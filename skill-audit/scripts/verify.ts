#!/usr/bin/env bun
// Hermetic verification for the skill-audit plugin: fixtures only, no real HOME, no network.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.resolve(plugin, "..");
const cli = path.join(plugin, "scripts/skill-audit.ts");

let cases = 0;
let failures = 0;
const check = (name: string, fn: () => unknown | Promise<unknown>) => {
	return Promise.resolve()
		.then(fn)
		.then(() => {
			cases++;
			console.log(`ok ${cases} ${name}`);
		})
		.catch((error: unknown) => {
			cases++;
			failures++;
			console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
		});
};

function listing(root: string): string[] {
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const target = path.join(dir, entry.name);
			out.push(path.relative(root, target));
			if (entry.isDirectory()) walk(target);
		}
	};
	walk(root);
	return out.sort();
}

function writeSkill(home: string, name: string, body?: string) {
	const dir = path.join(home, ".gjc/agent/skills", name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture skill\n---\n\n${body ?? `Body of ${name}.`}\n`);
}

function writeTranscript(home: string, lines: string[]) {
	const dir = path.join(home, ".gjc/agent/sessions/v2-verify");
	mkdirSync(dir, { recursive: true });
	writeFileSync(path.join(dir, "2026-01-01T00-00-00-000Z_verify.jsonl"), `${lines.join("\n")}\n`);
}

const skillLine = (skill: string, at: string) =>
	JSON.stringify({
		type: "message",
		id: `m_${skill}`,
		timestamp: at,
		message: { role: "assistant", content: [{ type: "toolCall", id: `c_${skill}`, name: "skill", arguments: { name: skill } }] },
	});

const runCli = (args: string[], home: string, cwd: string) =>
	spawnSync(process.execPath, ["--no-env-file", cli, ...args], {
		cwd,
		encoding: "utf8",
		timeout: 120000,
		env: { HOME: home, PATH: process.env.PATH ?? "", TMPDIR: os.tmpdir(), LC_ALL: "C", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
	});

const root = mkdtempSync(path.join(os.tmpdir(), "skill-audit-verify-"));
try {
	const home = path.join(root, "home");
	const cwd = path.join(root, "cwd");
	mkdirSync(home, { recursive: true });
	mkdirSync(cwd, { recursive: true });

	await check("generated tool surface is in sync with its core", () => {
		const result = spawnSync(process.execPath, ["--no-env-file", path.join(plugin, "scripts/build.mjs"), "--check"], {
			env: process.env,
			encoding: "utf8",
			timeout: 30000,
		});
		assert.equal(result.status, 0, result.stderr);
		assert.match(result.stdout, /in sync/);
	});

	await check("manifest and repository registration stay wired", () => {
		const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8"));
		assert.equal(manifest.kind, "gajae-code-plugin");
		assert.equal(manifest.name, "skill-audit");
		assert.deepEqual(Object.keys(manifest).sort(), ["kind", "name", "tools", "version"]);
		assert.deepEqual(manifest.tools.map((tool: { name: string }) => tool.name), ["skill_audit"]);
		assert.equal(manifest.tools[0].path, "tools/skill-audit.ts");
		assert.deepEqual(manifest.tools[0].schema, { type: "object", properties: {}, additionalProperties: false });

		const index = JSON.parse(readFileSync(path.join(repo, "gjc-plugin.json"), "utf8"));
		assert.ok(index.plugins.includes("skill-audit/gajae-plugin.json"));

		const scripts = JSON.parse(readFileSync(path.join(repo, "package.json"), "utf8")).scripts;
		assert.equal(scripts["build:skill-audit"], "bun skill-audit/scripts/build.mjs");
		assert.equal(scripts["test:skill-audit"], "bun skill-audit/scripts/verify.ts && bun test skill-audit/tests/audit.test.ts");
		assert.match(scripts.build, /build:skill-audit$/);
		assert.match(scripts["build:check"], /skill-audit\/scripts\/build\.mjs --check$/);
		assert.match(readFileSync(path.join(repo, "README.md"), "utf8"), /\[`skill-audit`\]\(skill-audit\/\)/);
	});

	await check("tool surface accepts exactly {} and returns the read-only report", async () => {
		const module = await import(pathToFileURL(path.join(plugin, "tools/skill-audit.ts")).href);
		const stub = {
			typebox: {
				Type: {
					Object: (fields: Record<string, unknown>, options?: Record<string, unknown>) => ({
						type: "object",
						properties: fields,
						...options,
					}),
				},
			},
		};
		const tool = module.default(stub);
		assert.equal(tool.name, "skill_audit");
		assert.deepEqual(tool.parameters, { type: "object", properties: {}, additionalProperties: false });

		writeSkill(home, "alpha");
		writeTranscript(home, [skillLine("alpha", "2026-01-01T00:00:00.000Z")]);
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const response = await tool.execute("call_1", {});
			assert.equal(response.isError, false);
			const report = JSON.parse(response.content[0].text);
			assert.equal(report.report, "skill_audit");
			assert.equal(report.mode, "read_only");
			assert.equal(report.status, "complete");
			assert.equal(report.skills[0].verdict, "used");
			const rejected = await tool.execute("call_2", { path: "/tmp" });
			assert.equal(rejected.isError, true);
			assert.match(rejected.content[0].text, /invalid_input/);
		} finally {
			process.env.HOME = previousHome;
		}
	});

	await check("CLI reports candidates with evidence and exit code 1 on a measurable window", () => {
		writeSkill(home, "beta");
		const before = listing(home);
		const result = runCli(["--json"], home, cwd);
		assert.equal(result.status, 1, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.status, "complete");
		assert.equal(report.usage.status, "ok");
		assert.equal(report.usage.transcripts, 1);
		assert.equal(report.counts.installed, 2);
		assert.equal(report.counts.used, 1);
		assert.equal(report.counts.unused, 1);
		assert.deepEqual(
			report.candidates.unused.map((candidate: { name: string }) => candidate.name),
			["beta"],
		);
		assert.match(report.candidates.unused[0].basis, /0 skill tool calls and 0 prompt-only \/skill: invocations across 1 retained transcripts/);
		assert.deepEqual(report.usage.outside_roots, []);
		assert.deepEqual(listing(home), before, "the audit must not write into the scanned home");
	});

	await check("--out writes only the named report file", () => {
		const target = path.join(root, "reports/report.json");
		const result = runCli(["--json", "--out", target], home, cwd);
		assert.equal(result.status, 1, result.stderr);
		const written = JSON.parse(readFileSync(target, "utf8"));
		assert.equal(written.report, "skill_audit");
		assert.equal(written.schema_version, 1);
		assert.deepEqual(JSON.parse(result.stdout), written);
	});

	await check("an absent transcript log is unknown with exit code 2, not zero uses", () => {
		const emptyHome = path.join(root, "empty-home");
		mkdirSync(emptyHome, { recursive: true });
		const result = runCli(["--json"], emptyHome, cwd);
		assert.equal(result.status, 2, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.status, "unknown");
		assert.equal(report.usage.status, "unknown");
		assert.equal(report.counts.installed, 0);
		assert.equal(report.candidates.unused.length, 0);
		assert.match(readFileSync(path.join(repo, "skill-audit/scripts/skill-audit.ts"), "utf8"), /2  usage unknown or degraded/);

		writeSkill(emptyHome, "orphan");
		const withSkill = runCli(["--json"], emptyHome, cwd);
		assert.equal(withSkill.status, 2, withSkill.stderr);
		const orphan = JSON.parse(withSkill.stdout);
		assert.equal(orphan.status, "unknown");
		assert.equal(orphan.skills[0].used_count, null);
		assert.equal(orphan.skills[0].last_used, null);
		assert.equal(orphan.skills[0].verdict, "unknown");
		assert.deepEqual(orphan.candidates.unused, []);
	});

	await check("corrupt and unreadable transcript paths degrade instead of hiding evidence", () => {
		const brokenHome = path.join(root, "broken-home");
		mkdirSync(brokenHome, { recursive: true });
		writeSkill(brokenHome, "alpha");
		writeTranscript(brokenHome, [skillLine("alpha", "2026-01-01T00:00:00.000Z"), '{"type": "message", "skill": ']);
		mkdirSync(path.join(brokenHome, ".gjc/agent/sessions/v2-verify/broken.jsonl"), { recursive: true });

		const result = runCli(["--json"], brokenHome, cwd);
		assert.equal(result.status, 2, result.stderr);
		const report = JSON.parse(result.stdout);
		assert.equal(report.status, "partial");
		assert.equal(report.usage.status, "degraded");
		assert.equal(report.usage.corrupt_lines, 1);
		assert.equal(report.usage.unreadable_files, 1);
		assert.equal(report.skills[0].used_count, 1);
		assert.equal(report.skills[0].verdict, "used");
	});

	await check("--help exits 0 and an unknown argument exits 64", () => {
		const help = runCli(["--help"], home, cwd);
		assert.equal(help.status, 0);
		assert.match(help.stdout, /skill-audit — installed-vs-used audit/);
		const bad = runCli(["--nope"], home, cwd);
		assert.equal(bad.status, 64);
		assert.match(bad.stderr, /unknown argument: --nope/);
		const missing = runCli(["--out"], home, cwd);
		assert.equal(missing.status, 64);
	});

	await check("the audit never reaches the network and needs no credentials", () => {
		const sources = [readFileSync(path.join(plugin, "tools/skill-audit.ts"), "utf8"), readFileSync(cli, "utf8")].join("\n");
		for (const forbidden of ["node:http", "node:https", "node:net", "fetch(", "child_process", "API_KEY", "process.env.HOME || homedir()"]) {
			if (forbidden === "process.env.HOME || homedir()") {
				assert.ok(sources.includes(forbidden), "the home directory must come from the process environment");
				continue;
			}
			assert.ok(!sources.includes(forbidden), `unexpected capability: ${forbidden}`);
		}
	});
} finally {
	rmSync(root, { recursive: true, force: true });
}

console.log(JSON.stringify({ kind: "skill-audit-verify", cases, failures, realHomeReads: 0, networkCalls: 0 }));
console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
process.exitCode = failures || cases === 0 ? 1 : 0;
