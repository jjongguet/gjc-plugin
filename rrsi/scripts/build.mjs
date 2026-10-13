#!/usr/bin/env node
/**
 * Build rrsi plugin surface files.
 *
 *   node scripts/build.mjs   →  tools/rrsi.ts  (one generated, committed file)
 *
 * Bundling decision (M5): the shared journaling core
 * (../shared/lib/results.ts) plus the Dream-RSI core modules
 * (../self-improve/lib/{types,ledger,replay,dream,policy}.mjs) and this plugin's
 * own lib/src files are inlined into ONE tool file, exactly like the sibling
 * plugins inline their cores. Local imports are stripped because every local
 * binding is declared earlier in the same bundle; the self-improve modules are
 * plain Node ESM (no type annotations), so they transpile unchanged and the
 * generated file stays a single self-contained surface (no runtime file
 * resolution outside the plugin). The fallback recorded in the plan (vendoring
 * the modules as separate files) is unnecessary.
 *
 * ALWAYS keyless: no credentials are read and the generated surface has no
 * network path (no fetch, no provider client).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = path.resolve(pluginRoot, "..");

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

const parts = [sharedCore.trimEnd()];
for (const relative of dreamRsiModules) {
	const text = await readFile(path.join(repoRoot, relative), "utf8");
	parts.push(`// ---- inlined from ${relative} (Dream-RSI core, keyless plain ESM) ----\n${stripLocalImports(text).trimEnd()}`);
}
parts.push(stripLocalImports(await readFile(path.join(pluginRoot, "lib/rrsi.ts"), "utf8")).trimEnd());
parts.push(stripLocalImports(await readFile(path.join(pluginRoot, "src/rrsi.adapter.ts"), "utf8")).trimStart());

// Identical builtin import statements (e.g. `import * as fs from "node:fs";`
// declared by both the Dream-RSI core and this plugin) would collide as
// duplicate top-level bindings once inlined; keep the first occurrence.
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

const banner = [
	"// GENERATED FILE — do not edit by hand.",
	"// Core: lib/rrsi.ts + adapter: src/rrsi.adapter.ts",
	"// Inlined: shared/lib/results.ts and self-improve/lib/{types,ledger,replay,dream,policy}.mjs",
	"// Rebuild with: bun scripts/build.mjs",
	"",
].join("\n");

const out = path.join(pluginRoot, "tools/rrsi.ts");
await mkdir(path.dirname(out), { recursive: true });
await writeFile(out, dedupeBuiltins(`${banner}\n${parts.join("\n\n")}\n`), "utf8");
console.log(`built tools/rrsi.ts (keyless; ${dreamRsiModules.length} core modules inlined)`);
