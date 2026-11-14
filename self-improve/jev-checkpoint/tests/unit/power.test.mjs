import test from "node:test";
import assert from "node:assert/strict";
import {
  HOLDOUT_TASKS,
  Z_ALPHA_ONE_SIDED,
  Z_POWER,
  binomialTail,
  decisiveRunSize,
  logChoose,
  minQForPower,
  minTasksForPower,
  monteCarloA3,
  nRequired,
  normalQuantile,
  signTestPValue,
  signTestPower,
  signTestThreshold,
} from "../../lib/power.mjs";
import { SEED } from "../../lib/analyze.mjs";

const close = (actual, expected, tolerance = 1e-9) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `expected ${actual} to be within ${tolerance} of ${expected}`);

test("exact binomial tail matches the frozen holdout numbers", () => {
  assert.equal(logChoose(6, 6), 0);
  close(binomialTail({ n: 6, k: 6, q: 0.5 }), 1 / 64);
  close(binomialTail({ n: 6, k: 5, q: 0.5 }), 7 / 64);
  close(binomialTail({ n: 18, k: 13, q: 0.5 }), 12616 / 262144);
  close(binomialTail({ n: 18, k: 12, q: 0.5 }), 31180 / 262144);
  assert.equal(binomialTail({ n: 6, k: 0, q: 0.5 }), 1);
  assert.equal(binomialTail({ n: 6, k: 7, q: 0.5 }), 0);
  assert.equal(binomialTail({ n: 6, k: 3, q: 1 }), 1);
  assert.equal(binomialTail({ n: 6, k: 3, q: 0 }), 0);
  assert.throws(() => binomialTail({ n: 6, k: 3, q: 1.5 }), /q must be in/);
});

test("one-sided sign test: n=6 needs 6/6 and q=0.8 gives 0.262 power", () => {
  assert.equal(signTestThreshold({ n: 6 }), 6);
  assert.equal(signTestThreshold({ n: 18 }), 13);
  assert.equal(signTestThreshold({ n: 4 }), null);
  close(signTestPValue({ n: 6, k: 6 }), 1 / 64);
  close(signTestPValue({ n: 18, k: 13 }), 0.048126220703125);
  close(signTestPower({ n: 6, q: 0.8 }), 0.262144);
  close(signTestPower({ n: 6, q: 0.9 }), 0.531441);
  close(signTestPower({ n: 6, q: 0.95 }), 0.735091890625);
  assert.equal(signTestPower({ n: 4, q: 0.9 }), 0);
});

test("q of 0.963-0.964 is the holdout power threshold at 80%", () => {
  const threshold = minQForPower({ n: HOLDOUT_TASKS, alpha: 0.05, power: 0.8 });
  assert.ok(threshold > 0.963 && threshold < 0.964, `got ${threshold}`);
  assert.ok(signTestPower({ n: 6, q: 0.964 }) >= 0.8);
  assert.ok(signTestPower({ n: 6, q: 0.963 }) < 0.8);
});

test("minTasksForPower agrees with the decisive run of 18 task units", () => {
  assert.equal(minTasksForPower({ q: 0.8, alpha: 0.05, power: 0.8 }), 18);
  assert.equal(minTasksForPower({ q: 0.9, alpha: 0.05, power: 0.8 }), 8);
  for (const [q, n] of [
    [0.8, 18],
    [0.9, 8],
  ]) {
    const k = signTestThreshold({ n });
    assert.ok(binomialTail({ n, k, q }) >= 0.8);
    const previousK = signTestThreshold({ n: n - 1 });
    assert.ok(previousK === null || binomialTail({ n: n - 1, k: previousK, q }) < 0.8);
  }
});

test("normal-approximation sample size uses z0.95 + z0.80", () => {
  close(normalQuantile(0.95), 1.6448536269514722, 1e-6);
  close(normalQuantile(0.8), 0.8416212335729143, 1e-6);
  close(Z_ALPHA_ONE_SIDED + Z_POWER, 2.4864748605243865, 1e-6);
  assert.equal(nRequired({ sigma: 1, delta: 1 }), 7);
  assert.equal(nRequired({ sigma: 2, delta: 1 }), 25);
  assert.equal(nRequired({ sigma: 0.5, delta: 0.25 }), 25);
  assert.throws(() => nRequired({ sigma: 1, delta: 0 }), /delta must be > 0/);
  assert.throws(() => nRequired({ sigma: 0, delta: 1 }), /sigma must be > 0/);
});

test("decisive run reproduces holdout 18, k=13, alpha~0.048, power~0.87", () => {
  const run = decisiveRunSize();
  assert.equal(run.n, 18);
  assert.equal(run.k, 13);
  close(run.alpha, 0.048126220703125);
  assert.ok(run.power > 0.86 && run.power < 0.88, `power ${run.power}`);
  assert.equal(run.q, 0.8);
  assert.equal(run.repeats, 3);
  assert.deepEqual(run.arms, { s1: 3, s2: 1, s3: 2 });
  assert.deepEqual(run.cells, { s1: 162, s2: 54, s3: 108, total: 324 });
  assert.equal(run.holdoutTasks, 6);
});

test("Monte Carlo of the A3 estimator is seeded, report-only and monotone in q", () => {
  const settings = { qs: [0.6, 0.8, 0.9, 0.95], sims: 200, bootstrapReps: 100 };
  const first = monteCarloA3(settings);
  const second = monteCarloA3(settings);
  assert.deepEqual(first, second);
  assert.equal(first.seed, SEED);
  assert.equal(first.rows.length, 4);
  for (const row of first.rows) {
    assert.equal(row.sims, 200);
    assert.equal(row.bootstrapReps, 100);
    assert.equal(row.n, HOLDOUT_TASKS);
    assert.ok(row.power >= 0 && row.power <= 1);
  }
  const byQ = new Map(first.rows.map((row) => [row.q, row.power]));
  assert.ok(byQ.get(0.95) > byQ.get(0.8));
  assert.ok(byQ.get(0.8) > byQ.get(0.6));
  assert.ok(byQ.get(0.9) > 0.8);
  assert.ok(byQ.get(0.6) < 0.5);
  const other = monteCarloA3({ ...settings, seed: SEED + 1 });
  assert.notDeepEqual(first.rows, other.rows);
  assert.match(first.note, /report-only/);
});
