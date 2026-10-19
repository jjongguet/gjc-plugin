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

const surfaces = [
	{ core: "lib/decision.ts", adapter: "src/hook.adapter.ts", out: "hooks/jev-advisor.ts" },
	{ core: "lib/decision.ts", adapter: "src/tool.adapter.ts", out: "tools/jev-advise.ts" },
	{ core: "lib/decision.ts", adapter: "src/check.adapter.ts", out: "tools/jev-check.ts" },
	{ core: "lib/decision.ts", adapter: "src/result.adapter.ts", out: "hooks/jev-advisor-result.ts" },
	{ core: "lib/decision.ts", adapter: "src/metrics.adapter.ts", out: "tools/plugin-metrics.ts" },
];

const banner = [
	"// GENERATED FILE — do not edit by hand.",
	"// Core: lib/decision.ts + adapter: {ADAPTER}",
	"// Rebuild with: bun scripts/build.mjs",
	"",
].join("\n");

const keysBlock =
	"\n// Keyless build. Activation: ~/.gjc/agent/jev-advisor/.env or JEV_ADVISOR_API_KEY /\n// OPENROUTER_API_KEY env (env wins over the file), or JEV_ADVISOR_PROVIDER=ollaya (local, no key).\n";

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
