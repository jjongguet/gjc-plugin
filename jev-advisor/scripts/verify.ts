#!/usr/bin/env bun
/** Offline generated-package acceptance. No product import before child isolation. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, symlinkSync, copyFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const script = fileURLToPath(import.meta.url);
const plugin = path.resolve(path.dirname(script), "..");
if (process.argv[2] !== "--isolated") {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jev-offline-")));
	let status = 1;
	try {
		for (const dir of ["home", "tmp", "cwd", "config"]) mkdirSync(path.join(root, dir), { mode: 0o700 });
		const child = spawnSync(process.execPath, ["--no-env-file", script, "--isolated", root], {
			cwd: path.join(root, "cwd"),
			env: { HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), XDG_CONFIG_HOME: path.join(root, "config"), LC_ALL: "C", JEV_VERIFY_CHILD: "1" },
			stdio: "inherit",
			timeout: 120000,
		});
		if (child.error) console.error(child.error.message);
		status = child.status ?? 1;
	} finally { rmSync(root, { recursive: true, force: true }); }
	process.exitCode = status;
} else {
	await runSuite(process.argv[3]);
}

async function runSuite(root: string) {
	assert.equal(process.env.JEV_VERIFY_CHILD, "1");
	assert.equal(os.homedir(), path.join(root, "home"));
	assert.equal(process.cwd(), path.join(root, "cwd"));
	assert.equal(process.env.OPENROUTER_API_KEY, undefined);
	let cases = 0;
	let failures = 0;
	let fetchCalls = 0;
	let unexpectedFetches = 0;
	let responder: ((url: string, init: RequestInit) => Promise<Response> | Response) | undefined;
	globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
		fetchCalls++;
		if (!responder) { unexpectedFetches++; throw new Error("Unexpected fetch: offline transport denied"); }
		assert.equal(init.redirect, "error");
		const auth = new Headers(init.headers).get("authorization");
		assert.ok(!auth || auth === "Bearer synthetic-key", "only synthetic credentials may reach stub");
		return responder(String(url), init);
	}) as typeof fetch;
	const core = await import(pathToFileURL(path.join(plugin, "lib/decision.ts")).href);
	const preModule = await import(pathToFileURL(path.join(plugin, "hooks/jev-advisor.ts")).href);
	const resultModule = await import(pathToFileURL(path.join(plugin, "hooks/jev-advisor-result.ts")).href);
	const toolModule = await import(pathToFileURL(path.join(plugin, "tools/jev-advise.ts")).href);
	assert.ok(core.pluginEnvFile().startsWith(path.join(root, "home") + path.sep));
	assert.ok(!existsSync(core.pluginEnvFile()));
	const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
		cases++;
		try { await fn(); console.log(`ok ${cases} ${name}`); }
		catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`); }
	};
	const cfg = (overrides: Record<string, string> = {}) => core.readConfig({ JEV_ADVISOR_API_KEY: "synthetic-key", JEV_ADVISOR_MIN_INTERVAL_MS: "0", ...overrides }, {});
	const batch = (assignments = ["Repair a typo"], tiers = ["fast"]) => ({ agent: "executor", tasks: assignments.map((assignment, i) => ({ id: `input-${i}`, assignment, tier: tiers[i] ?? "balanced" })) });
	const task = (text = "Repair a typo", cap: 1900 | 4000 = 4000) => core.extractTasks(batch([text]), cap).tasks[0];
	const decision = (tier = "balanced", confidence = 0.9, extra = {}) => ({ tier, confidence, ...extra });
	const system = (value = decision()) => new Response(JSON.stringify({ answers: { tier: { choice: value.tier, ...value } } }));
	const chat = (value: unknown) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(value) } }] }));
	const probabilities = { fast: 0.1, balanced: 0.8, strong: 0.1 };
	const advice = (tier = "balanced") => ({ status: "decision", tier, confidence: 0.9, confidenceKind: "provider_choice", probabilities });
	const limits = { memoryMaxKeys: 200, memoryMaxEvents: 10 };
	let serial = 0;
	const base = () => path.join(root, `case-${++serial}`, "state.json");
	const env = (overrides: Record<string, string> = {}) => {
		for (const key of Object.keys(process.env)) if (key.startsWith("JEV_ADVISOR_") || key === "OPENROUTER_API_KEY") delete process.env[key];
		Object.assign(process.env, { JEV_ADVISOR_API_KEY: "synthetic-key", JEV_ADVISOR_MIN_INTERVAL_MS: "0", JEV_ADVISOR_STATE: base(), JEV_ADVISOR_MODE: "hint", ...overrides });
	};
	const stateFile = () => core.version2StateFile(process.env.JEV_ADVISOR_STATE!);
	const state = () => { const r = core.readEvidenceV2(stateFile()); assert.equal(r.status, "ok"); return r.value; };
	const records = (s = state()) => Object.values(s.groups).flatMap((g: any) => Object.values(g.tasks)) as any[];
	const context = (session = "session-a") => ({ sessionManager: { getSessionId: () => session }, ui: { notify() {}, setWidget() {} } });
	const hook = (module: any) => { let handler: any; module.default({ on: (_: string, fn: any) => { handler = fn; } }); return handler; };
	const call = (id = "call-a", input = batch()) => ({ type: "tool_call", toolName: "task", toolCallId: id, input });
	const launch = (id = "call-a", input = batch(), jobId = "job-a", extra: any = {}) => ({ type: "tool_result", toolName: "task", toolCallId: id, input, details: { results: [], async: { state: "running", type: "task", jobId }, ...extra }, isError: false });
	const terminal = (entries: any[], extra: any = {}) => ({ type: "tool_result", toolName: "subagent", details: { subagents: entries }, isError: false, ...extra });
	const entry = (jobId = "job-a", status = "completed", extra = {}) => ({ jobId, id: `allocated-${jobId}`, status, ...extra });
	const manual = toolModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
	const text = (value: any) => value.content[0].text;
	const parse = (value: unknown) => core.parseDecision(JSON.stringify(value));
	const request = (value: any, config = cfg(), input = task()) => core.askDecisionModel(config, input, async (_url: any, init: any) => {
		assert.equal(init.redirect, "error");
		return config.provider === "openrouter" ? chat(value) : system(value);
	});

	await check("egress allowlist and credentials/redirect boundary", () => {
		for (const url of ["https://openrouter.ai/api/alpha/decisions", "https://api.typesafe.ai/v1/systemone", "http://127.0.0.1:11435/v1/systemone", "http://[::1]:1234/"]) assert.equal(core.isAllowedEndpoint(url), true);
		for (const url of ["https://evil.invalid/", "http://openrouter.ai/", "http://192.168.0.2/", "http://key:secret@localhost/", "https://key:secret@openrouter.ai/", "file:///tmp/a"]) assert.equal(core.isAllowedEndpoint(url), false);
	});
	await check("config precedence, disabled/missing key and versioned paths", () => {
		assert.equal(core.readConfig({ JEV_ADVISOR_API_KEY: "env" }, { JEV_ADVISOR_API_KEY: "file" }).apiKey, "env");
		assert.equal(core.isConfigured(core.readConfig({}, {})), false);
		assert.equal(core.isConfigured(cfg({ JEV_ADVISOR_PROVIDER: "off" })), false);
		assert.equal(core.version2StateFile("/x/my.json"), "/x/my.v2.json");
		assert.equal(core.version2StateFile("/x/custom"), "/x/custom.v2");
		assert.equal(core.providerPromptLimit(cfg({ JEV_ADVISOR_PROVIDER: "ollaya" })), 1900);
		assert.equal(core.providerPromptLimit(cfg()), 4000);
	});
	await check("mixed tasks, malformed entries and bounded extraction", () => {
		const b = batch(["Mechanical typo", "Design distributed transaction recovery"], ["fast", "strong"]);
		const x = core.extractTasks({ ...b, context: "Shared acceptance constraint" }, 4000);
		assert.equal(x.tasks.length, 2); assert.ok(x.tasks[0].prompt.includes("Shared acceptance constraint"));
		assert.ok(!x.tasks[0].prompt.includes("distributed")); assert.ok(!x.tasks[1].prompt.includes("Mechanical"));
		assert.equal(core.extractTasks({ tasks: [{ id: "only-id", tier: "fast" }, null, { assignment: 12 }] }, 4000).rejected.length, 3);
		assert.equal(core.extractTasks({ assignment: "flat unsupported" }, 4000).tasks.length, 0);
		const many = core.extractTasks(batch(Array.from({ length: 33 }, (_, i) => `task ${i}`)), 4000);
		assert.equal(many.tasks.length, 32); assert.equal(many.omittedCount, 1);
	});
	await check("semantic fingerprint excludes ids/tier/order but preserves full content", () => {
		const a = batch(["  code\n  indentation matters\n"]); const b = structuredClone(a);
		b.tasks[0].id = "new"; b.tasks[0].tier = "strong";
		assert.equal(core.extractTasks(a, 4000).tasks[0].fingerprint, core.extractTasks(b, 4000).tasks[0].fingerprint);
		assert.notEqual(task("x".repeat(5000) + "A").fingerprint, task("x".repeat(5000) + "B").fingerprint);
		assert.notEqual(task("code\n x").fingerprint, task("code\n  x").fingerprint);
	});
	for (const provider of ["jev", "typesafe-jev", "openrouter", "ollaya"]) {
		await check(`${provider} exact complete prompt and limit+1`, async () => {
			const config = cfg({ JEV_ADVISOR_PROVIDER: provider }); const cap = core.providerPromptLimit(config);
			const overhead = task("x", cap).prompt.length - 1;
			const exact = task("x".repeat(cap - overhead), cap); assert.equal(exact.prompt.length, cap);
			let n = 0;
			const fetcher = async (_url: any, init: any) => { n++; const body = JSON.parse(init.body); assert.equal(body.state ?? body.messages[1].content, exact.prompt); return provider === "openrouter" ? chat(decision()) : system(); };
			assert.equal((await core.askDecisionModel(config, exact, fetcher)).status, "decision");
			assert.equal((await core.askDecisionModel(config, task("x".repeat(cap - overhead + 1), cap), fetcher)).reason, "input_too_large");
			assert.equal(n, 1);
		});
	}
	await check("hosted Jev transmits late shared context beyond old cap unchanged", async () => {
		const x = core.extractTasks({ ...batch(["short work"]), context: "c".repeat(2300) + "LATE-CONSTRAINT" }, 4000).tasks[0];
		let seen = "";
		await core.askDecisionModel(cfg(), x, async (_: any, init: any) => { seen = JSON.parse(init.body).state; return system(); });
		assert.equal(seen, x.prompt); assert.ok(seen.includes("LATE-CONSTRAINT"));
	});
	for (const provider of ["jev", "openrouter"]) {
		await check(`${provider} strict confidence and probability parsing`, async () => {
			const config = cfg({ JEV_ADVISOR_PROVIDER: provider });
			for (const bad of [undefined, null, true, "0.9", -0.1, 1.1]) assert.equal((await request({ tier: "fast", confidence: bad }, config)).status, "no_decision");
			for (const valid of [0, 1]) assert.equal((await request(decision("fast", valid), config)).confidence, valid);
			const out = await request(decision("balanced", 0.9, { probabilities }), config); assert.deepEqual(out.probabilities, probabilities);
			assert.equal((await request(decision(), config)).probabilities, undefined);
			for (const p of [{ fast: 1 }, { ...probabilities, unknown: 0 }, { fast: -1, balanced: 1, strong: 1 }, { fast: "0.1", balanced: 0.8, strong: 0.1 }, { fast: 0.1, balanced: 0.1, strong: 0.1 }]) assert.equal((await request(decision("balanced", 0.9, { probabilities: p }), config)).status, "no_decision");
		});
	}
	await check("malformed JSON, tier, partial and reasoning-only responses", async () => {
		assert.equal(parse({ tier: "unknown", confidence: 1 }).status, "no_decision");
		assert.equal(core.parseDecision('{"tier":"fast",').status, "no_decision");
		for (const payload of [{ choices: [{ message: { content: null, reasoning: '{"tier":"fast","confidence":1}' } }] }, { choices: [{ error: { message: "secret" }, message: { content: '{"tier":"fast","confidence":1}' } }] }, {}]) {
			assert.equal((await core.askDecisionModel(cfg({ JEV_ADVISOR_PROVIDER: "openrouter" }), task(), async () => new Response(JSON.stringify(payload)))).reason, "invalid_response");
		}
	});
	await check("HTTP, rejected transport, overflow and invalid endpoint fail open", async () => {
		for (const status of [401, 429, 500]) assert.deepEqual(await core.askDecisionModel(cfg(), task(), async () => new Response("private", { status })), { status: "no_decision", reason: "provider_error", httpStatus: status });
		assert.equal((await core.askDecisionModel(cfg(), task(), async () => { throw new Error("private"); })).reason, "provider_error");
		assert.equal((await core.askDecisionModel(cfg(), task(), async () => new Response("x".repeat(65537)))).reason, "invalid_response");
		let n = 0; assert.equal((await core.askDecisionModel(cfg({ JEV_ADVISOR_ENDPOINT: "https://evil.invalid" }), task(), async () => { n++; return system(); })).reason, "invalid_endpoint"); assert.equal(n, 0);
	});
	await check("abort before/during request and timeout", async () => {
		const before = new AbortController(); before.abort(); let n = 0;
		assert.equal((await core.askDecisionModel(cfg(), task(), async () => { n++; return system(); }, before.signal)).reason, "aborted"); assert.equal(n, 0);
		const during = new AbortController();
		const pending = core.askDecisionModel(cfg(), task(), async (_: any, init: any) => new Promise((_resolve, reject) => { init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); during.abort(); }), during.signal);
		assert.equal((await pending).reason, "aborted");
		const keepAlive = setTimeout(() => {}, 100);
		try { assert.equal((await core.askDecisionModel(cfg(), task(), async (_: any, init: any) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })), undefined, 5)).reason, "timeout"); }
		finally { clearTimeout(keepAlive); }
	});

	await check("generated hook mixed decisions and four-call budget", async () => {
		env(); responder = (_url, init) => system(decision(JSON.parse(String(init.body)).state.includes("hard-work") ? "strong" : "fast"));
		const pre = hook(preModule); const start = fetchCalls;
		assert.equal(await pre(call("mixed", batch(["easy-work", "hard-work", "third", "fourth", "fifth"])), context()), undefined);
		assert.equal(fetchCalls - start, 4); const rows = records();
		assert.equal(rows.find(r => r.ref.taskIndex === 0).advice.tier, "fast");
		assert.equal(rows.find(r => r.ref.taskIndex === 1).advice.tier, "strong");
		assert.equal(rows.find(r => r.ref.taskIndex === 4).advice.reason, "batch_limit");
	});
	await check("provider off, missing key and memory off have no prohibited writes", async () => {
		for (const mode of ["off", "missing", "memory-off"]) {
			env(mode === "off" ? { JEV_ADVISOR_PROVIDER: "off" } : mode === "memory-off" ? { JEV_ADVISOR_MEMORY: "off" } : {});
			if (mode === "missing") delete process.env.JEV_ADVISOR_API_KEY;
			const start = fetchCalls; responder = () => system();
			await hook(preModule)(call(), context()); await hook(resultModule)(terminal([entry()]), context());
			assert.equal(existsSync(stateFile()), false, mode);
			assert.equal(fetchCalls - start, mode === "memory-off" ? 1 : 0);
		}
	});
	await check("hint/shadow never block, enforce task-local threshold and cached replay", async () => {
		for (const mode of ["hint", "shadow", "enforce"]) {
			env({ JEV_ADVISOR_MODE: mode, JEV_ADVISOR_MIN_CONFIDENCE: "0.9", JEV_ADVISOR_MIN_INTERVAL_MS: "10000" }); responder = () => system(decision("strong", 0.9));
			const pre = hook(preModule); const first = await pre(call(), context());
			assert.equal(first?.block, mode === "enforce" ? true : undefined);
			const start = fetchCalls; assert.deepEqual(await pre(call(), context()), first); assert.equal(fetchCalls, start);
			if (mode === "enforce") { await hook(resultModule)(launch(), context()); assert.equal(records()[0].launchDisposition, "blocked"); assert.equal(records()[0].jobKey, null); }
		}
	});
	await check("enforce unknown, oversize, low confidence and overprovisioned fail open", async () => {
		for (const variant of ["missing", "oversize", "low", "over"]) {
			env({ JEV_ADVISOR_MODE: "enforce", JEV_ADVISOR_MIN_CONFIDENCE: "0.9" }); responder = () => system(decision("balanced", variant === "low" ? 0.89 : 0.9));
			const b: any = batch([variant === "oversize" ? "x".repeat(5000) : "work"], [variant === "over" ? "strong" : "fast"]);
			if (variant === "missing") delete b.tasks[0].tier;
			assert.equal(await hook(preModule)(call("edge", b), context()), undefined);
			if (variant === "oversize") assert.equal(records()[0].advice.reason, "input_too_large");
		}
	});
	await check("cooldown first-zero/exact boundary/failed reservation and deadline", async () => {
		const original = Object.getOwnPropertyDescriptor(performance, "now"); let clock = 0;
		Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
		try {
			env({ JEV_ADVISOR_MIN_INTERVAL_MS: "100" }); const pre = hook(preModule); responder = () => system(); let start = fetchCalls;
			await pre(call("t0"), context()); clock = 99; await pre(call("t99"), context()); assert.equal(fetchCalls - start, 1);
			clock = 100; await pre(call("t100"), context()); clock = 201; await pre(call("t201"), context()); assert.equal(fetchCalls - start, 3);
			assert.equal(records().find(r => r.ref.toolCallId === "t99").advice.reason, "rate_limited");
			env({ JEV_ADVISOR_MIN_INTERVAL_MS: "100" }); const failed = hook(preModule); clock = 0; responder = () => { throw new Error("fixture failure"); }; start = fetchCalls;
			await failed(call("failed"), context()); clock = 99; await failed(call("throttled"), context()); assert.equal(fetchCalls - start, 1);
			env(); clock = 0; responder = () => { clock = 8001; return system(); }; start = fetchCalls;
			await hook(preModule)(call("budget", batch(["first", "second"])), context()); assert.equal(fetchCalls - start, 1);
			assert.equal(records().find(r => r.ref.taskIndex === 1).advice.reason, "budget_exceeded");
		} finally { if (original) Object.defineProperty(performance, "now", original); else delete (performance as any).now; }
	});
	await check("pending duplicate and reversed advice replies preserve exact records", async () => {
		env(); const pre = hook(preModule); const resolvers: ((r: Response) => void)[] = []; responder = () => new Promise(resolve => resolvers.push(resolve));
		const first = pre(call("first"), context());
		while (resolvers.length < 1) await new Promise(resolve => setImmediate(resolve));
		const before = fetchCalls; await pre(call("first"), context()); assert.equal(fetchCalls, before);
		const second = hook(preModule)(call("second"), context());
		while (resolvers.length < 2) await new Promise(resolve => setImmediate(resolve));
		resolvers[1](system(decision("strong"))); await second; resolvers[0](system(decision("fast"))); await first;
		assert.equal(records().find(r => r.ref.toolCallId === "first").advice.tier, "fast");
		assert.equal(records().find(r => r.ref.toolCallId === "second").advice.tier, "strong");
	});
	await check("same-handler overlapping calls reserve cooldown before response", async () => {
		env({ JEV_ADVISOR_MIN_INTERVAL_MS: "100000" });
		let release!: (r: Response) => void;
		responder = () => new Promise(resolve => { release = resolve; });
		const pre = hook(preModule); const start = fetchCalls;
		const pending = pre(call("overlap-a"), context());
		while (!release) await new Promise(resolve => setImmediate(resolve));
		await pre(call("overlap-b"), context());
		assert.equal(fetchCalls - start, 1);
		assert.equal(records().find(r => r.ref.toolCallId === "overlap-b").advice.reason, "rate_limited");
		release(system()); await pending;
		assert.equal(records().find(r => r.ref.toolCallId === "overlap-a").advice.status, "decision");
	});
	await check("late advice persistence failure is visible without lock stealing", async () => {
		env(); const messages: string[] = []; let release!: (r: Response) => void;
		responder = () => new Promise(resolve => { release = resolve; });
		const ctx = { ...context(), ui: { notify: (s: string) => messages.push(s), setWidget: (_: string, s: string[]) => messages.push(s.join("\n")), setStatus: (_: string, s: string) => messages.push(s) } };
		const start = fetchCalls; const pending = hook(preModule)(call(), ctx);
		while (!release) await new Promise(resolve => setImmediate(resolve));
		const lock = `${stateFile()}.lock`; writeFileSync(lock, "foreign-late-owner", { mode: 0o600 });
		try {
			release(system()); assert.equal(await pending, undefined); assert.equal(fetchCalls - start, 1);
			assert.equal(records()[0].advice, null); assert.ok(messages.some(s => /unavailable.*locked|locked.*unavailable/i.test(s)), messages.join("\n"));
			assert.equal(readFileSync(lock, "utf8"), "foreign-late-owner");
		} finally { rmSync(lock, { force: true }); }
	});
	await check("blocked-marker persistence failure remains visible", async () => {
		env({ JEV_ADVISOR_MODE: "enforce" }); responder = () => system(decision("strong"));
		const messages: string[] = []; const lock = `${stateFile()}.lock`; let planted = false;
		const ctx = { ...context(), ui: {
			notify: (s: string) => messages.push(s), setStatus: (_: string, s: string) => messages.push(s),
			setWidget: (_: string, s: string[]) => { messages.push(s.join("\n")); if (!planted) { planted = true; writeFileSync(lock, "foreign-block-owner", { mode: 0o600 }); } },
		} };
		try {
			assert.equal((await hook(preModule)(call(), ctx))?.block, true);
			assert.equal(records()[0].advice.status, "decision"); assert.equal(records()[0].launchDisposition, "not_observed");
			assert.ok(messages.some(s => /unavailable.*locked|locked.*unavailable/i.test(s)), messages.join("\n"));
			assert.equal(readFileSync(lock, "utf8"), "foreign-block-owner");
		} finally { rmSync(lock, { force: true }); }
	});
	await check("one failed child write does not suppress later healthy child writes", async () => {
		env(); const messages: string[] = []; let requestIndex = 0; const lock = `${stateFile()}.lock`;
		responder = () => {
			requestIndex++;
			if (requestIndex === 1) writeFileSync(lock, "transient-fixture-owner", { mode: 0o600 });
			else { assert.equal(readFileSync(lock, "utf8"), "transient-fixture-owner"); rmSync(lock); }
			return system(decision(requestIndex === 1 ? "fast" : "strong"));
		};
		try {
			assert.equal(await hook(preModule)(call("two-writes", batch(["first", "second"])), {
				...context(), ui: { setWidget: (_: string, rows: string[]) => messages.push(rows.join("\n")), notify: (s: string) => messages.push(s) },
			}), undefined);
			assert.equal(requestIndex, 2);
			assert.equal(records().find(r => r.ref.taskIndex === 0).advice, null);
			assert.equal(records().find(r => r.ref.taskIndex === 1).advice.tier, "strong");
			assert.ok(messages.some(s => s.includes("locked")));
		} finally { rmSync(lock, { force: true }); }
	});
	await check("zero threshold still uses each complete explicit tier and blocks whole batch", async () => {
		env({ JEV_ADVISOR_MODE: "enforce", JEV_ADVISOR_MIN_CONFIDENCE: "0" });
		responder = (_url, init) => system(decision(JSON.parse(String(init.body)).state.includes("hard-child") ? "strong" : "fast", 0));
		const b = batch(["easy-child", "hard-child"], ["strong", "fast"]);
		assert.equal((await hook(preModule)(call("zero", b), context()))?.block, true);
		assert.equal(records().length, 2); assert.ok(records().every(r => r.launchDisposition === "blocked"));
		env({ JEV_ADVISOR_MODE: "enforce", JEV_ADVISOR_MIN_CONFIDENCE: "0" });
		const unknown: any = batch(["hard-child"]); delete unknown.tasks[0].tier;
		assert.equal(await hook(preModule)(call("no-tier", unknown), context()), undefined);
	});
	await check("running launch is not terminal, no result provider calls, singleton exact join", async () => {
		env(); responder = () => system(); await hook(preModule)(call(), context()); const result = hook(resultModule); const start = fetchCalls; responder = undefined;
		const event = launch(); const unchanged = JSON.stringify(event); assert.equal(await result(event, context()), undefined); assert.equal(JSON.stringify(event), unchanged);
		assert.equal(Object.keys(state().jobs).length, 0);
		await result(terminal([entry("job-a", "completed", { durationMs: 12000, requestedModel: "requested", effectiveModel: "actual" })]), context());
		await result(terminal([entry("job-a", "completed", { durationMs: 12000, requestedModel: "requested", effectiveModel: "actual" })]), context());
		assert.equal(fetchCalls, start); const s = core.calibrationSummary(state()).json;
		assert.equal(s.terminalJobs.count, 1); assert.equal(s.terminalJobs.joined, 1); assert.equal(s.terminalJobs.actualTier, null); assert.equal(s.terminalJobs.quality, null);
		assert.equal(s.terminalJobs.effectiveModel.known, 1);
	});
	await check("nonterminal statuses, missing identity and outer failures remain unknown", async () => {
		env(); responder = undefined; const result = hook(resultModule);
		for (const status of ["running", "paused", "queued", "not_found", "already_completed", "unknown"]) await result(terminal([entry(status, status)]), context());
		await result(terminal([{ status: "completed", id: "no-job" }]), context());
		await result(terminal([entry()]), {}); await result(terminal([entry()]), { sessionManager: { getSessionId() { throw new Error("no scope"); } } });
		await result(terminal([entry()], { isError: true }), context());
		for (const malformed of ["true", 1, null, {}]) {
			const malformedEvent = terminal([entry()], { isError: malformed });
			const before = JSON.stringify(malformedEvent);
			assert.equal(await result(malformedEvent, context()), undefined);
			assert.equal(JSON.stringify(malformedEvent), before);
		}
		assert.equal(existsSync(stateFile()), false);
		for (const value of ["", "x".repeat(513), null, 42]) assert.equal(core.readSessionId({ sessionManager: { getSessionId: () => value } }), null);
	});
	await check("failed/cancelled per-child status and positive-duration denominator", async () => {
		env(); responder = undefined; const result = hook(resultModule);
		await result(terminal([entry("failed", "failed", { durationMs: 12000 }), entry("cancelled", "cancelled"), entry("running", "running")]), context());
		const s = core.calibrationSummary(state()).json; assert.equal(s.terminalJobs.count, 2);
		assert.deepEqual(s.terminalJobs.byStatus, { completed: 0, failed: 1, cancelled: 1 });
		assert.equal(s.terminalJobs.durationMs.average, 12000); assert.equal(s.terminalJobs.durationMs.measured, 1);
		assert.equal(s.terminalJobs.unjoined, 2); assert.equal(s.terminalJobs.effectiveModel.unknown, 2);
	});
	await check("terminal-before-launch, cross-session identity and resumed jobs", async () => {
		env(); responder = () => system(); await hook(preModule)(call(), context()); const result = hook(resultModule); responder = undefined;
		await result(terminal([entry()]), context()); assert.equal(core.calibrationSummary(state()).json.terminalJobs.joined, 0);
		await result(launch(), context()); assert.equal(core.calibrationSummary(state()).json.terminalJobs.joined, 1);
		await result(terminal([entry()]), context("session-b")); await result(terminal([entry("new-job", "completed", { id: "allocated-job-a" })]), context());
		assert.equal(core.calibrationSummary(state()).json.terminalJobs.count, 3); assert.equal(core.calibrationSummary(state()).json.terminalJobs.unjoined, 2);
	});
	await check("original batch cardinality and scheduling failures never map singleton", async () => {
		for (const variant of ["batch", "invalid-sibling", "schedule-failure"]) {
			env(); responder = () => system(); const b: any = variant === "batch" ? batch(["first", "second"]) : batch();
			if (variant === "invalid-sibling") b.tasks.push({ id: "invalid" });
			await hook(preModule)(call("batch", b), context()); responder = undefined;
			const result = hook(resultModule); await result(launch("batch", b, "job-a", variant === "schedule-failure" ? { results: [{ index: 0, status: "failed" }] } : {}), context());
			await result(terminal([entry()]), context()); assert.equal(core.calibrationSummary(state()).json.terminalJobs.joined, 0);
		}
	});
	await check("terminal conflicts are explicit and excluded; late running cannot regress", async () => {
		env(); responder = undefined; const result = hook(resultModule);
		await result(terminal([entry("job-a", "completed", { durationMs: 12, effectiveModel: "a" })]), context());
		await result(terminal([entry("job-a", "failed", { durationMs: 15, effectiveModel: "b" })]), context());
		await result(terminal([entry("job-a", "running")]), context());
		const s = core.calibrationSummary(state()).json; assert.equal(s.terminalJobs.count, 1); assert.equal(s.terminalJobs.conflicted, 1);
		assert.deepEqual(s.terminalJobs.byStatus, { completed: 0, failed: 0, cancelled: 0 }); assert.equal(s.terminalJobs.durationMs.average, null); assert.equal(s.terminalJobs.effectiveModel.unknown, 1);
	});
	await check("independent generated surfaces merge concurrent completion and delayed advice", async () => {
		env(); let resolve!: (response: Response) => void; responder = () => new Promise(r => { resolve = r; });
		const pending = hook(preModule)(call(), context()); while (!resolve) await new Promise(r => setImmediate(r));
		await hook(resultModule)(terminal([entry("early", "failed")]), context()); resolve(system()); await pending;
		assert.equal(records().length, 1); assert.equal(records()[0].advice.status, "decision"); assert.equal(Object.keys(state().jobs).length, 1);
	});
	await check("legacy bytes and metadata privacy preserved; manual probability output", async () => {
		env(); const legacy = process.env.JEV_ADVISOR_STATE!; mkdirSync(path.dirname(legacy), { recursive: true }); writeFileSync(legacy, "legacy-sentinel");
		responder = () => system(decision("balanced", 0.9, { probabilities, rationale: "PRIVATE-RATIONALE" }));
		await hook(preModule)(call("privacy", batch(["PRIVATE-ASSIGNMENT"])), context());
		assert.equal(readFileSync(legacy, "utf8"), "legacy-sentinel"); const bytes = readFileSync(stateFile(), "utf8");
		for (const secret of ["PRIVATE-ASSIGNMENT", "PRIVATE-RATIONALE", "synthetic-key"]) assert.ok(!bytes.includes(secret));
		assert.equal(statSync(stateFile()).mode & 0o777, 0o600);
		const before = records().length; const out = JSON.parse(text(await manual.execute("manual", { assignment: "manual work" })));
		assert.deepEqual(out.probabilities, probabilities); assert.equal(records().length, before);
	});
	await check("manual provider caps, invalid input, offline report with provider off", async () => {
		env(); responder = () => system(); assert.equal(JSON.parse(text(await manual.execute("manual", { assignment: "x".repeat(2500) }))).status, "decision");
		process.env.JEV_ADVISOR_PROVIDER = "ollaya"; const n = fetchCalls; assert.equal(JSON.parse(text(await manual.execute("manual", { assignment: "x".repeat(2500) }))).reason, "input_too_large"); assert.equal(fetchCalls, n);
		assert.equal(JSON.parse(text(await manual.execute("manual", {}))).reason, "invalid_task");
		process.env.JEV_ADVISOR_PROVIDER = "off"; responder = undefined; const report = text(await manual.execute("report", { report: "calibration" })); assert.ok(report.includes("No v2 store")); assert.ok(report.includes("not quality"));
	});
	await check("corrupt/version/oversize/symlink/nonregular stores never reset", async () => {
		for (const variant of ["corrupt", "version", "oversize", "symlink", "directory"]) {
			const file = core.version2StateFile(base()); mkdirSync(path.dirname(file), { recursive: true });
			const target = `${file}.target`; if (variant === "symlink") { writeFileSync(target, "sentinel"); symlinkSync(target, file); }
			else if (variant === "directory") mkdirSync(file);
			else writeFileSync(file, variant === "corrupt" ? "{" : variant === "version" ? '{"version":1}' : " ".repeat(2097153), { mode: 0o600 });
			const before = variant === "directory" ? null : readFileSync(file);
			const out = await core.transaction(file, limits, () => {});
			assert.equal(out.status, "unavailable");
			assert.equal(out.reason, variant === "version" ? "unsupported_version" : variant === "corrupt" ? "corrupt" : variant === "oversize" ? "oversized" : "unsafe_path");
			if (before) assert.deepEqual(readFileSync(file), before);
			assert.ok(!existsSync(`${file}.lock`));
		}
	});
	await check("foreign old lock is not stolen; IO errors and callback failures clean up", async () => {
		const file = core.version2StateFile(base()); mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(`${file}.lock`, "foreign-owner", { mode: 0o600 });
		const started = performance.now(); const locked = await core.transaction(file, limits, () => {}); assert.equal(locked.reason, "locked"); assert.ok(performance.now() - started < 500);
		assert.equal(readFileSync(`${file}.lock`, "utf8"), "foreign-owner"); rmSync(`${file}.lock`);
		assert.equal((await core.transaction(file, limits, () => { throw new Error("fixture"); })).status, "unavailable"); assert.ok(!existsSync(`${file}.lock`));
		const invalid = path.join(root, "not-a-directory"); writeFileSync(invalid, "file"); assert.equal((await core.transaction(path.join(invalid, "state.v2.json"), limits, () => {})).status, "unavailable");
	});
	await check("record reuse/conflict, eviction, stale tokens and zero retention", async () => {
		const file = core.version2StateFile(base()); const t = task();
		const first = await core.prepareTaskRecords(file, limits, "s", "a", [t], 1); assert.equal(first.status, "ok");
		assert.equal((await core.prepareTaskRecords(file, limits, "s", "a", [t], 1)).value[0].state, "reused");
		assert.equal((await core.prepareTaskRecords(file, limits, "s", "a", [task("changed")], 2)).value[0].state, "conflict");
		assert.equal((await core.updateTaskAdvice(file, limits, { sessionId: "s", toolCallId: "a", taskIndex: 0 }, first.value[0].token, advice(), 3)).value, false);
		const tiny = { memoryMaxKeys: 1, memoryMaxEvents: 1 }; const fresh = core.version2StateFile(base());
		const old = await core.prepareTaskRecords(fresh, tiny, "s", "a", [t], 1); await core.prepareTaskRecords(fresh, tiny, "s", "b", [t], 2);
		assert.equal((await core.updateTaskAdvice(fresh, tiny, { sessionId: "s", toolCallId: "a", taskIndex: 0 }, old.value[0].token, advice(), 3)).value, false);
		await core.transaction(fresh, { memoryMaxKeys: 0, memoryMaxEvents: 0 }, () => {}); assert.deepEqual(core.readEvidenceV2(fresh).value, core.emptyEvidenceV2());
	});
	await check("independent observed duration and recommendation denominators", async () => {
		const file = core.version2StateFile(base()); const tasks = core.extractTasks(batch(["a", "b"], ["fast", "strong"]), 4000).tasks;
		for (const [i, t] of tasks.entries()) {
			const p = await core.prepareTaskRecords(file, limits, "s", `call${i}`, [t], 1);
			await core.updateTaskAdvice(file, limits, { sessionId: "s", toolCallId: `call${i}`, taskIndex: i }, p.value[0].token, advice(i ? "balanced" : "fast"), 2);
		}
		await core.observeTerminalJob(file, limits, { sessionId: "s", jobId: "a" }, { status: "completed", durationMs: 12000 }, 3);
		await core.observeTerminalJob(file, limits, { sessionId: "s", jobId: "b" }, { status: "failed" }, 3);
		const summary = core.calibrationSummary(core.readEvidenceV2(file).value); assert.deepEqual(summary.json.agreement, { agree: 1, denominator: 2, rate: 0.5 });
		assert.equal(summary.json.terminalJobs.durationMs.average, 12000); assert.ok(summary.text.includes("1 measured jobs"));
	});
	await check("joined per-recommendation duration excludes unjoined jobs and missing values", async () => {
		const file = core.version2StateFile(base()); const t = task();
		for (const [id, tier, duration] of [["a", "fast", 12000], ["b", "fast", undefined], ["c", "strong", undefined]] as const) {
			const p = await core.prepareTaskRecords(file, limits, "s", id, [t], 1);
			await core.updateTaskAdvice(file, limits, { sessionId: "s", toolCallId: id, taskIndex: 0 }, p.value[0].token, advice(tier), 2);
			await core.observeTaskLaunch(file, limits, "s", id, true, 0, { sessionId: "s", jobId: id }, 3);
			await core.observeTerminalJob(file, limits, { sessionId: "s", jobId: id }, { status: id === "b" ? "failed" : "completed", durationMs: duration }, 4);
		}
		await core.observeTerminalJob(file, limits, { sessionId: "s", jobId: "unjoined" }, { status: "completed", durationMs: 99000 }, 4);
		const { json, text: report } = core.calibrationSummary(core.readEvidenceV2(file).value);
		assert.equal(json.terminalJobs.joined, 3); assert.equal(json.terminalJobs.unjoined, 1);
		assert.deepEqual(json.terminalJobs.byRecommendation.fast, { jobs: 2, byStatus: { completed: 1, failed: 1, cancelled: 0 }, durationMs: { sum: 12000, measured: 1, average: 12000 } });
		assert.deepEqual(json.terminalJobs.byRecommendation.strong.durationMs, { sum: 0, measured: 0, average: null });
		assert.ok(report.includes("strong recommendation (exactly joined): 1 jobs")); assert.ok(report.includes("duration unknown"));
	});
	await check("canonical builder exact bytes for all three surfaces and stale candidate", () => {
		const fixture = path.join(root, "builder");
		for (const dir of ["scripts", "lib", "src", "hooks", "tools"]) mkdirSync(path.join(fixture, dir), { recursive: true });
		for (const file of ["scripts/build.mjs", "lib/decision.ts", "src/hook.adapter.ts", "src/result.adapter.ts", "src/tool.adapter.ts"]) copyFileSync(path.join(plugin, file), path.join(fixture, file));
		const result = spawnSync(process.execPath, ["--no-env-file", path.join(fixture, "scripts/build.mjs")], { cwd: fixture, env: { HOME: os.homedir(), TMPDIR: process.env.TMPDIR!, LC_ALL: "C" }, encoding: "utf8", timeout: 30000 });
		assert.equal(result.status, 0, result.stderr);
		for (const file of ["hooks/jev-advisor.ts", "hooks/jev-advisor-result.ts", "tools/jev-advise.ts"]) {
			const expected = readFileSync(path.join(fixture, file)); const actual = readFileSync(path.join(plugin, file)); assert.deepEqual(actual, expected, file);
			assert.notDeepEqual(Buffer.concat([actual, Buffer.from(" ")]), expected); console.log(`artifact-sync ${file}: exact`);
		}
	});
	await check("manifest surfaces and no version change", () => {
		const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8")); assert.equal(manifest.version, "0.0.3");
		assert.deepEqual(manifest.hooks.map((h: any) => [h.event, h.target, h.phase]), [["tool_call", "task", "before"], ["tool_result", "task", "after"], ["tool_result", "subagent", "after"]]);
		assert.equal(new Set(manifest.hooks.map((h: any) => h.name)).size, 3);
	});
	await check("no unexpected fetch and no owned transaction residue", () => {
		assert.equal(unexpectedFetches, 0);
		const walk = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) walk(file); else assert.ok(!item.name.endsWith(".lock") && !item.name.endsWith(".tmp"), file); } };
		walk(root);
	});
	console.log(JSON.stringify({ kind: "api-package-test-report", cases, failures, scriptedFetchCalls: fetchCalls, unexpectedFetches, realNetworkCalls: 0, generatedArtifactsCompared: 3 }));
	console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
	process.exitCode = failures || cases === 0 ? 1 : 0;
}
