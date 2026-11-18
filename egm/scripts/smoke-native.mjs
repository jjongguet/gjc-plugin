#!/usr/bin/env node
// Native-install smoke for EGM in a throwaway GJC user root. It clones the
// pinned EGM tag (the only network step), runs the native installer from this
// checkout (runtime surfaces + the egm readiness bundle through the installed
// `gjc` CLI), and drives fresh `gjc --print` processes through a scripted model
// on 127.0.0.1 that also serves the task subagent, so both request bodies are
// captured byte for byte:
//
//   1. skill discovery lists the seven un-namespaced egm-* skills and
//      egm_readiness reports install_verified;
//   2. a task call to the egm-zoom-out reviewer runs with the persona prompt,
//      without the parent-only sentinel, with only read/search/find among the
//      built-in tools, and forced edit/write/bash calls have no side effect;
//   3. /skill:egm-review injects the loose skill payload;
//   4. a session launched without the task tool cannot activate it.
//
//   node egm/scripts/smoke-native.mjs
//
// No model, key, live registry or real GJC configuration is used: HOME,
// GJC_CODING_AGENT_DIR, TMPDIR and every registry live in an owned temp root.
// Exit codes: 0 pass, 1 check failed, 2 missing prerequisite (bun, gjc, git,
// or network for the pinned clone).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSmokeEnvironment } from "../../verification-receipts/scripts/smoke-environment.mjs";

const MIN_GJC = "0.21.1";
const REPOSITORY = "https://github.com/google/elephant-goldfish-model";
const TAG = "v0.1.1";
const COMMIT = "dea7761de06ce5b51c177ebb9bba0469f24af5a4";
const SKILLS = ["egm-brainstorm", "egm-bootstrap", "egm-drift-report", "egm-draft", "egm-resolve", "egm-review", "egm-review-loop"];
const REVIEWERS = [
	"egm-codebase-details",
	"egm-comprehension",
	"egm-design",
	"egm-implementation-readiness",
	"egm-inventive-catalyst",
	"egm-structural",
	"egm-style",
	"egm-zoom-out",
];
const DENIED = ["edit", "write", "bash"];
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
const installScript = path.join(plugin, "scripts", "install.ts");

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
	if (spawnSync("bun", ["--version"], { encoding: "utf8" }).status !== 0) return "`bun` is not on PATH; the installer entry is a Bun script.";
	return null;
}

const toolOutput = (body) => {
	const item = [...(body.input ?? [])].reverse().find((entry) => entry.type === "function_call_output");
	if (!item) return null;
	return typeof item.output === "string" ? item.output : JSON.stringify(item.output);
};

const lastToolOutputs = (body) => (body.input ?? []).filter((entry) => entry.type === "function_call_output").map((entry) => (typeof entry.output === "string" ? entry.output : JSON.stringify(entry.output)));

// Scripted loopback model. A request whose input carries PARENT_MARK is the
// parent session and gets the next scripted parent step; any other request is
// the task subagent, which is driven through the forced write/bash/edit calls
// and then finishes through `yield`.
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
			if (parent) decision = state.parentSteps[state.parentStep++] ?? { final: "smoke done" };
			else {
				const offered = (body.tools ?? []).map((tool) => tool.name);
				decision = state.childSteps[state.childStep++] ?? (offered.includes("yield") ? { tool: "yield", args: { result: { data: "reviewed" }, data: "reviewed" } } : { final: "reviewed" });
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

// First substantial prose line after the YAML frontmatter, read from the
// installed files at run time so no EGM text is copied into this repository.
function bodyLine(text) {
	const body = text.startsWith("---") ? text.slice(text.indexOf("\n---", 3) + 4) : text;
	return body.split("\n").map((line) => line.trim()).find((line) => line.length > 40 && !line.startsWith("#"));
}

async function session(state, steps, prompt, env, cwd, extra = [], childSteps = []) {
	state.parentSteps = steps;
	state.parentStep = 0;
	state.childSteps = childSteps;
	state.childStep = 0;
	state.requests = [];
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
	const build = spawnSync("bun", [path.join(plugin, "scripts", "build.mjs"), "--check"], { encoding: "utf8", timeout: 60000 });
	if (build.status !== 0) {
		console.error(`egm smoke: prerequisite — the generated tool is out of sync; run \`bun run build:egm\` first.\n${(build.stderr || build.stdout).trim()}`);
		process.exitCode = 2;
		return;
	}
	const realRoot = path.join(os.homedir(), ".gjc");
	const realFiles = [path.join(realRoot, "agent", "gjc-plugins", "registry.json"), path.join(realRoot, "plugins", "installed_plugins.json"), path.join(realRoot, "marketplaces.json")];
	const before = realFiles.map(sha256);
	const owned = realpathSync(mkdtempSync(path.join(os.tmpdir(), "egm-smoke-")));
	const state = { requests: [], parentSteps: [], parentStep: 0, childStep: 0, error: null };
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
		const draft = path.join(work, "design_draft.md");
		writeFileSync(draft, "# Design draft\n\nA two-line design used only by the smoke.\n");

		// The pinned clone is the only network step.
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

		// One native command: runtime surfaces + the readiness bundle.
		const installed = await run("bun", [installScript, "--source", source, "--json"], env, work, 300000);
		const receiptText = installed.stdout.trim().split("\n").at(-1) ?? "{}";
		let receipt = null;
		try {
			receipt = JSON.parse(receiptText).install ?? null;
		} catch {
			receipt = null;
		}
		if (!expect(installed.code === 0 && receipt?.status === "installed", `native install failed (exit ${installed.code}): ${(installed.stderr || installed.stdout).slice(0, 500)}`)) {
			console.error(`egm smoke: native install failed (exit ${installed.code}): ${(installed.stderr || installed.stdout).slice(0, 500)}`);
			process.exitCode = 1;
			return;
		}
		expect(receipt.runtime === "written", `installer runtime receipt: ${JSON.stringify(receipt.runtime)}`);
		expect(receipt.plugin?.status === "installed", `installer plugin receipt: ${JSON.stringify(receipt.plugin)}`);
		expect(
			receipt.counts?.bundle === 31 && receipt.counts?.skills === 7 && receipt.counts?.references === 3 && receipt.counts?.agents === 8,
			`installer counts: ${JSON.stringify(receipt.counts)}`,
		);

		const list = JSON.parse((await run("gjc", ["plugin", "list", "--json"], env, work)).stdout);
		const listed = (list.gjc ?? []).some((entry) => entry.identity?.name === "egm");
		expect(listed, "the egm readiness bundle is not registered after the install");
		expect((list.marketplace ?? []).length === 0, `an unexpected marketplace entry exists in the isolated root: ${JSON.stringify(list.marketplace)}`);

		const bundle = path.join(agent, "egm", TAG);
		const journal = JSON.parse(readFileSync(path.join(bundle, "bundle.json"), "utf8"));
		expect(journal.state === "complete", `journal state: ${journal.state}`);
		expect(Object.keys(journal.bundle ?? {}).length === 31, "the journal does not record 31 upstream digests");
		expect(Object.keys(journal.loose ?? {}).length === 18, "the journal does not record 18 loose files");
		const personaLine = bodyLine(readFileSync(path.join(bundle, "agents", "zoom_out.md"), "utf8"));
		const skillLine = bodyLine(readFileSync(path.join(bundle, "skills", "egm-review", "SKILL.md"), "utf8"));

		// 1 + 2: discovery, readiness, and one isolated reviewer driven through
		// forced edit/write/bash calls before it yields.
		const deniedWrite = path.join(owned, "denied-write.txt");
		const deniedBash = path.join(owned, "denied-bash.txt");
		const draftDigest = sha256(draft);
		const childSteps = [
			{ tool: "write", args: { file_path: deniedWrite, content: "must not be written" } },
			{ tool: "bash", args: { command: `touch ${deniedBash}` } },
			{ tool: "edit", args: { file_path: draft, old_string: "A two-line design", new_string: "REWRITTEN BY A REVIEWER" } },
			{ tool: "yield", args: { result: { data: "reviewed" }, data: "reviewed" } },
		];
		const primary = await session(
			state,
			[
				{ tool: "skill_discovery", args: { query: "egm", limit: 20 } },
				{ tool: "egm_readiness", args: {} },
				{ tool: "search_tool_bm25", args: { query: "subagent delegation task", limit: 5 } },
				{ tool: "task", args: { agent: "egm-zoom-out", tasks: [{ id: "ZoomOut", description: "isolation smoke", assignment: "Read design_draft.md in the working directory and report the single biggest gap. Acceptance: one finding with a file reference." }] } },
				{ final: "smoke done" },
			],
			`Isolation smoke. ${SENTINEL} is a parent-only token.`,
			env,
			work,
			[],
			childSteps,
		);
		expect(primary.result.code === 0, `primary session exited ${primary.result.code}: ${primary.result.stderr.slice(0, 300)}`);
		const parents = primary.requests.filter((request) => request.role === "parent");
		const children = primary.requests.filter((request) => request.role === "child");
		const discoveryText = toolOutput(parents[1]?.body ?? {}) ?? "";
		const discovered = [...new Set(discoveryText.match(/egm-(?:review-loop|drift-report|brainstorm|bootstrap|resolve|review|draft)\b/g) ?? [])].sort();
		expect(JSON.stringify(discovered) === JSON.stringify([...SKILLS].sort()), `discovered skills: ${JSON.stringify(discovered)}`);
		const readinessText = toolOutput(parents[2]?.body ?? {}) ?? "";
		const readiness = /^egm_readiness: (\S+)/.exec(readinessText)?.[1] ?? null;
		expect(readiness === "install_verified", `egm_readiness: ${readinessText.split("\n").slice(0, 8).join(" | ")}`);
		const activated = JSON.parse(toolOutput(parents[3]?.body ?? {}) ?? "{}").activated_tools ?? [];
		expect(activated.includes("task"), `task not activated: ${JSON.stringify(activated)}`);
		const childText = children.map((request) => JSON.stringify(request.body)).join("\n");
		const parentText = JSON.stringify(parents[0]?.body ?? {});
		expect(children.length >= 1, "no task subagent request reached the scripted model");
		expect(personaLine !== undefined && childText.includes(JSON.stringify(personaLine).slice(1, -1)), "the egm-zoom-out persona prompt is not in the subagent request");
		expect(childText.includes("GJC adapter"), "the GJC agent adapter block is missing from the subagent request");
		expect(parentText.includes(SENTINEL), "the sentinel is missing from the parent request (probe broken)");
		expect(!childText.includes(SENTINEL), "the parent-only sentinel reached the subagent request");
		const hostInstructions = Object.fromEntries(Object.entries(MARKERS).map(([name, marker]) => [name, { parent: parentText.includes(marker), subagent: childText.includes(marker) }]));
		expect(Object.values(hostInstructions).every((entry) => entry.parent), `a host instruction marker is missing from the parent: ${JSON.stringify(hostInstructions)}`);

		const reviewerOffered = [...new Set(children.flatMap((request) => (request.body.tools ?? []).map((tool) => tool.name)))].sort();
		expect(DENIED.every((name) => !reviewerOffered.includes(name)), `a denied built-in tool is offered to the reviewer: ${JSON.stringify(reviewerOffered)}`);
		expect(["read", "search", "find"].every((name) => reviewerOffered.includes(name)), `a read-only reviewer tool is missing: ${JSON.stringify(reviewerOffered)}`);
		const denials = lastToolOutputs(children.at(-1)?.body ?? {}).map((text) => text.slice(0, 240));
		expect(!existsSync(deniedWrite), "a forced reviewer write created a file");
		expect(!existsSync(deniedBash), "a forced reviewer bash command created a file");
		expect(sha256(draft) === draftDigest, "a forced reviewer edit changed the design draft");

		// 3: the native un-namespaced command injects the loose skill.
		const invocation = await session(state, [{ final: "smoke done" }], "/skill:egm-review design_draft.md", env, work);
		const injected = skillLine !== undefined && JSON.stringify(invocation.requests[0]?.body?.input ?? []).includes(JSON.stringify(skillLine).slice(1, -1));
		expect(injected, "/skill:egm-review did not inject the loose skill payload");

		// 4: without the task tool in the launch set, it cannot be activated.
		const noTask = await session(state, [{ tool: "search_tool_bm25", args: { query: "subagent delegation task", limit: 5 } }, { final: "smoke done" }], "No-subagent smoke.", env, work, ["--tools", NO_TASK_TOOLS]);
		const noTaskActivated = JSON.parse(toolOutput(noTask.requests.filter((request) => request.role === "parent")[1]?.body ?? {}) ?? "{}").activated_tools ?? null;
		expect(Array.isArray(noTaskActivated) && !noTaskActivated.includes("task"), `task activated without being launched: ${JSON.stringify(noTaskActivated)}`);

		const uninstall = await run("gjc", ["plugin", "uninstall", "egm", "--user"], env, work);
		expect(uninstall.code === 0, `gjc plugin uninstall egm --user exited ${uninstall.code}: ${(uninstall.stderr || uninstall.stdout).slice(0, 300)}`);
		const afterUninstall = JSON.parse((await run("gjc", ["plugin", "list", "--json"], env, work)).stdout);
		expect(!(afterUninstall.gjc ?? []).some((entry) => entry.identity?.name === "egm"), `the egm bundle is still listed: ${JSON.stringify(afterUninstall.gjc)}`);
		expect(!state.error, `scripted endpoint: ${state.error}`);
		report = {
			schemaVersion: 2,
			kind: "egm-native-smoke",
			gjcVersion,
			pinned: { tag: TAG, commit: head },
			isolated: true,
			remoteModelRequests: 0,
			install: receipt,
			pluginListed: listed,
			pluginUninstalled: uninstall.code === 0,
			journal: { state: journal.state, bundle: Object.keys(journal.bundle ?? {}).length, loose: Object.keys(journal.loose ?? {}).length },
			skills: discovered,
			readiness,
			subagentRequests: children.length,
			reviewerOffered,
			deniedTools: DENIED.filter((name) => !reviewerOffered.includes(name)),
			forcedDenials: { writeSideEffect: existsSync(deniedWrite), bashSideEffect: existsSync(deniedBash), draftChanged: sha256(draft) !== draftDigest, rejectionSamples: denials },
			parentSentinelInSubagent: childText.includes(SENTINEL),
			hostInstructions,
			invocation: { skill: "egm-review", injected },
			taskActivatableWithoutLaunch: Array.isArray(noTaskActivated) ? noTaskActivated.includes("task") : null,
			reviewers: REVIEWERS,
		};
	} finally {
		server.close();
		rmSync(owned, { recursive: true, force: true });
		expect(JSON.stringify(realFiles.map(sha256)) === JSON.stringify(before), "a real GJC plugin registry changed");
	}
	if (report) report.status = failures.length === 0 ? "passed" : "failed";
	console.log(JSON.stringify(report, null, 2));
	for (const failure of failures) console.error(`egm smoke: ${failure}`);
	process.exitCode = failures.length === 0 && report !== null ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
