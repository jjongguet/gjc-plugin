#!/usr/bin/env bun
/** Offline generated-package acceptance. No product import before child isolation. */
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, symlinkSync, linkSync, copyFileSync, realpathSync, renameSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
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
	const checkToolModule = await import(pathToFileURL(path.join(plugin, "tools/jev-check.ts")).href);
	const alignmentCore = await import(pathToFileURL(path.join(plugin, "lib/alignment.ts")).href);
	const alignmentHookModule = await import(pathToFileURL(path.join(plugin, "hooks/jev-advisor-alignment.ts")).href);
	const alignmentObserveModule = await import(pathToFileURL(path.join(plugin, "hooks/jev-advisor-alignment-observe.ts")).href);
	const alignmentShutdownModule = await import(pathToFileURL(path.join(plugin, "hooks/jev-advisor-alignment-shutdown.ts")).href);
	const sharedResults = await import(pathToFileURL(path.join(plugin, "../shared/lib/results.ts")).href);
	const appendPluginOutcome = sharedResults.appendPluginOutcome as (plugin: any, outcome: any, deps?: any) => Promise<{ persisted: boolean; id?: string; reason?: string }>;
	assert.ok(core.pluginEnvFile().startsWith(path.join(root, "home") + path.sep));
	assert.ok(!existsSync(core.pluginEnvFile()));
	const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
		cases++;
		try { await fn(); console.log(`ok ${cases} ${name}`); }
		catch (error) { failures++; console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`); }
	};
	const withFileIoCounters = async <T>(fn: () => T | Promise<T>) => {
		const calls = { reads: 0, writes: 0 };
		const restore: Array<() => void> = [];
		const instrument = (target: any, method: string, kind: "read" | "write" | "both") => {
			const original = target[method];
			if (typeof original !== "function") return;
			target[method] = function (this: unknown, ...args: unknown[]) {
				if (kind !== "write") calls.reads++;
				if (kind !== "read") calls.writes++;
				return original.apply(this, args);
			};
			restore.push(() => { target[method] = original; });
		};
		for (const method of ["readSync", "readFileSync", "lstatSync", "fstatSync", "statSync", "readdirSync", "existsSync", "accessSync", "opendirSync"]) instrument(fs, method, "read");
		for (const method of ["writeSync", "writeFileSync", "appendFileSync", "mkdirSync", "renameSync", "unlinkSync", "rmSync", "rmdirSync", "mkdtempSync"]) instrument(fs, method, "write");
		instrument(fs, "openSync", "both");
		for (const method of ["readFile", "lstat", "stat", "readdir", "opendir", "access"]) instrument(fs.promises, method, "read");
		for (const method of ["writeFile", "appendFile", "mkdir", "rename", "unlink", "rm", "rmdir"]) instrument(fs.promises, method, "write");
		instrument(fs.promises, "open", "both");
		syncBuiltinESMExports();
		try { return { value: await fn(), calls }; }
		finally { for (const undo of restore.reverse()) undo(); syncBuiltinESMExports(); }
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
		const home = path.join(root, `home-${++serial}`);
		mkdirSync(home, { mode: 0o700 });
		process.env.HOME = home;
		Object.assign(process.env, { JEV_ADVISOR_API_KEY: "synthetic-key", JEV_ADVISOR_MIN_INTERVAL_MS: "0", JEV_ADVISOR_STATE: base(), JEV_ADVISOR_MODE: "hint", ...overrides });
	};
	const stateFile = () => core.version2StateFile(core.pluginStateFile());
	const state = () => { const r = core.readEvidenceV2(stateFile()); assert.equal(r.status, "ok"); return r.value; };
	const records = (s = state()) => Object.values(s.groups).flatMap((g: any) => Object.values(g.tasks)) as any[];
	const journalRecords = () => {
		const dir = path.join(process.env.HOME!, '.gjc-plugin', 'jev-advisor', 'journal', 'v1');
		const inventory = JSON.parse(readFileSync(path.join(dir, 'inventory.json'), 'utf8'));
		return inventory.segments.flatMap((segment: {name:string}) => readFileSync(path.join(dir,segment.name),'utf8').trimEnd().split('\n').map(line => JSON.parse(line)));
	};
	const context = (session = "session-a") => ({ sessionManager: { getSessionId: () => session }, ui: { notify() {}, setWidget() {} } });
	const hook = (module: any) => { let handler: any; module.default({ on: (_: string, fn: any) => { handler = fn; } }); return handler; };
	const call = (id = "call-a", input = batch()) => ({ type: "tool_call", toolName: "task", toolCallId: id, input });
	const launch = (id = "call-a", input = batch(), jobId = "job-a", extra: any = {}) => ({ type: "tool_result", toolName: "task", toolCallId: id, input, details: { results: [], async: { state: "running", type: "task", jobId }, ...extra }, isError: false });
	const terminal = (entries: any[], extra: any = {}) => ({ type: "tool_result", toolName: "subagent", details: { subagents: entries }, isError: false, ...extra });
	const entry = (jobId = "job-a", status = "completed", extra = {}) => ({ jobId, id: `allocated-${jobId}`, status, ...extra });
	const manual = toolModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
	const checkTool = checkToolModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
	const systemCheck = (value: { verdict?: unknown; confidence?: unknown; probabilities?: unknown; rationale?: unknown } = { verdict: "correct", confidence: 0.9 }) =>
		new Response(JSON.stringify({ answers: { check: { type: "choice", choice: value.verdict, confidence: value.confidence, ...(value.probabilities !== undefined ? { probabilities: value.probabilities } : {}), ...(value.rationale !== undefined ? { rationale: value.rationale } : {}) } } }));
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

	await check("check request wire shape, strict verdict/probability parsing and admission bounds", async () => {
		for (const provider of ["jev", "openrouter"]) {
			const config = cfg({ JEV_ADVISOR_PROVIDER: provider });
			const prepared = core.prepareCheck("Is this classification appropriate?", "text: the stadium roared\nlabel: sports", core.providerPromptLimit(config));
			assert.equal(prepared.status, "ok");
			let seen = "";
			const response = await core.askCheckModel(config, prepared.check, async (_: any, init: any) => {
				if (provider === "openrouter") { seen = JSON.parse(init.body).messages[1].content; return chat({ verdict: "correct", confidence: 0.9 }); }
				const body = JSON.parse(init.body); seen = JSON.stringify([body.state, body.questions]);
				assert.equal(body.state, "text: the stadium roared\nlabel: sports");
				assert.equal(body.questions.check.instructions, "Is this classification appropriate?");
				assert.deepEqual(Object.keys(body.questions.check.criteria), ["correct", "incorrect", "unsure"]);
				return systemCheck({ verdict: "correct", confidence: 0.9 });
			});
			assert.equal(response.status, "decision", provider); assert.equal(response.verdict, "correct", provider); assert.equal(response.confidence, 0.9, provider);
			assert.equal(response.confidenceKind, provider === "openrouter" ? "self_reported" : "provider_choice", provider);
			assert.ok(seen.includes("Is this classification appropriate?"), provider);
			assert.ok(seen.includes("label: sports"), provider);
		}
		for (const bad of [{ verdict: "maybe", confidence: 1 }, { verdict: "correct", confidence: "0.9" }, { verdict: "correct", confidence: -0.1 }, { verdict: "correct", confidence: 1.1 }, { verdict: "correct", confidence: null }, { verdict: "correct", confidence: 1, extra: true }, { verdict: "correct", confidence: 1, probabilities: { correct: 0.5, incorrect: 0.4, unsure: 0.05 } }, { verdict: "correct", confidence: 1, probabilities: { correct: 1, incorrect: 0, unsure: 1 } }, { verdict: "correct", confidence: 1, rationale: 5 }]) {
			assert.equal(core.parseCheckDecision(JSON.stringify(bad)).status, "no_decision", JSON.stringify(bad));
		}
		const fenced = core.parseCheckDecision('```json\n{"verdict":"Incorrect","confidence":0.8,"probabilities":{"correct":0.1,"incorrect":0.8,"unsure":0.1},"rationale":"label mismatch"}\n```');
		assert.deepEqual(fenced, { status: "decision", verdict: "incorrect", confidence: 0.8, probabilities: { correct: 0.1, incorrect: 0.8, unsure: 0.1 }, confidenceKind: "self_reported", rationale: "label mismatch" });
		assert.deepEqual(core.parseCheckDecision('{"verdict":"correct","confidence":1,"probabilities":{"correct":1,"incorrect":0,"unsure":0}}').probabilities, { correct: 1, incorrect: 0, unsure: 0 });
		for (const bad of [undefined, null, 17, ""]) assert.equal(core.prepareCheck(bad, "artifact", 4000).status, "invalid_task", String(bad));
		assert.equal(core.prepareCheck("  \n", "artifact", 4000).status, "invalid_task");
		assert.equal(core.prepareCheck("question", " \t ", 4000).status, "invalid_task");
		const cap = 1900;
		const base = core.composeCheckPrompt({ question: "q", artifact: "" }).length;
		assert.equal(core.prepareCheck("q", "a".repeat(cap - base), cap).status, "ok");
		assert.equal(core.prepareCheck("q", "a".repeat(cap - base + 1), cap).status, "input_too_large");
	});

	await check("check path fails open with explicit reasons and rejected configurations never reach transport", async () => {
		const input = core.prepareCheck("Is the artifact acceptable?", "artifact", 4000).check;
		let calls = 0;
		const noFetch = async () => { calls++; return systemCheck(); };
		assert.equal((await core.askCheckModel(cfg({ JEV_ADVISOR_PROVIDER: "off" }), input, noFetch)).reason, "disabled");
		assert.equal((await core.askCheckModel(core.readConfig({}, {}), input, noFetch)).reason, "unconfigured");
		assert.equal((await core.askCheckModel(cfg({ JEV_ADVISOR_ENDPOINT: "https://evil.invalid" }), input, noFetch)).reason, "invalid_endpoint");
		assert.equal(calls, 0, "rejected configurations never call fetch");
		for (const status of [401, 429, 500]) assert.deepEqual(await core.askCheckModel(cfg(), input, async () => new Response("private", { status })), { status: "no_decision", reason: "provider_error", httpStatus: status });
		assert.equal((await core.askCheckModel(cfg(), input, async () => { throw new Error("private"); })).reason, "provider_error");
		assert.equal((await core.askCheckModel(cfg(), input, async () => new Response("x".repeat(65537)))).reason, "invalid_response");
		assert.equal((await core.askCheckModel(cfg(), input, async () => system(decision()))).reason, "invalid_response", "a tier answer is not a check answer");
		assert.equal((await core.askCheckModel(cfg({ JEV_ADVISOR_PROVIDER: "openrouter" }), input, async () => new Response(JSON.stringify({ choices: [{ message: { content: null, reasoning: '{"verdict":"correct","confidence":1}' } }] })))).reason, "invalid_response");
		const before = new AbortController(); before.abort(); let n = 0;
		assert.equal((await core.askCheckModel(cfg(), input, async () => { n++; return systemCheck(); }, before.signal)).reason, "aborted"); assert.equal(n, 0);
		const keepAlive = setTimeout(() => {}, 100);
		try { assert.equal((await core.askCheckModel(cfg(), input, async (_: any, init: any) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })), undefined, 5)).reason, "timeout"); }
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
			const widget: string[] = [];
			const ctx = { ...context(), ui: { notify() {}, setWidget: (_: string, rows: string[]) => widget.push(rows.join("\n")) } };
			const beforeFetch = fetchCalls;
			assert.equal(await hook(preModule)(call("edge", b), ctx), undefined);
			if (variant === "oversize") {
				assert.equal(records()[0].advice.reason, "input_too_large");
				assert.equal(fetchCalls, beforeFetch, "oversize makes no provider call");
				assert.match(widget.join("\n"), /input_too_large: \d+ > 4000 chars/, widget.join("\n"));
			}
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
			assert.equal(core.readEvidenceV2(stateFile()).reason, "locked", "public reader reports the foreign lock instead of a stale snapshot");
			assert.ok(messages.some(s => /unavailable.*locked|locked.*unavailable/i.test(s)), messages.join("\n"));
			assert.equal(readFileSync(lock, "utf8"), "foreign-late-owner");
		} finally { rmSync(lock, { force: true }); }
		assert.equal(records()[0].advice, null, "the failed advice write left the record without advice");
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
			assert.equal(core.readEvidenceV2(stateFile()).reason, "locked", "public reader reports the foreign lock during the block-marker failure");
			assert.ok(messages.some(s => /unavailable.*locked|locked.*unavailable/i.test(s)), messages.join("\n"));
			assert.equal(readFileSync(lock, "utf8"), "foreign-block-owner");
		} finally { rmSync(lock, { force: true }); }
		assert.equal(records()[0].advice.status, "decision"); assert.equal(records()[0].launchDisposition, "not_observed");
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
		assert.equal(s.terminalJobs.count, 1); assert.equal(s.terminalJobs.joined, 1); assert.deepEqual(s.terminalJobs.actualTier, { known: 0, unknown: 1, byTier: { fast: 0, balanced: 0, strong: 0 } }); assert.equal(s.terminalJobs.quality, null);
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
	await check('result root enforcement and manual disabled/report outcomes are journaled privately', async () => {
		env({JEV_ADVISOR_PROVIDER:'off'});
		const legacy = process.env.JEV_ADVISOR_STATE!;
		mkdirSync(path.dirname(legacy),{recursive:true,mode:0o700});writeFileSync(legacy,'legacy-owned-sentinel',{mode:0o600});
		const configured = core.readConfig();
		assert.equal(configured.stateOverrideIgnored,true);
		assert.equal(configured.stateFile,path.join(process.env.HOME!,'.gjc-plugin','jev-advisor','state.json'));
		const start = fetchCalls;
		const result = JSON.parse(text(await manual.execute('manual-off',{assignment:'PRIVATE-MANUAL-ASSIGNMENT'})));
		assert.equal(result.status,'no_decision');assert.equal(result.reason,'disabled');assert.equal(result.journalStorage.persisted,true);assert.equal(result.stateOverrideIgnored,true);
		const report = text(await manual.execute('calibration',{report:'calibration'}));assert.ok(report.includes('No v2 store exists yet.'));assert.ok(report.includes('"persisted":true'));
		await manual.execute('invalid-report',{report:'invalid'});
		const rows = journalRecords();assert.deepEqual(rows.map((row:any)=>row.operation),['advise','calibration','advise']);
		assert.equal(rows[0].advice.reason,'disabled');assert.equal(rows[1].evidenceStorage.status,'missing');assert.equal(rows[2].evidenceStorage.reason,'invalid_input');
		const bytes = JSON.stringify(rows);assert.ok(!bytes.includes('PRIVATE-MANUAL-ASSIGNMENT'));assert.ok(!bytes.includes('synthetic-key'));assert.ok(!bytes.includes(legacy));
		assert.equal(fetchCalls,start);assert.equal(readFileSync(legacy,'utf8'),'legacy-owned-sentinel');assert.equal(existsSync(stateFile()),false);
	});
	await check('automatic advice launch and terminal journals match retained evidence without prose', async () => {
		env();responder=()=>system(decision('balanced',0.9,{probabilities,rationale:'PRIVATE-JOURNAL-RATIONALE'}));
		await hook(preModule)(call('journal',batch(['PRIVATE-JOURNAL-ASSIGNMENT'])),context());
		await hook(resultModule)(launch('journal',batch(['PRIVATE-JOURNAL-ASSIGNMENT'])),context());
		await hook(resultModule)(terminal([entry()]),context());
		const rows=journalRecords();assert.deepEqual(rows.map((row:any)=>row.operation),['task_advice','task_launch','subagent_terminal']);
		assert.equal(rows[0].taskAdvice[0].tier,'balanced');assert.equal(rows[0].taskAdvice[0].basis,'provider_choice');assert.deepEqual(records()[0].advice.probabilities,probabilities);
		assert.equal(rows[1].evidenceStorage.status,'ok');assert.equal(rows[2].evidenceStorage.status,'ok');assert.equal(records().length,1);
		for(const marker of ['PRIVATE-JOURNAL-ASSIGNMENT','PRIVATE-JOURNAL-RATIONALE','synthetic-key'])assert.ok(!JSON.stringify(rows).includes(marker));
	});
	await check('batch advice and multi-child observations each append exactly one complete bounded record',async()=>{
		env();responder=()=>system();await hook(preModule)(call('batch-journal',batch(Array.from({length:32},(_,index)=>`fixture-${index}`))),context());
		let rows=journalRecords();assert.equal(rows.length,1);assert.equal(rows[0].taskAdvice.length,32);assert.equal(rows[0].taskAdvice.filter((advice:any)=>advice.status==='decision').length,4);assert.equal(rows[0].taskAdvice.filter((advice:any)=>advice.reason==='batch_limit').length,28);
		await hook(resultModule)(terminal([entry('journal-completed','completed'),entry('journal-failed','failed')]),context());
		rows=journalRecords();assert.equal(rows.length,2);assert.deepEqual(rows[1].evidenceObservations,{completed:1,failed:1,cancelled:0,stored:2,unavailable:0});assert.equal(rows[1].evidenceStorage.status,'ok');
	});
	await check("manual provider caps, invalid input, offline report with provider off", async () => {
		env(); responder = () => system(); assert.equal(JSON.parse(text(await manual.execute("manual", { assignment: "x".repeat(2500) }))).status, "decision");
		process.env.JEV_ADVISOR_PROVIDER = "ollaya"; const n = fetchCalls; assert.equal(JSON.parse(text(await manual.execute("manual", { assignment: "x".repeat(2500) }))).reason, "input_too_large"); assert.equal(fetchCalls, n);
		assert.equal(JSON.parse(text(await manual.execute("manual", {}))).reason, "invalid_task");
		process.env.JEV_ADVISOR_PROVIDER = "off"; responder = undefined; const report = text(await manual.execute("report", { report: "calibration" })); assert.ok(report.includes("No v2 store")); assert.ok(report.includes("not quality"));
	});
	await check("generated jev_check surfaces journal sanitized check outcomes and stay strict", async () => {
		env();
		responder = (url, init) => {
			assert.ok(String(url).includes("/decisions"), "check uses the configured provider endpoint");
			return systemCheck({ verdict: "incorrect", confidence: 0.8, probabilities: { correct: 0.1, incorrect: 0.8, unsure: 0.1 }, rationale: "PRIVATE-CHECK-RATIONALE" });
		};
		for (const surface of ["src/check.adapter.ts", "tools/jev-check.ts"]) {
			const module = await import(pathToFileURL(path.join(plugin, surface)).href);
			const tool = module.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
			assert.equal(tool.name, "jev_check", surface);
			const before = fetchCalls;
			const invalid = await tool.execute(`check-invalid-${surface}`, { question: "PRIVATE-CHECK-QUESTION" });
			assert.equal(JSON.parse(text(invalid)).reason, "invalid_task", surface);
			assert.equal(fetchCalls, before, `${surface}: invalid check input never reaches the provider`);
			const native = await tool.execute(`check-ok-${surface}`, { question: "Is the label appropriate? PRIVATE-CHECK-QUESTION", artifact: "label: sports" });
			const body = JSON.parse(text(native));
			assert.equal(body.status, "decision", surface);
			assert.equal(body.verdict, "incorrect", surface);
			assert.equal(body.confidence, 0.8, surface);
			assert.equal(body.confidenceKind, "provider_choice", surface);
			assert.deepEqual(body.probabilities, { correct: 0.1, incorrect: 0.8, unsure: 0.1 }, surface);
			assert.equal(body.journalStorage.persisted, true, surface);
			assert.equal(body.stateOverrideIgnored, true, surface);
		}
		const rows = journalRecords();
		assert.equal(rows.length, 4, "two surfaces, one invalid and one decided outcome each");
		assert.deepEqual(rows.map((row: any) => row.operation), ["check", "check", "check", "check"]);
		assert.equal(rows[0].check.status, "no_decision"); assert.equal(rows[0].check.reason, "invalid_task");
		assert.equal(rows[2].check.status, "no_decision"); assert.equal(rows[2].check.reason, "invalid_task");
		for (const row of [rows[1], rows[3]]) {
			assert.equal(row.check.status, "decision"); assert.equal(row.check.verdict, "incorrect");
			assert.equal(row.check.confidence, 0.8); assert.equal(row.check.confidenceKind, "provider_choice");
			assert.deepEqual(row.check.probabilities, { correct: 0.1, incorrect: 0.8, unsure: 0.1 });
			assert.ok(!("rationale" in row.check), "provider rationale is never journaled");
			assert.match(row.toolCallDigest, /^[a-f0-9]{64}$/);
		}
		const serialized = JSON.stringify(rows);
		for (const marker of ["PRIVATE-CHECK-QUESTION", "PRIVATE-CHECK-RATIONALE", "synthetic-key"]) assert.ok(!serialized.includes(marker), marker);
		const snapshot = await sharedResults.readPluginOutcomeSnapshot("jev-advisor");
		assert.equal(snapshot.status, "ok");
		assert.equal(snapshot.records.length, 4);
		assert.ok(snapshot.records.every((record: any) => record.operation === "check"), "canonical reader accepts the check operation");
		assert.ok(snapshot.records.filter((record: any) => record.check.verdict === "incorrect").length === 2, "canonical reader validates the check outcome shape");
		assert.equal((await appendPluginOutcome("jev-advisor", { operation: "check", check: { status: "decision", verdict: "maybe" } } as any)).persisted, false, "unknown verdict is rejected at projection");
		assert.equal((await appendPluginOutcome("jev-advisor", { operation: "check", check: { status: "no_decision", reason: "provider_error" } } as any)).persisted, true);
		const checkRows = journalRecords().filter((row: any) => row.operation === "check");
		assert.equal(checkRows.length, 5);
		const jev = core.aggregateJevMetrics(checkRows);
		assert.equal(jev.checkAdvice.invocations, 5); assert.equal(jev.checkAdvice.present, 5);
		assert.deepEqual(jev.checkAdvice.byVerdict, { incorrect: 2 }); assert.deepEqual(jev.checkAdvice.byReason, { invalid_task: 2, provider_error: 1 });
		assert.equal(jev.manualAdvice.invocations, 0, "check records stay out of the manual-advice bucket");
	});
	await check('lock retry rejects ancestor symlink and same-mode directory replacements',async()=>{
		for(const variant of ['symlink','directory']){
			const file=core.version2StateFile(base()),dir=path.dirname(file),retained=dir+'.retained',external=dir+'.external';
			mkdirSync(dir,{mode:0o700});mkdirSync(external,{mode:0o700});writeFileSync(path.join(external,'sentinel'),'untouched',{mode:0o600});writeFileSync(file+'.lock','foreign-lock',{mode:0o600});
			let mutated=false;const pending=core.transaction(file,limits,()=>{mutated=true;});
			renameSync(dir,retained);if(variant==='symlink')symlinkSync(external,dir);else mkdirSync(dir,{mode:0o700});
			const result=await pending;assert.equal(result.status,'unavailable');assert.equal(result.reason,'unsafe_path');assert.equal(mutated,false);
			assert.equal(readFileSync(path.join(retained,path.basename(file)+'.lock'),'utf8'),'foreign-lock');assert.deepEqual(readdirSync(external),['sentinel']);assert.equal(readFileSync(path.join(external,'sentinel'),'utf8'),'untouched');assert.equal(existsSync(file),false);assert.equal(existsSync(file+'.lock'),false);
			rmSync(retained,{recursive:true});
		}
	});
	await check('generated hook refuses lock-wait ancestor redirection without external writes',async()=>{
		env();responder=()=>system();const file=stateFile(),dir=path.dirname(file),retained=dir+'.retained',external=dir+'.external';
		mkdirSync(dir,{recursive:true,mode:0o700});mkdirSync(external,{mode:0o700});writeFileSync(path.join(external,'sentinel'),'untouched',{mode:0o600});writeFileSync(file+'.lock','foreign-lock',{mode:0o600});
		const pending=hook(preModule)(call('ancestor-swap'),context());renameSync(dir,retained);symlinkSync(external,dir);await pending;
		assert.deepEqual(readdirSync(external),['sentinel']);assert.equal(readFileSync(path.join(external,'sentinel'),'utf8'),'untouched');assert.equal(readFileSync(path.join(retained,path.basename(file)+'.lock'),'utf8'),'foreign-lock');assert.equal(existsSync(file),false);assert.equal(existsSync(file+'.lock'),false);
		rmSync(retained,{recursive:true});
	});
	await check('publication and release refuse directory replacement inside the synchronous callback',async()=>{
		const file=core.version2StateFile(base()),dir=path.dirname(file),retained=dir+'.retained',external=dir+'.external';mkdirSync(dir,{mode:0o700});mkdirSync(external,{mode:0o700});writeFileSync(path.join(external,'sentinel'),'untouched',{mode:0o600});
		const result=await core.transaction(file,limits,()=>{renameSync(dir,retained);symlinkSync(external,dir);});assert.equal(result.status,'unavailable');assert.deepEqual(readdirSync(external),['sentinel']);assert.equal(readFileSync(path.join(external,'sentinel'),'utf8'),'untouched');assert.equal(existsSync(file),false);assert.equal(existsSync(file+'.lock'),false);assert.equal(existsSync(path.join(retained,path.basename(file)+'.lock')),true);
		rmSync(retained,{recursive:true});
	});
	await check('whole-call malformed task input journals once without invalid task indices',async()=>{
		for(const input of [{},{tasks:null},{tasks:'PRIVATE-UNSUPPORTED-INPUT'}]){
			env({JEV_ADVISOR_PROVIDER:'off'});responder=undefined;const before=fetchCalls;await hook(preModule)(call('unsupported',input),context());const rows=journalRecords();assert.equal(rows.length,1);assert.equal(rows[0].operation,'task_advice');assert.deepEqual(rows[0].taskAdvice,[]);assert.deepEqual(rows[0].advice,{status:'no_decision',reason:'unsupported_input'});assert.equal(JSON.stringify(rows).includes('PRIVATE-UNSUPPORTED-INPUT'),false);assert.equal(fetchCalls,before);
		}
	});
	await check("corrupt/version/oversize/symlink/nonregular stores never reset", async () => {
		for (const variant of ["corrupt", "version", "oversize", "symlink", "directory"]) {
			const file = core.version2StateFile(base()); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
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
		const file = core.version2StateFile(base()); mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 }); writeFileSync(`${file}.lock`, "foreign-owner", { mode: 0o600 });
		const started = performance.now(); const locked = await core.transaction(file, limits, () => {}); assert.equal(locked.reason, "locked"); assert.ok(performance.now() - started < 500);
		assert.equal(readFileSync(`${file}.lock`, "utf8"), "foreign-owner"); rmSync(`${file}.lock`);
		assert.equal((await core.transaction(file, limits, () => { throw new Error("fixture"); })).status, "unavailable"); assert.ok(!existsSync(`${file}.lock`));
		const invalid = path.join(root, "not-a-directory"); writeFileSync(invalid, "file"); assert.equal((await core.transaction(path.join(invalid, "state.v2.json"), limits, () => {})).status, "unavailable");
	});
	await check('Jev refuses ancestor symlinks unsafe directories and hardlinked state without adoption',async()=>{
		const external=path.join(root,`external-${++serial}`),alias=path.join(root,`alias-${++serial}`);mkdirSync(external,{mode:0o700});writeFileSync(path.join(external,'sentinel'),'external-owned-sentinel',{mode:0o600});symlinkSync(external,alias);
		const throughAlias=path.join(alias,'state.v2.json');assert.equal((await core.transaction(throughAlias,limits,()=>{})).reason,'unsafe_path');assert.equal(core.readEvidenceV2(throughAlias).status,'unavailable');assert.equal(existsSync(path.join(external,'state.v2.json')),false);assert.equal(readFileSync(path.join(external,'sentinel'),'utf8'),'external-owned-sentinel');
		const unsafe=core.version2StateFile(base());mkdirSync(path.dirname(unsafe),{recursive:true,mode:0o755});assert.equal((await core.transaction(unsafe,limits,()=>{})).reason,'unsafe_path');assert.equal(statSync(path.dirname(unsafe)).mode&0o777,0o755);assert.equal(existsSync(unsafe),false);
		const file=core.version2StateFile(base());assert.equal((await core.transaction(file,limits,()=>{})).status,'ok');const original=readFileSync(file);linkSync(file,`${file}.alias`);
		assert.equal(core.readEvidenceV2(file).status,'unavailable');assert.equal((await core.transaction(file,limits,()=>{})).reason,'unsafe_path');assert.deepEqual(readFileSync(file),original);assert.equal(statSync(file).nlink,2);
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
	await check("actualTier is host-only, conflict-flagged, and byEffectiveModel is bounded", async () => {
		const file = core.version2StateFile(base()); const t = task();
		const p = await core.prepareTaskRecords(file, limits, "s", "call", [t], 1);
		await core.updateTaskAdvice(file, limits, { sessionId: "s", toolCallId: "call", taskIndex: 0 }, p.value[0].token, advice("strong"), 2);
		await core.observeTaskLaunch(file, limits, "s", "call", true, 0, { sessionId: "s", jobId: "a" }, 3);
		await core.observeTerminalJob(file, limits, { sessionId: "s", jobId: "a" }, { status: "completed", durationMs: 12000, effectiveModel: "model-x", actualTier: "strong" }, 4);
		let { json, text } = core.calibrationSummary(core.readEvidenceV2(file).value);
		assert.deepEqual(json.terminalJobs.actualTier, { known: 1, unknown: 0, byTier: { fast: 0, balanced: 0, strong: 1 } });
		assert.equal(json.terminalJobs.exactJoin, 1); assert.equal(json.terminalJobs.batchMapped, 0);
		assert.deepEqual(json.terminalJobs.byEffectiveModel["model-x"], { jobs: 1, byStatus: { completed: 1, failed: 0, cancelled: 0 }, durationMs: { sum: 12000, measured: 1, average: 12000 } });
		assert.ok(text.includes("actual tier known/unknown 1/0"));
		await core.observeTerminalJob(file, limits, { sessionId: "s", jobId: "a" }, { status: "completed", actualTier: "balanced" }, 5);
		({ json } = core.calibrationSummary(core.readEvidenceV2(file).value));
		assert.deepEqual(json.terminalJobs.actualTier, { known: 0, unknown: 1, byTier: { fast: 0, balanced: 0, strong: 0 } });
		assert.ok(core.readEvidenceV2(file).value.jobs[JSON.stringify(["s", "a"])].conflicts.includes("actual_tier_conflict"));
		await core.observeTerminalJob(file, limits, { sessionId: "s", jobId: "b" }, { status: "completed", effectiveModel: "model-y" }, 6);
		({ json } = core.calibrationSummary(core.readEvidenceV2(file).value));
		assert.equal(core.readEvidenceV2(file).value.jobs[JSON.stringify(["s", "b"])].actualTier, null);
		assert.equal(json.terminalJobs.actualTier.unknown, 2);
		assert.equal(json.terminalJobs.byEffectiveModel["model-y"].jobs, 1);
	});
	// --- widget-lifecycle checks (V1-V8) ---
	core.widgetLifecycleResetForTests();
	const recording = () => {
		const calls: { op: string; arg: unknown }[] = [];
		return {
			calls,
			ctx: (session = "session-a") => ({ sessionManager: { getSessionId: () => session }, ui: {
				notify: (s: string) => calls.push({ op: "notify", arg: s }),
				setWidget: (_k: unknown, s: unknown) => calls.push({ op: "setWidget", arg: s }),
				setStatus: (_k: unknown, s: unknown) => calls.push({ op: "setStatus", arg: s }),
			} }),
			notifies: () => calls.filter(c => c.op === "notify").map(c => String(c.arg)),
			clears: () => calls.filter(c => c.op === "setWidget" && c.arg === undefined),
			widgets: () => calls.filter(c => c.op === "setWidget" && c.arg !== undefined).map(c => Array.isArray(c.arg) ? c.arg.join("\n") : String(c.arg)),
		};
	};
	const tasksN = (n: number) => batch(Array.from({ length: n }, (_, i) => `child ${i}`));
	const syncReceipt = (id: string, input: unknown) => ({ type: "tool_result", toolName: "task", toolCallId: id, input, details: {}, isError: false });
	const snapshotEntries = (specs: [string, string, string?][]) => specs.map(([jobId, status, allocatedId]) => {
		const id = allocatedId ?? `allocated-${jobId}`;
		return { jobId, id, label: id, status };
	});
	const snapshotFor = (specs: [string, string, string?][], extra: any = {}) => ({ type: "tool_result", toolName: "subagent", toolCallId: "snap", details: { subagents: snapshotEntries(specs) }, isError: false, ...extra });
	await check("V1 matching-receipt classification is total: sync/async/terminal/isError/blocked/non-matching", async () => {
		// 1. sync receipt (no async envelope) -> CLEAR
		core.widgetLifecycleResetForTests();
		let rec = recording(); responder = () => system();
		const pre = hook(preModule); const res = hook(resultModule);
		await pre(call("sync", tasksN(2)), rec.ctx());
		await res(syncReceipt("sync", tasksN(2)), rec.ctx());
		assert.equal(rec.clears().length, 1, "sync receipt (no async envelope) clears");
		// 2. matching isError receipt -> CLEAR
		core.widgetLifecycleResetForTests();
		rec = recording();
		await pre(call("err", tasksN(2)), rec.ctx());
		await res({ type: "tool_result", toolName: "task", toolCallId: "err", input: tasksN(2), details: {}, isError: true }, rec.ctx());
		assert.equal(rec.clears().length, 1, "matching isError receipt clears");
		// 3. non-matching toolCallId never clears
		core.widgetLifecycleResetForTests();
		rec = recording();
		await pre(call("mine", tasksN(2)), rec.ctx());
		await res(syncReceipt("other", tasksN(2)), rec.ctx());
		assert.equal(rec.clears().length, 0, "non-matching toolCallId never clears");
		// 4. blocked matching receipt -> CLEAR (defensive)
		core.widgetLifecycleResetForTests();
		rec = recording();
		await pre(call("blk", tasksN(2)), rec.ctx());
		await res({ type: "tool_result", toolName: "task", toolCallId: "blk", input: tasksN(2), details: { blocked: true, results: [{ index: 0, status: "failed" }] }, isError: false }, rec.ctx());
		assert.equal(rec.clears().length, 1, "blocked matching receipt clears (defensive)");
		// 5. async in-flight -> awaitingAsync + primaryJobId, no clear
		core.widgetLifecycleResetForTests();
		rec = recording();
		await pre(call("flight", tasksN(2)), rec.ctx());
		await res(launch("flight", tasksN(2), "f-j0"), rec.ctx());
		assert.equal(rec.clears().length, 0, "in-flight async envelope does not clear");
		const flightEntry = core.widgetSessionEntry("session-a");
		assert.ok(flightEntry && flightEntry.awaitingAsync === true && flightEntry.primaryJobId === "f-j0", "awaitingAsync + primaryJobId recorded");
		// 6. async state completed -> CLEAR
		core.widgetLifecycleResetForTests();
		rec = recording();
		await pre(call("done", tasksN(2)), rec.ctx());
		await res(launch("done", tasksN(2), "d-j0", { async: { state: "completed", type: "task", jobId: "d-j0" } }), rec.ctx());
		assert.equal(rec.clears().length, 1, "terminal async state clears");
		// 6b. async state failed -> CLEAR
		core.widgetLifecycleResetForTests();
		rec = recording();
		await pre(call("afail", tasksN(2)), rec.ctx());
		await res(launch("afail", tasksN(2), "af-j0", { async: { state: "failed", type: "task", jobId: "af-j0" } }), rec.ctx());
		assert.equal(rec.clears().length, 1, "failed async state clears");
		// 6c. async envelope without a usable jobId -> CLEAR (no usable envelope)
		core.widgetLifecycleResetForTests();
		rec = recording();
		await pre(call("nojob", tasksN(2)), rec.ctx());
		await res(launch("nojob", tasksN(2), "unused-job", { async: { state: "running", type: "task" } }), rec.ctx());
		assert.equal(rec.clears().length, 1, "unusable async jobId clears as no usable envelope");
		// 6d. aborted ctx overrides an in-flight async envelope -> CLEAR
		core.widgetLifecycleResetForTests();
		rec = recording();
		await pre(call("aborted", tasksN(2)), rec.ctx());
		await res(launch("aborted", tasksN(2), "ab-j0"), { ...rec.ctx(), signal: { aborted: true } });
		assert.equal(rec.clears().length, 1, "aborted ctx clears even with an async envelope");
		// 7. async state unrecognized -> IN FLIGHT, no clear
		core.widgetLifecycleResetForTests();
		rec = recording();
		await pre(call("weird", tasksN(2)), rec.ctx());
		await res(launch("weird", tasksN(2), "w-j0", { async: { state: "warp-speed", type: "task", jobId: "w-j0" } }), rec.ctx());
		assert.equal(rec.clears().length, 0, "unrecognized async state does not clear");
	});
	await check("V2 production-shaped async sequence: running then completed, clear only after terminal observed", async () => {
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const rec = recording();
		await hook(preModule)(call("v2", tasksN(2)), rec.ctx("session-a"));
		responder = undefined;
		const res = hook(resultModule);
		const before = rec.clears().length;
		// Launch: details.async.jobId = the first child's job id
		assert.equal(await res(launch("v2", tasksN(2), "j0"), rec.ctx("session-a")), undefined);
		assert.equal(rec.clears().length, before, "launch must not clear");
		// Partial/mixed snapshot: [j0 running, j1 completed] -> no clear
		await res(snapshotFor([["j0", "running"], ["j1", "completed"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, before, "mixed snapshot must not clear");
		// Closing snapshot: [j0 completed, j1 completed] -> clear fires exactly once
		await res(snapshotFor([["j0", "completed"], ["j1", "completed"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, before + 1, "closing snapshot clears exactly once");
		// Repeat snapshot after clear: no additional clear (entry dropped)
		await res(snapshotFor([["j0", "completed"], ["j1", "completed"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, before + 1, "no duplicate clear");
	});
	await check("V3 unresolved ever-non-terminal child blocks despite threshold", async () => {
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const rec = recording();
		await hook(preModule)(call("v3", tasksN(2)), rec.ctx("session-a"));
		responder = undefined;
		const res = hook(resultModule);
		await res(launch("v3", tasksN(2), "j0"), rec.ctx("session-a"));
		const before = rec.clears().length;
		// Pre-seed foreign terminals so the terminal-count threshold is met
		await res(snapshotFor([["foreign-1", "completed"], ["foreign-2", "completed"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, before, "padding terminals cannot clear while a real child is unresolved");
		// Threshold (2) is met, but j0/j1 were ever-non-terminal and remain unresolved -> no clear
		await res(snapshotFor([["j0", "completed"], ["j1", "running"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, before, "unresolved ever-non-terminal child blocks clear");
		// Once it is observed terminal -> clear
		await res(snapshotFor([["j0", "completed"], ["j1", "completed"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, before + 1, "clear fires once resolved");
	});
	await check("V4 unknown listed status blocks the clear", async () => {
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const rec = recording();
		await hook(preModule)(call("v4", tasksN(3)), rec.ctx("session-a"));
		responder = undefined;
		const res = hook(resultModule);
		await res(launch("v4", tasksN(3), "j0"), rec.ctx("session-a"));
		const before = rec.clears().length;
		// threshold met (3 foreign terminals), but a listed not_found entry blocks
		await res(snapshotFor([["f1", "completed"], ["f2", "completed"], ["f3", "completed"], ["j0", "completed"], ["j1", "completed"], ["j2", "not_found"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, before, "unknown listed status blocks the clear");
		// not_found entries contribute nothing to the terminal count
		const batchEntry = core.widgetSessionEntry("session-a");
		assert.ok(batchEntry && batchEntry.jobs["j2"] && batchEntry.jobs["j2"].status === "unknown", "unknown recorded, not terminal");
		// once the unknown resolves -> clear
		await res(snapshotFor([["j0", "completed"], ["j1", "completed"], ["j2", "cancelled"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, before + 1, "clear fires once unknown resolves");
	});
	await check("V4b per-row removal: each terminal child row disappears, last row clears", async () => {
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const rec = recording();
		const input = tasksN(2);
		await hook(preModule)(call("v4b", input), rec.ctx("session-a"));
		responder = undefined;
		const res = hook(resultModule);
		const progress = [{ index: 0, id: "input-0" }, { index: 1, id: "input-1" }];
		await res(launch("v4b", input, "1-input-0", { progress }), rec.ctx("session-a"));
		assert.equal(rec.widgets().length, 1, "pre-hook drew the batch widget");
		assert.ok(rec.widgets()[0].includes("task 0") && rec.widgets()[0].includes("task 1"), "initial widget carries every per-task row");
		assert.equal(core.widgetSessionEntry("session-a")?.counterBase, 1, "primary job id anchors the batch counter");
		// Structured allocated ids match the task ids drawn by the pre-hook.
		await res(snapshotFor([["1-input-0", "running", "1-input-0"], ["2-input-1", "completed", "2-input-1"]]), rec.ctx("session-a"));
		const widgets = rec.widgets();
		assert.equal(widgets.length, 2, "one redraw after a terminal child");
		assert.ok(widgets[1].includes("task 0"), "in-progress row remains");
		assert.ok(!widgets[1].includes("task 1"), "terminal child row removed");
		assert.equal(rec.clears().length, 0, "one remaining row does not clear");
		const entry = core.widgetSessionEntry("session-a");
		assert.ok(entry && entry.rows.length === 1 && entry.rows[0].index === 0, "only the in-progress row is tracked");
		await res(snapshotFor([["1-input-0", "completed", "1-input-0"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, 1, "last-row removal clears the widget");
		assert.equal(core.widgetSessionEntry("session-a"), null, "last-row clear drops the lifecycle entry");
	});
	await check("V4e batch counter anchor rejects an old-batch job with the same task id", async () => {
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const rec = recording();
		const input = tasksN(2);
		await hook(preModule)(call("v4e", input), rec.ctx("session-a"));
		responder = undefined;
		const res = hook(resultModule);
		await res(launch("v4e", input, "5-input-0"), rec.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.counterBase, 5, "counter base derived from primary index 0");
		const before = rec.widgets().length;
		// Counter 4 belongs to an earlier allocation batch; expected counter for index 1 is 6.
		await res(snapshotFor([["4-input-1", "completed", "4-input-1"]]), rec.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.rows.length, 2, "old-batch job keeps the row");
		assert.equal(rec.widgets().length, before, "old-batch job does not redraw");
		assert.equal(core.widgetSessionEntry("session-a")?.jobRows["4-input-1"], undefined, "old-batch job is not bound");
		// The current batch's index 1 job has counter 6 and removes its row.
		await res(snapshotFor([["6-input-1", "completed", "6-input-1"]]), rec.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.rows.length, 1, "current-batch job removes its row");
		assert.ok(rec.widgets().at(-1)?.includes("task 0") && !rec.widgets().at(-1)?.includes("task 1"), "redraw keeps only the in-progress row");
	});
	await check("V4c last-row clear fires even when the closure predicate is still false", async () => {
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const rec = recording();
		const input = { agent: "executor", tasks: [
			{ id: "input-0", assignment: "child 0", tier: "balanced" },
			{ id: "input-1", assignment: 42, tier: "balanced" },
		] };
		await hook(preModule)(call("v4c", input), rec.ctx("session-a"));
		responder = undefined;
		const res = hook(resultModule);
		await res(launch("v4c", input, "v4c-j0"), rec.ctx("session-a"));
		const entry = core.widgetSessionEntry("session-a");
		assert.ok(entry && entry.rows.length === 1 && entry.taskCount === 2, "one valid row plus one rejected entry in the raw count");
		await res(snapshotFor([["v4c-j0", "completed", "1-input-0"]]), rec.ctx("session-a"));
		assert.equal(rec.clears().length, 1, "exhausted rows clear without closure");
		assert.equal(core.widgetSessionEntry("session-a"), null, "entry cleaned after last-row clear");
	});
	await check("V4d retention boundary: unmapped, unknown, duplicate-label, and contradictory observations never remove rows", async () => {
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const rec = recording();
		const input = tasksN(2);
		await hook(preModule)(call("v4d", input), rec.ctx("session-a"));
		responder = undefined;
		const res = hook(resultModule);
		await res(launch("v4d", input, "v4d-j0"), rec.ctx("session-a"));
		const before = rec.widgets().length;
		// Foreign/unmapped terminal job: no row label match, so retention.
		await res(snapshotFor([["foreign-job", "completed", "foreign-alloc"]]), rec.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.rows.length, 2, "unmapped terminal job keeps rows");
		assert.equal(rec.widgets().length, before, "unmapped terminal job does not redraw");
		// Duplicate task id: two rows share the label, so the match is ambiguous.
		const duplicate = { agent: "executor", tasks: [
			{ id: "dup-0", assignment: "first duplicate", tier: "balanced" },
			{ id: "dup-0", assignment: "second duplicate", tier: "balanced" },
		] };
		responder = () => system();
		await hook(preModule)(call("v4d-dup", duplicate), rec.ctx("session-a"));
		responder = undefined;
		await res(launch("v4d-dup", duplicate, "dup-j0"), rec.ctx("session-a"));
		const duplicateWidgets = rec.widgets().length;
		await res(snapshotFor([["dup-j0", "completed", "1-dup-0"]]), rec.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.rows.length, 2, "duplicate label retains both rows");
		assert.equal(rec.widgets().length, duplicateWidgets, "ambiguous match does not redraw");
		// Contradictory structured signals for one job pin it out of removal.
		const contradiction = tasksN(2);
		responder = () => system();
		await hook(preModule)(call("v4d-c", contradiction), rec.ctx("session-a"));
		responder = undefined;
		await res(launch("v4d-c", contradiction, "c-j0"), rec.ctx("session-a"));
		await res(snapshotFor([["c-j0", "running", "1-input-0"]]), rec.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.jobRows["c-j0"], 0, "first structured match binds the row");
		await res(snapshotFor([["c-j0", "completed", "2-input-1"]]), rec.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.jobRows["c-j0"], null, "contradictory match is pinned");
		assert.equal(core.widgetSessionEntry("session-a")?.rows.length, 2, "contradiction retains both rows");
		assert.equal(rec.clears().length, 0, "retention boundary never clears");
	});
	await check("V4f pre-launch snapshot cannot remove a row before async ownership", async () => {
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const rec = recording();
		const input = tasksN(3);
		await hook(preModule)(call("v4f", input), rec.ctx("session-a"));
		responder = undefined;
		const res = hook(resultModule);
		const before = rec.widgets().length;
		await res(snapshotFor([["stranger", "completed", "1-input-0"]]), rec.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.rows.length, 3, "pre-launch snapshot removes nothing");
		assert.equal(rec.widgets().length, before, "pre-launch snapshot does not redraw");
		assert.equal(core.widgetSessionEntry("session-a")?.awaitingAsync, false, "batch is not async-owned yet");
		await res(launch("v4f", input, "1-input-0"), rec.ctx("session-a"));
		await res(snapshotFor([["1-input-0", "completed", "1-input-0"]]), rec.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.rows.length, 2, "owned terminal child removes its row");
	});
	await check("V5 memory off / provider off still clear (zero store writes)", async () => {
		responder = () => system();
		for (const variant of [{ JEV_ADVISOR_MEMORY: "off" }, { JEV_ADVISOR_PROVIDER: "off" }]) {
			core.widgetLifecycleResetForTests();
			env({ ...variant, JEV_ADVISOR_STATE: core.version2StateFile(base()) });
			const res = hook(resultModule); const rec = recording();
			const before = existsSync(stateFile());
			await hook(preModule)(call("v5", tasksN(2)), rec.ctx("session-a"));
			const fetchStart = fetchCalls;
			// matching sync receipt (no usable async envelope) -> CLEAR
			await res(syncReceipt("v5", tasksN(2)), rec.ctx("session-a"));
			assert.equal(rec.clears().length, 1, `clear works with ${JSON.stringify(variant)}`);
			assert.equal(existsSync(stateFile()), before, "zero store writes");
			assert.equal(fetchCalls - fetchStart, 0, "zero provider calls in the clear path");
		}
	});
	await check("V6 enforce pre-hook block clears its own widget before blocking", async () => {
		core.widgetLifecycleResetForTests();
		env({ JEV_ADVISOR_MODE: "enforce", JEV_ADVISOR_MIN_CONFIDENCE: "0" }); responder = () => system(decision("strong", 0));
		const rec = recording();
		const out = await hook(preModule)(call("v6", tasksN(2)), rec.ctx("session-a"));
		assert.equal(out?.block, true, "enforce blocks");
		assert.equal(rec.clears().length, 1, "exactly one setWidget('jev-advisor', undefined) after the set");
		assert.ok(core.widgetSessionEntry("session-a") === null, "session entry dropped on block");
	});
	await check("V7 supersede and session isolation", async () => {
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const rec = recording();
		await hook(preModule)(call("old", tasksN(2)), rec.ctx("session-a"));
		const res = hook(resultModule);
		const before = rec.clears().length;
		await res(launch("old", tasksN(2), "old-j0"), rec.ctx("session-a"));
		// A newer batch supersedes the entry for the same session
		await hook(preModule)(call("new", tasksN(2)), rec.ctx("session-a"));
		const supersededEntry = core.widgetSessionEntry("session-a");
		assert.ok(supersededEntry && supersededEntry.toolCallId === "new" && supersededEntry.awaitingAsync === false, "newer batch entry owns the widget");
		// The older batch's launch receipt must not clear the new batch
		await res(launch("old", tasksN(2), "old-j0"), rec.ctx("session-a"));
		assert.equal(rec.clears().length, before, "old receipts never clear the new batch");
		// Session isolation: session B's clear never touches session A's entry
		core.widgetLifecycleResetForTests();
		await hook(preModule)(call("a-batch", tasksN(2)), rec.ctx("session-a"));
		await hook(preModule)(call("b-batch", tasksN(2)), rec.ctx("session-b"));
		await res(syncReceipt("b-batch", tasksN(2)), rec.ctx("session-b"));
		const entryA = core.widgetSessionEntry("session-a");
		assert.ok(entryA && entryA.toolCallId === "a-batch", "session B's clear never touches session A's entry");
		assert.ok(core.widgetSessionEntry("session-b") === null, "session B's own entry is gone");
		// Empty-summary task call takes no ownership: no record, no clear.
		core.widgetLifecycleResetForTests();
		env(); responder = () => system();
		const recEmpty = recording();
		await hook(preModule)(call("own", tasksN(2)), recEmpty.ctx("session-a"));
		const beforeEmpty = recEmpty.clears().length;
		await hook(preModule)(call("empty", batch([])), recEmpty.ctx("session-a"));
		assert.equal(core.widgetSessionEntry("session-a")?.toolCallId, "own", "empty-summary call does not steal ownership");
		assert.equal(recEmpty.clears().length, beforeEmpty, "empty-summary call does not clear");
		// An empty-only session records nothing at all.
		core.widgetLifecycleResetForTests();
		const recEmptyOnly = recording();
		await hook(preModule)(call("empty-only", batch([])), recEmptyOnly.ctx("session-b"));
		assert.equal(core.widgetSessionEntry("session-b"), null, "empty-summary call alone records nothing");
	});
	await check("V8 notify policy: single-line bounded payloads, shadow silent", async () => {
		// hint: single bounded line, no newline
		core.widgetLifecycleResetForTests();
		env({ JEV_ADVISOR_MODE: "hint" }); responder = () => system();
		const rec = recording();
		await hook(preModule)(call("v8", tasksN(2)), rec.ctx("session-a"));
		const hintNotifies = rec.notifies();
		assert.ok(hintNotifies.length >= 1, "hint notifies");
		for (const n of hintNotifies) {
			assert.ok(!n.includes("\n"), "hint payload contains no newline");
			assert.ok(n.length <= 200, "hint payload is <=200 chars");
		}
		// enforce non-blocking path: notification still fires, single bounded line
		core.widgetLifecycleResetForTests();
		env({ JEV_ADVISOR_MODE: "enforce", JEV_ADVISOR_MIN_CONFIDENCE: "0.95" }); responder = () => system(decision("strong", 0.9));
		const recE = recording();
		const out = await hook(preModule)(call("v8e", tasksN(2)), recE.ctx("session-a"));
		assert.equal(out?.block, undefined, "low-confidence advice does not block");
		const enforceNotifies = recE.notifies();
		assert.ok(enforceNotifies.length >= 1, "enforce notifies");
		for (const n of enforceNotifies) {
			assert.ok(!n.includes("\n"), "enforce payload contains no newline");
			assert.ok(n.length <= 200, "enforce payload is <=200 chars");
		}
		// shadow notifies nothing
		core.widgetLifecycleResetForTests();
		env({ JEV_ADVISOR_MODE: "shadow" }); responder = () => system();
		const recS = recording();
		await hook(preModule)(call("v8s", tasksN(2)), recS.ctx("session-a"));
		assert.deepEqual(recS.notifies(), [], "shadow notifies nothing");
	});
	await check("widget-lifecycle pure helpers: fold no-regression, unknown, clamp, version guard", () => {
		core.widgetLifecycleResetForTests();
		core.widgetRecordBatch("s", "c", 2);
		core.widgetFoldSnapshot("s", [{ jobId: "j1", status: "running" }]);
		assert.equal(core.widgetSessionEntry("s")?.jobs.j1.status, "nonTerminal");
		core.widgetFoldSnapshot("s", [{ jobId: "j1", status: "completed" }]);
		assert.equal(core.widgetSessionEntry("s")?.jobs.j1.status, "terminal");
		core.widgetFoldSnapshot("s", [{ jobId: "j1", status: "running" }, { jobId: "j2", status: "mystery" }]);
		assert.equal(core.widgetSessionEntry("s")?.jobs.j1.status, "terminal", "terminal never regresses");
		assert.equal(core.widgetSessionEntry("s")?.jobs.j2.status, "unknown", "unlisted status records unknown");
		assert.equal(core.widgetSessionEntry("s")?.jobs.j1.everNonTerminal, true, "everNonTerminal flag retained");
		assert.equal(core.widgetShouldClear("s", [{ jobId: "j1", status: "completed" }, { jobId: "j2", status: "completed" }]), false, "unknown status blocks clear");
		// taskCount clamp (32) relates to the 64-id map bound: raw 40 clamps to 32
		core.widgetLifecycleResetForTests();
		core.widgetRecordBatch("s2", "c2", 40);
		assert.equal(core.widgetSessionEntry("s2")?.taskCount, 32);
		core.widgetMarkAwaitingAsync("s2", "c2", "p0");
		core.widgetFoldSnapshot("s2", Array.from({ length: 32 }, (_, i) => ({ jobId: `j${i}`, status: "completed" })));
		assert.equal(core.widgetShouldClear("s2", [{ jobId: "p0", status: "completed" }]), false, "32 foreign terminals cannot substitute for the primary job");
		// unbounded-jobId listed entries: non-terminal blocks, terminal does not
		core.widgetLifecycleResetForTests();
		core.widgetRecordBatch("s3", "c3", 1);
		core.widgetMarkAwaitingAsync("s3", "c3", "p3");
		core.widgetFoldSnapshot("s3", [{ jobId: "p3", status: "completed" }]);
		assert.equal(core.widgetShouldClear("s3", [{ jobId: "p3", status: "completed" }, { jobId: undefined, status: "running" }]), false, "unbounded-jobId non-terminal entry blocks the clear");
		assert.equal(core.widgetShouldClear("s3", [{ jobId: "p3", status: "completed" }, { jobId: undefined, status: "completed" }]), true, "unbounded-jobId terminal entry does not block");
		// per-row binding: progress fills a missing label, singleton primary maps to index 0
		core.widgetLifecycleResetForTests();
		core.widgetRecordBatch("s4", "c4", 1, [{ index: 0, label: null, text: "task 0: requested=fast; no decision (disabled)" }], []);
		core.widgetMarkAwaitingAsync("s4", "c4", "p4", [{ index: 0, id: "input-0" }]);
		assert.equal(core.widgetSessionEntry("s4")?.rows[0].label, "input-0", "launch progress confirms the task label");
		assert.equal(core.widgetSessionEntry("s4")?.jobRows.p4, 0, "singleton primary maps to the sole row");
		const lastRow = core.widgetFoldSnapshot("s4", [{ jobId: "p4", status: "completed" }]);
		assert.equal(lastRow.removedRows, 1, "terminal singleton removes its row");
		assert.equal(lastRow.remainingText, null, "no rows remain to redraw");
		assert.equal(core.widgetSessionEntry("s4")?.rows.length, 0, "row removed from the batch state");
		// duplicate label in the pure helper: ambiguous match never removes
		core.widgetLifecycleResetForTests();
		core.widgetRecordBatch("s5", "c5", 2, [
			{ index: 0, label: "dup", text: "task 0: duplicate a" },
			{ index: 1, label: "dup", text: "task 1: duplicate b" },
		], []);
		core.widgetMarkAwaitingAsync("s5", "c5", "p5");
		const ambiguous = core.widgetFoldSnapshot("s5", [{ jobId: "j5", status: "completed", id: "1-dup", label: "1-dup" }]);
		assert.equal(ambiguous.removedRows, 0, "duplicate label is not removed");
		assert.equal(core.widgetSessionEntry("s5")?.rows.length, 2, "both duplicate rows retained");
		// malformed slot version reads empty (fail toward keeping)
		const slotKey = Symbol.for("gjc.jev-advisor.widget-lifecycle");
		assert.equal(core.WIDGET_LIFECYCLE_VERSION, 2, "row-aware lifecycle schema version");
		(globalThis as any)[slotKey] = { state: { version: 1, sessions: { old: { toolCallId: "old" } } } };
		assert.equal(core.widgetSessionEntry("old"), null, "version 1 state is not adopted after the schema change");
		(globalThis as any)[slotKey] = { state: { version: 99, sessions: {} } };
		assert.equal(core.widgetSessionEntry("s2"), null, "version mismatch yields empty registry");
		(globalThis as any)[slotKey] = undefined;
		core.widgetLifecycleResetForTests();
	});
	await check("canonical builder exact bytes for all eight surfaces and stale candidate", () => {
		const fixture = path.join(root, "builder");
		for (const dir of ["scripts", "lib", "src", "hooks", "tools"]) mkdirSync(path.join(fixture, dir), { recursive: true });
		mkdirSync(path.join(root, "shared", "lib"), { recursive: true });
		copyFileSync(path.join(plugin, "../shared/lib/results.ts"), path.join(root, "shared/lib/results.ts"));
		copyFileSync(path.join(plugin, "../shared/lib/decision-contract.ts"), path.join(root, "shared/lib/decision-contract.ts"));
		for (const file of ["scripts/build.mjs", "lib/decision.ts", "lib/alignment.ts", "src/hook.adapter.ts", "src/result.adapter.ts", "src/tool.adapter.ts", "src/check.adapter.ts", "src/metrics.adapter.ts", "src/alignment.adapter.ts", "src/alignment-observe.adapter.ts", "src/alignment-shutdown.adapter.ts"]) copyFileSync(path.join(plugin, file), path.join(fixture, file));
		const result = spawnSync(process.execPath, ["--no-env-file", path.join(fixture, "scripts/build.mjs")], { cwd: fixture, env: { HOME: os.homedir(), TMPDIR: process.env.TMPDIR!, LC_ALL: "C" }, encoding: "utf8", timeout: 30000 });
		assert.equal(result.status, 0, result.stderr);
		for (const file of ["hooks/jev-advisor.ts", "hooks/jev-advisor-result.ts", "tools/jev-advise.ts", "tools/jev-check.ts", "tools/plugin-metrics.ts", "hooks/jev-advisor-alignment.ts", "hooks/jev-advisor-alignment-observe.ts", "hooks/jev-advisor-alignment-shutdown.ts"]) {
			const expected = readFileSync(path.join(fixture, file)); const actual = readFileSync(path.join(plugin, file)); assert.deepEqual(actual, expected, file);
			assert.notDeepEqual(Buffer.concat([actual, Buffer.from(" ")]), expected); console.log(`artifact-sync ${file}: exact`);
		}
	});
	await check("manifest surfaces and release version", () => {
		const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8")); assert.equal(manifest.version, "0.0.9");
		assert.deepEqual(manifest.hooks.map((h: any) => [h.event, h.target, h.phase]), [
			["tool_call", "task", "before"],
			["tool_result", "task", "after"],
			["tool_result", "subagent", "after"],
			["tool_call", "*", "before"],
			["tool_result", "*", "after"],
			["session_shutdown", undefined, undefined],
		]);
		assert.equal(new Set(manifest.hooks.map((h: any) => h.name)).size, 6);
		for (const name of ["jev-goal-alignment", "jev-goal-alignment-observe", "jev-goal-alignment-shutdown"]) assert.ok(manifest.hooks.some((h: any) => h.name === name), name);
		const toolNames = manifest.tools.map((t: any) => t.name);
		assert.deepEqual(toolNames.sort(), ["jev_advise", "jev_check", "plugin_metrics"]);
		const checkToolEntry = manifest.tools.find((t: any) => t.name === "jev_check"); assert.equal(checkToolEntry.path, "tools/jev-check.ts");
		const metricsTool = manifest.tools.find((t: any) => t.name === "plugin_metrics"); assert.equal(metricsTool.path, "tools/plugin-metrics.ts");
	});
	const alignmentUser = (id: string, text: string) => ({ type: "user", id, parts: [{ type: "text", text }] });
	const alignmentSurface = (module: any) => {
		const handlers: { event: string; handler: any }[] = [];
		module.default({ on: (event: string, handler: any) => { handlers.push({ event, handler }); } });
		return handlers;
	};
	const alignmentBefore = alignmentSurface(alignmentHookModule);
	const alignmentAfter = alignmentSurface(alignmentObserveModule);
	const alignmentShutdownSurface = alignmentSurface(alignmentShutdownModule);
	const alignmentContext = (entries: unknown) => ({ sessionManager: { getBranch: () => entries }, ui: { notify() {}, setWidget() {}, setStatus() {} } });
	const alignmentHome = (session = "default") => path.join(process.env.HOME!, ".gjc-plugin", "jev-advisor", "alignment", "v1", session);
	const alignmentEvents = () => {
		const directory = alignmentHome();
		const read = (name: string) => { try { return readFileSync(path.join(directory, name), "utf8"); } catch { return ""; } };
		const text = read("events.1.jsonl") + read("events.jsonl");
		return { text, events: text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line)) };
	};
	const alignmentWrite = (id: string, filePath: string) => ({ type: "tool_call", toolName: "write", toolCallId: id, input: { filePath } });
	const alignmentResult = (id: string, filePath: string) => ({ type: "tool_result", toolName: "write", toolCallId: id, input: { filePath }, details: {}, isError: false });
	const withAlignmentMode = async <T>(mode: string | undefined, fn: () => T | Promise<T>): Promise<T> => {
		const previous = process.env.JEV_ALIGNMENT_MODE;
		if (mode === undefined) delete process.env.JEV_ALIGNMENT_MODE;
		else process.env.JEV_ALIGNMENT_MODE = mode;
		try { return await fn(); }
		finally {
			if (previous === undefined) delete process.env.JEV_ALIGNMENT_MODE;
			else process.env.JEV_ALIGNMENT_MODE = previous;
		}
	};

	await check("goal alignment core: user-entry authority, digests only and ordered rules", () => {
		assert.deepEqual(alignmentBefore.map(entry => entry.event), ["tool_call"]);
		assert.deepEqual(alignmentAfter.map(entry => entry.event), ["tool_result"]);
		assert.deepEqual(alignmentShutdownSurface.map(entry => entry.event), ["session_shutdown"]);
		const authority = alignmentCore.collectAuthority([
			alignmentUser("entry-alpha", "Please implement `src/demo.ts` with criterion=artifact_exists:src/demo.ts and do not touch src/other.ts"),
			{ type: "assistant", id: "entry-agent", parts: [{ type: "text", text: "read-only note written by the agent" }] },
			{ type: "tool", id: "entry-tool", parts: [{ type: "text", text: "read-only tool output" }] },
		]);
		assert.equal(authority.latestUserEntryId, "entry-alpha");
		assert.equal(authority.userEntries, 1, "assistant and tool entries are never authority");
		const serialized = JSON.stringify(authority);
		for (const canary of ["Please implement", "read-only note", "read-only tool output"]) assert.ok(!serialized.includes(canary), canary);
		assert.equal(authority.criterion.kind, "artifact_exists");
		assert.equal(authority.criterion.targetDigest, alignmentCore.digestTarget("src/demo.ts"));
		const aligned = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority });
		assert.deepEqual([aligned.ruleId, aligned.verdict, aligned.coverage, aligned.stage2Admissible, aligned.block], ["aligned_write_within_requested_scope", "aligned", "evaluated", true, false]);
		const forbidden = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/other.ts"), authority });
		assert.deepEqual([forbidden.ruleId, forbidden.verdict, forbidden.coverage, forbidden.stage2Admissible, forbidden.block], ["drift_write_forbidden_target", "drift", "evaluated", false, true]);
		const ambiguous = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/unrequested.ts"), authority });
		assert.deepEqual([ambiguous.ruleId, ambiguous.verdict, ambiguous.coverage, ambiguous.stage2Admissible, ambiguous.block], ["uncertain_authority_ambiguous", "uncertain", "coverage_gap", false, false]);
		const read = alignmentCore.evaluateAction({ actionClass: "read", targetDigest: null, authority });
		assert.deepEqual([read.ruleId, read.verdict, read.coverage, read.stage2Admissible, read.block], ["read_allow", "allow", "evaluated", false, false]);
		const bash = alignmentCore.evaluateAction({ actionClass: "bash", targetDigest: null, authority });
		assert.deepEqual([bash.ruleId, bash.verdict, bash.coverage, bash.stage2Admissible, bash.block], ["bash_observe", "allow", "coverage_gap", false, false]);
		const missing = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority: null });
		assert.deepEqual([missing.ruleId, missing.block, missing.stage2Admissible], ["unknown_authority", false, false]);
		assert.equal(alignmentCore.collectAuthority([]), null);
		assert.equal(alignmentCore.collectAuthority(undefined), null);
		// The branch head is not part of the retry identity; the user entry is.
		const grown = alignmentCore.collectAuthority([
			alignmentUser("entry-alpha", "Please implement `src/demo.ts` with criterion=artifact_exists:src/demo.ts and do not touch src/other.ts"),
			{ type: "tool", id: "branch-head-1", parts: [] },
			{ type: "assistant", id: "branch-head-2", parts: [{ type: "text", text: "done" }] },
		]);
		assert.equal(alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority: grown }).retryKey, aligned.retryKey);
		assert.match(aligned.retryKey, /^[a-f0-9]{32}$/);
	});

	await check("goal alignment core: continue never clears read-only, an explicit release does, a hedged one is ambiguous", () => {
		const readOnlyEntry = "This is read-only; do not modify anything.";
		const writeOf = (authority: any) => alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority });
		const readOnly = alignmentCore.collectAuthority([alignmentUser("u-ro", readOnlyEntry)]);
		assert.equal(readOnly.constraints.some((constraint: any) => constraint.kind === "read_only"), true);
		assert.equal(writeOf(readOnly).ruleId, "drift_write_vs_readonly");
		const continued = alignmentCore.collectAuthority([alignmentUser("u-ro", readOnlyEntry), alignmentUser("u-continue", "continue")]);
		assert.equal(continued.changeSemantics, "unknown");
		assert.equal(continued.constraints.some((constraint: any) => constraint.kind === "read_only"), true, "continue keeps read-only active");
		assert.equal(writeOf(continued).block, true, "a later continue never clears read-only");
		const released = alignmentCore.collectAuthority([alignmentUser("u-ro", readOnlyEntry), alignmentUser("u-release", "The read-only restriction is released; you may write.")]);
		assert.equal(released.release, "explicit");
		assert.equal(released.constraints.some((constraint: any) => constraint.kind === "read_only"), false);
		assert.equal(writeOf(released).block, false, "an explicit release unblocks writes");
		const hedged = alignmentCore.collectAuthority([alignmentUser("u-ro", readOnlyEntry), alignmentUser("u-hedge", "You may write if you want?")]);
		assert.equal(hedged.release, "release_ambiguous");
		assert.equal(hedged.constraints.some((constraint: any) => constraint.kind === "read_only"), true, "an unclear release never clears read-only");
		assert.equal(writeOf(hedged).block, true);
		const stopped = alignmentCore.collectAuthority([alignmentUser("u-stop", "stop the current work")]);
		assert.deepEqual([stopped.changeSemantics, writeOf(stopped).ruleId], ["cancel", "drift_write_after_stop"]);
	});

	await check("goal alignment core: typed transition chain, mismatch, baseline and missing criterion", () => {
		const authority = alignmentCore.collectAuthority([alignmentUser("entry-chain", "Create `src/demo.ts` with criterion=artifact_exists:src/demo.ts")]);
		const evaluation = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority });
		const correction = alignmentCore.recordCorrection({ authority, baseline: "false", now: 1000 });
		assert.equal(correction.applied, true);
		assert.equal(correction.state.status, "correction_recorded");
		assert.equal(correction.state.step, 1);
		assert.equal(correction.state.criterionBaseline, "false");
		const same = alignmentCore.recordCorrection({ authority, baseline: "false", now: 1001, previous: correction.state });
		assert.deepEqual([same.applied, same.reason], [false, "same_authority"]);
		const targetMismatch = alignmentCore.admitAlignedAction({ state: correction.state, evaluation, targetDigest: alignmentCore.digestTarget("src/other.ts"), toolCallIdDigest: alignmentCore.digestText("call-1"), now: 1002 });
		assert.deepEqual([targetMismatch.applied, targetMismatch.reason], [false, "target_mismatch"]);
		const notAdmissible = alignmentCore.admitAlignedAction({ state: correction.state, evaluation: alignmentCore.evaluateAction({ actionClass: "read", targetDigest: null, authority }), targetDigest: null, toolCallIdDigest: alignmentCore.digestText("call-1"), now: 1002 });
		assert.deepEqual([notAdmissible.applied, notAdmissible.reason], [false, "not_stage2_admissible"]);
		const missingCall = alignmentCore.admitAlignedAction({ state: correction.state, evaluation, targetDigest: alignmentCore.digestTarget("src/demo.ts"), toolCallIdDigest: null, now: 1002 });
		assert.deepEqual([missingCall.applied, missingCall.reason], [false, "missing_tool_call"]);
		const admitted = alignmentCore.admitAlignedAction({ state: correction.state, evaluation, targetDigest: alignmentCore.digestTarget("src/demo.ts"), toolCallIdDigest: alignmentCore.digestText("call-1"), now: 1003 });
		assert.deepEqual([admitted.applied, admitted.state.status, admitted.state.step], [true, "aligned_admitted", 2]);
		const mismatch = alignmentCore.observeResult({ state: admitted.state, toolCallIdDigest: alignmentCore.digestText("call-2"), observation: "true", now: 1004 });
		assert.deepEqual([mismatch.applied, mismatch.state.status, mismatch.state.step, mismatch.reason], [true, "recovery_unverified", 4, "tool_call_mismatch"]);
		const observedFalse = alignmentCore.observeResult({ state: admitted.state, toolCallIdDigest: alignmentCore.digestText("call-1"), observation: "false", now: 1005 });
		assert.deepEqual([observedFalse.applied, observedFalse.state.status, observedFalse.state.step], [true, "result_observed", 3]);
		const pending = alignmentCore.evaluateCompletion({ state: observedFalse.state, now: 1006 });
		assert.deepEqual([pending.applied, pending.reason, pending.state.status], [false, "criterion_not_true", "result_observed"]);
		const observed = alignmentCore.observeResult({ state: admitted.state, toolCallIdDigest: alignmentCore.digestText("call-1"), observation: "true", now: 1007 });
		const recovered = alignmentCore.evaluateCompletion({ state: observed.state, now: 1008 });
		assert.deepEqual([recovered.applied, recovered.state.status, recovered.state.step], [true, "recovered", 4]);
		assert.equal(recovered.event.kind, "complete");
		const baselineTrue = alignmentCore.evaluateCompletion({ state: { ...observed.state, criterionBaseline: "true" }, now: 1009 });
		assert.deepEqual([baselineTrue.state.status, baselineTrue.reason], ["recovery_unverified", "baseline_true"]);
		const noCriterion = alignmentCore.evaluateCompletion({ state: { ...observed.state, criterion: null }, now: 1010 });
		assert.deepEqual([noCriterion.state.status, noCriterion.reason], ["recovery_unverified", "no_declared_criterion"]);
		const outOfOrder = alignmentCore.evaluateCompletion({ state: correction.state, now: 1011 });
		assert.deepEqual([outOfOrder.applied, outOfOrder.reason], [false, "not_observed_stage"]);
	});

	await check("goal alignment journal: record caps, rotation, retention and idempotent stop", () => {
		const now = Date.UTC(2026, 9, 25, 8, 0, 0);
		const authority = alignmentCore.collectAuthority([alignmentUser("entry-journal", "Create `src/demo.ts` with criterion=artifact_exists:src/demo.ts")]);
		const evaluation = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority });
		const block = alignmentCore.recordBlock({ evaluation, retryCount: 1, now });
		assert.ok(Buffer.byteLength(alignmentCore.serializeEvent(block), "utf8") <= 2048);
		assert.equal(alignmentCore.serializeEvent({ ...block, retryKey: "x".repeat(3000) }), null, "over-cap records are refused");
		const expired = { ...block, at: now - 8 * 24 * 60 * 60 * 1000 };
		const retained = alignmentCore.readJournalTexts([`${JSON.stringify(expired)}\n${JSON.stringify(block)}\n`], now);
		assert.deepEqual([retained.dropped, retained.events.length, retained.retryCounts[evaluation.retryKey]], [1, 1, 1], "7-day retention keeps only the fresh record");
		const lines = Array.from({ length: 200 }, (_, index) => alignmentCore.serializeEvent({ ...block, at: now - 1000 + index }));
		const full = `${lines.join("\n")}\n`;
		const plan = alignmentCore.planJournalAppend(full, [{ ...block, at: now }], now);
		assert.deepEqual([plan.rotate, plan.appended], [true, 1], "the 201st record rotates the active segment");
		const compacted = alignmentCore.compactJournalText(full, now);
		assert.equal(compacted.trimEnd().split("\n").length, 200, "compaction keeps the newest 200 records");
		assert.ok(Buffer.byteLength(compacted, "utf8") <= alignmentCore.ALIGNMENT_LIMITS.maxTotalBytes);
		const correction = alignmentCore.recordCorrection({ authority, baseline: "false", now });
		const shutdown = alignmentCore.recordShutdown({ state: correction.state, counts: { corrections: 1, blocks: 1, recovered: 0, unverified: 0, unresolved: 1 }, now });
		const snapshot = alignmentCore.readJournalTexts([`${alignmentCore.serializeEvent(correction.event)}\n${alignmentCore.serializeEvent(shutdown)}\n`], now);
		assert.equal(snapshot.shutdownFor[correction.state.recoveryId], true, "the stop record is keyed by recovery id");
		assert.equal(snapshot.counts.unresolved, 1);
	});

	await check("goal alignment journal rotation keeps two bounded segments", async () => {
		env();
		const directory = alignmentHome();
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const authority = alignmentCore.collectAuthority([alignmentUser("entry-rotate", "Please improve the feature")]);
		const evaluation = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority });
		const now = Date.now();
		const lines = Array.from({ length: 200 }, (_, index) => alignmentCore.serializeEvent(alignmentCore.recordBlock({ evaluation, retryCount: index + 1, now: now - 500 + index })));
		writeFileSync(path.join(directory, "events.jsonl"), lines.join("\n") + "\n", { mode: 0o600 });
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-rotate", "src/demo.ts"), alignmentContext([alignmentUser("entry-rotate", "Please improve the feature")])), undefined);
		const current = readFileSync(path.join(directory, "events.jsonl"), "utf8").trimEnd().split("\n");
		const rotated = readFileSync(path.join(directory, "events.1.jsonl"), "utf8").trimEnd().split("\n");
		assert.equal(current.length, 1, "the new record starts a fresh active segment");
		assert.equal(JSON.parse(current[0]).kind, "correction");
		assert.ok(rotated.length <= 200, "the retained segment stays within the record cap");
		assert.deepEqual(readdirSync(directory).sort(), ["events.1.jsonl", "events.jsonl"], "rotation keeps two segments");
	});

	await check("goal alignment hooks fail open on a thrown handler", async () => {
		env();
		const before = fetchCalls;
		const entries = [alignmentUser("entry-error", "This is read-only; do not modify anything.")];
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		assert.equal(await alignmentBefore[0].handler({ type: "tool_call", toolName: "write", toolCallId: "call-throw", input: revoked.proxy }, alignmentContext(entries)), undefined, "a throwing input never blocks");
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-branch-throw", "src/demo.ts"), { sessionManager: { getBranch() { throw new Error("no branch"); } } }), undefined, "a throwing branch facade never blocks");
		assert.equal(await alignmentAfter[0].handler(null, alignmentContext(entries)), undefined);
		assert.equal(await alignmentShutdownSurface[0].handler(undefined, alignmentContext(entries)), undefined);
		assert.equal(fetchCalls, before);
		assert.equal(unexpectedFetches, 0);
	});

	await check("AC-A1 alignment shadow: metadata-only journal never blocks", async () => {
		env();
		const before = fetchCalls;
		const ctx = alignmentContext([alignmentUser("entry-shadow", "PRIVATE_REQUEST_CANARY improve the tool")]);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-shadow", "src/unrequested.ts"), ctx), undefined, "an uncertain write is allowed");
		const journal = alignmentEvents();
		assert.deepEqual(journal.events.map((event: any) => event.kind), ["correction"]);
		assert.equal(typeof journal.events[0].at, "number");
		assert.ok(!journal.text.includes("PRIVATE_REQUEST_CANARY"));
		assert.ok(!journal.text.includes("improve the tool"));
		for (const line of journal.text.split("\n").filter(Boolean)) assert.ok(Buffer.byteLength(line, "utf8") <= 2048, "record cap");
		assert.equal(statSync(alignmentHome()).mode & 0o777, 0o700, "journal directory is private");
		assert.equal(statSync(path.join(alignmentHome(), "events.jsonl")).mode & 0o777, 0o600, "journal records are private");
		assert.equal(fetchCalls, before, "no provider call");
		assert.equal(unexpectedFetches, 0);
	});

	await check("AC-A2.1 in-scope write reaches recovered", async () => {
		env();
		const target = path.join(process.env.HOME!, "artifact", "demo.txt");
		const ctx = alignmentContext([alignmentUser("entry-aligned", "Create the artifact `" + target + "` with criterion=artifact_exists:" + target)]);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-aligned", target), ctx), undefined, "an aligned write is allowed");
		let journal = alignmentEvents();
		assert.deepEqual(journal.events.map((event: any) => event.kind), ["correction", "admit"]);
		assert.equal(journal.events[1].state.status, "aligned_admitted");
		assert.equal(journal.events[1].state.toolCallIdDigest, alignmentCore.digestText("call-aligned"));
		assert.equal(journal.events[1].state.criterionBaseline, "false");
		mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(target, "artifact\n", { mode: 0o600 });
		assert.equal(await alignmentAfter[0].handler(alignmentResult("call-aligned", target), ctx), undefined);
		journal = alignmentEvents();
		assert.deepEqual(journal.events.map((event: any) => event.kind), ["correction", "admit", "observe", "complete"]);
		const last = journal.events[journal.events.length - 1].state;
		assert.deepEqual([last.status, last.step, last.criterion.kind], ["recovered", 4, "artifact_exists"]);
	});

	await check("AC-A2.2 default allow is never stage-2", async () => {
		env();
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-no-authority", "src/demo.ts"), alignmentContext([])), undefined);
		assert.equal(existsSync(alignmentHome()), false, "missing authority writes no journal");
		const entries = [alignmentUser("entry-scope", "Please improve the feature")];
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-no-scope", "src/demo.ts"), alignmentContext(entries)), undefined);
		const journal = alignmentEvents();
		assert.deepEqual(journal.events.map((event: any) => event.kind), ["correction"], "no admission without a requested target");
		const evaluation = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority: alignmentCore.collectAuthority(entries) });
		assert.deepEqual([evaluation.verdict, evaluation.stage2Admissible, evaluation.block], ["uncertain", false, false]);
		const defaultCount = alignmentEvents().events.length;
		const sessionContext = { sessionManager: { getSessionId: () => "session-alpha", getBranch: () => entries }, ui: {} };
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-session-alpha", "src/demo.ts"), sessionContext), undefined);
		assert.equal(alignmentEvents().events.length, defaultCount, "another session keeps its own segment");
		assert.equal(existsSync(alignmentHome(alignmentCore.digestText("session-alpha").slice(0, 16))), true, "a session gets its own bounded segment");
	});

	await check("AC-A2.3 read and bash are never stage-2 and bash is a coverage gap", async () => {
		const authority = alignmentCore.collectAuthority([alignmentUser("entry-read", "Please improve the feature")]);
		const read = alignmentCore.evaluateAction({ actionClass: "read", targetDigest: null, authority });
		const bash = alignmentCore.evaluateAction({ actionClass: "bash", targetDigest: null, authority });
		assert.deepEqual([read.ruleId, read.coverage, read.stage2Admissible], ["read_allow", "evaluated", false]);
		assert.deepEqual([bash.ruleId, bash.coverage, bash.stage2Admissible], ["bash_observe", "coverage_gap", false]);
		env();
		const ctx = alignmentContext([alignmentUser("entry-read", "Please improve the feature")]);
		assert.equal(await alignmentBefore[0].handler({ type: "tool_call", toolName: "read", toolCallId: "call-read", input: { filePath: "src/demo.ts" } }, ctx), undefined);
		assert.equal(await alignmentBefore[0].handler({ type: "tool_call", toolName: "bash", toolCallId: "call-bash", input: { command: "ls" } }, ctx), undefined);
		assert.equal(existsSync(alignmentHome()), false, "read and bash never enter the recovery chain");
	});

	await check("AC-A2.4 a criterion that was already true stays recovery_unverified", async () => {
		env();
		const target = path.join(process.env.HOME!, "artifact", "existing.txt");
		mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(target, "already here\n", { mode: 0o600 });
		const ctx = alignmentContext([alignmentUser("entry-baseline", "Update `" + target + "` with criterion=artifact_exists:" + target)]);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-baseline", target), ctx), undefined);
		let journal = alignmentEvents();
		assert.deepEqual(journal.events.map((event: any) => event.kind), ["correction", "admit"]);
		assert.equal(journal.events[0].state.criterionBaseline, "true");
		assert.equal(await alignmentAfter[0].handler(alignmentResult("call-baseline", target), ctx), undefined);
		journal = alignmentEvents();
		assert.deepEqual(journal.events.map((event: any) => event.kind), ["correction", "admit", "observe", "unverified"]);
		const last = journal.events[journal.events.length - 1].state;
		assert.deepEqual([last.status, last.reason], ["recovery_unverified", "baseline_true"]);
	});

	await check("AC-A2.5/AC-A2.6 degraded storage still blocks a write and always allows a read", async () => {
		await withAlignmentMode("deterministic", async () => {
			env();
			const alignmentRoot = path.join(process.env.HOME!, ".gjc-plugin", "jev-advisor");
			mkdirSync(alignmentRoot, { recursive: true, mode: 0o700 });
			writeFileSync(path.join(alignmentRoot, "alignment"), "occupied\n", { mode: 0o600 });
			const before = fetchCalls;
			const ctx = alignmentContext([alignmentUser("entry-degraded", "This is read-only; do not modify anything.")]);
			const output = await alignmentBefore[0].handler(alignmentWrite("call-degraded", "src/demo.ts"), ctx);
			assert.equal(output?.block, true, "the write violation still blocks without a store");
			assert.ok(String(output.reason).includes("drift_write_vs_readonly"));
			assert.ok(String(output.reason).includes("entry-de"), "reason carries the 8-char entry id prefix");
			assert.ok(!String(output.reason).includes("do not modify anything"), "reason carries no raw user text");
			assert.equal(existsSync(alignmentHome()), false, "the blocked store path holds no journal");
			assert.equal(statSync(path.join(alignmentRoot, "alignment")).isFile(), true);
			const repeated = await alignmentBefore[0].handler(alignmentWrite("call-degraded-2", "src/demo.ts"), ctx);
			assert.equal(repeated?.block, true);
			assert.ok(String(repeated.reason).includes("stop_recommended"), "in-process counters keep the retry chain alive");
			assert.equal(await alignmentBefore[0].handler({ type: "tool_call", toolName: "read", toolCallId: "call-degraded-read", input: { filePath: "src/demo.ts" } }, ctx), undefined, "reads are never blocked");
			assert.equal(fetchCalls, before);
		});
	});

	await check("AC-A2.7 read-only allows bash", async () => {
		env();
		const ctx = alignmentContext([alignmentUser("entry-bash-ro", "This is read-only; do not modify anything.")]);
		assert.equal(await alignmentBefore[0].handler({ type: "tool_call", toolName: "bash", toolCallId: "call-bash-ro", input: { command: "bun test" } }, ctx), undefined);
		assert.equal(existsSync(alignmentHome()), false, "bash never writes the alignment journal");
	});

	await check("AC-A2.8 two repeated blocks stop_recommended with zero provider calls; a new entry resets", async () => {
		await withAlignmentMode("deterministic", async () => {
			env();
			const entries = [alignmentUser("entry-retry", "This is read-only; do not modify anything.")];
			const before = fetchCalls;
			const first = await alignmentBefore[0].handler(alignmentWrite("call-retry-1", "src/demo.ts"), alignmentContext(entries));
			assert.equal(first.block, true);
			assert.ok(!String(first.reason).includes("stop_recommended"), "the first block is not a stop recommendation");
			const second = await alignmentBefore[0].handler(alignmentWrite("call-retry-2", "src/demo.ts"), alignmentContext(entries));
			assert.equal(second.block, true);
			assert.ok(String(second.reason).includes("stop_recommended"), "the second repeated block recommends stopping");
			const blocks = alignmentEvents().events.filter((event: any) => event.kind === "block");
			assert.deepEqual(blocks.map((event: any) => event.retryCount), [1, 2]);
			assert.deepEqual(blocks.map((event: any) => event.stopRecommended), [false, true]);
			assert.equal(fetchCalls, before, "alignment never calls a provider");
			const reset = await alignmentBefore[0].handler(alignmentWrite("call-retry-3", "src/demo.ts"), alignmentContext([...entries, alignmentUser("entry-retry-new", "continue")]));
			assert.equal(reset.block, true);
			assert.ok(!String(reset.reason).includes("stop_recommended"), "a new user entry starts a new retry chain");
			const lastBlock = alignmentEvents().events.filter((event: any) => event.kind === "block").pop();
			assert.equal(lastBlock.retryCount, 1);
		});
	});

	await check("alignment mode: unset or unknown resolves to shadow with journal but no block", async () => {
		await withAlignmentMode(undefined, async () => {
			env();
			const ctx = alignmentContext([alignmentUser("entry-shadow-mode", "This is read-only; do not modify anything.")]);
			assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-shadow-mode", "src/demo.ts"), ctx), undefined, "shadow never blocks");
			const journal = alignmentEvents();
			const block = journal.events.find((event: any) => event.kind === "block");
			assert.equal(block.ruleId, "drift_write_vs_readonly", "shadow still journals the would-be block");
			assert.equal(block.retryCount, 1);
			assert.ok(!journal.text.includes("do not modify anything"), "shadow journal carries no raw user text");
		});
		await withAlignmentMode(" BOGUS ", async () => {
			env();
			const ctx = alignmentContext([alignmentUser("entry-shadow-bogus", "This is read-only; do not modify anything.")]);
			assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-shadow-bogus", "src/demo.ts"), ctx), undefined, "an unknown mode falls back to shadow");
			assert.equal(alignmentEvents().events.some((event: any) => event.kind === "block"), true);
		});
	});

	await check("alignment mode off disables evaluation, journal and block", async () => {
		await withAlignmentMode("  OFF ", async () => {
			env();
			const ctx = alignmentContext([alignmentUser("entry-off", "This is read-only; do not modify anything.")]);
			assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-off", "src/demo.ts"), ctx), undefined, "off never blocks");
			assert.equal(existsSync(alignmentHome()), false, "off performs no journal write");
			assert.equal(await alignmentBefore[0].handler({ type: "tool_call", toolName: "read", toolCallId: "call-off-read", input: { filePath: "src/demo.ts" } }, ctx), undefined);
			assert.equal(existsSync(alignmentHome()), false, "off writes nothing for reads either");
		});
	});

	await check("alignment mode deterministic blocks with the reason contract", async () => {
		await withAlignmentMode("Deterministic", async () => {
			env();
			const before = fetchCalls;
			const ctx = alignmentContext([alignmentUser("entry-deterministic", "This is read-only; do not modify anything.")]);
			const output = await alignmentBefore[0].handler(alignmentWrite("call-deterministic", "src/demo.ts"), ctx);
			assert.equal(output?.block, true, "deterministic enforces the drift verdict");
			const reason = String(output.reason);
			assert.ok(reason.includes("drift_write_vs_readonly"), "reason carries the rule id");
			assert.ok(reason.includes("entry-de"), "reason carries the 8-char entry id prefix");
			assert.ok(reason.includes("explicit release"), "reason carries recovery guidance");
			assert.ok(!reason.includes("do not modify anything"), "reason carries no raw user text");
			const block = alignmentEvents().events.find((event: any) => event.kind === "block");
			assert.equal(block.ruleId, "drift_write_vs_readonly");
			assert.equal(block.retryCount, 1);
			assert.equal(fetchCalls, before, "mode resolution never calls a provider");
		});
		assert.equal(process.env.JEV_ALIGNMENT_MODE, undefined, "the mode env var is restored after the case");
	});

	await check("goal alignment toolCallId binding: a different call is ignored, an unbound result is unverified", async () => {
		env();
		const target = path.join(process.env.HOME!, "artifact", "bound.txt");
		const ctx = alignmentContext([alignmentUser("entry-bind", "Create `" + target + "` with criterion=artifact_exists:" + target)]);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-bound", target), ctx), undefined);
		const beforeMismatch = alignmentEvents().events.length;
		assert.equal(await alignmentAfter[0].handler(alignmentResult("call-other", target), ctx), undefined);
		assert.equal(alignmentEvents().events.length, beforeMismatch, "a different call is not this recovery");
		mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(target, "created\n", { mode: 0o600 });
		assert.equal(await alignmentAfter[0].handler({ type: "tool_result", toolName: "write", input: { filePath: target }, details: {}, isError: false }, ctx), undefined);
		const last = alignmentEvents().events.pop().state;
		assert.deepEqual([last.status, last.reason], ["recovery_unverified", "tool_call_mismatch"]);
		const authority = alignmentCore.collectAuthority([alignmentUser("entry-bind", "Create `" + target + "` with criterion=artifact_exists:" + target)]);
		const evaluation = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget(target), authority });
		const correction = alignmentCore.recordCorrection({ authority, baseline: "false", now: 1 });
		const admitted = alignmentCore.admitAlignedAction({ state: correction.state, evaluation, targetDigest: alignmentCore.digestTarget(target), toolCallIdDigest: alignmentCore.digestText("call-bound"), now: 2 });
		const mismatch = alignmentCore.observeResult({ state: admitted.state, toolCallIdDigest: alignmentCore.digestText("call-other"), observation: "true", now: 3 });
		assert.deepEqual([mismatch.applied, mismatch.state.status, mismatch.reason], [true, "recovery_unverified", "tool_call_mismatch"]);
	});

	await check("goal alignment shutdown flushes unresolved counts idempotently", async () => {
		env();
		const target = path.join(process.env.HOME!, "artifact", "shutdown.txt");
		const ctx = alignmentContext([alignmentUser("entry-shutdown", "Create `" + target + "` with criterion=artifact_exists:" + target)]);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-shutdown", target), ctx), undefined);
		assert.equal(await alignmentShutdownSurface[0].handler({ type: "session_shutdown" }, ctx), undefined);
		const first = alignmentEvents().events;
		const shutdowns = first.filter((event: any) => event.kind === "shutdown");
		assert.equal(shutdowns.length, 1);
		assert.equal(shutdowns[0].counts.unresolved, 1);
		assert.equal(await alignmentShutdownSurface[0].handler({ type: "session_shutdown" }, ctx), undefined);
		assert.equal(alignmentEvents().events.length, first.length, "a repeated shutdown appends nothing");
	});

	await check("no unexpected fetch and no owned transaction residue", () => {
		assert.equal(unexpectedFetches, 0);
		const walk = (dir: string) => { for (const item of readdirSync(dir, { withFileTypes: true })) { const file = path.join(dir, item.name); if (item.isDirectory()) walk(file); else assert.ok(!item.name.endsWith(".lock") && !item.name.endsWith(".tmp"), file); } };
		walk(root);
	});
	await check("plugin_metrics tool: invalid_input rejection before any reads, exact envelope, nonmutation", async () => {
		const metricsModule = await import(pathToFileURL(path.join(plugin, "tools/plugin-metrics.ts")).href);
		const sourceMetricsModule = await import(pathToFileURL(path.join(plugin, "src/metrics.adapter.ts")).href);
		const metricsTool = metricsModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
		const sourceMetricsTool = sourceMetricsModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
		const metricsSurfaces = [["generated", metricsTool], ["source", sourceMetricsTool]] as const;
		assert.equal(metricsTool.name, "plugin_metrics");
		const pluginMetricsFetchCalls = fetchCalls;
		const pluginMetricsUnexpectedFetches = unexpectedFetches;
		// home without any data: envelope over missing sources
		env({ JEV_ADVISOR_PROVIDER: "off" });
		const home = process.env.HOME!;
		const result = JSON.parse(text(await metricsTool.execute("m1", {})));
		assert.equal(result.schemaVersion, 1); assert.equal(result.report, "plugin_metrics");
		assert.equal(result.mode, "offline_descriptive"); assert.equal(result.window, "all_retained");
		assert.equal(result.scope, "current_process_home_all_repositories");
		assert.equal(result.status, "unavailable");
		for (const p of ["jev-advisor", "verification-receipts", "ui-regression"]) {
			assert.equal(result.plugins[p].status, "missing"); assert.equal(result.plugins[p].reason, null);
			assert.equal(result.plugins[p].metrics, null); assert.equal(result.plugins[p].snapshot, null);
		}
		assert.equal(result.correlation.status, "missing"); assert.equal(result.correlation.metrics, null);
		assert.equal(result.correlation.window, "retained_v2_metadata");
		assert.ok(result.limitations.slice(0, 18).join(",") === "retained_not_lifetime,unrecorded_invocations_unknown,independent_source_snapshots,wall_clock_not_event_authority,run_observations_not_unique_executions,status_not_reexecution,terminal_sightings_not_unique_jobs,correlation_window_independent,unknown_identity_and_unobserved_terminals,receipt_duration_excludes_storage_assessment_journal,hook_duration_excludes_journal,provider_assessment_latency_unmeasured,end_to_end_and_isolated_overhead_unmeasured,historical_version_unidentified,smoke_real_workload_unidentified,counts_not_coverage,assessment_not_quality,causal_effect_unmeasured");
		assert.deepEqual(result.limitations.slice(18), ["source_missing"]);
		for (const key of ["pluginOverheadMs", "providerLatencyMs", "assessmentLatencyMs", "endToEndInvocationMs", "providerCost", "tokenUsage", "quality", "accuracy", "causalRoi"]) assert.equal(result.unavailableMeasures[key], null);
		// privacy canaries / raw identifier exclusion
		const serialized = JSON.stringify(result);
		for (const canary of ["PRIVATE", "SECRET", "synthetic-key", "sk-", "http"]) assert.ok(!serialized.includes(canary), "privacy canary in report");
		// nonmutation fingerprint: file/dir names, sizes, modes, link counts unchanged
		const fingerprint = async () => { const out: any = {}; for (const p of ["verification-receipts", "jev-advisor", "ui-regression"]) { const dirP = path.join(home, ".gjc-plugin", p); out[p] = { exists: existsSync(dirP) }; if (out[p].exists) { out[p].entries = readdirSync(path.join(dirP, "journal", "v1")).sort(); out[p].mode = statSync(path.join(dirP, "journal", "v1")).mode & 0o7777; } } return out; };
		const fp1 = await fingerprint();
		await metricsTool.execute("m2", {});
		assert.deepEqual(await fingerprint(), fp1, "metrics invocation must not mutate anything");
		// Positive controls prove interception observes real tool reads and fixture writes.
		for (const [surface, tool] of metricsSurfaces) {
			const { value: control, calls } = await withFileIoCounters(() => tool.execute(`m-io-control-${surface}`, {}));
			assert.equal(JSON.parse(text(control)).report, "plugin_metrics");
			assert.ok(calls.reads > 0, `${surface}: valid input reaches instrumented store reads`);
		}
		const ioControlPath = path.join(root, "metrics-io-control.txt");
		const { calls: controlIoCalls } = await withFileIoCounters(async () => {
			fs.writeFileSync(ioControlPath, "LOCAL_IO_CONTROL", { mode: 0o600 });
			assert.equal(await fs.promises.readFile(ioControlPath, "utf8"), "LOCAL_IO_CONTROL");
		});
		rmSync(ioControlPath);
		assert.ok(controlIoCalls.reads > 0 && controlIoCalls.writes > 0, "actual fixture read/write exercises both I/O counters");
		// Every invalid runtime category must fail before any store access.
		const beforeInvalid = await fingerprint();
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		const invalidParams: [string, unknown][] = [
			["null", null], ["undefined", undefined], ["empty array", []], ["nonempty array", [1]],
			["string primitive", "path"], ["number primitive", 1], ["boolean primitive", false],
			["bigint primitive", 1n], ["symbol primitive", Symbol("invalid")], ["function", () => undefined],
			["nonempty object", { path: "/etc/passwd", limit: 10 }], ["empty non-plain object", new Date(0)],
			["null-prototype object", Object.create(null)], ["symbol field", { [Symbol("invalid")]: 1 }],
			["nonenumerable field", Object.defineProperty({}, "hidden", { value: 1 })], ["revoked Proxy", revoked.proxy],
		];
		const fixedInvalidInputText = "plugin_metrics: invalid_input. This tool accepts exactly {} — no user paths, filters or config.";
		const { value: invalidResults, calls: invalidIoCalls } = await withFileIoCounters(async () => {
			const results = [];
			for (const [surface, tool] of metricsSurfaces) {
				for (let index = 0; index < invalidParams.length; index++) {
					results.push({ label: `${surface}: ${invalidParams[index][0]}`, result: await tool.execute(`m-invalid-${surface}-${index}`, invalidParams[index][1]) });
				}
			}
			return results;
		});
		for (const { label, result } of invalidResults) {
			assert.equal(result.isError, true, `${label} must use the native tool error result`);
			assert.equal(text(result), fixedInvalidInputText, `${label} fixed invalid_input text`);
		}
		assert.deepEqual(invalidIoCalls, { reads: 0, writes: 0 }, "invalid inputs must not read or write stores");
		assert.deepEqual(await fingerprint(), beforeInvalid, "invalid input must not mutate stores");
		assert.equal(fetchCalls, pluginMetricsFetchCalls, "invalid plugin_metrics input must not call fetch");
		assert.equal(unexpectedFetches, pluginMetricsUnexpectedFetches, "invalid plugin_metrics input must not attempt network access");
		// envelope over full seeded journals: run/status arithmetic AC6
		const home2 = path.join(root, `home-full-${++serial}`); mkdirSync(home2, { mode: 0o700 }); process.env.HOME = home2;
		for (const [plugin, ops] of [["verification-receipts", [{ operation: "run", durationMs: 100 }, { operation: "status", durationMs: 100 }, { operation: "status", durationMs: 100 }, { operation: "status", durationMs: 100 }]], ["ui-regression", [{ operation: "run", durationMs: 100 }, { operation: "status", durationMs: 100 }, { operation: "status", durationMs: 100 }, { operation: "status", durationMs: 100 }]]] as const) {
			for (const op of ops) { const r = await appendPluginOutcome(plugin, op as any, {}); assert.equal(r.persisted, true, JSON.stringify(r)); }
		}
		const batchRecord: any = { operation: "task_advice", durationMs: 80, taskAdvice: Array.from({ length: 32 }, (_, index) => index === 0 ? { index, status: "decision", tier: "fast", confidence: 0.9, basis: "provider_choice" } : { index, status: "no_decision", reason: "batch_limit" }) };
		await appendPluginOutcome("jev-advisor", batchRecord, {});
		await appendPluginOutcome("jev-advisor", { operation: "subagent_terminal", evidenceObservations: { completed: 2, failed: 0, cancelled: 0, stored: 2, unavailable: 0 } }, {});
		await appendPluginOutcome("jev-advisor", { operation: "advise", advice: { status: "decision", tier: "strong", confidence: 0.9, confidenceKind: "self_reported" } }, {});
		const fullReport = JSON.parse(text(await metricsTool.execute("m4", {})));
		assert.equal(fullReport.status, "partial");
		for (const p of ["verification-receipts", "ui-regression"]) {
			const m = fullReport.plugins[p].metrics;
			assert.deepEqual(m.operations, { run: 1, status: 3 });
			assert.equal(m.run.invocations, 1); assert.equal(m.status.invocations, 3);
			assert.deepEqual(m.run.recordedReceiptDurationMs, { measured: 1, sum: 100, average: 100 });
			assert.equal(m.status.recordedReceiptDurationMs, null, "status never contributes duration");
			assert.equal(m.run.nativeCounts, null, "no count-bearing run sample → nativeCounts null");
			assert.equal(m.run.assertions, null);
			assert.deepEqual(m.run.passedFraction, { numerator: 0, denominator: 0, rate: null });
		}
		const jm = fullReport.plugins["jev-advisor"].metrics;
		assert.deepEqual(jm.operations, { task_advice: 1, subagent_terminal: 1, advise: 1 });
		assert.equal(jm.taskAdvice.batches, 1); assert.equal(jm.taskAdvice.batchesWithEntries, 1); assert.equal(jm.taskAdvice.entries, 32);
		assert.deepEqual(jm.taskAdvice.recordedPreJournalHookDurationMs, { measured: 1, sum: 80, average: 80 });
		assert.equal(jm.taskAdvice.byTier.fast, 1); assert.equal(jm.taskAdvice.byReason.batch_limit, 31);
		assert.equal(jm.manualAdvice.invocations, 1); assert.equal(jm.manualAdvice.present, 1); assert.equal(jm.manualAdvice.byTier.strong, 1);
		assert.deepEqual(jm.evidenceObservations.subagent_terminal, { contributingRecords: 1, completed: 2, failed: 0, cancelled: 0, stored: 2, unavailable: 0 });
		// full envelope over seeded state: measured=0 duration → null sum
		const file2 = await version2StateFileFixture(home2);
		await seedStateWithZeroDuration(file2);
		const withState = JSON.parse(text(await metricsTool.execute("m5", {})));
		assert.equal(withState.correlation.status, "ok", `correlation unavailable: ${withState.correlation.reason}`);
		assert.deepEqual(withState.correlation.metrics.terminalJobs.durationMs, { measured: 0, sum: null, average: null }, "measured=0 → sum/average null in report view");
		assert.deepEqual(withState.correlation.metrics.terminalJobs.actualTier, { known: 0, unknown: 1, byTier: { fast: 0, balanced: 0, strong: 0 } }); assert.equal(withState.correlation.metrics.terminalJobs.quality, null);
		assert.equal(fetchCalls, pluginMetricsFetchCalls, "plugin_metrics invocations must not add fetch calls");
		assert.equal(unexpectedFetches, pluginMetricsUnexpectedFetches, "plugin_metrics invocations must not attempt network access");
		// 2MiB+1 bounded state read: exact cap passes, cap+1 fails oversized before decode
		const bigFile = core.version2StateFile(base());
		mkdirSync(path.dirname(bigFile), { recursive: true, mode: 0o700 });
		const emptyJson = JSON.stringify(core.emptyEvidenceV2());
		const padTo = (total: number) => `${emptyJson.slice(0, -1)},"pad":"${"x".repeat(total - 9 - emptyJson.length)}"}`;
		const oversizeBody = padTo(2097153);
		assert.equal(Buffer.byteLength(oversizeBody), 2097153, "fixture is exactly MAX_STORE_BYTES + 1");
		writeFileSync(bigFile, oversizeBody, { mode: 0o600 });
		assert.equal(core.readEvidenceV2(bigFile).reason, "oversized", "cap+1 → oversized before decode");
		const exactBody = padTo(2097152);
		assert.equal(Buffer.byteLength(exactBody), 2097152, "fixture is exactly MAX_STORE_BYTES");
		writeFileSync(bigFile, exactBody, { mode: 0o600 });
		const exactRead = core.readEvidenceV2(bigFile);
		assert.equal(exactRead.status, "unavailable"); assert.equal(exactRead.reason, "corrupt", "exact cap reads and decodes before canonical validation fails");
		writeFileSync(bigFile, JSON.stringify(core.emptyEvidenceV2()), { mode: 0o600 });
		assert.equal(core.readEvidenceV2(bigFile).status, "ok", "canonical small state passes after cap fixtures");
		// public lock vs transaction-owned lock separation
		writeFileSync(`${bigFile}.lock`, "foreign-owner", { mode: 0o600 });
		assert.equal(core.readEvidenceV2(bigFile).reason, "locked", "public reader rejects foreign lock");
		rmSync(`${bigFile}.lock`);
		const txn = await core.transaction(bigFile, limits, () => {});
		assert.equal(txn.status, "ok", "transaction works under its own lock while no foreign lock exists");
	});

	await check("plugin_metrics counts canonical operations including check without widening run/status buckets", async () => {
		env({ JEV_ADVISOR_PROVIDER: "off" });
		const beforeFetch = fetchCalls, beforeUnexpectedFetches = unexpectedFetches;
		const operations = ["run", "status", "advise", "calibration", "task_advice", "task_launch", "subagent_terminal"] as const;
		const counts = { tests: 3, suites: 1, topLevel: 2, passed: 2, failed: 1, skipped: 0, todo: 0, cancelled: 0 };
		const otherCounts = { tests: 50, suites: 5, topLevel: 40, passed: 49, failed: 1, skipped: 0, todo: 0, cancelled: 0 };
		for (const pluginName of ["verification-receipts", "ui-regression"] as const) {
			for (const operation of operations) {
				const run = operation === "run";
				const outcome = {
					operation,
					durationMs: run ? 100 : Number.MAX_SAFE_INTEGER,
					execution: {
						status: run ? "passed" : "failed", reason: run ? "complete" : "native_failure",
						counts: run ? counts : otherCounts,
						assertions: run
							? [{ step: 0, id: "step-0", kind: "visible", status: "passed" }, { step: 1, id: "step-1", kind: "text_exact", status: "failed" }]
							: [{ step: 0, id: "step-0", kind: "text_substring", status: "failed" }],
					},
				};
				assert.equal((await appendPluginOutcome(pluginName, outcome)).persisted, true, `${pluginName}: ${operation} canonical writer accepts fixture`);
			}
		}
		assert.equal((await appendPluginOutcome("jev-advisor", { operation: "advise" })).persisted, true);
		assert.equal((await appendPluginOutcome("jev-advisor", { operation: "check", check: { status: "decision", verdict: "correct", confidence: 0.7, confidenceKind: "provider_choice" } } as any)).persisted, true);
		await seedStateWithZeroDuration(await version2StateFileFixture(process.env.HOME!));
		for (const surface of ["src/metrics.adapter.ts", "tools/plugin-metrics.ts"]) {
			const module = await import(pathToFileURL(path.join(plugin, surface)).href);
			const tool = module.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
			const native = await tool.execute("m-all-operations", {});
			assert.notEqual(native.isError, true, surface);
			const report = JSON.parse(text(native));
			assert.equal(report.status, "complete", surface);
			for (const pluginName of ["verification-receipts", "ui-regression"] as const) {
				const source = report.plugins[pluginName], m = source.metrics;
				assert.equal(source.status, "ok"); assert.equal(source.reason, null); assert.equal(source.snapshot.records, 7);
				assert.deepEqual(m.operations, Object.fromEntries(operations.map(operation => [operation, 1])));
				assert.equal(m.run.invocations, 1); assert.equal(m.status.invocations, 1);
				assert.deepEqual(m.run.execution, { present: 1, byStatus: { passed: 1 }, byReason: { complete: 1 } });
				assert.deepEqual(m.status.execution, { present: 1, byStatus: { failed: 1 }, byReason: { native_failure: 1 } });
				assert.equal(m.run.executionMissing, 0); assert.equal(m.status.executionMissing, 0);
				assert.deepEqual(m.run.passedFraction, { numerator: 1, denominator: 1, rate: 1 });
				assert.deepEqual(m.status.passedFraction, { numerator: 0, denominator: 1, rate: 0 });
				assert.deepEqual(m.run.recordedReceiptDurationMs, { measured: 1, sum: 100, average: 100 });
				assert.equal(m.status.recordedReceiptDurationMs, null);
				assert.equal(m.status.nativeCounts, null); assert.equal(m.status.assertions, null);
				if (pluginName === "verification-receipts") {
					assert.deepEqual(m.run.nativeCounts, { contributingRecords: 1, totals: counts });
					assert.equal(m.run.assertions, null);
				} else {
					assert.equal(m.run.nativeCounts, null);
					assert.deepEqual(m.run.assertions, { contributingRecords: 1, entries: 2, byKind: { visible: 1, text_exact: 1 }, byStatus: { passed: 1, failed: 1 } });
				}
			}
			const jevMetrics = report.plugins["jev-advisor"].metrics;
			assert.equal(jevMetrics.checkAdvice.invocations, 1, surface);
			assert.deepEqual(jevMetrics.checkAdvice.byVerdict, { correct: 1 }, surface);
			assert.equal(jevMetrics.checkAdvice.confidenceBasis.provider_choice, 1, surface);
			assert.equal(jevMetrics.manualAdvice.invocations, 1, surface);
		}
		assert.equal(fetchCalls, beforeFetch); assert.equal(unexpectedFetches, beforeUnexpectedFetches);
	});

	await check("plugin_metrics correlation rejects nonrepresentable sums, preserves fractions and readable siblings", async () => {
		const beforeFetch = fetchCalls, beforeUnexpectedFetches = unexpectedFetches;
		const fixtures = [
			{ name: "nonfinite", durations: [1e308, 1e308], duration: { sum: Infinity, measured: 2, average: Infinity }, unavailable: true },
			{ name: "unsafe integer", durations: [Number.MAX_SAFE_INTEGER, 1], duration: { sum: Number.MAX_SAFE_INTEGER + 1, measured: 2, average: 4503599627370496 }, unavailable: true },
			{ name: "fractional", durations: [1.25, 2.5], duration: { sum: 3.75, measured: 2, average: 1.875 }, unavailable: false },
			{ name: "safe integer boundary", durations: [Number.MAX_SAFE_INTEGER - 1, 1], duration: { sum: Number.MAX_SAFE_INTEGER, measured: 2, average: 4503599627370495.5 }, unavailable: false },
		] as const;
		for (const fixture of fixtures) {
			env({ JEV_ADVISOR_PROVIDER: "off" });
			for (const pluginName of ["jev-advisor", "verification-receipts", "ui-regression"] as const) {
				assert.equal((await appendPluginOutcome(pluginName, { operation: pluginName === "jev-advisor" ? "task_advice" : "run", durationMs: 80 })).persisted, true);
			}
			const siblings = (await core.buildPluginMetricsReport()).plugins;
			const file = await version2StateFileFixture(process.env.HOME!);
			const durations: Array<number | undefined> = [...fixture.durations];
			if (fixture.name === "fractional") durations.push(undefined);
			for (const [index, durationMs] of durations.entries()) {
				const id = `duration-${index}`, ref = { sessionId: "s", jobId: id };
				const prepared = await core.prepareTaskRecords(file, limits, "s", id, [task()], 1);
				assert.equal(prepared.status, "ok");
				assert.equal((await core.updateTaskAdvice(file, limits, { sessionId: "s", toolCallId: id, taskIndex: 0 }, prepared.value[0].token, advice(index === 2 ? "strong" : "fast"), 2)).status, "ok");
				assert.equal((await core.observeTaskLaunch(file, limits, "s", id, true, 0, ref, 3)).status, "ok");
				assert.equal((await core.observeTerminalJob(file, limits, ref, { status: "completed", durationMs }, 4)).status, "ok");
			}
			const retained = core.readEvidenceV2(file);
			assert.equal(retained.status, "ok", "canonical validator accepts every seeded duration");
			for (const job of Object.values(retained.value.jobs) as any[]) assert.deepEqual(job.conflicts, []);
			const canonical = core.calibrationSummary(retained.value).json;
			assert.equal(canonical.terminalJobs.count, durations.length); assert.equal(canonical.terminalJobs.joined, durations.length);
			assert.equal(canonical.terminalJobs.conflicted, 0);
			assert.deepEqual(canonical.terminalJobs.durationMs, fixture.duration, "calibration arithmetic is unchanged");
			assert.deepEqual(canonical.terminalJobs.byRecommendation.fast.durationMs, fixture.duration);
			const expected = structuredClone(canonical);
			if (fixture.name === "fractional") {
				assert.deepEqual(canonical.terminalJobs.byRecommendation.strong.durationMs, { sum: 0, measured: 0, average: null });
				expected.terminalJobs.byRecommendation.strong.durationMs.sum = null;
			}
			const beforeState = readFileSync(file);
			for (const surface of ["src/metrics.adapter.ts", "tools/plugin-metrics.ts"]) {
				const module = await import(pathToFileURL(path.join(plugin, surface)).href);
				const tool = module.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
				const native = await tool.execute(`m-correlation-${fixture.name}`, {});
				assert.notEqual(native.isError, true, `${surface}: retained numeric boundary is a source-level result`);
				const report = JSON.parse(text(native));
				assert.equal(report.status, fixture.unavailable ? "partial" : "complete");
				assert.equal(report.correlation.status, fixture.unavailable ? "unavailable" : "ok");
				assert.equal(report.correlation.reason, fixture.unavailable ? "corrupt" : null);
				assert.deepEqual(report.correlation.metrics, fixture.unavailable ? null : expected);
				assert.equal(report.limitations.includes("source_unavailable"), fixture.unavailable);
				assert.equal(report.limitations.includes("source_missing"), false);
				for (const pluginName of ["jev-advisor", "verification-receipts", "ui-regression"] as const) {
					assert.equal(report.plugins[pluginName].status, "ok"); assert.equal(report.plugins[pluginName].reason, null);
					assert.deepEqual(report.plugins[pluginName].snapshot, siblings[pluginName].snapshot);
					assert.deepEqual(report.plugins[pluginName].metrics, siblings[pluginName].metrics);
				}
				if (fixture.name === "fractional") {
					const originalIsInteger = Number.isInteger;
					let injected = false;
					try {
						Number.isInteger = (value: unknown) => {
							if (value === 3.75) { injected = true; throw new Error("PRIVATE_CORRELATION_PROJECTION_EXCEPTION"); }
							return originalIsInteger(value);
						};
						const failed = await tool.execute("m-correlation-exception", {});
						assert.equal(injected, true, "unexpected exception occurs in numeric projection");
						assert.deepEqual(failed, { content: [{ type: "text", text: "plugin_metrics: unexpected_error. The report could not be produced." }], isError: true });
					} finally { Number.isInteger = originalIsInteger; }
					const recovered = await tool.execute("m-correlation-recovered", {});
					assert.notEqual(recovered.isError, true); assert.deepEqual(JSON.parse(text(recovered)).correlation.metrics, expected);
				}
			}
			assert.deepEqual(readFileSync(file), beforeState, "report leaves canonical state bytes unchanged");
		}
		assert.equal(fetchCalls, beforeFetch); assert.equal(unexpectedFetches, beforeUnexpectedFetches);
	});

	await check("plugin_metrics source and generated tools return fixed native errors for unexpected report and serialization exceptions", async () => {
		env({ JEV_ADVISOR_PROVIDER: "off" });
		const beforeFetch = fetchCalls;
		const beforeUnexpectedFetches = unexpectedFetches;
		const fixedError = { content: [{ type: "text", text: "plugin_metrics: unexpected_error. The report could not be produced." }], isError: true };
		for (const surface of ["src/metrics.adapter.ts", "tools/plugin-metrics.ts"]) {
			const module = await import(pathToFileURL(path.join(plugin, surface)).href);
			const tool = module.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
			for (const stage of ["report", "serialization"]) {
				const originalISOString = Date.prototype.toISOString;
				const originalStringify = JSON.stringify;
				let injected = false;
				let result;
				try {
					if (stage === "report") Date.prototype.toISOString = function () { injected = true; throw new Error("PRIVATE_REPORT_EXCEPTION"); };
					else JSON.stringify = ((value: any, ...args: any[]) => {
						if (value?.report === "plugin_metrics") { injected = true; throw new Error("PRIVATE_SERIALIZATION_EXCEPTION"); }
						return (originalStringify as any)(value, ...args);
					}) as typeof JSON.stringify;
					result = await tool.execute(`m-exception-${stage}`, {});
				} finally { Date.prototype.toISOString = originalISOString; JSON.stringify = originalStringify; }
				assert.equal(injected, true, `${surface}: ${stage} exception fixture must run`);
				assert.deepEqual(result, fixedError, `${surface}: ${stage} exception is a fixed native error, not a successful report`);
				const recovered = await tool.execute(`m-recovered-${stage}`, {});
				assert.notEqual(recovered.isError, true);
				assert.equal(JSON.parse(text(recovered)).report, "plugin_metrics", "normal JSON report survives exception fixture restoration");
			}
		}
		assert.equal(fetchCalls, beforeFetch);
		assert.equal(unexpectedFetches, beforeUnexpectedFetches);
	});

	await check("metrics corrupt inventory and digest-matching malformed segments stay source-local", async () => {
		const { createHash } = await import("node:crypto");
		const metricsModule = await import(pathToFileURL(path.join(plugin, "tools/plugin-metrics.ts")).href);
		const metricsTool = metricsModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x } } });
		const beforeFetch = fetchCalls;
		const beforeUnexpectedFetches = unexpectedFetches;
		const priorHome = process.env.HOME;
		try {
			for (const variant of ["empty inventory", "malformed JSON", "invalid operation"]) {
				const home = path.join(root, `metrics-corrupt-home-${++serial}`);
				mkdirSync(home, { mode: 0o700 }); process.env.HOME = home;
				const baseDir = path.join(home, ".gjc-plugin");
				for (const pluginName of ["jev-advisor", "verification-receipts", "ui-regression"]) {
					assert.equal((await appendPluginOutcome(pluginName, { operation: pluginName === "jev-advisor" ? "advise" : "run", durationMs: 0 }, { baseDir })).persisted, true);
				}
				await seedStateWithZeroDuration(await version2StateFileFixture(home));
				assert.equal((await core.buildPluginMetricsReport()).status, "complete", "positive control: all four sources are readable");
				const journal = path.join(baseDir, "verification-receipts", "journal", "v1");
				const inventoryPath = path.join(journal, "inventory.json");
				const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
				const segment = inventory.segments[0];
				const segmentPath = path.join(journal, segment.name);
				if (variant === "empty inventory") writeFileSync(inventoryPath, "{}");
				else {
					const record = JSON.parse(readFileSync(segmentPath, "utf8").trimEnd());
					const body = variant === "malformed JSON" ? '{"schemaVersion":\n' : JSON.stringify({ ...record, operation: "invalid" }) + "\n";
					segment.bytes = Buffer.byteLength(body); segment.digest = createHash("sha256").update(body).digest("hex");
					writeFileSync(segmentPath, body); writeFileSync(inventoryPath, JSON.stringify(inventory));
					assert.equal(readFileSync(segmentPath).length, segment.bytes);
					assert.equal(createHash("sha256").update(readFileSync(segmentPath)).digest("hex"), segment.digest);
				}
				const inventoryBefore = readFileSync(inventoryPath), segmentBefore = readFileSync(segmentPath);
				const native = await metricsTool.execute(`m-corrupt-${variant}`, {});
				assert.notEqual(native.isError, true, "expected source failure remains a successful JSON report");
				for (const report of [await core.buildPluginMetricsReport(), JSON.parse(text(native))]) {
					assert.equal(report.status, "partial", variant);
					assert.equal(report.plugins["verification-receipts"].status, "unavailable");
					assert.equal(report.plugins["verification-receipts"].reason, "store_corrupt");
					assert.equal(report.plugins["verification-receipts"].metrics, null);
					assert.equal(report.plugins["verification-receipts"].snapshot, null);
					assert.equal(report.plugins["jev-advisor"].status, "ok");
					assert.equal(report.plugins["ui-regression"].status, "ok");
					assert.equal(report.correlation.status, "ok");
				}
				assert.deepEqual(readFileSync(inventoryPath), inventoryBefore);
				assert.deepEqual(readFileSync(segmentPath), segmentBefore);
			}
		} finally { process.env.HOME = priorHome; }
		assert.equal(fetchCalls, beforeFetch);
		assert.equal(unexpectedFetches, beforeUnexpectedFetches);
	});

	await check("state descriptor growth, replacement and late lock fail closed without unbounded reads", async () => {
		const { mock } = await import("bun:test");
		const file = path.join(root, "state-read-races", "state.v2.json");
		mkdirSync(path.dirname(file), { mode: 0o700 });
		const canonical = JSON.stringify(core.emptyEvidenceV2());
		for (const scenario of ["overflow", "rewrite", "replace", "lock"]) {
			writeFileSync(file, canonical, { mode: 0o600 });
			const originalRead = fs.readSync;
			const originalParse = JSON.parse;
			let injected = false, consumed = 0, parses = 0;
			const interceptedRead = (...args: any[]) => {
				if (!injected) {
					injected = true;
					if (scenario === "overflow") fs.appendFileSync(file, " ".repeat(2097153));
					if (scenario === "rewrite") {
						writeFileSync(file, canonical, { mode: 0o600 });
						fs.utimesSync(file, new Date(), new Date(Date.now() + 10000));
					}
					if (scenario === "replace") {
						writeFileSync(`${file}.replacement`, canonical, { mode: 0o600 });
						renameSync(`${file}.replacement`, file);
					}
					if (scenario === "lock") writeFileSync(`${file}.lock`, "foreign", { mode: 0o600 });
				}
				const bytes = (originalRead as any)(...args);
				consumed += bytes;
				return bytes;
			};
			mock.module("node:fs", () => ({ ...fs, default: fs, readSync: interceptedRead }));
			const raceCore = await import(pathToFileURL(path.join(plugin, "lib/decision.ts")).href + `?race=${scenario}`);
			JSON.parse = ((...args: any[]) => { parses++; return (originalParse as any)(...args); }) as typeof JSON.parse;
			let result;
			try { result = raceCore.readEvidenceV2(file); }
			finally { mock.restore(); JSON.parse = originalParse; syncBuiltinESMExports(); }
			assert.equal(injected, true, `${scenario}: descriptor interception ran (${JSON.stringify(result)})`);
			assert.equal(result.status, "unavailable", scenario);
			assert.equal(result.reason, scenario === "overflow" ? "oversized" : scenario === "lock" ? "locked" : "unsafe_path", scenario);
			assert.ok(consumed <= 2097153, `${scenario}: bounded descriptor consumption`);
			if (scenario === "overflow") { assert.equal(consumed, 2097153); assert.equal(parses, 0, "overflow never reaches JSON decoding"); }
			rmSync(`${file}.lock`, { force: true });
		}
		writeFileSync(file, canonical, { mode: 0o600 });
		assert.equal((await core.transaction(file, limits, () => {})).status, "ok", "internal reader accepts transaction-owned lock");
	});

	await check("metrics sparse source-specific fields, overflow isolation and timestamp extrema", async () => {
		const counts = { tests: 0, suites: 0, topLevel: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
		const records = [{ operation: "run", execution: { status: "passed", reason: "complete", counts, assertions: [] } }];
		const verification = core.aggregateRunStatusMetrics(records, "verification-receipts");
		const ui = core.aggregateRunStatusMetrics(records, "ui-regression");
		assert.deepEqual(verification.run.execution.byReason, { complete: 1 });
		assert.equal(verification.run.assertions, null);
		assert.deepEqual(verification.run.nativeCounts, { contributingRecords: 1, totals: counts });
		assert.equal(ui.run.nativeCounts, null);
		assert.equal(ui.run.assertions.contributingRecords, 1);
		assert.deepEqual(core.aggregateRunStatusMetrics([], "ui-regression").run.execution.byStatus, {});
		const home = path.join(root, "metrics-overflow-home");
		mkdirSync(home, { mode: 0o700 });
		const baseDir = path.join(home, ".gjc-plugin");
		const priorHome = process.env.HOME;
		process.env.HOME = home;
		try {
			for (const [pluginName, operation, durations] of [
				["verification-receipts", "run", [Number.MAX_SAFE_INTEGER, 1]],
				["ui-regression", "run", [0]],
				["jev-advisor", "task_advice", [1, 2, 3]],
			] as const) {
				for (const durationMs of durations) assert.equal((await appendPluginOutcome(pluginName, { operation, durationMs }, { baseDir })).persisted, true);
			}
			const journal = path.join(baseDir, "jev-advisor", "journal", "v1");
			const inventoryPath = path.join(journal, "inventory.json");
			const inventory = JSON.parse(readFileSync(inventoryPath, "utf8"));
			assert.equal(inventory.segments.length, 1);
			const segment = inventory.segments[0];
			const segmentPath = path.join(journal, segment.name);
			const times = ["2026-01-03T00:00:00.000Z", "2026-01-01T00:00:00.000Z", "2026-01-02T00:00:00.000Z"];
			const body = readFileSync(segmentPath, "utf8").trimEnd().split("\n").map((line, index) => {
				const record = JSON.parse(line); record.observedAt = times[index]; return JSON.stringify(record);
			}).join("\n") + "\n";
			segment.bytes = Buffer.byteLength(body);
			segment.digest = (await import("node:crypto")).createHash("sha256").update(body).digest("hex");
			writeFileSync(segmentPath, body); writeFileSync(inventoryPath, JSON.stringify(inventory));
			const report = await core.buildPluginMetricsReport();
			assert.equal(report.status, "partial");
			assert.equal(report.plugins["verification-receipts"].reason, "resource_limit");
			assert.equal(report.plugins["verification-receipts"].metrics, null);
			assert.equal(report.plugins["verification-receipts"].snapshot, null);
			assert.equal(report.plugins["ui-regression"].status, "ok");
			assert.equal(report.plugins["jev-advisor"].status, "ok");
			assert.equal(report.plugins["jev-advisor"].snapshot.oldestObservedAt, times[1]);
			assert.equal(report.plugins["jev-advisor"].snapshot.newestObservedAt, times[0]);
		} finally { process.env.HOME = priorHome; }
	});

async function version2StateFileFixture(home: string): Promise<string> {
	return path.join(home, ".gjc-plugin", "jev-advisor", "state.v2.json");
}

async function seedStateWithZeroDuration(file: string): Promise<void> {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const state = core.emptyEvidenceV2();
	state.jobs[JSON.stringify(["s", "j0"])] = { ref: { sessionId: "s", jobId: "j0" }, status: "completed", statusObservations: ["completed"], durationObservations: [], requestedModelObservations: [], effectiveModelObservations: [], allocatedChildIds: [], actualTier: null, observedAt: Date.now(), taskKey: null, conflicts: [] };
	writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
}
	console.log(JSON.stringify({ kind: "api-package-test-report", cases, failures, scriptedFetchCalls: fetchCalls, unexpectedFetches, realNetworkCalls: 0, generatedArtifactsCompared: 8 }));
	console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
	process.exitCode = failures || cases === 0 ? 1 : 0;
}
