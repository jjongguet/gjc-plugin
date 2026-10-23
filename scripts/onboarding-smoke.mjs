#!/usr/bin/env node
// README quick start, end to end, in a throwaway GJC user root:
// install backplan from this checkout, call backplan_check from a fresh
// `gjc --print` process with both bundled examples, uninstall, and confirm a
// fresh process no longer lists the plugin. The model is a scripted loopback
// endpoint, so no key, network or real GJC configuration is used.
//
//   node scripts/onboarding-smoke.mjs
//
// Exit codes: 0 pass, 1 check failed, 2 missing or unsupported prerequisite.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createSmokeEnvironment } from "../verification-receipts/scripts/smoke-environment.mjs";

export const MIN_GJC = "0.18.12";
export const MIN_NODE_MAJOR = 22;

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const plugin = path.join(repo, "backplan");
const examples = { valid: path.join(plugin, "examples", "valid-plan.json"), invalid: path.join(plugin, "examples", "invalid-plan.json") };

function newer(a, b) {
	const pa = a.split(".").map(Number);
	const pb = b.split(".").map(Number);
	for (let i = 0; i < 3; i += 1) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
	return false;
}

export function prerequisiteProblem(env = process.env, nodeVersion = process.versions.node) {
	if (Number(nodeVersion.split(".")[0]) < MIN_NODE_MAJOR) return `Node.js ${nodeVersion} is older than ${MIN_NODE_MAJOR}; install Node.js ${MIN_NODE_MAJOR} or newer.`;
	const probe = spawnSync("gjc", ["--version"], { env, encoding: "utf8", timeout: 30000 });
	if (probe.error?.code === "ENOENT") return "`gjc` is not on PATH; install gajae-code (https://github.com/Yeachan-Heo/gajae-code) and re-run.";
	if (probe.status !== 0) return `\`gjc --version\` failed (exit ${probe.status}); repair the gajae-code installation and re-run.`;
	const version = /(\d+\.\d+\.\d+)/.exec(probe.stdout)?.[1];
	if (!version) return `could not read a version from \`gjc --version\` output: ${probe.stdout.trim().slice(0, 80)}`;
	if (newer(MIN_GJC, version)) return `gjc ${version} is older than the verified ${MIN_GJC}; upgrade gajae-code and re-run.`;
	return null;
}

// backplan_check answers "backplan_check: <status>\n{report}\n{journalStorage}".
export function parseToolReport(text) {
	const start = text.indexOf("{");
	if (start < 0) throw new Error(`tool result without a JSON report: ${text.slice(0, 120)}`);
	const journal = text.indexOf("\n{", start);
	return JSON.parse(text.slice(start, journal > 0 ? journal : undefined));
}

function lastToolOutput(data) {
	const items = [...(data.messages ?? data.input ?? [])].reverse();
	const item = items.find(entry => entry.role === "tool" || entry.type === "function_call_output");
	if (!item) throw new Error("request carries no tool result");
	const content = item.output ?? item.content;
	return typeof content === "string" ? content : content.map(part => part.text ?? "").join("");
}

// Scripted loopback model: call backplan_check with each example, then stop.
function scriptedEndpoint(state) {
	const plan = { valid: examples.valid, invalid: examples.invalid };
	const next = data => {
		if (state.step === 0) {
			const offered = (data.tools ?? []).map(tool => tool.function?.name ?? tool.name);
			if (!offered.includes("backplan_check")) throw new Error(`backplan_check not offered; tools: ${offered.join(",")}`);
			return { call: { plan_path: plan.valid } };
		}
		const report = parseToolReport(lastToolOutput(data));
		if (state.step === 1) {
			state.valid = { status: report.status, digest: report.digest };
			return { call: { plan_path: plan.invalid } };
		}
		state.invalid = { status: report.status, errors: (report.errors ?? []).slice(0, 3) };
		return { final: "onboarding smoke finished" };
	};
	return http.createServer(async (req, res) => {
		try {
			if (req.method === "GET" && req.url === "/v1/models") {
				res.writeHead(200, { "content-type": "application/json" });
				res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o", object: "model", owned_by: "local" }] }));
				return;
			}
			if (req.method !== "POST" || !["/v1/chat/completions", "/v1/responses"].includes(req.url)) throw new Error(`unexpected request ${req.method} ${req.url}`);
			let body = "";
			for await (const chunk of req) {
				body += chunk;
				if (body.length > 4_000_000) throw new Error("request too large");
			}
			const decision = next(JSON.parse(body));
			const id = `local_${state.step}`;
			state.step += 1;
			res.writeHead(200, { "content-type": "text/event-stream" });
			if (req.url === "/v1/responses") writeResponses(res, id, decision);
			else writeChat(res, id, decision);
		} catch (error) {
			state.error ??= error.message;
			res.writeHead(500, { "content-type": "application/json" });
			res.end(JSON.stringify({ error: { message: "onboarding_smoke_endpoint_failed" } }));
		}
	});
}

function writeResponses(res, id, decision) {
	const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	const response = { id: `resp_${id}`, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
	send({ type: "response.created", response: { ...response, status: "in_progress" } });
	const item = decision.call
		? { id: `fc_${id}`, type: "function_call", call_id: `call_${id}`, name: "backplan_check", arguments: JSON.stringify(decision.call), status: "completed" }
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
		? { role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: "backplan_check", arguments: JSON.stringify(decision.call) } }] }
		: { role: "assistant", content: decision.final };
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: decision.call ? "tool_calls" : "stop" }] })}\n\n`);
	res.end("data: [DONE]\n\n");
}

function run(command, args, env, cwd, timeout = 120000) {
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

const sha256 = file => {
	try {
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} catch {
		return null;
	}
};

async function main() {
	const problem = prerequisiteProblem();
	if (problem) {
		console.error(`onboarding:smoke: prerequisite — ${problem}`);
		process.exitCode = 2;
		return;
	}
	const realAgent = process.env.GJC_CODING_AGENT_DIR ?? path.join(os.homedir(), ".gjc", "agent");
	const realRegistry = path.join(realAgent, "gjc-plugins", "registry.json");
	const registryBefore = sha256(realRegistry);
	const owned = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gjc-onboarding-")));
	const state = { step: 0 };
	const server = scriptedEndpoint(state);
	const failures = [];
	const expect = (ok, message) => {
		if (!ok) failures.push(message);
		return ok;
	};
	let report;
	try {
		const env = await createSmokeEnvironment(owned);
		const cwd = path.join(owned, "home");
		await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
		env.OPENAI_BASE_URL = `http://127.0.0.1:${server.address().port}/v1`;
		const gjcVersion = spawnSync("gjc", ["--version"], { env, encoding: "utf8" }).stdout.trim();

		const install = await run("gjc", ["plugin", "install", plugin, "--user", "--json"], env, cwd);
		if (expect(install.code === 0, `install exited ${install.code}: ${install.stderr.slice(0, 300)}`)) {
			const session = await run("gjc", ["--print", "--no-session", "--no-title", "--no-mcp", "--no-lsp", "--no-rules", "--no-pty", "--model", "openai/gpt-4o", "--thinking", "off", "--tools", "backplan_check", "Run backplan_check on the bundled examples as directed."], env, cwd, 180000);
			expect(session.code === 0, `gjc --print exited ${session.code}: ${session.stderr.slice(0, 300)}`);
			expect(!state.error, `scripted endpoint: ${state.error}`);
			expect(state.step === 3, `expected 3 model requests, saw ${state.step}`);
			expect(state.valid?.status === "ok" && /^[0-9a-f]{64}$/.test(state.valid?.digest ?? ""), `valid example: ${JSON.stringify(state.valid)}`);
			expect(state.invalid?.status === "invalid" && state.invalid.errors.includes("plan.end_state: required"), `invalid example: ${JSON.stringify(state.invalid)}`);
			const uninstall = await run("gjc", ["plugin", "uninstall", "backplan", "--user", "--json"], env, cwd);
			expect(uninstall.code === 0, `uninstall exited ${uninstall.code}: ${uninstall.stderr.slice(0, 300)}`);
		}
		const list = await run("gjc", ["plugin", "list", "--json"], env, cwd);
		const names = list.code === 0 ? (JSON.parse(list.stdout).gjc ?? []).map(entry => entry.identity?.name) : null;
		expect(Array.isArray(names) && !names.includes("backplan"), `fresh plugin list after uninstall: ${JSON.stringify(names)}`);
		expect(sha256(realRegistry) === registryBefore, "the real plugin registry changed");
		report = { schemaVersion: 1, kind: "onboarding-smoke", gjcVersion, plugin: "backplan", isolated: true, modelRequests: state.step, remoteModelRequests: 0, valid: state.valid ?? null, invalid: state.invalid ?? null, listedAfterUninstall: names?.includes("backplan") ?? null, status: failures.length === 0 ? "passed" : "failed" };
	} finally {
		server.close();
		rmSync(owned, { recursive: true, force: true });
	}
	console.log(JSON.stringify(report, null, 2));
	for (const failure of failures) console.error(`onboarding:smoke: ${failure}`);
	process.exitCode = failures.length === 0 ? 0 : 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
