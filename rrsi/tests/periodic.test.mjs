// Receipt-bearing node:test harness for the rrsi periodic refresh.
//
// This file is eligible for `verification_run` (a repository-relative `.mjs`
// node:test file). It delegates plugin execution to bun via spawnSync:
//   1. the full hermetic acceptance suite (rrsi/scripts/verify.ts), which now
//      includes the periodic invariants (due matrix, locks, one-slot writer,
//      receipts, isolation, kill switch), and
//   2. one directly observed periodic cycle under an isolated HOME
//      (rrsi/tests/periodic-harness-child.mjs).
// Keyless and offline; the user's real store is never touched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const plugin = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Resolve bun even under a restricted runner PATH (verification_run): env
// override, common install locations, then a shell lookup, then PATH default.
function resolveBun() {
	if (process.env.BUN_BIN) return process.env.BUN_BIN;
	const candidates = [
		path.join(os.homedir(), ".bun", "bin", "bun"),
		"/opt/homebrew/bin/bun",
		"/usr/local/bin/bun",
		"/usr/bin/bun",
	];
	for (const candidate of candidates) {
		try {
			if (statSync(candidate).isFile()) return candidate;
		} catch {
			/* keep looking */
		}
	}
	const found = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" });
	const line = (found.stdout || "").trim().split("\n")[0];
	return line || "bun";
}

const bun = resolveBun();

test("hermetic rrsi acceptance (incl. periodic invariants) passes under bun", { timeout: 300000 }, () => {
	const result = spawnSync(bun, [path.join(plugin, "scripts/verify.ts")], { encoding: "utf8", timeout: 300000, env: { ...process.env } });
	assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
	const periodicCases = (result.stdout.match(/ok \d+ periodic/g) || []).length;
	assert.ok(periodicCases >= 8, `periodic cases observed=${periodicCases}`);
	const summaryLine = result.stdout
		.trim()
		.split("\n")
		.filter((line) => line.startsWith('{"kind":"rrsi-plugin-acceptance"'))
		.pop();
	assert.ok(summaryLine, "the acceptance summary line is present");
	const summary = JSON.parse(summaryLine);
	assert.equal(summary.failures, 0);
	assert.ok(summary.cases >= 25, `cases=${summary.cases}`);
});

test("periodic cycle observed directly: no_input -> ran -> skipped_due -> unchanged with byte-stable store", { timeout: 300000 }, () => {
	const child = path.join(plugin, "tests", "periodic-harness-child.mjs");	const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rrsi-periodic-child-")));
	try {
		const result = spawnSync(bun, [child], { encoding: "utf8", timeout: 180000, env: { ...process.env, HOME: home, TMPDIR: home } });
		assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
		const line = result.stdout.trim().split("\n").filter(Boolean).pop();
		const observed = JSON.parse(line);
		assert.equal(observed.empty, "no_input");
		assert.equal(observed.first, "ran");
		assert.equal(observed.firstStoreWrite, "added");
		assert.equal(observed.second, "skipped_due");
		assert.equal(observed.third, "unchanged");
		assert.equal(observed.thirdStoreWrite, "unchanged");
		assert.equal(observed.storeStable, true, "the unchanged rerun must leave store bytes identical");
		assert.equal(observed.receipts, 2, "one receipt per fired run (ran + unchanged)");
		assert.equal(observed.outcomes, 3, `one journal record per executed run (no_input + ran + unchanged); journalStorage=${JSON.stringify(observed.firstJournalStorage)}`);
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
});

test("the generated hook surface carries the v2 quality contract and the prefix-cut flag", () => {
	const hook = readFileSync(path.join(plugin, "hooks", "rrsi-periodic.ts"), "utf8");
	const tool = readFileSync(path.join(plugin, "tools", "rrsi.ts"), "utf8");
	for (const surface of [hook, tool]) {
		// The canonical gjc.quality_trial.v2 validator is inlined, and the v1
		// boolean permission field is gone from every generated surface.
		assert.ok(surface.includes('"gjc.quality_trial.v2"'), "v2 trial schema is inlined");
		assert.ok(surface.includes("conflicting_duplicate"), "duplicate exclusion taxonomy is inlined");
		assert.equal(surface.includes("efficacyClaimsAllowed"), false, "no boolean efficacy permission survives");
	}
	assert.ok(hook.includes("incomplete_prefix"), "the periodic surface reports a prefix cut");
});
