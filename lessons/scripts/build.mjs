#!/usr/bin/env bun
/**
 * Build the lessons surfaces from lib/ + src/.
 *
 *   bun scripts/build.mjs --check   -> non-mutating drift check (exit 1 on drift)
 *   bun scripts/build.mjs           -> generated tools/ and hooks/
 *
 * Generated files are committed so `gjc plugin install` needs no build step.
 * The select surfaces read one bounded ledger selection and write nothing; the
 * session_shutdown surface appends one bounded correction line to the plugin
 * data directory and never touches the wiki or a git repository.
 *
 * `lib/root.ts` is a core of every surface (one wiki-root chain for both tools),
 * so an identical module import repeated across cores is emitted once.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");

const surfaces = [
	{ out: "tools/lessons-select.ts", adapter: "src/select.adapter.ts", cores: ["lib/root.ts", "lib/select.ts"] },
	{ out: "tools/lessons-staged.ts", adapter: "src/staged.adapter.ts", cores: ["lib/root.ts", "lib/correction.ts"] },
	{
		out: "hooks/lessons-start.ts",
		adapter: "src/session-start.adapter.ts",
		cores: ["lib/root.ts", "lib/select.ts", "lib/notice.ts"],
	},
	{ out: "hooks/session-end.ts", adapter: "src/session-end.adapter.ts", cores: ["lib/root.ts", "lib/correction.ts"] },
];

const banner = [
	"// GENERATED FILE - do not edit by hand.",
	"// Adapter: {ADAPTER}",
	"// Rebuild with: bun lessons/scripts/build.mjs",
	"",
].join("\n");

const stripRelativeImports = text => text.replace(/^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)?\s*from\s*['"]\.[^'"]*['"];?\r?\n/gm, "");

// Two cores (or a core and its adapter) may import the same module identically;
// one concatenated file needs one binding, so an exact duplicate import line is
// emitted once. Distinct imports of the same module are both kept.
const dedupeImports = parts => {
	const seen = new Set();
	return parts.map(text =>
		text
			.split("\n")
			.filter(line => {
				if (!/^import\s[^\n]*from\s*["'][^"']*["'];?[ \t]*$/.test(line)) return true;
				if (seen.has(line)) return false;
				seen.add(line);
				return true;
			})
			.join("\n"),
	);
};

let drift = false;
for (const surface of surfaces) {
	const parts = [];
	for (const core of surface.cores) parts.push(stripRelativeImports(await readFile(path.join(root, core), "utf8")));
	parts.push(stripRelativeImports(await readFile(path.join(root, surface.adapter), "utf8")));
	const text = `${banner.replace("{ADAPTER}", surface.adapter)}\n${dedupeImports(parts).join("\n").trimEnd()}\n`;
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
