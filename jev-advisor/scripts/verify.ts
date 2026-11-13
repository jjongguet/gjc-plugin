#!/usr/bin/env bun
/** Offline generated-package acceptance. No product import before child isolation. */
import assert from "node:assert/strict";
import { validateSemanticEnvelope } from "../lib/alignment";

import fs from "node:fs";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, statSync, symlinkSync, linkSync, copyFileSync, realpathSync, renameSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

const script = fileURLToPath(import.meta.url);
const plugin = path.resolve(path.dirname(script), "..");
if (process.argv[2] === "--runtime") {
	await runInstalledRuntime();
} else if (process.argv[2] !== "--isolated") {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jev-offline-")));
	let status = 1;
	try {
		for (const dir of ["home", "tmp", "cwd", "config"]) mkdirSync(path.join(root, dir), { mode: 0o700 });
		const child = spawnSync(process.execPath, ["--no-env-file", script, "--isolated", root, ...process.argv.slice(2)], {
			cwd: path.join(root, "cwd"),
			env: { HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), XDG_CONFIG_HOME: path.join(root, "config"), LC_ALL: "C", JEV_VERIFY_CHILD: "1" },
			stdio: "inherit",
			timeout: process.argv.includes("--perf") ? 240000 : 120000,
		});
		if (child.error) console.error(child.error.message);
		status = child.status ?? 1;
	} finally { rmSync(root, { recursive: true, force: true }); }
	process.exitCode = status;
} else if (process.argv.includes("--perf")) {
	await runPerformance(process.argv[3]);
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
	const semanticCore = await import(pathToFileURL(path.join(plugin, "lib/semantic.ts")).href);
	const alignmentJournalCore = await import(pathToFileURL(path.join(plugin, "lib/alignment-journal.ts")).href);
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
		for (const key of Object.keys(process.env)) if (key.startsWith("JEV_ADVISOR_") || key === "OPENROUTER_API_KEY" || key === "OPENGATEWAY_API_KEY" || key === "JEV_ALIGNMENT_SEND_AUTHORITY_TEXT") delete process.env[key];
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
	const manual = toolModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } });
	const checkTool = checkToolModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } });
	const systemCheck = (value: { verdict?: unknown; confidence?: unknown; probabilities?: unknown; rationale?: unknown } = { verdict: "correct", confidence: 0.9 }) =>
		new Response(JSON.stringify({ answers: { check: { type: "choice", choice: value.verdict, confidence: value.confidence, ...(value.probabilities !== undefined ? { probabilities: value.probabilities } : {}), ...(value.rationale !== undefined ? { rationale: value.rationale } : {}) } } }));
	const text = (value: any) => value.content[0].text;
	const parse = (value: unknown) => core.parseDecision(JSON.stringify(value));
	const request = (value: any, config = cfg(), input = task()) => core.askDecisionModel(config, input, async (_url: any, init: any) => {
		assert.equal(init.redirect, "error");
		return config.provider === "openrouter" ? chat(value) : system(value);
	});

	const pngBytes = (width: number, height: number, animated = false) => {
		const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
		const chunk = (type: string, data: Buffer) => {
			const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
			return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
		};
		const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
		const parts = [signature, chunk("IHDR", header)];
		if (animated) parts.push(chunk("acTL", Buffer.alloc(8)));
		parts.push(chunk("IDAT", Buffer.from([0x78, 0x9c, 0x03, 0x00, 0x00, 0x00, 0x00, 0x01])), chunk("IEND", Buffer.alloc(0)));
		return Buffer.concat(parts);
	};
	const jpegBytes = (width: number, height: number) => Buffer.concat([
		Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]),
		Buffer.from([0xff, 0xd9]),
	]);

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
		assert.equal(core.providerPromptLimit(cfg({ JEV_ADVISOR_PROVIDER: "ollaya" })), core.LOOPBACK_PROMPT_CHARS);
		assert.equal(core.providerPromptLimit(cfg()), core.HOSTED_PROMPT_CHARS);
		assert.ok(core.HOSTED_PROMPT_CHARS > core.LOOPBACK_PROMPT_CHARS);
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
	await check("hosted prompt budget admits long assignments and still rejects at the boundary", () => {
		const long = "x".repeat(8000);
		assert.equal(core.extractTasks(batch([long]), core.HOSTED_PROMPT_CHARS).tasks[0].complete, true);
		assert.equal(core.extractTasks(batch([long]), core.LOOPBACK_PROMPT_CHARS).tasks[0].complete, false);
		const overhead = core.extractTasks(batch(["z"]), core.HOSTED_PROMPT_CHARS).tasks[0].prompt.length - 1;
		const exact = core.extractTasks(batch(["z".repeat(core.HOSTED_PROMPT_CHARS - overhead)]), core.HOSTED_PROMPT_CHARS).tasks[0];
		assert.equal(exact.prompt.length, core.HOSTED_PROMPT_CHARS); assert.equal(exact.complete, true);
		const over = core.extractTasks(batch(["z".repeat(core.HOSTED_PROMPT_CHARS - overhead + 1)]), core.HOSTED_PROMPT_CHARS).tasks[0];
		assert.equal(over.complete, false);
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

	await check("image evidence: deterministic inspection, bounds and jev-only wire parts", async () => {
		const png512 = pngBytes(512, 512);
		assert.deepEqual(core.inspectImage(png512).image, { mediaType: "image/png", base64: "", width: 512, height: 512 });
		assert.deepEqual(core.inspectImage(jpegBytes(800, 600)).image, { mediaType: "image/jpeg", base64: "", width: 800, height: 600 });
		assert.equal(core.inspectImage(pngBytes(255, 512)).status, "unsupported_input", "below the 256 px minimum");
		assert.equal(core.inspectImage(pngBytes(512, 1569)).status, "input_too_large", "above the 1568 px maximum");
		assert.equal(core.inspectImage(pngBytes(260, 260)).status, "unsupported_input", "below the total pixel floor");
		assert.equal(core.inspectImage(pngBytes(512, 512, true)).status, "unsupported_input", "animated PNG is rejected");
		assert.equal(core.inspectImage(Buffer.from("GIF89a")).status, "unsupported_input");
		assert.equal(core.inspectImage(new Uint8Array(0)).status, "unsupported_input");

		const base64 = png512.toString("base64");
		const image = { mediaType: "image/png", base64, width: 512, height: 512 };
		assert.equal(core.prepareCheck("q", "artifact", 4000, [image]).status, "ok");
		assert.equal(core.prepareCheck("q", "artifact", 4000, [image, image, image, image, image]).status, "input_too_large");
		assert.equal(core.prepareCheck("q", "artifact", 4000, [{ ...image, mediaType: "image/webp" }]).status, "unsupported_input");
		assert.equal(core.prepareCheck("q", "artifact", 4000, [{ ...image, base64: "not base64!" }]).status, "unsupported_input");
		assert.equal(core.prepareCheck("q", "artifact", 4000, [{ ...image, width: 100, height: 100 }]).status, "unsupported_input");
		assert.equal(core.prepareCheck("q", "artifact", 4000, "images").status, "unsupported_input");

		const prepared = core.prepareCheck("Does the screenshot show the retry banner?", "Observed UI state", 4000, [image]);
		assert.equal(prepared.status, "ok");
		let wire = "";
		const decided = await core.askCheckModel(cfg(), prepared.check, async (_: any, init: any) => { wire = String(init.body); return systemCheck(); });
		assert.equal(decided.status, "decision");
		assert.deepEqual(JSON.parse(wire).state, ["Observed UI state", { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } }]);
		assert.equal(JSON.parse(wire).model, "typesafe/jev-1.14");

		let calls = 0;
		const noFetch = async () => { calls++; return systemCheck(); };
		for (const provider of ["openrouter", "ollaya", "typesafe-jev"]) {
			assert.equal((await core.askCheckModel(cfg({ JEV_ADVISOR_PROVIDER: provider }), prepared.check, noFetch)).reason, "unsupported_input", provider);
		}
		assert.equal(calls, 0, "unverified image routes never call fetch");
	});

	await check("jev_check images: local inspection, no bytes leaked, deterministic rejection", async () => {
		env({ JEV_ADVISOR_PROVIDER: "jev" });
		const dir = path.join(root, "images"); mkdirSync(dir, { recursive: true });
		const file = path.join(dir, "shot.png"); writeFileSync(file, pngBytes(512, 512));
		const small = path.join(dir, "small.png"); writeFileSync(small, pngBytes(64, 64));
		let body = "";
		responder = (_url, init) => { body = String(init.body); return systemCheck({ verdict: "correct", confidence: 0.93 }); };
		const accepted = await checkTool.execute("image-ok", { question: "Does the screenshot show the retry banner?", artifact: "Observed UI state", images: [file] });
		const result = JSON.parse(text(accepted));
		assert.equal(result.status, "decision");
		assert.equal(result.verdict, "correct");
		assert.ok(body.includes("data:image/png;base64,"));
		assert.equal(body.includes("shot.png"), false, "file paths never reach the provider");
		assert.equal(text(accepted).includes("iVBORw0KGgo"), false, "bytes never reach the tool result");

		const before = fetchCalls;
		for (const images of [[path.join(dir, "missing.png")], [small], [dir], [file, file, file, file, file]]) {
			const rejected = JSON.parse(text(await checkTool.execute("image-reject", { question: "q", artifact: "a", images })));
			assert.equal(rejected.status, "no_decision", JSON.stringify(images));
			assert.ok(["unsupported_input", "input_too_large"].includes(rejected.reason), JSON.stringify(rejected));
		}
		assert.equal(fetchCalls, before, "rejected images never reach the provider");
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
	await check("exact-prompt reuse preserves four independent children and the fifth-slot limit", async () => {
		for (const memory of ["on", "off"]) {
			env({ JEV_ADVISOR_MEMORY: memory }); responder = () => system(decision("strong"));
			const start = fetchCalls;
			await hook(preModule)(call("duplicates", batch(Array(5).fill("PRIVATE_REUSE_FIXTURE"))), context());
			assert.equal(fetchCalls - start, 1);
			const outcomes = journalRecords().find((r: any) => r.operation === "task_advice").taskAdvice;
			assert.deepEqual(outcomes.map((r: any) => r.status), ["decision", "decision", "decision", "decision", "no_decision"]);
			assert.equal(outcomes[4].reason, "batch_limit");
			if (memory === "on") {
				const rows = records();
				assert.equal(rows.length, 5);
				assert.equal(new Set(rows.map(r => r.requestToken)).size, 5);
				assert.deepEqual(rows.map(r => r.ref.taskIndex), [0, 1, 2, 3, 4]);
				assert.ok(!JSON.stringify(state()).includes("PRIVATE_REUSE_FIXTURE"));
			}
		}
	});
	await check("reuse never admits the next distinct task or changes its provider prompt", async () => {
		env(); const bodies: string[] = [];
		responder = (_url, init) => { bodies.push(String(init.body)); return system(); };
		const input = batch(["A", "A", "B", "C", "D"]);
		await hook(preModule)(call("slots", input), context());
		assert.equal(bodies.length, 3);
		const expected = core.extractTasks(input, core.HOSTED_PROMPT_CHARS).tasks;
		assert.deepEqual(bodies.map(b => JSON.parse(b).state), [expected[0].prompt, expected[2].prompt, expected[3].prompt]);
		assert.equal(records().find(r => r.ref.taskIndex === 4).advice.reason, "batch_limit");
	});
	await check("reused advice keeps requested-tier enforcement task-local", async () => {
		env({ JEV_ADVISOR_MODE: "enforce" }); responder = () => system(decision("strong"));
		const before = fetchCalls;
		const result = await hook(preModule)(call("tiers", batch(["same", "same"], ["strong", "fast"])), context());
		assert.equal(fetchCalls - before, 1);
		assert.equal(result.block, true); assert.match(result.reason, /task 1 recommends strong/);
		assert.deepEqual(records().map(r => r.requestedTier), ["strong", "fast"]);
	});
	await check("reuse is invocation-local and exact, not a cross-call prompt cache", async () => {
		env(); responder = () => system(); const pre = hook(preModule); const before = fetchCalls;
		await pre(call("one", batch(["A", "A"])), context());
		await pre(call("two", batch(["A", "A"])), context());
		await pre(call("different", batch(["A", "A!"])), context());
		assert.equal(fetchCalls - before, 4);
		assert.equal(records().length, 6);
	});
	await check("HTTP and invalid response failures never seed successful reuse", async () => {
		for (const failure of [401, 429, 500, "throw", "invalid", "overflow"]) {
			env(); let requests = 0;
			responder = () => {
				if (++requests > 1) return system();
				if (typeof failure === "number") return new Response("fixture", { status: failure });
				if (failure === "throw") throw new Error("fixture");
				return new Response(failure === "overflow" ? "x".repeat(65537) : "invalid");
			};
			await hook(preModule)(call("fail", batch(Array(4).fill("same"))), context());
			assert.equal(requests, 2, String(failure));
			assert.equal(records()[0].advice.status, "no_decision");
			assert.deepEqual(records().slice(1).map(r => r.advice.status), ["decision", "decision", "decision"]);
		}
	});
	await check("expired deadline and observed caller abort are checked before a cache hit", async () => {
		const original = Object.getOwnPropertyDescriptor(performance, "now"); let clock = 0;
		Object.defineProperty(performance, "now", { configurable: true, value: () => clock });
		try {
			env(); responder = () => { clock = 8001; return system(); };
			await hook(preModule)(call("deadline", batch(["same", "same"])), context());
			assert.equal(records()[1].advice.reason, "budget_exceeded");
			clock = 0; env(); const controller = new AbortController();
			responder = () => { controller.abort(); return system(); };
			await hook(preModule)(call("abort", batch(["same", "same"])), { ...context(), signal: controller.signal });
			assert.equal(records()[1].advice.reason, "aborted");
		} finally { if (original) Object.defineProperty(performance, "now", original); else delete (performance as any).now; }
	});
	await check("credentials are provider-scoped and never borrowed across providers", async () => {
		const jevFromOpenRouter = cfg({ JEV_ADVISOR_API_KEY: "", OPENROUTER_API_KEY: "synthetic-or" });
		assert.equal(jevFromOpenRouter.apiKey, "synthetic-or");
		assert.equal(core.isConfigured(jevFromOpenRouter), true);
		const typesafeBorrowing = cfg({ JEV_ADVISOR_API_KEY: "", JEV_ADVISOR_PROVIDER: "typesafe-jev", OPENROUTER_API_KEY: "synthetic-or" });
		assert.equal(typesafeBorrowing.apiKey, "", "typesafe-jev must not send the OpenRouter key to api.typesafe.ai");
		assert.equal(core.isConfigured(typesafeBorrowing), false);
		const typesafeOwn = cfg({ JEV_ADVISOR_API_KEY: "", JEV_ADVISOR_PROVIDER: "typesafe-jev", TYPESAFE_API_KEY: "synthetic-ts" });
		assert.equal(typesafeOwn.apiKey, "synthetic-ts");
		assert.equal(core.isConfigured(typesafeOwn), true);
		const explicitOverride = cfg({ JEV_ADVISOR_PROVIDER: "typesafe-jev" });
		assert.equal(explicitOverride.apiKey, "synthetic-key", "JEV_ADVISOR_API_KEY outranks the provider variable");
		assert.deepEqual(core.providerKeyEnv("typesafe-jev"), ["TYPESAFE_API_KEY"]);
		assert.deepEqual(core.providerKeyEnv("ollaya"), []);
		const contract = await import(pathToFileURL(path.join(plugin, "../shared/lib/decision-contract.ts")).href);
		for (const id of ["opengateway/sionic-ai/jev-omni", "opengateway/sionic-ai/decider-4b"]) {
			assert.deepEqual(contract.decisionProvider(id).authEnv, ["OPENGATEWAY_API_KEY"], id);
		}
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
		const b: any = batch([variant === "oversize" ? "x".repeat(core.HOSTED_PROMPT_CHARS) : "work"], [variant === "over" ? "strong" : "fast"]);
			if (variant === "missing") delete b.tasks[0].tier;
			const widget: string[] = [];
			const ctx = { ...context(), ui: { notify() {}, setWidget: (_: string, rows: string[]) => widget.push(rows.join("\n")) } };
			const beforeFetch = fetchCalls;
			assert.equal(await hook(preModule)(call("edge", b), ctx), undefined);
			if (variant === "oversize") {
				assert.equal(records()[0].advice.reason, "input_too_large");
				assert.equal(fetchCalls, beforeFetch, "oversize makes no provider call");
				assert.match(widget.join("\n"), new RegExp(`input_too_large: \\d+ > ${core.HOSTED_PROMPT_CHARS} chars`), widget.join("\n"));
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
			const tool = module.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } });
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
	await check("canonical builder exact bytes for all nine surfaces and stale candidate", () => {
		const fixture = path.join(root, "builder");
		for (const dir of ["scripts", "lib", "src", "hooks", "tools"]) mkdirSync(path.join(fixture, dir), { recursive: true });
		mkdirSync(path.join(root, "shared", "lib"), { recursive: true });
		copyFileSync(path.join(plugin, "../shared/lib/results.ts"), path.join(root, "shared/lib/results.ts"));
		copyFileSync(path.join(plugin, "../shared/lib/decision-contract.ts"), path.join(root, "shared/lib/decision-contract.ts"));
		for (const file of ["scripts/build.mjs", "semantic.openapi.json", "lib/semantic.ts", "lib/decision.ts", "lib/alignment.ts", "lib/alignment-journal.ts", "src/hook.adapter.ts", "src/result.adapter.ts", "src/tool.adapter.ts", "src/check.adapter.ts", "src/metrics.adapter.ts", "src/session-start.adapter.ts", "src/alignment.adapter.ts", "src/alignment-observe.adapter.ts", "src/alignment-shutdown.adapter.ts"]) copyFileSync(path.join(plugin, file), path.join(fixture, file));
		const result = spawnSync(process.execPath, ["--no-env-file", path.join(fixture, "scripts/build.mjs")], { cwd: fixture, env: { HOME: os.homedir(), TMPDIR: process.env.TMPDIR!, LC_ALL: "C" }, encoding: "utf8", timeout: 30000 });
		assert.equal(result.status, 0, result.stderr);
		for (const file of ["hooks/jev-advisor.ts", "hooks/jev-advisor-result.ts", "tools/jev-advise.ts", "tools/jev-check.ts", "tools/plugin-metrics.ts", "hooks/jev-advisor-session-start.ts", "hooks/jev-advisor-alignment.ts", "hooks/jev-advisor-alignment-observe.ts", "hooks/jev-advisor-alignment-shutdown.ts"]) {
			const expected = readFileSync(path.join(fixture, file)); const actual = readFileSync(path.join(plugin, file)); assert.deepEqual(actual, expected, file);
			assert.notDeepEqual(Buffer.concat([actual, Buffer.from(" ")]), expected); console.log(`artifact-sync ${file}: exact`);
		}
	});
	await check("manifest surfaces and release version", () => {
		const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8")); assert.equal(manifest.version, "0.0.18");
		assert.deepEqual(manifest.hooks.map((h: any) => [h.event, h.target, h.phase]), [
			["tool_call", "task", "before"],
			["tool_result", "task", "after"],
			["tool_result", "subagent", "after"],
			["tool_call", "*", "before"],
			["tool_result", "*", "after"],
			["session_shutdown", undefined, undefined],
			["session_start", undefined, undefined],
		]);
		assert.equal(new Set(manifest.hooks.map((h: any) => h.name)).size, 7);
		for (const name of ["jev-goal-alignment", "jev-goal-alignment-observe", "jev-goal-alignment-shutdown", "jev-advisor-session-start"]) assert.ok(manifest.hooks.some((h: any) => h.name === name), name);
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

	// JJO-1161 P1: 게이트가 명사의 "stop"/"중지"/"read-only"/"instead" 를 지시로 오판하면
	// 일상적인 구현 요청이 cancel/read_only/supersede 로 분류되어 정상 쓰기가 막힌다.
	await check("alignment lexicon: ordinary work requests never read as cancel, read-only or supersede", () => {
		const readOnlyOf = (text: string) =>
			alignmentCore.collectAuthority([alignmentUser("lex-ro", text)]).constraints.some((constraint: any) => constraint.kind === "read_only");
		const notSignals = [
			"버튼에 pause 상태를 추가하고 stop 이벤트를 로깅해줘",
			"배포 중지 기능을 구현해줘",
			"서버가 멈춰 있는 이유를 찾아줘",
			"service stop 후 start 가 되는지 테스트해줘",
			"use map instead of for loop",
			"A 대신 B를 쓰자",
		];
		for (const text of notSignals) {
			assert.equal(alignmentCore.classifyChange(text), "unknown", text);
			assert.equal(readOnlyOf(text), false, text);
		}
		assert.equal(readOnlyOf("이 설정은 읽기 전용 모드로 열어줘"), false, "a read-only feature is not a read-only directive");

		// 2026-11-01 실측: 위임 프롬프트가 "add a test; do not modify or delete the existing test"라고 쓰면
		// 범위 한정 금지가 세션 전체 읽기전용으로 승격돼 정작 요청한 쓰기까지 막혔다(라이브 서브에이전트 차단).
		const scoped = [
			"Add one test to service.test.ts and do not modify or delete the existing base test.",
			"기존 테스트는 수정하지 마. 새 테스트를 추가해줘.",
		];
		for (const text of scoped) {
			const authority = alignmentCore.collectAuthority([alignmentUser("scope-probe", text)]);
			assert.equal(authority.constraints.some((constraint: any) => constraint.kind === "read_only"), false, text);
			assert.equal(authority.constraints.some((constraint: any) => constraint.kind === "forbidden_target"), false, text);
			assert.equal(alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("service.test.ts"), authority }).block, false, text);
		}
		// 한 문장 안에서 지목한 대상은 여전히 금지된다.
		const sameSentence = alignmentCore.collectAuthority([alignmentUser("scope-keep", "implement `src/demo.ts` and do not touch src/other.ts")]);
		assert.equal(sameSentence.constraints.filter((constraint: any) => constraint.kind === "forbidden_target").length, 1);
		assert.equal(alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/other.ts"), authority: sameSentence }).block, true);

		// 반대 방향: 진짜 지시는 여전히 잡힌다.
		for (const text of ["그만해", "stop", "Stop.", "stop the current work", "작업 중지해줘", "작업 취소", "do not continue", "cancel the task"]) {
			assert.equal(alignmentCore.classifyChange(text), "cancel", text);
		}
		for (const text of ["새 목표로 진행하자", "다른 작업을 하자", "instead, do the migration"]) {
			assert.equal(alignmentCore.classifyChange(text), "supersede", text);
		}
		// 2026-11-01 실측(세션 d4e3084fd4f4c07c): "다른 작업은 하지 마"는 범위 축소이지 목표 교체가 아니다.
		for (const text of ["다른 작업은 하지 마", "다른 작업 금지"]) {
			assert.notEqual(alignmentCore.classifyChange(text), "supersede", text);
		}
		for (const text of ["This is read-only; do not modify anything.", "읽기 전용으로 진행해", "수정하지 마", "don't modify anything", "do not modify the code"]) {
			assert.equal(readOnlyOf(text), true, text);
		}
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
		assert.ok(
			alignmentEvents().events.some((event: any) => event.kind === "hook_error"),
			"a thrown handler is recorded as hook_error and survives the production reader",
		);
		// The production reader (not a raw JSON.parse) must accept the kind.
		const parsedJournal = alignmentCore.readJournalTexts([alignmentEvents().text], Date.now());
		assert.ok(
			parsedJournal.events.some((event: any) => event.kind === "hook_error"),
			"hook_error survives readJournalTexts",
		);
		assert.equal(fetchCalls, before);
		assert.equal(unexpectedFetches, 0);
	});

	await check("AC-A3 semantic advisory never leaves the process without opt-in", async () => {
		const suppressed = validateSemanticEnvelope({ sendAuthorityText: false, confidence: 0.9, probabilities: { aligned: 1 }, labels: ["aligned", "drift"] });
		assert.equal(suppressed.status, "outbound_suppressed");
		assert.equal(suppressed.outbound, false);
		assert.equal(suppressed.confidence, null);
	});

	await check("AC-A3 precision anomaly keeps the raw envelope instead of clamping it", async () => {
		const anomalous = validateSemanticEnvelope({
			sendAuthorityText: true,
			confidence: 0.9989,
			probabilities: { aligned: 0.0001, drift: 0.9993, uncertain: 0.0007 },
			labels: ["aligned", "drift", "uncertain"],
		});
		assert.equal(anomalous.status, "precision_anomaly");
		assert.equal(anomalous.confidence, 0.9989, "provider confidence is preserved verbatim");
		assert.deepEqual(anomalous.probabilities, { aligned: 0.0001, drift: 0.9993, uncertain: 0.0007 }, "no normalisation");
		assert.equal(Number(anomalous.probabilitySum?.toFixed(4)), 1.0001);
		const exact = validateSemanticEnvelope({ sendAuthorityText: true, confidence: 0.9681, probabilities: { aligned: 0.9788, drift: 0.0022, uncertain: 0.019 }, labels: ["aligned", "drift", "uncertain"] });
		assert.equal(exact.status, "ok");
		assert.equal(exact.confidence, 0.9681);
		assert.equal(validateSemanticEnvelope({ sendAuthorityText: true, confidence: 0.5, probabilities: { aligned: 1 }, labels: ["aligned", "drift"] }).status, "invalid_response");
	});

	const semanticEnv = { JEV_ALIGNMENT_SEND_AUTHORITY_TEXT: "true", OPENGATEWAY_API_KEY: "synthetic-key" };
	const semanticInput = { branchEntries: [alignmentUser("semantic-user", "Implement `src/demo.ts`")], targetPaths: ["src/demo.ts"] };
	const semanticAnswer = (choice: unknown = "aligned", confidence: unknown = 0.9681, probabilities: unknown = { aligned: 0.9788, drift: 0.0022, uncertain: 0.019 }) => ({ answers: { alignment: { type: "choice", choice, confidence, probabilities } } });
	await check("JJO-663 default and false opt-in make exactly zero outbound calls before input or key access", async () => {
		let outbound = 0;
		const spy = async () => { outbound++; throw new Error("must not call"); };
		const unreadable = new Proxy({}, { get() { throw new Error("must not inspect input"); } });
		for (const flag of [undefined, "false", "1", "TRUE"]) {
			const config = { JEV_ALIGNMENT_SEND_AUTHORITY_TEXT: flag, get OPENGATEWAY_API_KEY(): string { throw new Error("must not read key"); } };
			assert.deepEqual(await semanticCore.askSemanticAdvice(unreadable, config, spy), { status: "no_decision", reason: "outbound_suppressed", outbound: false });
		}
		assert.equal(outbound, 0);
	});
	await check("JJO-663 unconfigured never borrows OpenAI, OpenRouter or advisor credentials", async () => {
		let outbound = 0;
		const result = await semanticCore.askSemanticAdvice(semanticInput, { JEV_ALIGNMENT_SEND_AUTHORITY_TEXT: "true", OPENAI_API_KEY: "wrong-route", OPENROUTER_API_KEY: "wrong-route", JEV_ADVISOR_API_KEY: "wrong-route" }, async () => { outbound++; throw new Error("must not call"); });
		assert.deepEqual(result, { status: "no_decision", reason: "unconfigured", outbound: false });
		assert.deepEqual(await semanticCore.askSemanticAdvice(semanticInput, { JEV_ALIGNMENT_SEND_AUTHORITY_TEXT: "true", get OPENGATEWAY_API_KEY(): string { throw new Error("unreadable configuration"); } }), { status: "no_decision", reason: "unconfigured", outbound: false });
		assert.equal(outbound, 0);
	});
	await check("JJO-663 serialized wire follows OpenAPI, fixed route and host-only authority", async () => {
		const spec = JSON.parse(readFileSync(path.join(plugin, "semantic.openapi.json"), "utf8"));
		const operation = spec.paths["/v1/decisions"].post;
		assert.equal(operation["x-timeout-ms"], 8000);
		assert.equal(operation["x-retries"], 0);
		assert.equal(operation["x-credential-env"], "OPENGATEWAY_API_KEY");
		assert.equal(operation.responses["200"].content["application/json"].schema.properties.answers.properties.alignment.properties.probabilities["x-sum-tolerance"], 1e-6);
		let calls = 0;
		const input = { ...semanticInput, branchEntries: [...semanticInput.branchEntries, { type: "assistant", text: "ASSISTANT_CANARY" }, { type: "tool", text: "TOOL_CANARY" }] };
		const got = await semanticCore.askSemanticAdvice(input, { ...semanticEnv, JEV_ADVISOR_ENDPOINT: "https://evil.invalid", JEV_ADVISOR_MODEL: "other" }, async (url: string, init: RequestInit) => {
			calls++;
			assert.equal(url, "https://apis.opengateway.ai/v1/decisions");
			assert.equal(init.method, "POST"); assert.equal(init.redirect, "error");
			assert.equal(new Headers(init.headers).get("authorization"), "Bearer synthetic-key");
			const wire = JSON.parse(String(init.body));
			const schema = operation.requestBody.content["application/json"].schema;
			assert.deepEqual(Object.keys(wire).sort(), schema.required.slice().sort());
			assert.equal(wire.model, schema.properties.model.const);
			const question = schema.properties.questions.properties.alignment.properties;
			assert.deepEqual(wire.questions, { alignment: { type: question.type.const, instructions: question.instructions.const, criteria: question.criteria.const } });
			assert.equal(Array.isArray(wire.questions.alignment.criteria), false, "criteria is a record, not an array");
			assert.deepEqual(wire.state, { userEntries: ["Implement `src/demo.ts`"], action: { actionClass: "write", targetPaths: ["src/demo.ts"] } });
			assert.ok(!String(init.body).includes("CANARY"));
			return new Response(JSON.stringify(semanticAnswer()));
		});
		assert.equal(calls, 1);
		assert.deepEqual(got, { status: "decision", choice: "aligned", confidence: 0.9681, probabilities: { aligned: 0.9788, drift: 0.0022, uncertain: 0.019 }, outbound: true });
	});
	await check("JJO-663 incomplete, oversized or missing authority is not silently sliced and sent", async () => {
		let outbound = 0;
		const inputs = [
			{ ...semanticInput, branchEntries: [] },
			{ ...semanticInput, branchEntries: [{ type: "assistant", text: "Implement `src/demo.ts`" }] },
			{ ...semanticInput, branchEntries: Array.from({ length: 13 }, (_, i) => alignmentUser(`e${i}`, "continue")) },
			{ ...semanticInput, branchEntries: [alignmentUser("long", "a".repeat(8193))] },
			{ ...semanticInput, branchEntries: Array.from({ length: 12 }, (_, i) => alignmentUser(`e${i}`, "한".repeat(8192))) },
			{ ...semanticInput, targetPaths: [] }, { ...semanticInput, targetPaths: ["https://invalid/"] },
			{ ...semanticInput, targetPaths: Array(17).fill("src/demo.ts") },
		];
		for (const input of inputs) assert.deepEqual(await semanticCore.askSemanticAdvice(input, semanticEnv, async () => { outbound++; throw new Error("must not call"); }), { status: "no_decision", reason: "invalid_input", outbound: false });
		assert.equal(outbound, 0);
	});
	for (const confidence of [undefined, null, "0.9", -0.000001, 1.000001, NaN, Infinity, -Infinity]) {
		await check(`JJO-663 invalid confidence rejected without clamping: ${String(confidence)}`, () => {
			assert.equal(semanticCore.parseSemanticAdvice(semanticAnswer("aligned", confidence === undefined ? null : confidence)).status, "no_decision");
			assert.equal(validateSemanticEnvelope({ sendAuthorityText: true, labels: ["aligned"], confidence, probabilities: { aligned: 1 } }).status, "invalid_response");
		});
	}
	await check("JJO-663 raw confidence endpoints and probabilities survive unchanged", () => {
		for (const confidence of [0, 1]) assert.equal(semanticCore.parseSemanticAdvice(semanticAnswer("drift", confidence, { aligned: 0, drift: 1, uncertain: 0 })).confidence, confidence);
		for (const probabilities of [{ aligned: 1, drift: 0 }, { aligned: 1, drift: 0, uncertain: 0, invented: 0 }, { aligned: 1.1, drift: -0.1, uncertain: 0 }, { aligned: NaN, drift: 1, uncertain: 0 }, { aligned: "1", drift: 0, uncertain: 0 }]) assert.equal(semanticCore.parseSemanticAdvice(semanticAnswer("aligned", 0.9, probabilities)).reason, "invalid_response");
		assert.equal(semanticCore.parseSemanticAdvice(semanticAnswer("invented")).reason, "invalid_response");
	});
	await check("JJO-663 precision_anomaly refuses consumption and preserves the raw numbers", () => {
		const probabilities = { aligned: 0.0001, drift: 0.9993, uncertain: 0.0007 };
		const got = semanticCore.parseSemanticAdvice(semanticAnswer("drift", 0.9989, probabilities));
		assert.deepEqual([got.status, got.reason, got.envelope.confidence, got.envelope.probabilities], ["no_decision", "precision_anomaly", 0.9989, probabilities]);
		assert.equal(got.choice, undefined, "rejected advice has no consumable choice");
		for (const delta of [-0.0000005, 0.0000005]) assert.equal(semanticCore.parseSemanticAdvice(semanticAnswer("aligned", 0.9, { aligned: 0.5, drift: 0.25, uncertain: 0.25 + delta })).status, "decision");
		for (const delta of [-0.000002, 0.000002]) assert.equal(semanticCore.parseSemanticAdvice(semanticAnswer("aligned", 0.9, { aligned: 0.5, drift: 0.25, uncertain: 0.25 + delta })).reason, "precision_anomaly");
	});
	for (const status of [302, 401, 402, 429, 500]) {
		await check(`JJO-663 HTTP ${status} is no_decision with retry 0`, async () => {
			let calls = 0;
			const got = await semanticCore.askSemanticAdvice(semanticInput, semanticEnv, async () => { calls++; return new Response("not logged", { status }); });
			assert.deepEqual(got, { status: "no_decision", reason: "http_error", outbound: true }); assert.equal(calls, 1);
		});
	}
	await check("JJO-663 transport, malformed JSON and oversized response are bounded no_decision", async () => {
		for (const [reason, responder] of [["provider_error", async () => { throw new Error("PRIVATE_PROVIDER_ERROR"); }], ["invalid_response", async () => new Response("not json")], ["response_cap", async () => new Response("x".repeat(65537))]] as const) {
			let calls = 0;
			const got = await semanticCore.askSemanticAdvice(semanticInput, semanticEnv, async () => { calls++; return responder(); });
			assert.deepEqual(got, { status: "no_decision", reason, outbound: true }); assert.equal(calls, 1);
		}
	});
	for (const phase of ["fetch", "body"]) {
		await check(`JJO-663 8s deadline includes hung ${phase} and retry 0`, async () => {
			let calls = 0;
			let signal: AbortSignal | null = null;
			const started = performance.now();
			const got = await semanticCore.askSemanticAdvice(semanticInput, semanticEnv, async (_url: string, init: RequestInit) => {
				calls++; signal = init.signal!;
				return phase === "fetch" ? new Promise<Response>(() => {}) : new Response(new ReadableStream({ start() {} }));
			});
			const elapsed = performance.now() - started;
			assert.deepEqual(got, { status: "no_decision", reason: "timeout", outbound: true });
			assert.equal(calls, 1); assert.equal(signal?.aborted, true);
			assert.ok(elapsed >= 7900 && elapsed < 10000, `8s wire deadline observed ${elapsed}ms`);
		});
	}
	await check("JJO-663 generated hook semantic advice never creates or suppresses a deterministic block", async () => {
		for (const mode of ["shadow", "deterministic"]) for (const choice of ["aligned", "drift", "uncertain", "transport_error", "precision_anomaly", "ui_error"]) {
			env({ ...semanticEnv, JEV_ALIGNMENT_MODE: mode });
			const statuses: string[] = [];
			responder = () => {
				if (choice === "transport_error") throw new Error("PRIVATE_PROVIDER_ERROR");
				return new Response(JSON.stringify(semanticAnswer(choice === "ui_error" ? "aligned" : choice === "precision_anomaly" ? "drift" : choice, 0.9, choice === "precision_anomaly" ? { aligned: 0.0001, drift: 0.9993, uncertain: 0.0007 } : { aligned: choice === "aligned" || choice === "ui_error" ? 1 : 0, drift: choice === "drift" ? 1 : 0, uncertain: choice === "uncertain" ? 1 : 0 })));
			};
			const ui = { setStatus(key: string, value: string) { if (choice === "ui_error") throw new Error("ui failed"); if (key === "jev-alignment-semantic") statuses.push(value); } };
			for (const forbidden of [false, true]) {
				const ctx = { ...alignmentContext([alignmentUser("semantic-hook", forbidden ? "Read only: do not modify any files." : "Implement `src/demo.ts`")]), ui };
				const before = fetchCalls;
				const got = await alignmentBefore[0].handler(alignmentWrite(`semantic-${forbidden}`, "src/other.ts"), ctx);
				assert.equal(got?.block === true, mode === "deterministic" && forbidden, `${mode}/${choice}/${forbidden}`);
				assert.equal(fetchCalls, before + 1);
				assert.ok(!alignmentEvents().events.some((event: any) => event.kind === "admit"), "semantic aligned does not admit an out-of-scope write");
			}
			for (const value of statuses) { const status = JSON.parse(value); assert.equal(status.model, "sionic-ai/jev-omni"); assert.ok(!value.includes("PRIVATE_")); }
		}
		responder = undefined;
		env();
		delete process.env.JEV_ALIGNMENT_MODE;
	});
	await check("JJO-663 opt-in never sends read/bash/off calls and reports unconfigured without outbound", async () => {
		env({ JEV_ALIGNMENT_SEND_AUTHORITY_TEXT: "true", JEV_ALIGNMENT_MODE: "off" });
		const statuses: string[] = [];
		const ctx = { ...alignmentContext(semanticInput.branchEntries), ui: { setStatus(key: string, value: string) { if (key === "jev-alignment-semantic") statuses.push(value); } } };
		const before = fetchCalls;
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("off", "src/demo.ts"), ctx), undefined);
		process.env.JEV_ALIGNMENT_MODE = "deterministic";
		for (const toolName of ["read", "bash"]) assert.equal(await alignmentBefore[0].handler({ type: "tool_call", toolName, input: { path: "src/demo.ts" } }, ctx), undefined);
		assert.deepEqual(statuses, []);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("unconfigured", "src/demo.ts"), ctx), undefined);
		assert.equal(JSON.parse(statuses[0]).reason, "unconfigured");
		assert.equal(fetchCalls, before);
		env(); delete process.env.JEV_ALIGNMENT_MODE;
	});
	await check("JJO-663 generated hook rejects incomplete action targets before outbound", async () => {
		env({ ...semanticEnv, JEV_ALIGNMENT_MODE: "deterministic" });
		const paths = Array.from({ length: 17 }, (_, i) => `src/file-${i}.ts`);
		const inputs = [
			{ files: paths },
			{ patch: paths.map(value => `*** Update File: ${value}`).join("\n") },
			{ files: ["src/demo.ts", "https://invalid/"] },
			{ files: ["src/demo.ts", null] },
			{ path: "src/demo.ts", patch: "line\n".repeat(401) },
			{ patch: "*** Update File: src/demo.ts\n*** Move to: src/renamed.ts" },
			{ patch: "diff --git a/src/old.ts b/src/renamed.ts" },
		];
		const before = fetchCalls;
		for (const input of inputs) for (const forbidden of [false, true]) {
			const statuses: string[] = [];
			const ctx = { ...alignmentContext([alignmentUser("incomplete-targets", forbidden ? "Read only: do not modify any files." : "Implement `src/demo.ts`.")]), ui: { setStatus(key: string, value: string) { if (key === "jev-alignment-semantic") statuses.push(value); } } };
			const got = await alignmentBefore[0].handler({ type: "tool_call", toolName: "apply_patch", toolCallId: "incomplete-targets", input }, ctx);
			assert.equal(got?.block === true, forbidden, "semantic rejection cannot change the deterministic verdict");
			assert.deepEqual(JSON.parse(statuses[0]), { model: "sionic-ai/jev-omni", status: "no_decision", reason: "invalid_input" });
			assert.equal(fetchCalls, before, "no incomplete target list leaves the hook");
		}
		responder = () => new Response(JSON.stringify(semanticAnswer()));
		const ctx = alignmentContext([alignmentUser("complete-targets", "Implement `src/demo.ts`.")]);
		await alignmentBefore[0].handler({ type: "tool_call", toolName: "apply_patch", toolCallId: "complete-targets", input: { files: paths.slice(0, 16) } }, ctx);
		assert.equal(fetchCalls, before + 1, "the complete 16-target boundary still reaches the transport");
		responder = undefined;
		env(); delete process.env.JEV_ALIGNMENT_MODE;
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

	await check("S07-D criterion_file binds an explicit satisfied boolean", async () => {
		env();
		const target = path.join(process.env.HOME!, "artifact", "criterion.json");
		const ctx = alignmentContext([alignmentUser("entry-critfile", "Create `" + target + "` with criterion=criterion_file:" + target)]);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-critfile", target), ctx), undefined);
		mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
		writeFileSync(target, JSON.stringify({ satisfied: false }), { mode: 0o600 });
		assert.equal(await alignmentAfter[0].handler(alignmentResult("call-critfile", target), ctx), undefined);
		let last = alignmentEvents().events.at(-1).state;
		assert.deepEqual([last.status, last.step], ["result_observed", 3], "satisfied:false must not complete");
		// A fresh session where the criterion file is absent at correction time and
		// satisfied:true is observed afterwards must complete the chain.
		rmSync(target, { force: true });
		env();
		const ctxTrue = alignmentContext([alignmentUser("entry-critfile-true", "Create `" + target + "` with criterion=criterion_file:" + target)]);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-critfile-true", target), ctxTrue), undefined);
		writeFileSync(target, JSON.stringify({ satisfied: true }), { mode: 0o600 });
		assert.equal(await alignmentAfter[0].handler(alignmentResult("call-critfile-true", target), ctxTrue), undefined);
		last = alignmentEvents().events.at(-1).state;
		assert.deepEqual([last.status, last.step], ["recovered", 4], "the false->true transition completes the chain");
		env();
		const big = path.join(process.env.HOME!, "artifact", "big.json");
		const ctx2 = alignmentContext([alignmentUser("entry-critfile-big", "Create `" + big + "` with criterion=criterion_file:" + big)]);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-critfile-big", big), ctx2), undefined);
		mkdirSync(path.dirname(big), { recursive: true, mode: 0o700 });
		writeFileSync(big, "x".repeat(5000), { mode: 0o600 });
		assert.equal(await alignmentAfter[0].handler(alignmentResult("call-critfile-big", big), ctx2), undefined);
		last = alignmentEvents().events.at(-1).state;
		assert.notEqual(last.status, "recovered", "an oversized criterion file never completes");
	});

	await check("truncated authority never claims alignment, never blocks and reports the gap", async () => {
		env();
		// The requested target sits inside the scanned window while older entries
		// stay unscanned, so the truncation guard alone stands between this write
		// and a stage-2 admission. Dropping that guard flips the verdict below.
		const entries = [
			...Array.from({ length: 13 }, (_, index) => alignmentUser("entry-filler-" + index, "continue")),
			alignmentUser("entry-scope", "Implement `src/demo.ts`"),
		];
		const truncated = alignmentCore.collectAuthority(entries, { windowSize: 12 });
		assert.equal(truncated.authorityTruncated, true, "a 14-entry tail over a 12-entry window is truncated");
		assert.equal(truncated.constraints.length, 0);
		assert.ok(truncated.scopeDigests.includes(alignmentCore.digestTarget("src/demo.ts")), "the scanned window still names the target");
		const evaluation = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority: truncated });
		assert.equal(evaluation.verdict, "uncertain", "truncated authority never yields aligned");
		assert.equal(evaluation.block, false, "truncated authority never blocks");
		assert.equal(evaluation.stage2Admissible, false, "truncated authority never admits a write");
		assert.equal(evaluation.coverage, "coverage_gap", "a partially read authority is a coverage gap, matching ADR 0002");
		const narrow = alignmentCore.collectAuthority([alignmentUser("entry-only", "Implement `src/demo.ts`")], { windowSize: 12 });
		assert.equal(narrow.authorityTruncated, false, "a single entry is complete authority");
		assert.ok(narrow.scopeDigests.includes(alignmentCore.digestTarget("src/demo.ts")), "the narrow authority still scopes the write");
		const admitted = alignmentCore.evaluateAction({ actionClass: "write", targetDigest: alignmentCore.digestTarget("src/demo.ts"), authority: narrow });
		assert.deepEqual(
			[admitted.ruleId, admitted.verdict, admitted.coverage, admitted.stage2Admissible],
			["aligned_write_within_requested_scope", "aligned", "evaluated", true],
			"the same target is admitted once the authority is complete",
		);
	});

	await check("N1 a hung journal store is bounded and degrades every read and append", async () => {
		env();
		const ctx = alignmentContext([]);
		const now = Date.now();
		// Failure induction: an injected store that never settles. Without the
		// deadline in the store this case would never resolve.
		const hungIo = {
			readFile: () => new Promise(() => {}),
			appendFile: () => new Promise(() => {}),
			writeFile: () => new Promise(() => {}),
			mkdir: () => new Promise(() => {}),
		} as any;
		const startedAt = Date.now();
		const loaded = await alignmentJournalCore.loadJournalStore(ctx, now, 30, hungIo);
		assert.equal(loaded.available, false, "a bounded-out read is degraded storage");
		assert.equal(loaded.snapshot.latest, null, "a bounded-out read never invents a recovery state");
		const stored = await alignmentJournalCore.appendJournalStore(ctx, [alignmentCore.recordHookError({ errorClass: "hung", now })], now, 30, hungIo);
		assert.equal(stored, false, "a bounded-out append is not stored");
		const elapsed = Date.now() - startedAt;
		assert.ok(elapsed < 1000, `both store calls must be bounded (took ${elapsed}ms)`);
		// Positive control: the same seam with the production I/O still persists.
		const appended = await alignmentJournalCore.appendJournalStore(ctx, [alignmentCore.recordHookError({ errorClass: "probe", now })], now, 500);
		assert.equal(appended, true, "the default I/O is the real store");
		const reread = await alignmentJournalCore.loadJournalStore(ctx, now, 500);
		assert.equal(reread.available, true);
		assert.equal(reread.snapshot.events.at(-1).kind, "hook_error", "the shared store round-trips a record");
	});

	await check("N1b every surface journal await is one bounded store call with the shared budget", () => {
		for (const name of ["src/alignment.adapter.ts", "src/alignment-observe.adapter.ts", "src/alignment-shutdown.adapter.ts"]) {
			const text = readFileSync(path.join(plugin, name), "utf8");
			assert.ok(text.includes("journalStoreBudgetMs()"), `${name} resolves the store budget per call`);
			const calls = text.split("\n").filter(line => /(?:load|append)JournalStore\(/.test(line));
			// The before-tool and shutdown surfaces each carry one more bounded append: the opt-in
			// bash bridge's bash_coverage record (JJO-2327).
			const expected = name === "src/alignment-observe.adapter.ts" ? 3 : 4;
			assert.equal(calls.length, expected, `${name} has one bounded read and ${expected - 1} bounded appends`);
			for (const call of calls) assert.match(call.trim(), /storeBudgetMs\);$/, `${name} passes the bounded budget: ${call.trim()}`);
		}
	});

	await check("N2 the three alignment surfaces share one journal store with no private plumbing", () => {
		const retired = ["alignmentAppendEvents", "alignmentLoadJournal", "alignmentJournalFiles", "alignmentReadText", "alignmentSessionKey"];
		for (const name of ["src/alignment.adapter.ts", "src/alignment-observe.adapter.ts", "src/alignment-shutdown.adapter.ts"]) {
			const text = readFileSync(path.join(plugin, name), "utf8");
			assert.ok(text.includes('from "../lib/alignment-journal"'), `${name} imports the shared journal store`);
			for (const copy of retired) assert.ok(!text.includes(`function ${copy}(`), `${name} keeps no local ${copy} copy`);
			assert.ok(!/await (?:readFile|appendFile|writeFile|mkdir)\(/.test(text), `${name} performs no unbounded journal await`);
		}
		const shared = ["journalSessionKey", "journalFiles", "journalReadText", "loadJournalStore", "appendJournalStore"];
		for (const name of ["hooks/jev-advisor-alignment.ts", "hooks/jev-advisor-alignment-observe.ts", "hooks/jev-advisor-alignment-shutdown.ts"]) {
			const text = readFileSync(path.join(plugin, name), "utf8");
			for (const fn of shared) assert.equal(text.split(`function ${fn}(`).length - 1, 1, `${name} carries exactly one ${fn} definition`);
		}
	});

	await check("N3 a hung journal append degrades instead of delaying the verdict", async () => {
		const fast = await alignmentCore.withDeadline(Promise.resolve("stored"), 50, "timeout");
		assert.equal(fast, "stored", "a completing append wins");
		const startedAt = Date.now();
		const hung = await alignmentCore.withDeadline(new Promise<string>(() => {}), 30, "timeout");
		const elapsed = Date.now() - startedAt;
		assert.equal(hung, "timeout", "a hung append resolves to the fallback");
		assert.ok(elapsed < 1000, `the deadline must actually bound the wait (took ${elapsed}ms)`);
	});

	await check("the observe surface records hook_error when its input throws", async () => {
		env();
		const entries = [alignmentUser("entry-observe-throw", "Create `src/demo.ts` with criterion=artifact_exists:src/demo.ts")];
		const ctx = alignmentContext(entries);
		assert.equal(await alignmentBefore[0].handler(alignmentWrite("call-observe-throw", "src/demo.ts"), ctx), undefined);
		const before = alignmentEvents().events.filter((event: any) => event.kind === "hook_error").length;
		const revoked = Proxy.revocable({}, {});
		revoked.revoke();
		assert.equal(await alignmentAfter[0].handler(revoked.proxy, ctx), undefined, "the observe surface stays fail-open");
		const after = alignmentEvents().events.filter((event: any) => event.kind === "hook_error").length;
		assert.equal(after, before + 1, "the thrown observe input is journaled as hook_error");
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

	await check("V-E2E 18 over-budget evaluation allows the write and records latency_exceeded", async () => {
		await withAlignmentMode("deterministic", async () => {
			env();
			process.env.JEV_ALIGNMENT_LATENCY_BUDGET_MS = "-1";
			try {
				const ctx = alignmentContext([alignmentUser("entry-latency", "This is read-only; do not modify anything.")]);
				const output = await alignmentBefore[0].handler(alignmentWrite("call-latency", "src/demo.ts"), ctx);
				assert.equal(output, undefined, "an over-budget evaluation must not block");
				const events = alignmentEvents();
				assert.ok(events.events.some((event: any) => event.kind === "block"), "the violation was still evaluated");
				assert.ok(events.events.some((event: any) => event.kind === "latency_exceeded"), "the overrun is recorded");
				const record = alignmentCore.recordLatencyExceeded({ elapsedMs: 1, budgetMs: -1, now: Date.now() });
				const roundTrip = alignmentCore.readJournalTexts([`${alignmentCore.serializeEvent(record)}\n`], Date.now());
				assert.deepEqual(roundTrip.events.map((event: any) => event.kind), ["latency_exceeded"], "the production reader accepts latency_exceeded");
			} finally {
				delete process.env.JEV_ALIGNMENT_LATENCY_BUDGET_MS;
			}
		});
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
			assert.ok(String(output.reason).includes("[storage_degraded]"), "a degraded store is named in the reason instead of being silent");
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
		const metricsTool = metricsModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } });
		const sourceMetricsTool = sourceMetricsModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } });
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
		assert.deepEqual(result.limitations.slice(18), ["source_missing", "telemetry_source_missing", "telemetry_usage_only_when_provider_reports_it", "telemetry_join_limited_by_independent_retention", "report_scope_vs_record_scope"]);
		assert.equal(result.telemetry.status, "missing"); assert.equal(result.telemetry.metrics, null);
		assert.equal(result.jevLock, undefined);
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
			const tool = module.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } });
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
				const tool = module.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } });
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
			const tool = module.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } });
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
		const metricsTool = metricsModule.default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } });
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
	// ---- JJO-2327: layered configuration, check telemetry, advisory checkpoints ----
	// The canary is assembled at runtime so no key-shaped literal ever exists in the repository.
	const runtimeCanary = ["sk", "or", "v1"].join("-") + "-" + (await import("node:crypto")).randomBytes(24).toString("hex");
	const sharedLayer = (values: Record<string, string>, reads = { count: 0 }) => (names: readonly string[]) => {
		reads.count++;
		return { status: "read" as const, env: Object.fromEntries(names.filter(name => values[name]).map(name => [name, values[name]])) };
	};
	await check("JJO-2327 config: layer first, explicit key first within a layer, shared credentials read lazily", () => {
		const reads = { count: 0 };
		let c = core.readConfig({ OPENROUTER_API_KEY: "l1-provider" }, {}, {}, sharedLayer({ JEV_ADVISOR_API_KEY: "l4-explicit" }, reads));
		assert.equal(c.apiKey, "l1-provider", "an L4 explicit key never beats an L1 provider key");
		assert.equal(c.credentialSource, "env");
		assert.equal(reads.count, 0, "the shared file is not opened when an upper layer has a credential");
		c = core.readConfig({ OPENROUTER_API_KEY: "l1-provider", JEV_ADVISOR_API_KEY: "l1-explicit" }, {}, {}, sharedLayer({}, reads));
		assert.equal(c.apiKey, "l1-explicit", "within one layer the explicit key comes first");
		c = core.readConfig({}, { OPENROUTER_API_KEY: "l2" }, {}, sharedLayer({ OPENROUTER_API_KEY: "l4" }, reads));
		assert.deepEqual([c.apiKey, c.credentialSource, reads.count], ["l2", "plugin_file", 0]);
		c = core.readConfig({}, {}, {}, sharedLayer({ OPENROUTER_API_KEY: "l4" }, reads));
		assert.deepEqual([c.apiKey, c.credentialSource, core.isConfigured(c), reads.count], ["l4", "shared_env", true, 1], "a broker-like empty env resolves the shared credential");
		c = core.readConfig({ JEV_ADVISOR_PROVIDER: "typesafe-jev" }, {}, {}, sharedLayer({ OPENROUTER_API_KEY: "wrong-provider" }));
		assert.deepEqual([c.apiKey, c.credentialSource, core.isConfigured(c)], ["", "none", false], "a provider never borrows another provider's key");
		c = core.readConfig({ JEV_ADVISOR_PROVIDER: "ollaya" }, {}, {}, sharedLayer({}, reads));
		assert.equal(c.credentialSource, "keyless");
		const settings = { JEV_ADVISOR_MODE: "hint", JEV_ADVISOR_MIN_CONFIDENCE: "0.8", JEV_ADVISOR_MIN_INTERVAL_MS: "0", OPENROUTER_API_KEY: runtimeCanary, JEV_ADVISOR_ENDPOINT: "https://evil.invalid" };
		c = core.readConfig({}, {}, settings, sharedLayer({}));
		assert.deepEqual([c.mode, c.minConfidence, c.minIntervalMs, c.apiKey, c.endpoint], ["hint", 0.8, 0, "", core.PROVIDERS.jev.endpoint], "settings.env supplies only allowlisted non-secret keys");
		c = core.readConfig({ JEV_ADVISOR_MODE: "shadow" }, { JEV_ADVISOR_MIN_CONFIDENCE: "0.7" }, settings, sharedLayer({}));
		assert.deepEqual([c.mode, c.minConfidence, c.minIntervalMs], ["shadow", 0.7, 0], "upper layers win per key");
		const described = core.describeEffectiveConfig({}, {}, settings, sharedLayer({ OPENROUTER_API_KEY: runtimeCanary }), "read");
		assert.deepEqual(described, { provider: "jev", model: "typesafe/jev-1.14", mode: "hint", minConfidence: 0.8, minIntervalMs: 0, configured: true, credentialSource: "shared_env", sharedEnvStatus: "read", settingsStatus: "read", layersUsed: ["settings", "shared_env"], settingsIgnoredKeys: ["JEV_ADVISOR_ENDPOINT", "OPENROUTER_API_KEY"] });
		assert.equal(core.describeEffectiveConfig({}, {}, {}, sharedLayer({})).settingsStatus, "absent", "a missing tracked baseline is visible");
		assert.ok(!JSON.stringify(described).includes(runtimeCanary), "describe-config never carries a credential value");
	});
	await check("JJO-2327 shared credential file is read only when owner-only, regular and small, and only for allowlisted names", () => {
		const dir = path.join(root, "shared-env"); mkdirSync(dir, { recursive: true, mode: 0o700 });
		const file = path.join(dir, ".env");
		writeFileSync(file, `OTHER_SECRET=${runtimeCanary}\nOPENROUTER_API_KEY=${runtimeCanary}\n`, { mode: 0o600 });
		const names = core.sharedCredentialNames();
		assert.ok(names.includes("OPENROUTER_API_KEY") && names.includes("JEV_ADVISOR_API_KEY") && names.includes("TYPESAFE_API_KEY") && !names.includes("OTHER_SECRET"));
		const read = core.readSharedCredentials(names, file);
		assert.equal(read.status, "read"); assert.deepEqual(Object.keys(read.env), ["OPENROUTER_API_KEY"]);
		fs.chmodSync(file, 0o644);
		assert.deepEqual(core.readSharedCredentials(names, file), { status: "unsafe", env: {} }, "group/other-readable SOT is skipped");
		fs.chmodSync(file, 0o600);
		const link = path.join(dir, "link.env"); symlinkSync(file, link);
		assert.deepEqual(core.readSharedCredentials(names, link), { status: "unsafe", env: {} }, "a symlinked SOT is skipped");
		const big = path.join(dir, "big.env"); writeFileSync(big, "X=" + "y".repeat(17 * 1024), { mode: 0o600 });
		assert.equal(core.readSharedCredentials(names, big).status, "unsafe");
		assert.equal(core.readSharedCredentials(names, path.join(dir, "absent.env")).status, "absent");
		// A FIFO without a writer must be refused without blocking (Codex review, PR #65).
		const fifo = path.join(dir, "fifo.env");
		assert.equal(spawnSync("mkfifo", ["-m", "600", fifo]).status, 0);
		const started = performance.now();
		assert.deepEqual(core.readSharedCredentials(names, fifo), { status: "unsafe", env: {} });
		assert.ok(performance.now() - started < 1000, "a writer-less FIFO never blocks the read");
		const describedFifo = core.describeEffectiveConfig({}, {}, {}, (list: readonly string[]) => core.readSharedCredentials(list, fifo));
		assert.deepEqual([describedFifo.configured, describedFifo.sharedEnvStatus], [false, "unsafe"]);
	});
	const metricsSurface = () => (async () => (await import(pathToFileURL(path.join(plugin, "tools/plugin-metrics.ts")).href)).default({ typebox: { Type: { Object: (x: any) => x, String: (x: any) => x, Optional: (x: any) => x, Array: (x: any) => x } } }))();
	await check("JJO-2327 jev_check journals a released-decoder-compatible record plus a joined jev-telemetry record", async () => {
		env({ JEV_ADVISOR_PROVIDER: "jev" });
		const ctx = { sessionManager: { getSessionId: () => "session-telemetry" } };
		responder = () => new Response(JSON.stringify({ answers: { check: { type: "choice", choice: "correct", confidence: 0.9 } }, usage: { prompt_tokens: 1200, completion_tokens: 3, total_tokens: 1203, cost: 0.0000504 } }));
		const first = JSON.parse(text(await checkTool.execute("tele-1", { question: "Is it done?", artifact: "done" }, undefined, ctx)));
		assert.equal(first.status, "decision");
		assert.deepEqual([first.journalStorage.persisted, first.telemetryStorage.persisted, first.credentialSource], [true, true, "env"]);
		assert.deepEqual(first.usage, { promptTokens: 1200, completionTokens: 3, totalTokens: 1203, costMicroUsd: 50 });
		assert.ok(Number.isInteger(first.durationMs));
		responder = () => systemCheck();
		const second = JSON.parse(text(await checkTool.execute("tele-2", { question: "Is it done?", artifact: "done" })));
		assert.equal(second.usage, undefined, "no provider usage means no usage field, never zero");
		responder = () => new Response("private", { status: 503 });
		const third = JSON.parse(text(await checkTool.execute("tele-3", { question: "Is it done?", artifact: "done" })));
		assert.deepEqual([third.status, third.reason, third.httpStatus], ["no_decision", "provider_error", 503]);
		responder = undefined;
		const legacy = journalRecords().filter((record: any) => record.operation === "check");
		assert.equal(legacy.length, 3);
		for (const record of legacy) {
			assert.ok(Object.keys(record.check).every(key => ["status", "verdict", "confidence", "confidenceKind", "probabilities", "reason"].includes(key)), "legacy namespace keeps the released check shape");
			assert.ok(Number.isInteger(record.durationMs));
		}
		assert.equal(legacy[0].toolCallDigest, createHash("sha256").update("tele-1").digest("hex"));
		const tele = await sharedResults.readPluginOutcomeSnapshot("jev-telemetry");
		assert.equal(tele.status, "ok"); assert.equal(tele.records.length, 3);
		assert.deepEqual(tele.records.map((record: any) => record.toolCallDigest), legacy.map((record: any) => record.toolCallDigest), "telemetry joins by toolCallDigest");
		assert.deepEqual(tele.records[0].check, { status: "decision", verdict: "correct", confidence: 0.9, confidenceKind: "provider_choice", provider: "jev", model: "typesafe/jev-1.14", sessionKey: createHash("sha256").update("session-telemetry").digest("hex").slice(0, 16), usage: { promptTokens: 1200, completionTokens: 3, totalTokens: 1203, costMicroUsd: 50 } });
		assert.equal(tele.records[1].check.usage, undefined);
		assert.deepEqual([tele.records[2].check.httpStatus, tele.records[2].check.reason], [503, "provider_error"]);
		const metrics = JSON.parse(text(await (await metricsSurface()).execute("tele-metrics", {})));
		assert.equal(metrics.telemetry.status, "ok");
		assert.deepEqual({ records: metrics.telemetry.metrics.records, joined: metrics.telemetry.metrics.joined, unjoined: metrics.telemetry.metrics.unjoined, byProvider: metrics.telemetry.metrics.byProvider, byHttpStatus: metrics.telemetry.metrics.byHttpStatus, sessions: metrics.telemetry.metrics.sessions, measured: metrics.telemetry.metrics.latencyMs.measured }, { records: 3, joined: 3, unjoined: 0, byProvider: { jev: 3 }, byHttpStatus: { 503: 1 }, sessions: { distinct: 1, truncated: false }, measured: 3 });
		assert.deepEqual(metrics.telemetry.metrics.usage, { records: 1, measured: 1, promptTokens: 1200, completionTokens: 3, totalTokens: 1203, costMicroUsd: 50 });
		assert.equal(metrics.telemetry.metrics.sessions.truncated, false);
		assert.ok(!metrics.limitations.includes("telemetry_source_missing") && !metrics.limitations.includes("telemetry_source_unavailable"));
		assert.deepEqual(core.aggregateTelemetryMetrics([{ operation: "check", toolCallDigest: "a".repeat(64), durationMs: 1, check: { status: "decision", provider: "jev" } }], null).usage, { records: 0, measured: 0, promptTokens: null, completionTokens: null, totalTokens: null, costMicroUsd: null }, "no reported usage keeps sums null, never zero");
		assert.deepEqual([core.aggregateTelemetryMetrics([], null).joined, core.aggregateTelemetryMetrics([], null).unjoined], [null, null], "an unreadable legacy journal makes the join unknown");
		assert.ok(!JSON.stringify([first, second, third, metrics]).includes("synthetic-key"));
	});
	await check("JJO-2327 a telemetry storage failure never fails the check or its legacy record", async () => {
		env({ JEV_ADVISOR_PROVIDER: "jev" });
		mkdirSync(path.join(process.env.HOME!, ".gjc-plugin"), { recursive: true, mode: 0o700 });
		writeFileSync(path.join(process.env.HOME!, ".gjc-plugin", "jev-telemetry"), "not a directory", { mode: 0o600 });
		responder = () => systemCheck();
		const out = JSON.parse(text(await checkTool.execute("tele-fail", { question: "q?", artifact: "a" })));
		responder = undefined;
		assert.equal(out.status, "decision");
		assert.equal(out.journalStorage.persisted, true);
		assert.equal(out.telemetryStorage.persisted, false);
		assert.equal(journalRecords().length, 1);
		const metrics = JSON.parse(text(await (await metricsSurface()).execute("tele-fail-metrics", {})));
		assert.equal(metrics.telemetry.status, "unavailable");
		assert.ok(metrics.limitations.includes("telemetry_source_unavailable"), "a telemetry-only failure is a named limitation");
	});
	const sessionStartModule = await import(pathToFileURL(path.join(plugin, "hooks/jev-advisor-session-start.ts")).href);
	const healthHook = (warnings: string[] = []) => { let handler: any; sessionStartModule.default({ on: (event: string, fn: any) => { assert.equal(event, "session_start"); handler = fn; }, logger: { warn: (message: string) => warnings.push(message) } }); return handler; };
	const healthRun = async (ui: any = {}) => { const notices: string[] = []; const ctx = { ui: { notify: (message: string) => notices.push(message), ...ui } }; const before = fetchCalls; const value = await healthHook()({ type: "session_start" }, ctx); assert.equal(value, undefined); assert.equal(fetchCalls, before, "the health line never calls a provider"); return notices; };
	await check("JJO-2327 session_start health line is silent when healthy and names the cause otherwise", async () => {
		try {
			env();
			assert.deepEqual(await healthRun(), [], "configured with an empty journal: silent");
			delete process.env.JEV_ADVISOR_API_KEY;
			const unconfigured = await healthRun();
			assert.equal(unconfigured.length, 1);
			assert.match(unconfigured[0], /^jev-advisor health: unconfigured \(jev credential missing: JEV_ADVISOR_API_KEY\|OPENROUTER_API_KEY; shared \.env absent\)$/);
			assert.ok(core.describeEffectiveConfig().configured === false, "the boundary is gated on describe-config");
			env();
			for (let index = 0; index < 5; index++) assert.equal((await appendPluginOutcome("jev-advisor", { operation: "check", toolCallDigest: "f".repeat(64), check: { status: "no_decision", reason: "unconfigured" } })).persisted, true);
			assert.deepEqual(await healthRun(), ["jev-advisor health: recent jev_check no_decision 5/5 (unconfigured 5)"]);
			const lock = path.join(process.env.HOME!, ".gjc-plugin", "jev-advisor", "journal", "v1", ".append.lock");
			writeFileSync(lock, "", { mode: 0o600 });
			const old = new Date(Date.now() - 3_600_000); fs.utimesSync(lock, old, old);
			const busy = await healthRun();
			assert.equal(busy.length, 1); assert.match(busy[0], /journal store_busy \(lockAgeMs=\d+, owner=unknown\)/);
			assert.ok(existsSync(lock), "the health line never reclaims a lock");
			const metricsBusy = JSON.parse(text(await (await metricsSurface()).execute("busy-metrics", {})));
			assert.deepEqual(metricsBusy.jevLock, { ageMs: metricsBusy.jevLock.ageMs, owner: "unknown" }, "plugin_metrics reports the held jev lock");
			const guard = path.join(process.env.HOME!, ".gjc-plugin", "jev-advisor", "journal", ".append.reclaim.lock");
			writeFileSync(guard, JSON.stringify({ v: 1, pid: 2_147_483_000, host: os.hostname(), createdAt: 0, nonce: "00000000-0000-4000-8000-000000000000" }), { mode: 0o600 });
			const blocked = await healthRun();
			assert.equal(blocked.length, 1); assert.match(blocked[0], /^jev-advisor health: reclaim_blocked \(lockAgeMs=\d+, owner=unknown, guardAgeMs=\d+, guardOwner=dead\)$/);
			rmSync(lock);
			const guardOnly = await healthRun();
			assert.equal(guardOnly.length, 1); assert.match(guardOnly[0], /reclaim guard left \(guardAgeMs=\d+, guardOwner=dead\)/);
			rmSync(guard);
			writeFileSync(lock, JSON.stringify({ v: 1, pid: process.pid, host: os.hostname(), createdAt: Date.now(), nonce: "00000000-0000-4000-8000-000000000000" }), { mode: 0o600 });
			assert.deepEqual(await healthRun(), [], "a young lock held by a live owner is ordinary contention: silent");
			rmSync(lock);
			const inventory = path.join(process.env.HOME!, ".gjc-plugin", "jev-advisor", "journal", "v1", "inventory.json");
			const savedInventory = readFileSync(inventory);
			writeFileSync(inventory, "{not json", { mode: 0o600 });
			assert.deepEqual(await healthRun(), ["jev-advisor health: journal store_corrupt"]);
			writeFileSync(inventory, savedInventory, { mode: 0o600 });
			writeFileSync(lock, "", { mode: 0o600 });
			fs.utimesSync(lock, old, old);
			process.env.JEV_HEALTH_LINE = "off";
			assert.deepEqual(await healthRun(), []);
			process.env.JEV_HEALTH_LINE = "stderr";
			const written: string[] = []; const original = process.stderr.write.bind(process.stderr);
			(process.stderr as any).write = (chunk: any) => { written.push(String(chunk)); return true; };
			try { assert.deepEqual(await healthRun(), []); } finally { (process.stderr as any).write = original; }
			assert.equal(written.length, 1); assert.match(written[0], /^jev-advisor health: journal store_busy/);
			process.env.JEV_HEALTH_LINE = "notify";
			const warnings: string[] = [];
			assert.equal(await healthHook(warnings)({ type: "session_start" }, { ui: { notify() { throw new Error("ui broke"); } } }), undefined, "a failing UI never blocks the session");
			assert.equal(warnings.length, 1);
		} finally { delete process.env.JEV_HEALTH_LINE; }
	});
	await check("JJO-2327 alignment authority status is one line per identity and changes no verdict", async () => {
		env();
		process.env.JEV_ALIGNMENT_MODE = "deterministic";
		try {
			const statuses: [string, string][] = [];
			const ui = { notify() {}, setWidget() {}, setStatus(key: string, value: string) { statuses.push([key, value]); } };
			const entries = [alignmentUser("authority-1", "PRIVATE_AUTHORITY_CANARY Read only: do not modify any files.")];
			const ctx = { sessionManager: { getBranch: () => entries, getSessionId: () => "authority-session" }, ui };
			const a = await alignmentBefore[0].handler(alignmentWrite("authority-a", "src/demo.ts"), ctx);
			const b = await alignmentBefore[0].handler(alignmentWrite("authority-b", "src/demo.ts"), ctx);
			assert.equal(a?.block, true); assert.equal(b?.block, true, "the deterministic verdict is unchanged");
			const authority = statuses.filter(([key]) => key === "jev-alignment-authority");
			assert.equal(authority.length, 1, "the same authority publishes once");
			assert.match(authority[0][1], /^jev alignment authority: entry [a-f0-9]{8} constraints=read_only targets=0 criterion=none release=/);
			assert.ok(!authority[0][1].includes("PRIVATE_AUTHORITY_CANARY"), "no user text in the status");
			entries.push(alignmentUser("authority-2", "Implement `src/demo.ts`."));
			await alignmentBefore[0].handler(alignmentWrite("authority-c", "src/demo.ts"), ctx);
			assert.equal(statuses.filter(([key]) => key === "jev-alignment-authority").length, 2, "a new identity publishes again");
		} finally { delete process.env.JEV_ALIGNMENT_MODE; }
	});
	await check("JJO-2327 destructive-bash bridge: off changes nothing; on notices at most three times and counts coverage", async () => {
		assert.deepEqual(alignmentCore.detectDestructiveBash("rm -rf build"), ["rm_recursive_force"]);
		for (const command of ["rm -fr x", "rm -r -f x", "rm --recursive --force x", "git push --force origin x", "git push -f origin x", "git push origin +main", "git branch -D topic", "git push origin --delete topic", "git worktree remove ../lane", "git reset --hard HEAD~1", "git clean -fdx", "npm run migrate:down", "lane-finish --self"]) assert.ok(alignmentCore.detectDestructiveBash(command).length > 0, command);
		for (const command of ["rm file.txt", "git push origin main", "git branch -a", "git status", "grep -rf patterns src", "git worktree list", "bun test"]) assert.deepEqual(alignmentCore.detectDestructiveBash(command), [], command);
		const bash = (id: string, command: string) => ({ type: "tool_call", toolName: "bash", toolCallId: id, input: { command } });
		const run = async (bridge: string | undefined, alignmentModeValue: string | undefined) => {
			env();
			if (bridge === undefined) delete process.env.JEV_BASH_BRIDGE; else process.env.JEV_BASH_BRIDGE = bridge;
			if (alignmentModeValue === undefined) delete process.env.JEV_ALIGNMENT_MODE; else process.env.JEV_ALIGNMENT_MODE = alignmentModeValue;
			const notices: string[] = [];
			const sessionId = `bridge-${bridge}-${alignmentModeValue}-${serial}`;
			const ctx = { sessionManager: { getBranch: () => [], getSessionId: () => sessionId }, ui: { notify: (message: string) => notices.push(message), setWidget() {}, setStatus() {} } };
			const results: unknown[] = [];
			for (let index = 0; index < 4; index++) results.push(await alignmentBefore[0].handler(bash(`bridge-${index}`, `rm -rf /tmp/${runtimeCanary}-${index}`), ctx));
			results.push(await alignmentBefore[0].handler(bash("bridge-benign", "ls -la"), ctx));
			await alignmentShutdownSurface[0].handler({ type: "session_shutdown" }, ctx);
			const key = createHash("sha256").update(sessionId, "utf8").digest("hex").slice(0, 32).slice(0, 16);
			const read = (name: string) => { try { return readFileSync(path.join(alignmentHome(key), name), "utf8"); } catch { return ""; } };
			const journalText = read("events.1.jsonl") + read("events.jsonl");
			return { results, notices, journalText, events: journalText.split("\n").filter(Boolean).map(line => JSON.parse(line)) };
		};
		try {
			const off = await run(undefined, "deterministic");
			assert.deepEqual(off.results, [undefined, undefined, undefined, undefined, undefined]);
			assert.deepEqual([off.notices, off.events], [[], []], "bridge off: no notice and no journal record");
			const on = await run("1", "deterministic");
			assert.deepEqual(on.results, [undefined, undefined, undefined, undefined, undefined], "the bridge never blocks");
			assert.equal(on.notices.length, 3, "at most three notices per session");
			assert.ok(on.notices.every(message => message.includes("rm_recursive_force") && message.includes("jev_check")));
			const coverage = on.events.filter((event: any) => event.kind === "bash_coverage").map((event: any) => event.bashCoverage);
			assert.deepEqual(coverage.at(-1), { bashCalls: 5, destructive: 4, notices: 3, patterns: { rm_recursive_force: 4 } }, "shutdown flushes the cumulative counts");
			assert.ok(!on.journalText.includes(runtimeCanary) && !on.notices.join("").includes(runtimeCanary), "command text never leaves the hook");
			const silenced = await run("1", "off");
			assert.deepEqual([silenced.notices, silenced.events], [[], []], "alignment off silences the bridge");
		} finally { delete process.env.JEV_BASH_BRIDGE; delete process.env.JEV_ALIGNMENT_MODE; }
	});
	console.log(JSON.stringify({ kind: "api-package-test-report", cases, failures, scriptedFetchCalls: fetchCalls, unexpectedFetches, realNetworkCalls: 0, generatedArtifactsCompared: 9 }));
	console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
	process.exitCode = failures || cases === 0 ? 1 : 0;
}

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function digest(bytes: string | Buffer): string {
	return createHash("sha256").update(bytes).digest("hex");
}

async function runInstalledRuntime() {
	const out = option("--out");
	assert.ok(out, "--runtime requires --out <new-receipt.json>");
	assert.ok(!existsSync(out), "refuse to overwrite runtime evidence");
	const pluginRoot = path.resolve(option("--plugin") ?? plugin);
	const sourceHookHash = digest(readFileSync(path.join(pluginRoot, "hooks/jev-advisor.ts")));
	const { spawn } = await import("node:child_process");
	const { createServer } = await import("node:http");
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "advisor-runtime-")));
	const results: any[] = [];
	const run = (args: string[], env: Record<string, string>, cwd: string) => new Promise<{ status: number; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn("gjc", args, { env, cwd });
		let stdout = "", stderr = "";
		const timer = setTimeout(() => child.kill("SIGTERM"), 45000);
		child.stdout.on("data", data => { stdout += data; });
		child.stderr.on("data", data => { stderr += data; });
		child.once("error", error => { clearTimeout(timer); reject(error); });
		child.once("close", status => { clearTimeout(timer); resolve({ status: status ?? -1, stdout, stderr }); });
	});
	try {
		for (const scenario of ["duplicates", "fifth-slot", "provider-failure"]) {
			const home = path.join(root, scenario, "home"), work = path.join(root, scenario, "work");
			const agent = path.join(home, ".gjc/agent");
			for (const dir of [home, work, agent]) mkdirSync(dir, { recursive: true, mode: 0o700 });
			let modelRequests = 0, adviceRequests = 0, unexpectedRequests = 0;
			const count = scenario === "fifth-slot" ? 5 : 4;
			const input: any = { agent: "executor", context: "Synthetic hook verification only.", tasks: Array.from({ length: count }, (_, index) => ({ id: `fixture-${index}`, description: "Bounded fixture", assignment: scenario === "provider-failure" && index >= 2 ? "Reply fixture B." : "Reply fixture A.", tier: "fast" })) };
			if (count > 4) input.spawnPlan = { whyParallel: "Hook admission fixture only", whyNotLocal: "Verify before-hook admission", independence: "No child launches are expected", expectedReceiptShape: "Independent child advice", maxInlineTokens: 100 };
			const server = createServer(async (req, res) => {
				try {
					let body = "";
					for await (const chunk of req) body += chunk;
					if (req.url === "/advice") {
						adviceRequests++;
						if (scenario === "provider-failure" && adviceRequests <= 2) { res.writeHead(500); res.end("fixture"); return; }
						res.writeHead(200, { "content-type": "application/json" });
						res.end(JSON.stringify({ answers: { tier: { choice: "strong", confidence: 0.99 } } })); return;
					}
					if (req.url === "/v1/models") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ data: [{ id: "gpt-4o", object: "model" }] })); return; }
					if (req.url !== "/v1/responses") { unexpectedRequests++; res.writeHead(404); res.end(); return; }
					modelRequests++;
					assert.ok(modelRequests <= 2, "unexpected model continuation or child launch");
					const first = modelRequests === 1;
					if (!first) assert.ok(body.includes("function_call_output"), "host did not return a tool result");
					const args = JSON.stringify(input);
					const item: any = first ? { id: "fc_fixture", type: "function_call", call_id: "fixture_task", status: "completed", name: "task", arguments: args } : { id: "msg_fixture", type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: "fixture complete" }] };
					res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
					const send = (type: string, fields: any) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
					const response = { id: "resp_fixture", object: "response", model: "gpt-4o", status: "in_progress", output: [] };
					send("response.created", { response });
					send("response.output_item.added", { output_index: 0, item: first ? { ...item, arguments: "" } : { ...item, content: [] } });
					if (first) {
						send("response.function_call_arguments.delta", { item_id: item.id, output_index: 0, delta: args });
						send("response.function_call_arguments.done", { item_id: item.id, output_index: 0, arguments: args });
					} else {
						send("response.output_text.delta", { item_id: item.id, output_index: 0, content_index: 0, delta: "fixture complete" });
						send("response.output_text.done", { item_id: item.id, output_index: 0, content_index: 0, text: "fixture complete" });
					}
					send("response.output_item.done", { output_index: 0, item });
					send("response.completed", { response: { ...response, status: "completed", output: [item] } }); res.end();
				} catch { unexpectedRequests++; if (!res.headersSent) res.writeHead(500); res.end(); }
			});
			await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
			const address = server.address() as { port: number };
			const origin = `http://127.0.0.1:${address.port}`;
			const env = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: root, GJC_CODING_AGENT_DIR: agent, GJC_AGENT_DIR: agent, GJC_MODEL_PRESET_REGISTRY_DISABLED: "1", JEV_ADVISOR_PROVIDER: "ollaya", JEV_ADVISOR_ENDPOINT: `${origin}/advice`, JEV_ADVISOR_MODE: "enforce", JEV_ADVISOR_MEMORY: "on", JEV_ADVISOR_MIN_INTERVAL_MS: "0", JEV_ALIGNMENT_MODE: "off", OPENAI_API_KEY: "local-fixture-not-a-real-credential", OPENAI_BASE_URL: `${origin}/v1`, NO_COLOR: "1", CI: "1" };
			try {
				const install = await run(["plugin", "install", pluginRoot, "--user", "--json"], env, work);
				assert.equal(install.status, 0, `isolated install failed: ${install.stderr}`);
				const installed = path.join(agent, "gjc-plugins/jev-advisor/hooks/jev-advisor.ts");
				assert.equal(digest(readFileSync(installed)), sourceHookHash, "installed hook is not the supplied artifact");
				const startedAt = Date.now();
				const session = await run(["--print", "--no-session", "--no-title", "--no-mcp", "--no-lsp", "--no-rules", "--no-pty", "--model", "openai/gpt-4o", "--thinking", "off", "--tools", "task", "Run the bounded synthetic task hook fixture. No actual children should launch."], env, work);
				assert.equal(session.status, 0, `fresh CLI failed: ${session.stderr}`);
				assert.equal(unexpectedRequests, 0);
				assert.equal(modelRequests, 2, "must observe tool call and final response through the real host");
				assert.equal(adviceRequests, scenario === "provider-failure" ? 3 : 1);
				const stateBytes = readFileSync(path.join(home, ".gjc-plugin/jev-advisor/state.v2.json"));
				const state = JSON.parse(stateBytes.toString());
				const children = (Object.values(state.groups).flatMap((g: any) => Object.values(g.tasks)) as any[]).sort((a, b) => a.ref.taskIndex - b.ref.taskIndex);
				assert.equal(children.length, count);
				assert.equal(new Set(children.map(r => r.requestToken)).size, count);
				assert.equal(new Set(children.map(r => r.ref.toolCallId)).size, 1);
				assert.ok(children.every(r => r.createdAt >= startedAt && r.jobKey === null && r.launchDisposition === "blocked"));
				const expected = scenario === "provider-failure" ? ["provider_error", "provider_error", "decision", "decision"] : Array.from({ length: count }, (_, index) => index === 4 ? "batch_limit" : "decision");
				const observed = children.map(r => r.advice.status === "decision" ? "decision" : r.advice.reason);
				assert.deepEqual(observed, expected);
				const journal = path.join(home, ".gjc-plugin/jev-advisor/journal/v1");
				const inventory = JSON.parse(readFileSync(path.join(journal, "inventory.json"), "utf8"));
				const records = inventory.segments.flatMap((segment: any) => readFileSync(path.join(journal, segment.name), "utf8").trimEnd().split("\n").map(line => JSON.parse(line)));
				const advice = records.filter((r: any) => r.operation === "task_advice");
				assert.equal(advice.length, 1);
				assert.equal(advice[0].taskAdvice.length, count);
				results.push({ scenario, startedAt, completedAt: Date.now(), sessionExit: session.status, modelRequests, adviceRequests, childCount: count, observed, stateSha256: digest(stateBytes), journalSha256: digest(JSON.stringify(records)), invocationDigest: advice[0].toolCallDigest, installedHookHash: sourceHookHash, hookBlocked: true, childLaunches: 0, passed: true });
			} finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
		}
		writeFileSync(out, JSON.stringify({ schema: "gjc.advisor.runtime.v1", sourceHookHash, cases: results, remoteRequests: 0, passed: results.length === 3, scope: "fresh isolated user installation and actual installed GJC task-hook; not delegation success or live-provider quality" }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
		console.log("ALL PASS (3 fresh installed GJC task-hook cases; zero child launches)");
	} finally { rmSync(root, { recursive: true, force: true }); }
}

async function runPerformance(root: string) {
	const baseline = option("--baseline");
	assert.ok(baseline, "--perf requires --baseline <unchanged-plugin-root>");
	const out = option("--out");
	assert.ok(out, "--perf requires --out <new-receipt.json>");
	assert.ok(!existsSync(out), "refuse to overwrite evidence");
	const samples = Number(option("--samples") ?? 30);
	assert.ok(samples === 30 || samples === 60, "only the declared 30-sample run or one 60-sample noise repeat is admitted");
	const roots = { baseline: path.resolve(baseline), candidate: plugin };
	const modules: Record<string, any> = {};
	const hashes: Record<string, string> = {};
	for (const [arm, dir] of Object.entries(roots)) {
		const file = path.join(dir, "hooks/jev-advisor.ts");
		hashes[arm] = digest(readFileSync(file));
		modules[arm] = await import(pathToFileURL(file).href);
	}
	assert.notEqual(hashes.baseline, hashes.candidate, "baseline and candidate must identify different generated hooks");
	const workloads = { singleton: ["A"], identical: ["A", "A", "A", "A"], pairs: ["A", "A", "B", "B"], distinct: ["A", "B", "C", "D"] };
	const rows: any[] = [];
	let serial = 0;
	const originalFetch = globalThis.fetch;
	try {
		for (const memory of ["on", "off"]) for (const [workload, assignments] of Object.entries(workloads)) {
			const measurements: Record<string, any[]> = { baseline: [], candidate: [] };
			for (let sample = -5; sample < samples; sample++) {
				const pair: Record<string, any> = {};
				for (const arm of sample % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"]) {
					const home = path.join(root, `perf-${++serial}`);
					mkdirSync(home, { mode: 0o700 });
					process.env.HOME = home;
					Object.assign(process.env, { JEV_ADVISOR_PROVIDER: "ollaya", JEV_ADVISOR_MODE: "hint", JEV_ADVISOR_MEMORY: memory, JEV_ADVISOR_MIN_INTERVAL_MS: "0" });
					let handler: any;
					modules[arm].default({ on: (_event: string, fn: any) => { handler = fn; } });
					let requests = 0, providerAwaitMs = 0;
					const bodies: string[] = [];
					globalThis.fetch = (async (_url: unknown, init: RequestInit) => {
						requests++; bodies.push(digest(String(init.body)));
						const start = performance.now();
						await new Promise(resolve => setTimeout(resolve, 40));
						providerAwaitMs += performance.now() - start;
						return new Response(JSON.stringify({ answers: { tier: { choice: "balanced", confidence: 0.9 } } }));
					}) as typeof fetch;
					const input = { agent: "executor", tasks: assignments.map((assignment, index) => ({ id: `fixture-${index}`, assignment, tier: "fast" })) };
					const start = performance.now();
					await handler({ type: "tool_call", toolName: "task", toolCallId: `perf-${serial}`, input }, { sessionManager: { getSessionId: () => "perf-session" } });
					const wallMs = performance.now() - start;
					const journal = path.join(home, ".gjc-plugin/jev-advisor/journal/v1");
					const inventory = JSON.parse(readFileSync(path.join(journal, "inventory.json"), "utf8"));
					const outcomes = inventory.segments.flatMap((segment: any) => readFileSync(path.join(journal, segment.name), "utf8").trimEnd().split("\n").map(line => JSON.parse(line)));
					const statuses = outcomes.find((r: any) => r.operation === "task_advice").taskAdvice;
					assert.equal(statuses.length, assignments.length);
					assert.ok(statuses.every((r: any) => r.status === "decision" && r.tier === "balanced"));
					assert.equal(requests, arm === "baseline" ? assignments.length : new Set(assignments).size);
					if (memory === "on") {
						const state = JSON.parse(readFileSync(path.join(home, ".gjc-plugin/jev-advisor/state.v2.json"), "utf8"));
						const children = Object.values(state.groups).flatMap((g: any) => Object.values(g.tasks)) as any[];
						assert.equal(children.length, assignments.length);
						assert.equal(new Set(children.map(r => r.requestToken)).size, assignments.length);
					}
					pair[arm] = { wallMs, providerAwaitMs, nonProviderMs: wallMs - providerAwaitMs, requests, bodyDigests: bodies };
					if (sample >= 0) measurements[arm].push(pair[arm]);
				}
				assert.deepEqual(pair.candidate.bodyDigests, [...new Set(pair.baseline.bodyDigests)], "only identical complete wire requests may be elided");
			}
			const quantile = (values: number[], fraction: number) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
			const stats = (arm: string) => ({ medianMs: quantile(measurements[arm].map(r => r.wallMs), 0.5), p95Ms: quantile(measurements[arm].map(r => r.wallMs), 0.95) });
			const before = stats("baseline"), after = stats("candidate");
			const medianReduction = 1 - after.medianMs / before.medianMs;
			const passed = workload === "identical" ? medianReduction >= 0.2 : workload === "singleton" || workload === "distinct" ? ["medianMs", "p95Ms"].every(key => (after as any)[key] - (before as any)[key] <= Math.max(5, (before as any)[key] * 0.1)) : true;
			rows.push({ memory, workload, samples, baseline: before, candidate: after, medianReduction, passed, measurements });
			console.log(`METRIC ${memory}_${workload}_baseline_median_ms=${before.medianMs}`);
			console.log(`METRIC ${memory}_${workload}_candidate_median_ms=${after.medianMs}`);
		}
	} finally { globalThis.fetch = originalFetch; }
	const report = { schema: "gjc.advisor.perf.v1", synthetic: true, delayMs: 40, warmups: 5, samples, hookHashes: hashes, remoteRequests: 0, passed: rows.every(r => r.passed), rows, limits: ["duplicate_prevalence_unknown", "not_provider_latency", "not_model_quality", "not_dollar_or_token_savings"] };
	writeFileSync(out, JSON.stringify(report, null, 2) + "\n", { flag: "wx", mode: 0o600 });
	assert.equal(report.passed, true, "paired performance criteria failed; inspect the receipt, do not ship as an improvement");
}

