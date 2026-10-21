#!/usr/bin/env node
/**
 * Post-fix battery runner. Executes each command, keeps its captured output and
 * the real exit status, and writes battery-results.json. The markdown tables are
 * rendered from this JSON (never from log-file existence), so a failed command
 * cannot be recorded as a pass.
 *
 * Usage: node tools/run-battery.mjs [--only name,name]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const auditDir = path.resolve(here, "..");
const repoRoot = path.resolve(auditDir, "..", "..", "..");
const logDir = path.join(auditDir, "battery-logs");

const COMMANDS = [
  ["build-check", "bun", ["run", "build:check"]],
  ["evidence-check", "bun", ["run", "evidence:check"]],
  ["docs-check", "bun", ["run", "docs:check"]],
  ["policy-check", "bun", ["run", "policy:check"]],
  ["paths-check", "bun", ["run", "paths:check"]],
  ["audit-claims", "node", ["scripts/check-audit-claims.mjs", "--base", "e74140c", "--reenumerate"]],
  ["test-all", "bun", ["run", "test"]],
  ["rrsi-verify", "bun", ["rrsi/scripts/verify.ts"]],
  ["rrsi-real-journal", "bun", ["test", "rrsi/tests/real-journal.test.ts"]],
  ["rrsi-periodic", "node", ["--test", "rrsi/tests/periodic.test.mjs"]],
  ["demo", "bun", ["run", "demo"]],
  ["reproductions", "node", ["self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs"]],
];

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? new Set(process.argv[onlyIndex + 1].split(",")) : null;
mkdirSync(logDir, { recursive: true });

const results = [];
for (const [name, command, args] of COMMANDS) {
  if (only && !only.has(name)) continue;
  const startedAt = new Date().toISOString();
  const startedMs = Date.now();
  const proc = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, timeout: 3_600_000 });
  const stdout = proc.stdout ?? "";
  const stderr = proc.stderr ?? "";
  const logName = `${name}.log`;
  writeFileSync(path.join(logDir, logName), `$ ${command} ${args.join(" ")}\n${stdout}\n${stderr}`.trimEnd() + "\n");
  results.push({
    name,
    command: `${command} ${args.join(" ")}`,
    exitCode: proc.status,
    signal: proc.signal ?? null,
    error: proc.error ? String(proc.error.message ?? proc.error) : null,
    durationMs: Date.now() - startedMs,
    startedAt,
    log: path.relative(repoRoot, path.join(logDir, logName)),
    stdoutSha256: createHash("sha256").update(stdout).digest("hex"),
    stderrSha256: createHash("sha256").update(stderr).digest("hex"),
    logSha256: createHash("sha256").update(`${command} ${args.join(" ")}\n${stdout}\n${stderr}`.trimEnd() + "\n").digest("hex"),
  });
  process.stdout.write(`${name}: exit=${proc.status} durationMs=${results.at(-1).durationMs}\n`);
}

const failed = results.filter((row) => row.exitCode !== 0);
writeFileSync(
  path.join(auditDir, "battery-results.json"),
  `${JSON.stringify({ schema: "gjc.audit.battery.v1", base: "e74140c", executedAt: new Date().toISOString(), results }, null, 2)}\n`,
);
process.stdout.write(`battery: commands=${results.length} failed=${failed.length}\n`);
process.exit(failed.length === 0 ? 0 : 1);
