/**
 * M1 pilot preflight: plan the cells and the request slots, budget every
 * request (not just every cell), resolve oracles, prove isolation and loading,
 * and refuse every live path by construction.
 *
 * This module never calls a model. `--live` is refused with one of five stable
 * codes unless a caller injects an existing executor; even then preflight only
 * admits the plan. The dry run's artifact is the deterministic blocker report,
 * not a trial result.
 *
 * Optional `subset` pins one already-validated development case:
 *   { schema: "harness2.m1.subset.v1", taskIds: [...], manifestDigest, taskDigest }
 * It never weakens the whole-manifest validation (`validateManifest`), never
 * reads an oracle payload and can never name a holdout task.
 *
 * One digest convention only: `manifestDigest(manifest)` from behavior-eval, the
 * same value `validateManifest(manifest).digest` returns. Nothing is stripped,
 * re-serialized differently or mutated by the CLI.
 */
import { createHash } from "node:crypto";
import { admitCall, manifestDigest, planTrial, validateManifest } from "../lib/behavior-eval.mjs";

export const PREFLIGHT_SCHEMA = "harness2.m1.preflight.v1";
export const PREFLIGHT_SUBSET_SCHEMA = "harness2.m1.subset.v1";
export const PREFLIGHT_LIMITS = Object.freeze({ maxCells: 512, maxRepeats: 5, maxArms: 3 });

/**
 * Attempt slots per cell per arm. B0 is one shot; B1 and B2 spend three calls on
 * the same cell (draft, check, refine), so a one-task pilot is 3 + 9 + 9 = 21
 * model requests and a 27-cell development dry plan is 63.
 */
export const ARM_ATTEMPTS = Object.freeze({ B0: 1, B1: 3, B2: 3 });

export const LIVE_RESPONSE_CODES = Object.freeze([
  "live_not_approved",
  "live_approval_invalid",
  "live_cap_exceeds_declared",
  "live_approval_without_live",
  "live_executor_absent",
]);

/** No oracle comparator is implemented in this slice; a caller may inject one. */
export const DEFAULT_COMPARATORS = Object.freeze({});

const isPositiveInt = (value) => Number.isSafeInteger(value) && value >= 1;
const isDigestHex = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const numericOrNaN = (value) => {
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim() !== "") return Number(value);
  return Number.NaN;
};
const isPresent = (value) => value !== undefined && value !== null;

function countCodes(blockers) {
  const counts = {};
  for (const blocker of blockers) counts[blocker.code] = (counts[blocker.code] ?? 0) + 1;
  return counts;
}

const cellIdFor = (cell) => `${cell?.taskId ?? "unknown"}/${cell?.arm ?? "unknown"}/r${cell?.repeat ?? 0}`;

/**
 * The frozen manifest's canonical digest: `manifestDigest(manifest)` unchanged,
 * i.e. exactly what `validateManifest(manifest).digest` returns. There is no
 * second serializer and no field exclusion: a `digest` the manifest already
 * declares is ordinary declared input hashed whole, never treated as
 * authoritative and never substituted for this value. Exported so the parent
 * computes the subset binding with the same code the preflight checks.
 */
export function manifestDigestFor(manifest) {
  if (!manifest || typeof manifest !== "object") return null;
  return manifestDigest(manifest);
}

/**
 * Digest pin for the tasks a subset selects: `manifestDigest` applied to the
 * selected task objects in manifest order, as an array even for one task.
 */
export function taskDigestFor(tasks) {
  const list = Array.isArray(tasks) ? tasks : [tasks];
  return manifestDigest(list);
}

/**
 * Validate an optional subset against the whole manifest. Every failure is a
 * named blocker: a bad schema, a malformed digest, a mismatched manifest or
 * task digest, an empty/duplicate/undeclared id, or a holdout id. A holdout id
 * is refused before anything about its oracle is touched.
 */
export function validateSubset({ manifest = null, subset = null } = {}) {
  const identity = {
    provided: isPresent(subset),
    schema: null,
    taskIds: [],
    taskCount: 0,
    manifestDigest: null,
    taskDigest: null,
    manifestDigestCanonical: manifestDigestFor(manifest),
    taskDigestCanonical: null,
  };
  const blockers = [];
  const fail = (code, extra = {}) => blockers.push({ code, source: "subset", ...extra });
  if (!identity.provided) return { ok: true, blockers, identity, tasks: [] };
  if (typeof subset !== "object" || Array.isArray(subset)) {
    fail("subset_invalid", { reason: "not_an_object" });
    return { ok: false, blockers, identity, tasks: [] };
  }
  identity.schema = subset.schema ?? null;
  if (subset.schema !== PREFLIGHT_SUBSET_SCHEMA) fail("subset_invalid", { reason: "schema", expected: PREFLIGHT_SUBSET_SCHEMA });

  const rawIds = subset.taskIds;
  if (!Array.isArray(rawIds) || rawIds.length === 0) {
    fail("subset_empty", { reason: "task_ids_missing" });
  } else {
    identity.taskIds = rawIds.filter((id) => typeof id === "string");
    const invalid = rawIds.filter((id) => typeof id !== "string" || id.trim().length === 0);
    if (invalid.length > 0) fail("subset_empty", { reason: "task_id_invalid", count: invalid.length });
    const seen = new Set();
    for (const id of rawIds) {
      if (typeof id !== "string" || id.length === 0) continue;
      if (seen.has(id)) fail("subset_duplicate_task", { taskId: id });
      else seen.add(id);
    }
  }

  if (!isDigestHex(subset.manifestDigest)) fail("subset_invalid", { reason: "manifest_digest_shape" });
  if (!isDigestHex(subset.taskDigest)) fail("subset_invalid", { reason: "task_digest_shape" });
  identity.manifestDigest = typeof subset.manifestDigest === "string" ? subset.manifestDigest : null;
  identity.taskDigest = typeof subset.taskDigest === "string" ? subset.taskDigest : null;

  const canonicalManifest = identity.manifestDigestCanonical;
  if (isDigestHex(subset.manifestDigest) && canonicalManifest !== null && subset.manifestDigest !== canonicalManifest) {
    fail("subset_manifest_digest_mismatch", { expected: canonicalManifest, actual: subset.manifestDigest });
  }

  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const byId = new Map();
  for (const task of tasks) if (task && typeof task.id === "string") byId.set(task.id, task);
  const selected = [];
  for (const id of Array.isArray(rawIds) ? rawIds : []) {
    if (typeof id !== "string" || id.length === 0) continue;
    const task = byId.get(id);
    if (!task) { fail("subset_undeclared_task", { taskId: id }); continue; }
    if (task.split !== "development") { fail("subset_holdout_task", { taskId: id, split: task.split ?? null }); continue; }
    selected.push(task);
  }
  identity.taskCount = selected.length;
  const canonicalTask = selected.length > 0 ? taskDigestFor(selected) : null;
  identity.taskDigestCanonical = canonicalTask;
  if (isDigestHex(subset.taskDigest) && canonicalTask !== null && subset.taskDigest !== canonicalTask) {
    fail("subset_task_digest_mismatch", { expected: canonicalTask, actual: subset.taskDigest });
  }
  return { ok: blockers.length === 0, blockers, identity, tasks: selected };
}

/**
 * Development cells only: the holdout stays untouched and is reported by id.
 * With a subset, only the ids the subset validated become cells; without one,
 * every development task does (the legitimate full development dry plan).
 */
export function planCells({ manifest, subset = null, repeats = 3, arms = ["B0", "B1", "B2"] } = {}) {
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const holdoutTasks = tasks.filter((task) => task?.split === "holdout").map((task) => task.id);
  const subsetResult = validateSubset({ manifest, subset });
  const subsetTasks = subsetResult.ok ? subsetResult.tasks.map((task) => task.id) : [];
  const base = {
    cells: [],
    count: 0,
    holdoutTasks,
    arms,
    repeats,
    subset: subsetResult.identity,
    subsetBlockers: subsetResult.blockers,
    subsetTasks,
    error: null,
  };
  if (!subsetResult.ok) return { ...base, error: "subset_invalid" };
  if (!isPositiveInt(repeats) || repeats > PREFLIGHT_LIMITS.maxRepeats) return { ...base, error: "invalid_repeats" };
  if (!Array.isArray(arms) || arms.length === 0 || arms.length > PREFLIGHT_LIMITS.maxArms) return { ...base, error: "invalid_arms" };
  for (const arm of arms) if (!Number.isSafeInteger(ARM_ATTEMPTS[arm])) return { ...base, error: "unknown_arm" };
  const development = subsetResult.identity.provided ? subsetResult.tasks : tasks.filter((task) => task?.split === "development");
  const cells = [];
  for (const task of development) {
    for (const arm of arms) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        cells.push({ cellId: cellIdFor({ taskId: task.id, arm, repeat }), taskId: task.id, klass: task.klass, split: task.split, arm, repeat });
        if (cells.length > PREFLIGHT_LIMITS.maxCells) return { ...base, cells: [], error: "cell_limit" };
      }
    }
  }
  return { ...base, cells, count: cells.length };
}

/**
 * Expand cells into the exact model-request slots a live run would spend. B0
 * costs one request per cell, B1 and B2 cost three on the same cell. A caller
 * that only budgeted cells therefore under-counts by more than half and must
 * never be admitted for a 21-request pilot.
 */
export function planRequests({ cells = [] } = {}) {
  const requests = [];
  let error = null;
  for (const cell of Array.isArray(cells) ? cells : []) {
    const attempts = ARM_ATTEMPTS[cell?.arm];
    if (!Number.isSafeInteger(attempts)) { error = error ?? "unknown_arm"; continue; }
    const cellId = cell.cellId ?? cellIdFor(cell);
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      requests.push({
        slotId: `${cellId}/a${attempt}`,
        cellId,
        taskId: cell.taskId ?? null,
        klass: cell.klass ?? null,
        split: cell.split ?? null,
        arm: cell.arm,
        repeat: cell.repeat ?? null,
        attempt,
      });
    }
  }
  return { requests, count: requests.length, attemptsByArm: ARM_ATTEMPTS, error };
}

const usageOf = (raw) => {
  if (!isPresent(raw)) return { ok: true, value: 0 };
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) return { ok: false, value: null };
  return { ok: true, value: raw };
};

/**
 * Accumulate the projected spend across request slots. Admission runs per
 * request: prior spend, prior reservations, unresolved charges and cleanup are
 * committed up front, the first refusal blocks every later request, and
 * `maxCalls` applies to requests rather than cells. Unknown, NaN or negative
 * price bounds and malformed usage are refused, never coerced to zero.
 */
export function planBudget({ budget, cells = [], requests = null } = {}) {
  const capUsd = numericOrNaN(budget?.capUsd);
  const rawBounds = [budget?.pricePer1kInputUsd, budget?.pricePer1kOutputUsd, budget?.maxInputTokensPerCall, budget?.maxOutputTokensPerCall];
  const bounds = rawBounds.map(numericOrNaN);
  const usage = {
    spentUsd: usageOf(budget?.spentUsd),
    reservedUsd: usageOf(budget?.reservedUsd),
    unresolvedUsd: usageOf(budget?.unresolvedUsd),
    cleanupUsd: usageOf(budget?.cleanupUsd),
  };
  const rawMaxCalls = budget?.maxCalls;
  const maxCalls = isPresent(rawMaxCalls) ? numericOrNaN(rawMaxCalls) : null;

  let refused = null;
  if (rawBounds.some((value) => !isPresent(value))) refused = "price_bounds_missing";
  else if (bounds.some((value) => !Number.isFinite(value) || value < 0)) refused = "price_bounds_invalid";
  if (refused === null && (!Number.isFinite(capUsd) || capUsd < 0)) refused = "missing_cap";
  if (refused === null && Object.values(usage).some((entry) => entry.ok !== true)) refused = "usage_invalid";
  if (refused === null && maxCalls !== null && (!Number.isSafeInteger(maxCalls) || maxCalls <= 0)) refused = "invalid_max_calls";

  const priceOk = rawBounds.every(isPresent) && bounds.every((value) => Number.isFinite(value) && value >= 0);
  const perCallUsd = priceOk ? (bounds[2] / 1000) * bounds[0] + (bounds[3] / 1000) * bounds[1] : null;

  const planned = Array.isArray(requests)
    ? { requests, count: requests.length, error: null }
    : planRequests({ cells });
  if (refused === null && planned.error) refused = planned.error;

  const baseUsd = Object.values(usage).every((entry) => entry.ok === true)
    ? Object.values(usage).reduce((sum, entry) => sum + entry.value, 0)
    : null;

  const cellById = new Map();
  for (const cell of Array.isArray(cells) ? cells : []) cellById.set(cell?.cellId ?? cellIdFor(cell), cell);

  const requestRows = [];
  let admittedUsd = 0;
  for (const [index, request] of planned.requests.entries()) {
    if (refused === null && maxCalls !== null && index >= maxCalls) refused = "call_cap_exceeded";
    if (refused !== null) {
      requestRows.push({ ...request, allowed: false, reason: refused, projected: null });
      continue;
    }
    const admission = admitCall({
      capUsd,
      spentUsd: baseUsd + admittedUsd,
      unresolvedUsd: 0,
      reservationUsd: perCallUsd,
      cleanupUsd: 0,
      priceUsd: perCallUsd,
    });
    if (!admission.allowed) {
      refused = admission.reason;
      requestRows.push({ ...request, allowed: false, reason: admission.reason, projected: null });
      continue;
    }
    admittedUsd += perCallUsd;
    requestRows.push({ ...request, allowed: true, reason: null, projected: admission.projected });
  }

  const cellRows = [];
  const aggregate = new Map();
  for (const row of requestRows) {
    let entry = aggregate.get(row.cellId);
    if (!entry) {
      const cell = cellById.get(row.cellId) ?? { cellId: row.cellId, taskId: row.taskId, klass: row.klass, split: row.split, arm: row.arm, repeat: row.repeat };
      entry = { cell, cellId: row.cellId, taskId: row.taskId, arm: row.arm, repeat: row.repeat, requests: 0, allowed: true, reason: null, projected: null };
      aggregate.set(row.cellId, entry);
      cellRows.push(entry);
    }
    entry.requests += 1;
    if (row.allowed !== true) {
      entry.allowed = false;
      entry.reason = entry.reason ?? row.reason;
    }
    if (row.projected !== null) entry.projected = row.projected;
  }

  const committedUsd = baseUsd;
  const projected = committedUsd === null ? null : committedUsd + admittedUsd;
  return {
    capUsd: Number.isFinite(capUsd) && capUsd >= 0 ? capUsd : null,
    perCallUsd,
    cleanupUsd: usage.cleanupUsd.ok ? usage.cleanupUsd.value : null,
    prior: {
      spentUsd: usage.spentUsd.value,
      reservedUsd: usage.reservedUsd.value,
      unresolvedUsd: usage.unresolvedUsd.value,
      cleanupUsd: usage.cleanupUsd.value,
    },
    committedUsd,
    maxCalls: maxCalls !== null && Number.isSafeInteger(maxCalls) && maxCalls > 0 ? maxCalls : null,
    cells: cellRows,
    requests: requestRows,
    requestCount: requestRows.length,
    projected,
    remaining: Number.isFinite(capUsd) && projected !== null ? capUsd - projected : null,
    refused,
    admitted: refused === null && requestRows.every((row) => row.allowed === true),
  };
}

/**
 * Resolve each task's oracle and prompt (both splits: resolving does not run a
 * task). A declared but unimplemented oracle kind is
 * `oracle_kind_unimplemented`; a missing path is `oracle_unresolved`; a task
 * without a prompt is `prompt_missing`.
 */
export function resolveOracle({ manifest, comparators = DEFAULT_COMPARATORS } = {}) {
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const rows = [];
  const blockers = [];
  for (const task of tasks) {
    const kind = task?.oracle?.kind ?? null;
    const hasPath = typeof task?.oracle?.path === "string" && task.oracle.path.length > 0;
    const hasPrompt = typeof task?.prompt === "string" && task.prompt.trim().length > 0;
    const implemented = typeof kind === "string" && typeof comparators[kind] === "function";
    if (!hasPath) blockers.push({ code: "oracle_unresolved", taskId: task.id, source: "oracle" });
    else if (!implemented) blockers.push({ code: "oracle_kind_unimplemented", taskId: task.id, kind, source: "oracle" });
    if (!hasPrompt) blockers.push({ code: "prompt_missing", taskId: task.id, source: "oracle" });
    rows.push({ taskId: task.id, split: task?.split ?? null, kind, hasPath, hasPrompt, resolved: hasPath && hasPrompt && implemented });
  }
  return { tasks: rows, resolved: rows.filter((row) => row.resolved).length, blockers, counts: countCodes(blockers) };
}

/** Five-case live refusal matrix; only an existing executor could approve. */
export function resolveLive({ live = false, approveLive = null, budget = {}, executorAvailable = false } = {}) {
  if (approveLive !== null && approveLive !== undefined && live !== true) {
    return { status: "refused", code: "live_approval_without_live", exit: 2 };
  }
  if (live !== true) return { status: "skipped", code: "live_not_approved", exit: 0 };
  const cap = typeof approveLive === "number" ? approveLive : Number(approveLive);
  if (!Number.isFinite(cap) || cap <= 0) return { status: "refused", code: "live_approval_invalid", exit: 2 };
  const declared = Number(budget?.capUsd);
  if (!Number.isFinite(declared) || cap > declared) return { status: "refused", code: "live_cap_exceeds_declared", exit: 2 };
  if (!executorAvailable) return { status: "refused", code: "live_executor_absent", exit: 2 };
  return { status: "approved", code: null, exit: 0, capUsd: cap };
}

/**
 * One deterministic preflight object. `isolation` and `loading` are injected by
 * the CLI (or a test); a missing or failed proof is a blocker, never a pass, and
 * once live is approved both receipts are mandatory. Preflight itself still
 * dispatches nothing: the parent live executor owns the calls.
 */
export function preflight({
  manifest,
  subset = null,
  budget = {},
  repeats = 3,
  arms = ["B0", "B1", "B2"],
  comparators = DEFAULT_COMPARATORS,
  isolation = null,
  loading = null,
  live = false,
  approveLive = null,
  executorAvailable = false,
  sourceHead = null,
} = {}) {
  const validity = validateManifest(manifest);
  // One pin: the canonical manifest digest the subset binds, never a digest the
  // manifest declares about itself.
  const canonicalDigest = validity.digest ?? manifestDigestFor(manifest);
  const planned = planCells({ manifest, subset, repeats, arms });
  const requests = planned.error ? { requests: [], count: 0, error: planned.error } : planRequests({ cells: planned.cells });
  const spend = planBudget({ budget, cells: planned.cells, requests: requests.requests });
  const selectedIds = new Set(planned.cells.map((cell) => cell.taskId));
  const oracle = resolveOracle({
    manifest: subset === null ? manifest : { tasks: (manifest?.tasks ?? []).filter((task) => selectedIds.has(task.id)) },
    comparators,
  });
  const liveState = resolveLive({ live, approveLive, budget, executorAvailable });
  const liveApproved = liveState.status === "approved";

  const blockers = [];
  if (!validity.ok) blockers.push({ code: "manifest_invalid", errors: validity.errors, source: "manifest" });
  if (planned.error) blockers.push({ code: planned.error, source: "cells" });
  blockers.push(...(planned.subsetBlockers ?? []));
  blockers.push(...oracle.blockers);
  if (spend.refused) blockers.push({ code: "budget_refused", reason: spend.refused, source: "budget" });
  if (isolation && isolation.status !== "pass") blockers.push({ code: "isolation_not_proven", reason: isolation.reason ?? isolation.status, source: "isolation" });
  else if (liveApproved && !isolation) blockers.push({ code: "isolation_not_proven", reason: "not_probed", source: "isolation" });
  if (loading && loading.loaded !== true) blockers.push({ code: "loading_not_proven", failures: loading.failures ?? [], source: "loading" });
  else if (liveApproved && !loading) blockers.push({ code: "loading_not_proven", failures: ["loading_not_probed"], source: "loading" });
  if (liveState.status === "refused") blockers.push({ code: liveState.code, source: "live" });

  // The plan must fit the same resource ceiling for the compute-matched arm,
  // pinned to the canonical manifest digest above.
  const trialPlan = !planned.error && canonicalDigest !== null
    ? planTrial({ arm: "B1", manifestDigest: canonicalDigest, totalResourceMs: Number(budget?.maxWallMs ?? 60_000) })
    : null;

  const body = {
    schema: PREFLIGHT_SCHEMA,
    sourceHead,
    dryRun: !liveApproved,
    manifest: {
      digest: canonicalDigest,
      tasks: Array.isArray(manifest?.tasks) ? manifest.tasks.length : 0,
      development: Array.isArray(manifest?.tasks) ? manifest.tasks.filter((task) => task?.split === "development").length : 0,
      holdout: planned.holdoutTasks,
      holdoutUsedEarly: false,
    },
    subset: planned.subset,
    arms: planned.arms,
    repeats: planned.repeats,
    cells: planned.cells,
    cellCount: planned.count,
    requests: requests.requests,
    requestCount: requests.count,
    budget: spend,
    trialPlan: trialPlan && trialPlan.ok ? { ok: true, arm: trialPlan.plan.arm } : { ok: false, reason: trialPlan?.reason ?? (planned.error ? "planning_failed" : "missing_manifest_digest") },
    oracle,
    isolation: isolation
      ? {
          runtime: isolation.runtime ?? null,
          status: isolation.status ?? "unavailable",
          reason: isolation.reason ?? null,
          allowlist: isolation.allowlist ?? null,
          profileDigestNormalized: isolation.profileDigestNormalized ?? null,
          probes: Array.isArray(isolation.probes) ? isolation.probes.map((probe) => ({ id: probe.id, passed: probe.passed === true })) : [],
        }
      : { status: "unavailable", reason: "not_probed" },
    loading: loading
      ? { loaded: loading.loaded === true, sha256: loading.sha256 ?? null, failures: loading.failures ?? [] }
      : { loaded: false, sha256: null, failures: ["loading_not_probed"] },
    live: liveState,
    blockers,
    blockerCounts: countCodes(blockers),
  };
  body.digest = createHash("sha256").update(JSON.stringify(body)).digest("hex");
  return body;
}
