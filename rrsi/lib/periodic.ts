/**
 * rrsi periodic runner: a due-gated, bounded session-start refresh of the
 * exploration store. NO timer process: the only trigger is the plugin's
 * `session_start` hook (src/periodic.adapter.ts), which awaits one bounded
 * inline attempt; large corpora are completed by a detached worker that
 * executes this same module through the generated hook file
 * (`RRSI_PERIODIC_WORKER=1 bun <plugin>/hooks/rrsi-periodic.ts`).
 *
 * Scope: functional acceptance only (see RRSI_SCOPE_SENTENCE); no accuracy,
 * savings or routing claim. Keyless and offline: no network, no credentials,
 * no model calls. Every failure path is a bounded result — this module never
 * throws. The store and its lock are shared with capture/import through
 * `withStoreLock`; the periodic lock is this module's own.
 *
 * Measured basis (M0, 2026-10-15): dream replay cost is super-linear in corpus
 * size (40 attempts ≈ 59 ms; 160 ≈ 0.8 s; 480 ≈ 18.6 s), so the inline fast
 * path dreams only when the corpus is at or below INLINE_DREAM_MAX_ATTEMPTS;
 * larger corpora take the detached-worker path (plan A1b fallback).
 */
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { appendPluginOutcome } from "../../shared/lib/results";
import {
  RRSI_LIMITS,
  replaceDerivedSet,
  derivedEpisodeSetFor,
  projectionDigestFor,
  projectJournalRecords,
  privateDirSafe,
  readJournalRecords,
  readStore,
  rrsiJournalDir,
  rrsiRoot,
  storeCounts,
  writeStore,
  withStoreLock,
  dreamOverStore,
  summarizeReceipt,
} from "./rrsi";

export const RRSI_PERIODIC_SCHEMA = "gjc.rrsi.periodic.v1";
export const RRSI_PERIODIC_RECEIPT_SCHEMA = "gjc.rrsi.periodic.run.v1";

export const RRSI_PERIODIC_DEFAULTS = Object.freeze({
  intervalMs: 24 * 60 * 60 * 1000,
  minRetryMs: 15 * 60 * 1000,
  maxWallMs: 12_000,
  inlineDreamMaxAttempts: 160,
  projectionLimit: 40,
  receiptMaxCount: 60,
  receiptMaxBytes: 64 * 1024,
  clockSkewMaxMs: 5 * 60 * 1000,
});

function bounded(value, max = 200) {
  return typeof value === "string" ? value.slice(0, max) : "";
}

export function rrsiPeriodicStatePath(env = process.env) {
  return path.join(rrsiRoot(env), "periodic.json");
}

export function rrsiPeriodicLockPath(env = process.env) {
  return path.join(rrsiRoot(env), "periodic.lock");
}

export function rrsiReceiptsDir(env = process.env) {
  return path.join(rrsiRoot(env), "runs", "v1");
}

export function resolveIntervalMs(env = process.env) {
  const raw = env && env.RRSI_PERIODIC_INTERVAL_MS;
  const parsed = typeof raw === "string" && /^\d+$/.test(raw) ? Number.parseInt(raw, 10) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 60_000) return RRSI_PERIODIC_DEFAULTS.intervalMs;
  return Math.min(parsed, 30 * 24 * 60 * 60 * 1000);
}

/** Read the periodic state: absent/invalid/unavailable reported, never repaired. */
export function readPeriodicState(env = process.env) {
  const file = rrsiPeriodicStatePath(env);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) return { status: "invalid", state: null, reason: "unsafe_or_oversized" };
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!parsed || parsed.schema !== RRSI_PERIODIC_SCHEMA) return { status: "invalid", state: null, reason: "corrupt" };
    return { status: "ok", state: parsed, reason: null };
  } catch (error) {
    if (error && error.code === "ENOENT") return { status: "missing", state: null, reason: null };
    return { status: "unavailable", state: null, reason: "io_error" };
  }
}

export function writePeriodicState({ state, env = process.env }) {
  const file = rrsiPeriodicStatePath(env);
  const body = `${JSON.stringify(state, null, 2)}\n`;
  const root = rrsiRoot(env);
  if (!privateDirSafe(root, { create: true })) return { persisted: false, reason: "unsafe_path" };
  const temp = path.join(root, `.periodic.json.tmp-${process.pid}`);
  try {
    fs.mkdirSync(rrsiRoot(env), { recursive: true, mode: 0o700 });
    fs.writeFileSync(temp, body, { mode: 0o600 });
    fs.renameSync(temp, file);
    return { persisted: true, reason: "stored" };
  } catch {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* best effort */
    }
    return { persisted: false, reason: "state_unavailable" };
  }
}

/**
 * Pure due decision. Returns { due, status, clockSkew } where status is the
 * taxonomy value when not due. `skipped_locked` is decided by the caller.
 */
export function dueForRun({ state, now, env = process.env }) {
  if (env && env.RRSI_PERIODIC === "off") return { due: false, status: "skipped_disabled", clockSkew: false };
  const intervalMs = resolveIntervalMs(env);
  const nowMs = Date.parse(now);
  let clockSkew = false;
  const readStamp = (value) => {
    const ms = typeof value === "string" ? Date.parse(value) : NaN;
    if (!Number.isFinite(ms)) return null;
    if (ms > nowMs + RRSI_PERIODIC_DEFAULTS.clockSkewMaxMs) {
      clockSkew = true;
      return nowMs;
    }
    return ms;
  };
  // nextRetryAt is a forward stamp by design and is never skew-clamped; only
  // lastAttemptAt/lastSuccessAt (past observations) carry the skew clamp.
  const lastAttempt = state ? readStamp(state.lastAttemptAt) : null;
  if (state && state.nextRetryAt) {
    const retryMs = typeof state.nextRetryAt === "string" ? Date.parse(state.nextRetryAt) : NaN;
    if (Number.isFinite(retryMs)) {
      if (nowMs < retryMs) return { due: false, status: "skipped_due", clockSkew, reason: "backoff", intervalMs };
      return { due: true, status: null, clockSkew, intervalMs };
    }
  }
  if (lastAttempt !== null && nowMs - lastAttempt < intervalMs) {
    return { due: false, status: "skipped_due", clockSkew, intervalMs };
  }
  return { due: true, status: null, clockSkew, intervalMs };
}

/**
 * Acquire the periodic lock (0600, `wx`, stale takeover by age = 2 × maxWallMs
 * once). Returns { ok:true, release, takeover } or { ok:false, reason }.
 */
export function acquirePeriodicLock({ env = process.env, now }) {
  const file = rrsiPeriodicLockPath(env);
  const staleMs = 2 * RRSI_PERIODIC_DEFAULTS.maxWallMs;
  if (!privateDirSafe(rrsiRoot(env), { create: true })) return { ok: false, reason: "unsafe_path" };
  const attempt = (allowTakeover) => {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, startedAt: now }));
      fs.closeSync(fd);
      return { ok: true };
    } catch (error) {
      if (error && error.code !== "EEXIST") return { ok: false, reason: "lock_unavailable" };
      if (!allowTakeover) return { ok: false, reason: "locked" };
      try {
        const stat = fs.lstatSync(file);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(file);
          const retry = attempt(false);
          return retry.ok ? { ok: true, takeover: true } : retry;
        }
      } catch {
        const retry = attempt(false);
        return retry.ok ? { ok: true, takeover: true } : retry;
      }
      return { ok: false, reason: "locked" };
    }
  };
  const acquired = attempt(true);
  if (!acquired.ok) return acquired;
  return {
    ok: true,
    takeover: acquired.takeover === true,
    release: () => {
      try {
        fs.unlinkSync(file);
      } catch {
        /* best effort */
      }
    },
  };
}

/** Keep at most `maxCount` receipts (oldest by mtime pruned on write). */
export function pruneReceipts({ env = process.env, maxCount = RRSI_PERIODIC_DEFAULTS.receiptMaxCount } = {}) {
  const dir = rrsiReceiptsDir(env);
  if (!privateDirSafe(dir, { create: false })) return { pruned: 0, skipped: "unsafe_path" };
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(path.join(dir, name)).mtimeMs;
        } catch {
          /* raced */
        }
        return { name, mtimeMs };
      })
      .sort((a, b) => a.mtimeMs - b.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const extra = entries.length - maxCount;
    for (let i = 0; i < extra; i += 1) {
      try {
        fs.unlinkSync(path.join(dir, entries[i].name));
      } catch {
        /* best effort */
      }
    }
    return { pruned: Math.max(0, extra) };
  } catch {
    return { pruned: 0 };
  }
}

export function countReceipts(env = process.env) {
  try {
    return fs.readdirSync(rrsiReceiptsDir(env)).filter((name) => name.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function writeReceipt({ env, receipt }) {
  const dir = rrsiReceiptsDir(env);
  if (!privateDirSafe(dir, { create: true })) return { persisted: false, reason: "unsafe_path", receiptId: receipt.receiptId };
  const file = path.join(dir, `${receipt.receiptId}.json`);
  let body = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(body, "utf8") > RRSI_PERIODIC_DEFAULTS.receiptMaxBytes) {
    const trimmed = { ...receipt, limits: undefined };
    body = `${JSON.stringify(trimmed, null, 2)}\n`;
  }
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, body, { mode: 0o600 });
    return { persisted: true, reason: "stored", receiptId: receipt.receiptId };
  } catch {
    return { persisted: false, reason: "receipt_unavailable", receiptId: receipt.receiptId };
  }
}

function receiptIdFor(now, tag) {
  const compact = now.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  return `${compact}-${tag}-${randomBytes(3).toString("hex")}`;
}

/** Default detached worker spawn: `bun <installed hook file>` with the worker flag. */
export async function defaultSpawnWorker({ env = process.env } = {}) {
  try {
    const hookFile = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hooks", "rrsi-periodic.ts");
    const child = spawn("bun", [hookFile], { env: { ...env, RRSI_PERIODIC_WORKER: "1" }, detached: true, stdio: "ignore" });
    const outcome = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ ok: true, pid: child.pid ?? null }), 250);
      child.once("error", (error) => {
        clearTimeout(timer);
        resolve({ ok: false, reason: bounded(error && (error.code || error.message) ? String(error.code ?? error.message) : "spawn_failed", 80) });
      });
      child.once("spawn", () => {
        clearTimeout(timer);
        resolve({ ok: true, pid: child.pid ?? null });
      });
    });
    if (outcome.ok) child.unref();
    return outcome;
  } catch (error) {
    return { ok: false, reason: bounded(error && error.message ? error.message : "spawn_failed", 80) };
  }
}

async function appendPeriodicRecord({ env, startedMs, summary, storage }) {
  try {
    return await appendPluginOutcome("rrsi", {
      operation: "dream",
      durationMs: Date.now() - startedMs,
      rrsi: {
        action: "dream",
        episodes: summary.episodes ?? 0,
        attempts: summary.attempts ?? 0,
        imported: summary.imported ?? 0,
        policies: summary.policies ?? 0,
        storage,
      },
    });
  } catch {
    return { persisted: false, reason: "store_unavailable" };
  }
}

/**
 * One periodic attempt. `mode:"inline"` is the hook path (bounded; may hand a
 * large dream to the detached worker); `mode:"worker"` is the detached path
 * (skips the due gate — it was spawned because a due run imported — and
 * dreams over the full bounded store). Never throws.
 */
export async function runPeriodic({ env = process.env, now = new Date().toISOString(), mode = "inline", spawnWorker = defaultSpawnWorker, dreamer = dreamOverStore } = {}) {
  const startedMs = Date.now();
  const intervalMs = resolveIntervalMs(env);
  let lock = null;
  let clockSkew = false;
  const finish = async (result) => {
    if (lock && lock.ok) lock.release();
    return result;
  };
  try {
    if (env && env.RRSI_PERIODIC === "off") return await finish({ status: "skipped_disabled", mode, receipt: false, journal: false, stateWrite: false });

    const stateRead = readPeriodicState(env);
    const state = stateRead.status === "ok" ? stateRead.state : null;
    if (!state && stateRead.status === "unavailable") {
      const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: 0, attempts: 0, imported: 0, policies: 0 }, storage: "unavailable" });
      return await finish({ status: "error", mode, reason: "state_unavailable", receipt: false, journal: true, stateWrite: false, journalStorage: mapStorage(journalStorage) });
    }

    if (mode !== "worker") {
      const due = dueForRun({ state, now, env });
      if (!due.due) return await finish({ status: due.status, mode, reason: due.reason ?? null, receipt: false, journal: false, stateWrite: false });
      clockSkew = due.clockSkew === true;
    }

    const acquired = acquirePeriodicLock({ env, now });
    if (!acquired.ok) {
      if (acquired.reason === "locked") return await finish({ status: "skipped_locked", mode, receipt: false, journal: false, stateWrite: false });
      return await finish({ status: "error", mode, reason: acquired.reason, receipt: false, journal: false, stateWrite: false });
    }
    lock = acquired;
    const takeover = acquired.takeover === true;

    // Re-check due under the lock (another session may have completed a run).
    if (mode !== "worker") {
      const recheck = dueForRun({ state: readPeriodicState(env).state, now, env });
      if (!recheck.due) return await finish({ status: recheck.status, mode, receipt: false, journal: false, stateWrite: false });
    }

    const journal = readJournalRecords({ journalDir: rrsiJournalDir(env) });
    const baseState = stateRead.status === "ok" ? stateRead.state : null;
    const writeState = (patch) => {
      const next = {
        schema: RRSI_PERIODIC_SCHEMA,
        intervalMs,
        lastAttemptAt: now,
        lastSuccessAt: baseState?.lastSuccessAt ?? null,
        lastStatus: null,
        lastReason: null,
        nextRetryAt: null,
        consecutiveFailures: baseState?.consecutiveFailures ?? 0,
        lastReceiptId: baseState?.lastReceiptId ?? null,
        lastProjectionDigest: baseState?.lastProjectionDigest ?? null,
        storeWrite: baseState?.storeWrite ?? null,
        derivedChunks: baseState?.derivedChunks ?? null,
        clockSkew: false,
        updatedAt: now,
        ...patch,
      };
      return writePeriodicState({ state: next, env });
    };

    if (journal.status !== "ok" || journal.records.length === 0) {
      const reason = journal.reason ?? "no_records";
      const stateWrite = writeState({ lastStatus: "empty", lastReason: reason, nextRetryAt: new Date(Date.parse(now) + intervalMs).toISOString(), consecutiveFailures: 0 });
		const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: 0, attempts: 0, imported: 0, policies: 0 }, storage: "missing" });
		return await finish({ status: "no_input", mode, reason, receipt: false, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage) });
    }

    const projected = projectJournalRecordsSafe(journal.records, RRSI_PERIODIC_DEFAULTS.projectionLimit);
    if (projected.failed) {
      const failures = (baseState?.consecutiveFailures ?? 0) + 1;
      const stateWrite = writeState({ lastStatus: "error", lastReason: "projection_failed", consecutiveFailures: failures, nextRetryAt: new Date(Date.parse(now) + backoffMs(failures, intervalMs)).toISOString() });
      const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: 0, attempts: 0, imported: 0, policies: 0 }, storage: "missing" });
      return await finish({ status: "error", mode, reason: "projection_failed", receipt: false, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage) });
    }
    const digest = projectionDigestFor(projected.attempts, RRSI_PERIODIC_DEFAULTS.projectionLimit);
    const { episodes: derivedSet } = derivedEpisodeSetFor({ digest, attempts: projected.attempts });

    const loaded = readStore(env);
    if (loaded.status === "invalid" || loaded.status === "unavailable") {
      const reason = loaded.status === "invalid" ? `store_${loaded.reason ?? "invalid"}` : "store_unavailable";
      const failures = (baseState?.consecutiveFailures ?? 0) + 1;
      const stateWrite = writeState({ lastStatus: "error", lastReason: reason, storeWrite: "rejected", lastProjectionDigest: digest, derivedChunks: derivedSet.length, consecutiveFailures: failures, nextRetryAt: new Date(Date.parse(now) + backoffMs(failures, intervalMs)).toISOString() });
      const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: 0, attempts: 0, imported: projected.attempts.length, policies: 0 }, storage: loaded.status });
      return await finish({ status: "error", mode, reason, receipt: false, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage) });
    }

    const lockResult = withStoreLock(env, () => {
      const current = readStore(env);
      const replaced = replaceDerivedSet({ store: current.store, sourceClass: "jev-journal", derivedSet });
      if (replaced.storeWrite === "unchanged") {
        return { store: current.store, replaced, written: { persisted: true, reason: "unchanged", bytes: 0 } };
      }
      const written = writeStore({ store: replaced.store, env });
      return { store: written.persisted ? replaced.store : current.store, replaced, written };
    });
    if (!lockResult.ok) {
      const failures = (baseState?.consecutiveFailures ?? 0) + 1;
      const reason = lockResult.reason ?? "store_busy";
      const stateWrite = writeState({ lastStatus: "error", lastReason: reason, storeWrite: "rejected", lastProjectionDigest: digest, derivedChunks: derivedSet.length, consecutiveFailures: failures, nextRetryAt: new Date(Date.parse(now) + backoffMs(failures, intervalMs)).toISOString(), clockSkew });
      const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: 0, attempts: 0, imported: projected.attempts.length, policies: 0 }, storage: loaded.status });
      return await finish({ status: "error", mode, reason, receipt: false, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage) });
    }

    const { store, replaced, written } = lockResult.result;
    const counts = storeCounts(store);
    if (!written.persisted && written.reason !== "unchanged") {
      const failures = (baseState?.consecutiveFailures ?? 0) + 1;
      const reason = written.reason;
      const stateWrite = writeState({ lastStatus: "error", lastReason: reason, storeWrite: "rejected", lastProjectionDigest: digest, derivedChunks: derivedSet.length, consecutiveFailures: failures, nextRetryAt: new Date(Date.parse(now) + backoffMs(failures, intervalMs)).toISOString() });
      const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: counts.episodes, attempts: counts.attempts, imported: projected.attempts.length, policies: 0 }, storage: loaded.status });
      const receiptWrite = writeReceipt({
        env,
        receipt: {
          schema: RRSI_PERIODIC_RECEIPT_SCHEMA,
          receiptId: receiptIdFor(now.replace(/\.\d+Z$/, "Z"), "er"),
          trigger: "session_start",
          startedAt: new Date(startedMs).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
          status: "error",
          reason,
          persisted: false,
          mode,
          projectionDigest: digest,
          storeWrite: "rejected",
          derivedChunks: derivedSet.length,
          episodes: counts.episodes,
          attempts: counts.attempts,
          imported: projected.attempts.length,
          policies: 0,
          attemptsOmitted: Math.max(0, journal.records.length - projected.attempts.length),
          limits: appliedLimits(intervalMs),
          storage: { store: loaded.status, journalStorage: mapStorage(journalStorage) },
          clockSkew,
          lockTakeover: takeover,
        },
      });
      if (receiptWrite.persisted) pruneReceipts({ env });
      return await finish({ status: "error", mode, reason, receipt: receiptWrite.persisted, journal: true, stateWrite: stateWrite.persisted });
    }

    const status = replaced.storeWrite === "unchanged" ? "unchanged" : "ran";
    const corpusAttempts = counts.attempts;

    if (mode === "inline" && corpusAttempts > RRSI_PERIODIC_DEFAULTS.inlineDreamMaxAttempts) {
      const spawned = await spawnWorker({ env, mode: "worker" });
      if (!spawned || !spawned.ok) {
        const failures = (baseState?.consecutiveFailures ?? 0) + 1;
        const stateWrite = writeState({ lastStatus: "error", lastReason: "worker_spawn_failed", storeWrite: replaced.storeWrite, lastProjectionDigest: digest, derivedChunks: derivedSet.length, consecutiveFailures: failures, nextRetryAt: new Date(Date.parse(now) + backoffMs(failures, intervalMs)).toISOString(), clockSkew });
        const journalStorage = await appendPeriodicRecord({ env, startedMs, summary: { episodes: counts.episodes, attempts: counts.attempts, imported: projected.attempts.length, policies: 0 }, storage: "ok" });
        return await finish({ status: "error", mode, reason: "worker_spawn_failed", receipt: false, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage) });
      }
      const stateWrite = writeState({ lastStatus: "deferred", lastReason: "dream_deferred", storeWrite: replaced.storeWrite, lastProjectionDigest: digest, derivedChunks: derivedSet.length, nextRetryAt: null, consecutiveFailures: 0, clockSkew });
      const deferredReceipt = writeReceipt({
        env,
        receipt: {
          schema: RRSI_PERIODIC_RECEIPT_SCHEMA,
          receiptId: receiptIdFor(now.replace(/\.\d+Z$/, "Z"), "df"),
          trigger: "session_start",
          startedAt: new Date(startedMs).toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: Date.now() - startedMs,
          status: "deferred",
          reason: "dream_deferred",
          persisted: true,
          mode,
          projectionDigest: digest,
          storeWrite: replaced.storeWrite,
          derivedChunks: derivedSet.length,
          episodes: counts.episodes,
          attempts: counts.attempts,
          imported: projected.attempts.length,
          policies: 0,
          attemptsOmitted: Math.max(0, journal.records.length - projected.attempts.length),
          limits: appliedLimits(intervalMs),
          storage: { store: loaded.status, journalStorage: null },
          clockSkew,
          lockTakeover: takeover,
        },
      });
      if (deferredReceipt.persisted) pruneReceipts({ env });
      return await finish({ status: "deferred", mode, spawned: true, storeWrite: replaced.storeWrite, receipt: deferredReceipt.persisted, stateWrite: stateWrite.persisted });
    }

    let dream = null;
    let dreamFailure = null;
    try {
      const dreamed = dreamer({ store, seed: 1 });
      const summary = summarizeReceipt(dreamed.receipt);
      dream = { ran: true, verdict: summary.verdict, receiptHash: summary.receiptHash, policies: dreamed.receipt.candidateCount };
    } catch {
      dreamFailure = "dream_failed";
    }

    const journalStorage = await appendPeriodicRecord({
      env,
      startedMs,
      summary: { episodes: counts.episodes, attempts: counts.attempts, imported: projected.attempts.length, policies: dream?.policies ?? 0 },
      storage: "ok",
    });
    const receiptId = receiptIdFor(now.replace(/\.\d+Z$/, "Z"), mode === "worker" ? "wk" : "in");
    const failuresAfter = dreamFailure ? (baseState?.consecutiveFailures ?? 0) + 1 : 0;
    const receiptWrite = writeReceipt({
      env,
      receipt: {
        schema: RRSI_PERIODIC_RECEIPT_SCHEMA,
        receiptId,
        trigger: "session_start",
        startedAt: new Date(startedMs).toISOString(),
        finishedAt: new Date().toISOString(),
        durationMs: Date.now() - startedMs,
        status: dreamFailure ? "error" : status,
        reason: dreamFailure,
        persisted: true,
        mode,
        projectionDigest: digest,
        storeWrite: replaced.storeWrite,
        derivedChunks: derivedSet.length,
        episodes: counts.episodes,
        attempts: counts.attempts,
        imported: projected.attempts.length,
        policies: dream?.policies ?? 0,
        corpusAttempts,
        receiptHash: dream?.receiptHash ?? null,
        verdict: dream?.verdict ?? null,
        attemptsOmitted: Math.max(0, journal.records.length - projected.attempts.length),
        limits: appliedLimits(intervalMs),
        storage: { store: loaded.status, journalStorage: mapStorage(journalStorage) },
        clockSkew,
        lockTakeover: takeover,
      },
    });
    if (receiptWrite.persisted) pruneReceipts({ env });
    const stateWrite = writeState({
      lastStatus: dreamFailure ? "error" : status,
      lastReason: dreamFailure,
      lastSuccessAt: dreamFailure ? (baseState?.lastSuccessAt ?? null) : now,
      lastReceiptId: receiptWrite.persisted ? receiptId : null,
      lastProjectionDigest: digest,
      storeWrite: replaced.storeWrite,
      derivedChunks: derivedSet.length,
      nextRetryAt: dreamFailure
        ? new Date(Date.parse(now) + backoffMs(failuresAfter, intervalMs)).toISOString()
        : new Date(Date.parse(now) + intervalMs).toISOString(),
      consecutiveFailures: failuresAfter,
      clockSkew,
    });
    return await finish({ status: dreamFailure ? "error" : status, mode, reason: dreamFailure, storeWrite: replaced.storeWrite, episodesDelta: replaced.episodesDelta, attemptsDelta: replaced.attemptsDelta, receipt: receiptWrite.persisted, journal: true, stateWrite: stateWrite.persisted, journalStorage: mapStorage(journalStorage), durationMs: Date.now() - startedMs });
  } catch (error) {
    return await finish({ status: "error", mode, reason: bounded(error && error.message ? error.message : "periodic_failed", 120), receipt: false, journal: false, stateWrite: false });
  }
}

function projectJournalRecordsSafe(records, limit) {
  try {
    return projectJournalRecords(records, { limit });
  } catch {
    return { attempts: [], failed: true };
  }
}

function backoffMs(failures, intervalMs) {
  const base = RRSI_PERIODIC_DEFAULTS.minRetryMs;
  const scaled = base * Math.pow(2, Math.max(0, failures - 1));
  return Math.min(scaled, intervalMs);
}

function appliedLimits(intervalMs = RRSI_PERIODIC_DEFAULTS.intervalMs) {
  return {
    limit: RRSI_PERIODIC_DEFAULTS.projectionLimit,
    maxAttemptsPerEpisode: RRSI_LIMITS.maxAttemptsPerEpisode,
    maxEpisodes: RRSI_LIMITS.maxEpisodes,
    maxStoreBytes: RRSI_LIMITS.maxStoreBytes,
    inlineDreamMaxAttempts: RRSI_PERIODIC_DEFAULTS.inlineDreamMaxAttempts,
    intervalMs,
  };
}

function mapStorage(storage) {
  return storage && typeof storage === "object" ? { persisted: storage.persisted === true, reason: bounded(storage.reason, 40) } : { persisted: false, reason: "unknown" };
}

/** Bounded summary for the `rrsi status` tool action. */
export function summarizePeriodicState({ state, env = process.env, now = new Date().toISOString() }) {
  const due = dueForRun({ state: state ?? null, now, env });
  return {
    lastAttemptAt: state?.lastAttemptAt ?? null,
    lastSuccessAt: state?.lastSuccessAt ?? null,
    lastStatus: state?.lastStatus ?? null,
    lastReason: state?.lastReason ?? null,
    nextRetryAt: state?.nextRetryAt ?? null,
    storeWrite: state?.storeWrite ?? null,
    lastProjectionDigest: state?.lastProjectionDigest ?? null,
    due: due.due,
    dueStatus: due.status ?? null,
    receiptCount: countReceipts(env),
    intervalMs: resolveIntervalMs(env),
    disabled: env && env.RRSI_PERIODIC === "off",
  };
}

/** Worker entry used by the generated hook file when executed directly. */
export async function runPeriodicWorker({ env = process.env, now = new Date().toISOString() } = {}) {
  return await runPeriodic({ env, now, mode: "worker" });
}
