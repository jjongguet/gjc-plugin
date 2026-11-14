// Concatenate src/core.ts with each adapter into a standalone hook module (same
// pattern as verification-receipts/scripts/build.mjs). GJC loads every manifest
// hook entry as its own module, so each event gets its own file. `--check` fails
// when a committed hook is out of sync with its sources.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const check = process.argv.includes("--check");
const OUTPUTS = [
	["src/adapter.ts", "hooks/jev-checkpoint.ts"],
	["src/shutdown.adapter.ts", "hooks/jev-checkpoint-shutdown.ts"],
];
const stripLocalImports = (text) => text.replace(/^import\s+(?:type\s+)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)?\s*from\s+['"]\.[^'"]*['"];?\r?\n/gm, "");
for (const [adapter, out] of OUTPUTS) {
	const parts = await Promise.all(["src/core.ts", adapter].map(async (file) => stripLocalImports(await readFile(path.join(root, file), "utf8"))));
	const body = `// GENERATED — edit src/, then node self-improve/jev-checkpoint/plugin/scripts/build.mjs. Experiment-only standalone hook.\n${parts.join("\n")}`;
	if (check) {
		if ((await readFile(path.join(root, out), "utf8")) !== body) throw new Error(`generated_out_of_sync:${out}`);
	} else {
		await mkdir(path.dirname(path.join(root, out)), { recursive: true });
		await writeFile(path.join(root, out), body);
	}
	console.log(`${check ? "checked" : "built"} ${out}`);
}
