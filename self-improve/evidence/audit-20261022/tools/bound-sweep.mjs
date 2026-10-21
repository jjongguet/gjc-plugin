#!/usr/bin/env node
/**
 * Bound-row sweep: re-executes every distinct `binding_command` declared by a
 * PASS row with `binding_strength=bound`, and reports how many rows each
 * command covers.
 *
 * The claims checker validates quotes, evidence digests and dispositions but
 * deliberately does not execute the declared commands; this tool is the
 * execution half. It fails closed: a non-zero exit from any distinct command
 * makes the sweep exit 1 and the uncovered rows stay uncovered.
 *
 * Usage: node tools/bound-sweep.mjs [--out <file>]
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const claimsFile = path.join(repoRoot, "self-improve", "evidence", "audit-20261022", "claims.csv");

// Minimal RFC4180 reader; mirrors the checker's parseCsv so the sweep cannot
// silently disagree with it about row boundaries.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((entry) => entry.length > 1 || entry[0] !== "");
}

const REQUIRED = ["id", "verdict", "binding_strength", "binding_command"];

if (!existsSync(claimsFile)) {
  process.stderr.write("bound-sweep: missing claims.csv\n");
  process.exit(2);
}
const [header, ...rows] = parseCsv(readFileSync(claimsFile, "utf8"));
for (const column of REQUIRED) {
  if (!header.includes(column)) {
    process.stderr.write(`bound-sweep: claims.csv header lacks ${column}\n`);
    process.exit(2);
  }
}
const records = rows.map((row) => Object.fromEntries(header.map((column, index) => [column, row[index]])));
const bound = records.filter((record) => record.verdict === "PASS" && record.binding_strength === "bound");
const mixed = records.filter((record) => record.binding_strength === "bound" && record.verdict !== "PASS");
if (mixed.length > 0) {
  process.stderr.write(`bound-sweep: ${mixed.length} row(s) carry bound strength without PASS\n`);
  process.exit(2);
}

const byCommand = new Map();
for (const record of bound) {
  if (!record.binding_command) {
    process.stderr.write(`bound-sweep: ${record.id} is bound but has no binding_command\n`);
    process.exit(2);
  }
  const ids = byCommand.get(record.binding_command) ?? [];
  ids.push(record.id);
  byCommand.set(record.binding_command, ids);
}

const results = [];
let remaining = bound.length;
for (const [command, ids] of byCommand) {
  const startedAt = Date.now();
  const probe = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 900000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const status = probe.status ?? (probe.signal ? 1 : 0);
  results.push({ command, rows: ids.length, exitCode: status, durationMs: Date.now() - startedAt, signal: probe.signal ?? null });
  if (status === 0) remaining -= ids.length;
}

const outIndex = process.argv.indexOf("--out");
const lines = [
  "# Bound-row sweep",
  "",
  "Every distinct `binding_command` declared by a PASS row with",
  "`binding_strength=bound`, executed once in the repository root. A failing",
  "command leaves its rows unverified; the sweep exits non-zero.",
  "",
  `claims.csv rows: ${records.length} · bound rows: ${bound.length} · distinct commands: ${byCommand.size}`,
  "",
  "| command | rows | exit | duration ms |",
  "| --- | --- | --- | --- |",
  ...results.map((result) => `| \`${result.command.replaceAll("|", "\\|")}\` | ${result.rows} | ${result.exitCode} | ${result.durationMs} |`),
  "",
  `verified rows: ${bound.length - remaining}/${bound.length} · failing commands: ${results.filter((result) => result.exitCode !== 0).length}`,
];
const rendered = lines.join("\n") + "\n";
process.stdout.write(rendered);
if (outIndex >= 0) {
  const target = path.resolve(repoRoot, process.argv[outIndex + 1]);
  writeFileSync(target, rendered);
  process.stderr.write(`bound-sweep: wrote ${path.relative(repoRoot, target)}\n`);
}
const failed = results.filter((result) => result.exitCode !== 0);
if (failed.length > 0) {
  for (const result of failed) {
    process.stderr.write(`bound-sweep: FAIL exit=${result.exitCode} rows=${result.rows} ${result.command}\n`);
  }
  process.exit(1);
}
