#!/usr/bin/env bun
// Operator E2E for an INSTALLED jev-advisor (not a test step; never part of `bun run test`).
//
// A fresh `gjc --print` process, using the real HOME and the real installed plugin registry of
// one agent profile, is driven by a scripted loopback model: it calls jev_check once (one real
// provider call, the only cost) and then plugin_metrics, and the driver reports what the tools
// returned and how the jev-advisor and jev-telemetry journals changed. The child environment is
// an allowlist, so a credential can only come from the profile's own `.env` (GJC injects it) or
// from the plugin's layered resolution; `--describe-config` prints the installed resolution
// (names and layers, never values) under that same environment without calling anything.
//
//   JEV_E2E_REAL=1 bun jev-advisor/scripts/e2e-installed.mjs [--agent-dir DIR] [--gjc CMD...] [--health stderr] [--rrsi-import] [--expect-settings]
//
// The pass gate requires an observed (not absent) installed registry left unchanged, no session
// file written by this run (the child runs --no-session; files are attributed by a run nonce in the
// prompt because other live sessions on the host keep writing), the tracked settings baseline present and unchanged when
// --expect-settings is given, and an rrsi import reporting status ok when --rrsi-import is given.
//   bun jev-advisor/scripts/e2e-installed.mjs --describe-config [--agent-dir DIR] [--env K=V ...]
//
// --gjc takes the launcher as one string split on spaces, e.g. "bun /path/gjc.js" for a pinned
// gateway runtime. Exit: 0 decision observed, 1 check failed, 2 refused or prerequisite missing.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const value = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const values = name => args.flatMap((arg, index) => (arg === name ? [args[index + 1]] : []));
const home = os.homedir();
const agentDir = path.resolve(value("--agent-dir") ?? path.join(home, ".gjc", "agent"));
const launcher = (value("--gjc") ?? "gjc").split(" ").filter(Boolean);
const extraEnv = Object.fromEntries(values("--env").map(pair => { const at = pair.indexOf("="); return [pair.slice(0, at), pair.slice(at + 1)]; }));
for (const key of Object.keys(extraEnv)) if (!/^JEV_[A-Z_]+$/.test(key) || /KEY|TOKEN|SECRET/.test(key)) { console.error(`e2e-installed: --env accepts non-secret JEV_* names only (${key})`); process.exit(2); }
const pluginRoot = path.join(agentDir, "gjc-plugins", "jev-advisor");
if (!existsSync(path.join(pluginRoot, "tools", "jev-check.ts"))) { console.error(`e2e-installed: no installed jev-advisor under ${agentDir}`); process.exit(2); }
const manifest = JSON.parse(readFileSync(path.join(pluginRoot, "gajae-plugin.json"), "utf8"));

/** Allowlisted child environment: no inherited credential can reach the child. */
function childEnv(extra = {}) {
	const env = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: process.env.TMPDIR ?? os.tmpdir(), LANG: process.env.LANG ?? "C.UTF-8", NO_COLOR: "1", CI: "1", GJC_CODING_AGENT_DIR: agentDir, GJC_AGENT_DIR: agentDir, ...extraEnv, ...extra };
	if (process.env.JEV_ALIGNMENT_MODE && env.JEV_ALIGNMENT_MODE === undefined) env.JEV_ALIGNMENT_MODE = process.env.JEV_ALIGNMENT_MODE;
	return env;
}

if (args.includes("--describe-config")) {
	// Resolve in a child so the parent's credentials never enter the resolution.
	const script = `const m = await import(${JSON.stringify(pathToFileURL(path.join(pluginRoot, "tools", "jev-check.ts")).href)}); process.stdout.write(JSON.stringify(m.describeEffectiveConfig(process.env)));`;
	const run = spawnSync("bun", ["--no-env-file", "-e", script], { env: childEnv(), encoding: "utf8", timeout: 30000 });
	if (run.status !== 0) { console.error(run.stderr.slice(0, 400)); process.exit(1); }
	console.log(JSON.stringify({ agentDir, plugin: manifest.version, effective: JSON.parse(run.stdout) }, null, 2));
	process.exit(0);
}
if (process.env.JEV_E2E_REAL !== "1") { console.error("e2e-installed: refused; one real provider call needs JEV_E2E_REAL=1"); process.exit(2); }

const journalLines = plugin => {
	const dir = path.join(home, ".gjc-plugin", plugin, "journal", "v1");
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(name => name.endsWith(".jsonl")).sort().flatMap(name => readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean));
};
const before = { legacy: new Set(journalLines("jev-advisor")), telemetry: new Set(journalLines("jev-telemetry")) };
// Side-effect snapshot: installed registry, tracked settings baseline and session store size.
const digestOf = file => { try { return createHash("sha256").update(readFileSync(file)).digest("hex").slice(0, 16); } catch { return null; } };
const walkFiles = (dir, visit) => { const walk = d => { let names; try { names = readdirSync(d); } catch { return; } for (const name of names) { const p = path.join(d, name); let st; try { st = statSync(p); } catch { continue; } if (st.isDirectory()) walk(p); else visit(p, st); } }; walk(dir); };
const countFiles = dir => { let n = 0; walkFiles(dir, () => { n++; }); return n; };
const sideEffects = () => ({ registry: digestOf(path.join(agentDir, "gjc-plugins", "registry.json")), settings: digestOf(path.join(home, ".gjc", "agent", "jev-advisor", "settings.env")), sessionFiles: countFiles(path.join(agentDir, "sessions")) });
// The run nonce goes into the prompt, so a session file written by THIS child (despite --no-session)
// can be told apart from files other live sessions on the same host write meanwhile.
const runNonce = `jev-e2e-${randomUUID()}`;
const runStartedAtMs = Date.now();
const ownSessionFiles = () => {
	const own = [];
	walkFiles(path.join(agentDir, "sessions"), (file, st) => {
		if (st.mtimeMs < runStartedAtMs - 1000 || st.size > 64 * 1024 * 1024) return;
		try { if (readFileSync(file, "utf8").includes(runNonce)) own.push(path.relative(agentDir, file)); } catch { /* unreadable: not ours to judge */ }
	});
	return own;
};
const sideBefore = sideEffects();

function lastToolOutput(data) {
	const items = [...(data.messages ?? data.input ?? [])].reverse();
	const item = items.find(entry => entry.role === "tool" || entry.type === "function_call_output");
	if (!item) throw new Error("request carries no tool result");
	const content = item.output ?? item.content;
	return typeof content === "string" ? content : content.map(part => part.text ?? "").join("");
}
const firstJson = text => JSON.parse(text.slice(text.indexOf("{")));

const state = { step: 0 };
const plan = [
	{ name: "jev_check", arguments: { question: "Does the artifact state that two plus two equals four?", artifact: "Arithmetic note: 2 + 2 = 4." } },
	{ name: "plugin_metrics", arguments: {} },
	...(args.includes("--rrsi-import") ? [{ name: "rrsi", arguments: { action: "import" } }] : []),
];
const toolNames = plan.map(call => call.name);
const server = http.createServer(async (req, res) => {
	try {
		if (req.method === "GET" && req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4o", object: "model", owned_by: "local" }] })); return; }
		let body = "";
		for await (const chunk of req) { body += chunk; if (body.length > 4_000_000) throw new Error("request too large"); }
		const data = JSON.parse(body);
		if (state.step === 0) {
			const offered = (data.tools ?? []).map(tool => tool.function?.name ?? tool.name);
			for (const name of toolNames) if (!offered.includes(name)) throw new Error(`${name} not offered`);
		} else if (state.step === 1) state.check = firstJson(lastToolOutput(data));
		else if (state.step === 2) state.metrics = firstJson(lastToolOutput(data));
		else if (state.step === 3) state.rrsi = lastToolOutput(data);
		const call = plan[state.step];
		const id = `e2e_${state.step}`;
		state.step += 1;
		res.writeHead(200, { "content-type": "text/event-stream" });
		const base = { id, object: "chat.completion.chunk", created: 0, model: "gpt-4o" };
		const delta = call ? { role: "assistant", tool_calls: [{ index: 0, id: `call_${id}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } : { role: "assistant", content: "e2e finished" };
		if (req.url === "/v1/responses") {
			const send = event => res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
			const response = { id: `resp_${id}`, status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
			const item = call ? { id: `fc_${id}`, type: "function_call", call_id: `call_${id}`, name: call.name, arguments: JSON.stringify(call.arguments), status: "completed" } : { id: `msg_${id}`, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "e2e finished", annotations: [] }] };
			send({ type: "response.created", response: { ...response, status: "in_progress" } });
			send({ type: "response.output_item.added", output_index: 0, item: call ? { ...item, arguments: "" } : { ...item, content: [] } });
			if (call) send({ type: "response.function_call_arguments.delta", output_index: 0, item_id: item.id, delta: item.arguments });
			else send({ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "e2e finished" });
			send({ type: "response.output_item.done", output_index: 0, item });
			send({ type: "response.completed", response: { ...response, output: [item] } });
			res.end();
			return;
		}
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
		res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`);
		res.end("data: [DONE]\n\n");
	} catch (error) {
		state.error ??= error.message;
		res.writeHead(500, { "content-type": "application/json" });
		res.end(JSON.stringify({ error: { message: "e2e_endpoint_failed" } }));
	}
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const env = childEnv({ OPENAI_BASE_URL: `http://127.0.0.1:${server.address().port}/v1`, OPENAI_API_KEY: "local-fixture-not-a-real-credential", ...(value("--health") ? { JEV_HEALTH_LINE: value("--health") } : {}) });
const startedAt = Date.now();
const result = await new Promise(resolve => {
	let stdout = ""; let stderr = "";
	const child = spawn(launcher[0], [...launcher.slice(1), "--print", "--no-session", "--no-title", "--no-mcp", "--no-lsp", "--no-pty", "--model", "openai/gpt-4o", "--thinking", "off", "--tools", toolNames.join(","), `Run the listed tools once each, as directed. (${runNonce})`], { cwd: os.tmpdir(), env, detached: true });
	const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 180000);
	child.stdout.on("data", chunk => (stdout += chunk));
	child.stderr.on("data", chunk => (stderr += chunk));
	child.on("close", code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
});
server.close();
const added = (plugin, set) => journalLines(plugin).filter(line => !set.has(line)).map(line => JSON.parse(line));
const legacy = added("jev-advisor", before.legacy).filter(record => record.operation === "check");
const telemetry = added("jev-telemetry", before.telemetry);
const check = state.check ?? null;
const healthLines = result.stderr.split("\n").filter(line => line.startsWith("jev-advisor health:"));
const sideAfter = sideEffects();
const ownSessions = ownSessionFiles();
const rrsi = state.rrsi === undefined ? null : (() => { const text = String(state.rrsi); const status = /store_busy/.test(text) ? "store_busy" : /"status"\s*:\s*"(ok|unavailable|missing|invalid)"/.exec(text)?.[1] ?? "unparsed"; return { status, storeBusy: /store_busy/.test(text), excerpt: text.slice(0, 240) }; })();
const report = {
	schemaVersion: 1,
	kind: "jev-advisor-installed-e2e",
	host: os.hostname(),
	agentDir,
	launcher: launcher.join(" "),
	plugin: manifest.version,
	hooks: manifest.hooks.map(hook => hook.name),
	exitCode: result.code,
	wallMs: Date.now() - startedAt,
	modelRequests: state.step,
	endpointError: state.error ?? null,
	// One jev-advisor check record per jev_check call; a provider request happens only for a configured decision path.
	checkRecords: legacy.length,
	check: check && { status: check.status, verdict: check.verdict ?? null, reason: check.reason ?? null, confidence: check.confidence ?? null, credentialSource: check.credentialSource ?? null, durationMs: check.durationMs ?? null, usage: check.usage ?? null, journalStorage: check.journalStorage ?? null, telemetryStorage: check.telemetryStorage ?? null },
	journal: {
		legacy: legacy.map(record => ({ id: record.id, toolCallDigest: record.toolCallDigest?.slice(0, 12), durationMs: record.durationMs ?? null, checkKeys: Object.keys(record.check ?? {}) })),
		telemetry: telemetry.map(record => ({ id: record.id, toolCallDigest: record.toolCallDigest?.slice(0, 12), check: { ...record.check, probabilities: undefined } })),
	},
	metrics: state.metrics && { status: state.metrics.status, jevAdvisor: state.metrics.plugins?.["jev-advisor"]?.status ?? null, telemetry: state.metrics.telemetry && { status: state.metrics.telemetry.status, records: state.metrics.telemetry.metrics?.records ?? null, joined: state.metrics.telemetry.metrics?.joined ?? null, usage: state.metrics.telemetry.metrics?.usage ?? null, byProvider: state.metrics.telemetry.metrics?.byProvider ?? null }, jevLock: state.metrics.jevLock ?? null },
	healthLines,
	rrsi: rrsi ?? { skipped: "rrsi import not requested (--rrsi-import)" },
	sideEffects: {
		before: sideBefore,
		after: sideAfter,
		registryChecked: sideBefore.registry !== null,
		registryUnchanged: sideBefore.registry !== null && sideBefore.registry === sideAfter.registry,
		settingsPresent: sideBefore.settings !== null,
		settingsUnchanged: sideBefore.settings === sideAfter.settings,
		// Host-wide delta includes other live sessions; ownSessionFiles is the attributable count.
		sessionFilesDelta: sideAfter.sessionFiles - sideBefore.sessionFiles,
		ownSessionFiles: ownSessions.length,
	},
};
console.log(JSON.stringify(report, null, 2));
const ok = result.code === 0 && !state.error && check?.status === "decision" && telemetry.length >= 1 && legacy.length === 1 && report.metrics?.telemetry?.status === "ok" && report.sideEffects.registryUnchanged && report.sideEffects.settingsUnchanged && report.sideEffects.ownSessionFiles === 0
	&& (!args.includes("--expect-settings") || report.sideEffects.settingsPresent)
	&& (!args.includes("--rrsi-import") || rrsi?.status === "ok");
if (!ok) console.error(`e2e-installed: not passed${result.code !== 0 ? `; gjc exit ${result.code}: ${result.stderr.slice(0, 300)}` : ""}`);
process.exitCode = ok ? 0 : 1;
