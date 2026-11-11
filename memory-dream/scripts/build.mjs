#!/usr/bin/env bun
/**
 * Build the memory-dream surfaces from lib/ + src/.
 *
 *   bun scripts/build.mjs --check   -> non-mutating drift check (exit 1 on drift)
 *   bun scripts/build.mjs           -> generated tools/ and hooks/
 *
 * Generated files are committed so `gjc plugin install` needs no build step.
 * The core reads GJC memory and writes only its own private report directory.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const surfaces = [
	{ out: "tools/memory-dream.ts", adapter: "src/dream.adapter.ts", cores: ["lib/dream.ts"] },
	{
		out: "hooks/memory-dream-session-start.ts",
		adapter: "src/session-start.adapter.ts",
		cores: ["lib/notice.ts"],
	},
];

const banner = [
	"// GENERATED FILE - do not edit by hand.",
	"// Adapter: {ADAPTER}",
	"// Rebuild with: bun scripts/build.mjs",
	"",
].join("\n");

const stripRelativeImports = text => text.replace(/^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)?\s*from\s+['"]\.[^'"]*['"];?\r?\n/gm, "");

let drift = false;
for (const surface of surfaces) {
	const parts = [];
	for (const core of surface.cores) parts.push(stripRelativeImports(await readFile(path.join(root, core), "utf8")));
	parts.push(stripRelativeImports(await readFile(path.join(root, surface.adapter), "utf8")));
	const text = `${banner.replace("{ADAPTER}", surface.adapter)}\n${parts.join("\n").trimEnd()}\n`;
	const file = path.join(root, surface.out);
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
	console.log(`built ${surface.out}`);
}
if (check) {
	if (drift) process.exit(1);
	console.log(`generated surfaces are in sync: ${surfaces.map(surface => surface.out).join(", ")}`);
}
