/**
 * Append-only JSONL ledger with a sha256 prev-hash chain.
 * Rows are the committed proof stream for self-improve cycles.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  LEDGER_SCHEMA,
  MAX_LEDGER_ROW_BYTES,
  isPlainObject,
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

/**
 * Composition provenance (Harness² M2): independent candidate identity, the
 * record that binds a composed patch to the candidates it was built from, and
 * a row-size-bounded form for the append-only ledger.
 *
 * The identity is recomputable from the candidate's own objective and patch
 * bytes, so it survives being carried between processes and cannot be
 * re-labelled by the composition that consumes it.
 */
export const COMPOSITION_SCHEMA = "gjc.self-improve.compose.v1";
export const MIN_COMPOSITION_SOURCES = 2;
export const MAX_COMPOSITION_SOURCES = 4;
export const MAX_COMPOSITION_EVIDENCE_BYTES = 1024;
export const CANDIDATE_ID_RE = /^cand-[0-9a-f]{12}$/;
const CANDIDATE_VERDICTS = Object.freeze(["adopt", "reject"]);
const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_SOURCE_OBJECTIVE_CHARS = 40;
const MAX_SOURCE_REASONS = 2;
const MAX_SOURCE_REASON_CHARS = 20;

export function candidateProposalId({ objective, patchSha256 }) {
  if (typeof objective !== "string" || objective.length === 0) {
    throw new Error("candidate_objective_required");
  }
  if (typeof patchSha256 !== "string" || !HEX64_RE.test(patchSha256)) {
    throw new Error("candidate_patch_sha256_invalid");
  }
  return `cand-${sha256Hex(`${objective}\n${patchSha256}`).slice(0, 12)}`;
}

const provenanceMissing = (detail) => ({ ok: false, reason: "composition_provenance_missing", detail });
const provenanceMismatch = (detail) => ({ ok: false, reason: "composition_provenance_mismatch", detail });

/**
 * Verify a composition record against the composed patch it claims to explain.
 * Source ids are re-derived rather than trusted, the record is bound to this
 * exact patch text, and every source carries its own objective and patch sha:
 * a record with a missing source, a hand-written id or a digest that belongs to
 * a different patch is refused instead of recorded.
 */
export function validateCompositionEvidence({ composition, patchText, requireBaseline = true }) {
  if (!isPlainObject(composition)) return provenanceMissing("composition_not_an_object");
  if (composition.schema !== COMPOSITION_SCHEMA) return provenanceMissing("schema_mismatch");
  if (typeof composition.composedSha256 !== "string" || !HEX64_RE.test(composition.composedSha256)) {
    return provenanceMissing("composed_sha256_missing");
  }
  if (requireBaseline && (typeof composition.baselineFingerprint !== "string" || !HEX64_RE.test(composition.baselineFingerprint))) {
    return provenanceMissing("baseline_fingerprint_missing");
  }
  if (composition.baselineFingerprint !== undefined && !HEX64_RE.test(String(composition.baselineFingerprint))) {
    return provenanceMismatch("baseline_fingerprint_invalid");
  }
  if (!Array.isArray(composition.sources)) return provenanceMissing("sources_missing");
  if (composition.sources.length < MIN_COMPOSITION_SOURCES) return provenanceMissing("sources_missing");
  if (composition.sources.length > MAX_COMPOSITION_SOURCES) return provenanceMismatch("sources_excess");
  const seen = new Set();
  for (const source of composition.sources) {
    if (!isPlainObject(source)) return provenanceMissing("source_invalid");
    if (
      typeof source.id !== "string" ||
      typeof source.objective !== "string" ||
      source.objective.length === 0 ||
      typeof source.patchSha256 !== "string" ||
      !HEX64_RE.test(source.patchSha256)
    ) {
      return provenanceMissing("source_identity_incomplete");
    }
    if (seen.has(source.id)) return provenanceMismatch(`source_duplicate:${source.id}`);
    seen.add(source.id);
    if (!CANDIDATE_ID_RE.test(source.id)) return provenanceMissing("source_identity_incomplete");
    if (candidateProposalId({ objective: source.objective, patchSha256: source.patchSha256 }) !== source.id) {
      return provenanceMismatch(`source_id_not_recomputable:${source.id}`);
    }
    if (source.verdict !== undefined && !CANDIDATE_VERDICTS.includes(source.verdict)) {
      return provenanceMismatch(`source_verdict_invalid:${source.id}`);
    }
  }
  if (typeof patchText !== "string" || sha256Hex(patchText) !== composition.composedSha256) {
    return provenanceMismatch("composed_patch_mismatch");
  }
  return { ok: true, reason: null, detail: null };
}

function boundedSource(source, includeReasons) {
  return {
    id: source.id,
    sha12: source.patchSha256.slice(0, 12),
    objective: String(source.objective).slice(0, MAX_SOURCE_OBJECTIVE_CHARS),
    ...(source.verdict ? { verdict: source.verdict } : {}),
    ...(includeReasons && Array.isArray(source.reasons) && source.reasons.length > 0
      ? {
          reasons: source.reasons
            .slice(0, MAX_SOURCE_REASONS)
            .map((reason) => String(reason).slice(0, MAX_SOURCE_REASON_CHARS)),
        }
      : {}),
  };
}

/**
 * Row-safe form of a validated composition record. Identity fields are kept;
 * per-source reasons are dropped first so a wide record stays inside
 * `MAX_COMPOSITION_EVIDENCE_BYTES` instead of pushing the cycle row past the
 * ledger limit. When identity alone does not fit, the record is refused.
 */
export function boundedCompositionEvidence(composition) {
  const build = (includeReasons) => ({
    schema: COMPOSITION_SCHEMA,
    composedSha256: composition.composedSha256,
    baselineFingerprint: composition.baselineFingerprint,
    sources: composition.sources.map((source) => boundedSource(source, includeReasons)),
  });
  const full = build(true);
  let bytes = Buffer.byteLength(JSON.stringify(full), "utf8");
  if (bytes <= MAX_COMPOSITION_EVIDENCE_BYTES) return { ok: true, evidence: full, bytes };
  const trimmed = build(false);
  bytes = Buffer.byteLength(JSON.stringify(trimmed), "utf8");
  if (bytes <= MAX_COMPOSITION_EVIDENCE_BYTES) return { ok: true, evidence: trimmed, bytes };
  return { ok: false, reason: "composition_evidence_too_large", bytes };
}

/** Drop the optional per-source reason codes (identity is kept). */
export function stripCompositionReasons(evidence) {
  return {
    ...evidence,
    sources: evidence.sources.map(({ reasons, ...rest }) => rest),
  };
}

/** Projected row size of a cycle row before it is appended (seq/prev worst case). */
export function ledgerRowBytes(row) {
  const projected = { schema: LEDGER_SCHEMA, ...row, seq: Number.MAX_SAFE_INTEGER, prev: "f".repeat(64) };
  return Buffer.byteLength(JSON.stringify(projected), "utf8");
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
