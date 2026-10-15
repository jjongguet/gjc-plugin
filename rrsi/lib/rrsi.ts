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
 * (0700 dir, 0600 file) and is never committed.
 */
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

export const RRSI_STORE_SCHEMA = "gjc.rrsi.store.v1";

export const RRSI_SCOPE_SENTENCE =
  "Functional acceptance only: rrsi captures exploration episodes, projects journals into attempt records and replays them through the bundled Dream-RSI core. The performance proof (P1-P3) applies to the self-improve loop and its frozen corpus, not to this plugin; no accuracy, savings or routing claim is made.";

export const RRSI_LIMITS = Object.freeze({
  maxEpisodes: 128,
  maxAttemptsPerEpisode: 40,
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

function projectionDigestHex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function boundedText(value, max = RRSI_LIMITS.maxTextChars) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedInteger(value, max = Number.MAX_SAFE_INTEGER, fallback = 0) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : fallback;
}

export function emptyStore(now = new Date().toISOString()) {
  return { schema: RRSI_STORE_SCHEMA, updatedAt: now, episodes: [] };
}

/** Flatten one exploration attempt into the bounded core-shaped record. */
export function normalizeAttempt(raw, index) {
  const objective = boundedText(raw?.objective ?? raw?.goal ?? "unlabeled", 120) || "unlabeled";
  const decision = RRSI_DECISIONS.includes(raw?.decision) ? raw.decision : "inconclusive";
  const guardFailures = Array.isArray(raw?.guardFailures)
    ? raw.guardFailures.filter((value) => typeof value === "string" && value.length > 0).slice(0, 16).map((value) => value.slice(0, 40))
    : [];
  return {
    index: boundedInteger(index, RRSI_LIMITS.maxAttemptsPerEpisode),
    objective,
    hypothesisNovelty: raw?.hypothesisNovelty !== false,
    decision,
    wallMs: boundedInteger(raw?.wallMs, 86_400_000),
    guardFailures,
    budgetRung: boundedInteger(raw?.budgetRung, 16),
    files: boundedInteger(raw?.files, 512),
    hunks: boundedInteger(raw?.hunks, 4096),
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

/**
 * Read-only projection of the jev-advisor journal segments. Records are read in
 * segment order and never modified; the caller decides what to persist.
 */
export function readJournalRecords({ journalDir, maxSegments = RRSI_LIMITS.maxJournalSegments } = {}) {
  const dir = journalDir ?? rrsiJournalDir();
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".jsonl")).sort();
  } catch {
    return { status: "missing", records: [], segments: 0, reason: "no_journal" };
  }
  const segments = names.slice(-maxSegments);
  const records = [];
  for (const name of segments) {
    let text;
    try {
      const file = path.join(dir, name);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > RRSI_LIMITS.maxReadBytes) continue;
      text = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    let count = 0;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      count += 1;
      if (count > RRSI_LIMITS.maxJournalRecordsPerSegment) break;
      try {
        records.push(JSON.parse(line));
      } catch {
        /* a malformed line is skipped, never repaired */
      }
    }
  }
  return { status: records.length > 0 ? "ok" : "missing", records, segments: segments.length, reason: records.length > 0 ? null : "no_records" };
}

/**
 * Journal record -> attempt projection (bounded, flattened for the replay core):
 *   branch objective = "<operation>:<tier|advice-status>"
 *   hypothesisNovelty = first record of that branch in the read order
 *   priorFailures = count of earlier records of that branch whose advice was not a decision
 *   decision = "adopt" when the record carries a decision else "reject"
 *   wallMs = durationMs; provenance = the journal record id
 */
export function projectJournalRecords(records, { limit = 4000 } = {}) {
  const seen = new Map();
  const attempts = [];
  for (const record of records) {
    if (attempts.length >= limit) break;
    if (!record || typeof record !== "object") continue;
    const operation = boundedText(record.operation, 40) || "unknown";
    const status = boundedText(record.advice?.status ?? record.assessment?.status ?? "unknown", 40) || "unknown";
    const tier = boundedText(record.advice?.tier, 16) || status;
    const objective = `${operation}:${tier}`;
    const branch = seen.get(objective) ?? { records: 0, failures: 0 };
    attempts.push(
      normalizeAttempt(
        {
          objective,
          hypothesisNovelty: branch.records === 0,
          decision: record.advice?.status === "decision" ? "adopt" : "reject",
          wallMs: boundedInteger(record.durationMs, 86_400_000),
          guardFailures: [],
          budgetRung: 0,
          files: 0,
          hunks: 0,
          provenance: boundedText(record.id, RRSI_LIMITS.maxIdChars),
        },
        attempts.length,
      ),
    );
    seen.set(objective, { records: branch.records + 1, failures: branch.failures + (record.advice?.status === "decision" ? 0 : 1) });
  }
  return { attempts, branches: seen.size };
}

/** Ledger cycle rows -> attempts (read-only summary of the repo search history). */
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
          wallMs: boundedInteger(row.cost?.wallMs, 86_400_000),
          guardFailures: Array.isArray(row.guards) ? row.guards.filter((guard) => guard.status !== "pass").map((guard) => guard.id) : [],
          budgetRung: boundedInteger(row.budgetRung, 16),
          files: Array.isArray(row.proposal?.files) ? row.proposal.files.length : 0,
          hunks: boundedInteger(row.proposal?.hunks, 4096),
          provenance: boundedText(row.cycleId, RRSI_LIMITS.maxIdChars),
        },
        attempts.length,
      ),
    );
  }
  return { attempts };
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
  const file = path.join(rrsiRoot(env), "store.lock");
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

/** Store attempts -> the replay corpus (epochs partition at adopted attempts). */
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
        files: [],
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

export const RRSI_ACTION_LIST = Object.freeze([...RRSI_ACTIONS]);
