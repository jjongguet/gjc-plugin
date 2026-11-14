import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { QUALITY_TRIAL_SCHEMA, executionKeyFor, validateQualityTrial } from "../../../lib/quality-trial.mjs";
import { armFor, buildReceipt, buildReceipts, costFor, requireContext, validateAll } from "../../lib/receipts.mjs";
import {
  ADOPTED,
  BOOTSTRAP_REPS,
  DECLARED_EFFECT_PP,
  INSUFFICIENT,
  POWER_GATE,
  REJECTED,
  RULE_TABLE,
  SEED,
  analyzeFinal,
  analyzeS1,
  bootstrap,
  decideVerdict,
  mulberry32,
  normalizeRecords,
  p1Gate,
  ruleTableDigest,
  taskMeans,
  wasteRatioFor,
} from "../../lib/analyze.mjs";

const TASKS = ["t1", "t2", "t3", "t4", "t5", "t6"];
const X_IDS = ["X1", "X2", "X3", "X4", "X5", "X6"];
const A_IDS = ["A1", "A2", "A3", "A4", "A5"];

const baseCell = (overrides = {}) => ({
  stage: "S3",
  split: "holdout",
  taskId: "t1",
  repeat: 1,
  condition: "a1-off",
  status: "ok",
  errorClass: null,
  score: 2,
  success: 1,
  wasteTurns: 4,
  turnCap: 16,
  sessionUsd: 0.1,
  jevUsd: 0,
  wallMs: 1000,
  tokens: 5000,
  triggerCount: 0,
  adviceCount: 0,
  ignoredAdvice: 0,
  falseStop: 0,
  falseProceed: 0,
  labelChecks: 0,
  labelCorrect: 0,
  noDecision: {},
  appendTokens: 0,
  harnessSignals: 0,
  ...overrides,
});

const value = (spec, taskId, repeat) => (typeof spec === "function" ? spec(taskId, repeat) : spec);

/** One condition over `tasks` x 3 repeats; every spec may be a literal or a fn. */
function armCells(condition, spec = {}) {
  const {
    stage = "S3",
    split = "holdout",
    tasks = TASKS,
    repeats = [1, 2, 3],
    success = 1,
    waste = 4,
    sessionUsd = 0.1,
    jevUsd = 0,
    wallMs = 1000,
    triggerCount = 0,
    adviceCount = 0,
    ignoredAdvice = 0,
    falseStop = 0,
    labelChecks = 0,
    labelCorrect = 0,
    noDecision = {},
    harnessSignals = 0,
    status = "ok",
    errorClass = null,
  } = spec;
  return tasks.flatMap((taskId) =>
    repeats.map((repeat) =>
      baseCell({
        stage,
        split,
        taskId,
        repeat,
        condition,
        success: value(success, taskId, repeat),
        wasteTurns: value(waste, taskId, repeat),
        sessionUsd: value(sessionUsd, taskId, repeat),
        jevUsd: value(jevUsd, taskId, repeat),
        wallMs: value(wallMs, taskId, repeat),
        triggerCount: value(triggerCount, taskId, repeat),
        adviceCount: value(adviceCount, taskId, repeat),
        ignoredAdvice: value(ignoredAdvice, taskId, repeat),
        falseStop: value(falseStop, taskId, repeat),
        labelChecks: value(labelChecks, taskId, repeat),
        labelCorrect: value(labelCorrect, taskId, repeat),
        noDecision: value(noDecision, taskId, repeat),
        harnessSignals: value(harnessSignals, taskId, repeat),
        status: value(status, taskId, repeat),
        errorClass: value(errorClass, taskId, repeat),
      }),
    ),
  );
}

/** A treatment arm that engages the mechanism healthily (no X4/X6 signal). */
const HEALTHY_ADVICE = { triggerCount: 1, adviceCount: 1, ignoredAdvice: 0, labelChecks: 4, labelCorrect: 4 };

const splitRules = (rules) => ({
  adoption: Object.fromEntries(A_IDS.map((id) => [id, rules[id]])),
  xRules: Object.fromEntries(X_IDS.map((id) => [id, rules[id]])),
});

const adoptionPassingRecords = () => [
  ...armCells("a1-off", { success: 1, waste: 4, sessionUsd: 0.1, wallMs: 1000 }),
  ...armCells("fz-frozen", { success: 1, waste: 2, sessionUsd: 0.08, jevUsd: 0.002, wallMs: 1020, ...HEALTHY_ADVICE }),
];

test("rule table is frozen, digest is stable and carries the frozen constants", () => {
  assert.equal(SEED, 20261114);
  assert.equal(BOOTSTRAP_REPS, 10000);
  assert.equal(DECLARED_EFFECT_PP, 0.25);
  assert.equal(POWER_GATE, "fail");
  assert.deepEqual(Object.keys(RULE_TABLE.adoption), A_IDS);
  assert.deepEqual(Object.keys(RULE_TABLE.rejection), X_IDS);
  assert.equal(RULE_TABLE.rejection.X2.threshold, 1 / 12);
  assert.equal(RULE_TABLE.rejection.X3.threshold, 1.1);
  assert.equal(RULE_TABLE.rejection.X6.accuracyThreshold, 0.75);
  assert.equal(RULE_TABLE.declaration.minDeterminableDelta, 0.25);
  assert.equal(RULE_TABLE.mapping.length, 5);
  assert.throws(() => {
    RULE_TABLE.adoption.A1.threshold = 9;
  }, TypeError);
  const digest = ruleTableDigest();
  assert.match(digest, /^[a-f0-9]{64}$/);
  assert.equal(digest, ruleTableDigest());
});

test("PRNG and bootstrap are deterministic for a fixed seed", () => {
  const first = mulberry32(SEED);
  const second = mulberry32(SEED);
  const draws = [first(), first(), first()];
  assert.deepEqual(draws, [second(), second(), second()]);
  assert.notEqual(draws[0], mulberry32(SEED + 1)());

  const units = [1, 2, 3, 4, 5];
  const meanOfSample = (sample) => sample.reduce((sum, item) => sum + item, 0) / sample.length;
  const a = bootstrap(units, meanOfSample, { reps: 500, seed: SEED });
  const b = bootstrap(units, meanOfSample, { reps: 500, seed: SEED });
  assert.deepEqual(a, b);
  assert.equal(a.n, 5);
  assert.equal(a.valid, 500);
  const other = bootstrap(units, meanOfSample, { reps: 500, seed: 7 });
  assert.notDeepEqual(a, other);
  assert.equal(bootstrap([], meanOfSample).lower, null);
});

test("task-unit aggregation: six tasks resampled as six means, not eighteen cells", () => {
  const records = armCells("a1-off", { success: (taskId, repeat) => (taskId === "t1" && repeat === 3 ? 0 : 1) });
  const normalized = normalizeRecords(records);
  assert.equal(normalized.cells.length, 18);
  const tasks = taskMeans(normalized.cells);
  assert.equal(tasks.length, 6);
  const first = tasks.find((task) => task.taskId === "t1");
  assert.ok(Math.abs(first.success - 2 / 3) < 1e-12);
  assert.equal(first.repeats, 3);

  const result = analyzeFinal({ records: adoptionPassingRecords() });
  assert.equal(result.baseline.pairs, 6);
  assert.equal(result.rules.A1.detail.pairs, 6);
  assert.equal(result.rules.A1.detail.reps, BOOTSTRAP_REPS);
  assert.equal(result.rules.A1.detail.seed, SEED);
});

test("F4: error cells impute success 0, observed-or-cap waste and ledger cost, symmetrically", () => {
  const cells = [
    baseCell({ condition: "a1-off", taskId: "t1", repeat: 1, turnCap: 20, status: "failed", errorClass: "cell_cap", success: undefined, wasteTurns: 5, sessionUsd: 0.03 }),
    baseCell({ condition: "a1-off", taskId: "t1", repeat: 2, turnCap: 20, status: "failed", errorClass: "timeout", success: 0, wasteTurns: null, sessionUsd: null, reservedUsd: 0.04 }),
    baseCell({ condition: "a1-off", taskId: "t1", repeat: 3, turnCap: 20, status: "ok", success: 1, wasteTurns: 2 }),
  ];
  const normalized = normalizeRecords(cells, { turnCap: 20 });
  assert.equal(normalized.cells.length, 3);
  const [observed, capped, ok] = normalized.cells;
  assert.equal(observed.success, 0);
  assert.equal(observed.wasteTurns, 5);
  assert.equal(observed.wasteFromCap, false);
  assert.equal(capped.success, 0);
  assert.equal(capped.wasteTurns, 20);
  assert.equal(capped.wasteFromCap, true);
  assert.equal(capped.sessionUsd, 0.04);
  assert.equal(ok.success, 1);
  assert.deepEqual(
    { waste_error_imputed: normalized.imputed.waste_error_imputed, cost_reserved: normalized.imputed.cost_reserved, error_cells: normalized.imputed.error_cells },
    { waste_error_imputed: 1, cost_reserved: 1, error_cells: 2 },
  );

  const treatment = normalizeRecords(
    cells.map((cell) => ({ ...cell, condition: "fz-frozen" })),
    { turnCap: 20 },
  );
  assert.deepEqual(treatment.imputed, normalized.imputed);
  assert.deepEqual(
    treatment.cells.map((cell) => [cell.success, cell.wasteTurns, cell.sessionUsd]),
    normalized.cells.map((cell) => [cell.success, cell.wasteTurns, cell.sessionUsd]),
  );
  const tasks = taskMeans(normalized.cells);
  assert.equal(tasks[0].wasteTurns, (5 + 20 + 2) / 3);
  assert.equal(tasks[0].success, (0 + 0 + 1) / 3);

  // The runner applies the same cap itself when a cell has no transcript: it
  // marks the record `imputed` and leaves waste at the record's turnCap.
  const producerCapped = normalizeRecords([
    baseCell({ condition: "fz-frozen", taskId: "t2", repeat: 1, turnCap: 16, status: "failed", errorClass: "spawn", success: 0, wasteTurns: 16, imputed: true, sessionUsd: 0.02 }),
  ]);
  assert.equal(producerCapped.imputed.waste_error_imputed, 1);
  assert.equal(producerCapped.cells[0].wasteFromCap, true);
  assert.equal(producerCapped.cells[0].wasteTurns, 16);

  const observedAtCap = normalizeRecords([
    baseCell({ condition: "fz-frozen", taskId: "t3", repeat: 1, status: "failed", errorClass: "cell_cap", success: 0, wasteTurns: 4, imputed: true, sessionUsd: 0.02 }),
  ]);
  assert.equal(observedAtCap.imputed.waste_error_imputed, 0);
});

test("zero-baseline waste ratio follows the post-consensus amendment", () => {
  assert.equal(wasteRatioFor(0, 0), 0);
  assert.equal(wasteRatioFor(0, 2), -1);
  assert.equal(wasteRatioFor(4, 0), 1);
  assert.equal(wasteRatioFor(4, 2), 0.5);
  assert.equal(wasteRatioFor(Number.NaN, 2), null);

  const allZero = [
    ...armCells("a1-off", { waste: 0 }),
    ...armCells("fz-frozen", { waste: 0, sessionUsd: 0.08, jevUsd: 0.002, ...HEALTHY_ADVICE }),
  ];
  const zero = analyzeFinal({ records: allZero });
  assert.equal(zero.rules.A3.detail.zeroBaseline, 6);
  assert.equal(zero.rules.A3.passed, false);
  assert.equal(zero.rules.A3.value, 0);
  assert.notEqual(zero.branch, "x-rule");
  assert.equal(zero.verdict, INSUFFICIENT);

  const pureLoss = [
    ...armCells("a1-off", { waste: 0 }),
    ...armCells("fz-frozen", { waste: 2, sessionUsd: 0.08, jevUsd: 0.002, ...HEALTHY_ADVICE }),
  ];
  const loss = analyzeFinal({ records: pureLoss });
  assert.equal(loss.rules.A3.value, -1);
  assert.equal(loss.rules.A3.passed, false);
});

test("branch 3: power gate blocks adoption even when A1-A5 all pass", () => {
  const result = analyzeFinal({ records: adoptionPassingRecords() });
  for (const id of A_IDS) assert.equal(result.rules[id].passed, true, `${id} should pass`);
  for (const id of X_IDS) assert.equal(result.rules[id].fired, false, `${id} should not fire`);
  assert.equal(POWER_GATE, "fail");
  assert.equal(result.branch, "power-gate");
  assert.equal(result.verdict, INSUFFICIENT);
  assert.notEqual(result.verdict, ADOPTED);
  assert.equal(result.decision.adoptionPassed, true);
  assert.equal(result.powerGate, "fail");
  assert.ok(result.observations.some((entry) => entry.code === "power_gate_fail"));
  assert.ok(result.observations.some((entry) => entry.code === "adoption_rules_passed"));

  const { adoption, xRules } = splitRules(result.rules);
  assert.equal(decideVerdict({ adoption, xRules, powerGate: POWER_GATE }).verdict, INSUFFICIENT);
  assert.equal(decideVerdict({ adoption, xRules, powerGate: POWER_GATE }).branch, "power-gate");
  const hypothetical = decideVerdict({ adoption, xRules, powerGate: "pass" });
  assert.equal(hypothetical.verdict, ADOPTED);
  assert.equal(hypothetical.branch, "adopted");
});

test("saturation 100% vs 100% is noted without disabling A1", () => {
  const result = analyzeFinal({ records: adoptionPassingRecords() });
  assert.equal(result.saturation.baselineAtCeiling, true);
  assert.equal(result.saturation.treatmentAtCeiling, true);
  assert.equal(result.saturation.superiorityIndeterminate, true);
  assert.equal(result.saturation.note, "우월성 판정 불가");
  assert.equal(result.rules.A1.passed, true);
  assert.equal(result.rules.A1.value, 0);
});

test("branch 2: X1 ceiling collapse rejects the treatment", () => {
  const records = [
    ...armCells("a1-off"),
    ...armCells("fz-frozen", { success: (task) => (task === "t1" ? 0 : 1), ...HEALTHY_ADVICE }),
  ];
  const result = analyzeFinal({ records });
  assert.equal(result.rules.X1.fired, true);
  assert.deepEqual(result.rules.X1.detail.tasks, ["t1"]);
  assert.equal(result.rules.X2.fired, true);
  assert.equal(result.branch, "x-rule");
  assert.equal(result.verdict, REJECTED);
});

test("branch 1: early termination wins over a fired X rule and stays insufficient", () => {
  const records = [
    ...armCells("a1-off"),
    ...armCells("fz-frozen", { success: (task) => (task === "t1" ? 0 : 1), ...HEALTHY_ADVICE }),
    baseCell({ condition: "fz-frozen", taskId: "t9", status: "not_run", success: 0, wasteTurns: null, sessionUsd: null, reservedUsd: 0.01 }),
    baseCell({ condition: "fz-frozen", taskId: "t8", status: "failed", errorClass: "global_stop", wasteTurns: 16, sessionUsd: 0.02 }),
  ];
  const result = analyzeFinal({ records });
  assert.equal(result.rules.X1.fired, true);
  assert.equal(result.branch, "early-termination");
  assert.equal(result.verdict, INSUFFICIENT);
  assert.notEqual(result.verdict, REJECTED);
  assert.equal(result.rules.A5.passed, false);
  assert.equal(result.imputed.not_run, 1);
  assert.ok(
    result.observations.some((entry) => entry.code === "x_rule_suppressed_by_partial" && entry.detail.rule === "X1"),
  );

  const forced = analyzeFinal({ records: adoptionPassingRecords(), termination: { terminated: true, reason: "global_stop" } });
  assert.equal(forced.branch, "early-termination");
  assert.ok(forced.observations.some((entry) => entry.code === "termination_reason" && entry.detail.reason === "global_stop"));
});

test("branch 5: the mapping's default fallback is insufficient, upstream of the constant gate", () => {
  const records = [
    ...armCells("a1-off", { waste: 4 }),
    ...armCells("fz-frozen", { waste: 4, sessionUsd: 0.08, jevUsd: 0.002, ...HEALTHY_ADVICE }),
  ];
  const result = analyzeFinal({ records });
  assert.equal(result.rules.A3.value, 0);
  assert.equal(result.rules.A3.passed, false);
  assert.equal(result.rules.A1.passed, true);
  assert.equal(result.rules.A2.passed, true);
  assert.equal(result.rules.A4.passed, true);
  for (const id of X_IDS) assert.equal(result.rules[id].fired, false, `${id} should not fire`);
  // The frozen order puts the constant power gate before the default bucket, so
  // the reachable branch is the gate; the verdict is insufficient either way.
  assert.equal(result.branch, "power-gate");
  assert.equal(result.verdict, INSUFFICIENT);
  assert.notEqual(result.verdict, ADOPTED);

  const { adoption, xRules } = splitRules(result.rules);
  const withoutGate = decideVerdict({ adoption, xRules, powerGate: "pass" });
  assert.equal(withoutGate.branch, "insufficient");
  assert.equal(withoutGate.verdict, INSUFFICIENT);
  assert.equal(withoutGate.adoptionPassed, false);
});

test("X3 fires on a cost ratio bound at or above 1.1", () => {
  const records = [
    ...armCells("a1-off", { sessionUsd: 0.1 }),
    ...armCells("fz-frozen", { sessionUsd: 0.12, waste: 2, ...HEALTHY_ADVICE }),
  ];
  const result = analyzeFinal({ records });
  assert.equal(result.rules.X3.fired, true);
  assert.ok(result.rules.X3.value >= 1.1 - 1e-9);
  assert.equal(result.verdict, REJECTED);
});

test("X4 fires on a trigger rate below 10% and on ignored advice at 70%", () => {
  const quiet = analyzeFinal({
    records: [...armCells("a1-off"), ...armCells("fz-frozen", { waste: 2, sessionUsd: 0.08, jevUsd: 0.002 })],
  });
  assert.equal(quiet.rules.X4.detail.triggerFired, true);
  assert.equal(quiet.rules.X4.fired, true);

  const ignored = analyzeFinal({
    records: [
      ...armCells("a1-off"),
      ...armCells("fz-frozen", { waste: 2, sessionUsd: 0.08, jevUsd: 0.002, triggerCount: 1, adviceCount: 10, ignoredAdvice: 7, labelChecks: 4, labelCorrect: 4 }),
    ],
  });
  assert.equal(ignored.rules.X4.detail.ignoredFired, true);
  assert.equal(ignored.rules.X4.value.ignoredAdviceRate, 0.7);
});

test("X5 fires at two harness collision signals", () => {
  const records = [
    ...armCells("a1-off"),
    ...armCells("fz-frozen", {
      waste: 2,
      sessionUsd: 0.08,
      jevUsd: 0.002,
      ...HEALTHY_ADVICE,
      harnessSignals: (taskId, repeat) => (taskId === "t1" && repeat <= 2 ? 1 : 0),
    }),
  ];
  const result = analyzeFinal({ records });
  assert.equal(result.rules.X5.value, 2);
  assert.equal(result.rules.X5.fired, true);
});

test("X6 counts no-decisions as wrong, breaks down causes and reports sensitivity", () => {
  const withNoDecision = analyzeFinal({
    records: [
      ...armCells("a1-off"),
      ...armCells("fz-frozen", {
        waste: 2,
        sessionUsd: 0.08,
        jevUsd: 0.002,
        triggerCount: 1,
        adviceCount: 1,
        labelChecks: (taskId, repeat) => (taskId === "t1" && repeat === 1 ? 4 : 0),
        labelCorrect: (taskId, repeat) => (taskId === "t1" && repeat === 1 ? 1 : 0),
        noDecision: (taskId, repeat) =>
          taskId === "t1" && repeat === 1 ? { unnormalized_probabilities: 2, provider_timeout: 1 } : {},
      }),
    ],
  });
  const x6 = withNoDecision.rules.X6;
  assert.equal(x6.fired, true);
  assert.equal(x6.detail.accuracyFired, true);
  assert.equal(x6.detail.accuracyDenominator, 4);
  assert.equal(x6.value.labelAccuracy, 0.25);
  assert.equal(x6.value.sensitivityAccuracy, 0.5);
  assert.deepEqual(x6.detail.breakdown, [
    { reason: "provider_timeout", count: 1 },
    { reason: "unnormalized_probabilities", count: 2 },
  ]);
  assert.equal(x6.detail.noDecisionTotal, 3);

  const sensitivityClears = analyzeFinal({
    records: [
      ...armCells("a1-off"),
      ...armCells("fz-frozen", {
        waste: 2,
        sessionUsd: 0.08,
        jevUsd: 0.002,
        triggerCount: 1,
        adviceCount: 1,
        labelChecks: (taskId, repeat) => (taskId === "t1" && repeat === 1 ? 4 : 0),
        labelCorrect: (taskId, repeat) => (taskId === "t1" && repeat === 1 ? 3 : 0),
        noDecision: (taskId, repeat) =>
          taskId === "t1" && repeat === 1 ? { unnormalized_probabilities: 1 } : {},
      }),
    ],
  });
  assert.equal(sensitivityClears.rules.X6.value.labelAccuracy, 0.75);
  assert.equal(sensitivityClears.rules.X6.value.sensitivityAccuracy, 1);
  assert.equal(sensitivityClears.rules.X6.detail.accuracyDenominator, 4);
  assert.equal(sensitivityClears.rules.X6.fired, false);

  const falseStop = analyzeFinal({
    records: [
      ...armCells("a1-off"),
      ...armCells("fz-frozen", {
        waste: 2,
        sessionUsd: 0.08,
        jevUsd: 0.002,
        triggerCount: 1,
        adviceCount: 10,
        ignoredAdvice: 0,
        falseStop: 1,
        labelChecks: 4,
        labelCorrect: 4,
      }),
    ],
  });
  assert.equal(falseStop.rules.X6.value.falseStopRate, 0.1);
  assert.equal(falseStop.rules.X6.detail.falseStopFired, true);
  assert.equal(falseStop.rules.X6.fired, true);
});

// ---------------------------------------------------------------------------
// F5: S1 pass table, winner tie-breaks and the C3 -> Fz condition
// ---------------------------------------------------------------------------

const S1_ADVICE = { triggerCount: 1, adviceCount: 1, ignoredAdvice: 0, labelChecks: 4, labelCorrect: 4 };

function s1Records({ baseline = {}, bp = {}, de = {}, c3 = null } = {}) {
  const records = [
    ...armCells("a1-off", { split: "dev", stage: "S1", success: 1, waste: 4, sessionUsd: 0.1, wallMs: 1000, ...S1_ADVICE, ...baseline }),
    ...armCells("bp-periodic", { split: "dev", stage: "S1", success: 1, waste: 2, sessionUsd: 0.09, wallMs: 1020, ...S1_ADVICE, ...bp }),
    ...armCells("de-error", { split: "dev", stage: "S1", success: 1, waste: 2.12, sessionUsd: 0.085, wallMs: 1020, ...S1_ADVICE, ...de }),
  ];
  if (c3) records.push(...armCells("c3-ensemble", { split: "dev", stage: "S2", success: 1, waste: 2, sessionUsd: 0.08, ...S1_ADVICE, ...c3 }));
  return records;
}

test("F5 tie-break 1: a waste gap under 5pp falls to the lower cost ratio", () => {
  const result = analyzeS1(s1Records());
  assert.equal(result.baseline.condition, "a1-off");
  assert.equal(result.candidates.length, 2);
  const bp = result.candidates.find((candidate) => candidate.condition === "bp-periodic");
  const de = result.candidates.find((candidate) => candidate.condition === "de-error");
  assert.equal(bp.waste.median, 0.5);
  assert.equal(de.waste.median, 0.47);
  assert.ok(Math.abs(bp.costRatio.ratioOfMeans - 0.9) < 1e-12);
  assert.ok(Math.abs(de.costRatio.ratioOfMeans - 0.85) < 1e-12);
  assert.equal(bp.passed, true);
  assert.equal(de.passed, true);
  assert.equal(result.winner, "de-error");
  assert.equal(result.winnerReason, "cost_ratio");
  assert.deepEqual(result.tieBreaks, ["waste_reduction"]);
  assert.equal(result.rules["P1:bp-periodic"].passed, true);
  assert.equal(result.rules["P2:de-error"].passed, true);
});

test("F5 tie-break 2: a cost gap under 0.02 falls to the lower trigger rate", () => {
  const result = analyzeS1(
    s1Records({
      bp: { sessionUsd: 0.086, triggerCount: 1 },
      de: { sessionUsd: 0.085, triggerCount: (taskId, repeat) => (TASKS.indexOf(taskId) < 3 ? 1 : 0) },
    }),
  );
  const bp = result.candidates.find((candidate) => candidate.condition === "bp-periodic");
  const de = result.candidates.find((candidate) => candidate.condition === "de-error");
  assert.ok(Math.abs(bp.costRatio.ratioOfMeans - 0.86) < 1e-12);
  assert.ok(Math.abs(de.costRatio.ratioOfMeans - 0.85) < 1e-12);
  assert.equal(bp.triggerRate, 1);
  assert.ok(Math.abs(de.triggerRate - 0.5) < 1e-12);
  assert.equal(result.winner, "de-error");
  assert.equal(result.winnerReason, "trigger_rate");
  assert.deepEqual(result.tieBreaks, ["waste_reduction", "cost_ratio"]);
});

test("F5 tie-break 3: an exact tie returns de-error; a clear waste gap keeps the leader", () => {
  const tied = analyzeS1(
    s1Records({
      bp: { waste: 2, sessionUsd: 0.08, triggerCount: 1 },
      de: { waste: 2, sessionUsd: 0.08, triggerCount: 1 },
    }),
  );
  assert.equal(tied.winner, "de-error");
  assert.equal(tied.winnerReason, "de_error");
  assert.deepEqual(tied.tieBreaks, ["waste_reduction", "cost_ratio", "trigger_rate", "de_error"]);

  const clear = analyzeS1(s1Records({ bp: { waste: 1.6 }, de: { waste: 2.12 } }));
  assert.equal(clear.winner, "bp-periodic");
  assert.equal(clear.winnerReason, "waste_reduction");
});

test("F5: P1 and P4 failures remove a candidate, and no passer means no winner", () => {
  const worse = analyzeS1(
    s1Records({
      bp: { success: (taskId) => (taskId === "t1" || taskId === "t2" ? 0.5 : 1) },
      de: { success: (taskId) => (taskId === "t1" ? 0 : 1) },
    }),
  );
  const bp = worse.candidates.find((candidate) => candidate.condition === "bp-periodic");
  const de = worse.candidates.find((candidate) => candidate.condition === "de-error");
  assert.equal(bp.passes.P1, false);
  assert.equal(bp.passed, false);
  assert.equal(de.passes.P4, false);
  assert.equal(de.passed, false);
  assert.equal(worse.winner, null);
  assert.equal(worse.winnerReason, "no_passer");
  assert.equal(worse.rules["P1:bp-periodic"].passed, false);
  assert.equal(worse.rules["P4:de-error"].passed, false);

  const failingP2 = analyzeS1(s1Records({ bp: { triggerCount: 0, adviceCount: 0 } }));
  const bpOnly = failingP2.candidates.find((candidate) => candidate.condition === "bp-periodic");
  assert.equal(bpOnly.passes.P2, false);
  assert.equal(failingP2.winner, "de-error");
});

test("C3 -> Fz needs the three dev conditions and an open P1 gate", () => {
  const passing = analyzeS1(
    s1Records({
      bp: { waste: 2, sessionUsd: 0.08, jevUsd: 0.01 },
      de: { waste: 2, sessionUsd: 0.08, jevUsd: 0.02 },
      c3: { waste: 1.9, jevUsd: 0.005 },
    }),
  );
  assert.equal(passing.winner, "de-error");
  assert.equal(passing.c3ToFz.evaluated, true);
  assert.equal(passing.c3ToFz.becomeFz, true);
  assert.equal(passing.c3ToFz.reason, "c3_becomes_fz");
  assert.ok(passing.c3ToFz.c3.jevUsdPerAbsorbedTurn < passing.c3ToFz.winner.jevUsdPerAbsorbedTurn);

  const gateClosed = analyzeS1(
    s1Records({
      bp: { waste: 2, sessionUsd: 0.08, jevUsd: 0.01 },
      de: { waste: 2, sessionUsd: 0.08, jevUsd: 0.02 },
      c3: { waste: 1.9, jevUsd: 0.005 },
    }),
    { j0: { agreementErrorRate: 0.12, bothWrongHighConfidence: 0 } },
  );
  assert.equal(gateClosed.c3ToFz.becomeFz, false);
  assert.equal(gateClosed.c3ToFz.reason, "p1_gate");
  assert.equal(gateClosed.c3ToFz.conditions.p1GateOpen, false);
  assert.equal(gateClosed.p1Gate.open, true);

  const expensive = analyzeS1(
    s1Records({
      bp: { waste: 2, sessionUsd: 0.08, jevUsd: 0.01 },
      de: { waste: 2, sessionUsd: 0.08, jevUsd: 0.02 },
      c3: { waste: 1.9, jevUsd: 0.5 },
    }),
  );
  assert.equal(expensive.c3ToFz.becomeFz, false);
  assert.equal(expensive.c3ToFz.reason, "jev_per_absorbed_turn");

  const noC3 = analyzeS1(s1Records());
  assert.equal(noC3.c3ToFz.evaluated, false);
  assert.equal(noC3.c3ToFz.reason, "no_c3_records");
});

test("P1 gate thresholds are 10% agreement errors and one high-confidence joint error", () => {
  assert.equal(p1Gate(null), null);
  const clean = p1Gate({ agreementErrorRate: 0.05, bothWrongHighConfidence: 0 });
  assert.equal(clean.open, false);
  assert.equal(clean.c3Adoptable, true);
  assert.equal(clean.agreementThreshold, 0.1);
  assert.equal(clean.bothWrongThreshold, 1 / 30);
  assert.equal(p1Gate({ agreementErrorRate: 0.1, bothWrongHighConfidence: 0 }).open, true);
  assert.equal(p1Gate({ agreementErrorRate: 0, bothWrongHighConfidence: 1 }).open, true);
});

test("a0-release is accepted as the baseline arm when a1-off is absent", () => {
  const records = [
    ...armCells("a0-release", { success: 1, waste: 4, sessionUsd: 0.1 }),
    ...armCells("fz-frozen", { success: 1, waste: 2, sessionUsd: 0.08, jevUsd: 0.002, ...HEALTHY_ADVICE }),
  ];
  const result = analyzeFinal({ records });
  assert.equal(result.baseline.condition, "a0-release");
  assert.equal(result.baseline.pairs, 6);
  assert.equal(result.rules.A1.passed, true);
  assert.ok(result.observations.some((entry) => entry.code === "dev_treatment_unavailable"));
  assert.ok(result.observations.some((entry) => entry.code === "dev_treatment" && entry.detail.condition === null));
});

test("imputed counts appear on the final result and unmeasured cost is reported", () => {
  const records = [
    ...armCells("a1-off"),
    ...armCells("fz-frozen", { waste: 2, sessionUsd: 0.08, jevUsd: 0.002, ...HEALTHY_ADVICE }),
    baseCell({ condition: "fz-frozen", taskId: "t7", repeat: 1, status: "failed", errorClass: "spawn", wasteTurns: null, sessionUsd: null, reservedUsd: null }),
  ];
  const result = analyzeFinal({ records });
  assert.equal(result.imputed.waste_error_imputed, 1);
  assert.equal(result.imputed.cost_unmeasured, 1);
  assert.ok(result.observations.some((entry) => entry.code === "cost_unmeasured"));
  assert.ok(result.observations.some((entry) => entry.code === "unpaired_task" && entry.detail.taskId === "t7"));
  assert.equal(result.rules.A2.detail.note, null);
  assert.equal(result.rules.A2.detail.pairs, 6);
});

// ---------------------------------------------------------------------------
// receipts: the gjc.quality_trial.v2 bridge for the same cell records.
// This section lives in the analyzer test file because the assignment's file
// boundary names only analyze.test.mjs and power.test.mjs.
// ---------------------------------------------------------------------------

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** Independent re-implementation of the receipt digest so the test can re-derive it. */
const canonicalReceipt = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalReceipt).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalReceipt(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const receiptContext = {
  producer: { id: "jexp-harness", kind: "harness" },
  executor: { id: "jexp-cell" },
  harness: {
    sourceDigest: "b".repeat(64),
    harnessDigest: "c".repeat(64),
    manifestDigest: "d".repeat(64),
    version: "jexp-v1",
  },
  oracle: {
    kind: "deterministic-oracle",
    verifierId: "jexp-blind-oracle",
    evidenceDigestFor: (record) => sha256(JSON.stringify({ taskId: record.taskId, repeat: record.repeat, score: record.score })),
  },
  createdAt: "2026-11-14T09:00:00Z",
  sourceHead: "4640b856",
};

const receiptCell = (overrides = {}) =>
  baseCell({
    taskId: "cost-arith",
    inputTokens: 3800,
    outputTokens: 400,
    ...overrides,
  });

test("receipts: arm mapping is B0 for baseline conditions and B1 for every treatment", () => {
  assert.equal(armFor("a1-off"), "B0");
  assert.equal(armFor("a0-release"), "B0");
  for (const condition of ["bp-periodic", "de-error", "c3-ensemble", "fz-frozen"]) assert.equal(armFor(condition), "B1");
  assert.throws(() => armFor("checkpoint-on"), /unknown condition/);
});

test("receipts: one validated gjc.quality_trial.v2 receipt per executed cell", () => {
  const records = [
    receiptCell({ condition: "a1-off", taskId: "cost-arith", repeat: 1 }),
    receiptCell({ condition: "fz-frozen", taskId: "cost-arith", repeat: 2 }),
    receiptCell({ condition: "fz-frozen", taskId: "merge-conflict", repeat: 1, status: "failed", errorClass: "cell_cap", success: 0.5, score: 1 }),
    receiptCell({ condition: "fz-frozen", taskId: "merge-conflict", repeat: 2, status: "not_run", success: 0, sessionUsd: null, reservedUsd: 0.01 }),
  ];
  const { receipts, skipped } = buildReceipts(records, receiptContext);
  assert.equal(receipts.length, 3);
  assert.deepEqual(skipped, [{ taskId: "merge-conflict", condition: "fz-frozen", repeat: 2, stage: "S3", reason: "not_run" }]);
  const report = validateAll(receipts);
  assert.equal(report.ok, true);
  assert.equal(report.total, 3);
  assert.equal(report.valid, 3);
  assert.deepEqual(report.failures, []);
  assert.deepEqual(report.conflicts, []);

  const [baseline, treatment, failed] = receipts;
  assert.equal(baseline.schema, QUALITY_TRIAL_SCHEMA);
  assert.equal(baseline.arm, "B0");
  assert.equal(treatment.arm, "B1");
  assert.equal(baseline.split, "holdout");
  assert.equal(baseline.condition, "a1-off");
  assert.equal(baseline.stage, "S3");
  assert.equal(baseline.score, 2);
  assert.equal(baseline.success, 1);
  assert.deepEqual([baseline.outcome, baseline.denominator], ["passed", { planned: 1, passed: 1, failed: 0, error: 0, skipped: 0 }]);
  assert.deepEqual([failed.outcome, failed.denominator], ["failed", { planned: 1, passed: 0, failed: 1, error: 0, skipped: 0 }]);
  assert.equal(failed.errorClass, "cell_cap");
  assert.equal(failed.success, 0.5);

  assert.equal(
    baseline.executionKey,
    executionKeyFor({
      taskId: "cost-arith",
      taskVersion: 1,
      arm: "B0",
      repeat: 1,
      harnessDigest: receiptContext.harness.harnessDigest,
      oracleDigest: baseline.oracle.evidenceDigest,
      goalRevision: "1",
    }),
  );
  assert.equal(baseline.executor.receiptDigest, sha256(canonicalReceipt(records[0])));
  assert.equal(validateQualityTrial(baseline).ok, true);
});

test("receipts: dev maps to development and includeNotRun attests an unstarted cell", () => {
  const records = [
    receiptCell({ split: "dev", stage: "S1", condition: "bp-periodic" }),
    receiptCell({ split: "dev", stage: "S1", status: "not_run", success: 0, sessionUsd: null, reservedUsd: 0.02 }),
  ];
  const { receipts } = buildReceipts(records, receiptContext, { includeNotRun: true });
  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].split, "development");
  assert.equal(receipts[1].outcome, "failed");
  assert.equal(validateAll(receipts).ok, true);
});

test("receipts: cost is the settled value then the reservation, and an all-zero cell explains itself", () => {
  assert.deepEqual(costFor(receiptCell({ sessionUsd: 0.5, reservedUsd: 0.9 })), {
    measured: true,
    wallMs: 1000,
    inputTokens: 3800,
    outputTokens: 400,
    usd: 0.5,
  });
  assert.equal(costFor(receiptCell({ sessionUsd: null, reservedUsd: 0.25 })).usd, 0.25);
  const zero = costFor(receiptCell({ sessionUsd: 0, wallMs: 0, inputTokens: 0, outputTokens: 0 }));
  assert.equal(zero.usd, 0);
  assert.equal(typeof zero.zeroCostRationale, "string");
  assert.ok(zero.zeroCostRationale.length <= 120);
  assert.throws(() => costFor(receiptCell({ sessionUsd: null, reservedUsd: null })), /neither a settled nor a reserved cost/);
  assert.throws(() => costFor(receiptCell({ sessionUsd: -1 })), /negative cost/);
});

test("receipts: missing or self-referential provenance is refused, never fabricated", () => {
  assert.throws(
    () => buildReceipt(receiptCell(), { ...receiptContext, harness: { ...receiptContext.harness, harnessDigest: undefined } }),
    /context\.harness\.harnessDigest/,
  );
  assert.throws(
    () => requireContext({ ...receiptContext, producer: { id: "same", kind: "harness" }, executor: { id: "same" } }),
    /must differ/,
  );
  assert.throws(
    () => requireContext({ ...receiptContext, oracle: { kind: "x", verifierId: "jexp-harness", evidenceDigest: "e".repeat(64) } }),
    /oracle\.verifierId must differ/,
  );
  assert.throws(() => requireContext({ ...receiptContext, oracle: { kind: "x", verifierId: "jexp-blind-oracle" } }), /evidenceDigestFor/);
  assert.throws(() => requireContext({ ...receiptContext, createdAt: "yesterday" }), /not an ISO timestamp/);
  assert.throws(() => buildReceipt(receiptCell({ stage: "S9" }), receiptContext), /stage must be one of/);
  assert.throws(() => buildReceipt(receiptCell({ split: "test" }), receiptContext), /unknown split/);
  assert.throws(() => buildReceipt(receiptCell({ repeat: 0 }), receiptContext), /positive integer repeat/);
  assert.throws(() => buildReceipt(receiptCell({ success: 2 }), receiptContext), /success outside/);
  assert.throws(() => buildReceipt(receiptCell({ condition: "checkpoint-on" }), receiptContext), /unknown condition/);
  assert.throws(() => buildReceipt(receiptCell({ sessionUsd: null, reservedUsd: null }), receiptContext), /neither a settled nor a reserved cost/);
});

test("receipts: validateAll names tampered keys and denominators by index", () => {
  const receipt = buildReceipt(receiptCell(), receiptContext);
  const badKey = validateAll([receipt, { ...receipt, trialId: "S3.a1-off.cost-arith.r2", executionKey: "f".repeat(64) }]);
  assert.equal(badKey.ok, false);
  assert.equal(badKey.failures.length, 1);
  assert.deepEqual(badKey.failures[0], {
    index: 1,
    trialId: "S3.a1-off.cost-arith.r2",
    taskId: "cost-arith",
    reason: "legacy_schema",
    detail: "execution_key",
  });
  assert.equal(badKey.valid, 1);

  const badDenominator = validateAll([{ ...receipt, denominator: { planned: 1, passed: 0, failed: 1, error: 0, skipped: 0 } }]);
  assert.equal(badDenominator.ok, false);
  assert.equal(badDenominator.failures[0].reason, "denominator_mismatch");
});

test("receipts: identical duplicates are allowed and counted, conflicting duplicates are not", () => {
  const receipt = buildReceipt(receiptCell(), receiptContext);
  const duplicate = validateAll([receipt, receipt]);
  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicates, 1);
  assert.equal(duplicate.valid, 1);

  const conflict = validateAll([receipt, { ...receipt, cost: { ...receipt.cost, usd: receipt.cost.usd + 1 } }]);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.duplicates, 0);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0].index, 1);
  assert.equal(conflict.conflicts[0].executionKey, receipt.executionKey);
});

test("receipts: construction is deterministic", () => {
  const records = [receiptCell({ condition: "fz-frozen" }), receiptCell({ condition: "c3-ensemble", repeat: 2 })];
  const first = buildReceipts(records, receiptContext);
  const second = buildReceipts(records, receiptContext);
  assert.deepEqual(first, second);
  assert.equal(first.receipts[0].executor.receiptId, first.receipts[0].trialId);
});
