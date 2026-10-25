#!/usr/bin/env node
/**
 * Build jev-advisor surface files from lib/decision.ts + src/*.adapter.ts.
 *
 *   node scripts/build.mjs --check   →  non-mutating drift check (exit 1 on drift)
 *   node scripts/build.mjs   →  hooks/, tools/ at the plugin root
 *
 * ALWAYS keyless: the generated surfaces are committed for one-command
 * distribution, so the repo tree can never contain a key. Activation is a
 * single channel by design — the file ~/.gjc/agent/jev-advisor/.env (or
 * exported env vars, which win over the file). Keyless providers (ollaya)
 * need nothing.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const resultsCore = await readFile(path.join(pluginRoot, "../shared/lib/results.ts"), "utf8");
const decisionContract = await readFile(path.join(pluginRoot, "../shared/lib/decision-contract.ts"), "utf8");

const surfaces = [
	{ cores: ["lib/decision.ts"], adapter: "src/hook.adapter.ts", out: "hooks/jev-advisor.ts" },
	{ cores: ["lib/decision.ts"], adapter: "src/tool.adapter.ts", out: "tools/jev-advise.ts" },
	{ cores: ["lib/decision.ts"], adapter: "src/check.adapter.ts", out: "tools/jev-check.ts" },
	{ cores: ["lib/decision.ts"], adapter: "src/result.adapter.ts", out: "hooks/jev-advisor-result.ts" },
	{ cores: ["lib/decision.ts"], adapter: "src/metrics.adapter.ts", out: "tools/plugin-metrics.ts" },
	// Goal alignment: deterministic and keyless, so no provider prelude is inlined.
	{ cores: ["lib/alignment.ts"], adapter: "src/alignment.adapter.ts", out: "hooks/jev-advisor-alignment.ts", shared: false },
	{ cores: ["lib/alignment.ts"], adapter: "src/alignment-observe.adapter.ts", out: "hooks/jev-advisor-alignment-observe.ts", shared: false },
	{ cores: ["lib/alignment.ts"], adapter: "src/alignment-shutdown.adapter.ts", out: "hooks/jev-advisor-alignment-shutdown.ts", shared: false },
];

const banner = [
	"// GENERATED FILE — do not edit by hand.",
	"// Core: {CORES} + adapter: {ADAPTER}",
	"// Rebuild with: bun scripts/build.mjs",
	"",
].join("\n");

const keysBlock =
	"\n// Keyless build. Activation: ~/.gjc/agent/jev-advisor/.env or JEV_ADVISOR_API_KEY /\n// OPENROUTER_API_KEY env (env wins over the file), or JEV_ADVISOR_PROVIDER=ollaya (local, no key).\n";

const check = process.argv.includes("--check");
const stripLocalImports = text =>
	text
		.replace(/^import\s*\{[^}]*\}\s*from\s*["']\.[^"']*["'];?[ \t]*\r?\n/gm, "")
		.replace(/^import\s+[^;{\n]*?\s+from\s*["']\.[^"']*["'];?[ \t]*\r?\n/gm, "");
let drift = false;
for (const surface of surfaces) {
	const cores = surface.cores;
	const core = [];
	for (const file of cores) core.push(stripLocalImports(await readFile(path.join(pluginRoot, file), "utf8")));
	const adapter = stripLocalImports(await readFile(path.join(pluginRoot, surface.adapter), "utf8"));
	const header = banner
		.replace("{CORES}", cores.join(" + "))
		.replace("{ADAPTER}", surface.adapter);
	const file = path.join(pluginRoot, surface.out);
	const parts = [header];
	if (surface.shared !== false) parts.push(decisionContract.trimEnd(), resultsCore.trimEnd());
	for (const text of core) parts.push(text.trimEnd());
	if (surface.shared !== false) parts.push(keysBlock);
	parts.push(adapter.trimStart());
	const text = parts.join("\n");
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
