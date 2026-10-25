#!/usr/bin/env node
/**
 * Build rrsi plugin surface files.
 *
 *   bun scripts/build.mjs           → tools/rrsi.ts + hooks/rrsi-periodic.ts (generated, committed)
 *   bun scripts/build.mjs --check   → non-mutating drift check (no writes; exit 1 on drift)
 *
 * Both surfaces are self-contained single files, exactly like the sibling
 * plugins: the shared journaling core (../shared/lib/results.ts), the Dream-RSI
 * core modules (../self-improve/lib/{types,ledger,replay,dream,policy}.mjs) and
 * this plugin's own lib/src files are inlined (local imports stripped, builtin
 * imports de-duplicated) because the installer copies only manifest-declared
 * files — the generated hook must not resolve anything outside itself. The
 * hook file also doubles as the detached worker CLI
 * (`RRSI_PERIODIC_WORKER=1 bun hooks/rrsi-periodic.ts`).
 *
 * ALWAYS keyless: no credentials are read and the generated surfaces have no
 * network path (no fetch, no provider client).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginRoot, "..");
const check = process.argv.includes("--check");

const stripLocalImports = (text) => {
	const lines = text.split("\n");
	const out = [];
	let pending = null; // lines of an in-progress import statement
	const relative = /from\s+["']\.[^"']*["']/;
	const anyFrom = /from\s+["'][^"']*["']/;
	for (const line of lines) {
		if (pending === null && /^import\s/.test(line)) {
			if (anyFrom.test(line)) {
				if (!relative.test(line)) out.push(line);
				continue;
			}
			pending = [line];
			continue;
		}
		if (pending !== null) {
			pending.push(line);
			if (anyFrom.test(line)) {
				if (!relative.test(line)) out.push(...pending);
				pending = null;
			}
			continue;
		}
		out.push(line);
	};
	if (pending !== null) out.push(...pending);
	return out.join("\n");
};

const sharedCore = await readFile(path.join(repoRoot, "shared/lib/results.ts"), "utf8");
const dreamRsiModules = [
	"self-improve/lib/types.mjs",
	"self-improve/lib/ledger.mjs",
	"self-improve/lib/replay.mjs",
	"self-improve/lib/dream.mjs",
	"self-improve/lib/policy.mjs",
];

// Canonical quality-evidence contract (gjc.quality_trial.v2) consumed by
// lib/rrsi.ts. Inlined like the Dream-RSI core so the generated surfaces stay
// self-contained.
const inlineModules = ["self-improve/lib/quality-trial.mjs"];

const inlineParts = [];
for (const relative of inlineModules) {
	const text = await readFile(path.join(repoRoot, relative), "utf8");
	inlineParts.push(`// ---- inlined from ${relative} (canonical quality-evidence contract, keyless plain ESM) ----\n${stripLocalImports(text).trimEnd()}`);
}

const dreamParts = [];
for (const relative of dreamRsiModules) {
	const text = await readFile(path.join(repoRoot, relative), "utf8");
	dreamParts.push(`// ---- inlined from ${relative} (Dream-RSI core, keyless plain ESM) ----\n${stripLocalImports(text).trimEnd()}`);
}

const pluginPart = async (relative, { trimStart = false } = {}) => {
	const stripped = stripLocalImports(await readFile(path.join(pluginRoot, relative), "utf8"));
	return trimStart ? stripped.trimStart() : stripped.trimEnd();
};

// Detached worker entry, appended to the hook bundle only. Inert when the
// loader imports the module; active only when bun executes the file directly
// with the worker flag.
const workerTail = [
	"",
	"// Worker entry: executed directly (`RRSI_PERIODIC_WORKER=1 bun hooks/rrsi-periodic.ts`) for",
	"// the detached large-corpus dream; imported by the plugin loader it stays inert.",
	"if (import.meta.main && process.env.RRSI_PERIODIC_WORKER === \"1\") {",
	"  const result = await runPeriodicWorker({ env: process.env });",
	"  process.stdout.write(`${JSON.stringify({ worker: true, status: result?.status ?? \"error\", reason: result?.reason ?? null, durationMs: result?.durationMs ?? null })}\\n`);",
	"  process.exit(result && (result.status === \"ran\" || result.status === \"unchanged\") ? 0 : 1);",
	"}",
	"",
].join("\n");

// Identical builtin import statements (e.g. `import * as fs from "node:fs";`
// declared by both the Dream-RSI core and this plugin) would collide as
// duplicate top-level bindings once inlined; keep the first occurrence.
const compose = (bannerText, parts, tail = "") => {
	const seenBuiltinImports = new Set();
	const dedupeBuiltins = (text) =>
		text
			.split("\n")
			.filter((line) => {
				if (!/^import\s/.test(line) || !/^import\s.*from\s+["'][^"'.]/.test(line)) return true;
				const key = line.trim();
				if (seenBuiltinImports.has(key)) return false;
				seenBuiltinImports.add(key);
				return true;
			})
			.join("\n");
	return dedupeBuiltins(`${bannerText}\n${parts.join("\n\n")}\n${tail}`);
};

const toolBanner = [
	"// GENERATED FILE — do not edit by hand.",
	"// Core: lib/rrsi.ts + adapter: src/rrsi.adapter.ts",
	"// Inlined: shared/lib/results.ts, self-improve/lib/{types,ledger,replay,dream,policy}.mjs and",
	"//          self-improve/lib/quality-trial.mjs (gjc.quality_trial.v2)",
	"// Rebuild with: bun scripts/build.mjs",
	"",
].join("\n");

const hookBanner = [
	"// GENERATED FILE — do not edit by hand.",
	"// Core: lib/rrsi.ts + lib/periodic.ts + adapter: src/periodic.adapter.ts",
	"// Inlined: shared/lib/results.ts, self-improve/lib/{types,ledger,replay,dream,policy}.mjs and",
	"//          self-improve/lib/quality-trial.mjs (gjc.quality_trial.v2)",
	"// Rebuild with: bun scripts/build.mjs",
	"// One session_start registration; doubles as the detached worker CLI (RRSI_PERIODIC_WORKER=1).",
	"",
].join("\n");

const toolText = compose(toolBanner, [sharedCore.trimEnd(), ...dreamParts, ...inlineParts, await pluginPart("lib/rrsi.ts"), await pluginPart("lib/periodic.ts"), await pluginPart("src/rrsi.adapter.ts", { trimStart: true })]);
const hookText = compose(
	hookBanner,
	[sharedCore.trimEnd(), ...dreamParts, ...inlineParts, await pluginPart("lib/rrsi.ts"), await pluginPart("lib/periodic.ts"), await pluginPart("src/periodic.adapter.ts", { trimStart: true })],
	workerTail,
);

const outputs = [
	{ file: path.join(pluginRoot, "tools/rrsi.ts"), text: toolText, label: `tools/rrsi.ts (keyless; ${dreamRsiModules.length} core modules + ${inlineModules.length} quality module inlined)` },
	{ file: path.join(pluginRoot, "hooks/rrsi-periodic.ts"), text: hookText, label: "hooks/rrsi-periodic.ts (keyless; one session_start registration + worker tail)" },
];

if (check) {
	let drift = false;
	for (const output of outputs) {
		let existing = null;
		try {
			existing = await readFile(output.file, "utf8");
		} catch {
			existing = null;
		}
		if (existing !== output.text) {
			drift = true;
			process.stderr.write(`generated_out_of_sync:${path.relative(repoRoot, output.file)}\n`);
		}
	}
	if (drift) process.exit(1);
	console.log("generated surfaces are in sync: tools/rrsi.ts, hooks/rrsi-periodic.ts");
} else {
	for (const output of outputs) {
		await mkdir(path.dirname(output.file), { recursive: true });
		await writeFile(output.file, output.text, "utf8");
		console.log(`built ${output.label}`);
	}
}
