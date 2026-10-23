/**
 * Offline machinery for the Harness² comparison described in HARNESS2.md and
 * ADR 0001. Nothing here calls a model or starts a process: it validates the
 * frozen pilot manifest, plans comparable arms, gates spending before a call,
 * checks trial validity, computes the paired benefit verdict and bounds lesson
 * reuse. Live trials stay a separate, budgeted decision.
 */
import { createHash } from "node:crypto";
import path from "node:path";

export const PILOT_SCHEMA = "harness2.pilot.v1";
export const ARMS = Object.freeze(["B0", "B1", "B2"]);
export const TASK_CLASSES = Object.freeze(["artifact-check", "eligible-adequacy", "small-repo-task"]);
export const SPLITS = Object.freeze(["development", "holdout"]);

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const isText = (value, max = 200) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/** Stable digest of the canonical manifest, used to pin a frozen pilot. */
export function manifestDigest(manifest) {
  return sha256(JSON.stringify(manifest));
}

/**
 * Validate a frozen pilot manifest. Oracle paths must stay outside the trial
 * mount and inside the declared oracle root; every class needs development and
 * holdout tasks.
 */
export function validateManifest(manifest, { oracleRoot = "self-improve/tests/fixtures/pilot", trialMounts = ["scratch", "home", "tmp"] } = {}) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") return { ok: false, errors: ["manifest must be an object"] };
  if (manifest.schema !== PILOT_SCHEMA) errors.push(`schema must be ${PILOT_SCHEMA}`);
  const tasks = Array.isArray(manifest.tasks) ? manifest.tasks : [];
  if (tasks.length === 0) errors.push("tasks must not be empty");
  const seen = new Set();
  const counts = Object.fromEntries(TASK_CLASSES.map((klass) => [klass, { development: 0, holdout: 0 }]));
  for (const [index, task] of tasks.entries()) {
    const where = `tasks[${index}]`;
    if (!task || typeof task !== "object") { errors.push(`${where} must be an object`); continue; }
    if (!isText(task.id, 64)) errors.push(`${where}.id must be 1..64 chars`);
    else if (seen.has(task.id)) errors.push(`${where}.id duplicates ${task.id}`);
    else seen.add(task.id);
    if (!TASK_CLASSES.includes(task.klass)) errors.push(`${where}.klass must be one of ${TASK_CLASSES.join(", ")}`);
    if (!SPLITS.includes(task.split)) errors.push(`${where}.split must be one of ${SPLITS.join(", ")}`);
    if (task.klass in counts && task.split in counts[task.klass]) counts[task.klass][task.split] += 1;
    const oracle = task.oracle;
    if (!oracle || typeof oracle !== "object") { errors.push(`${where}.oracle is required`); continue; }
    if (!isText(oracle.kind, 40)) errors.push(`${where}.oracle.kind is required`);
    if (!isText(oracle.path, 200)) { errors.push(`${where}.oracle.path is required`); continue; }
    const resolved = path.normalize(oracle.path);
    if (path.isAbsolute(resolved)) errors.push(`${where}.oracle.path must be repository-relative`);
    if (!resolved.startsWith(`${path.normalize(oracleRoot)}/`)) errors.push(`${where}.oracle.path must stay under ${oracleRoot}`);
    for (const mount of trialMounts) {
      if (resolved === mount || resolved.startsWith(`${path.normalize(mount)}/`)) errors.push(`${where}.oracle.path must never live inside the trial mount ${mount}`);
    }
  }
  for (const klass of TASK_CLASSES) {
    if (counts[klass].development < 1) errors.push(`${klass}: needs at least one development task`);
    if (counts[klass].holdout < 1) errors.push(`${klass}: needs at least one holdout task`);
  }
  return { ok: errors.length === 0, errors, counts, digest: manifestDigest(manifest) };
}

/**
 * Plan a trial for one arm. B1 and B2 must share one total resource ceiling;
 * B1 selects the first candidate that passes public build/schema checks only.
 */
export function planTrial({ arm, manifestDigest: digest, totalResourceMs, repeats = 3 }) {
  if (!ARMS.includes(arm)) return { ok: false, reason: "unknown_arm" };
  if (!Number.isSafeInteger(totalResourceMs) || totalResourceMs <= 0) return { ok: false, reason: "invalid_ceiling" };
  if (!Number.isSafeInteger(repeats) || repeats < 1) return { ok: false, reason: "invalid_repeats" };
  if (!isText(digest, 64)) return { ok: false, reason: "missing_manifest_digest" };
  return {
    ok: true,
    plan: {
      arm,
      manifestDigest: digest,
      totalResourceMs,
      actualSpendMs: 0,
      repeats,
      selection: arm === "B1" ? "first-public-check-pass" : arm === "B2" ? "refinement-composite" : "single-attempt",
      countsAllStages: arm === "B2",
    },
  };
}

/**
 * Pre-call spending admission. Unknown price or unsettled charges fail closed
 * before any call is sent.
 */
export function admitCall({ capUsd, spentUsd = 0, unresolvedUsd = 0, reservationUsd, cleanupUsd = 0, priceUsd }) {
  if (!Number.isFinite(capUsd) || capUsd < 0) return { allowed: false, reason: "missing_cap" };
  if (!Number.isFinite(priceUsd) || priceUsd < 0) return { allowed: false, reason: "unknown_price" };
  if (!Number.isFinite(reservationUsd) || reservationUsd < 0) return { allowed: false, reason: "invalid_reservation" };
  if (![spentUsd, unresolvedUsd, cleanupUsd].every(Number.isFinite)) return { allowed: false, reason: "unknown_usage" };
  const projected = spentUsd + unresolvedUsd + Math.max(reservationUsd, priceUsd) + cleanupUsd;
  if (projected > capUsd) return { allowed: false, reason: "cap_exceeded", projected };
  return { allowed: true, projected, remaining: capUsd - projected };
}

/**
 * Isolation preflight. A live trial needs an enforceable runtime and a passing
 * deny-probe set; anything less fails closed and forbids live execution.
 */
export function isolationPreflight({ runtime = null, denyProbes = [] } = {}) {
  if (typeof runtime !== "string" || runtime.trim() === "") return { status: "unavailable", reason: "no_enforceable_runtime", liveTrialsAllowed: false };
  if (!Array.isArray(denyProbes) || denyProbes.length === 0) return { status: "unavailable", reason: "no_deny_probes", liveTrialsAllowed: false };
  const failed = denyProbes.filter((probe) => probe?.passed !== true).map((probe) => probe?.id ?? "unknown");
  if (failed.length > 0) return { status: "fail", failures: failed, liveTrialsAllowed: false };
  return { status: "pass", runtime, probes: denyProbes.length, liveTrialsAllowed: true };
}

/** E-valid: every trial receipt must prove loading, isolation and a clean denominator. */
export function validateTrialReceipt(receipt) {
  const failures = [];
  if (!receipt || typeof receipt !== "object") return { valid: false, failures: ["missing_receipt"] };
  if (!isText(receipt.loadingReceipt?.sha256, 64)) failures.push("missing_loading_receipt");
  if (receipt.isolation?.denyProbesPassed !== true) failures.push("isolation_not_proven");
  if (receipt.oracle?.independent !== true) failures.push("oracle_not_independent");
  if (receipt.budget?.admitted !== true) failures.push("budget_not_admitted");
  if (receipt.holdout?.usedEarly === true) failures.push("holdout_used_early");
  if (!Array.isArray(receipt.outcomes) || receipt.outcomes.length === 0) failures.push("missing_outcomes");
  if (!receipt.cost?.measured) failures.push("cost_not_measured");
  return { valid: failures.length === 0, failures };
}

/**
 * Paired task-level benefit with a predeclared rule: no regressions, no lower
 * coverage on decidable tasks, quality delta not below -0 with a cost ratio
 * under 1. Component gains never substitute for the composite result.
 */
export function pairedBenefit(pairs, { maxCostRatio = 1, minQualityDelta = 0 } = {}) {
  if (!Array.isArray(pairs) || pairs.length === 0) return { verdict: "insufficient", reason: "no_pairs" };
  const complete = pairs.filter((pair) => pair && Number.isFinite(pair.qualityDelta) && Number.isFinite(pair.costRatio ?? 1));
  if (complete.length < 2) return { verdict: "insufficient", reason: "too_few_pairs", pairs: complete.length };
  const qualityDelta = complete.reduce((sum, pair) => sum + pair.qualityDelta, 0) / complete.length;
  const costRatio = complete.reduce((sum, pair) => sum + (pair.costRatio ?? 1), 0) / complete.length;
  const regressions = complete.filter((pair) => pair.qualityDelta < 0).length;
  const lowerCoverage = complete.filter((pair) => pair.coverageDelta !== undefined && pair.coverageDelta < 0).length;
  if (regressions > 0) return { verdict: "no-gain", reason: "regression", regressions, qualityDelta, costRatio };
  if (lowerCoverage > 0) return { verdict: "no-gain", reason: "lower_coverage", lowerCoverage, qualityDelta, costRatio };
  if (qualityDelta < minQualityDelta) return { verdict: "no-gain", reason: "quality_delta", qualityDelta, costRatio };
  if (!(costRatio < maxCostRatio)) return { verdict: "no-gain", reason: "cost_ratio", qualityDelta, costRatio };
  return { verdict: "pass", qualityDelta, costRatio, pairs: complete.length };
}

/**
 * M3 reuse: at most `maxLessons` lessons and `maxBytes` of payload, only for the
 * same objective and version, withholding contradicted or stale lessons.
 */
export function selectLessons(lessons, { objective, version, maxLessons = 3, maxBytes = 2048 } = {}) {
  const withheld = [];
  const eligible = [];
  for (const lesson of Array.isArray(lessons) ? lessons : []) {
    if (!lesson || lesson.objective !== objective || lesson.version !== version) { withheld.push({ id: lesson?.id ?? null, reason: "not_applicable" }); continue; }
    if (lesson.outcome === "contradicted") { withheld.push({ id: lesson.id, reason: "contradicted" }); continue; }
    if (lesson.outcome === "stale") { withheld.push({ id: lesson.id, reason: "stale" }); continue; }
    eligible.push(lesson);
  }
  const selected = [];
  let bytes = 0;
  for (const lesson of eligible) {
    const size = Buffer.byteLength(JSON.stringify({ cue: lesson.cue ?? "", lesson: lesson.lesson ?? "", evidence: lesson.evidence ?? "" }), "utf8");
    if (selected.length >= maxLessons) { withheld.push({ id: lesson.id, reason: "count_bound" }); continue; }
    if (bytes + size > maxBytes) { withheld.push({ id: lesson.id, reason: "byte_bound" }); continue; }
    bytes += size;
    selected.push({ id: lesson.id, source: lesson.source ?? null, lesson: lesson.lesson ?? "", cue: lesson.cue ?? "", bytes: size });
  }
  return { selected, withheld, bytes };
}
