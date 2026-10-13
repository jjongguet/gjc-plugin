import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = await readFile(path.join(root, "lib/memory.ts"), "utf8");
const adapter = (await readFile(path.join(root, "src/memory.adapter.ts"), "utf8")).replace(/^import .* from ["']\..*["'];?\r?\n/gm, "");
const output = `// GENERATED FILE — do not edit by hand.\n// Core: lib/memory.ts + adapter: src/memory.adapter.ts\n// Rebuild with: bun aside-memory/scripts/build.mjs\n\n${core.trimEnd()}\n\n${adapter.trimStart()}`;
const target = path.join(root, "tools/aside-memory.ts");
if (process.argv.includes("--check")) {
	if (await readFile(target, "utf8") !== output) throw new Error("aside-memory generated surface drift");
	console.log("aside-memory generated surface in sync");
} else {
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, output, "utf8");
	console.log("built tools/aside-memory.ts (keyless)");
}
