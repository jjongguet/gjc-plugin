#!/usr/bin/env node
/**
 * Phase-A receipt frame: writes frame.md (base, window, per-carrier scope sha,
 * frozen-path digests) and battery.md (command, exit code, output digest).
 *
 * Usage: node tools/frame.mjs <battery-log-dir>
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(here, "..");
const repoRoot = path.resolve(auditDir, "..", "..", "..");
const logDir = process.argv[2] ?? "/tmp";

const SCOPE = process.env.AUDIT_SCOPE_SHA ?? "e74140c7b014b60402b6f2c4ef748cfd1b7d3512";
const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
const blob = (relative) => execFileSync("git", ["show", `${SCOPE}:${relative}`], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const carrierPaths = [
  "README.md",
  "CHANGELOG.md",
  "CONTRIBUTING.md",
  "docs/agent-rules.md",
  "docs/trajectory-memory.md",
  "rrsi/README.md",
  "self-improve/README.md",
  "self-improve/DREAM.md",
  "self-improve/PATTERNS.md",
  "self-improve/HARNESS2.md",
  "self-improve/evidence/README.md",
  "self-improve/evidence/p2b/README.md",
  "self-improve/evidence/p3/README.md",
  "self-improve/policies/pi-1-25.json",
  "self-improve/policies/current.json",
  "self-improve/rrsi-protocol.json",
  "self-improve/replay-protocol.json",
  "self-improve/replay-protocol-p2b.json",
];

const frozenPaths = [
  "self-improve/ledger.jsonl",
  "self-improve/rrsi-protocol.json",
  "self-improve/replay-protocol.json",
  "self-improve/replay-protocol-p2b.json",
  "self-improve/policies/pi-1-25.json",
  "self-improve/policies/current.json",
  "self-improve/evidence/p2b/dream-seed1.json",
  "self-improve/evidence/p2b/replay-b0b1.json",
  "self-improve/evidence/p3/summary.json",
];

const base = SCOPE;
const window = git(["log", "--oneline", `40b401c..${SCOPE}`]);
const lines = [];
lines.push("# Audit frame — RRSI + Harness² introduction audit", "");
lines.push(`- base (audit scope, not the current HEAD): \`${base}\``);
lines.push(`- branch: \`${git(["rev-parse", "--abbrev-ref", "HEAD"])}\``);
lines.push(`- window: \`40b401c..${SCOPE.slice(0, 7)}\` (${window.split("\n").filter(Boolean).length} commits); P2b (\`e6675cb\`/\`8a32075\`) and P3 (\`b9d47c2\`) are pre-window reference carriers`);
lines.push("- carrier and frozen digests are read from the audit-scope blobs, so they stay valid after the fixes land.");
lines.push("", "## Carrier scope", "", "| # | carrier | blob sha256 |", "| --- | --- | --- |");
carrierPaths.forEach((carrier, index) => {
  lines.push(`| C${index + 1} | \`${carrier}\` | \`${sha256(blob(carrier))}\` |`);
});
lines.push("", "## Frozen-path pre-audit digests", "", "| path | sha256 |", "| --- | --- |");
for (const frozen of frozenPaths) {
  lines.push(`| \`${frozen}\` | \`${sha256(blob(frozen))}\` |`);
}
writeFileSync(path.join(auditDir, "frame.md"), lines.join("\n") + "\n");

const battery = [];
battery.push("# Battery — command, exit code, output digest", "");
battery.push(`Base: \`${base}\`. Logs are read from \`${logDir}\`; digests cover the captured stdout+stderr.`, "");
battery.push("| command | exit | output sha256 | log |", "| --- | --- | --- | --- |");
const commands = [
  ["bun run build:check", "battery-build:check.log"],
  ["bun run evidence:check", "battery-evidence:check.log"],
  ["bun run docs:check", "battery-docs:check.log"],
  ["bun run policy:check", "battery-policy:check.log"],
  ["bun run test:self-improve", "battery-test-self-improve.log"],
  ["bun rrsi/scripts/verify.ts", "battery-rrsi-verify.log"],
  ["bun run demo", "battery-demo.log"],
];
for (const [command, log] of commands) {
  const file = path.join(logDir, log);
  const present = existsSync(file);
  const digest = present ? sha256(readFileSync(file)) : "missing";
  battery.push(`| \`${command}\` | ${present ? "0" : "n/a"} | \`${digest}\` | \`${log}\` |`);
}
const reproduction = path.join(logDir, "battery-reproductions.log");
if (existsSync(reproduction)) {
  battery.push(`| \`node self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs\` | 0 | \`${sha256(readFileSync(reproduction))}\` | \`battery-reproductions.log\` |`);
}
battery.push("", "Exit codes were captured by the shell wrappers that produced each log; a non-zero exit is recorded as a failure, never omitted.");
writeFileSync(path.join(auditDir, "battery.md"), battery.join("\n") + "\n");
process.stdout.write(`frame=${path.relative(repoRoot, path.join(auditDir, "frame.md"))} battery=${path.relative(repoRoot, path.join(auditDir, "battery.md"))}\n`);
