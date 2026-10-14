#!/usr/bin/env node
/**
 * Runs the self-improve node:test integration suite and prints a bounded summary
 * in the repository's "ALL PASS (N cases)" convention (see verify-unit.mjs).
 * This runner is part of the `test:self-improve` chain, so the integration suite
 * joins every cycle's `test` guard. Zero cases is a failure.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// The suite runs with cwd at the repository root: the engine's patch parsing
// follows git's restriction that `git apply` ignores paths outside the current
// directory when invoked from a repository subdirectory.
const REPO_ROOT = resolve(SELF_IMPROVE_DIR, "..");
const INTEGRATION_DIR = join(SELF_IMPROVE_DIR, "tests", "integration");

const testFiles = readdirSync(INTEGRATION_DIR)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(INTEGRATION_DIR, name));

if (testFiles.length === 0) {
  process.stderr.write("FAIL (0 cases): no *.test.mjs files found in tests/integration\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
  cwd: REPO_ROOT,
  encoding: "utf8",
});

const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
const testsMatch = output.match(/^# tests (\d+)$/m);
const passMatch = output.match(/^# pass (\d+)$/m);
const failMatch = output.match(/^# fail (\d+)$/m);
const cases = testsMatch ? Number.parseInt(testsMatch[1], 10) : 0;
const pass = passMatch ? Number.parseInt(passMatch[1], 10) : 0;
const fail = failMatch ? Number.parseInt(failMatch[1], 10) : 0;

if (result.status === 0 && cases > 0) {
  process.stdout.write(`ALL PASS (${cases} cases)\n`);
  // Carry the boundary diagnostics into green runs: planned guard ids, guard
  // statuses, and recorded skips must stay visible even when the suite passes.
  const carried = output.split("\n").filter((line) =>
    line.startsWith("# plan:") || line.startsWith("# integration guards:") || /^# skipped [1-9]/.test(line) || line.includes("# SKIP "));
  if (carried.length) process.stdout.write(carried.join("\n") + "\n");
  process.exitCode = 0;
} else {
  process.stdout.write(output);
  const detail = `status=${result.status ?? "null"}${result.signal ? `, signal=${result.signal}` : ""}${result.error ? `, error=${result.error.message}` : ""}`;
  process.stderr.write(`FAIL (${cases} cases, ${pass} pass, ${fail} fail, ${detail})\n`);
  process.exitCode = 1;
}
