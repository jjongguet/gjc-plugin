#!/usr/bin/env bun
/**
 * Deterministic acceptance for the lessons plugin.
 *
 * Every ledger root is a synthetic temp directory with a shim ledger CLI, so the
 * checks never read the owner's real wiki, never need Python and never touch the
 * network. The suite covers the four documented statuses, the bounds (limit,
 * byte budget, 4096-byte result, stdout cap, timeout), argv/env shaping without a
 * shell, the advisory session_start line, and the correction staging path:
 * cue matching, redaction, 600-byte clipping, replay dedupe, transcript
 * selection and the lessons_staged json/add-argv surfaces.
 */
import assert from "node:assert/strict";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(import.meta.url);
const plugin = path.resolve(path.dirname(script), "..");
const buildScript = path.join(plugin, "scripts", "build.mjs");
const toolFile = path.join(plugin, "tools", "lessons-select.ts");
const hookFile = path.join(plugin, "hooks", "lessons-start.ts");
const stagedToolFile = path.join(plugin, "tools", "lessons-staged.ts");
const sessionEndHookFile = path.join(plugin, "hooks", "session-end.ts");
const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "lessons-verify-")));

for (const file of [toolFile, hookFile, stagedToolFile, sessionEndHookFile]) {
	if (existsSync(file)) continue;
	const built = spawnSync(process.execPath, [buildScript], { encoding: "utf8" });
	if (built.status !== 0) {
		console.error(`lessons verify: generated surfaces are missing and the build failed\n${built.stdout}${built.stderr}`);
		process.exit(1);
	}
}

const core = await import(pathToFileURL(path.join(plugin, "lib", "select.ts")).href);
const notice = await import(pathToFileURL(path.join(plugin, "lib", "notice.ts")).href);
const correction = await import(pathToFileURL(path.join(plugin, "lib", "correction.ts")).href);
const toolModule = await import(pathToFileURL(toolFile).href);
const hookModule = await import(pathToFileURL(hookFile).href);
const stagedToolModule = await import(pathToFileURL(stagedToolFile).href);
const sessionEndHookModule = await import(pathToFileURL(sessionEndHookFile).href);

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
const stagedTool = stagedToolModule.default({ cwd: plugin, typebox: { Type } });

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

async function runStagedTool(params: Record<string, unknown>) {
	const result = await stagedTool.execute("call-1", params);
	const text = String(result.content?.[0]?.text ?? "");
	let json: any = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return { text, isError: result.isError === true, json };
}

await check("manifest declares two tools, the two hooks and the documented bounds", async () => {
	const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8"));
	assert.equal(manifest.kind, "gajae-code-plugin");
	assert.equal(manifest.name, "lessons");
	assert.equal(manifest.version, "0.0.1");
	assert.deepEqual(
		manifest.tools.map((entry: { name: string; path: string; schema?: unknown }) => ({
			name: entry.name,
			path: entry.path,
			schema: entry.schema,
		})),
		[
			{ name: "lessons_select", path: "tools/lessons-select.ts", schema: undefined },
			{ name: "lessons_staged", path: "tools/lessons-staged.ts", schema: undefined },
		],
	);
	assert.deepEqual(manifest.hooks, [
		{ name: "lessons-start", event: "session_start", path: "hooks/lessons-start.ts" },
		{ name: "session-end", event: "session_shutdown", path: "hooks/session-end.ts" },
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
			correctionSchema: correction.CORRECTION_SCHEMA,
			correctionTextBytes: correction.CORRECTION_TEXT_MAX_BYTES,
			excerptBytes: correction.EXCERPT_MAX_BYTES,
			recentWindow: correction.RECENT_WINDOW_MS,
			shutdownTimeout: correction.SHUTDOWN_TIMEOUT_MS,
			chunkBytes: correction.TRANSCRIPT_CHUNK_BYTES,
			readCap: correction.TRANSCRIPT_MAX_BYTES,
			sessionDirs: correction.MAX_SESSION_DIRS,
			sessionFiles: correction.MAX_SESSION_FILES,
			stagedLimit: correction.STAGED_MAX_LIMIT,
			stagedResultBytes: correction.MAX_RESULT_BYTES,
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
			correctionSchema: "lessons-correction.v1",
			correctionTextBytes: 600,
			excerptBytes: 600,
			recentWindow: 900000,
			shutdownTimeout: 1500,
			chunkBytes: 1048576,
			readCap: 16777216,
			sessionDirs: 2048,
			sessionFiles: 8192,
			stagedLimit: 20,
			stagedResultBytes: 4096,
		},
	);
});

await check("generated surfaces are in sync and export the manifest paths", async () => {
	const built = spawnSync(process.execPath, [buildScript, "--check"], { encoding: "utf8" });
	assert.equal(built.status, 0, built.stderr);
	assert.match(built.stdout, /in sync/);
	for (const file of [toolFile, hookFile, stagedToolFile, sessionEndHookFile]) {
		assert.match(readFileSync(file, "utf8"), /^\/\/ GENERATED FILE - do not edit by hand\./);
	}
	for (const module of [toolModule, hookModule, stagedToolModule, sessionEndHookModule]) {
		assert.equal(typeof module.default, "function");
	}
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

await check("oversize: the limit wins, the joined text budget holds and the JSON envelope stays under 4096 bytes", async () => {
	const repo = path.join(sandbox, "repo");
	const wiki = ledgerRoot("oversize");
	const many = Array.from({ length: 20 }, (_value, index) =>
		lesson(`L-${String(index).padStart(2, "0")}`, { text: "y".repeat(200) }),
	);
	const { bin } = shim("oversize", emit(payload(many)));
	const result = await core.selectLessons({ repo, limit: 6, max_bytes: 600 }, deps(bin, wiki));
	assert.equal(result.status, "ok");
	assert.ok(result.count <= 6, `count ${result.count}`);
	assert.ok(result.count >= 1, "the ranked first lesson is kept");
	assert.ok(
		result.lessons.every((entry: { text: string }) => Buffer.byteLength(entry.text, "utf8") <= 600),
		"no single lesson exceeds the whole byte budget",
	);
	assert.equal(result.bytes, Buffer.byteLength(result.lessons.map((entry: { text: string }) => entry.text).join("\n"), "utf8"));
	assert.ok(result.bytes <= 600, `joined bytes ${result.bytes}`);
	assert.ok(Buffer.byteLength(JSON.stringify(result), "utf8") <= 4096);

	// Small texts, fat metadata: the byte budget is not the binding constraint here,
	// so the 4096-byte envelope must drop the ranked tail on its own.
	const jsonWiki = ledgerRoot("oversize-json");
	const fat = Array.from({ length: 6 }, (_value, index) =>
		lesson(`L-${String(index).padStart(2, "0")}`, { text: "t".repeat(40), trigger: "g".repeat(400), action: "h".repeat(400) }),
	);
	const jsonShim = shim("oversize-json", emit(payload(fat)));
	const capped = await core.selectLessons({ repo, limit: 6, max_bytes: 600 }, deps(jsonShim.bin, jsonWiki));
	assert.equal(capped.status, "ok");
	assert.ok(capped.count < 6, `envelope cap must drop the tail: count ${capped.count}`);
	assert.ok(capped.count >= 1);
	assert.ok(Buffer.byteLength(JSON.stringify(capped), "utf8") <= 4096);
});

await check("multiple near-budget lessons never exceed the aggregate joined-text budget", async () => {
	const repo = path.join(sandbox, "repo");
	const wiki = ledgerRoot("aggregate");
	// 6 x 250 B: the sum of two fits 600 but the joined block of three does not.
	const near = Array.from({ length: 6 }, (_value, index) => {
		const id = `L-${index + 1}`;
		const prefix = `[${id}] `;
		return lesson(id, { text: prefix + "k".repeat(250 - prefix.length) });
	});
	const { bin } = shim("aggregate", emit(payload(near)));
	const result = await core.selectLessons({ repo, limit: 6, max_bytes: 600 }, deps(bin, wiki));
	assert.equal(result.status, "ok");
	assert.equal(result.count, 2, "three 250 B lessons plus two separators exceed 600");
	assert.equal(result.lessons.length, result.count);
	assert.deepEqual(
		result.lessons.map((entry: { id: string }) => entry.id),
		["L-1", "L-2"],
		"the ranked tail is dropped, not reordered",
	);
	const joined = result.lessons.map((entry: { text: string }) => entry.text).join("\n");
	assert.equal(result.bytes, Buffer.byteLength(joined, "utf8"));
	assert.equal(result.bytes, 501);
	assert.ok(result.bytes <= 600);

	// The separator is budgeted: two 300 B texts sum to exactly 600 but join to 601,
	// so only the first is emitted.
	const edgeWiki = ledgerRoot("aggregate-edge");
	const edge = [
		lesson("L-a", { text: "a".repeat(300) }),
		lesson("L-b", { text: "b".repeat(300) }),
	];
	const edgeShim = shim("aggregate-edge", emit(payload(edge)));
	const edgeResult = await core.selectLessons({ repo, limit: 6, max_bytes: 600 }, deps(edgeShim.bin, edgeWiki));
	assert.equal(edgeResult.status, "ok");
	assert.equal(edgeResult.count, 1);
	assert.equal(edgeResult.bytes, 300);
	assert.ok(edgeResult.bytes <= 600);

	// The reported regression: two lessons that are each exactly at the budget.
	const twinWiki = ledgerRoot("aggregate-twins");
	const twins = [lesson("L-x", { text: "x".repeat(600) }), lesson("L-y", { text: "y".repeat(600) })];
	const twinShim = shim("aggregate-twins", emit(payload(twins)));
	const twinResult = await core.selectLessons({ repo, limit: 6, max_bytes: 600 }, deps(twinShim.bin, twinWiki));
	assert.equal(twinResult.status, "ok");
	assert.equal(twinResult.count, 1, "two 600 B texts join to 1201 and cannot both fit");
	assert.equal(twinResult.bytes, 600);
	assert.ok(twinResult.bytes <= twinResult.max_bytes);
	assert.ok(Buffer.byteLength(JSON.stringify(twinResult), "utf8") <= 4096);
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

// ---- correction staging (JJO-2566) -------------------------------------

const sessionRecord = (cwd: string) => ({
	type: "session",
	id: "01a1f043-05ab-7312-8574-7bdb75518f30",
	cwd,
	timestamp: "2026-11-19T04:59:00.000Z",
});
const userRecord = (text: string) => ({ type: "message", message: { role: "user", content: [{ type: "text", text }] } });
const assistantRecord = (text: string) => ({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } });

function sessionsAt(name: string): string {
	const dir = path.join(caseDir(name), "sessions");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

function dataAt(name: string): string {
	const dir = path.join(caseDir(name), "data");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	return dir;
}

// `GJC_PLUGIN_DATA` is the plugin data base; the staged file is under `lessons/`.
function stagedFile(data: string): string {
	return path.join(data, "lessons", "corrections.jsonl");
}

// The real store is `<sessions>/<project-hash>/<ts>_<session-id>.jsonl`.
function transcriptFile(sessions: string, sessionId: string, records: unknown[], project = "project"): string {
	const dir = path.join(sessions, project);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, `2026-11-19T04-59-00-000Z_${sessionId}.jsonl`);
	writeFileSync(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, { mode: 0o600 });
	return file;
}

function lineCount(file: string): number {
	return readFileSync(file, "utf8")
		.split("\n")
		.filter((line) => line.trim().length > 0).length;
}

const stagedCandidate = (index: number) => ({
	schema: "lessons-correction.v1",
	sessionId: `01a1f043-05ab-7312-8574-7bdb7551800${index}`,
	cwd: "/srv/work/project",
	pattern: "그게 아니라",
	correctionText: `correction ${index} ${"상세".repeat(150)}`,
	priorAssistantExcerpt: `excerpt ${index}`,
	createdAt: "2026-11-19T05:00:00.000Z",
});

await check("correction cues match Korean and English and ignore an ordinary message", async () => {
	const cwd = path.join(sandbox, "cue-project");
	const build = (text: string) => correction.extractCorrection([sessionRecord(cwd), userRecord(text)], { sessionId: "s-cue", cwd, now: Date.parse("2026-11-19T05:00:00.000Z") });
	assert.equal(build("아니 그게 아니라 bun으로 돌려").pattern, "그게 아니라");
	assert.equal(build("그러지 하지마").pattern, "하지마");
	assert.equal(build("아니, 테스트는 bun으로").pattern, "아니");
	assert.equal(build("다시 해줘").pattern, "다시");
	assert.equal(build("No, use the repo default").pattern, "no,");
	assert.equal(build("Actually, use bun instead").pattern, "actually");
	assert.equal(build("Remember: the ledger is canonical").pattern, "remember:");
	assert.equal(build("please run the build and report the result"), null);
	assert.equal(build("the tests are green and 2026-11-19 is done"), null);
	assert.equal(build("nothing to change here"), null);
});

await check("only the last user message is scanned, and the assistant turn before it is the excerpt", async () => {
	const cwd = path.join(sandbox, "last-message-project");
	const now = Date.parse("2026-11-19T05:00:00.000Z");
	const earlier = correction.extractCorrection(
		[sessionRecord(cwd), userRecord("아니 이건 고쳐"), assistantRecord("done"), userRecord("good, thanks")],
		{ sessionId: "s-last", cwd, now },
	);
	assert.equal(earlier, null, "a correction that is not the last user message is not a candidate");
	const candidate = correction.extractCorrection(
		[sessionRecord(cwd), userRecord("아니 이건 고쳐"), assistantRecord("I ran node --test."), userRecord("Actually, use bun test")],
		{ sessionId: "s-last", cwd, now },
	);
	assert.equal(candidate.pattern, "actually");
	assert.equal(candidate.priorAssistantExcerpt, "I ran node --test.");
	assert.equal(candidate.schema, "lessons-correction.v1");
	assert.equal(candidate.sessionId, "s-last");
	assert.equal(candidate.cwd, cwd);
	assert.equal(candidate.createdAt, "2026-11-19T05:00:00.000Z");
	assert.equal(correction.extractCorrection([sessionRecord(cwd)], { sessionId: "s-last", cwd, now }), null);
});

await check("credential-shaped text is redacted and a private key drops the candidate", async () => {
	const cwd = path.join(sandbox, "redaction-project");
	const now = Date.parse("2026-11-19T05:00:00.000Z");
	// Built by concatenation: the fixture is not a live credential shape in the repo.
	const token = ["sk", "-", "abcdefghijklmnopqrstuvwx"].join("");
	const candidate = correction.extractCorrection(
		[sessionRecord(cwd), assistantRecord(`deploy with ${token} now`), userRecord(`no, ${token} is wrong`)],
		{ sessionId: "s-secret", cwd, now },
	);
	assert.equal(candidate.pattern, "no,");
	assert.equal(candidate.correctionText.includes(token), false, "the credential never survives");
	assert.match(candidate.correctionText, /\[REDACTED\]/);
	assert.equal(candidate.priorAssistantExcerpt.includes(token), false);
	assert.match(candidate.priorAssistantExcerpt, /\[REDACTED\]/);
	const assignment = correction.redactText(`password: ${"hunter2hunter2hunter2"}`);
	assert.equal(assignment.ok, true);
	assert.equal(assignment.text, "password: [REDACTED]", "the label is kept, the value is not");
	const pem = ["-----BEGIN", "RSA PRIVATE KEY-----", "body"].join(" ");
	assert.deepEqual(correction.redactText(pem), { ok: false, reason: "private_key" });
	assert.equal(correction.extractCorrection([sessionRecord(cwd), userRecord(`no, here: ${pem}`)], { sessionId: "s-pem", cwd, now }), null);
});

await check("staged text is clipped to 600 UTF-8 bytes on a character boundary", async () => {
	const cwd = path.join(sandbox, "clip-project");
	const long = `그게 아니라 ${"가나다라마바사".repeat(200)}`;
	const candidate = correction.extractCorrection([sessionRecord(cwd), assistantRecord("가나다".repeat(400)), userRecord(long)], {
		sessionId: "s-clip",
		cwd,
		now: Date.parse("2026-11-19T05:00:00.000Z"),
	});
	assert.ok(Buffer.byteLength(candidate.correctionText, "utf8") <= 600);
	assert.ok(Buffer.byteLength(candidate.correctionText, "utf8") > 590);
	assert.equal(candidate.correctionText.includes("\ufffd"), false, "no half character survives");
	assert.ok(Buffer.byteLength(candidate.priorAssistantExcerpt, "utf8") <= 600);
	assert.equal(Buffer.byteLength(correction.clipBytes("가".repeat(400), 600), "utf8"), 600);
	assert.equal(correction.clipBytes("가".repeat(400), 600).length, 200, "600 bytes is 200 three-byte characters");
});

await check("the newest transcript for the hook cwd inside the 15-minute window is used", async () => {
	const sessions = sessionsAt("correction-transcripts");
	const project = path.join(sandbox, "transcript project");
	const other = path.join(sandbox, "another project");
	const stale = transcriptFile(sessions, "stale-session", [sessionRecord(project), userRecord("아니 이전 세션")], "p-stale");
	const old = (Date.now() - 20 * 60 * 1000) / 1000;
	utimesSync(stale, old, old);
	const fresh = transcriptFile(sessions, "fresh-session", [sessionRecord(project), userRecord("아니 지금 세션")], "p-fresh");
	const otherFile = transcriptFile(sessions, "other-session", [sessionRecord(other), userRecord("아니 다른 프로젝트")], "p-other");
	const later = new Date(Date.now() + 30_000);
	utimesSync(otherFile, later, later);
	const hit = correction.latestTranscript(project, { sessionsRoot: sessions, now: Date.now() });
	assert.equal(hit.file, fresh);
	assert.equal(hit.sessionId, "fresh-session");
	assert.equal(correction.latestTranscript(path.join(sandbox, "no session recorded"), { sessionsRoot: sessions, now: Date.now() }), null);
	assert.equal(correction.latestTranscript(project, { sessionsRoot: path.join(sandbox, "absent-sessions"), now: Date.now() }), null);
	assert.equal(
		correction.latestTranscript(project, { sessionsRoot: sessions, now: Date.now() + 30 * 60 * 1000 }),
		null,
		"nothing is read outside the 15-minute window",
	);
	assert.equal(correction.latestTranscript(project, { sessionsRoot: sessions, now: Date.now(), maxSessionDirs: 0 }), null);
	assert.equal(correction.latestTranscript(project, { sessionsRoot: sessions, now: Date.now(), maxSessionFiles: 0 }), null);
});

await check("staging appends one 0600 line and a replay appends nothing", async () => {
	const sessions = sessionsAt("correction-dedupe-sessions");
	const data = dataAt("correction-dedupe-data");
	const cwd = path.join(sandbox, "dedupe project");
	const sessionId = "01a1f043-05ab-7312-8574-7bdb75518f30";
	transcriptFile(sessions, sessionId, [sessionRecord(cwd), assistantRecord("I ran node --test."), userRecord("아니 그게 아니라 bun test로 돌려")]);
	const deps = { sessionsRoot: sessions, env: { GJC_PLUGIN_DATA: data }, now: Date.now() };
	const first = await correction.sessionEndStage({ cwd }, deps);
	assert.equal(first.status, "appended");
	const file = stagedFile(data);
	assert.equal(statSync(file).mode & 0o777, 0o600, "the staged file is owner-only");
	assert.equal(lineCount(file), 1);
	const stored = JSON.parse(readFileSync(file, "utf8").trim());
	assert.equal(stored.schema, "lessons-correction.v1");
	assert.equal(stored.sessionId, sessionId);
	assert.equal(stored.pattern, "그게 아니라");
	assert.equal(stored.priorAssistantExcerpt, "I ran node --test.");
	const replay = await correction.sessionEndStage({ cwd }, deps);
	assert.equal(replay.status, "duplicate");
	assert.equal(lineCount(file), 1, "the replay appends nothing");
	const second = correction.stageCorrection({ ...stored, correctionText: "a different correction" }, { env: { GJC_PLUGIN_DATA: data } });
	assert.equal(second.status, "appended");
	assert.equal(lineCount(file), 2);
});

await check("a session with no matching transcript is a no-op", async () => {
	const sessions = sessionsAt("correction-missing-sessions");
	const data = dataAt("correction-missing-data");
	const deps = { sessionsRoot: sessions, env: { GJC_PLUGIN_DATA: data } };
	assert.equal(await correction.sessionEndStage({ cwd: path.join(sandbox, "no transcript here") }, deps), null);
	assert.equal(existsSync(stagedFile(data)), false, "nothing is created when nothing matched");
	assert.equal(await correction.sessionEndStage({ cwd: sandbox }, { ...deps, sessionsRoot: path.join(sandbox, "absent-root") }), null);
	assert.equal(await correction.sessionEndStage({}, deps), null);
	assert.equal(await correction.sessionEndStage({ cwd: "" }, deps), null);
});

await check("the shutdown work is bounded and never rejects", async () => {
	const started = Date.now();
	assert.equal(await correction.withBound(new Promise(() => {}), 60), null);
	assert.ok(Date.now() - started < 1000, "a stalled read cannot hold the shutdown");
	assert.ok(Date.now() - started >= 50, "the bound is the documented timeout, not a zero wait");
	assert.equal(await correction.withBound(Promise.reject(new Error("boom")), 60), null);
	assert.equal(await correction.withBound(Promise.resolve("ok"), 60), "ok");
});

await check("session_shutdown registers one handler, stages once, and swallows every error", async () => {
	const sessions = sessionsAt("hook-shutdown-sessions");
	const data = dataAt("hook-shutdown-data");
	const cwd = path.join(sandbox, "hook shutdown project");
	transcriptFile(sessions, "hook-session", [sessionRecord(cwd), assistantRecord("I used node."), userRecord("Actually, use bun")]);
	const events: string[] = [];
	const logs: string[] = [];
	let registered: ((event: unknown, ctx: unknown) => unknown) | null = null;
	sessionEndHookModule.default(
		{
			on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				events.push(event);
				registered = handler;
			},
			logger: { info: (message: string) => logs.push(message) },
		},
		{ sessionsRoot: sessions, env: { GJC_PLUGIN_DATA: data } },
	);
	assert.deepEqual(events, ["session_shutdown"]);
	const handler = registered as (event: unknown, ctx: unknown) => unknown;
	assert.equal(
		await handler(
			{ type: "session_shutdown" },
			{
				cwd,
				ui: {
					notify: () => {
						throw new Error("ui broke");
					},
				},
			},
		),
		undefined,
	);
	assert.equal(await handler({ type: "session_shutdown" }, { cwd }), undefined);
	const file = stagedFile(data);
	assert.equal(lineCount(file), 1, "the replay appends nothing");
	assert.equal(logs.length, 1, "the replay logs nothing");
	assert.match(logs[0], /^lessons: staged correction [0-9a-f]{8} \(lessons_staged\)$/);
	logs.length = 0;
	sessionEndHookModule.default({
		on: (_event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
			registered = handler;
		},
		logger: {
			info: () => {
				throw new Error("logger broke");
			},
		},
	});
	assert.equal(await (registered as (event: unknown, ctx: unknown) => unknown)({ type: "session_shutdown" }, { cwd }), undefined);
	assert.equal(await (registered as (event: unknown, ctx: unknown) => unknown)({ type: "session_shutdown" }, { cwd: 42 }), undefined);
});

await check("lessons_staged returns counts, newest first, bounded to 4096 bytes", async () => {
	const wiki = ledgerRoot("staged-json");
	const data = dataAt("staged-json-data");
	for (let index = 0; index < 12; index++) {
		assert.equal(correction.stageCorrection(stagedCandidate(index) as never, { env: { GJC_PLUGIN_DATA: data } }).status, "appended");
	}
	const file = stagedFile(data);
	const result = await withEnv({ GJC_COMPOUND_ROOT: wiki, GJC_PLUGIN_DATA: data }, () => runStagedTool({}));
	assert.equal(result.isError, false);
	assert.equal(result.json.status, "ok");
	assert.equal(result.json.format, "json");
	assert.equal(result.json.root, wiki);
	assert.equal(result.json.count, 12);
	assert.equal(result.json.returned, result.json.entries.length);
	assert.ok(result.json.entries.length < 12, "the entry list is reduced to fit the result budget");
	assert.ok(result.json.entries.length >= 1);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= 4096, `result bytes ${Buffer.byteLength(result.text, "utf8")}`);
	assert.match(result.json.entries[0].id, /^[0-9a-f]{16}$/);
	assert.equal(result.json.entries[0].correctionText.startsWith("correction 11 "), true, "newest first");
	const limited = await withEnv({ GJC_COMPOUND_ROOT: wiki, GJC_PLUGIN_DATA: data }, () => runStagedTool({ limit: 1 }));
	assert.equal(limited.json.returned, 1);
	assert.equal(limited.json.count, 12);
	const clamped = await withEnv({ GJC_COMPOUND_ROOT: wiki, GJC_PLUGIN_DATA: data }, () => runStagedTool({ limit: 500 }));
	assert.ok(clamped.json.returned <= 20);
	// A duplicate and a corrupt line already in the file change neither count nor content.
	writeFileSync(file, `{"not":"a candidate"}\n${JSON.stringify(stagedCandidate(11))}\n`, { flag: "a" });
	const after = await withEnv({ GJC_COMPOUND_ROOT: wiki, GJC_PLUGIN_DATA: data }, () => runStagedTool({}));
	assert.equal(after.json.count, 12);
});

await check("lessons_staged refuses unknown fields, a bad format and a misplaced id", async () => {
	const wiki = ledgerRoot("staged-invalid");
	const data = dataAt("staged-invalid-data");
	const run = (params: Record<string, unknown>) => withEnv({ GJC_COMPOUND_ROOT: wiki, GJC_PLUGIN_DATA: data }, () => runStagedTool(params));
	const unknown = await run({ query: "x" });
	assert.equal(unknown.isError, true);
	assert.match(unknown.text, /lessons_staged: invalid_input \(unknown field query\)/);
	const badFormat = await run({ format: "csv" });
	assert.equal(badFormat.isError, true);
	assert.match(badFormat.text, /format must be json or add-argv/);
	const missingId = await run({ format: "add-argv" });
	assert.equal(missingId.isError, true);
	assert.match(missingId.text, /id is required for format add-argv/);
	const misplaced = await run({ id: "0123456789abcdef" });
	assert.equal(misplaced.isError, true);
	assert.match(misplaced.text, /id is only used with format add-argv/);
	const nan = await run({ limit: "3" });
	assert.equal(nan.isError, true);
	assert.match(nan.text, /limit must be a number/);
	assert.deepEqual(rejectable(schemaView(stagedTool.parameters)), []);
	assert.deepEqual(Object.keys(stagedTool.parameters.args[0]), ["limit", "format", "id"]);
	assert.equal(stagedTool.name, "lessons_staged");
});

await check("lessons_staged is unavailable without a wiki root and empty without a staged file", async () => {
	const data = dataAt("staged-unavailable-data");
	const absent = path.join(root, "cases", "absent-wiki");
	const missing = await withEnv({ GJC_COMPOUND_ROOT: absent, GJC_PLUGIN_DATA: data }, () => runStagedTool({}));
	assert.deepEqual(missing.json, { status: "unavailable", reason: "wiki_root_missing" });
	const noScript = caseDir("staged-no-script");
	const noScriptResult = await withEnv({ GJC_COMPOUND_ROOT: noScript, GJC_PLUGIN_DATA: data }, () => runStagedTool({}));
	assert.deepEqual(noScriptResult.json, { status: "unavailable", reason: "script_missing" });
	const wiki = ledgerRoot("staged-empty");
	const empty = await withEnv({ GJC_COMPOUND_ROOT: wiki, GJC_PLUGIN_DATA: data }, () => runStagedTool({}));
	assert.equal(empty.json.status, "empty");
	assert.equal(empty.json.count, 0);
	assert.equal(empty.json.returned, 0);
});

await check("lessons_staged add-argv prints one exact, runnable ledger command and never executes it", async () => {
	const wiki = ledgerRoot("staged-argv");
	const data = dataAt("staged-argv-data");
	const candidate = {
		schema: "lessons-correction.v1" as const,
		sessionId: "01a1f043-05ab-7312-8574-7bdb75518f30",
		cwd: "/srv/work/project with space",
		pattern: "그게 아니라",
		correctionText: "bun test로 돌려",
		priorAssistantExcerpt: "I ran node --test.",
		createdAt: "2026-11-19T05:00:00.000Z",
	};
	assert.equal(correction.stageCorrection(candidate, { env: { GJC_PLUGIN_DATA: data } }).status, "appended");
	const listed = await withEnv({ GJC_COMPOUND_ROOT: wiki, GJC_PLUGIN_DATA: data }, () => runStagedTool({}));
	const id = listed.json.entries[0].id;
	const result = await withEnv({ GJC_COMPOUND_ROOT: wiki, GJC_PLUGIN_DATA: data }, () => runStagedTool({ format: "add-argv", id }));
	assert.equal(result.json.status, "ok");
	assert.equal(result.json.format, "add-argv");
	assert.equal(result.json.id, id);
	assert.ok(Buffer.byteLength(result.text, "utf8") <= 4096);
	// Nothing ran and nothing was written into the wiki.
	assert.equal(existsSync(path.join(wiki, "lessons")), false);
	// The printed line, executed by a shell against an argv-recording python3 shim,
	// must produce exactly the documented argv (quoting included).
	const { bin, log } = shim("staged-argv-run", "process.exit(0);", { as: "python3" });
	const shell = spawnSync("/bin/sh", ["-c", result.json.command], {
		encoding: "utf8",
		env: { PATH: `${path.dirname(bin)}:/usr/bin:/bin` },
	});
	assert.equal(shell.status, 0, shell.stderr);
	assert.deepEqual(calls(log)[0].argv, [
		path.join(wiki, "scripts", "lessons.py"),
		"--root",
		wiki,
		"add",
		"--id",
		`L-corr-${id}`,
		"--trigger",
		"Owner correction (그게 아니라) after: I ran node --test.",
		"--action",
		"bun test로 돌려",
		"--scope",
		"project",
		"--repo",
		"/srv/work/project with space",
		"--evidence",
		candidate.sessionId,
		"--json",
	]);
	const unknownId = await withEnv({ GJC_COMPOUND_ROOT: wiki, GJC_PLUGIN_DATA: data }, () => runStagedTool({ format: "add-argv", id: "0000000000000000" }));
	assert.deepEqual(unknownId.json, { status: "error", reason: "unknown_correction_id" });
});

await check("the transcript scan abandons the rest at the deadline instead of running to completion", async () => {
	const sessions = sessionsAt("deadline-sessions");
	const cwd = path.join(sandbox, "deadline project");
	for (let index = 0; index < 24; index++) {
		transcriptFile(
			sessions,
			`deadline-session-${index}`,
			[sessionRecord(cwd), assistantRecord(`assistant ${index}`), userRecord("Actually, use bun")],
			`p-${String(index).padStart(2, "0")}`,
		);
	}
	const controlData = dataAt("deadline-control-data");
	const control = await correction.sessionEndStage({ cwd }, { sessionsRoot: sessions, env: { GJC_PLUGIN_DATA: controlData }, now: Date.now() });
	assert.equal(control.status, "appended", "the same store stages with a real clock");
	let calls = 0;
	const start = Date.parse("2026-11-19T05:00:00.000Z");
	const clock = () => {
		calls += 1;
		return start + calls * 400;
	};
	const data = dataAt("deadline-data");
	const result = await correction.sessionEndStage(
		{ cwd },
		{ sessionsRoot: sessions, env: { GJC_PLUGIN_DATA: data }, now: Date.now(), clock, timeoutMs: 1500 },
	);
	assert.equal(result, null, "an expired scan stages nothing instead of finishing the enumeration");
	assert.ok(calls >= 3, `the deadline check is reached (${calls} clock reads)`);
	assert.equal(existsSync(stagedFile(data)), false);
});

await check("a correction earlier than the old 4 MiB tail is found by the chunked backward read", async () => {
	const sessions = sessionsAt("chunked-sessions");
	const cwd = path.join(sandbox, "chunked project");
	const filler = JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "x".repeat(4096) }] } });
	const head = [
		JSON.stringify(sessionRecord(cwd)),
		JSON.stringify(assistantRecord("I ran node --test.")),
		JSON.stringify(userRecord("아니 그게 아니라 bun test로 돌려")),
	];
	const dir = path.join(sessions, "chunked");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, "2026-11-19T04-59-00-000Z_chunked-session.jsonl");
	writeFileSync(file, `${head.join("\n")}\n${Array.from({ length: 1300 }, () => filler).join("\n")}\n`, { mode: 0o600 });
	const bytes = statSync(file).size;
	const headBytes = Buffer.byteLength(head.join("\n"), "utf8");
	assert.ok(bytes > 4 * 1024 * 1024, `fixture is ${bytes} bytes`);
	assert.ok(bytes - headBytes > 4 * 1024 * 1024, "the correction is farther than 4 MiB from the end");
	const data = dataAt("chunked-data");
	const result = await correction.sessionEndStage(
		{ cwd },
		{ sessionsRoot: sessions, env: { GJC_PLUGIN_DATA: data }, now: Date.now(), timeoutMs: 60_000 },
	);
	assert.equal(result.status, "appended");
	const stored = JSON.parse(readFileSync(stagedFile(data), "utf8").trim());
	assert.equal(stored.pattern, "그게 아니라");
	assert.match(stored.correctionText, /bun test/);
	assert.equal(stored.priorAssistantExcerpt, "I ran node --test.");
});

await check("a transcript whose only user record is beyond the read cap is a documented no-op", async () => {
	const sessions = sessionsAt("cap-sessions");
	const cwd = path.join(sandbox, "cap project");
	const filler = JSON.stringify({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "y".repeat(8192) }] } });
	const head = [
		JSON.stringify(sessionRecord(cwd)),
		JSON.stringify(assistantRecord("I ran node --test.")),
		JSON.stringify(userRecord("Actually, use bun")),
	];
	const dir = path.join(sessions, "cap");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const file = path.join(dir, "2026-11-19T04-59-00-000Z_cap-session.jsonl");
	writeFileSync(file, `${head.join("\n")}\n${Array.from({ length: 2200 }, () => filler).join("\n")}\n`, { mode: 0o600 });
	assert.ok(statSync(file).size > correction.TRANSCRIPT_MAX_BYTES, "the user record is beyond the documented cap");
	const data = dataAt("cap-data");
	const logs: string[] = [];
	const debugs: string[] = [];
	let registered: ((event: unknown, ctx: unknown) => unknown) | null = null;
	sessionEndHookModule.default(
		{
			on: (_event: string, handler: (event: unknown, ctx: unknown) => unknown) => {
				registered = handler;
			},
			logger: { info: (message: string) => logs.push(message), debug: (message: string) => debugs.push(message) },
		},
		{ sessionsRoot: sessions, env: { GJC_PLUGIN_DATA: data }, now: Date.now(), timeoutMs: 60_000 },
	);
	assert.equal(await (registered as (event: unknown, ctx: unknown) => unknown)({ type: "session_shutdown" }, { cwd }), undefined);
	assert.deepEqual(logs, [], "nothing is reported as staged");
	assert.equal(debugs.length, 1, "exactly one debug line");
	assert.match(debugs[0], /^lessons: no correction staged \(transcript scan stopped at the 16 MiB read cap\)$/);
	assert.equal(existsSync(stagedFile(data)), false, "the cap never stages a partial candidate");
});

await check("one wiki-root chain: GJC_COMPOUND_ROOT, then GJC_LESSONS_WIKI, then the home default", async () => {
	const wikiA = ledgerRoot("root-chain-a");
	const wikiB = ledgerRoot("root-chain-b");
	const data = dataAt("root-chain-data");
	const viaWiki = await withEnv({ GJC_COMPOUND_ROOT: undefined, GJC_LESSONS_WIKI: wikiB, GJC_PLUGIN_DATA: data }, async () => ({
		select: core.wikiRoot({ env: process.env, home }),
		staged: await runStagedTool({}),
	}));
	assert.equal(viaWiki.select, wikiB, "lessons_select resolves GJC_LESSONS_WIKI");
	assert.equal(viaWiki.staged.json.root, wikiB, "lessons_staged resolves the same checkout");
	assert.equal(viaWiki.staged.json.status, "empty");
	const both = await withEnv({ GJC_COMPOUND_ROOT: wikiA, GJC_LESSONS_WIKI: wikiB, GJC_PLUGIN_DATA: data }, async () => ({
		select: core.wikiRoot({ env: process.env, home }),
		staged: await runStagedTool({}),
	}));
	assert.equal(both.select, wikiA, "GJC_COMPOUND_ROOT wins over GJC_LESSONS_WIKI");
	assert.equal(both.staged.json.root, wikiA, "both surfaces prefer the same name");
	const wikiOnly = correction.stagedResult({ limit: 20, format: "json", id: null }, { env: { GJC_LESSONS_WIKI: wikiB }, home });
	assert.equal(wikiOnly.status, "empty");
	if (wikiOnly.status !== "ok" && wikiOnly.status !== "empty") throw new Error(`unexpected status ${wikiOnly.status}`);
	assert.equal(wikiOnly.root, wikiB, "the staged core honors the same chain without an env override object");
	assert.equal(core.wikiRoot({ env: { GJC_LESSONS_WIKI: "  " }, home }), path.join(home, "jjongguet", "personal-wiki"));
	assert.equal(core.wikiRoot({ env: { GJC_COMPOUND_ROOT: "~/wiki" }, home }), path.join(home, "wiki"), "~ expands for both names");
	assert.equal(core.wikiRoot({ env: {}, home }), path.join(home, "jjongguet", "personal-wiki"));
});

rmSync(root, { recursive: true, force: true });
if (failures > 0) {
	console.error(`lessons verify: ${failures}/${cases} failed`);
	process.exit(1);
}
console.log(`lessons verify: ${cases}/${cases} passed`);
