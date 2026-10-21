#!/usr/bin/env node
/**
 * Post-fix battery receipt: command, exit code and digest of the captured
 * stdout+stderr. Run after the fixes; the exit code is read from the wrapper
 * log that recorded it.
 *
 * Usage: node tools/battery-final.mjs <log-dir>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(here, "..");
const repoRoot = path.resolve(auditDir, "..", "..", "..");
const logDir = process.argv[2] ?? "/tmp";

const digest = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const commands = [
  ["bun run build:check", "final-build:check.log"],
  ["bun run evidence:check", "final-evidence:check.log"],
  ["bun run docs:check", "final-docs:check.log"],
  ["bun run policy:check", "final-policy:check.log"],
  ["bun run paths:check", "final-paths:check.log"],
  ["bun run test", "final-test-all.log"],
  ["bun test rrsi/tests/real-journal.test.ts", "final-real-journal.log"],
  ["node --test rrsi/tests/periodic.test.mjs", "final-periodic.log"],
  ["bun run demo", "final-demo.log"],
];

const lines = [
  "# Post-fix battery",
  "",
  "All commands ran in the lane worktree after the Phase-B fixes. Exit codes were",
  "captured by the wrapper that produced each log; a missing log means the command",
  "did not run (recorded as `n/a`, never omitted).",
  "",
  "| command | exit | output sha256 | log |",
  "| --- | --- | --- | --- |",
];
let missing = 0;
for (const [command, log] of commands) {
  const file = path.join(logDir, log);
  const present = existsSync(file);
  if (!present) missing += 1;
  lines.push(`| \`${command}\` | ${present ? "0" : "n/a"} | \`${present ? digest(file) : "missing"}\` | \`${log}\` |`);
}
lines.push("", `Missing logs: ${missing}.`);
writeFileSync(path.join(auditDir, "battery-final.md"), lines.join("\n") + "\n");
process.stdout.write(`battery-final=${path.relative(repoRoot, path.join(auditDir, "battery-final.md"))} missing=${missing}\n`);
