#!/usr/bin/env node
/**
 * Build jev-advisor surface files from lib/decision.ts + src/*.adapter.ts.
 *
 *   node scripts/build.mjs   →  hooks/, tools/ at the plugin root
 *
 * ALWAYS keyless: the generated surfaces are committed for one-command
 * distribution, so the repo tree can never contain a key. Activation is a
 * single channel by design — the file ~/.gjc/agent/jev-advisor/.env (or
 * exported env vars, which win over the file). Keyless providers (ollaya)
 * need nothing.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const surfaces = [
	{ core: "lib/decision.ts", adapter: "src/hook.adapter.ts", out: "hooks/jev-advisor.ts" },
	{ core: "lib/decision.ts", adapter: "src/tool.adapter.ts", out: "tools/jev-advise.ts" },
];

const banner = [
	"// GENERATED FILE — do not edit by hand.",
	"// Core: lib/decision.ts + adapter: {ADAPTER}",
	"// Rebuild with: bun scripts/build.mjs",
	"",
].join("\n");

const keysBlock =
	"\n// Keyless build. Activation: ~/.gjc/agent/jev-advisor/.env or JEV_ADVISOR_API_KEY /\n// OPENROUTER_API_KEY env (env wins over the file), or JEV_ADVISOR_PROVIDER=ollaya (local, no key).\n";

for (const surface of surfaces) {
	const core = await readFile(path.join(pluginRoot, surface.core), "utf8");
	const adapter = await readFile(path.join(pluginRoot, surface.adapter), "utf8");
	const header = banner.replace("{ADAPTER}", surface.adapter);
	await writeFile(
		path.join(pluginRoot, surface.out),
		`${header}\n${core.trimEnd()}\n${keysBlock}\n${adapter.trimStart()}`,
		"utf8",
	);
	console.log(`built ${surface.out} (keyless)`);
}
