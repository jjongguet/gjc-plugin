/**
 * Frozen verdict analyzer for the JJO-2329 jev-checkpoint trial.
 *
 * The adoption rule table is frozen before any paid cell (F1-F6 plus the
 * post-consensus amendments) and `ruleTableDigest()` pins it so a manifest can
 * refuse a run whose analyzer or table drifted (D12).
 *
 * `POWER_GATE` is a binding constant, not a computed result. The decisive-run
 * arithmetic in lib/power.mjs shows the holdout sample cannot reach 0.8 power
 * for the declared effect, so `adopted` is unreachable by construction while
 * `rejected` stays reachable through an X rule. Everything is one-sided and
 * fail-closed: an estimator that cannot be computed never defaults to a
 * favourable value, and early termination never yields `rejected`.
 *
 * `pairedBenefit` (self-improve/lib/behavior-eval.mjs) is a different rule: it
 * requires a declared pair count, folds quality and cost into one composite
 * verdict and has no interval estimator, so it cannot express A1-A4's one-sided
 * percentile bounds or A3's median-plus-bootstrap pair. The estimators here are
 * implemented directly instead.
 */
import { createHash } from "node:crypto";

export const SEED = 20261114;
export const BOOTSTRAP_REPS = 10_000;
export const ALPHA = 0.05;
/** Declared determinable effect: on 12 tasks (holdout 6) differences under 25pp are not determinable. */
export const DECLARED_EFFECT_PP = 0.25;
/** Frozen power gate value. `adopted` is unreachable while this is `'fail'` (C2329-15 / A2329-24). */
export const POWER_GATE = "fail";
export const TURN_CAP_DEFAULT = 16;

export const REJECTED = "rejected";
export const ADOPTED = "adopted (default-off advisory)";
export const INSUFFICIENT = "insufficient → 현행 유지";

export const BASELINE_CONDITIONS = Object.freeze(["a1-off", "a0-release"]);
export const TREATMENT_CONDITIONS = Object.freeze(["bp-periodic", "de-error", "c3-ensemble", "fz-frozen"]);
export const S1_CANDIDATES = Object.freeze(["bp-periodic", "de-error"]);
export const SPLITS = Object.freeze(["dev", "holdout"]);
export const STAGES = Object.freeze(["S1", "S2", "S3"]);

const CONDITIONS = Object.freeze([...BASELINE_CONDITIONS, ...TREATMENT_CONDITIONS]);
const EPS = 1e-9;

const deepFreeze = (value) => {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
};

/** Deterministic, key-sorted JSON: the only serialization the digests see. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export const RULE_TABLE = deepFreeze({
  version: "F1-F6+post-consensus-2026-11-14",
  unit: "task (3-repeat mean), paired by task",
  interval: "one-sided 95% percentile",
  seed: SEED,
  bootstrapReps: BOOTSTRAP_REPS,
  alpha: ALPHA,
  powerGate: POWER_GATE,
  declaration: Object.freeze({
    minDeterminableDelta: DECLARED_EFFECT_PP,
    note: "12 tasks (holdout 6): sign test needs 10/12 overall and 6/6 on holdout, so differences under 25pp are not determinable",
  }),
  adoption: Object.freeze({
    A1: Object.freeze({ metric: "success delta (Fz - A1)", estimator: "paired task bootstrap", rule: "5th percentile >= 0", threshold: 0 }),
    A2: Object.freeze({
      metric: "cost ratio of means (Fz / A1), mean ratio secondary",
      estimator: "paired task bootstrap",
      rule: "95th percentile < 1.0",
      threshold: 1,
    }),
    A3: Object.freeze({
      metric: "per-task waste-turn reduction (A1 - Fz) / A1",
      estimator: "median + bootstrap",
      rule: "median >= 0.20 and 5th percentile > 0",
      threshold: 0.2,
    }),
    A4: Object.freeze({
      metric: "jevUsd/sessionUsd and paired wall ratio",
      estimator: "arithmetic and paired task bootstrap",
      rule: "<= 0.05 and 95th percentile <= 1.10",
      threshold: 0.05,
      wallThreshold: 1.1,
    }),
    A5: Object.freeze({ metric: "X1-X6 fired", estimator: "count", rule: "0 fired", threshold: 0 }),
  }),
  rejection: Object.freeze({
    X1: Object.freeze({ metric: "holdout tasks going A1 3/3 to Fz 0/3", rule: ">= 1 task", threshold: 1 }),
    X2: Object.freeze({ metric: "dev+holdout success drop", rule: ">= 1/12 (8.3pp)", threshold: 1 / 12 }),
    X3: Object.freeze({ metric: "cost ratio of means 95th percentile", rule: ">= 1.1", threshold: 1.1 }),
    X4: Object.freeze({
      metric: "ignoredAdvice rate and trigger rate over treatment sessions",
      rule: "ignoredAdvice >= 0.70 or triggerRate < 0.10",
      ignoredAdviceThreshold: 0.7,
      triggerRateThreshold: 0.1,
    }),
    X5: Object.freeze({ metric: "harness collision signals", rule: ">= 2", threshold: 2 }),
    X6: Object.freeze({
      metric: "falseStop rate and label accuracy (no-decision = wrong)",
      rule: "falseStop >= 0.10 or label accuracy < 0.75",
      falseStopThreshold: 0.1,
      accuracyThreshold: 0.75,
    }),
  }),
  mapping: Object.freeze([
    "early termination -> insufficient → 현행 유지 (partial data never yields rejected)",
    "any X1-X6 fired -> rejected",
    "power gate fail -> insufficient → 현행 유지 (observations still reported)",
    "A1-A5 all passed -> adopted (default-off advisory)",
    "otherwise -> insufficient → 현행 유지",
  ]),
  s1: Object.freeze({
    candidates: S1_CANDIDATES,
    pass: Object.freeze({
      P1: "worse tasks <= 1",
      P2: "triggerRate >= 0.30 and ignoredAdvice < 0.70",
      P3: "costRatio < 1.0 or waste median reduction >= 0.10",
      P4: "tasks with A1 3/3 and candidate 0/3 == 0",
    }),
    tieBreak: Object.freeze([
      "waste reduction, gap >= 5pp",
      "cost ratio, gap >= 0.02",
      "trigger rate",
      "de-error",
    ]),
    c3ToFz: Object.freeze({
      gate: "P1 gate closed -> C3 cannot become Fz",
      condition: "C3 worse tasks <= 1 and C3 waste median <= winner and C3 jevUsd/absorbed waste turn < winner",
    }),
  }),
});

/**
 * Digest of the frozen table plus the estimator parameters it depends on.
 * A manifest freezes this value; a mismatch refuses the run (D12).
 */
export function ruleTableDigest() {
  return sha256(
    canonicalJson({
      table: RULE_TABLE,
      powerGate: POWER_GATE,
      seed: SEED,
      bootstrapReps: BOOTSTRAP_REPS,
      alpha: ALPHA,
      declaredEffectPp: DECLARED_EFFECT_PP,
    }),
  );
}

// ---------------------------------------------------------------------------
// Deterministic statistics
// ---------------------------------------------------------------------------

/** mulberry32: 32-bit seeded PRNG, identical stream for every engine. */
export function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const mean = (values) => {
  const usable = values.filter((value) => Number.isFinite(value));
  return usable.length === 0 ? null : usable.reduce((sum, value) => sum + value, 0) / usable.length;
};

/** Percentile with linear interpolation; `values` need not be sorted. */
export function percentileOf(values, p) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const index = p * (sorted.length - 1);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sorted[low] + (sorted[high] - sorted[low]) * (index - low);
}

/** Median of a numeric sample (percentile 0.5). */
export const medianOf = (values) => percentileOf(values, 0.5);

/**
 * Paired percentile bootstrap. `statistic(sample)` receives a resample of the
 * original units and must return a finite number or null; null samples are
 * counted in `valid` but never enter the interval, so an undefined estimator
 * cannot masquerade as a favourable value.
 */
export function bootstrap(units, statistic, { reps = BOOTSTRAP_REPS, seed = SEED } = {}) {
  const n = Array.isArray(units) ? units.length : 0;
  if (n === 0) return { point: null, lower: null, median: null, upper: null, n, reps, seed, valid: 0 };
  const random = mulberry32(seed);
  const draws = [];
  for (let draw = 0; draw < reps; draw += 1) {
    const sample = new Array(n);
    for (let index = 0; index < n; index += 1) sample[index] = units[Math.floor(random() * n)];
    const value = statistic(sample);
    draws.push(Number.isFinite(value) ? value : null);
  }
  const usable = draws.filter((value) => value !== null);
  if (usable.length === 0) return { point: null, lower: null, median: null, upper: null, n, reps, seed, valid: 0 };
  return {
    point: statistic(units),
    lower: percentileOf(usable, 0.05),
    median: percentileOf(usable, 0.5),
    upper: percentileOf(usable, 0.95),
    n,
    reps,
    seed,
    valid: usable.length,
  };
}

const finiteOr = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);

/**
 * F4 zero-baseline amendment for the per-task waste ratio.
 * A1 = 0 and Fz = 0 -> 0 (nothing to absorb); A1 = 0 and Fz > 0 -> -1 (pure loss).
 * A baseline of zero never becomes a perfect saving and never disables A3.
 */
export function wasteRatioFor(baselineWaste, treatmentWaste) {
  if (!Number.isFinite(baselineWaste) || !Number.isFinite(treatmentWaste)) return null;
  if (baselineWaste === 0) return treatmentWaste === 0 ? 0 : -1;
  return (baselineWaste - treatmentWaste) / baselineWaste;
}

// ---------------------------------------------------------------------------
// Estimators (A1-A4 primaries); rules apply thresholds, these only measure
// ---------------------------------------------------------------------------

/** A1: paired task success delta (treatment - baseline), 5th percentile bound. */
export function successDeltaStats(pairs, options = {}) {
  const deltas = pairs.map((pair) => pair.treatment.success - pair.baseline.success).filter(Number.isFinite);
  if (deltas.length === 0) return { point: null, lower: null, median: null, upper: null, n: 0, reps: 0, seed: SEED };
  return bootstrap(deltas, mean, options);
}

/**
 * A2: ratio of means over task units (primary) and mean of per-task ratios
 * (secondary). A zero baseline sum leaves the ratio undefined, never 1.
 */
export function costRatioStats(pairs, options = {}) {
  const usable = pairs.filter(
    (pair) => Number.isFinite(pair.baseline.sessionUsd) && Number.isFinite(pair.treatment.sessionUsd),
  );
  if (usable.length === 0) {
    return { ratioOfMeans: null, meanOfRatios: null, lower: null, median: null, upper: null, n: 0, note: "no_measured_cost" };
  }
  const ratioOfMeans = (sample) => {
    const baseline = sample.reduce((sum, pair) => sum + pair.baseline.sessionUsd, 0);
    const treatment = sample.reduce((sum, pair) => sum + pair.treatment.sessionUsd, 0);
    return baseline > 0 ? treatment / baseline : null;
  };
  const stats = bootstrap(usable, ratioOfMeans, options);
  const perTask = usable
    .filter((pair) => pair.baseline.sessionUsd > 0)
    .map((pair) => pair.treatment.sessionUsd / pair.baseline.sessionUsd);
  return {
    ratioOfMeans: stats.point,
    meanOfRatios: mean(perTask),
    lower: stats.lower,
    median: stats.median,
    upper: stats.upper,
    n: usable.length,
    reps: stats.reps,
    seed: stats.seed,
    valid: stats.valid,
    note: usable.length < pairs.length ? "some_tasks_unmeasured" : null,
  };
}

/** A3: per-task waste reduction; median plus the 5th percentile of resampled medians. */
export function wasteReductionStats(pairs, options = {}) {
  const ratios = [];
  let zeroBaseline = 0;
  for (const pair of pairs) {
    const ratio = wasteRatioFor(pair.baseline.wasteTurns, pair.treatment.wasteTurns);
    if (ratio === null) continue;
    if (pair.baseline.wasteTurns === 0) zeroBaseline += 1;
    ratios.push(ratio);
  }
  if (ratios.length === 0) {
    return { point: null, lower: null, median: null, upper: null, n: 0, zeroBaseline: 0, note: "no_waste_observation" };
  }
  const stats = bootstrap(ratios, medianOf, options);
  return { point: stats.point, median: stats.point, lower: stats.lower, upper: stats.upper, n: ratios.length, zeroBaseline, reps: stats.reps, seed: stats.seed };
}

/** A4 wall half: paired wall ratio of means, 95th percentile bound. */
export function wallRatioStats(pairs, options = {}) {
  const usable = pairs.filter((pair) => Number.isFinite(pair.baseline.wallMs) && Number.isFinite(pair.treatment.wallMs));
  if (usable.length === 0) return { ratioOfMeans: null, lower: null, median: null, upper: null, n: 0, note: "no_wall_observation" };
  const ratioOfMeans = (sample) => {
    const baseline = sample.reduce((sum, pair) => sum + pair.baseline.wallMs, 0);
    const treatment = sample.reduce((sum, pair) => sum + pair.treatment.wallMs, 0);
    return baseline > 0 ? treatment / baseline : null;
  };
  const stats = bootstrap(usable, ratioOfMeans, options);
  return { ratioOfMeans: stats.point, lower: stats.lower, median: stats.median, upper: stats.upper, n: usable.length, reps: stats.reps, seed: stats.seed, valid: stats.valid };
}

// ---------------------------------------------------------------------------
// Cell normalization and task aggregation (F4, F6, post-consensus unit = task)
// ---------------------------------------------------------------------------

const fail = (message) => {
  throw new Error(`analyze: ${message}`);
};

const assertMember = (value, allowed, label) => {
  if (!allowed.includes(value)) fail(`${label} must be one of ${allowed.join("|")}, got ${JSON.stringify(value)}`);
  return value;
};

const countOrZero = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);

const noDecisionOf = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const out = {};
  for (const [reason, count] of Object.entries(value)) {
    if (Number.isSafeInteger(count) && count >= 0) out[reason] = count;
  }
  return out;
};

/**
 * Apply F4 to every cell before any aggregation:
 *   success = 0 for an error cell;
 *   wasteTurns = observed value (truncated segment included) or the turn cap;
 *   cost = settled ledger value, else the reservation cap.
 * The same function runs for every arm, so the imputation is symmetric. The
 * `waste_error_imputed` count is the sensitivity line the arm table reports.
 */
const METRIC_NUMBERS = Object.freeze(["jevUsd", "wallMs"]);
const METRIC_COUNTS = Object.freeze(["tokens", "triggerCount", "adviceCount", "ignoredAdvice", "falseStop", "falseProceed", "labelChecks", "labelCorrect", "appendTokens", "harnessSignals"]);

export function normalizeRecords(records, { turnCap = TURN_CAP_DEFAULT } = {}) {
  if (!Number.isSafeInteger(turnCap) || turnCap < 1) fail(`turnCap must be a positive integer, got ${turnCap}`);
  const cells = [];
  const observations = [];
  const imputed = { cells: 0, error_cells: 0, waste_error_imputed: 0, cost_reserved: 0, cost_unmeasured: 0, metrics_imputed: 0, not_run: 0 };
  for (const record of Array.isArray(records) ? records : []) {
    if (!record || typeof record !== "object") fail("cell record must be an object");
    const stage = assertMember(record.stage, STAGES, "stage");
    const split = assertMember(record.split, SPLITS, "split");
    const condition = assertMember(record.condition, CONDITIONS, "condition");
    const status = assertMember(record.status, ["ok", "failed", "not_run"], "status");
    if (typeof record.taskId !== "string" || record.taskId.length === 0) fail("taskId must be a non-empty string");
    if (!Number.isSafeInteger(record.repeat) || record.repeat < 1) fail(`repeat must be a positive integer for ${record.taskId}`);
    imputed.cells += 1;
    if (status === "not_run") {
      imputed.not_run += 1;
      observations.push({ code: "cell_not_run", detail: { taskId: record.taskId, condition, repeat: record.repeat } });
      continue;
    }
    const errorCell = status !== "ok";
    if (errorCell) imputed.error_cells += 1;
    const recordCap = Number.isSafeInteger(record.turnCap) && record.turnCap > 0 ? record.turnCap : turnCap;
    const observedSuccess = finiteOr(record.success);
    if (!errorCell && (observedSuccess === null || observedSuccess < 0 || observedSuccess > 1)) {
      fail(`ok cell ${record.taskId}/${condition}/r${record.repeat} needs success in [0,1]`);
    }
    let wasteTurns = finiteOr(record.wasteTurns);
    let wasteFromCap = false;
    if (errorCell) {
      if (wasteTurns === null) {
        wasteTurns = recordCap;
        wasteFromCap = true;
      } else if (record.imputed === true && wasteTurns >= recordCap) {
        // The runner already applied the F4 cap when it had no transcript (it
        // sets `imputed` and leaves waste at the cap), so count that cell too.
        // An observed waste exactly at the cap on an error cell is the only
        // case this can mislabel, and it errs toward reporting imputation.
        wasteFromCap = true;
      }
      if (wasteFromCap) imputed.waste_error_imputed += 1;
    } else if (wasteTurns === null) {
      fail(`ok cell ${record.taskId}/${condition}/r${record.repeat} has no wasteTurns`);
    }
    const settled = finiteOr(record.sessionUsd);
    let sessionUsd = settled;
    if (sessionUsd === null) {
      const reserved = finiteOr(record.reservedUsd);
      if (reserved === null) {
        imputed.cost_unmeasured += 1;
        observations.push({ code: "cost_unmeasured", detail: { taskId: record.taskId, condition, repeat: record.repeat } });
      } else {
        sessionUsd = reserved;
        imputed.cost_reserved += 1;
      }
    }
    // A missing metric enters as 0 like the runner's own defaults, but never silently:
    // every such cell is counted and named so the report shows the imputation.
    const missing = [...METRIC_NUMBERS.filter((field) => finiteOr(record[field]) === null), ...METRIC_COUNTS.filter((field) => !(Number.isSafeInteger(record[field]) && record[field] >= 0))];
    if (missing.length) {
      imputed.metrics_imputed += 1;
      observations.push({ code: "metric_imputed", detail: { taskId: record.taskId, condition, repeat: record.repeat, status, fields: missing } });
    }
    cells.push({
      stage,
      split,
      taskId: record.taskId,
      repeat: record.repeat,
      condition,
      status,
      errorClass: record.errorClass ?? null,
      arm: BASELINE_CONDITIONS.includes(condition) ? "baseline" : "treatment",
      success: errorCell ? 0 : observedSuccess,
      wasteTurns,
      wasteFromCap,
      sessionUsd,
      jevUsd: finiteOr(record.jevUsd) ?? 0,
      wallMs: finiteOr(record.wallMs) ?? 0,
      tokens: countOrZero(record.tokens),
      triggerCount: countOrZero(record.triggerCount),
      adviceCount: countOrZero(record.adviceCount),
      ignoredAdvice: countOrZero(record.ignoredAdvice),
      falseStop: countOrZero(record.falseStop),
      falseProceed: countOrZero(record.falseProceed),
      labelChecks: countOrZero(record.labelChecks),
      labelCorrect: countOrZero(record.labelCorrect),
      noDecision: noDecisionOf(record.noDecision),
      appendTokens: countOrZero(record.appendTokens),
      harnessSignals: countOrZero(record.harnessSignals),
    });
  }
  return { cells, observations, imputed };
}

/**
 * Unit = task: 3-repeat mean per (condition, split, taskId). Repeat counts other
 * than 3 are reported, never silently averaged into a different unit.
 */
export function taskMeans(cells, { observations = [] } = {}) {
  const groups = new Map();
  for (const cell of cells) {
    const key = `${cell.condition}|${cell.split}|${cell.taskId}`;
    const group = groups.get(key) ?? { condition: cell.condition, split: cell.split, taskId: cell.taskId, repeats: [] };
    group.repeats.push(cell);
    groups.set(key, group);
  }
  const tasks = [];
  for (const group of groups.values()) {
    const repeats = group.repeats.sort((a, b) => a.repeat - b.repeat);
    const repeatCount = repeats.length;
    if (repeatCount !== 3) {
      observations.push({ code: "repeat_count_mismatch", detail: { condition: group.condition, split: group.split, taskId: group.taskId, repeats: repeatCount } });
    }
    tasks.push({
      condition: group.condition,
      split: group.split,
      taskId: group.taskId,
      repeats: repeatCount,
      success: mean(repeats.map((cell) => cell.success)),
      wasteTurns: mean(repeats.map((cell) => cell.wasteTurns)),
      sessionUsd: mean(repeats.map((cell) => cell.sessionUsd)),
      jevUsd: mean(repeats.map((cell) => cell.jevUsd)),
      wallMs: mean(repeats.map((cell) => cell.wallMs)),
      tokens: mean(repeats.map((cell) => cell.tokens)),
      errorCells: repeats.filter((cell) => cell.status !== "ok").length,
      wasteFromCap: repeats.filter((cell) => cell.wasteFromCap).length,
    });
  }
  return tasks;
}

/** Pair task units on (split, taskId); an unpaired task is reported, never dropped silently. */
export function pairTasks(tasks, { split, baselineCondition, treatmentCondition }) {
  const pick = (condition) =>
    new Map(tasks.filter((task) => task.split === split && task.condition === condition).map((task) => [task.taskId, task]));
  const baseline = pick(baselineCondition);
  const treatment = pick(treatmentCondition);
  const pairs = [];
  const unpaired = { baseline: [], treatment: [] };
  for (const [taskId, base] of baseline) {
    const treated = treatment.get(taskId);
    if (!treated) {
      unpaired.baseline.push(taskId);
      continue;
    }
    pairs.push({ taskId, split, baseline: base, treatment: treated });
  }
  for (const taskId of treatment.keys()) if (!baseline.has(taskId)) unpaired.treatment.push(taskId);
  pairs.sort((a, b) => (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0));
  return { pairs, unpaired };
}

/** Arm-level advice and label rates; the denominator of every rate is recorded. */
export function armRates(cells) {
  const sessions = cells.length;
  const triggered = cells.filter((cell) => cell.triggerCount > 0).length;
  const adviceCount = cells.reduce((sum, cell) => sum + cell.adviceCount, 0);
  const ignored = cells.reduce((sum, cell) => sum + cell.ignoredAdvice, 0);
  const falseStop = cells.reduce((sum, cell) => sum + cell.falseStop, 0);
  const labelChecks = cells.reduce((sum, cell) => sum + cell.labelChecks, 0);
  const labelCorrect = cells.reduce((sum, cell) => sum + cell.labelCorrect, 0);
  const noDecision = {};
  for (const cell of cells) {
    for (const [reason, count] of Object.entries(cell.noDecision)) noDecision[reason] = (noDecision[reason] ?? 0) + count;
  }
  const noDecisionTotal = Object.values(noDecision).reduce((sum, count) => sum + count, 0);
  // `labelChecks` is the number of decisions attempted and already includes the
  // no-decision rows (lib/metrics.mjs increments it before the abstain branch),
  // so a no-decision is wrong by omission. The floor guards a producer that
  // reports no-decisions outside the check count.
  const denom = Math.max(labelChecks, noDecisionTotal);
  const sensitivityDenom = denom - (noDecision.unnormalized_probabilities ?? 0);
  const sessionUsd = cells.reduce((sum, cell) => sum + (cell.sessionUsd ?? 0), 0);
  const jevUsd = cells.reduce((sum, cell) => sum + cell.jevUsd, 0);
  const harnessSignals = cells.reduce((sum, cell) => sum + cell.harnessSignals, 0);
  return {
    sessions,
    triggered,
    triggerRate: sessions === 0 ? null : triggered / sessions,
    adviceCount,
    ignoredAdvice: ignored,
    ignoredAdviceRate: adviceCount === 0 ? null : ignored / adviceCount,
    falseStop,
    falseStopRate: adviceCount === 0 ? null : falseStop / adviceCount,
    labelChecks,
    labelCorrect,
    noDecision,
    noDecisionTotal,
    labelAccuracy: denom === 0 ? null : labelCorrect / denom,
    labelSensitivityAccuracy: sensitivityDenom <= 0 ? null : labelCorrect / sensitivityDenom,
    harnessSignals,
    sessionUsd,
    jevUsd,
    jevOverhead: sessionUsd > 0 ? jevUsd / sessionUsd : null,
  };
}

// ---------------------------------------------------------------------------
// Rule evaluation
// ---------------------------------------------------------------------------

const rule = (id, value, threshold, passed, detail = {}, comparator = null) => ({
  id,
  value,
  threshold,
  passed,
  ...(comparator ? { comparator } : {}),
  detail,
});

/**
 * X1-X6. Each rule is evaluated whether or not the run terminated early: under
 * early termination the caller reports fired rules as observations only.
 */
export function evaluateRejectionRules({ splitPairs, allPairs, cost, advice }) {
  const holdout = splitPairs.holdout ?? [];
  const ceilingCollapse = holdout.filter((pair) => pair.baseline.success >= 1 - EPS && pair.treatment.success <= EPS);
  const X1 = {
    id: "X1",
    value: ceilingCollapse.length,
    threshold: RULE_TABLE.rejection.X1.threshold,
    fired: ceilingCollapse.length >= RULE_TABLE.rejection.X1.threshold,
    detail: { tasks: ceilingCollapse.map((pair) => pair.taskId) },
  };
  X1.passed = !X1.fired;

  const drop = allPairs.length === 0 ? null : mean(allPairs.map((pair) => pair.baseline.success - pair.treatment.success));
  const X2 = {
    id: "X2",
    value: drop,
    threshold: RULE_TABLE.rejection.X2.threshold,
    fired: drop !== null && drop >= RULE_TABLE.rejection.X2.threshold - EPS,
    detail: { pairs: allPairs.length, perSplit: { holdout: holdout.length, dev: (splitPairs.dev ?? []).length } },
  };
  X2.passed = !X2.fired;

  const X3 = {
    id: "X3",
    value: cost?.upper ?? null,
    threshold: RULE_TABLE.rejection.X3.threshold,
    fired: Number.isFinite(cost?.upper) && cost.upper >= RULE_TABLE.rejection.X3.threshold - EPS,
    detail: { ratioOfMeans: cost?.ratioOfMeans ?? null },
  };
  X3.passed = !X3.fired;

  const ignored = advice?.ignoredAdviceRate ?? null;
  const trigger = advice?.triggerRate ?? null;
  const ignoredFired = Number.isFinite(ignored) && ignored >= RULE_TABLE.rejection.X4.ignoredAdviceThreshold - EPS;
  const triggerFired = Number.isFinite(trigger) && trigger < RULE_TABLE.rejection.X4.triggerRateThreshold - EPS;
  const X4 = {
    id: "X4",
    value: { ignoredAdviceRate: ignored, triggerRate: trigger },
    threshold: {
      ignoredAdviceRate: RULE_TABLE.rejection.X4.ignoredAdviceThreshold,
      triggerRate: RULE_TABLE.rejection.X4.triggerRateThreshold,
    },
    fired: ignoredFired || triggerFired,
    // With no advice appended the ignoredAdvice limb has no denominator: it is not
    // applicable (reported), not a pass that the triggerRate limb could hide.
    detail: { ignoredFired, triggerFired, ignoredLimbApplicable: Number.isFinite(ignored), sessions: advice?.sessions ?? 0, adviceCount: advice?.adviceCount ?? 0 },
  };
  X4.passed = !X4.fired;

  const signals = advice?.harnessSignals ?? 0;
  const X5 = {
    id: "X5",
    value: signals,
    threshold: RULE_TABLE.rejection.X5.threshold,
    fired: signals >= RULE_TABLE.rejection.X5.threshold,
    detail: {},
  };
  X5.passed = !X5.fired;

  const falseStopRate = advice?.falseStopRate ?? null;
  const accuracy = advice?.labelAccuracy ?? null;
  const falseStopFired = Number.isFinite(falseStopRate) && falseStopRate >= RULE_TABLE.rejection.X6.falseStopThreshold - EPS;
  const accuracyFired = Number.isFinite(accuracy) && accuracy < RULE_TABLE.rejection.X6.accuracyThreshold - EPS;
  const breakdown = Object.entries(advice?.noDecision ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([reason, count]) => ({ reason, count }));
  const X6 = {
    id: "X6",
    value: { falseStopRate, labelAccuracy: accuracy, sensitivityAccuracy: advice?.labelSensitivityAccuracy ?? null },
    threshold: {
      falseStopRate: RULE_TABLE.rejection.X6.falseStopThreshold,
      labelAccuracy: RULE_TABLE.rejection.X6.accuracyThreshold,
    },
    fired: falseStopFired || accuracyFired,
    detail: {
      falseStopFired,
      accuracyFired,
      breakdown,
      noDecisionTotal: advice?.noDecisionTotal ?? 0,
      labelChecks: advice?.labelChecks ?? 0,
      labelCorrect: advice?.labelCorrect ?? 0,
      accuracyDenominator: Math.max(advice?.labelChecks ?? 0, advice?.noDecisionTotal ?? 0),
    },
  };
  X6.passed = !X6.fired;

  return { X1, X2, X3, X4, X5, X6 };
}

/** A1-A5 over holdout pairs. Every estimator that cannot be computed fails its rule. */
export function evaluateAdoptionRules({ pairs, cost, wall, advice, xRules }, options = {}) {
  const success = successDeltaStats(pairs, options);
  const A1 = rule(
    "A1",
    success.lower,
    RULE_TABLE.adoption.A1.threshold,
    Number.isFinite(success.lower) && success.lower >= RULE_TABLE.adoption.A1.threshold,
    { point: success.point, upper: success.upper, pairs: success.n, reps: success.reps, seed: success.seed },
    ">=",
  );

  const A2 = rule(
    "A2",
    cost?.upper ?? null,
    RULE_TABLE.adoption.A2.threshold,
    Number.isFinite(cost?.upper) && cost.upper < RULE_TABLE.adoption.A2.threshold,
    {
      ratioOfMeans: cost?.ratioOfMeans ?? null,
      meanOfRatios: cost?.meanOfRatios ?? null,
      lower: cost?.lower ?? null,
      pairs: cost?.n ?? 0,
      note: cost?.note ?? null,
    },
    "<",
  );

  const waste = wasteReductionStats(pairs, options);
  const A3 = rule(
    "A3",
    waste.median,
    RULE_TABLE.adoption.A3.threshold,
    Number.isFinite(waste.median) &&
      waste.median >= RULE_TABLE.adoption.A3.threshold &&
      Number.isFinite(waste.lower) &&
      waste.lower > 0,
    { lower: waste.lower, upper: waste.upper, pairs: waste.n, zeroBaseline: waste.zeroBaseline, note: waste.note ?? null },
    ">=",
  );

  const overhead = advice?.jevOverhead ?? null;
  const A4 = rule(
    "A4",
    overhead,
    RULE_TABLE.adoption.A4.threshold,
    Number.isFinite(overhead) &&
      overhead <= RULE_TABLE.adoption.A4.threshold &&
      Number.isFinite(wall?.upper) &&
      wall.upper <= RULE_TABLE.adoption.A4.wallThreshold,
    {
      wallRatio: wall?.ratioOfMeans ?? null,
      wallUpper: wall?.upper ?? null,
      wallThreshold: RULE_TABLE.adoption.A4.wallThreshold,
      jevUsd: advice?.jevUsd ?? 0,
      sessionUsd: advice?.sessionUsd ?? 0,
      wallPairs: wall?.n ?? 0,
    },
    "<=",
  );

  const fired = Object.values(xRules).filter((entry) => entry.fired).map((entry) => entry.id);
  const A5 = rule("A5", fired, RULE_TABLE.adoption.A5.threshold, fired.length === 0, { fired }, "===");

  return { A1, A2, A3, A4, A5 };
}

/**
 * F3 mapping order (frozen): early termination, X rule, power gate, adoption,
 * default. Early termination precedes the X rules so partial data never yields
 * `rejected`; fired X rules are returned in `suppressed` for the observations.
 * With the frozen `POWER_GATE = 'fail'` the last two branches are unreachable:
 * everything that reaches step three is `insufficient`. Their mapping is still
 * total so an injected `powerGate: 'pass'` exercises the same rule table.
 */
export function decideVerdict({ terminated = false, adoption = {}, xRules = {}, powerGate = POWER_GATE } = {}) {
  const fired = Object.values(xRules).filter((entry) => entry?.fired).map((entry) => entry.id);
  const adoptionPassed = ["A1", "A2", "A3", "A4", "A5"].every((id) => adoption[id]?.passed === true);
  if (terminated) {
    return { verdict: INSUFFICIENT, branch: "early-termination", fired, suppressed: fired, adoptionPassed };
  }
  if (fired.length > 0) return { verdict: REJECTED, branch: "x-rule", fired, suppressed: [], adoptionPassed };
  if (powerGate !== "pass") {
    return { verdict: INSUFFICIENT, branch: "power-gate", fired, suppressed: [], adoptionPassed, powerGate };
  }
  if (adoptionPassed) return { verdict: ADOPTED, branch: "adopted", fired, suppressed: [], adoptionPassed };
  return { verdict: INSUFFICIENT, branch: "insufficient", fired, suppressed: [], adoptionPassed };
}

// ---------------------------------------------------------------------------
// F5: S1 pass, winner, C3 -> Fz
// ---------------------------------------------------------------------------

/** P1 gate: a correlated judge failure closes C3's path to Fz before S2. */
export function p1Gate(j0) {
  if (!j0 || typeof j0 !== "object") return null;
  const agreementErrorRate = finiteOr(j0.agreementErrorRate);
  const bothWrongHighConfidence = finiteOr(j0.bothWrongHighConfidence);
  const agreementThreshold = 0.1;
  const bothWrongThreshold = 1 / 30;
  const agreementOpen = Number.isFinite(agreementErrorRate) && agreementErrorRate >= agreementThreshold - EPS;
  const bothWrongOpen = Number.isFinite(bothWrongHighConfidence) && bothWrongHighConfidence >= bothWrongThreshold - EPS;
  return {
    agreementErrorRate,
    bothWrongHighConfidence,
    agreementThreshold,
    bothWrongThreshold,
    open: agreementOpen || bothWrongOpen,
    c3Adoptable: !(agreementOpen || bothWrongOpen),
    basis: { agreementOpen, bothWrongOpen },
  };
}

const candidateSummary = (condition, pairSet, advice, options) => {
  const pairs = pairSet.pairs;
  const worseTasks = pairs.filter((pair) => pair.treatment.success < pair.baseline.success - EPS);
  const collapsed = pairs.filter((pair) => pair.baseline.success >= 1 - EPS && pair.treatment.success <= EPS);
  const cost = costRatioStats(pairs, options);
  const waste = wasteReductionStats(pairs, options);
  const worseCount = worseTasks.length;
  const passes = {
    P1: worseCount <= 1,
    P2:
      Number.isFinite(advice.triggerRate) &&
      advice.triggerRate >= 0.3 - EPS &&
      Number.isFinite(advice.ignoredAdviceRate) &&
      advice.ignoredAdviceRate < 0.7 - EPS,
    P3: (Number.isFinite(cost.ratioOfMeans) && cost.ratioOfMeans < 1) || (Number.isFinite(waste.median) && waste.median >= 0.1 - EPS),
    P4: collapsed.length === 0,
  };
  return {
    condition,
    pairs: pairs.length,
    worseTasks: worseCount,
    worseTaskIds: worseTasks.map((pair) => pair.taskId),
    ceilingCollapse: collapsed.map((pair) => pair.taskId),
    triggerRate: advice.triggerRate,
    ignoredAdviceRate: advice.ignoredAdviceRate,
    costRatio: { ratioOfMeans: cost.ratioOfMeans, meanOfRatios: cost.meanOfRatios, upper: cost.upper, lower: cost.lower },
    waste: { median: waste.median, lower: waste.lower, upper: waste.upper, zeroBaseline: waste.zeroBaseline },
    wasteMedianAbs: medianOf(pairs.map((pair) => pair.treatment.wasteTurns)),
    absorbedWasteTurns: pairs.reduce((sum, pair) => sum + (pair.baseline.wasteTurns - pair.treatment.wasteTurns), 0),
    jevUsd: advice.jevUsd,
    sessionUsd: advice.sessionUsd,
    jevUsdPerAbsorbedTurn: null,
    passes,
    passed: passes.P1 && passes.P2 && passes.P3 && passes.P4,
  };
};

/**
 * F5 winner: larger waste reduction; a gap under 5pp falls to the lower cost
 * ratio, a cost gap under 0.02 to the lower trigger rate, and a remaining tie
 * to de-error (design H2).
 */
export function pickWinner(candidates) {
  const passers = candidates.filter((candidate) => candidate.passed);
  if (passers.length === 0) return { winner: null, reason: "no_passer", tieBreaks: [] };
  const byWaste = [...passers].sort((a, b) => b.waste.median - a.waste.median);
  const top = byWaste[0];
  const near = passers.filter((candidate) => top.waste.median - candidate.waste.median < 0.05 - EPS);
  if (near.length === 1) return { winner: top.condition, reason: "waste_reduction", tieBreaks: [] };
  const costOf = (candidate) => (Number.isFinite(candidate.costRatio?.ratioOfMeans) ? candidate.costRatio.ratioOfMeans : Infinity);
  const minCost = Math.min(...near.map(costOf));
  const costTied = minCost === Infinity ? near : near.filter((candidate) => costOf(candidate) - minCost < 0.02 - EPS);
  if (costTied.length === 1) return { winner: costTied[0].condition, reason: "cost_ratio", tieBreaks: ["waste_reduction"] };
  const triggerOf = (candidate) => (Number.isFinite(candidate.triggerRate) ? candidate.triggerRate : Infinity);
  const minTrigger = Math.min(...costTied.map(triggerOf));
  const triggerTied = minTrigger === Infinity ? costTied : costTied.filter((candidate) => triggerOf(candidate) - minTrigger < EPS);
  if (triggerTied.length === 1) {
    return { winner: triggerTied[0].condition, reason: "trigger_rate", tieBreaks: ["waste_reduction", "cost_ratio"] };
  }
  const de = triggerTied.find((candidate) => candidate.condition === "de-error");
  return {
    winner: (de ?? triggerTied[0]).condition,
    reason: "de_error",
    tieBreaks: ["waste_reduction", "cost_ratio", "trigger_rate", "de_error"],
  };
}

// jev cost per absorbed waste turn; null when the arm absorbed none (not evaluable, never a vacuous pass).
const absorbedRatio = (candidate) =>
  candidate.absorbedWasteTurns > 0 && Number.isFinite(candidate.jevUsd) ? candidate.jevUsd / candidate.absorbedWasteTurns : null;

/**
 * S1 verdict: candidate pass table, winner and whether C3 may replace the
 * winner as Fz. C3 needs <= 1 worse task, a waste median no worse than the
 * winner, a smaller jev cost per absorbed waste turn, and an open P1 gate.
 */
export function analyzeS1(records, { turnCap = TURN_CAP_DEFAULT, baselineCondition = null, j0 = null } = {}) {
  const normalized = normalizeRecords(records, { turnCap });
  const observations = [...normalized.observations];
  const devCells = normalized.cells.filter((cell) => cell.split === "dev");
  const tasks = taskMeans(devCells, { observations });
  const options = { reps: BOOTSTRAP_REPS, seed: SEED };
  const resolvedBaseline = resolveBaselineCondition(tasks, baselineCondition);
  if (resolvedBaseline === null) {
    return {
      stage: "S1",
      baseline: { condition: null, tasks: 0 },
      candidates: [],
      winner: null,
      winnerReason: "no_baseline",
      c3ToFz: { evaluated: false, becomeFz: false, reason: "no_baseline" },
      p1Gate: p1Gate(j0),
      rules: {},
      observations: [...observations, { code: "no_baseline_cells", detail: {} }],
      imputed: normalized.imputed,
      saturation: { baselineAtCeiling: false, treatmentAtCeiling: false, superiorityIndeterminate: false },
    };
  }
  const rules = {};
  const candidates = [];
  for (const condition of S1_CANDIDATES) {
    const pairSet = pairTasks(tasks, { split: "dev", baselineCondition: resolvedBaseline, treatmentCondition: condition });
    for (const taskId of [...pairSet.unpaired.baseline, ...pairSet.unpaired.treatment]) {
      observations.push({ code: "unpaired_task", detail: { condition, taskId } });
    }
    const advice = armRates(devCells.filter((cell) => cell.condition === condition));
    const summary = candidateSummary(condition, pairSet, advice, options);
    for (const id of ["P1", "P2", "P3", "P4"]) {
      rules[`${id}:${condition}`] = {
        id,
        condition,
        passed: summary.passes[id],
        detail: { worseTasks: summary.worseTasks, triggerRate: summary.triggerRate, ignoredAdviceRate: summary.ignoredAdviceRate, costRatio: summary.costRatio.ratioOfMeans, wasteMedian: summary.waste.median },
      };
    }
    if (pairSet.pairs.length === 0) observations.push({ code: "candidate_without_pairs", detail: { condition } });
    candidates.push(summary);
  }
  const winnerPick = pickWinner(candidates);
  const winner = candidates.find((candidate) => candidate.condition === winnerPick.winner) ?? null;
  const gate = p1Gate(j0);

  const c3PairSet = pairTasks(tasks, { split: "dev", baselineCondition: resolvedBaseline, treatmentCondition: "c3-ensemble" });
  let c3ToFz = { evaluated: false, becomeFz: false, reason: "no_c3_records" };
  if (c3PairSet.pairs.length > 0 && winner) {
    const c3Advice = armRates(devCells.filter((cell) => cell.condition === "c3-ensemble"));
    const c3 = candidateSummary("c3-ensemble", c3PairSet, c3Advice, options);
    c3.jevUsdPerAbsorbedTurn = absorbedRatio(c3);
    winner.jevUsdPerAbsorbedTurn = absorbedRatio(winner);
    const worseOk = c3.worseTasks <= 1;
    const wasteOk = Number.isFinite(c3.wasteMedianAbs) && Number.isFinite(winner.wasteMedianAbs) && c3.wasteMedianAbs <= winner.wasteMedianAbs + EPS;
    const jevEvaluable = c3.jevUsdPerAbsorbedTurn !== null && winner.jevUsdPerAbsorbedTurn !== null;
    if (!jevEvaluable) observations.push({ code: "c3_cost_not_evaluable", detail: { c3Absorbed: c3.absorbedWasteTurns, winnerAbsorbed: winner.absorbedWasteTurns } });
    const jevOk = jevEvaluable && c3.jevUsdPerAbsorbedTurn < winner.jevUsdPerAbsorbedTurn;
    const gateOk = gate === null || gate.c3Adoptable;
    c3ToFz = {
      evaluated: true,
      becomeFz: worseOk && wasteOk && jevOk && gateOk,
      reason: !gateOk ? "p1_gate" : !worseOk ? "worse_tasks" : !wasteOk ? "waste_median" : !jevOk ? (jevEvaluable ? "jev_per_absorbed_turn" : "jev_cost_not_evaluable") : "c3_becomes_fz",
      c3: {
        worseTasks: c3.worseTasks,
        wasteMedian: c3.wasteMedianAbs,
        jevUsdPerAbsorbedTurn: c3.jevUsdPerAbsorbedTurn,
        absorbedWasteTurns: c3.absorbedWasteTurns,
      },
      winner: {
        condition: winner.condition,
        wasteMedian: winner.wasteMedianAbs,
        jevUsdPerAbsorbedTurn: winner.jevUsdPerAbsorbedTurn,
        absorbedWasteTurns: winner.absorbedWasteTurns,
      },
      conditions: { worseTasksOk: worseOk, wasteMedianOk: wasteOk, jevPerAbsorbedTurnOk: jevOk, p1GateOpen: gateOk },
    };
    observations.push({ code: c3ToFz.becomeFz ? "c3_becomes_fz" : "c3_keeps_winner", detail: { reason: c3ToFz.reason } });
  }

  const baselineTasks = tasks.filter((task) => task.condition === resolvedBaseline);
  return {
    stage: "S1",
    baseline: { condition: resolvedBaseline, tasks: baselineTasks.length },
    candidates,
    winner: winner ? winner.condition : null,
    winnerReason: winnerPick.reason,
    winnerDetail: winner,
    tieBreaks: winnerPick.tieBreaks,
    c3ToFz,
    p1Gate: gate,
    rules,
    observations,
    imputed: normalized.imputed,
    saturation: saturationOf(baselineTasks, tasks),
  };
}

const saturationOf = (baselineTasks, tasks) => {
  const baselineAtCeiling = baselineTasks.length > 0 && baselineTasks.every((task) => task.success >= 1 - EPS);
  const conditions = [...new Set(tasks.map((task) => task.condition))].filter((condition) => !BASELINE_CONDITIONS.includes(condition));
  const treatmentAtCeiling =
    conditions.length > 0 &&
    conditions.every((condition) => {
      const own = tasks.filter((task) => task.condition === condition);
      return own.length > 0 && own.every((task) => task.success >= 1 - EPS);
    });
  return {
    baselineAtCeiling,
    treatmentAtCeiling,
    superiorityIndeterminate: baselineAtCeiling && treatmentAtCeiling,
    note: baselineAtCeiling && treatmentAtCeiling ? "우월성 판정 불가" : null,
  };
};

const resolveBaselineCondition = (tasks, preferred) => {
  if (preferred) {
    if (!BASELINE_CONDITIONS.includes(preferred)) fail(`baselineCondition must be one of ${BASELINE_CONDITIONS.join("|")}`);
    return tasks.some((task) => task.condition === preferred) ? preferred : null;
  }
  for (const condition of BASELINE_CONDITIONS) if (tasks.some((task) => task.condition === condition)) return condition;
  return null;
};

/**
 * Dev-side treatment arm for X2: an explicit condition wins, then a dev Fz run,
 * then the S1 winner computed from the same records. Null means the dev half of
 * X2 has no treatment evidence, which is reported instead of assumed.
 */
const resolveDevTreatment = (records, tasks, { devCondition = null, turnCap = TURN_CAP_DEFAULT } = {}) => {
  if (devCondition) return devCondition;
  if (tasks.some((task) => task.split === "dev" && task.condition === "fz-frozen")) return "fz-frozen";
  if (!tasks.some((task) => task.split === "dev" && TREATMENT_CONDITIONS.includes(task.condition))) return null;
  return analyzeS1(records, { turnCap }).winner;
};

/**
 * Final verdict over holdout Fz vs the baseline arm, plus the dev half of X2.
 * Returns every rule with its value and threshold, the branch the frozen
 * mapping took, the imputation counts and the saturation note.
 */
export function analyzeFinal({
  records,
  j0 = null,
  baselineCondition = null,
  treatmentCondition = "fz-frozen",
  devCondition = null,
  turnCap = TURN_CAP_DEFAULT,
  termination = null,
} = {}) {
  const normalized = normalizeRecords(records, { turnCap });
  const observations = [...normalized.observations];
  const tasks = taskMeans(normalized.cells, { observations });
  const options = { reps: BOOTSTRAP_REPS, seed: SEED };
  const resolvedBaseline = resolveBaselineCondition(tasks, baselineCondition);
  const resolvedTreatment = treatmentCondition;
  if (!TREATMENT_CONDITIONS.includes(resolvedTreatment)) fail(`treatmentCondition must be one of ${TREATMENT_CONDITIONS.join("|")}`);
  if (resolvedBaseline === null) observations.push({ code: "no_baseline_cells", detail: { requested: baselineCondition } });

  const holdoutSet = resolvedBaseline
    ? pairTasks(tasks, { split: "holdout", baselineCondition: resolvedBaseline, treatmentCondition: resolvedTreatment })
    : { pairs: [], unpaired: { baseline: [], treatment: [] } };
  for (const taskId of [...holdoutSet.unpaired.baseline, ...holdoutSet.unpaired.treatment]) {
    observations.push({ code: "unpaired_task", detail: { split: "holdout", taskId } });
  }
  const devConditionResolved = resolveDevTreatment(records, tasks, { devCondition, turnCap });
  const devSet =
    resolvedBaseline && devConditionResolved
      ? pairTasks(tasks, { split: "dev", baselineCondition: resolvedBaseline, treatmentCondition: devConditionResolved })
      : { pairs: [], unpaired: { baseline: [], treatment: [] } };
  if (devConditionResolved === null) observations.push({ code: "dev_treatment_unavailable", detail: {} });
  observations.push({ code: "dev_treatment", detail: { condition: devConditionResolved } });

  const pairs = holdoutSet.pairs;
  if (pairs.length === 0) observations.push({ code: "no_holdout_pairs", detail: { baseline: resolvedBaseline, treatment: resolvedTreatment } });
  const allPairs = [...pairs, ...devSet.pairs];

  const cost = costRatioStats(pairs, options);
  const wall = wallRatioStats(pairs, options);
  const treatmentCells = normalized.cells.filter((cell) => cell.condition === resolvedTreatment);
  const advice = armRates(treatmentCells);

  const xRules = evaluateRejectionRules({ splitPairs: { holdout: pairs, dev: devSet.pairs }, allPairs, cost, advice });
  if (!xRules.X4.detail.ignoredLimbApplicable) observations.push({ code: "x4_ignored_advice_not_applicable", detail: { adviceCount: xRules.X4.detail.adviceCount } });
  const adoption = evaluateAdoptionRules({ pairs, cost, wall, advice, xRules }, options);

  const terminated = Boolean(termination?.terminated) || normalized.imputed.not_run > 0 || normalized.cells.some((cell) => cell.errorClass === "global_stop");
  const decision = decideVerdict({ terminated, adoption, xRules });
  if (termination?.reason) observations.push({ code: "termination_reason", detail: { reason: termination.reason } });
  for (const id of decision.suppressed) {
    observations.push({
      code: "x_rule_suppressed_by_partial",
      detail: { rule: id, value: xRules[id].value, threshold: xRules[id].threshold },
    });
  }
  if (decision.branch === "power-gate") observations.push({ code: "power_gate_fail", detail: { powerGate: POWER_GATE } });
  if (decision.adoptionPassed) observations.push({ code: "adoption_rules_passed", detail: {} });

  const rules = { ...adoption, ...xRules };
  return {
    verdict: decision.verdict,
    branch: decision.branch,
    rules,
    observations,
    imputed: normalized.imputed,
    saturation: saturationOf(tasks.filter((task) => task.condition === resolvedBaseline && task.split === "holdout"), tasks.filter((task) => task.split === "holdout")),
    baseline: { condition: resolvedBaseline, pairs: pairs.length },
    treatment: { condition: resolvedTreatment, pairs: pairs.length, devPairs: devSet.pairs.length, devCondition: devConditionResolved },
    powerGate: POWER_GATE,
    ruleTableDigest: ruleTableDigest(),
    p1Gate: p1Gate(j0),
    decision: { terminated, adoptionPassed: decision.adoptionPassed, fired: decision.fired },
  };
}
