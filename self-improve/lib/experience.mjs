/**
 * Bounded experience reuse (Harness² M3): cue/lesson/evidence records with
 * explicit provenance, an append-only store with a sha256 prev-hash chain,
 * deterministic cue-relevance selection and a held-out separation check.
 *
 * An entry is only useful if it stays explainable: `cue` says when it applies,
 * `lesson` says what to do, `evidence` says why it is believed, and the
 * provenance block pins the source, version, outcome, domain and patch digest
 * it came from. Contradicted lessons are never edited away — an
 * `op:"invalidate"` or `op:"supersede"` row is appended and the target stops
 * being selectable. A missing file is an empty store; a corrupt chain or row
 * fails closed instead of returning a partial library.
 *
 * Selection is bounded (default 6 records / 600 lesson bytes), active-only and
 * stable: a record must share at least one normalized token with the cue (a
 * domain match alone ranks first but does not admit a cue-unrelated record),
 * then exact repo/domain match, cue token overlap and id order break ties.
 * Held-out separation rejects literal fixture substrings and any shared
 * normalized token run of `MIN_LEAK_TOKENS` words in cue, lesson or evidence.
 *
 * Nothing here calls a model, reads the network or measures efficacy. The
 * stub evaluation in `experience-eval.mjs` proves the predicates only.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { MAX_LEDGER_ROW_BYTES, isPlainObject, sha256Hex } from "./types.mjs";

export const EXPERIENCE_SCHEMA = "gjc.self-improve.experience.v1";
export const EXPERIENCE_STORE_PATH = "self-improve/experience/library.jsonl";

export const EXPERIENCE_OUTCOMES = Object.freeze(["adopt", "reject", "observe"]);
export const EXPERIENCE_STATUSES = Object.freeze(["active", "invalidated", "superseded"]);
export const EXPERIENCE_OPS = Object.freeze(["invalidate", "supersede"]);
export const EXPERIENCE_ID_RE = /^exp-[0-9a-f]{12}$/;

export const MAX_CUE_BYTES = 256;
export const MAX_LESSON_BYTES = 512;
export const MAX_EVIDENCE_BYTES = 512;
export const MAX_SOURCE_BYTES = 120;
export const MAX_VERSION_BYTES = 32;
export const MAX_DOMAIN_BYTES = 64;
export const MAX_REASON_BYTES = 200;
/** One row must fit the same ceiling the ledger uses for one cycle row. */
export const MAX_EXPERIENCE_ROW_BYTES = MAX_LEDGER_ROW_BYTES;

export const DEFAULT_SELECT_LIMIT = 6;
export const DEFAULT_SELECT_MAX_BYTES = 600;
export const MIN_LEAK_TOKENS = 8;
/** A shorter normalized held-out string is left to the token-run check. */
export const MIN_LITERAL_CHARS = 24;

/** Field order is the canonical identity payload; do not reorder. */
export const EXPERIENCE_PAYLOAD_FIELDS = Object.freeze([
  "cue",
  "lesson",
  "evidence",
  "source",
  "version",
  "outcome",
  "domain",
  "patchSha256",
  "validFrom",
]);

const HEX64_RE = /^[0-9a-f]{64}$/;
const DOMAIN_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const TOKEN_RE = /[\p{L}\p{N}][\p{L}\p{N}_.-]*/gu;

const byteLength = (value) => Buffer.byteLength(value, "utf8");
const invalid = (reason, detail = null) => ({ ok: false, reason, detail });

/**
 * Deterministic entry identity: 12 hex of the canonical payload, so the id is
 * recomputable from the record itself and cannot be re-labelled by the store.
 */
export function experienceId(payload) {
  if (!isPlainObject(payload)) throw new Error("experience_payload_invalid");
  const canonical = {};
  for (const field of EXPERIENCE_PAYLOAD_FIELDS) canonical[field] = payload[field];
  return `exp-${sha256Hex(JSON.stringify(canonical)).slice(0, 12)}`;
}

function checkText(field, value, maxBytes, errors) {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push({ reason: `${field}_missing`, detail: field });
    return false;
  }
  if (byteLength(value) > maxBytes) {
    errors.push({ reason: `${field}_too_large`, detail: `${field}:${byteLength(value)}` });
    return false;
  }
  return true;
}

/**
 * Validate one experience record. Returns `{ok:true, entry, id}` with the nine
 * payload fields plus `status`, or `{ok:false, reason, detail}`. `status` must
 * be one of the enums here; `appendExperience` additionally requires `active`
 * because invalidation is an appended op, never an entry field.
 */
export function validateExperienceEntry(entry) {
  if (!isPlainObject(entry)) return invalid("entry_not_object");
  if (entry.schema !== undefined && entry.schema !== EXPERIENCE_SCHEMA) return invalid("schema_mismatch");
  const errors = [];
  checkText("cue", entry.cue, MAX_CUE_BYTES, errors);
  checkText("lesson", entry.lesson, MAX_LESSON_BYTES, errors);
  checkText("evidence", entry.evidence, MAX_EVIDENCE_BYTES, errors);
  checkText("source", entry.source, MAX_SOURCE_BYTES, errors);
  checkText("version", entry.version, MAX_VERSION_BYTES, errors);
  if (!EXPERIENCE_OUTCOMES.includes(entry.outcome)) errors.push({ reason: "outcome_invalid", detail: entry.outcome ?? null });
  if (checkText("domain", entry.domain, MAX_DOMAIN_BYTES, errors) && !DOMAIN_RE.test(entry.domain)) {
    errors.push({ reason: "domain_invalid", detail: entry.domain });
  }
  if (typeof entry.patchSha256 !== "string" || !HEX64_RE.test(entry.patchSha256)) {
    errors.push({ reason: "patch_sha256_invalid", detail: entry.patchSha256 ?? null });
  }
  if (typeof entry.validFrom !== "string" || entry.validFrom.length === 0 || !Number.isFinite(Date.parse(entry.validFrom))) {
    errors.push({ reason: "valid_from_invalid", detail: entry.validFrom ?? null });
  }
  if (!EXPERIENCE_STATUSES.includes(entry.status)) errors.push({ reason: "status_invalid", detail: entry.status ?? null });
  if (errors.length > 0) return { ok: false, reason: errors[0].reason, detail: errors[0].detail };

  const payload = {};
  for (const field of EXPERIENCE_PAYLOAD_FIELDS) payload[field] = entry[field];
  const id = experienceId(payload);
  if (entry.id !== undefined && entry.id !== id) return invalid("id_mismatch", entry.id);
  return { ok: true, reason: null, detail: null, id, entry: { ...payload, status: entry.status } };
}

/** Projected row size with the worst-case `seq`/`prev` values. */
export function experienceRowBytes(row) {
  const projected = { ...row, seq: Number.MAX_SAFE_INTEGER, prev: "f".repeat(64) };
  return byteLength(JSON.stringify(projected));
}

/** Lowercase, NFKC, punctuation/symbols to single spaces, collapsed. */
export function normalizeExperienceText(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/** Normalized word tokens; trailing dots/dashes are dropped. */
export function normalizeExperienceTokens(value) {
  const normalized = normalizeExperienceText(value);
  if (normalized.length === 0) return [];
  return normalized.match(TOKEN_RE)?.map((token) => token.replace(/[.-]+$/, "")).filter((token) => token.length > 0) ?? [];
}

function loadRows(filePath) {
  if (!existsSync(filePath)) return { ok: true, rows: [], text: "" };
  const text = readFileSync(filePath, "utf8");
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const rows = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return { ok: false, reason: "parse_error", at: rows.length + 1 };
    }
    rows.push({ row, raw: line, hash: sha256Hex(line) });
  }
  return { ok: true, rows };
}

function checkChain(rows) {
  let previousHash = null;
  for (let i = 0; i < rows.length; i += 1) {
    const expectedSeq = i + 1;
    if (rows[i].row.seq !== expectedSeq) return { ok: false, count: rows.length, brokenAt: expectedSeq, reason: "seq_mismatch" };
    if ((rows[i].row.prev ?? null) !== previousHash) return { ok: false, count: rows.length, brokenAt: expectedSeq, reason: "prev_mismatch" };
    previousHash = rows[i].hash;
  }
  return { ok: true, count: rows.length, brokenAt: null, reason: null };
}

/** Chain-only verification (same discipline as the ledger). */
export function verifyExperienceChain(filePath) {
  const loaded = loadRows(filePath);
  if (!loaded.ok) return { ok: false, count: 0, brokenAt: null, reason: loaded.reason };
  return checkChain(loaded.rows);
}

function corrupt(reason, detail, chain) {
  return {
    ok: false,
    reason: "experience_store_corrupt",
    detail: { reason, detail: detail ?? null },
    count: 0,
    rowCount: chain?.count ?? 0,
    lastHash: null,
    entries: [],
    active: [],
    ops: [],
    chain: chain ?? { ok: false, count: 0, brokenAt: null, reason },
  };
}

function validateOpRow(row) {
  if (row.op !== "invalidate" && row.op !== "supersede") return invalid("unknown_op", row.op ?? null);
  if (typeof row.target !== "string" || !EXPERIENCE_ID_RE.test(row.target)) return invalid("target_invalid", row.target ?? null);
  if (!isPlainObject(row.provenance)) return invalid("provenance_missing");
  const errors = [];
  checkText("reason", row.reason, MAX_REASON_BYTES, errors);
  checkText("source", row.provenance.source, MAX_SOURCE_BYTES, errors);
  checkText("version", row.provenance.version, MAX_VERSION_BYTES, errors);
  if (row.op === "supersede") {
    if (typeof row.replacement !== "string" || !EXPERIENCE_ID_RE.test(row.replacement)) {
      errors.push({ reason: "replacement_invalid", detail: row.replacement ?? null });
    } else if (row.replacement === row.target) {
      errors.push({ reason: "self_invalidation", detail: row.target });
    }
  }
  if (errors.length > 0) return { ok: false, reason: errors[0].reason, detail: errors[0].detail };
  if (row.op === "invalidate" && row.replacement !== undefined) return invalid("unexpected_replacement", row.replacement);
  return {
    ok: true,
    reason: null,
    detail: null,
    op: {
      op: row.op,
      target: row.target,
      ...(row.op === "supersede" ? { replacement: row.replacement } : {}),
      reason: row.reason,
      provenance: { source: row.provenance.source, version: row.provenance.version },
    },
  };
}

const projectEntry = (entry) => ({
  id: entry.id,
  cue: entry.cue,
  lesson: entry.lesson,
  evidence: entry.evidence,
  source: entry.source,
  version: entry.version,
  outcome: entry.outcome,
  domain: entry.domain,
  patchSha256: entry.patchSha256,
  validFrom: entry.validFrom,
  status: entry.status,
});

/**
 * Read and replay the store. The chain and every row are validated first; any
 * corruption or an op that references an unknown/inactive target fails closed.
 * The returned `entries` carry the effective status derived from the ops.
 */
export function readExperience(filePath) {
  const loaded = loadRows(filePath);
  if (!loaded.ok) return corrupt(loaded.reason, `line ${loaded.at}`);
  const chain = checkChain(loaded.rows);
  if (!chain.ok) return corrupt(chain.reason, `seq ${chain.brokenAt}`, chain);

  const byId = new Map();
  const entries = [];
  const ops = [];
  for (const { row, hash } of loaded.rows) {
    if (row.schema !== EXPERIENCE_SCHEMA) return corrupt("schema_mismatch", `seq ${row.seq}`, chain);
    if (row.op === "add") {
      const checked = validateExperienceEntry(row);
      if (!checked.ok) return corrupt(checked.reason, `seq ${row.seq}`, chain);
      if (checked.entry.status !== "active") return corrupt("self_invalidation", `seq ${row.seq}`, chain);
      if (byId.has(checked.id)) return corrupt("duplicate_entry", `seq ${row.seq}`, chain);
      const stored = { ...checked.entry, id: checked.id, seq: row.seq };
      byId.set(checked.id, stored);
      entries.push(stored);
      continue;
    }
    const checked = validateOpRow(row);
    if (!checked.ok) return corrupt(checked.reason, `seq ${row.seq}`, chain);
    const target = byId.get(checked.op.target);
    if (!target) return corrupt("unknown_target", `seq ${row.seq}:${checked.op.target}`, chain);
    if (target.status !== "active") return corrupt("target_not_active", `seq ${row.seq}:${checked.op.target}`, chain);
    if (checked.op.op === "supersede") {
      const replacement = byId.get(checked.op.replacement);
      if (!replacement) return corrupt("unknown_replacement", `seq ${row.seq}:${checked.op.replacement}`, chain);
      if (replacement.status !== "active") return corrupt("replacement_not_active", `seq ${row.seq}`, chain);
    }
    target.status = checked.op.op === "invalidate" ? "invalidated" : "superseded";
    ops.push({ ...checked.op, seq: row.seq, hash });
  }

  const active = entries.filter((entry) => entry.status === "active").map(projectEntry);
  return {
    ok: true,
    reason: null,
    detail: null,
    count: entries.length,
    rowCount: loaded.rows.length,
    lastHash: loaded.rows.length > 0 ? loaded.rows[loaded.rows.length - 1].hash : null,
    entries: entries.map(projectEntry),
    active,
    ops: ops.map((op) => ({ ...op })),
    chain,
  };
}

function appendLine(filePath, row) {
  const line = JSON.stringify(row);
  const bytes = byteLength(line);
  if (bytes > MAX_EXPERIENCE_ROW_BYTES) return invalid("row_too_large", `${bytes}>${MAX_EXPERIENCE_ROW_BYTES}`);
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${line}\n`);
  return { ok: true, seq: row.seq, hash: sha256Hex(line), bytes };
}

/**
 * Append one active entry. Re-appending the identical payload is idempotent
 * (`duplicate:true`) only while the stored entry is still active — a dead
 * lesson is not resurrected by re-appending it.
 */
export function appendExperience(filePath, input) {
  const state = readExperience(filePath);
  if (!state.ok) return invalid("store_corrupt", state.detail);
  if (isPlainObject(input) && EXPERIENCE_STATUSES.includes(input.status) && input.status !== "active") {
    return invalid("self_invalidation", input.status);
  }
  const checked = validateExperienceEntry({ ...input, schema: input?.schema ?? EXPERIENCE_SCHEMA });
  if (!checked.ok) return checked;
  const existing = state.entries.find((entry) => entry.id === checked.id);
  if (existing) {
    const identical = EXPERIENCE_PAYLOAD_FIELDS.every((field) => existing[field] === checked.entry[field]);
    if (!identical) return invalid("duplicate_entry", checked.id);
    if (existing.status !== "active") return invalid("entry_not_active", checked.id);
    return { ok: true, duplicate: true, id: checked.id, seq: null, hash: null };
  }
  const row = {
    schema: EXPERIENCE_SCHEMA,
    op: "add",
    id: checked.id,
    ...checked.entry,
    seq: state.rowCount + 1,
    prev: state.lastHash,
  };
  const appended = appendLine(filePath, row);
  if (!appended.ok) return appended;
  return { ...appended, id: checked.id };
}

function opPayload(op) {
  return JSON.stringify({
    op: op.op,
    target: op.target,
    ...(op.op === "supersede" ? { replacement: op.replacement } : {}),
    reason: op.reason,
    provenance: { source: op.provenance.source, version: op.provenance.version },
  });
}

function appendExperienceOp(filePath, input) {
  const state = readExperience(filePath);
  if (!state.ok) return invalid("store_corrupt", state.detail);
  const row = {
    schema: EXPERIENCE_SCHEMA,
    op: input?.op,
    target: input?.target,
    ...(input?.op === "supersede" ? { replacement: input.replacement } : {}),
    reason: input?.reason,
    provenance: { source: input?.source, version: input?.version },
  };
  const checked = validateOpRow(row);
  if (!checked.ok) return checked;
  const prior = state.ops.filter((op) => op.target === checked.op.target);
  const identical = prior.find((op) => opPayload(op) === opPayload(checked.op));
  if (identical) return { ok: true, duplicate: true, op: checked.op.op, target: checked.op.target, seq: identical.seq };
  const target = state.entries.find((entry) => entry.id === checked.op.target);
  if (!target) return invalid("unknown_target", checked.op.target);
  if (target.status !== "active" || prior.length > 0) return invalid("target_not_active", checked.op.target);
  if (checked.op.op === "supersede") {
    const replacement = state.entries.find((entry) => entry.id === checked.op.replacement);
    if (!replacement) return invalid("unknown_replacement", checked.op.replacement);
    if (replacement.status !== "active") return invalid("replacement_not_active", checked.op.replacement);
  }
  const stored = {
    schema: EXPERIENCE_SCHEMA,
    op: checked.op.op,
    target: checked.op.target,
    ...(checked.op.op === "supersede" ? { replacement: checked.op.replacement } : {}),
    reason: checked.op.reason,
    provenance: checked.op.provenance,
    seq: state.rowCount + 1,
    prev: state.lastHash,
  };
  const appended = appendLine(filePath, stored);
  if (!appended.ok) return appended;
  return { ...appended, op: checked.op.op, target: checked.op.target };
}

/** Append `op:"invalidate"`; replaying the identical op returns `duplicate:true`. */
export function invalidateExperience(filePath, { target, reason, source, version } = {}) {
  return appendExperienceOp(filePath, { op: "invalidate", target, reason, source, version });
}

/** Append `op:"supersede"`; the replacement must exist, be active and differ. */
export function supersedeExperience(filePath, { target, replacement, reason, source, version } = {}) {
  return appendExperienceOp(filePath, { op: "supersede", target, replacement, reason, source, version });
}

/**
 * Active-only, cue-relevance ranked, bounded selection. Corrupt entries are
 * skipped and counted, never thrown: a damaged record must not take the whole
 * retrieval (or the caller) down.
 */
export function selectExperience({
  entries,
  repo = "",
  cueText = "",
  limit = DEFAULT_SELECT_LIMIT,
  maxBytes = DEFAULT_SELECT_MAX_BYTES,
} = {}) {
  const limitValue = Number.isSafeInteger(limit) && limit >= 0 ? limit : DEFAULT_SELECT_LIMIT;
  const byteValue = Number.isFinite(maxBytes) && maxBytes >= 0 ? Math.floor(maxBytes) : DEFAULT_SELECT_MAX_BYTES;
  const cueTokens = new Set(normalizeExperienceTokens(cueText));
  const repoId = String(repo ?? "").trim().toLowerCase();
  const withheld = { inactive: 0, notRelevant: 0, countBound: 0, byteBound: 0 };
  const candidates = [];
  let skipped = 0;
  for (const raw of Array.isArray(entries) ? entries : []) {
    let checked;
    try {
      checked = validateExperienceEntry(raw);
    } catch {
      checked = { ok: false, reason: "entry_unreadable" };
    }
    if (!checked.ok) {
      skipped += 1;
      continue;
    }
    if (checked.entry.status !== "active") {
      withheld.inactive += 1;
      continue;
    }
    const domainMatch = repoId.length > 0 && checked.entry.domain.toLowerCase() === repoId;
    const overlap = new Set(normalizeExperienceTokens(checked.entry.cue).filter((token) => cueTokens.has(token))).size;
    // A domain match is a ranking signal, not relevance: an unrelated cue must
    // not be filled with same-domain records. Only a tokenless cue falls back
    // to the domain as the sole signal.
    if (overlap === 0 && !(domainMatch && cueTokens.size === 0)) {
      withheld.notRelevant += 1;
      continue;
    }
    candidates.push({ entry: checked.entry, id: checked.id, domainMatch: domainMatch ? 1 : 0, overlap });
  }
  candidates.sort(
    (a, b) =>
      b.domainMatch - a.domainMatch ||
      b.overlap - a.overlap ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const selected = [];
  let bytes = 0;
  let truncated = false;
  for (const candidate of candidates) {
    if (selected.length >= limitValue) {
      withheld.countBound += 1;
      truncated = true;
      continue;
    }
    const size = byteLength(candidate.entry.lesson);
    if (bytes + size > byteValue) {
      withheld.byteBound += 1;
      truncated = true;
      continue;
    }
    bytes += size;
    selected.push({
      id: candidate.id,
      cue: candidate.entry.cue,
      lesson: candidate.entry.lesson,
      evidence: candidate.entry.evidence,
      source: candidate.entry.source,
      version: candidate.entry.version,
      domain: candidate.entry.domain,
      status: candidate.entry.status,
      bytes: size,
    });
  }
  return { status: selected.length > 0 ? "ok" : "empty", selected, bytes, truncated, skipped, withheld };
}

/**
 * Held-out separation: reject a literal held-out substring and any shared
 * normalized token run of at least `minTokens` words (default 8). Overlaps are
 * reported as field/kind/length plus a short digest, never the matched text.
 * Missing held-out input fails closed: separation over nothing is not a pass.
 */
export function assertHeldoutSeparation({ entry, heldoutTexts, minTokens = MIN_LEAK_TOKENS } = {}) {
  if (!isPlainObject(entry)) return { ok: false, reason: "entry_missing", overlaps: [] };
  const texts = Array.isArray(heldoutTexts) ? heldoutTexts.filter((text) => typeof text === "string" && text.trim().length > 0) : [];
  if (texts.length === 0) return { ok: false, reason: "heldout_texts_missing", overlaps: [] };
  const run = Number.isSafeInteger(minTokens) && minTokens >= 1 ? minTokens : MIN_LEAK_TOKENS;
  const heldout = texts.map((text) => ({
    normalized: normalizeExperienceText(text),
    tokens: normalizeExperienceTokens(text),
  }));
  const overlaps = [];
  for (const field of ["cue", "lesson", "evidence"]) {
    if (typeof entry[field] !== "string" || entry[field].length === 0) continue;
    const normalized = normalizeExperienceText(entry[field]);
    const tokens = normalizeExperienceTokens(entry[field]);
    for (const source of heldout) {
      if (source.normalized.length >= MIN_LITERAL_CHARS && normalized.includes(source.normalized)) {
        overlaps.push({ field, kind: "literal", chars: source.normalized.length, sha12: sha256Hex(source.normalized).slice(0, 12) });
      }
      if (source.tokens.length < run || tokens.length < run) continue;
      const grams = new Set();
      for (let i = 0; i + run <= source.tokens.length; i += 1) grams.add(source.tokens.slice(i, i + run).join(" "));
      for (let i = 0; i + run <= tokens.length; i += 1) {
        const gram = tokens.slice(i, i + run).join(" ");
        if (!grams.has(gram)) continue;
        overlaps.push({ field, kind: "token_run", tokens: run, sha12: sha256Hex(gram).slice(0, 12) });
        break;
      }
    }
  }
  const bounded = overlaps.slice(0, 8);
  return { ok: bounded.length === 0, reason: bounded.length > 0 ? "heldout_overlap" : null, overlaps: bounded };
}
