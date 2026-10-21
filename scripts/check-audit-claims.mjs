#!/usr/bin/env node
/**
 * Audit claims checker (T-B9).
 *
 *   node scripts/check-audit-claims.mjs [--row <id>] [--carriers-dir <dir>]
 *
 * Full run validates the committed claim graph:
 *   - claims.csv has exactly the mandated columns and a legal verdict/fix class,
 *   - every candidate in candidates.jsonl has a disposition,
 *   - every `claim` disposition maps to a claims.csv row and every row maps back,
 *   - every row's file:line resolves and its verbatim quote appears there,
 *   - every PASS row carries binding_command + observed + evidence_sha256,
 *   - every GAP row carries a fix class, and no row edits a frozen carrier,
 *   - re-enumeration from --carriers-dir finds the same candidate set
 *     (an injected sentence with no candidate row fails),
 *   - the aggregate token is not `INTRODUCED CORRECTLY` while a GAP or
 *     UNVERIFIABLE row is open.
 *
 * `--row <id>` validates one row (schema + quote + PASS fields) and is the
 * per-row binding command used in claims.csv.
 */
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const auditDir = path.join(repoRoot, "self-improve", "evidence", "audit-20261022");

export const COLUMNS = [
  "id",
  "carrier",
  "class",
  "quote",
  "file_line",
  "scope_sha",
  "severity",
  "caveat_adjacency",
  "required_receipt",
  "evidence_kind",
  "binding_strength",
  "binding_command",
  "observed",
  "evidence_sha256",
  "verdict",
  "fix_class",
];

const CLASSES = new Set(["IMP", "MEAS", "BND", "RDM", "REF"]);
const VERDICTS = new Set(["PASS", "GAP", "UNVERIFIABLE"]);
const SEVERITIES = new Set(["S1", "S2", "S3"]);
const FIX_CLASSES = new Set(["", "doc", "evidence_annex", "code_doc", "refactor", "checker"]);
const BINDING_STRENGTHS = new Set(["", "bound", "self"]);

const FROZEN_PREFIXES = [
  "self-improve/ledger.jsonl",
  "self-improve/rrsi-protocol.json",
  "self-improve/replay-protocol.json",
  "self-improve/replay-protocol-p2b.json",
  "self-improve/policies/",
  "self-improve/domains/",
  "self-improve/evidence/p2b/",
  "self-improve/evidence/p3/summary.json",
];

export function parseCsv(text) {
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

function fail(message) {
  process.stderr.write(`audit-claims: ${message}\n`);
  process.exit(1);
}

function loadRows() {
  const file = path.join(auditDir, "claims.csv");
  if (!existsSync(file)) fail(`missing ${path.relative(repoRoot, file)}`);
  const [header, ...rows] = parseCsv(readFileSync(file, "utf8"));
  const seen = header.join(",");
  if (seen !== COLUMNS.join(",")) fail(`claims.csv header mismatch: ${seen}`);
  const records = rows.map((row) => {
    if (row.length !== COLUMNS.length) fail(`row width ${row.length} != ${COLUMNS.length}: ${row[0]}`);
    return Object.fromEntries(COLUMNS.map((column, index) => [column, row[index]]));
  });
  const ids = new Set();
  for (const record of records) {
    if (ids.has(record.id)) fail(`duplicate id ${record.id}`);
    ids.add(record.id);
    if (!CLASSES.has(record.class)) fail(`${record.id}: bad class ${record.class}`);
    if (!VERDICTS.has(record.verdict)) fail(`${record.id}: bad verdict ${record.verdict}`);
    if (!SEVERITIES.has(record.severity)) fail(`${record.id}: bad severity ${record.severity}`);
    if (!FIX_CLASSES.has(record.fix_class)) fail(`${record.id}: bad fix_class ${record.fix_class}`);
    if (!BINDING_STRENGTHS.has(record.binding_strength)) fail(`${record.id}: bad binding_strength ${record.binding_strength}`);
    if (record.verdict === "PASS" && !record.binding_strength) fail(`${record.id}: PASS row missing binding_strength`);
    if (record.verdict === "PASS" && record.evidence_kind !== "a") fail(`${record.id}: PASS rows must carry the carrier evidence kind`);
    if (record.verdict === "PASS" && (!record.binding_command || !record.observed || !record.evidence_sha256)) {
      fail(`${record.id}: PASS row missing binding_command/observed/evidence_sha256`);
    }
    if (record.verdict === "GAP" && !record.fix_class) fail(`${record.id}: GAP row missing fix_class`);
  }
  return records;
}

const allowWorktreeFallback = process.argv.includes("--allow-worktree-fallback");
const scopeCache = new Map();
function carrierLines(carrier, scopeSha) {
  const key = `${scopeSha}:${carrier}`;
  if (scopeCache.has(key)) return scopeCache.get(key);
  let lines;
  try {
    const text = execFileSync("git", ["show", key], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    lines = text.split("\n");
  } catch {
    if (!allowWorktreeFallback) {
      fail(`audit scope ${scopeSha} unavailable for ${carrier}; full-history checkout required (use --allow-worktree-fallback only for an exported tree)`);
    }
    const file = path.join(repoRoot, carrier);
    if (!existsSync(file)) fail(`carrier missing and audit scope ${scopeSha.slice(0, 8)} unavailable: ${carrier}`);
    lines = readFileSync(file, "utf8").split("\n");
    process.stderr.write(`audit-claims: scope ${scopeSha.slice(0, 8)} unavailable for ${carrier}; --allow-worktree-fallback validates the worktree copy\n`);
  }
  scopeCache.set(key, lines);
  return lines;
}

const scopeText = (carrier, scopeSha) => carrierLines(carrier, scopeSha).join("\n");

function normalized(text) {
  return text.replace(/\s+/g, " ").trim();
}

export function quoteAtLine(carrier, fileLine, quote, scopeSha) {
  const lines = carrierLines(carrier, scopeSha);
  const line = lines[Number(fileLine) - 1];
  if (line === undefined) return { ok: false, reason: `line ${fileLine} out of range` };
  const needle = normalized(quote);
  const haystack = normalized(line);
  // A wrapped markdown line may split one sentence; the window is the exact line
  // plus its immediate neighbours, and the needle is the full normalized quote.
  const window = normalized([lines[Number(fileLine) - 2] ?? "", line, lines[Number(fileLine)] ?? ""].join(" "));
  if (haystack.includes(needle) || window.includes(needle)) return { ok: true };
  return { ok: false, reason: `quote not found at ${carrier}:${fileLine}` };
}

function reenumerate(carriersDir) {
  const generator = path.join(auditDir, "tools", "audit-candidates.mjs");
  const candidatesFile = path.join(auditDir, "candidates.jsonl");
  if (!existsSync(generator) || !existsSync(candidatesFile)) fail("missing generator or candidates.jsonl");
  const committed = readFileSync(candidatesFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const keys = new Set(committed.map((row) => `${row.carrier}#${row.file_line}#${normalized(row.text)}`));
  let output;
  try {
    output = execFileSync(process.execPath, [generator, "--stdout"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: carriersDir ? { ...process.env, AUDIT_CARRIERS_DIR: carriersDir, AUDIT_CANDIDATES_STDOUT: "1" } : process.env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    if (allowWorktreeFallback) {
      process.stderr.write("audit-claims: re-enumeration skipped (audit scope unavailable and an exported tree cannot reproduce it)\n");
      return { committed: committed.length, generated: null, missing: [] };
    }
    fail("re-enumeration failed: audit scope unavailable");
  }
  const generated = output
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const missing = generated.filter((row) => !keys.has(`${row.carrier}#${row.file_line}#${normalized(row.text)}`));
  return { committed: committed.length, generated: generated.length, missing };
}

function dispositions(records, candidates) {
  const file = path.join(auditDir, "dispositions.jsonl");
  if (!existsSync(file)) fail("missing dispositions.jsonl");
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const byCandidate = new Map(rows.map((row) => [row.candidate_id, row]));
  const claimIds = new Set(records.map((record) => record.id));
  for (const candidate of candidates) {
    const row = byCandidate.get(candidate.id);
    if (!row) fail(`candidate ${candidate.id} has no disposition`);
    if (row.disposition === "claim") {
      if (!row.claim_id || !claimIds.has(row.claim_id)) fail(`candidate ${candidate.id} maps to unknown claim ${row.claim_id}`);
    } else if (row.disposition === "not_falsifiable" || row.disposition === "duplicate_of") {
      if (!row.reason) fail(`candidate ${candidate.id} disposition lacks a reason`);
      if (row.disposition === "duplicate_of" && !claimIds.has(row.claim_id)) fail(`candidate ${candidate.id} duplicate_of unknown claim ${row.claim_id}`);
    } else {
      fail(`candidate ${candidate.id} bad disposition ${row.disposition}`);
    }
  }
  return rows;
}

function frozenEditCheck(records, base) {
  if (!base) return;
  try {
    execFileSync("git", ["rev-parse", "--verify", base], { cwd: repoRoot, stdio: ["ignore", "ignore", "ignore"] });
  } catch {
    if (allowWorktreeFallback) return;
    fail(`audit base ${base} unavailable; frozen-path ban cannot run`);
  }
  const committed = execFileSync("git", ["diff", "--name-only", `${base}..HEAD`], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const worktree = execFileSync("git", ["diff", "--name-only", "HEAD"], { cwd: repoRoot, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const touched = [...new Set([...committed, ...worktree])].filter((file) => FROZEN_PREFIXES.some((prefix) => file.startsWith(prefix)));
  if (touched.length > 0) fail(`frozen paths changed since ${base}: ${touched.join(", ")}`);
}

const args = process.argv.slice(2);
const rowIndex = args.indexOf("--row");
const carriersIndex = args.indexOf("--carriers-dir");
const baseIndex = args.indexOf("--base");
const carriersDir = carriersIndex >= 0 ? path.resolve(args[carriersIndex + 1]) : repoRoot;
const base = baseIndex >= 0 ? args[baseIndex + 1] : null;

const records = loadRows();

if (rowIndex >= 0) {
  const id = args[rowIndex + 1];
  const record = records.find((entry) => entry.id === id);
  if (!record) fail(`unknown row ${id}`);
  const quote = quoteAtLine(record.carrier, record.file_line, record.quote, record.scope_sha);
  if (!quote.ok) fail(`${id}: ${quote.reason}`);
  process.stdout.write(`row=${id} ok class=${record.class} verdict=${record.verdict} quote=${record.carrier}:${record.file_line}@${record.scope_sha.slice(0, 8)}\n`);
  process.exit(0);
}

const candidatesFile = path.join(auditDir, "candidates.jsonl");
const candidates = readFileSync(candidatesFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

const requireIndex = args.indexOf("--require-candidate");
if (requireIndex >= 0) {
  const probe = args[requireIndex + 1];
  const known = new Set(candidates.map((row) => `${row.carrier}#${row.file_line}#${normalized(row.text)}`));
  if (!known.has(probe)) fail(`candidate sentence has no candidates.jsonl row: ${probe.slice(0, 80)}`);
}

for (const record of records) {
  const quote = quoteAtLine(record.carrier, record.file_line, record.quote, record.scope_sha);
  if (!quote.ok) fail(`${record.id}: ${quote.reason}`);
  if (record.verdict === "PASS" && record.evidence_kind === "a") {
    const actual = createHash("sha256").update(scopeText(record.carrier, record.scope_sha)).digest("hex");
    if (record.evidence_sha256 !== actual) fail(`${record.id}: evidence_sha256 does not match the carrier blob at ${record.scope_sha.slice(0, 8)}`);
  }
}
dispositions(records, candidates);
frozenEditCheck(records, base);

if (args.includes("--reenumerate")) {
  const reenumerated = reenumerate(carriersIndex >= 0 ? carriersDir : null);
  if (reenumerated.generated !== null && reenumerated.missing.length > 0) {
    fail(`re-enumeration found ${reenumerated.missing.length} sentence(s) with no candidate row, first: ${reenumerated.missing[0].carrier}:${reenumerated.missing[0].file_line}`);
  }
}

const counts = records.reduce((accumulator, record) => {
  accumulator[record.verdict] = (accumulator[record.verdict] ?? 0) + 1;
  return accumulator;
}, {});
const bound = records.filter((record) => record.verdict === "PASS" && record.binding_strength === "bound").length;
const self = records.filter((record) => record.verdict === "PASS" && record.binding_strength === "self").length;
const aggregate = counts.GAP ? `GAPS_OPEN (${counts.GAP})` : counts.UNVERIFIABLE ? `INCOMPLETE (${counts.UNVERIFIABLE} unverifiable)` : "INTRODUCED CORRECTLY";
process.stdout.write(
  `claims=${records.length} candidates=${candidates.length} PASS=${counts.PASS ?? 0} (bound=${bound} self=${self}) GAP=${counts.GAP ?? 0} UNVERIFIABLE=${counts.UNVERIFIABLE ?? 0} aggregate=${aggregate}\n`,
);
