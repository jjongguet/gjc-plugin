/**
 * Report-only power arithmetic for the JJO-2329 jev-checkpoint trial.
 *
 * Nothing here changes a verdict. `analyze.mjs` freezes `POWER_GATE = 'fail'`,
 * so the numbers below are the *evidence* for that constant, not an input to
 * it: the analytic holdout test needs 6/6 (p = 1/64) and reaches only q^6 =
 * 0.262 at q = 0.8, the decisive run scales to 18 task units, and the Monte
 * Carlo re-runs the implemented A3 estimator (median plus bootstrap bound)
 * rather than a sign test so the report shows exactly what the frozen estimator
 * would do. The MC result was the reason the design stopped deriving the gate
 * from a simulation: the A3 estimator is much easier to satisfy than the sign
 * test, so a simulation-driven gate could open at q = 0.9.
 *
 * A1's normal-approximation sample size (`nRequired`) and the exact binomial
 * functions are pure arithmetic over the frozen seed; every function is
 * deterministic and none of them touch the network.
 */
import { ALPHA, SEED, medianOf, mulberry32, wasteReductionStats } from "./analyze.mjs";

/** One-sided holdout sign test over the six holdout task units. */
export const HOLDOUT_TASKS = 6;
/** Declared determinable effect used by the MC (a 25pp waste reduction). */
export const MC_EFFECT = 0.25;
export const MC_THRESHOLD = 0.2;

/** ln C(n, k), evaluated on the shorter tail to keep the product small. */
export function logChoose(n, k) {
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(k) || k < 0 || k > n) throw new Error(`power: invalid binomial ${n} choose ${k}`);
  const kk = Math.min(k, n - k);
  let total = 0;
  for (let index = 1; index <= kk; index += 1) total += Math.log(n - kk + index) - Math.log(index);
  return total;
}

/**
 * Exact one-sided binomial tail P(X >= k) for X ~ Binomial(n, q).
 * Terms are generated in log space from the k-th term so no intermediate
 * probability underflows for the n up to a few thousand used here.
 */
export function binomialTail({ n, k, q }) {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`power: n must be a non-negative integer, got ${n}`);
  if (!Number.isFinite(q) || q < 0 || q > 1) throw new Error(`power: q must be in [0,1], got ${q}`);
  if (k <= 0) return 1;
  if (k > n) return 0;
  if (q === 0) return 0;
  if (q === 1) return 1;
  const logQ = Math.log(q);
  const logNotQ = Math.log1p(-q);
  let logTerm = logChoose(n, k) + k * logQ + (n - k) * logNotQ;
  let total = 0;
  for (let x = k; x <= n; x += 1) {
    if (logTerm > -745) total += Math.exp(logTerm);
    if (x === n) break;
    logTerm += Math.log((n - x) / (x + 1)) + logQ - logNotQ;
  }
  return Math.min(1, Math.max(0, total));
}

/** Smallest k with P(X >= k | q = 0.5) <= alpha; null when no k can reach it. */
export function signTestThreshold({ n, alpha = ALPHA }) {
  for (let k = 1; k <= n; k += 1) if (binomialTail({ n, k, q: 0.5 }) <= alpha + 1e-12) return k;
  return null;
}

/** One-sided p-value of observing k or more successes under the null q = 0.5. */
export function signTestPValue({ n, k }) {
  return binomialTail({ n, k, q: 0.5 });
}

/**
 * Power of the one-sided sign test at effect q: the holdout case is q^6 because
 * n = 6 needs 6/6 (p = 1/64 = 0.0156 <= 0.05). Returns 0 when no threshold
 * exists at this alpha.
 */
export function signTestPower({ n, q, alpha = ALPHA }) {
  const k = signTestThreshold({ n, alpha });
  if (k === null) return 0;
  return binomialTail({ n, k, q });
}

/** Smallest q whose exact sign-test power reaches `power` at fixed n. */
export function minQForPower({ n = HOLDOUT_TASKS, alpha = ALPHA, power = 0.8 } = {}) {
  const k = signTestThreshold({ n, alpha });
  if (k === null) return null;
  if (power <= 0) return 0;
  if (binomialTail({ n, k, q: 1 }) < power) return null;
  let low = 0;
  let high = 1;
  for (let step = 0; step < 200; step += 1) {
    const mid = (low + high) / 2;
    if (binomialTail({ n, k, q: mid }) >= power) high = mid;
    else low = mid;
  }
  return high;
}

/** Smallest number of task units whose exact sign test reaches `power` at q. */
export function minTasksForPower({ q, alpha = ALPHA, power = 0.8, maxN = 4000 } = {}) {
  for (let n = 1; n <= maxN; n += 1) {
    const k = signTestThreshold({ n, alpha });
    if (k === null) continue;
    if (binomialTail({ n, k, q }) >= power) return n;
  }
  return null;
}

/** Acklam's inverse normal CDF; used for the normal-approximation sample size. */
export function normalQuantile(p) {
  if (!(p > 0 && p < 1)) throw new Error(`power: p must be in (0,1), got ${p}`);
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const plow = 0.02425;
  const phigh = 1 - plow;
  if (p < plow) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > phigh) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/** z for the one-sided 95% level and the 80% power level. */
export const Z_ALPHA_ONE_SIDED = normalQuantile(1 - ALPHA);
export const Z_POWER = normalQuantile(0.8);

/**
 * Two-sample normal-approximation task count: ceil((z0.95 + z0.80)^2 * s^2 / d^2).
 * sigma and delta live on the same task-level scale the analyzer uses.
 */
export function nRequired({ sigma, delta } = {}) {
  if (!Number.isFinite(sigma) || sigma <= 0) throw new Error(`power: sigma must be > 0, got ${sigma}`);
  if (!Number.isFinite(delta) || delta <= 0) throw new Error(`power: delta must be > 0, got ${delta}`);
  return Math.ceil(((Z_ALPHA_ONE_SIDED + Z_POWER) ** 2 * sigma ** 2) / delta ** 2);
}

/**
 * The declared decisive run: 18 task units per split, k = 13, alpha = 0.0481,
 * power ~ 0.87 at q = 0.8. Cell counts follow the declared arms and the
 * three-repeat unit (S1 18x3x3 = 162, S2 18x1x3 = 54, S3 18x2x3 = 108).
 */
export function decisiveRunSize({ n = 18, q = 0.8, alpha = ALPHA } = {}) {
  const k = signTestThreshold({ n, alpha });
  if (k === null) throw new Error(`power: no sign-test threshold for n=${n} alpha=${alpha}`);
  const repeats = 3;
  const arms = { s1: 3, s2: 1, s3: 2 };
  const cells = {
    s1: n * arms.s1 * repeats,
    s2: n * arms.s2 * repeats,
    s3: n * arms.s3 * repeats,
  };
  return {
    n,
    k,
    alpha: signTestPValue({ n, k }),
    power: binomialTail({ n, k, q }),
    q,
    repeats,
    arms,
    units: "task",
    holdoutTasks: HOLDOUT_TASKS,
    cells: { ...cells, total: cells.s1 + cells.s2 + cells.s3 },
    note: "report-only: the frozen POWER_GATE constant does not depend on this size",
  };
}

/**
 * Monte Carlo of the implemented A3 estimator: per-task Bernoulli(q) waste
 * reductions of `effect`, then the shipped median-plus-bootstrap-bound rule.
 * Defaults are deliberately coarser than the verdict's 10k bootstrap because
 * the pass rate is dominated by the task-level sign structure; the parameters
 * are returned with the result so the report states what produced it.
 */
export function monteCarloA3({
  qs = [0.6, 0.7, 0.8, 0.9, 0.95],
  n = HOLDOUT_TASKS,
  sims = 2000,
  bootstrapReps = 200,
  seed = SEED,
  effect = MC_EFFECT,
  threshold = MC_THRESHOLD,
} = {}) {
  const master = mulberry32(seed);
  const rows = [];
  for (const q of qs) {
    if (!Number.isFinite(q) || q < 0 || q > 1) throw new Error(`power: q must be in [0,1], got ${q}`);
    let passes = 0;
    const medians = [];
    for (let sim = 0; sim < sims; sim += 1) {
      const pairs = [];
      for (let task = 0; task < n; task += 1) {
        const benefited = master() < q;
        pairs.push({
          taskId: `t${task}`,
          baseline: { wasteTurns: 1 },
          treatment: { wasteTurns: benefited ? 1 - effect : 1 },
        });
      }
      const bootstrapSeed = Math.floor(master() * 0xffffffff) >>> 0;
      const stats = wasteReductionStats(pairs, { reps: bootstrapReps, seed: bootstrapSeed });
      if (stats.median !== null && stats.median >= threshold - 1e-12 && stats.lower > 0) passes += 1;
      medians.push(stats.median);
    }
    rows.push({
      q,
      power: passes / sims,
      sims,
      bootstrapReps,
      n,
      effect,
      threshold,
      medianOfMedians: medianOf(medians),
    });
  }
  return { seed, rows, note: "report-only; the frozen POWER_GATE does not read this value" };
}
