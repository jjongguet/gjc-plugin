#!/usr/bin/env bun
// Bundles the plugin core + adapter into the single generated tool surface GJC loads.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE = ["lib/catalog.ts", "lib/usage.ts", "lib/report.ts"];
const ADAPTER = "src/audit.adapter.ts";
// Every relative import is stripped from the sources, so the generated file carries its own node imports.
const HEADER = [
	'import { createHash } from "node:crypto";',
	'import { readdirSync, readFileSync, statSync } from "node:fs";',
	'import { homedir } from "node:os";',
	'import path from "node:path";',
].join("\n");
// Sources keep one import statement per line; only those lines are dropped.
const stripImports = text =>
	text
		.split("\n")
		.filter(line => !/^import\b/.test(line))
		.join("\n")
		.trim();

const parts = [];
for (const file of [...CORE, ADAPTER]) parts.push(stripImports(await readFile(path.join(root, file), "utf8")));
const output = `// GENERATED FILE — do not edit by hand.
// Core: ${CORE.join(" + ")} + adapter: ${ADAPTER}
// Rebuild with: bun skill-audit/scripts/build.mjs

${HEADER}

${parts.join("\n\n")}
`;
const target = path.join(root, "tools/skill-audit.ts");
if (process.argv.includes("--check")) {
	if ((await readFile(target, "utf8")) !== output) throw new Error("skill-audit generated surface drift");
	console.log("skill-audit generated surface in sync");
} else {
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, output, "utf8");
	console.log("built tools/skill-audit.ts");
}
