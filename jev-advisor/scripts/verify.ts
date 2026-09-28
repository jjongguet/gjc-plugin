#!/usr/bin/env bun
/**
 * Offline verification for the jev-advisor core — no network, no API spend.
 * Spins up a loopback mock that speaks the TypeSafe "systemone" shape, then
 * exercises config parsing, the egress gate, both wire formats, and the
 * end-to-end decision path. Run: bun scripts/verify.ts (exit 0 = all pass).
 */
import { createServer } from "node:http";
import { readConfig, isConfigured, isAllowedEndpoint, askDecisionModel, PROVIDERS, parseEnvFile, pluginEnvFile, parseDecision, extractAssignment } from "../lib/decision.ts";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
	if (ok) console.log(`  ok  ${name}`);
	else {
		failures += 1;
		console.error(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}

// --- egress gate ------------------------------------------------------------
check("gate: allowlisted HTTPS origin", isAllowedEndpoint("https://openrouter.ai/api/v1/chat/completions"));
check("gate: loopback 127.0.0.1 http", isAllowedEndpoint("http://127.0.0.1:11435/v1/systemone"));
check("gate: loopback localhost http", isAllowedEndpoint("http://localhost:11435/v1/systemone"));
check("gate: loopback [::1] http", isAllowedEndpoint("http://[::1]:11435/v1/systemone"));
check("gate: rejects LAN http", !isAllowedEndpoint("http://192.168.0.5:11435/v1/systemone"));
check("gate: rejects remote http", !isAllowedEndpoint("http://example.com/v1/systemone"));
check("gate: rejects non-allowlisted https", !isAllowedEndpoint("https://evil.example.com/v1/systemone"));
check("gate: rejects garbage", !isAllowedEndpoint("not a url"));

// --- config ------------------------------------------------------------------
const ollayaCfg = readConfig({ JEV_ADVISOR_PROVIDER: "ollaya" }, {});
check("config: ollaya endpoint", ollayaCfg.endpoint === PROVIDERS.ollaya.endpoint, ollayaCfg.endpoint);
check("config: ollaya default model laya", ollayaCfg.model === "laya", ollayaCfg.model);
check("config: ollaya configured WITHOUT any key", isConfigured(ollayaCfg) && ollayaCfg.apiKey === "");
const jevDefault = readConfig({}, {});
check("config: default provider is jev (OpenRouter decisions API)", jevDefault.provider === "jev" && jevDefault.endpoint === "https://openrouter.ai/api/alpha/decisions", { provider: jevDefault.provider, endpoint: jevDefault.endpoint });
check("config: default model typesafe/jev-1.13", jevDefault.model === "typesafe/jev-1.13", jevDefault.model);
const orCfg = readConfig({ JEV_ADVISOR_PROVIDER: "openrouter", JEV_ADVISOR_API_KEY: "sk-or-v1-test" }, {});
check("config: openrouter chat provider keeps a chat model default", orCfg.model === "openai/gpt-5-mini" && orCfg.endpoint.endsWith("/chat/completions"), { model: orCfg.model, endpoint: orCfg.endpoint });
check("config: openrouter configured with env key", isConfigured(orCfg));
check("config: inert with no key and cloud provider", !isConfigured(readConfig({}, {})));
check("config: off is never configured", !isConfigured(readConfig({ JEV_ADVISOR_PROVIDER: "off", JEV_ADVISOR_API_KEY: "x" }, {})));
check("envfile: path is ~/.gjc/agent/jev-advisor/.env", pluginEnvFile().endsWith(".gjc/agent/jev-advisor/.env"), pluginEnvFile());
check(
	"envfile: parseEnvFile round-trip (quotes, comments, export)",
	(() => {
		const parsed = parseEnvFile('JEV_ADVISOR_API_KEY="sk-file"\nexport OPENROUTER_API_KEY=plain # trailing\n# full comment\n');
		return parsed.JEV_ADVISOR_API_KEY === "sk-file" && parsed.OPENROUTER_API_KEY === "plain" && Object.keys(parsed).length === 2;
	})(),
);
check("envfile: process env wins over the file", readConfig({ JEV_ADVISOR_API_KEY: "env-key" }, { OPENROUTER_API_KEY: "file-key" }).apiKey === "env-key");
check("envfile: file is the fallback when env is absent", readConfig({}, { OPENROUTER_API_KEY: "file-key" }).apiKey === "file-key");

// --- mock systemone server + end-to-end -------------------------------------
let captured: { body: any; auth?: string } | null = null;
const mock = createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		captured = { body: JSON.parse(raw), auth: req.headers.authorization };
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				model: "laya",
				answers: {
					tier: { type: "choice", choice: "balanced", confidence: 0.82, probabilities: { balanced: 0.82, fast: 0.1, strong: 0.08 } },
				},
			}),
		);
	});
});
await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
const port = (mock.address() as { port: number }).port;

const cfg = readConfig({ JEV_ADVISOR_PROVIDER: "ollaya", JEV_ADVISOR_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone` }, {});
const decision = await askDecisionModel(cfg, "role: executor\nRefactor the config loader across 4 files", (input, init) => fetch(input, init));
check("e2e: decision parsed from systemone answer", decision?.tier === "balanced" && Math.abs((decision?.confidence ?? 0) - 0.82) < 1e-9, decision);
check("e2e: request used state+questions shape", captured?.body?.state && captured?.body?.questions?.tier?.type === "choice" && !!captured.body.questions.tier.criteria?.fast, captured?.body && { state: !!captured.body.state, q: captured.body.questions?.tier?.type });
check("e2e: no authorization header without a key", captured?.auth === undefined, captured?.auth);
mock.close();

// --- openai-chat wire format still intact (mocked fetch, no network) ---------
let chatInit: { headers: any; body: string } | null = null;
const chatDecision = await askDecisionModel(
	{ ...readConfig({ JEV_ADVISOR_PROVIDER: "openrouter", JEV_ADVISOR_API_KEY: "sk-or-v1-test" }, {}), timeoutMs: 2000 },
	"role: executor\nFix a typo in README.md",
	(input, init) => {
		chatInit = { headers: init?.headers, body: String(init?.body) };
		return Promise.resolve(
			new Response(JSON.stringify({ choices: [{ message: { content: '{"tier":"fast","confidence":0.91,"rationale":"typo fix"}' } }] }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);
	},
);
check("chat: decision parsed", chatDecision?.tier === "fast" && chatDecision?.confidence === 0.91, chatDecision);
check("chat: messages body + bearer header", chatInit && JSON.parse(chatInit.body).messages?.length === 2 && chatInit.headers?.authorization === "Bearer sk-or-v1-test", chatInit && { auth: chatInit.headers?.authorization });


// --- review-driven hardening checks ------------------------------------------
const pin = readConfig({}, {});
check("defaults: full DEFAULTS pin (shadow/0.6/8000/15000/jev)", pin.mode === "shadow" && pin.minConfidence === 0.6 && pin.timeoutMs === 8000 && pin.minIntervalMs === 15000 && pin.provider === "jev", pin);
check("config: blank overrides fall through (empty JEV_ADVISOR_API_KEY)", readConfig({ JEV_ADVISOR_API_KEY: "", OPENROUTER_API_KEY: "sk-or-v1-real" }, {}).apiKey === "sk-or-v1-real");
check("config: blank endpoint override falls back to provider", readConfig({ JEV_ADVISOR_PROVIDER: "jev", JEV_ADVISOR_ENDPOINT: " " }, {}).endpoint === PROVIDERS.jev.endpoint);
check("typesafe-jev: bare model id for the hosted API", readConfig({ JEV_ADVISOR_PROVIDER: "typesafe-jev" }, {}).model === "jev-latest");
check("decision: parseDecision table (fence/prose/garbage/invalid tier/NaN conf)", (() => {
	const fence = parseDecision('```json\n{"tier":"fast","confidence":0.9}\n```');
	const prose = parseDecision('Sure! {"tier":"strong","confidence":0.8,"rationale":"x"} hope that helps');
	const garbage = parseDecision("no json here");
	const badTier = parseDecision('{"tier":"ultra","confidence":0.9}');
	const nanConf = parseDecision('{"tier":"fast","confidence":"high"}');
	return fence?.tier === "fast" && prose?.tier === "strong" && garbage === null && badTier === null && nanConf === null;
})());
check("extraction: realistic v0.17.7 payload → text + requestedTiers (case-folded)", (() => {
	const ex = extractAssignment({ agent: "executor", context: "shared", tasks: [{ id: "t1", description: "Fix typo", assignment: "README typo", tier: "FAST" }, null, { garbage: true }] });
	return ex?.text.includes("role: executor") && ex?.text.includes("#t1") && ex?.text.includes("[requested tier: fast]") && ex?.requestedTiers.length === 1 && ex?.requestedTiers[0] === "fast" && ex?.text.includes("2 unparseable task entries skipped");
})());
check("extraction: empty/null payloads → null", extractAssignment(null) === null && extractAssignment({}) === null && extractAssignment({ tasks: [] }) === null);
check("egress: custom evil endpoint refuses BEFORE any fetch", await askDecisionModel({ ...readConfig({ JEV_ADVISOR_ENDPOINT: "https://evil.example.com/x", JEV_ADVISOR_API_KEY: "k" }, {}), timeoutMs: 500 }, "x", async () => { throw new Error("fetch must not be called"); }) === null);
const systemoneMissingConf = await askDecisionModel({ ...readConfig({ JEV_ADVISOR_PROVIDER: "ollaya", JEV_ADVISOR_ENDPOINT: `http://127.0.0.1:${port}/v1/systemone` }, {}), timeoutMs: 2000 }, "x", () => Promise.resolve(new Response(JSON.stringify({ answers: { tier: { type: "choice", choice: "fast" } } }), { status: 200, headers: { "content-type": "application/json" } })));
check("systemone: missing confidence → no decision (never fabricated 0.5)", systemoneMissingConf === null, systemoneMissingConf);

// --- evidence memory: store, fingerprint, evidence, calibration ---------------
import { existsSync, mkdtempSync, writeFileSync as writeTmpFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import {
	fingerprint as libFingerprint,
	loadState,
	saveState,
	recordEvent,
	enrichLastPre,
	enrichLastPost,
	joinPostToPre,
	memoryHead,
	priorPostCount,
	withEvidence,
	calibrationSummary,
	pluginStateFile,
	type MemoryState,
	type MemoryEvent,
} from "../lib/decision.ts";

check("store: default state path is ~/.gjc/agent/jev-advisor/state.json", pluginStateFile().endsWith(".gjc/agent/jev-advisor/state.json"), pluginStateFile());
const memMock = createServer((req, res) => {
	let raw = "";
	req.on("data", (c) => (raw += c));
	req.on("end", () => {
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				model: "laya",
				answers: { tier: { type: "choice", choice: "balanced", confidence: 0.82, probabilities: { balanced: 0.82, fast: 0.1, strong: 0.08 } } },
			}),
		);
	});
});
await new Promise<void>((resolve) => memMock.listen(0, "127.0.0.1", resolve));
const memPort = (memMock.address() as { port: number }).port;
const memDir = mkdtempSync(`${tmpdir()}/jev-mem-`);
const memFile = `${memDir}/state.json`;
const memCfg = readConfig({ JEV_ADVISOR_STATE: memFile, JEV_ADVISOR_PROVIDER: "ollaya", JEV_ADVISOR_ENDPOINT: `http://127.0.0.1:${memPort}/v1/systemone` }, {});
check("store: JEV_ADVISOR_STATE override respected", memCfg.stateFile === memFile, memCfg.stateFile);
check("store: memory defaults (on / 200 / 10 / 120)", readConfig({}, {}).memoryEnabled === true && readConfig({}, {}).memoryMaxKeys === 200 && readConfig({}, {}).memoryMaxEvents === 10 && readConfig({}, {}).memoryHeadChars === 120);
check("store: JEV_ADVISOR_MEMORY=off disables memory", readConfig({ JEV_ADVISOR_MEMORY: "off" }, {}).memoryEnabled === false);
check("fingerprint: whitespace-collapse determinism", libFingerprint("a  b\n\nc") === libFingerprint("a b c") && libFingerprint("a b c") !== libFingerprint("a b d"));
check("store: corrupt JSON → fresh state", (() => {
	writeTmpFileSync(memFile, "{not json", { mode: 0o600 });
	const state = loadState(memFile);
	return state.version === 1 && Object.keys(state.keys).length === 0;
})());
{
	const state = loadState(memFile);
	const fp = libFingerprint("sample assignment");
	for (let i = 0; i < 11; i++) recordEvent(state, fp, "sample assignment", { kind: "pre", t: 1000 + i, requested: ["fast"] }, { memoryMaxEvents: 10 });
	saveState(memFile, state, memCfg);
	const reloaded = loadState(memFile);
	check("store: ring cap 11 → 10 events", reloaded.keys[fp].events.length === 10, reloaded.keys[fp].events.length);
	check("store: final file mode 0o600 and no tmp residue", (statSync(memFile).mode & 0o777) === 0o600 && !readdirSync(memDir).some(f => f.endsWith(".tmp")), readdirSync(memDir));
}
{
	const state = loadState(memFile);
	for (let i = 0; i < 201; i++) {
		const key = `k${String(i).padStart(4, "0")}`;
		recordEvent(state, key, "", { kind: "pre", t: 5000 + i }, { memoryMaxEvents: 10 });
	}
	saveState(memFile, state, memCfg);
	const reloaded = loadState(memFile);
	const keys = Object.keys(reloaded.keys);
	check("store: key cap 201 → 200 (oldest updatedAt evicted)", keys.length === 200 && !keys.includes("k0000") && keys.includes("k0200"), { len: keys.length, hasK0000: keys.includes("k0000"), hasK0200: keys.includes("k0200") });
}
{
	const cfg = readConfig({ JEV_ADVISOR_MEMORY_HEAD_CHARS: "0" }, {});
	check("head: HEAD_CHARS=0 → fingerprints only (no head stored)", memoryHead("some assignment text", cfg) === "");
}
{
	const record = { events: [{ kind: "post", t: 1, tier: "strong", durationMs: 34000 } satisfies MemoryEvent, { kind: "post", t: 2, error: true, tier: "strong", durationMs: 51000 } satisfies MemoryEvent, { kind: "post", t: 3, error: true, durationMs: 9000 } satisfies MemoryEvent], updatedAt: 3 };
	const enriched = withEvidence("role: executor\n#t1 do the thing", record);
	check("evidence: prepended block content + n=3", enriched.startsWith("prior outcomes (n=3): [strong→ok 34s, strong→error 51s, ?→error 9s]"), enriched.slice(0, 90));
	check("evidence: last re-tier rendered", enriched.includes("last re-tier: strong("), enriched.slice(0, 130));
	check("evidence: hard cap 200 + separator", enriched.split("\n")[0].length <= 200 && enriched.includes("\nrole: executor"), enriched.split("\n")[0].length);
	const longAssignment = "x".repeat(4000);
	const longEnriched = withEvidence(longAssignment, record);
	check("evidence: survives systemone 1900-char slice", longEnriched.slice(0, 1900).startsWith("prior outcomes (n=3)"), longEnriched.slice(0, 40));
	check("evidence: no prior posts → passthrough", withEvidence("plain", { events: [{ kind: "pre", t: 1 }], updatedAt: 1 }) === "plain" && withEvidence("plain", undefined) === "plain");
}
{
	// G5 join + calibration math on a seeded fixture.
	const state: MemoryState = { version: 1, keys: {} };
	const fpA = "aaaa1111aaaa1111";
	const fpB = "bbbb2222bbbb2222";
	// A: pre(fast requested, recommended balanced) → joined post ok 40s; re-tier strong.
	recordEvent(state, fpA, "head A", { kind: "pre", t: 100, requested: ["fast"], tier: "balanced", conf: 0.8 } satisfies MemoryEvent, { memoryMaxEvents: 10 });
	const postA: MemoryEvent = { kind: "post", t: 200, error: false, durationMs: 40000 };
	joinPostToPre(state, fpA, postA);
	recordEvent(state, fpA, "head A", postA, { memoryMaxEvents: 10 });
	enrichLastPost(state, fpA, "strong", 0.7);
	// A2: recommendation-less pre (rate-limited) + unpaired post.
	recordEvent(state, fpA, "head A", { kind: "pre", t: 300, requested: ["fast"] } satisfies MemoryEvent, { memoryMaxEvents: 10 });
	const postA2: MemoryEvent = { kind: "post", t: 400, error: true, durationMs: 5000 };
	joinPostToPre(state, fpA, postA2); // no joinable pre (the only tier-bearing pre is joined)
	recordEvent(state, fpA, "head A", postA2, { memoryMaxEvents: 10 });
	// B: pre(no requested tier, recommended strong) → joined post error 60s.
	recordEvent(state, fpB, "head B", { kind: "pre", t: 500, tier: "strong", conf: 0.9 } satisfies MemoryEvent, { memoryMaxEvents: 10 });
	const postB: MemoryEvent = { kind: "post", t: 600, error: true, durationMs: 60000 };
	joinPostToPre(state, fpB, postB);
	recordEvent(state, fpB, "head B", postB, { memoryMaxEvents: 10 });
	const joined = state.keys[fpA].events.find(e => e.kind === "pre" && e.t === 100);
	check("join: post joins latest unjoined recommendation-bearing pre", joined?.joined === true && postA.preT === 100, { joined: joined?.joined, preT: postA.preT });
	check("join: unpairable post stays unmatched", postA2.preT === undefined);
	const { json, text } = calibrationSummary(state);
	check(
		"calibration: seeded fixture math (pairs/tiers/agreement/totals)",
		json.delegations === 3 &&
			json.pairs.total === 2 &&
			json.pairs.withRequestedTier === 1 &&
			json.pairs.agreed === 0 &&
			json.pairs.byTier.balanced.count === 1 && json.pairs.byTier.balanced.errors === 0 && json.pairs.byTier.balanced.avgDurationMs === 40000 &&
			json.pairs.byTier.strong.count === 1 && json.pairs.byTier.strong.errors === 1 && json.pairs.byTier.strong.avgDurationMs === 60000 &&
			json.reTier.strong === 1 &&
			json.totalsOnly.unmatchedPosts === 1 && json.totalsOnly.recommendationlessPres === 1,
		json,
	);
	check("calibration: text renders stats", text.includes("delegations recorded: 3") && text.includes("matched pairs: 2") && text.includes("agreement: 0/1"), text);
	check("prior count: 2 posts for fpA", priorPostCount(state.keys[fpA]) === 2);
}

// --- adapter harness (concatenated-module, exactly as build.mjs inlines) --------
async function loadSurface(adapterRel: string): Promise<{ register?: unknown; default?: unknown }> {
	const root = new URL("../", import.meta.url);
	const core = await Bun.file(new URL("lib/decision.ts", root)).text();
	const adapter = await Bun.file(new URL(adapterRel, root)).text();
	const dir = mkdtempSync(`${tmpdir()}/jev-surface-`);
	const file = `${dir}/surface.ts`;
	writeTmpFileSync(file, `${core.trimEnd()}\n\n${adapter.trimStart()}`, { mode: 0o600 });
	return import(pathToFileURL(file).href);
}

function withEnv(patch: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> | void {
	const saved: Record<string, string | undefined> = {};
	for (const [k, v] of Object.entries(patch)) {
		saved[k] = process.env[k];
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	const restore = () => {
		for (const [k, v] of Object.entries(saved)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
	};
	try {
		const out = fn();
		if (out && typeof (out as Promise<void>).then === "function") return (out as Promise<void>).finally(restore);
		restore();
	} catch (error) {
		restore();
		throw error;
	}
}

const taskPayload = {
	agent: "executor",
	tasks: [{ id: "t1", description: "Fix typo", assignment: "Fix the typo in README.md line 3", tier: "fast" }],
};

// Tool adapter: real typebox shape + report path (offline).
{
	const surface = await loadSurface("src/tool.adapter.ts");
	const toolFactory = surface.default as (pi: unknown) => Record<string, unknown>;
	let objectFields: Record<string, unknown> = {};
	const pi = {
		typebox: {
			Type: {
				Object: (fields: Record<string, unknown>) => {
					objectFields = fields;
					return { __type: "object", fields };
				},
				String: (options?: Record<string, unknown>) => ({ __type: "string", ...options }),
				Optional: (schema: unknown) => ({ __type: "optional", schema }),
			},
		},
	};
	const tool = toolFactory(pi) as {
		parameters: { fields: Record<string, { __type?: string; schema?: unknown }> };
		description: string;
		execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ type: string; text: string }> }>;
	};
	check("tool: real typebox shape — report exposed, assignment optional", objectFields.report !== undefined && (objectFields.assignment as { __type?: string }).__type === "optional" && (objectFields.assignment as { schema?: { __type?: string } }).schema?.__type === "string", Object.keys(objectFields));
	check("tool: description advertises report", tool.description.includes("calibration"), tool.description);
	// Seed a state file, then read the report with the provider OFF (proves local-only).
	const reportFile = `${memDir}/report-state.json`;
	{
		const state = loadState(memFile);
		state.keys = {};
		const fp = libFingerprint("calibration fixture");
		recordEvent(state, fp, "", { kind: "pre", t: 100, requested: ["fast"], tier: "balanced", conf: 0.8 } satisfies MemoryEvent, { memoryMaxEvents: 10 });
		const post: MemoryEvent = { kind: "post", t: 200, error: false, durationMs: 40000 };
		joinPostToPre(state, fp, post);
		recordEvent(state, fp, "", post, { memoryMaxEvents: 10 });
		saveState(reportFile, state, memCfg);
	}
	await withEnv({ JEV_ADVISOR_STATE: reportFile, JEV_ADVISOR_PROVIDER: "off" }, async () => {
		const result = await tool.execute("t1", { report: "calibration" });
		check("tool: report=calibration offline with provider off", result.content[0].text.includes("delegations recorded: 1") && result.content[0].text.includes("matched pairs: 1"), result.content[0].text);
		const bogus = await tool.execute("t1", { report: "bogus" });
		check("tool: invalid report → guidance", bogus.content[0].text.includes("unknown report"), bogus.content[0].text);
		const empty = await tool.execute("t1", {});
		check("tool: no assignment + no report → guidance", empty.content[0].text.includes("provide an assignment"), empty.content[0].text);
	});
}

// Hook adapter (G3): pre recorded before the rate-limit gate; enrich after decision.
{
	const surface = await loadSurface("src/hook.adapter.ts");
	const register = surface.default as (api: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) => void;
	let handler: ((event: unknown, ctx: unknown) => unknown) | null = null;
	register({ on: (event, h) => { if (event === "tool_call") handler = h; } });
	if (!handler) {
		check("harness: tool_call handler registered", false);
	} else {
		const hookFile = `${memDir}/hook-state.json`;
		await withEnv({ JEV_ADVISOR_STATE: hookFile, JEV_ADVISOR_PROVIDER: "ollaya", JEV_ADVISOR_ENDPOINT: `http://127.0.0.1:${memPort}/v1/systemone`, JEV_ADVISOR_MIN_INTERVAL_MS: "15000" }, async () => {
			const statuses: string[] = [];
			const ctx = { ui: { setStatus: (_k: string, text: string | undefined) => { if (text) statuses.push(text); }, setWidget: () => {}, notify: () => {} } };
			await handler({ type: "tool_call", toolName: "task", toolCallId: "c1", input: taskPayload }, ctx);
			let state = loadState(hookFile);
			let events = Object.values(state.keys)[0]?.events ?? [];
			check("hook: pre recorded with requested tiers (save 1)", events.some(e => e.kind === "pre" && e.requested?.includes("fast")), events);
			check("hook: pre enriched with provider decision (save 2)", events.some(e => e.kind === "pre" && e.tier === "balanced" && e.conf === 0.82), events);
			// Privacy tripwire handled below with an unconfigured run; second rapid call hits the rate limit.
			await handler({ type: "tool_call", toolName: "task", toolCallId: "c2", input: taskPayload }, ctx);
			state = loadState(hookFile);
			events = Object.values(state.keys)[0]?.events ?? [];
			const pres = events.filter(e => e.kind === "pre");
			check("hook: rate-limited second call still records a recommendation-less pre", pres.length === 2 && pres[1].tier === undefined, pres);
		});
		// Privacy tripwire: an inert plugin (provider=off — the same isConfigured
		// gate a missing key falls through) must write NO state file. The
		// recording block sits after the gate; if it ever moved above it, this
		// catches it. (A missing-key case cannot be simulated on a machine with
		// a real key in ~/.gjc/agent/jev-advisor/.env — the file env feeds
		// readConfig — so provider=off is the deterministic equivalent.)
		const inertFile = `${memDir}/inert-state.json`;
		await withEnv({ JEV_ADVISOR_STATE: inertFile, JEV_ADVISOR_PROVIDER: "off" }, async () => {
			const out = await handler({ type: "tool_call", toolName: "task", toolCallId: "c3", input: taskPayload }, {});
			check("hook: inert (provider=off) → returns undefined AND writes no state file", out === undefined && !existsSync(inertFile), { out: String(out), exists: existsSync(inertFile) });
		});
	}
}

// Result adapter (G4/G5): post recorded before the rate-limit gate; observe-only.
{
	const surface = await loadSurface("src/result.adapter.ts");
	const register = surface.default as (api: { on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void }) => void;
	let handler: ((event: unknown, ctx: unknown) => unknown) | null = null;
	register({ on: (event, h) => { if (event === "tool_result") handler = h; } });
	if (!handler) {
		check("harness: tool_result handler registered", false);
	} else {
		const resultFile = `${memDir}/result-state.json`;
		await withEnv({ JEV_ADVISOR_STATE: resultFile, JEV_ADVISOR_PROVIDER: "ollaya", JEV_ADVISOR_ENDPOINT: `http://127.0.0.1:${memPort}/v1/systemone`, JEV_ADVISOR_MIN_INTERVAL_MS: "15000" }, async () => {
			const resultEvent = {
				type: "tool_result",
				toolName: "task",
				toolCallId: "c1",
				input: taskPayload,
				content: [{ type: "text", text: "fixed the typo" }],
				details: { subagents: [{ status: "completed", durationMs: 12000 }] },
				isError: false,
			};
			const first = await handler(resultEvent, { ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} } });
			let state = loadState(resultFile);
			let events = Object.values(state.keys)[0]?.events ?? [];
			check("result: post recorded with total subagent time + not error", events.some(e => e.kind === "post" && e.error === false && e.durationMs === 12000), events);
			check("result: handler returns undefined (observe-only)", first === undefined, first);
			const second = await handler(resultEvent, { ui: { setStatus: () => {}, setWidget: () => {}, notify: () => {} } });
			state = loadState(resultFile);
			events = Object.values(state.keys)[0]?.events ?? [];
			const posts = events.filter(e => e.kind === "post");
			check("result: rate-limited second outcome still records", posts.length === 2, posts);
			check("result: second handler still returns undefined", second === undefined, second);
		});
	}
}

rmSync(memDir, { recursive: true, force: true });
memMock.close();

// --- shipped-artifact tripwires ------------------------------------------------
const surfaces = ["hooks/jev-advisor.ts", "tools/jev-advise.ts", "hooks/jev-advisor-result.ts"];
for (const s of surfaces) {
	const text = await Bun.file(new URL(`../${s}`, import.meta.url)).text();
	check(`artifact ${s}: no real-looking key committed`, !/sk-or-v1-[A-Za-z0-9_-]{12,}/.test(text.replace(/sk-or-v1-test|sk-or-v1-\.\.\./g, "")));
	check(`artifact ${s}: in sync with sources (jev provider + redirect guard present)`, text.includes('jev: { endpoint: "https://openrouter.ai/api/alpha/decisions"') && text.includes('redirect: "error"'));
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
