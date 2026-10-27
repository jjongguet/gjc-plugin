/**
 * M1 pilot preflight: plan the cells and the budget, resolve oracles, prove
 * isolation and loading, and refuse every live path by construction.
 *
 * This module never calls a model. `--live` is refused with one of five stable
 * codes; there is no live executor to import in this slice. The dry run's
 * artifact is the deterministic blocker report, not a trial result.
 */
import { createHash } from "node:crypto";
import { admitCall, planTrial, validateManifest } from "../lib/behavior-eval.mjs";

export const PREFLIGHT_SCHEMA = "harness2.m1.preflight.v1";
export const PREFLIGHT_LIMITS = Object.freeze({ maxCells: 512, maxRepeats: 5, maxArms: 3 });
export const LIVE_REFUSAL_CODES = Object.freeze([
  "live_not_approved",
  "live_approval_invalid",
  "live_cap_exceeds_declared",
  "live_approval_without_live",
  "live_executor_absent",
]);

/** No oracle comparator is implemented in this slice; a caller may inject one. */
export const DEFAULT_COMPARATORS = Object.freeze({});

const isPositiveInt = (value) => Number.isSafeInteger(value) && value >= 1;
const isFiniteNonNegative = (value) => Number.isFinite(value) && value >= 0;

function countCodes(blockers) {
  const counts = {};
  for (const blocker of blockers) counts[blocker.code] = (counts[blocker.code] ?? 0) + 1;
  return counts;
}

/** Development cells only: the holdout stays untouched and is reported by id. */
export function planCells({ manifest, repeats = 3, arms = ["B0", "B1", "B2"] } = {}) {
  const tasks = Array.isArray(manifest?.tasks) ? manifest.tasks : [];
  const development = tasks.filter((task) => task?.split === "development");
  const holdoutTasks = tasks.filter((task) => task?.split === "holdout").map((task) => task.id);
  const cells = [];
  if (!isPositiveInt(repeats) || repeats > PREFLIGHT_LIMITS.maxRepeats) return { cells, count: 0, holdoutTasks, arms, repeats, error: "invalid_repeats" };
  if (!Array.isArray(arms) || arms.length === 0 || arms.length > PREFLIGHT_LIMITS.maxArms) return { cells, count: 0, holdoutTasks, arms, repeats, error: "invalid_arms" };
  for (const task of development) {
    for (const arm of arms) {
      for (let repeat = 1; repeat <= repeats; repeat += 1) {
        cells.push({ taskId: task.id, klass: task.klass, split: task.split, arm, repeat });
        if (cells.length > PREFLIGHT_LIMITS.maxCells) return { cells: [], count: 0, holdoutTasks, arms, repeats, error: "cell_limit" };
      }
    }
  }
  return { cells, count: cells.length, holdoutTasks, arms, repeats, error: null };
}

/**
 * Accumulate the projected spend across cells: the first refusal blocks every
 * later cell, so a per-cell admission can never let the plan total exceed the
 * cap.
 */
export function planBudget({ budget, cells = [] } = {}) {
  const capUsd = Number(budget?.capUsd);
  const pricePer1kInputUsd = Number(budget?.pricePer1kInputUsd);
  const pricePer1kOutputUsd = Number(budget?.pricePer1kOutputUsd);
  const maxInputTokensPerCall = Number(budget?.maxInputTokensPerCall);
  const maxOutputTokensPerCall = Number(budget?.maxOutputTokensPerCall);
  const cleanupUsd = Number(budget?.cleanupUsd ?? 0);
  const priceKnown = [pricePer1kInputUsd, pricePer1kOutputUsd, maxInputTokensPerCall, maxOutputTokensPerCall].every(isFiniteNonNegative);
  const perCallUsd = priceKnown ? (maxInputTokensPerCall / 1000) * pricePer1kInputUsd + (maxOutputTokensPerCall / 1000) * pricePer1kOutputUsd : null;
  const rows = [];
  let projected = 0;
  let refused = null;
  for (const cell of cells) {
    if (refused) {
      rows.push({ cell, allowed: false, reason: refused });
      continue;
    }
    const admission = admitCall({ capUsd, spentUsd: projected, unresolvedUsd: 0, reservationUsd: perCallUsd, cleanupUsd, priceUsd: perCallUsd });
    if (!admission.allowed) {
      refused = admission.reason;
      rows.push({ cell, allowed: false, reason: admission.reason });
      continue;
    }
    projected = admission.projected;
    rows.push({ cell, allowed: true, reason: null, projected });
  }
  return {
    capUsd: Number.isFinite(capUsd) ? capUsd : null,
    perCallUsd,
    cleanupUsd: Number.isFinite(cleanupUsd) ? cleanupUsd : null,
    cells: rows,
    projected,
    refused,
    admitted: refused === null && rows.every((row) => row.allowed),
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
 * the CLI (or a test); a missing or failed proof is a blocker, never a pass.
 */
export function preflight({
  manifest,
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
  const planned = planCells({ manifest, repeats, arms });
  const spend = planBudget({ budget, cells: planned.cells });
  const oracle = resolveOracle({ manifest, comparators });
  const liveState = resolveLive({ live, approveLive, budget, executorAvailable });
  const blockers = [];
  if (!validity.ok) blockers.push({ code: "manifest_invalid", errors: validity.errors, source: "manifest" });
  if (planned.error) blockers.push({ code: planned.error, source: "cells" });
  blockers.push(...oracle.blockers);
  if (spend.refused) blockers.push({ code: "budget_refused", reason: spend.refused, source: "budget" });
  if (isolation && isolation.status !== "pass") blockers.push({ code: "isolation_not_proven", reason: isolation.reason ?? isolation.status, source: "isolation" });
  if (loading && loading.loaded !== true) blockers.push({ code: "loading_not_proven", failures: loading.failures ?? [], source: "loading" });
  if (liveState.status === "refused") blockers.push({ code: liveState.code, source: "live" });

  // The plan must fit the same resource ceiling for the compute-matched arm.
  // A missing manifest digest is not replaced by a fabricated one.
  const trialPlan = !planned.error && typeof manifest?.digest === "string"
    ? planTrial({ arm: "B1", manifestDigest: manifest.digest, totalResourceMs: Number(budget?.maxWallMs ?? 60_000) })
    : null;

  const body = {
    schema: PREFLIGHT_SCHEMA,
    sourceHead,
    dryRun: liveState.status !== "approved",
    manifest: {
      digest: manifest?.digest ?? null,
      tasks: Array.isArray(manifest?.tasks) ? manifest.tasks.length : 0,
      development: planned.cells.length > 0 ? new Set(planned.cells.map((cell) => cell.taskId)).size : 0,
      holdout: planned.holdoutTasks,
      holdoutUsedEarly: false,
    },
    arms: planned.arms,
    repeats: planned.repeats,
    cells: planned.cells,
    cellCount: planned.count,
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
