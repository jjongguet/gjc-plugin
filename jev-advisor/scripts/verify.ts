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

// --- shipped-artifact tripwires ------------------------------------------------
const surfaces = ["hooks/jev-advisor.ts", "tools/jev-advise.ts"];
for (const s of surfaces) {
	const text = await Bun.file(new URL(`../${s}`, import.meta.url)).text();
	check(`artifact ${s}: no real-looking key committed`, !/sk-or-v1-[A-Za-z0-9_-]{12,}/.test(text.replace(/sk-or-v1-test|sk-or-v1-\.\.\./g, "")));
	check(`artifact ${s}: in sync with sources (jev provider + redirect guard present)`, text.includes('jev: { endpoint: "https://openrouter.ai/api/alpha/decisions"') && text.includes('redirect: "error"'));
}
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
