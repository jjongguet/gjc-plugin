#!/usr/bin/env node
/**
 * Build backplan plugin surface files from lib/backplan.ts + src/check.adapter.ts.
 *
 *   node scripts/build.mjs --check   →  non-mutating drift check (exit 1 on drift)
 *   node scripts/build.mjs   →  tools/ at the plugin root
 *
 * ALWAYS keyless: the generated surface is committed for one-command
 * distribution, so the repo tree can never contain a key. backplan_check is a
 * pure local validator/renderer — no credential channel and no network path
 * exist for this plugin.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsCore = await readFile(path.join(pluginRoot, "../shared/lib/results.ts"), "utf8");

const surfaces = [{ core: "lib/backplan.ts", adapter: "src/check.adapter.ts", out: "tools/backplan-check.ts" }];

const banner = [
	"// GENERATED FILE — do not edit by hand.",
	"// Core: lib/backplan.ts + adapter: {ADAPTER}",
	"// Rebuild with: bun scripts/build.mjs",
	"",
].join("\n");

const keysBlock =
	"\n// Keyless build. No credentials are read; backplan_check validates and renders locally — no network path exists.\n";

const check = process.argv.includes("--check");
const stripLocalImports = text => text.replace(/^import .* from ["']\..*["'];?\r?\n/gm, "");
let drift = false;
for (const surface of surfaces) {
	const core = stripLocalImports(await readFile(path.join(pluginRoot, surface.core), "utf8"));
	const adapter = stripLocalImports(await readFile(path.join(pluginRoot, surface.adapter), "utf8"));
	const header = banner.replace("{ADAPTER}", surface.adapter);
	const file = path.join(pluginRoot, surface.out);
	const text = `${header}\n${resultsCore.trimEnd()}\n${core.trimEnd()}\n${keysBlock}\n${adapter.trimStart()}`;
	if (check) {
		const existing = await readFile(file, "utf8").catch(() => null);
		if (existing !== text) {
			drift = true;
			process.stderr.write(`generated_out_of_sync:${surface.out}\n`);
		}
		continue;
	}
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, text, "utf8");
	console.log(`built ${surface.out} (keyless)`);
}
if (check) {
	if (drift) process.exit(1);
	console.log(`generated surfaces are in sync: ${surfaces.map(surface => surface.out).join(", ")}`);
}
