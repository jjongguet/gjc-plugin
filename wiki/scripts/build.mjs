#!/usr/bin/env node
/**
 * Build wiki plugin surface files from lib/wiki.ts + src/*.adapter.ts.
 *
 *   node scripts/build.mjs   →  tools/ at the plugin root
 *
 * ALWAYS keyless: the generated surfaces are committed for one-command
 * distribution, so the repo tree can never contain a key. The wiki is
 * accessed locally via python3 (WIKI_ROOT, default ~/jjongguet/personal-wiki);
 * no credential channel exists for this plugin.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsCore = await readFile(path.join(pluginRoot, "../shared/lib/results.ts"), "utf8");

const surfaces = [
	{ core: "lib/wiki.ts", adapter: "src/query.adapter.ts", out: "tools/wiki-query.ts" },
	{ core: "lib/wiki.ts", adapter: "src/propose.adapter.ts", out: "tools/wiki-propose.ts" },
];

const banner = [
	"// GENERATED FILE — do not edit by hand.",
	"// Core: lib/wiki.ts + adapter: {ADAPTER}",
	"// Rebuild with: bun scripts/build.mjs",
	"",
].join("\n");

const keysBlock =
	"\n// Keyless build. No credentials are read; wiki access is a local python3 call (WIKI_ROOT, default ~/jjongguet/personal-wiki).\n";

for (const surface of surfaces) {
	const stripLocalImports = text => text.replace(/^import .* from ["']\..*["'];?\r?\n/gm, "");
	const core = stripLocalImports(await readFile(path.join(pluginRoot, surface.core), "utf8"));
	const adapter = stripLocalImports(await readFile(path.join(pluginRoot, surface.adapter), "utf8"));
	const header = banner.replace("{ADAPTER}", surface.adapter);
	await mkdir(path.dirname(path.join(pluginRoot, surface.out)), { recursive: true });
	await writeFile(
		path.join(pluginRoot, surface.out),
		`${header}\n${resultsCore.trimEnd()}\n${core.trimEnd()}\n${keysBlock}\n${adapter.trimStart()}`,
		"utf8",
	);
	console.log(`built ${surface.out} (keyless)`);
}
