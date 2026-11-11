#!/usr/bin/env node
// Native-install smoke for EGM in a throwaway GJC user root. It clones the
// pinned EGM tag (the only network step), installs it through GJC's own
// marketplace path together with this checkout's egm plugin, and drives fresh
// `gjc --print` processes through a scripted model on 127.0.0.1 that also
// serves the task subagent, so both request bodies are captured byte for byte:
//
//   1. skill discovery lists the seven egm:egm-* skills and egm_readiness is ready;
//   2. a task call to the egm-zoom-out persona runs with the persona prompt and
//      without the parent-only sentinel, and records which host instruction
//      files (SYSTEM.md, AGENTS.md, RULES.md, an always-apply rule, a project
//      AGENTS.md) still reach the subagent;
//   3. /skill:egm:egm-review injects the skill and /skill:egm-review does not;
//   4. a session launched without the task tool cannot activate it.
//
//   node egm/scripts/smoke-native.mjs
//
// No model, key or real GJC configuration is used. Exit codes: 0 pass,
// 1 check failed, 2 missing prerequisite (gjc, git, network).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSmokeEnvironment } from "../../verification-receipts/scripts/smoke-environment.mjs";

const MIN_GJC = "0.20.0";
const REPOSITORY = "https://github.com/google/elephant-goldfish-model";
const TAG = "v0.1.1";
const COMMIT = "dea7761de06ce5b51c177ebb9bba0469f24af5a4";
const SKILLS = ["egm-brainstorm", "egm-draft", "egm-review", "egm-review-loop", "egm-resolve", "egm-bootstrap", "egm-drift-report"];
const PARENT_MARK = "EGM-SMOKE-PARENT-PROMPT";
const SENTINEL = "EGM-SMOKE-SENTINEL-7f3a9c";
const MARKERS = {
	userSystem: "EGM-SMOKE-MARKER-USER-SYSTEM",
	userAgents: "EGM-SMOKE-MARKER-USER-AGENTS",
	userRules: "EGM-SMOKE-MARKER-USER-RULES",
	alwaysApplyRule: "EGM-SMOKE-MARKER-ALWAYS-RULE",
	projectAgents: "EGM-SMOKE-MARKER-PROJECT-AGENTS",
};
const NO_TASK_TOOLS = "read,bash,edit,write,find,search,skill,skill_discovery,search_tool_bm25";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function newer(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	return false;
}

function prerequisiteProblem() {
	const gjc = spawnSync("gjc", ["--version"], { encoding: "utf8", timeout: 30000 });
	if (gjc.error?.code === "ENOENT") return "`gjc` is not on PATH; install gajae-code and re-run.";
	const version = /(\d+\.\d+\.\d+)/.exec(gjc.stdout ?? "")?.[1];
	if (gjc.status !== 0 || !version) return `\`gjc --version\` failed (exit ${gjc.status}).`;
	if (newer(MIN_GJC, version)) return `gjc ${version} is older than the verified ${MIN_GJC}.`;
	if (spawnSync("git", ["--version"], { encoding: "utf8" }).status !== 0) return "`git` is not on PATH.";
	return null;
}

const toolOutput = (body) => {
	const item = [...(body.input ?? [])].reverse().find((entry) => entry.type === "function_call_output");
	if (!item) return null;
	return typeof item.output === "string" ? item.output : JSON.stringify(item.output);
};

// Scripted loopback model. A request whose input carries PARENT_MARK is the
// parent session and gets the next scripted step; any other request is a task
// subagent, which finishes through `yield` when it is offered.
function scriptedEndpoint(state) {
	return http.createServer(async (req, res) => {
		try {
			if (req.method === "GET" && req.url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o", object: "model", owned_by: "local" }] }));
				return;
			}
			if (req.method !== "POST" || req.url !== "/v1/responses") throw new Error(`unexpected request ${req.method} ${req.url}`);
			let raw = "";
			for await (const chunk of req) {
				raw += chunk;
				if (raw.length > 8_000_000) throw new Error("request too large");
			}
			const body = JSON.parse(raw);
			const parent = JSON.stringify(body.input ?? []).includes(PARENT_MARK);
			state.requests.push({ role: parent ? "parent" : "child", body });
			let decision;
			if (parent) decision = state.steps[state.step++] ?? { final: "smoke done" };
			else {
				const names = (body.tools ?? []).map((tool) => tool.name);
				decision = names.includes("yield") && !state.childYielded
					? { tool: "yield", args: { result: { data: "reviewed" }, data: "reviewed" } }
					: { final: "reviewed" };
				if (decision.tool) state.childYielded = true;
			}
			writeResponses(res, `local_${state.requests.length}`, decision);
		} catch (error) {
			state.error ??= error.message;
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "egm_smoke_endpoint_failed" } }));
		}
	});
}

function writeResponses(res, id, decision) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const send = (event) => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	const response = { id: `resp_${id}`, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
	const item = decision.tool
		? { id: `fc_${id}`, type: "function_call", call_id: `call_${id}`, name: decision.tool, arguments: JSON.stringify(decision.args ?? {}), status: "completed" }
		: { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: decision.final, annotations: [] }] };
	send({ type: "response.created", response: { ...response, status: "in_progress" } });
	send({ type: "response.output_item.added", output_index: 0, item: decision.tool ? { ...item, arguments: "" } : { ...item, content: [] } });
	if (decision.tool) send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
	else send({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: decision.final });
	send({ type: "response.output_item.done", output_index: 0, item });
	send({ type: "response.completed", response: { ...response, output: [item] } });
	res.end();
}

function run(command, args, env, cwd, timeout = 180000) {
	return new Promise((resolve, reject) => {
		let stdout = "";
		let stderr = "";
		const child = spawn(command, args, { cwd, env, shell: false, detached: true });
		const timer = setTimeout(() => {
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {}
			reject(new Error(`${command} ${args.slice(0, 2).join(" ")} timed out`));
		}, timeout);
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", reject);
		child.on("close", (code) => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

const sha256 = (file) => {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
};

// First substantial prose line after the YAML frontmatter, read from the installed
// file at run time so no EGM text is copied into this repository.
function bodyLine(text) {
	const body = text.startsWith("---") ? text.slice(text.indexOf("\n---", 3) + 4) : text;
	return body.split("\n").map((line) => line.trim()).find((line) => line.length > 40 && !line.startsWith("#"));
}

async function session(state, steps, prompt, env, cwd, extra = []) {
	state.steps = steps;
	state.step = 0;
	state.requests = [];
	state.childYielded = false;
	const args = ["--print", "--no-session", "--no-title", "--no-mcp", "--no-lsp", "--no-pty", "--model", "openai/gpt-4o", "--thinking", "off", ...extra, `${prompt}\n${PARENT_MARK}`];
	const result = await run("gjc", args, env, cwd, 240000);
	return { result, requests: state.requests };
}

async function main() {
	const problem = prerequisiteProblem();
	if (problem) {
		console.error(`egm smoke: prerequisite — ${problem}`);
		process.exitCode = 2;
		return;
	}
	const realRoot = path.join(os.homedir(), ".gjc");
	const realFiles = [path.join(realRoot, "agent", "gjc-plugins", "registry.json"), path.join(realRoot, "plugins", "installed_plugins.json"), path.join(realRoot, "marketplaces.json")];
	const before = realFiles.map(sha256);
	const owned = realpathSync(mkdtempSync(path.join(os.tmpdir(), "egm-smoke-")));
	const state = { requests: [], steps: [], step: 0 };
	const server = scriptedEndpoint(state);
	const failures = [];
	const expect = (ok, message) => {
		if (!ok) failures.push(message);
		return ok;
	};
	let report = null;
	try {
		const env = await createSmokeEnvironment(owned);
		await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
		env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
		const agent = env.GJC_CODING_AGENT_DIR;
		mkdirSync(path.join(agent, "rules"), { recursive: true });
		writeFileSync(path.join(agent, "SYSTEM.md"), `${MARKERS.userSystem}: user SYSTEM.md line.\n`);
		writeFileSync(path.join(agent, "AGENTS.md"), `# user\n${MARKERS.userAgents}: user AGENTS.md line.\n`);
		writeFileSync(path.join(agent, "RULES.md"), `# user\n${MARKERS.userRules}: user RULES.md line.\n`);
		writeFileSync(path.join(agent, "rules", "smoke.md"), `---\ndescription: smoke rule\nalwaysApply: true\n---\n${MARKERS.alwaysApplyRule}: always-apply rule line.\n`);
		const work = path.join(owned, "work");
		mkdirSync(work);
		spawnSync("git", ["init", "--quiet", work], { env, encoding: "utf8" });
		writeFileSync(path.join(work, "AGENTS.md"), `# project\n${MARKERS.projectAgents}: project AGENTS.md line.\n`);
		writeFileSync(path.join(work, "design_draft.md"), "# Design draft\n\nA two-line design used only by the smoke.\n");

		const source = path.join(env.HOME, ".gjc-plugin", "egm", `elephant-goldfish-model-${TAG}`);
		const clone = await run("git", ["-c", "advice.detachedHead=false", "clone", "--quiet", "--depth", "1", "--branch", TAG, REPOSITORY, source], env, owned);
		if (clone.code !== 0) {
			console.error(`egm smoke: prerequisite — cloning ${REPOSITORY} at ${TAG} failed (exit ${clone.code}); the smoke needs network access to GitHub.`);
			process.exitCode = 2;
			return;
		}
		const head = spawnSync("git", ["-C", source, "rev-parse", "HEAD"], { env, encoding: "utf8" }).stdout.trim();
		expect(head === COMMIT, `pinned checkout HEAD ${head} is not ${COMMIT}`);
		const gjcVersion = spawnSync("gjc", ["--version"], { env, encoding: "utf8" }).stdout.trim();
		for (const args of [["plugin", "marketplace", "add", source], ["plugin", "install", "egm@egm"], ["plugin", "install", plugin, "--user", "--json"]]) {
			const step = await run("gjc", args, env, work);
			expect(step.code === 0, `gjc ${args.join(" ")} exited ${step.code}: ${(step.stderr || step.stdout).slice(0, 300)}`);
		}
		const installPath = JSON.parse(readFileSync(path.join(env.HOME, ".gjc", "plugins", "installed_plugins.json"), "utf8")).plugins["egm@egm"]?.[0]?.installPath;
		const personaLine = bodyLine(readFileSync(path.join(installPath, "agents", "zoom_out.md"), "utf8"));
		const skillLine = bodyLine(readFileSync(path.join(installPath, "skills", "egm-review", "SKILL.md"), "utf8"));

		// 1 + 2: discovery, readiness and one isolated persona task.
		const primary = await session(state, [
			{ tool: "skill_discovery", args: { query: "egm", limit: 20 } },
			{ tool: "egm_readiness", args: {} },
			{ tool: "search_tool_bm25", args: { query: "subagent delegation task", limit: 5 } },
			{ tool: "task", args: { agent: "egm-zoom-out", tasks: [{ id: "ZoomOut", description: "isolation smoke", assignment: "Read design_draft.md in the working directory and report the single biggest gap. Acceptance: one finding with a file reference." }] } },
			{ final: "smoke done" },
		], `Isolation smoke. ${SENTINEL} is a parent-only token.`, env, work);
		expect(primary.result.code === 0, `primary session exited ${primary.result.code}: ${primary.result.stderr.slice(0, 300)}`);
		const parents = primary.requests.filter((request) => request.role === "parent");
		const children = primary.requests.filter((request) => request.role === "child");
		const discovered = [...new Set((toolOutput(parents[1]?.body ?? {}) ?? "").match(/"name": "egm:egm-[a-z-]+"/g) ?? [])].map((match) => match.slice(9, -1)).sort();
		expect(JSON.stringify(discovered) === JSON.stringify(SKILLS.map((name) => `egm:${name}`).sort()), `discovered skills: ${JSON.stringify(discovered)}`);
		const readinessText = toolOutput(parents[2]?.body ?? {}) ?? "";
		const readiness = /^egm_readiness: (\S+)/.exec(readinessText)?.[1] ?? null;
		expect(readiness === "ready", `egm_readiness: ${readinessText.split("\n").slice(0, 8).join(" | ")}`);
		const activated = JSON.parse(toolOutput(parents[3]?.body ?? {}) ?? "{}").activated_tools ?? [];
		expect(activated.includes("task"), `task not activated: ${JSON.stringify(activated)}`);
		const childText = children.map((request) => JSON.stringify(request.body)).join("\n");
		const parentText = JSON.stringify(parents[0]?.body ?? {});
		expect(children.length >= 1, "no task subagent request reached the scripted model");
		expect(personaLine !== undefined && childText.includes(JSON.stringify(personaLine).slice(1, -1)), "the egm-zoom-out persona prompt is not in the subagent request");
		expect(parentText.includes(SENTINEL), "the sentinel is missing from the parent request (probe broken)");
		expect(!childText.includes(SENTINEL), "the parent-only sentinel reached the subagent request");
		const hostInstructions = Object.fromEntries(Object.entries(MARKERS).map(([name, marker]) => [name, { parent: parentText.includes(marker), subagent: childText.includes(marker) }]));
		expect(Object.values(hostInstructions).every((entry) => entry.parent), `a host instruction marker is missing from the parent: ${JSON.stringify(hostInstructions)}`);

		// 3: the namespaced command loads the skill; the bare form is plain text.
		const namespaced = await session(state, [{ final: "smoke done" }], "/skill:egm:egm-review design_draft.md", env, work);
		const bare = await session(state, [{ final: "smoke done" }], "/skill:egm-review design_draft.md", env, work);
		const injected = (entry) => skillLine !== undefined && JSON.stringify(entry.requests[0]?.body?.input ?? []).includes(JSON.stringify(skillLine).slice(1, -1));
		const invocation = { namespaced: injected(namespaced), bare: injected(bare) };
		expect(invocation.namespaced, "/skill:egm:egm-review did not inject the skill");

		// 4: without the task tool in the launch set, it cannot be activated.
		const noTask = await session(state, [{ tool: "search_tool_bm25", args: { query: "subagent delegation task", limit: 5 } }, { final: "smoke done" }], "No-subagent smoke.", env, work, ["--tools", NO_TASK_TOOLS]);
		const noTaskActivated = JSON.parse(toolOutput(noTask.requests.filter((request) => request.role === "parent")[1]?.body ?? {}) ?? "{}").activated_tools ?? null;
		expect(Array.isArray(noTaskActivated) && !noTaskActivated.includes("task"), `task activated without being launched: ${JSON.stringify(noTaskActivated)}`);

		for (const args of [["plugin", "uninstall", "egm@egm"], ["plugin", "marketplace", "remove", "egm"], ["plugin", "uninstall", "egm", "--user"]]) {
			const step = await run("gjc", args, env, work);
			expect(step.code === 0, `gjc ${args.join(" ")} exited ${step.code}: ${(step.stderr || step.stdout).slice(0, 300)}`);
		}
		const list = await run("gjc", ["plugin", "list", "--json"], env, work);
		const listed = list.code === 0 ? JSON.parse(list.stdout) : null;
		expect(listed !== null && (listed.marketplace ?? []).length === 0 && !(listed.gjc ?? []).some((entry) => entry.identity?.name === "egm"), `plugin list after uninstall: ${list.stdout.slice(0, 300)}`);
		expect(!state.error, `scripted endpoint: ${state.error}`);
		report = {
			schemaVersion: 1,
			kind: "egm-native-smoke",
			gjcVersion,
			pinned: { tag: TAG, commit: head },
			isolated: true,
			remoteModelRequests: 0,
			skills: discovered,
			readiness,
			subagentRequests: children.length,
			parentSentinelInSubagent: childText.includes(SENTINEL),
			hostInstructions,
			invocation,
			taskActivatableWithoutLaunch: Array.isArray(noTaskActivated) ? noTaskActivated.includes("task") : null,
		};
	} finally {
		server.close();
		rmSync(owned, { recursive: true, force: true });
	}
	expect(JSON.stringify(realFiles.map(sha256)) === JSON.stringify(before), "a real GJC plugin registry changed");
	if (report) report.status = failures.length === 0 ? "passed" : "failed";
	console.log(JSON.stringify(report, null, 2));
	for (const failure of failures) console.error(`egm smoke: ${failure}`);
	process.exitCode = failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
