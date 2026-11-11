#!/usr/bin/env node
/**
 * Host smoke for memory-dream against a real GJC memory scope.
 *
 * Installs the plugin into the user scope, starts a fresh `gjc --print`
 * process against a scripted loopback model endpoint, calls `memory_dream`
 * once, verifies the report and that the memory files' sha256 did not change,
 * then uninstalls unless --keep-installed is passed.
 *
 * The scripted endpoint is local: no model provider is contacted. The default
 * mode forces JEV_ADVISOR_PROVIDER=off so the run is keyless and cannot spend.
 *
 *   node scripts/smoke-host.mjs --project-root <repo> [--agent-dir <dir>] [--memory-dir <scope>] [--keep-installed]
 *   node scripts/smoke-host.mjs --project-root <repo> --live-jev
 *
 * Exit codes: 0 pass, 1 check failed, 2 missing prerequisite.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const options = parseArgs(process.argv.slice(2));
const projectRoot = path.resolve(options["project-root"] ?? process.cwd());
const agentDir = path.resolve(options["agent-dir"] ?? process.env.GJC_CODING_AGENT_DIR ?? path.join(os.homedir(), ".gjc", "agent"));
const memoryDir = path.resolve(options["memory-dir"] ?? path.join(agentDir, "memories", encodeProjectPath(projectRoot)));
const files = ["memory_summary.md", "MEMORY.md"].map(name => path.join(memoryDir, name));
const liveJev = options["live-jev"] === true;

function parseArgs(argv) {
	const out = {};
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index];
		if (key === "--keep-installed" || key === "--live-jev") out[key.slice(2)] = true;
		else if (key.startsWith("--")) out[key.slice(2)] = argv[++index];
	}
	return out;
}

function encodeProjectPath(cwd) {
	return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

function sha256(file) {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
}

function newer(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let index = 0; index < 3; index++) if ((pa[index] ?? 0) !== (pb[index] ?? 0)) return (pa[index] ?? 0) > (pb[index] ?? 0);
	return false;
}

function prerequisiteProblem() {
	const probe = spawnSync("gjc", ["--version"], { encoding: "utf8", timeout: 30000 });
	if (probe.error?.code === "ENOENT") return "`gjc` is not on PATH";
	if (probe.status !== 0) return `gjc --version failed (exit ${probe.status})`;
	const version = /(\d+\.\d+\.\d+)/.exec(probe.stdout)?.[1];
	if (!version) return "could not read a gjc version";
	if (newer("0.20.0", version)) return `gjc ${version} is older than 0.20.0`;
	if (!existsSync(memoryDir)) return `memory scope not found: ${memoryDir}`;
	const missing = files.filter(file => !existsSync(file));
	if (missing.length > 0) return `memory files missing: ${missing.map(file => path.basename(file)).join(", ")}`;
	return null;
}

function lastToolOutput(data) {
	const items = [...(data.messages ?? data.input ?? [])].reverse();
	const item = items.find(entry => entry.role === "tool" || entry.type === "function_call_output");
	if (!item) throw new Error("request carries no tool result");
	const content = item.output ?? item.content;
	return typeof content === "string" ? content : content.map(part => part.text ?? "").join("");
}

function scriptedEndpoint(state) {
	const call = { memory_dir: memoryDir, project_root: projectRoot, max_claims: 100, ...(liveJev ? { jev: true } : {}) };
	const next = data => {
		if (state.step === 0) {
			const offered = (data.tools ?? []).map(tool => tool.function?.name ?? tool.name);
			state.toolOffered = offered.includes("memory_dream");
			if (!state.toolOffered) throw new Error(`memory_dream not offered; tools: ${offered.join(",")}`);
			return { call };
		}
		state.toolOutput = lastToolOutput(data);
		return { final: "memory-dream smoke finished" };
	};
	return http.createServer(async (req, res) => {
		try {
			if (req.method === "GET" && req.url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o", object: "model", owned_by: "local" }] }));
				return;
			}
			if (req.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(req.url)) throw new Error(`unexpected ${req.method} ${req.url}`);
			let body = "";
			for await (const chunk of req) {
				body += chunk;
				if (body.length > 4_000_000) throw new Error("request too large");
			}
			const decision = next(JSON.parse(body));
			const id = `local_${state.step}`;
			state.step++;
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (req.url === "/v1/responses") writeResponses(res, id, decision);
			else writeChat(res, id, decision);
		} catch (error) {
			state.error ??= error.message;
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "memory_dream_smoke_endpoint_failed" } }));
		}
	});
}

function writeResponses(res, id, decision) {
	const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	const response = { id: `resp_${id}`, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
	send({ type: "response.created", response: { ...response, status: "in_progress" } });
	const item = decision.call
		? { id: `fc_${id}`, type: "function_call", call_id: `call_${id}`, name: "memory_dream", arguments: JSON.stringify(decision.call), status: "completed" }
		: { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: decision.final, annotations: [] }] };
	send({ type: "response.output_item.added", output_index: 0, item: decision.call ? { ...item, arguments: "" } : { ...item, content: [] } });
	if (decision.call) send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
	else send({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: decision.final });
	send({ type: "response.output_item.done", output_index: 0, item });
	send({ type: "response.completed", response: { ...response, output: [item] } });
	res.end();
}

function writeChat(res, id, decision) {
	const base = { id, object: "chat.completion.chunk", created: 0, model: "gpt-4o" };
	const delta = decision.call
		? { role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: "memory_dream", arguments: JSON.stringify(decision.call) } }] }
		: { role: "assistant", content: decision.final };
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: decision.call ? "tool_calls" : "stop" }] })}\n\n`);
	res.end("data: [DONE]\n\n");
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
			reject(new Error(`${command} ${args[0]} timed out`));
		}, timeout);
		child.stdout.on("data", chunk => (stdout += chunk));
		child.stderr.on("data", chunk => (stderr += chunk));
		child.on("error", reject);
		child.on("close", code => {
			clearTimeout(timer);
			resolve({ code, stdout, stderr });
		});
	});
}

function parseReportPath(text) {
	const match = /^report=(.+)$/m.exec(text);
	return match ? match[1].trim() : null;
}

async function main() {
	const problem = prerequisiteProblem();
	if (problem) {
		console.error(`memory-dream:smoke: prerequisite - ${problem}`);
		process.exitCode = 2;
		return;
	}
	const before = Object.fromEntries(files.map(file => [path.basename(file), sha256(file)]));
	const owned = realpathSync(mkdtempSync(path.join(os.tmpdir(), "memory-dream-smoke-")));
	const state = { step: 0, toolOffered: false, toolOutput: null, error: null };
	const server = scriptedEndpoint(state);
	const failures = [];
	const expect = (ok, message) => {
		if (!ok) failures.push(message);
		return ok;
	};
	let report;
	try {
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		const env = {
			...process.env,
			HOME: os.homedir(),
			TMPDIR: owned,
			GJC_CODING_AGENT_DIR: agentDir,
			GJC_AGENT_DIR: agentDir,
			GJC_MODEL_PRESET_REGISTRY_DISABLED: "1",
			OPENAI_API_KEY: "local-fixture-not-a-real-credential",
			OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`,
			NO_COLOR: "1",
			CI: "1",
		};
		if (!liveJev) env.JEV_ADVISOR_PROVIDER = "off";
		delete env.JEV_ADVISOR_API_KEY;
		delete env.OPENROUTER_API_KEY;
		delete env.OPENROUTER_DECISION_API_KEY;
		const cwd = projectRoot;
		const gjcVersion = spawnSync("gjc", ["--version"], { env, encoding: "utf8" }).stdout.trim();

		await run("gjc", ["plugin", "uninstall", "memory-dream", "--user", "--json"], env, cwd);
		const install = await run("gjc", ["plugin", "install", pluginRoot, "--user", "--json"], env, cwd);
		if (!expect(install.code === 0, `install exited ${install.code}: ${install.stderr.slice(0, 300)}`)) throw new Error("install failed");
		const session = await run(
			"gjc",
			[
				"--print",
				"--no-session",
				"--no-title",
				"--no-mcp",
				"--no-lsp",
				"--no-rules",
				"--no-pty",
				"--model",
				"openai/gpt-4o",
				"--thinking",
				"off",
				"--tools",
				"memory_dream",
				"Call memory_dream exactly once for the provided memory scope, then report the result.",
			],
			env,
			cwd,
		);
		expect(session.code === 0, `gjc --print exited ${session.code}: ${session.stderr.slice(0, 300)}`);
		expect(!state.error, `scripted endpoint: ${state.error}`);
		expect(state.step === 2, `expected 2 model requests, saw ${state.step}`);
		expect(state.toolOffered, "memory_dream was not offered to the model");
		const text = state.toolOutput ?? "";
		expect(/^memory_dream: ok$/m.test(text), `tool output: ${text.slice(0, 300)}`);
		expect(/memory_unchanged=yes/.test(text), "tool reported changed memory");
		expect(/claims=\d+/.test(text), "tool output has no claim count");
		expect(/no-decision=\d+/.test(text), "tool output has no no-decision count");
		expect(new RegExp(`jev_reason=${liveJev ? "[a-z_]+" : "disabled"}`).test(text), "unexpected jev reason");
		const reportPath = parseReportPath(text);
		expect(Boolean(reportPath && existsSync(reportPath)), `report path missing: ${reportPath}`);
		if (reportPath && existsSync(reportPath)) {
			const reportJson = JSON.parse(readFileSync(reportPath, "utf8"));
			expect(reportJson.schema === "memory-dream.report.v1", "report schema mismatch");
			expect(reportJson.counts?.claims > 0, "report has no claims");
			expect(reportJson.memory?.unchanged === true, "report says memory changed");
			expect(Array.isArray(reportJson.memory?.files) && reportJson.memory.files.every(file => file.sha256Before === file.sha256After), "report file hashes differ");
			const citations = reportJson.claims.flatMap(claim => claim.evidence.map(evidence => evidence.citation));
			expect(citations.every(citation => /^[\w./-]+:\d+$/.test(citation) || /^transcript:[a-f0-9]{16}:\d+$/.test(citation)), "evidence citation is not path:line");
			report = {
				claims: reportJson.counts.claims,
				supported: reportJson.counts.supported,
				contradicted: reportJson.counts.contradicted,
				unverified: reportJson.counts.unverified,
				noDecision: reportJson.counts.noDecision,
				sentToJev: reportJson.counts.sentToJev,
			};
		}
		const after = Object.fromEntries(files.map(file => [path.basename(file), sha256(file)]));
		expect(JSON.stringify(after) === JSON.stringify(before), "memory files changed on disk");
		const summary = {
			schemaVersion: 1,
			kind: "memory-dream-host-smoke",
			gjcVersion,
			pluginInstalled: true,
			memoryScope: memoryDir,
			files: Object.keys(before),
			sha256Unchanged: JSON.stringify(after) === JSON.stringify(before),
			claims: report?.claims ?? null,
			counts: report ?? null,
			reportPath: reportPath ?? null,
			modelRequests: state.step,
			remoteModelRequests: 0,
			liveJev,
			status: failures.length === 0 ? "passed" : "failed",
		};
		if (!options["keep-installed"]) await run("gjc", ["plugin", "uninstall", "memory-dream", "--user", "--json"], env, cwd);
		console.log(JSON.stringify(summary, null, 2));
	} finally {
		server.close();
		rmSync(owned, { recursive: true, force: true });
	}
	for (const failure of failures) console.error(`memory-dream:smoke: ${failure}`);
	process.exitCode = failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
