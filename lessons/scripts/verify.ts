#!/usr/bin/env bun
/**
 * Deterministic acceptance for the lessons plugin.
 *
 * Every ledger root is a synthetic temp directory with a shim ledger CLI, so the
 * checks never read the owner's real wiki, never need Python and never touch the
 * network. The suite covers the four documented statuses, the bounds (limit,
 * byte budget, 4096-byte result, stdout cap, timeout), argv/env shaping without a
 * shell and the advisory session_start line.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(import.meta.url);
const plugin = path.resolve(path.dirname(script), "..");
const buildScript = path.join(plugin, "scripts", "build.mjs");
const toolFile = path.join(plugin, "tools", "lessons-select.ts");
const hookFile = path.join(plugin, "hooks", "lessons-start.ts");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lessons-verify-")));

for (const file of [toolFile, hookFile]) {
	if (existsSync(file)) continue;
	const built = spawnSync(process.execPath, [buildScript], { encoding: "utf8" });
	if (built.status !== 0) {
		console.error(`lessons verify: generated surfaces are missing and the build failed\n${built.stdout}${built.stderr}`);
		process.exit(1);
	}
}

const core = await import(pathToFileURL(path.join(plugin, "lib", "select.ts")).href);
const notice = await import(pathToFileURL(path.join(plugin, "lib", "notice.ts")).href);
const toolModule = await import(pathToFileURL(toolFile).href);
const hookModule = await import(pathToFileURL(hookFile).href);

const sandbox = path.join(root, "sandbox");
mkdirSync(sandbox, { recursive: true, mode: 0o700 });
const home = path.join(sandbox, "home");
mkdirSync(home, { recursive: true, mode: 0o700 });

let cases = 0;
let failures = 0;
const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
	cases++;
	try {
		await fn();
		console.log(`ok ${cases} ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
	}
};

function caseDir(name: string): string {
	const dir = path.join(root, "cases", name);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function ledgerRoot(name: string, options: { script?: boolean } = {}): string {
	const dir = path.join(caseDir(name), "wiki");
	mkdirSync(path.join(dir, "scripts"), { recursive: true, mode: 0o700 });
	if (options.script !== false) {
		writeFileSync(path.join(dir, "scripts", "lessons.py"), "# synthetic ledger CLI; only the interpreter shim runs\n", { mode: 0o600 });
	}
	return dir;
}

type Call = { argv: string[]; env: string[] };

// The shim stands in for python3: it records the argv and environment it was
// given, then behaves like the documented ledger CLI (or misbehaves on purpose).
function shim(name: string, body: string, options: { as?: string } = {}): { bin: string; log: string } {
	const dir = path.join(caseDir(name), "bin");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const log = path.join(dir, "calls.jsonl");
	const file = path.join(dir, options.as ?? "python3");
	const prelude = [
		'import { appendFileSync } from "node:fs";',
		`const log = ${JSON.stringify(log)};`,
		'appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).sort() }) + "\\n");',
	].join("\n");
	writeFileSync(file, `#!${process.execPath}\n${prelude}\n${body}\n`, { mode: 0o755 });
	chmodSync(file, 0o755);
	return { bin: file, log };
}

function calls(log: string): Call[] {
	if (!existsSync(log)) return [];
	return readFileSync(log, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as Call);
}

const lesson = (id: string, extra: Record<string, unknown> = {}) => ({
	id,
	scope: "project",
	confidence: 0.8,
	helpful: 2,
	harmful: 0,
	repos: ["/synthetic/repo"],
	trigger: `trigger ${id}`,
	action: `action ${id}`,
	text: `[${id}] scope=project ${"x".repeat(20)}`,
	...extra,
});

const payload = (lessons: unknown[], status = "ok") => JSON.stringify({ status, bytes: 0, lessons });
const emit = (text: string) => `process.stdout.write(${JSON.stringify(text)});`;

const deps = (bin: string, wiki: string | null, extra: Record<string, unknown> = {}) => ({
	python: bin,
	env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C", ...(wiki === null ? {} : { GJC_LESSONS_WIKI: wiki }) },
	home,
	...extra,
});

async function withEnv(values: Record<string, string | undefined>, fn: () => Promise<unknown>) {
	const saved = new Map<string, string | undefined>();
	for (const key of Object.keys(values)) {
		saved.set(key, process.env[key]);
		if (values[key] === undefined) delete process.env[key];
		else process.env[key] = values[key] as string;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of saved) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

const Type = new Proxy({}, { get: (_target, name) => (...args: unknown[]) => ({ kind: String(name), args }) });
const tool = toolModule.default({ cwd: plugin, typebox: { Type } });

// The host validates advertised parameters before the plugin runs, so an
// advertised bound it rejects would fail outside this code (JJO-1107).
const REJECTABLE = [
	"enum",
	"const",
	"pattern",
	"format",
	"maxLength",
	"minLength",
	"maxItems",
	"minItems",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
];
function schemaView(node: any): any {
	if (Array.isArray(node)) return node.map(schemaView);
	if (node === null || typeof node !== "object") return node;
	if (typeof node.kind !== "string") return node;
	const [first, second] = node.args ?? [];
	const options = second !== null && typeof second === "object" ? second : {};
	if (node.kind === "Object") {
		return {
			type: "object",
			properties: Object.fromEntries(Object.entries(first ?? {}).map(([key, value]) => [key, schemaView(value)])),
			...options,
		};
	}
	if (node.kind === "Optional") return schemaView(first);
	return { type: node.kind.toLowerCase(), ...(first !== null && typeof first === "object" ? first : {}), ...options };
}
function rejectable(node: any, at = "parameters"): string[] {
	if (node === null || typeof node !== "object") return [];
	const found: string[] = [];
	for (const keyword of REJECTABLE) if (Object.hasOwn(node, keyword)) found.push(`${at}.${keyword}`);
	if (node.additionalProperties === false) found.push(`${at}.additionalProperties`);
	if (Array.isArray(node.required) && node.required.length > 0) found.push(`${at}.required`);
	for (const [name, child] of Object.entries(node.properties ?? {})) found.push(...rejectable(child, `${at}.${name}`));
	if (node.items) found.push(...rejectable(node.items, `${at}[]`));
	return found;
}

async function runTool(params: Record<string, unknown>) {
	const result = await tool.execute("call-1", params);
	const text = String(result.content?.[0]?.text ?? "");
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { text, isError: result.isError === true, json };
}

await check("manifest declares one tool, one session_start hook and the documented bounds", async () => {
	const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8"));
	assert.equal(manifest.kind, "gajae-code-plugin");
	assert.equal(manifest.name, "lessons");
	assert.equal(manifest.version, "0.0.1");
	assert.equal(manifest.tools.length, 1);
	assert.equal(manifest.tools[0].name, "lessons_select");
	assert.equal(manifest.tools[0].path, "tools/lessons-select.ts");
	assert.equal(manifest.tools[0].schema, undefined, "the adapter parameters are statically readable");
	assert.deepEqual(manifest.hooks, [
		{ name: "lessons-start", event: "session_start", path: "hooks/lessons-start.ts" },
	]);
	assert.deepEqual(
		{
			defaultLimit: core.DEFAULT_LIMIT,
			minLimit: core.MIN_LIMIT,
			maxLimit: core.MAX_LIMIT,
			defaultBytes: core.DEFAULT_MAX_BYTES,
			minBytes: core.MIN_MAX_BYTES,
			maxBytes: core.MAX_MAX_BYTES,
			selectTimeout: core.SELECT_TIMEOUT_MS,
			startLimit: core.START_LIMIT,
			startBytes: core.START_MAX_BYTES,
			startTimeout: core.START_TIMEOUT_MS,
			startLine: core.START_MAX_LINE_CHARS,
			resultBytes: core.MAX_RESULT_BYTES,
		},
		{
			defaultLimit: 6,
			minLimit: 1,
			maxLimit: 6,
			defaultBytes: 600,
			minBytes: 200,
			maxBytes: 600,
			selectTimeout: 4000,
			startLimit: 3,
			startBytes: 300,
			startTimeout: 1500,
			startLine: 300,
			resultBytes: 4096,
		},
	);
});

await check("generated surfaces are in sync and export the manifest paths", async () => {
	const built = spawnSync(process.execPath, [buildScript, "--check"], { encoding: "utf8" });
	assert.equal(built.status, 0, built.stderr);
	assert.match(built.stdout, /in sync/);
	assert.match(readFileSync(toolFile, "utf8"), /^\/\/ GENERATED FILE - do not edit by hand\./);
	assert.match(readFileSync(hookFile, "utf8"), /^\/\/ GENERATED FILE - do not edit by hand\./);
	assert.equal(typeof toolModule.default, "function");
	assert.equal(typeof hookModule.default, "function");
});

await check("tool advertises exactly repo/limit/max_bytes and refuses unknown or relative input", async () => {
	assert.equal(tool.name, "lessons_select");
	assert.deepEqual(Object.keys(tool.parameters.args[0]), ["repo", "limit", "max_bytes"]);
	assert.deepEqual(rejectable(schemaView(tool.parameters)), []);
	const unknown = await runTool({ query: "x" });
	assert.equal(unknown.isError, true);
	assert.match(unknown.text, /lessons_select: invalid_input \(unknown field query\)/);
	const relative = await runTool({ repo: "relative/path" });
	assert.equal(relative.isError, true);
	assert.match(relative.text, /repo must be an absolute path/);
	const nan = await runTool({ limit: "6" });
	assert.equal(nan.isError, true);
	assert.match(nan.text, /limit must be a number/);
});

await check("ok: two ranked lessons with exact argv, a minimal environment and a bounded result", async () => {
	const wiki = ledgerRoot("ok");
	const text = payload([lesson("L-1"), lesson("L-2", { scope: "global", helpful: 5 })]);
	const { bin, log } = shim("ok", emit(text));
	const repo = path.join(sandbox, "repo with space");
	const result = await core.selectLessons(
		{ repo, limit: 6, max_bytes: 600 },
		deps(bin, wiki),
	);
	assert.equal(result.status, "ok");
	assert.equal(result.count, 2);
	assert.equal(result.repo, repo);
	assert.equal(result.limit, 6);
	assert.equal(result.max_bytes, 600);
	assert.equal(
		result.bytes,
		Buffer.byteLength(result.lessons.map((entry: { text: string }) => entry.text).join("\n"), "utf8"),
		"bytes is the newline-joined block length, not the sum of text lengths",
	);
	assert.ok(
		result.bytes >
			result.lessons.reduce((sum: number, entry: { text: string }) => sum + Buffer.byteLength(entry.text, "utf8"), 0),
		"two lessons count one separator",
	);
	assert.equal(result.lessons[0].id, "L-1");
	assert.equal(result.lessons[1].scope, "global");
	assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
	const recorded = calls(log);
	assert.equal(recorded.length, 1);
	assert.deepEqual(recorded[0].argv, [
		path.join(wiki, "scripts", "lessons.py"),
		"--root",
		wiki,
		"select",
		"--repo",
		repo,
		"--limit",
		"6",
		"--max-bytes",
		"600",
		"--json",
	]);
	assert.deepEqual(recorded[0].env, ["LANG", "LC_ALL", "PATH", "PYTHONIOENCODING"]);
});

await check("bytes equals the UTF-8 length of the newline-joined lesson block", async () => {
	const wiki = ledgerRoot("joined-bytes");
	const rows = [
		lesson("L-1", { text: "[L-1] scope=project 짧은 교훈" }),
		lesson("L-2", { scope: "host", text: "[L-2] scope=host two lines" }),
		lesson("L-3", { scope: "global", text: "[L-3] scope=global three" }),
	];
	const { bin } = shim("joined-bytes", emit(payload(rows)));
	const result = await core.selectLessons(
		{ repo: path.join(sandbox, "repo"), limit: 6, max_bytes: 600 },
		deps(bin, wiki),
	);
	assert.equal(result.status, "ok");
	assert.equal(result.count, 3);
	const joined = result.lessons.map((entry: { text: string }) => entry.text).join("\n");
	assert.equal(Buffer.byteLength(joined, "utf8"), result.bytes);
	assert.equal(result.bytes, 85, "two separators plus one multibyte lesson text");
	assert.equal(
		result.bytes,
		result.lessons.reduce((sum: number, entry: { text: string }) => sum + Buffer.byteLength(entry.text, "utf8"), 0) + 2,
		"the two separators are counted exactly once each",
	);
	assert.ok(result.bytes <= result.max_bytes);
	assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
});

await check("empty: a healthy ledger with no matches is explicit, not an error", async () => {
	const wiki = ledgerRoot("empty");
	const { bin } = shim("empty", emit(payload([], "empty")));
	const result = await core.selectLessons({ repo: path.join(sandbox, "repo") }, deps(bin, wiki));
	assert.equal(result.status, "empty");
	assert.equal(result.count, 0);
	assert.equal(result.bytes, 0);
	assert.deepEqual(result.lessons, []);
});

await check("unavailable: missing root, missing script and an unreadable ledger never spawn or throw", async () => {
	const missing = await core.selectLessons(
		{ repo: path.join(sandbox, "repo") },
		deps("python3", path.join(root, "cases", "absent", "wiki")),
	);
	assert.deepEqual(missing, { status: "unavailable", reason: "root_missing" });

	const noScript = ledgerRoot("no-script", { script: false });
	const scriptMissing = await core.selectLessons({ repo: path.join(sandbox, "repo") }, deps("python3", noScript));
	assert.deepEqual(scriptMissing, { status: "unavailable", reason: "script_missing" });

	const wiki = ledgerRoot("ledger-unavailable");
	const { bin, log } = shim(
		"ledger-unavailable",
		`process.stdout.write(JSON.stringify({ status: "unavailable", bytes: 0, lessons: [] }));\nprocess.exit(2);`,
	);
	const result = await core.selectLessons({ repo: path.join(sandbox, "repo") }, deps(bin, wiki));
	assert.deepEqual(result, { status: "unavailable", reason: "ledger_unavailable" });
	assert.equal(calls(log).length, 1, "an unreadable ledger is reported, not retried");
});

await check("limit and max_bytes clamp into the documented windows before the call", async () => {
	const wiki = ledgerRoot("clamp");
	const { bin, log } = shim("clamp", emit(payload([])));
	const repo = path.join(sandbox, "repo");
	const high = await core.selectLessons({ repo, limit: 99, max_bytes: 5000 }, deps(bin, wiki));
	assert.equal(high.status, "empty");
	const low = await core.selectLessons({ repo, limit: 0, max_bytes: 100 }, deps(bin, wiki));
	assert.equal(low.status, "empty");
	const [first, second] = calls(log).map((call) => call.argv);
	assert.deepEqual(first.slice(first.indexOf("--limit")), ["--limit", "6", "--max-bytes", "600", "--json"]);
	assert.deepEqual(second.slice(second.indexOf("--limit")), ["--limit", "1", "--max-bytes", "200", "--json"]);
});

await check("oversize: the limit wins and the serialized result stays under 4096 bytes", async () => {
	const wiki = ledgerRoot("oversize");
	const many = Array.from({ length: 20 }, (_value, index) =>
		lesson(`L-${String(index).padStart(2, "0")}`, { text: "y".repeat(1200) }),
	);
	const { bin } = shim("oversize", emit(payload(many)));
	const result = await core.selectLessons(
		{ repo: path.join(sandbox, "repo"), limit: 6, max_bytes: 600 },
		deps(bin, wiki),
	);
	assert.equal(result.status, "ok");
	assert.ok(result.count <= 6, `count ${result.count}`);
	assert.ok(result.count >= 1, "the ranked first lesson is kept");
	assert.ok(
		result.lessons.every((entry: { text: string }) => Buffer.byteLength(entry.text, "utf8") <= 600),
		"no single lesson exceeds the whole byte budget",
	);
	assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);
});

await check("invalid JSON, a non-zero exit and a malformed lesson are bounded errors with no stderr passthrough", async () => {
	const repo = path.join(sandbox, "repo");
	const badJson = ledgerRoot("bad-json");
	const badShim = shim("bad-json", emit("not json at all"));
	const invalid = await core.selectLessons({ repo }, deps(badShim.bin, badJson));
	assert.deepEqual(invalid, { status: "error", reason: "invalid_json" });

	const failed = ledgerRoot("exit");
	const failedShim = shim(
		"exit",
		'process.stderr.write("SYNTHETIC_STDERR_MARKER");\nprocess.exit(3);',
	);
	const nonzero = await core.selectLessons({ repo }, deps(failedShim.bin, failed));
	assert.deepEqual(nonzero, { status: "error", reason: "exit_3" });
	assert.ok(!JSON.stringify(nonzero).includes("SYNTHETIC_STDERR_MARKER"), "child stderr is never passed through");

	const shape = ledgerRoot("bad-shape");
	const shapeShim = shim("bad-shape", emit(payload([{ ...lesson("L-1"), confidence: 3 }])));
	const malformed = await core.selectLessons({ repo }, deps(shapeShim.bin, shape));
	assert.deepEqual(malformed, { status: "error", reason: "invalid_lesson_shape" });
});

await check("an oversized stdout and a missing interpreter stay bounded errors", async () => {
	const repo = path.join(sandbox, "repo");
	const wiki = ledgerRoot("stdout-cap");
	const flood = shim("stdout-cap", `process.stdout.write("z".repeat(100 * 1024));`);
	const result = await core.selectLessons({ repo }, deps(flood.bin, wiki));
	assert.deepEqual(result, { status: "error", reason: "stdout_too_large" });

	const missing = await core.selectLessons(
		{ repo },
		deps(path.join(root, "cases", "no-interpreter", "python3"), ledgerRoot("no-interpreter")),
	);
	assert.deepEqual(missing, { status: "error", reason: "spawn_failed" });
});

await check("timeout: a stalled ledger CLI is killed and reported within the injected budget", async () => {
	const wiki = ledgerRoot("timeout");
	const { bin } = shim("timeout", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);");
	const started = Date.now();
	const result = await core.selectLessons(
		{ repo: path.join(sandbox, "repo") },
		deps(bin, wiki, { timeoutMs: 200 }),
	);
	const elapsed = Date.now() - started;
	assert.deepEqual(result, { status: "error", reason: "timeout" });
	assert.ok(elapsed < 5000, `elapsed ${elapsed}ms`);
});

await check("a repo path with shell metacharacters stays one argv element", async () => {
	const wiki = ledgerRoot("metacharacters");
	const { bin, log } = shim("metacharacters", emit(payload([])));
	const repo = path.join(sandbox, `repo; echo pwned $(id) 'quote' "double"`);
	const result = await core.selectLessons({ repo }, deps(bin, wiki));
	assert.equal(result.status, "empty");
	const argv = calls(log)[0].argv;
	assert.equal(argv[argv.indexOf("--repo") + 1], repo);
	assert.equal(argv.filter((entry) => entry === repo).length, 1);
});

await check("the committed tool runs through default arg resolution with only the four allowed variables", async () => {
	const wiki = ledgerRoot("tool-default");
	const { bin, log } = shim("tool-default", emit(payload([lesson("L-9")])));
	await withEnv({ PATH: path.dirname(bin), GJC_LESSONS_WIKI: wiki }, async () => {
		const result = await runTool({ repo: path.join(sandbox, "repo tool"), limit: 2, max_bytes: 240 });
		assert.equal(result.isError, false);
		assert.equal(result.json.status, "ok");
		assert.equal(result.json.count, 1);
		assert.equal(result.json.limit, 2);
		assert.equal(result.json.max_bytes, 240);
		assert.equal(result.json.lessons[0].id, "L-9");
		assert.ok(Buffer.byteLength(result.text, "utf8") <= 4096);
	});
	const recorded = calls(log);
	assert.equal(recorded.length, 1);
	assert.deepEqual(recorded[0].env, ["LANG", "LC_ALL", "PATH", "PYTHONIOENCODING"]);
	assert.deepEqual(recorded[0].argv.slice(recorded[0].argv.indexOf("--limit")), ["--limit", "2", "--max-bytes", "240", "--json"]);
});

await check("startLine is silent for empty, unavailable and error results", async () => {
	assert.equal(notice.startLine({ status: "empty", root: "/w", repo: null, limit: 3, max_bytes: 300, bytes: 0, count: 0, lessons: [] }), null);
	assert.equal(notice.startLine({ status: "unavailable", reason: "root_missing" }), null);
	assert.equal(notice.startLine({ status: "error", reason: "timeout" }), null);
});

await check("session_start is silent on a missing root and logs one bounded line when lessons exist", async () => {
	const handlers: Array<(event: unknown, ctx: unknown) => unknown> = [];
	hookModule.default({ on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.push(handler), logger: {} });
	assert.equal(handlers.length, 1);
	const handler = handlers[0];

	const silentLogs: string[] = [];
	const silentNotices: string[] = [];
	hookModule.default({
		on: (_event: string, entry: (event: unknown, ctx: unknown) => unknown) => {
			handlers.push(entry);
		},
		logger: { info: (message: string) => silentLogs.push(message) },
	});
	await withEnv({ PATH: "/usr/bin:/bin", GJC_LESSONS_WIKI: path.join(root, "cases", "absent", "wiki") }, async () => {
		const value = await handler({ type: "session_start" }, { cwd: sandbox, ui: { notify: (message: string) => silentNotices.push(message) } });
		assert.equal(value, undefined);
	});
	assert.deepEqual(silentLogs, []);
	assert.deepEqual(silentNotices, []);

	const wiki = ledgerRoot("hook");
	const { bin, log } = shim("hook", emit(payload([lesson("L-1"), lesson("L-2", { scope: "host" }), lesson("L-3")])));
	const logs: string[] = [];
	const notices: string[] = [];
	let registered: ((event: unknown, ctx: unknown) => unknown) | null = null;
	hookModule.default({
		on: (_event: string, entry: (event: unknown, ctx: unknown) => unknown) => {
			registered = entry;
		},
		logger: { info: (message: string) => logs.push(message) },
	});
	assert.notEqual(registered, null);
	const sessionCwd = path.join(sandbox, "session cwd");
	await withEnv({ PATH: path.dirname(bin), GJC_LESSONS_WIKI: wiki }, async () => {
		const value = await (registered as (event: unknown, ctx: unknown) => unknown)(
			{ type: "session_start" },
			{ cwd: sessionCwd, ui: { notify: (message: string) => notices.push(message) } },
		);
		assert.equal(value, undefined);
	});
	assert.equal(logs.length, 1);
	assert.ok(logs[0].length <= 300, `line length ${logs[0].length}`);
	assert.equal(notices.length, 1);
	assert.equal(notices[0], logs[0]);
	assert.match(logs[0], /^lessons: 3 relevant \(L-1, L-2, L-3\)/);
	const argv = calls(log)[0].argv;
	assert.deepEqual(argv.slice(argv.indexOf("select")), [
		"select",
		"--cwd",
		sessionCwd,
		"--limit",
		"3",
		"--max-bytes",
		"300",
		"--json",
	]);
});

await check("a broken UI or logger never blocks the session", async () => {
	const wiki = ledgerRoot("hook-broken-ui");
	const { bin } = shim("hook-broken-ui", emit(payload([lesson("L-1")])));
	let registered: ((event: unknown, ctx: unknown) => unknown) | null = null;
	hookModule.default({
		on: (_event: string, entry: (event: unknown, ctx: unknown) => unknown) => {
			registered = entry;
		},
		logger: {
			info: () => {
				throw new Error("logger broke");
			},
		},
	});
	await withEnv({ PATH: path.dirname(bin), GJC_LESSONS_WIKI: wiki }, async () => {
		const value = await (registered as (event: unknown, ctx: unknown) => unknown)(
			{ type: "session_start" },
			{
				cwd: sandbox,
				ui: {
					notify: () => {
						throw new Error("ui broke");
					},
				},
			},
		);
		assert.equal(value, undefined);
	});
});

rmSync(root, { recursive: true, force: true });
if (failures > 0) {
	console.error(`lessons verify: ${failures}/${cases} failed`);
	process.exit(1);
}
console.log(`lessons verify: ${cases}/${cases} passed`);
