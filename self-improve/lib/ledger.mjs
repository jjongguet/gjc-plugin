/**
 * Append-only JSONL ledger with a sha256 prev-hash chain.
 * Rows are the committed proof stream for self-improve cycles.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  LEDGER_SCHEMA,
  MAX_LEDGER_ROW_BYTES,
  sha256Hex,
  validateAdoptionRow,
  validateCycleRow,
  validatePolicyRow,
} from "./types.mjs";

function parseEntries(rawText) {
  const entries = [];
  const lines = rawText.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  for (const line of lines) {
    if (line.trim() === "") continue;
    const row = JSON.parse(line);
    entries.push({ row, raw: line, hash: sha256Hex(line) });
  }
  return entries;
}

function loadEntries(filePath) {
  if (!existsSync(filePath)) return [];
  return parseEntries(readFileSync(filePath, "utf8"));
}

export function readLedger(filePath) {
  return loadEntries(filePath).map((entry) => entry.row);
}

export function verifyChain(filePath) {
  const entries = loadEntries(filePath);
  let previousHash = null;
  for (let i = 0; i < entries.length; i += 1) {
    const { row, hash } = entries[i];
    const expectedSeq = i + 1;
    if (row.seq !== expectedSeq) {
      return { ok: false, count: entries.length, brokenAt: expectedSeq, reason: "seq_mismatch" };
    }
    if ((row.prev ?? null) !== previousHash) {
      return { ok: false, count: entries.length, brokenAt: expectedSeq, reason: "prev_mismatch" };
    }
    previousHash = hash;
  }
  return { ok: true, count: entries.length, brokenAt: null, reason: null };
}

export function appendRow(filePath, rowData) {
  const entries = loadEntries(filePath);
  const last = entries.length > 0 ? entries[entries.length - 1] : null;
  const row = {
    schema: LEDGER_SCHEMA,
    ...rowData,
    seq: entries.length + 1,
    prev: last ? last.hash : null,
  };
  if (row.kind === "cycle") {
    validateCycleRow(row);
    const duplicate = entries.find((entry) => entry.row.kind === "cycle" && entry.row.cycleId === row.cycleId);
    if (duplicate) {
      throw new Error(`duplicate_cycle: cycleId ${row.cycleId} already recorded at seq ${duplicate.row.seq}`);
    }
  } else if (row.kind === "adoption") {
    validateAdoptionRow(row);
    const duplicate = entries.find((entry) => entry.row.kind === "adoption" && entry.row.cycleId === row.cycleId);
    if (duplicate) {
      throw new Error(`duplicate_adoption: cycleId ${row.cycleId} already recorded at seq ${duplicate.row.seq}`);
    }
  } else if (row.kind === "policy") {
    validatePolicyRow(row);
    const duplicate = entries.find((entry) => entry.row.kind === "policy" && entry.row.policyId === row.policyId);
    if (duplicate) {
      throw new Error(`duplicate_policy: policyId ${row.policyId} already recorded at seq ${duplicate.row.seq}`);
    }
  } else {
    throw new Error(`unknown ledger row kind: ${String(row.kind)}`);
  }
  const line = JSON.stringify(row);
  const bytes = Buffer.byteLength(line, "utf8");
  if (bytes > MAX_LEDGER_ROW_BYTES) {
    throw new Error(`ledger_row_too_large: ${bytes} bytes exceeds ${MAX_LEDGER_ROW_BYTES}`);
  }
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${line}\n`);
  return { seq: row.seq, hash: sha256Hex(line), bytes };
}

export function ledgerCounts(filePath) {
  const entries = loadEntries(filePath);
  const byKind = { cycle: 0, adoption: 0, policy: 0 };
  const byVerdict = { adopt: 0, reject: 0, inconclusive: 0 };
  const cost = { cycleRows: 0, wallMsMeasured: 0, bytesMeasured: 0, tokensMeasured: 0, tokensNull: 0 };
  for (const { row } of entries) {
    if (byKind[row.kind] !== undefined) byKind[row.kind] += 1;
    if (row.kind !== "cycle") continue;
    cost.cycleRows += 1;
    if (typeof row.cost?.wallMs === "number") cost.wallMsMeasured += 1;
    if (typeof row.cost?.bytes === "number") cost.bytesMeasured += 1;
    if (row.cost?.tokens === null || row.cost?.tokens === undefined) cost.tokensNull += 1;
    else if (typeof row.cost.tokens === "number") cost.tokensMeasured += 1;
    if (byVerdict[row.verdict?.decision] !== undefined) {
      byVerdict[row.verdict.decision] += 1;
    }
  }
  return { total: entries.length, byKind, byVerdict, cost, chain: verifyChain(filePath) };
}
