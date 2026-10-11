#!/usr/bin/env node
/**
 * Runs the self-improve node:test unit suite and prints a bounded summary in the
 * repository's "ALL PASS (N cases)" convention (see jev-advisor/scripts/verify.ts).
 * Zero cases is a failure.
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const UNIT_DIR = join(SELF_IMPROVE_DIR, "tests", "unit");

const testFiles = readdirSync(UNIT_DIR)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort()
  .map((name) => join(UNIT_DIR, name));

if (testFiles.length === 0) {
  process.stderr.write("FAIL (0 cases): no *.test.mjs files found in tests/unit\n");
  process.exit(1);
}

const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...testFiles], {
  cwd: SELF_IMPROVE_DIR,
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
  process.exitCode = 0;
} else {
  process.stdout.write(output);
  const detail = `status=${result.status ?? "null"}${result.signal ? `, signal=${result.signal}` : ""}${result.error ? `, error=${result.error.message}` : ""}`;
  process.stderr.write(`FAIL (${cases} cases, ${pass} pass, ${fail} fail, ${detail})\n`);
  process.exitCode = 1;
}
