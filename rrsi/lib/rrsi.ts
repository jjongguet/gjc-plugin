/**
 * rrsi plugin core: a bounded, private exploration-episode store, read-only
 * projections of the jev-advisor journal and this repository's self-improve
 * ledger, and dreaming over the store through the bundled Dream-RSI core
 * (inlined at build time from self-improve/lib/{types,ledger,replay,dream,policy}.mjs).
 *
 * Scope: functional acceptance only. The performance proof (P1-P3) applies to
 * the self-improve loop and its frozen corpus, not to this plugin; no accuracy,
 * savings or routing claim is made here.
 *
 * Keyless and offline: no network, no credentials, no timer process. The
 * only automatic invocation is the due-gated `session_start` refresh in
 * `lib/periodic.ts`. The store lives at `~/.gjc-plugin/rrsi/store.json`
 * (0700 dir, 0600 file) and is never committed; dream policy receipts and
 * periodic run receipts share `runs/v1/` with the same ownership/mode rules.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
// Separate line on purpose: scripts/build.mjs de-duplicates identical builtin import
// lines, so this statement matches lib/periodic.ts instead of redeclaring createHash.
import { randomBytes } from "node:crypto";
import { sha256Hex } from "../../self-improve/lib/types.mjs";
import { corpusFromAttempts } from "../../self-improve/lib/replay.mjs";
import { runDream } from "../../self-improve/lib/dream.mjs";
import {
  projectQualityTrialCohort,
  QUALITY_COHORT_SCHEMA,
  QUALITY_TRIAL_SCHEMA,
} from "../../self-improve/lib/quality-trial.mjs";

export const RRSI_STORE_SCHEMA = "gjc.rrsi.store.v1";

export const RRSI_SCOPE_SENTENCE =
  "Functional acceptance only: rrsi captures exploration episodes, projects journals into attempt records and replays them through the bundled Dream-RSI core. The performance proof (P1-P3) applies to the self-improve loop and its frozen corpus, not to this plugin; no accuracy, savings or routing claim is made.";

export const RRSI_LIMITS = Object.freeze({
  maxEpisodes: 128,
  maxAttemptsPerEpisode: 160,
  maxStoreBytes: 512 * 1024,
  maxJournalSegments: 8,
  maxJournalRecordsPerSegment: 4096,
  maxLedgerRows: 4096,
  maxReadBytes: 4 * 1024 * 1024,
  maxTextChars: 280,
  maxIdChars: 64,
});

const RRSI_ACTIONS = ["capture", "import", "dream", "status"];
const RRSI_DECISIONS = ["adopt", "reject", "inconclusive"];
const RRSI_SOURCES = ["capture", "jev-journal", "self-improve-ledger"];

/** Changed-path list bound: same 512 cap as the recorded file count (JJO-2360). */
const MAX_ATTEMPT_FILES = 512;
const MAX_ATTEMPT_FILE_CHARS = 200;

export function rrsiRoot(env = process.env) {
  const home = (env && env.HOME) || os.homedir();
  return path.join(home, ".gjc-plugin", "rrsi");
}

export function rrsiStorePath(env = process.env) {
  return path.join(rrsiRoot(env), "store.json");
}

export function rrsiJournalDir(env = process.env) {
  return path.join(rrsiRoot(env), "..", "jev-advisor", "journal", "v1");
}

// Shared store-lock bounds: stale takeover after 2 × the 12 s periodic inline
// budget so a crashed writer cannot hold the lock forever; the contended wait
// is bounded at 100 ms (bounded result, no throw).
export const RRSI_STORE_LOCK_STALE_MS = 24_000;
export const RRSI_STORE_LOCK_WAIT_MS = 100;

/**
 * Walk the private directory chain from the `.gjc-plugin` boundary down to
 * `target`: every existing component must be a real, owned 0700 directory (no
 * symlinks); missing components are created with 0700 when `create` is true.
 * Returns false at the first unsafe component — callers translate that into a
 * bounded `unsafe_path` result and never write through a symlinked root.
 */
export function privateDirSafe(target, { create = false } = {}) {
  if (typeof target !== "string" || target.length === 0) return false;
  const absolute = path.resolve(target);
  const marker = `${path.sep}.gjc-plugin`;
  const boundary = absolute.indexOf(marker);
  if (boundary < 0) return false;
  const root = absolute.slice(0, boundary + marker.length);
  const rest = absolute.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of [null, ...rest]) {
    if (part !== null) current = path.join(current, part);
    let info;
    try {
      info = fs.lstatSync(current);
    } catch (error) {
      if (!error || error.code !== "ENOENT" || !create) return false;
      try {
        fs.mkdirSync(current, { mode: 0o700 });
      } catch {
        return false;
      }
      try {
        info = fs.lstatSync(current);
      } catch {
        return false;
      }
    }
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.() || (info.mode & 0o7777) !== 0o700) return false;
  }
  return true;
}

function projectionDigestHex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function boundedText(value, max = RRSI_LIMITS.maxTextChars) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedInteger(value, max = Number.MAX_SAFE_INTEGER, fallback = 0) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
}

/**
 * A bounded non-negative integer, or null when the source did not record it.
 * Used for counts (files/hunks) where an absent field must stay unknown
 * instead of collapsing to a fabricated 0.
 */
function optionalInteger(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

/** A bounded non-negative measured number (ms durations arrive as floats), or null. */
function optionalNonNegative(value, max = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : null;
}

/**
 * A measured wall-clock duration in whole milliseconds, or null when the source
 * recorded no measurable duration (negative, non-finite or absent). A fractional
 * measurement is rounded to millisecond granularity; an unknown duration is
 * never fabricated as 0 (JJO-2360: `wallMs` is an integer or null).
 */
function measuredWallMs(value) {
  const measured = optionalNonNegative(value, 86_400_000);
  return measured === null ? null : Math.round(measured);
}

/**
 * A recorded changed-path list, bounded and sanitized. Always an array; the
 * separate file count keeps "not recorded" (null) distinct from "recorded as
 * empty" (0).
 */
function boundedPaths(value) {
  if (!Array.isArray(value)) return [];
  const paths = [];
  for (const entry of value.slice(0, MAX_ATTEMPT_FILES)) {
    if (typeof entry !== "string") continue;
    const trimmed = entry.trim().slice(0, MAX_ATTEMPT_FILE_CHARS);
    if (trimmed.length > 0) paths.push(trimmed);
  }
  return paths;
}

function optionalNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function emptyStore(now = new Date().toISOString()) {
  return { schema: RRSI_STORE_SCHEMA, updatedAt: now, episodes: [] };
}

/**
 * Flatten one exploration attempt into the bounded core-shaped record.
 *
 * Every stored attempt carries `outcome`, `files` and `wallMs` (JJO-2360):
 *   outcome = the recorded decision (`adopt` | `reject` | `inconclusive`), so a
 *     reader never has to infer it; `decision` is kept because the bundled
 *     replay core keys on it.
 *   files = the recorded changed-path list (array, [] when unrecorded) and
 *     fileCount = the recorded/derived count or null when it was never
 *     recorded (a measured 0 and an unknown count stay different facts). A
 *     legacy numeric `files` input is accepted as the count.
 *   wallMs = a measured duration in whole milliseconds, else null.
 */
export function normalizeAttempt(raw, index) {
  const objective = boundedText(raw?.objective ?? raw?.goal ?? "unlabeled", 120) || "unlabeled";
  const decision = RRSI_DECISIONS.includes(raw?.decision) ? raw.decision : "inconclusive";
  const guardFailures = Array.isArray(raw?.guardFailures)
    ? raw.guardFailures.filter((value) => typeof value === "string" && value.length > 0).slice(0, 16).map((value) => value.slice(0, 40))
    : [];
  const files = boundedPaths(raw?.files);
  // An already-normalized attempt carries an explicit fileCount (possibly null =
  // unrecorded); re-normalization must not turn that unknown into a measured 0
  // just because `files` is now an empty array.
  const hasExplicitCount = raw !== null && typeof raw === "object" && Object.prototype.hasOwnProperty.call(raw, "fileCount");
  const fileCount = hasExplicitCount
    ? optionalInteger(raw.fileCount, MAX_ATTEMPT_FILES)
    : Array.isArray(raw?.files)
      ? files.length
      : optionalInteger(raw?.files, MAX_ATTEMPT_FILES);
  return {
    index: boundedInteger(index, RRSI_LIMITS.maxAttemptsPerEpisode),
    objective,
    hypothesisNovelty: raw?.hypothesisNovelty !== false,
    outcome: decision,
    decision,
    wallMs: measuredWallMs(raw?.wallMs),
    guardFailures,
    budgetRung: boundedInteger(raw?.budgetRung, 16),
    files,
    fileCount,
    hunks: optionalInteger(raw?.hunks, 4096),
    ...(typeof raw?.provenance === "string" && raw.provenance.length > 0
      ? { provenance: raw.provenance.slice(0, RRSI_LIMITS.maxIdChars) }
      : {}),
  };
}

export function normalizeEpisode(raw, now = new Date().toISOString()) {
  const source = RRSI_SOURCES.includes(raw?.source) ? raw.source : "capture";
  const attempts = Array.isArray(raw?.attempts)
    ? raw.attempts.slice(0, RRSI_LIMITS.maxAttemptsPerEpisode).map((attempt, index) => normalizeAttempt(attempt, index))
    : [];
  const goal = boundedText(raw?.goal, 200) || `episode ${now}`;
  return {
    id: `ep-${sha256Hex(`${source}|${goal}|${now}|${attempts.length}`).slice(0, 12)}`,
    source,
    goal,
    createdAt: boundedText(raw?.createdAt, 32) || now,
    attempts,
  };
}

export function storeCounts(store) {
  const episodes = Array.isArray(store?.episodes) ? store.episodes : [];
  const attempts = episodes.flatMap((episode) => episode.attempts ?? []);
  return {
    episodes: episodes.length,
    attempts: attempts.length,
    adoptions: attempts.filter((attempt) => attempt.decision === "adopt").length,
    // JJO-2360: durations and path counts that were never measured are reported
    // as unknown rather than silently counted as zero.
    wallMsUnknown: attempts.filter((attempt) => attempt.wallMs === null || attempt.wallMs === undefined).length,
    fileCountUnknown: attempts.filter((attempt) => attempt.fileCount === null || attempt.fileCount === undefined).length,
  };
}

export function captureEpisode({ store, goal, attempts, now }) {
  const base = store && store.schema === RRSI_STORE_SCHEMA ? store : emptyStore(now);
  const episode = normalizeEpisode({ source: "capture", goal, attempts }, now);
  const episodes = [...base.episodes, episode].slice(-RRSI_LIMITS.maxEpisodes);
  return { store: { schema: RRSI_STORE_SCHEMA, updatedAt: now, episodes }, episode };
}

/** Read the private store: absent/invalid/unavailable are reported, never repaired. */
export function readStore(env = process.env) {
  const file = rrsiStorePath(env);
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    return error && error.code === "ENOENT" ? { status: "missing", store: emptyStore(), reason: null } : { status: "unavailable", store: emptyStore(), reason: "io_error" };
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RRSI_LIMITS.maxStoreBytes) {
    return { status: "invalid", store: emptyStore(), reason: stat.size > RRSI_LIMITS.maxStoreBytes ? "oversized" : "unsafe_path" };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.schema !== RRSI_STORE_SCHEMA || !Array.isArray(parsed.episodes)) {
      return { status: "invalid", store: emptyStore(), reason: "corrupt" };
    }
    return { status: "ok", store: { schema: RRSI_STORE_SCHEMA, updatedAt: boundedText(parsed.updatedAt, 32), episodes: parsed.episodes.slice(-RRSI_LIMITS.maxEpisodes) }, reason: null };
  } catch {
    return { status: "invalid", store: emptyStore(), reason: "corrupt" };
  }
}

/** Write the store atomically (temp file + rename), 0700 dir / 0600 file, bounded. */
export function writeStore({ store, env = process.env }) {
  const body = `${JSON.stringify(store, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > RRSI_LIMITS.maxStoreBytes) return { persisted: false, reason: "resource_limit" };
  const root = rrsiRoot(env);
  if (!privateDirSafe(root, { create: true })) return { persisted: false, reason: "unsafe_path" };
  const file = rrsiStorePath(env);
  const temp = `${file}.tmp`;
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, body, { mode: 0o600 });
    fs.renameSync(temp, file);
    return { persisted: true, reason: "stored", bytes: Buffer.byteLength(body, "utf8") };
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    return { persisted: false, reason: "store_unavailable" };
  }
}

const SEGMENT_INDEX_RE = /-(\d+)\.jsonl$/;

/** Numeric suffix of a journal segment name, or null when the name is unproven. */
export function journalSegmentIndex(name) {
  const match = SEGMENT_INDEX_RE.exec(String(name ?? ""));
  return match ? Number.parseInt(match[1], 10) : null;
}

/**
 * Segment order: the numeric suffix ascending is authoritative. Names without
 * a numeric suffix sort last lexicographically for reporting only and are
 * never coverage evidence.
 */
export function orderJournalSegments(names) {
  const numeric = [];
  const unproven = [];
  for (const name of Array.isArray(names) ? names : []) {
    const index = journalSegmentIndex(name);
    if (index === null) unproven.push(String(name));
    else numeric.push({ name: String(name), index });
  }
  numeric.sort((left, right) => left.index - right.index || left.name.localeCompare(right.name));
  unproven.sort();
  return [
    ...numeric.map((entry) => ({ name: entry.name, index: entry.index, ordering: "numeric" })),
    ...unproven.map((name) => ({ name, index: null, ordering: "unproven" })),
  ];
}

function readJournalInventory(dir) {
  try {
    const file = path.join(dir, "inventory.json");
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return { status: "invalid", declared: null, next: null };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const declared = Array.isArray(parsed?.segments) ? new Set(parsed.segments.map((entry) => String(entry?.name ?? "")).filter(Boolean)) : null;
    return { status: "ok", declared, next: Number.isSafeInteger(parsed?.next) ? parsed.next : null };
  } catch (error) {
    return { status: error && error.code === "ENOENT" ? "missing" : "invalid", declared: null, next: null };
  }
}

/**
 * Read-only projection of the jev-advisor journal segments. Records are read
 * in ascending numeric segment order and never modified. The return value
 * carries a per-segment report so a caller can prove whether the newest
 * records were covered: a skipped, truncated or unproven segment inside the
 * retained window cannot count as covered. A torn tail line is excluded and
 * reported; it is not a coverage failure.
 */
export function readJournalRecords({ journalDir, maxSegments = RRSI_LIMITS.maxJournalSegments } = {}) {
  const dir = journalDir ?? rrsiJournalDir();
  const empty = (status, reason) => ({
    status,
    reason,
    records: [],
    segments: 0,
    segmentReport: [],
    skippedSegments: [],
    truncatedSegments: [],
    newestSegment: null,
    inventory: { status: "missing", stale: false, next: null, missingDeclared: [] },
    ordering: "none",
  });
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return empty("missing", "no_journal");
  }
  const ordered = orderJournalSegments(names);
  const selected = ordered.slice(-maxSegments);
  const inventory = readJournalInventory(dir);
  const stale = inventory.status === "ok" && inventory.declared !== null && selected.some((entry) => !inventory.declared.has(entry.name));
  const missingDeclared = inventory.status === "ok" && inventory.declared !== null ? [...inventory.declared].filter((name) => !names.includes(name)).slice(0, 8) : [];
  const records = [];
  const segmentReport = [];
  for (const entry of selected) {
    let text = null;
    let state = "read";
    let reason = null;
    try {
      const file = path.join(dir, entry.name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        state = "skipped";
        reason = "unsafe_segment";
      } else if (stat.size > RRSI_LIMITS.maxReadBytes) {
        state = "skipped";
        reason = "oversized_segment";
      } else {
        text = fs.readFileSync(file, "utf8");
      }
    } catch {
      state = "skipped";
      reason = "unreadable_segment";
    }
    const lines = [];
    let torn = false;
    let malformed = 0;
    let count = 0;
    if (text !== null) {
      const chunks = text.split("\n");
      const tail = chunks.length > 0 ? chunks[chunks.length - 1] : "";
      torn = tail !== "";
      if (torn) chunks.pop();
      for (const line of chunks) {
        if (!line.trim()) continue;
        count += 1;
        if (count > RRSI_LIMITS.maxJournalRecordsPerSegment) {
          if (state === "read") {
            state = "truncated";
            reason = "record_cap";
          }
          break;
        }
        try {
          lines.push(JSON.parse(line));
        } catch {
          malformed += 1;
        }
      }
      records.push(...lines);
    }
    segmentReport.push({ name: entry.name, index: entry.index, ordering: entry.ordering, records: lines.length, state: torn && state === "read" ? "torn" : state, tornTail: torn, malformed, reason });
  }
  const newest = segmentReport.length > 0 ? segmentReport[segmentReport.length - 1] : null;
  return {
    status: records.length > 0 ? "ok" : "missing",
    reason: records.length > 0 ? null : "no_records",
    records,
    segments: selected.length,
    segmentReport,
    skippedSegments: segmentReport.filter((entry) => entry.state === "skipped").map((entry) => entry.name),
    truncatedSegments: segmentReport.filter((entry) => entry.state === "truncated").map((entry) => entry.name),
    newestSegment: newest ? { name: newest.name, state: newest.state, tornTail: newest.tornTail, ordering: newest.ordering } : null,
    inventory: { status: inventory.status, stale, next: inventory.next, missingDeclared },
    ordering: selected.some((entry) => entry.ordering === "unproven") ? "unproven" : "numeric",
  };
}

/**
 * The advice entries a journal record actually carries. The jev-advisor
 * producer writes a compact `taskAdvice[]` batch (one entry per delegated
 * task); `advice` is the older single-answer field and is read only when the
 * batch field is absent. No entry is invented when neither exists.
 */
function journalAdviceEntries(record) {
  const batch = record?.taskAdvice;
  if (Array.isArray(batch)) {
    const entries = batch.filter((entry) => entry && typeof entry === "object");
    if (entries.length > 0) return entries;
  }
  if (record?.advice && typeof record.advice === "object") return [record.advice];
  if (record?.assessment && typeof record.assessment === "object") return [record.assessment];
  return [];
}

/**
 * Journal record -> attempt projection (bounded, flattened for the replay core):
 *   advice entries = taskAdvice[] when present, else advice/assessment
 *   branch objective = "<operation>:<tier|status>" of the representative entry
 *     (the first real decision, else the first entry, else "unknown")
 *   hypothesisNovelty = first record of that branch in the read order
 *   decision = "adopt" when the representative entry is a decision, "reject"
 *     when it is an explicit no-decision, and "inconclusive" when the record
 *     carries no advice entry at all — an unknown outcome is never fabricated
 *     as a success or a failure
 *   wallMs = durationMs when the producer measured it, else null
 *   files/hunks = null: the outcome journal carries no such measurement, so a
 *     count is never fabricated as 0
 *   provenance = the journal record id
 *
 * One object record is one attempt. Novelty is computed over the full read order,
 * then the newest `limit` attempts are retained. `scanned` counts inspected
 * JSON values and `headOmitted` counts every value not retained: older attempts
 * and non-object values. It uses the same definition as projection.omitted.
 */
export function projectJournalRecords(records, { limit = 4000 } = {}) {
  const input = Array.isArray(records) ? records : [];
  const seen = new Map();
  const all = [];
  let scanned = 0;
  const bound = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  for (const record of input) {
    scanned += 1;
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;
    const entries = journalAdviceEntries(record);
    const entry = entries.find((candidate) => candidate.status === "decision") ?? entries[0] ?? null;
    const operation = boundedText(record.operation, 40) || "unknown";
    const status = (entry && boundedText(entry.status, 40)) || "unknown";
    const tier = (entry && boundedText(entry.tier, 16)) || status;
    const objective = `${operation}:${tier}`;
    const branch = seen.get(objective) ?? { records: 0, failures: 0 };
    const decision = entry === null ? "inconclusive" : entry.status === "decision" ? "adopt" : "reject";
    all.push({
      objective,
      hypothesisNovelty: branch.records === 0,
      decision,
      wallMs: optionalNonNegative(record.durationMs, 86_400_000),
      guardFailures: [],
      budgetRung: 0,
      files: null,
      hunks: null,
      provenance: boundedText(record.id, RRSI_LIMITS.maxIdChars),
    });
    seen.set(objective, { records: branch.records + 1, failures: branch.failures + (entry !== null && entry.status === "decision" ? 0 : 1) });
  }
  const attempts = all.slice(all.length - Math.min(all.length, bound)).map((attempt, index) => normalizeAttempt(attempt, index));
  const headOmitted = projectionCoverage(input, attempts).omitted;
  const novel = attempts.filter((attempt) => attempt.hypothesisNovelty).length;
  return {
    attempts,
    branches: seen.size,
    scanned,
    headOmitted,
    novelty: { retained: attempts.length, novel, shared: attempts.length - novel, density: attempts.length > 0 ? novel / attempts.length : null },
  };
}

/**
 * Ledger cycle rows -> attempts (read-only summary of the repo search history).
 * Only fields the ledger actually records are projected: objective/provenance
 * from the row, decision/outcome from the recorded verdict (anything else stays
 * "inconclusive"), wallMs from a measured `cost.wallMs`, files from the recorded
 * `proposal.files` changed-path list (fileCount from its length), hunks from a
 * recorded `proposal.hunks`. A field the row does not carry projects as unknown
 * (null count/outcome unknown), never as 0.
 */
export function projectLedgerRows(rows, { limit = 4000 } = {}) {
  const attempts = [];
  for (const row of rows) {
    if (attempts.length >= limit) break;
    if (!row || row.kind !== "cycle") continue;
    attempts.push(
      normalizeAttempt(
        {
          objective: boundedText(row.objective, 120) || "unlabeled",
          hypothesisNovelty: true,
          decision: row.verdict?.decision === "adopt" ? "adopt" : row.verdict?.decision === "reject" ? "reject" : "inconclusive",
          wallMs: optionalNonNegative(row.cost?.wallMs, 86_400_000),
          guardFailures: Array.isArray(row.guards) ? row.guards.filter((guard) => guard.status !== "pass").map((guard) => guard.id) : [],
          budgetRung: boundedInteger(row.budgetRung, 16),
          files: Array.isArray(row.proposal?.files) ? row.proposal.files : null,
          hunks: optionalInteger(row.proposal?.hunks, 4096),
          provenance: boundedText(row.cycleId, RRSI_LIMITS.maxIdChars),
        },
        attempts.length,
      ),
    );
  }
  return { attempts };
}

/**
 * Bounded reader for `gjc.quality_trial.v2` receipts: one JSON array file or a
 * JSONL file. A symlinked, oversized or unreadable path is reported, never
 * repaired; malformed lines are skipped and counted by the cohort validator.
 */
export function readTrialRecords({ recordsPath, limit = 4000 } = {}) {
  if (typeof recordsPath !== "string" || recordsPath.length === 0) return { status: "missing", reason: "no_path", records: [] };
  const bound = Number.isSafeInteger(limit) && limit > 0 ? Math.min(limit, 4000) : 4000;
  try {
    const stat = fs.lstatSync(recordsPath);
    if (stat.isSymbolicLink() || !stat.isFile()) return { status: "invalid", reason: "unsafe_path", records: [] };
    if (stat.size > RRSI_LIMITS.maxReadBytes) return { status: "invalid", reason: "oversized", records: [] };
    const text = fs.readFileSync(recordsPath, "utf8");
    const trimmed = text.trim();
    let records = [];
    if (trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (!Array.isArray(parsed)) return { status: "invalid", reason: "not_an_array", records: [] };
        records = parsed;
      } catch {
        return { status: "invalid", reason: "malformed_json", records: [] };
      }
    } else {
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        if (records.length >= bound) break;
        try {
          records.push(JSON.parse(line));
        } catch {
          /* malformed lines are skipped, never repaired */
        }
      }
    }
    records = records.slice(0, bound);
    return { status: records.length > 0 ? "ok" : "missing", reason: records.length > 0 ? null : "no_records", records };
  } catch {
    return { status: "missing", reason: "unreadable", records: [] };
  }
}

export function readLedgerRows({ ledgerPath } = {}) {
  if (typeof ledgerPath !== "string" || ledgerPath.length === 0) return { status: "missing", rows: [], reason: "no_ledger" };
  try {
    const stat = fs.lstatSync(ledgerPath);
    if (!stat.isFile() || stat.size > RRSI_LIMITS.maxReadBytes) return { status: "invalid", rows: [], reason: "unsafe_or_oversized" };
    const rows = [];
    for (const line of fs.readFileSync(ledgerPath, "utf8").split("\n")) {
      if (!line.trim()) continue;
      if (rows.length >= RRSI_LIMITS.maxLedgerRows) break;
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip malformed rows, never repair */
      }
    }
    return { status: "ok", rows, reason: null };
  } catch {
    return { status: "missing", rows: [], reason: "no_ledger" };
  }
}

/** Merge imported episodes into the store (bounded, newest-last). */
export function mergeEpisodes({ store, episodes, now }) {
  const base = store && store.schema === RRSI_STORE_SCHEMA ? store : emptyStore(now);
  const merged = [...base.episodes, ...episodes].slice(-RRSI_LIMITS.maxEpisodes);
  return { schema: RRSI_STORE_SCHEMA, updatedAt: now, episodes: merged };
}

/** Content-keyed digest of one bounded projection (read order + applied limit). */
export function projectionDigestFor(attempts, limit) {
  const bounded = Array.isArray(attempts) ? attempts.slice(0, 4000) : [];
  return projectionDigestHex(JSON.stringify({ limit, attempts: bounded }));
}

/** Coverage of one bounded projection: records read vs attempts kept. */
export function projectionCoverage(records, attempts) {
  const total = Array.isArray(records) ? records.length : 0;
  const projected = Array.isArray(attempts) ? attempts.length : 0;
  const omitted = Math.max(0, total - projected);
  return { records: total, projected, omitted, ratio: total > 0 ? projected / total : null, limited: omitted > 0 };
}

/**
 * Window coverage: walk the segment report newest-first until the retained
 * window is filled. A skipped, truncated or unproven segment inside that walk
 * cannot prove coverage; a torn tail is reported and does not block.
 */
export function journalWindowCoverage(segmentReport, limit) {
  const report = Array.isArray(segmentReport) ? segmentReport : [];
  const bound = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  let collected = 0;
  const touched = [];
  for (let index = report.length - 1; index >= 0; index -= 1) {
    touched.push(report[index]);
    collected += Number.isSafeInteger(report[index].records) ? report[index].records : 0;
    if (collected >= bound) break;
  }
  const blocking = touched.filter((entry) => entry.state === "skipped" || entry.state === "truncated" || entry.ordering === "unproven");
  return {
    covered: touched.length > 0 && blocking.length === 0,
    touched: touched.map((entry) => entry.name),
    blocking: blocking.map((entry) => entry.name),
  };
}

/**
 * Chunked derived episode set for one source class (no clock value enters any
 * episode, so identical content yields a byte-identical set). Ids:
 * `ep-jev-<digest12>-<n>` for `jev-journal`, `ep-ledger-<digest12>-<n>` for
 * the self-improve ledger.
 */
export function derivedEpisodeSetFor({ digest, attempts, source = "jev-journal", maxPerEpisode = RRSI_LIMITS.maxAttemptsPerEpisode, goalPrefix = "periodic projection" }) {
  const digest12 = String(digest ?? "").slice(0, 12);
  const idPrefix = source === "self-improve-ledger" ? "ep-ledger" : "ep-jev";
  const input = Array.isArray(attempts) ? attempts : [];
  const episodes = [];
  for (let k = 0, n = 0; k < input.length; k += maxPerEpisode, n += 1) {
    const chunk = input.slice(k, k + maxPerEpisode).map((attempt, index) => normalizeAttempt(attempt, index));
    episodes.push({
      id: `${idPrefix}-${digest12}-${n}`,
      source,
      goal: boundedText(`${goalPrefix} ${digest12} chunk ${n}`, 200),
      createdAt: `derived:${digest12}`,
      attempts: chunk,
    });
  }
  return { episodes, digest12 };
}

/**
 * One slot per source class: replace the whole derived set for `sourceClass`
 * (never accumulate), or skip the write entirely when the existing set for
 * that class is byte-identical to the newly derived set. User `capture`
 * episodes are never selected by the filter. Returns a bounded result; never
 * throws.
 */
export function replaceDerivedSet({ store, sourceClass, derivedSet }) {
  const base = store && store.schema === RRSI_STORE_SCHEMA ? store : emptyStore();
  const set = Array.isArray(derivedSet) ? derivedSet : [];
  const prior = base.episodes.filter((episode) => episode && episode.source === sourceClass);
  const identical = prior.length === set.length && prior.every((episode, index) => JSON.stringify(episode) === JSON.stringify(set[index]));
  const priorAttempts = prior.reduce((sum, episode) => sum + (Array.isArray(episode.attempts) ? episode.attempts.length : 0), 0);
  const nextAttempts = set.reduce((sum, episode) => sum + (Array.isArray(episode.attempts) ? episode.attempts.length : 0), 0);
  if (identical) {
    return { store: base, storeWrite: "unchanged", episodesDelta: 0, attemptsDelta: 0 };
  }
  const episodes = [...base.episodes.filter((episode) => episode && episode.source !== sourceClass), ...set].slice(-RRSI_LIMITS.maxEpisodes);
  return {
    store: { schema: RRSI_STORE_SCHEMA, updatedAt: base.updatedAt, episodes },
    storeWrite: prior.length === 0 ? "added" : "replaced",
    episodesDelta: episodes.length - base.episodes.length,
    attemptsDelta: nextAttempts - priorAttempts,
  };
}

/**
 * Exclusive plugin-local store lock used by `capture`, `import` and the
 * periodic writer to serialize their read-modify-write sequences (not a
 * cross-process guarantee for foreign writers). Bounded 100 ms wait; stale
 * takeover by age; released in `finally`. Contended wait returns
 * `{ ok:false, reason:"store_busy" }` — no throw, no retry, no partial write.
 */
export function withStoreLock(env, fn) {
  const root = rrsiRoot(env);
  if (!privateDirSafe(root, { create: true })) return { ok: false, reason: "unsafe_path" };
  const file = path.join(root, "store.lock");
  const deadline = Date.now() + RRSI_STORE_LOCK_WAIT_MS;
  const tryAcquire = () => {
    try {
      fs.mkdirSync(rrsiRoot(env), { recursive: true, mode: 0o700 });
    } catch {
      /* reported by the write path */
    }
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fs.closeSync(fd);
      return true;
    } catch (error) {
      if (error && error.code !== "EEXIST") return false;
      try {
        const stat = fs.lstatSync(file);
        if (Date.now() - stat.mtimeMs > RRSI_STORE_LOCK_STALE_MS) {
          fs.unlinkSync(file);
          return tryAcquire();
        }
      } catch {
        /* raced */
      }
      return false;
    }
  };
  while (Date.now() < deadline) {
    if (tryAcquire()) {
      try {
        return { ok: true, result: fn() };
      } finally {
        try {
          fs.unlinkSync(file);
        } catch {
          /* best effort */
        }
      }
    }
    const until = Date.now() + 10;
    while (Date.now() < until) {
      /* bounded wait */
    }
  }
  return { ok: false, reason: "store_busy" };
}

/**
 * Store attempts -> the replay corpus (epochs partition at adopted attempts).
 * An unknown wallMs stays null; the replay core scores a null cost as 0 and a
 * null hunks count as 0 — those coercions live in this projection only, the
 * stored attempt keeps its unknown value.
 */
export function corpusFromStore(store) {
  const attempts = [];
  for (const episode of store?.episodes ?? []) {
    for (const attempt of episode.attempts ?? []) {
      const seq = attempts.length + 1;
      const novelty = attempt.hypothesisNovelty !== false;
      attempts.push({
        seq,
        cycleId: `${episode.id}-${attempt.index}`,
        objective: attempt.objective,
        hypothesisHash: sha256Hex(novelty ? `novel|${episode.id}|${attempt.index}` : `shared|${attempt.objective}`),
        baseCommit: null,
        budgetRung: attempt.budgetRung ?? 0,
        // JJO-2360: the recorded changed-path list (not an empty placeholder) so
        // the replay core sees the files the attempt actually touched.
        files: Array.isArray(attempt.files) ? attempt.files.slice(0, MAX_ATTEMPT_FILES) : [],
        hunks: attempt.hunks ?? 0,
        wallMs: attempt.wallMs ?? null,
        guardFailures: attempt.guardFailures ?? [],
        decision: attempt.decision ?? "inconclusive",
        delta: null,
        adoption: attempt.decision === "adopt" ? { commit: episode.id.slice(0, 7), install: "not_attempted" } : null,
        createdAt: episode.createdAt,
      });
    }
  }
  return corpusFromAttempts(attempts);
}

/**
 * Dream over the store with the bundled core. The synthetic adapter keeps the
 * store's branch order as the policy objective order (documented; the store is
 * not a domain adapter).
 */
export function dreamOverStore({ store, seed = 1, maxCandidates = 48, passGateN = 20, trainN = 14, validationN = 6 }) {
  const corpus = corpusFromStore(store);
  const objectives = [...new Set(corpus.attempts.map((attempt) => attempt.objective))];
  const receipt = runDream({
    corpus,
    adapter: { objectives },
    seed,
    maxCandidates,
    passGateN,
    trainN,
    validationN,
  });
  return { corpus, receipt };
}

/** Bounded tool-facing summary of a dream receipt (the full receipt stays in memory). */
export function summarizeReceipt(receipt) {
  return {
    schema: receipt.schema,
    seed: receipt.seed,
    corpus: receipt.corpus,
    candidateCount: receipt.candidateCount,
    selected: receipt.selected,
    baselines: {
      B0: receipt.baselines.B0.validation,
      B1: receipt.baselines.B1.validation,
    },
    thresholds: {
      evaluated: receipt.thresholds.evaluated,
      reason: receipt.thresholds.reason ?? null,
      ...(receipt.thresholds.evaluated
        ? { attemptsOk: receipt.thresholds.attemptsOk, costOk: receipt.thresholds.costOk, antiFlukeOk: receipt.thresholds.antiFlukeOk }
        : { advisory: receipt.thresholds.advisory ? { attemptsOk: receipt.thresholds.advisory.attemptsOk, costOk: receipt.thresholds.advisory.costOk } : null, downgradeNote: receipt.thresholds.downgradeNote ?? null }),
    },
    gate: receipt.gate,
    verdict: receipt.verdict,
    caveat: receipt.caveat,
    receiptHash: receipt.receiptHash,
    ranking: receipt.rankings.slice(0, 8),
  };
}

// --- Dream policy receipt ---------------------------------------------------
// The dream action returns a bounded summary to the caller. The top ranked
// policy ids and their measured scores are also written as one private receipt
// (0600 inside the plugin's own 0700 receipts directory) so a later session can
// see what was measured without re-running the dream. The receipt holds ids and
// numbers only: no goal, objective label, task text or credential can enter it.

export const RRSI_DREAM_RECEIPT_SCHEMA = "gjc.rrsi.dream.receipt.v1";

export const RRSI_DREAM_RECEIPT_LIMITS = Object.freeze({
  topPolicies: 5,
  maxBytes: 16 * 1024,
});

/** Measured score numbers of one policy slice; an unmeasured value stays null. */
function policyScoreSummary(score) {
  if (!score || typeof score !== "object") return null;
  return {
    attemptsToFirstAdoption: optionalNonNegative(score.attemptsToFirstAdoption, 100_000),
    costMsToFirstAdoption: optionalNonNegative(score.costMsToFirstAdoption, 86_400_000),
    adoptionReached: score.adoptionReached === true,
    attemptsPlayed: optionalNonNegative(score.attemptsPlayed, 100_000),
    value: optionalNumber(score.value),
  };
}

/**
 * Bounded private-receipt view of a dream receipt: the selected policy id plus
 * the top `topPolicies` ranked ids with their measured train/validation scores.
 */
export function dreamPolicyReceipt(receipt, { now = new Date().toISOString(), topPolicies = RRSI_DREAM_RECEIPT_LIMITS.topPolicies } = {}) {
  const candidates = new Map();
  for (const candidate of Array.isArray(receipt?.candidates) ? receipt.candidates : []) {
    if (candidate && typeof candidate.id === "string") candidates.set(candidate.id, candidate);
  }
  const top = [];
  for (const id of Array.isArray(receipt?.rankings) ? receipt.rankings : []) {
    if (top.length >= topPolicies) break;
    const candidate = candidates.get(id);
    if (!candidate) continue;
    top.push({ policyId: id, validation: policyScoreSummary(candidate.validation), train: policyScoreSummary(candidate.train) });
  }
  const baseline = (key) => policyScoreSummary(receipt?.baselines?.[key]?.validation);
  return {
    schema: RRSI_DREAM_RECEIPT_SCHEMA,
    createdAt: now,
    seed: optionalInteger(receipt?.seed, 1_000_000),
    receiptHash: typeof receipt?.receiptHash === "string" ? receipt.receiptHash.slice(0, 64) : null,
    candidateCount: optionalInteger(receipt?.candidateCount, 1000),
    selected: typeof receipt?.selected?.id === "string" ? receipt.selected.id.slice(0, 32) : null,
    gate: {
      ok: receipt?.gate?.ok === true,
      reason: typeof receipt?.gate?.reason === "string" ? receipt.gate.reason.slice(0, 64) : null,
    },
    top,
    baselines: { B0: baseline("B0"), B1: baseline("B1") },
    verdict: typeof receipt?.verdict === "string" ? receipt.verdict.slice(0, 120) : null,
  };
}

/**
 * Write one private receipt (0600, temp + rename) into an existing receipts
 * directory. The body is bounded before any write; an oversized or unsafe
 * request is reported, never trimmed silently. Retention stays the caller's
 * (`pruneReceipts` keeps the directory's retained-window bound).
 */
export function writeDreamReceipt({ dir, receipt, now = new Date().toISOString(), maxBytes = RRSI_DREAM_RECEIPT_LIMITS.maxBytes } = {}) {
  if (!receipt || receipt.schema !== RRSI_DREAM_RECEIPT_SCHEMA) return { persisted: false, reason: "invalid_metadata", file: null, bytes: 0 };
  if (typeof dir !== "string" || dir.length === 0) return { persisted: false, reason: "unsafe_path", file: null, bytes: 0 };
  if (!privateDirSafe(dir, { create: true })) return { persisted: false, reason: "unsafe_path", file: null, bytes: 0 };
  const body = `${JSON.stringify(receipt, null, 2)}\n`;
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > maxBytes) return { persisted: false, reason: "resource_limit", file: null, bytes: 0 };
  const compact = String(now).replace(/[^0-9]/g, "").slice(0, 14);
  const file = path.join(dir, `${compact}-dr-${randomBytes(3).toString("hex")}.json`);
  const temp = `${file}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, body, { mode: 0o600 });
    fs.renameSync(temp, file);
    return { persisted: true, reason: "stored", file, bytes };
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    return { persisted: false, reason: "receipt_unavailable", file: null, bytes: 0 };
  }
}

// --- Quality cohort ---------------------------------------------------------
// The operational journal projection above records that an advice answer was
// returned. That is availability telemetry, not task quality. Quality evidence
// may only come from the separate, versioned trial cohort validated by the
// canonical `gjc.quality_trial.v2` contract (self-improve/lib/quality-trial.mjs,
// inlined at build time): an independent producer/executor/verifier split, a
// complete denominator, a measured non-negative cost and pinned source and
// harness digests. This projection exposes counts only — there is no
// "efficacy claims allowed" boolean, and admissibility is never inferred from
// row counts; a consumer that wants a claim has to read the cohort it has.

export const RRSI_QUALITY_SCHEMA = QUALITY_TRIAL_SCHEMA;
export const RRSI_QUALITY_COHORT_SCHEMA = QUALITY_COHORT_SCHEMA;

export type QualityExclusion =
  | "legacy_schema"
  | "conflicting_duplicate"
  | "non_independent_producer"
  | "non_independent_oracle"
  | "unknown_outcome"
  | "negative_cost"
  | "missing_cost"
  | "denominator_mismatch";

export type QualityAttempt = {
  provenance: string;
  objective: string;
  taskVersion: string;
  split: "training" | "development" | "holdout";
  arm: "B0" | "B1" | "B2";
  repeat: number;
  executionKey: string;
  decision: "adopt" | "reject";
  wallMs: number;
  usd: number;
  costMeasured: true;
  sourceDigest: string;
  harnessDigest: string;
};

export type QualityCohort = {
  schema: string;
  total: number;
  admissible: QualityAttempt[];
  excluded: { reason: QualityExclusion; count: number }[];
  duplicate: number;
};

/** Counts-only cohort over `gjc.quality_trial.v2` records (delegates to the canonical validator). */
export function projectQualityCohort(records: readonly unknown[], { limit = 4000 }: { limit?: number } = {}): QualityCohort {
  return projectQualityTrialCohort(records, { limit }) as QualityCohort;
}

export const RRSI_ACTION_LIST = Object.freeze([...RRSI_ACTIONS]);
