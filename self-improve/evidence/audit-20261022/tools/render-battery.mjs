#!/usr/bin/env node
/**
 * Render battery.md from battery-results.json. Exits non-zero when any recorded
 * command failed, so the rendered table can never claim a green battery while a
 * command exited non-zero.
 *
 * Usage: node tools/render-battery.mjs
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(here, "..");
const repoRoot = path.resolve(auditDir, "..", "..", "..");
const resultsFile = path.join(auditDir, "battery-results.json");
if (!existsSync(resultsFile)) {
  process.stderr.write("render-battery: missing battery-results.json (run tools/run-battery.mjs first)\n");
  process.exit(2);
}

const { base, executedAt, results } = JSON.parse(readFileSync(resultsFile, "utf8"));
const EXPECTED = 12;
if (results.length !== EXPECTED) {
  process.stderr.write(`render-battery: expected ${EXPECTED} commands, found ${results.length}; a partial run cannot render the canonical battery (use battery-results-partial.json for subsets)\n`);
  process.exit(2);
}
const failed = results.filter((row) => row.exitCode !== 0);
const lines = [
  "# Battery",
  "",
  `Base: \`${base}\`. Executed ${executedAt}. Every row is produced by`,
  "`tools/run-battery.mjs`, which records the real exit status and keeps the",
  "captured output under [`battery-logs/`](battery-logs/). A non-zero exit fails",
  "this renderer; a command that did not run has no row.",
  "",
  "| command | exit | duration ms | log sha256 |",
  "| --- | --- | --- | --- |",
];
for (const row of results) {
  lines.push(`| \`${row.command}\` | ${row.exitCode} | ${row.durationMs} | \`${row.logSha256}\` |`);
}
lines.push("", `Commands: ${results.length}. Failed: ${failed.length}. Logs: \`battery-logs/\` (committed).`);
if (failed.length > 0) {
  lines.push("", "Failed commands:");
  for (const row of failed) lines.push(`- \`${row.command}\` exit ${row.exitCode}`);
}
writeFileSync(path.join(auditDir, "battery.md"), lines.join("\n") + "\n");
process.stdout.write(`battery.md rendered: commands=${results.length} failed=${failed.length}\n`);
process.exit(failed.length === 0 ? 0 : 1);
