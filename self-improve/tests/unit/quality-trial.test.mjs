import test from "node:test";
import assert from "node:assert/strict";
import {
  QUALITY_COHORT_SCHEMA,
  QUALITY_EXCLUSIONS,
  QUALITY_TRIAL_SCHEMA,
  executionKeyFor,
  isDigestHex,
  projectQualityTrialCohort,
  validateQualityTrial,
} from "../../lib/quality-trial.mjs";

const digest = (fill) => fill.repeat(64).slice(0, 64);
const SOURCE = digest("a");
const HARNESS = digest("b");
const MANIFEST = digest("c");
const EVIDENCE = digest("d");
const RECEIPT = digest("e");

// Every fixture is its own execution cell (`repeat` is in the key).
let serial = 0;
function trial(over = {}) {
  serial += 1;
  const body = {
    schema: QUALITY_TRIAL_SCHEMA,
    trialId: `trial-${serial}`,
    taskId: "docs-links",
    taskVersion: 1,
    split: "development",
    arm: "B1",
    repeat: serial,
    goalRevision: 1,
    producer: { id: "producer-a", kind: "agent" },
    executor: { id: "executor-a", receiptId: "receipt-1", receiptDigest: RECEIPT },
    harness: { sourceDigest: SOURCE, harnessDigest: HARNESS, manifestDigest: MANIFEST, version: "harness2.v2" },
    oracle: { kind: "artifact-check", verifierId: "verifier-a", evidenceDigest: EVIDENCE, independentFromProducer: true },
    outcome: "passed",
    denominator: { planned: 3, passed: 3, failed: 0, error: 0, skipped: 0 },
    cost: { wallMs: 1200, inputTokens: 900, outputTokens: 120, usd: 0.01, measured: true },
    createdAt: "2026-10-24T02:00:00.000Z",
    sourceHead: "abcdef1",
    ...over,
  };
  body.executionKey = executionKeyFor({
    taskId: body.taskId,
    taskVersion: body.taskVersion,
    arm: body.arm,
    repeat: body.repeat,
    harnessDigest: body.harness.harnessDigest,
    oracleDigest: body.oracle.evidenceDigest,
    goalRevision: body.goalRevision,
  });
  return body;
}

test("a well-formed v2 trial validates and normalizes its blocks", () => {
  const record = trial({ split: "holdout", arm: "B2", taskVersion: "v3", goalRevision: "rev-7" });
  const checked = validateQualityTrial(record);
  assert.equal(checked.ok, true);
  assert.equal(checked.trial.split, "holdout");
  assert.equal(checked.trial.arm, "B2");
  assert.equal(checked.trial.taskVersion, "v3");
  assert.equal(checked.trial.goalRevision, "rev-7");
  assert.equal(checked.trial.executionKey, record.executionKey);
  assert.equal(checked.trial.cost.usd, 0.01);
  assert.equal(checked.trial.oracle.verifierId, "verifier-a");
  assert.match(checked.trial.executor.receiptDigest, /^[a-f0-9]{64}$/);
  assert.equal(isDigestHex(checked.trial.harness.sourceDigest), true);
});

test("the v1 cohort schema is a legacy payload, not a v2 trial", () => {
  const legacy = {
    schema: "rrsi.quality_trial.v1",
    trialId: "old-1",
    objective: "probe.docs_links",
    oracle: { independent: true, status: "passed" },
    harness: { sourceDigest: SOURCE, harnessDigest: HARNESS },
    cost: { measured: true, wallMs: 1200 },
  };
  assert.deepEqual(validateQualityTrial(legacy), { ok: false, reason: "legacy_schema", detail: "schema" });
  assert.deepEqual(validateQualityTrial({ operation: "advise" }), { ok: false, reason: "legacy_schema", detail: "schema" });
});

test("executionKey re-derives from the declares cell, and repeats split the cell", () => {
  const record = trial({ repeat: 2 });
  assert.equal(validateQualityTrial({ ...record, executionKey: digest("f") }).reason, "legacy_schema");
  const repeatA = executionKeyFor({ taskId: "t", taskVersion: 1, arm: "B1", repeat: 0, harnessDigest: HARNESS, oracleDigest: EVIDENCE, goalRevision: 1 });
  const repeatB = executionKeyFor({ taskId: "t", taskVersion: 1, arm: "B1", repeat: 1, harnessDigest: HARNESS, oracleDigest: EVIDENCE, goalRevision: 1 });
  const goalB = executionKeyFor({ taskId: "t", taskVersion: 1, arm: "B1", repeat: 0, harnessDigest: HARNESS, oracleDigest: EVIDENCE, goalRevision: 2 });
  assert.notEqual(repeatA, repeatB);
  assert.notEqual(repeatA, goalB);
});

test("independence is relational: a bare boolean, a self-verifier or a shared actor never passes", () => {
  const bare = trial({ oracle: { independentFromProducer: true } });
  assert.equal(validateQualityTrial(bare).reason, "non_independent_oracle");
  const selfVerified = trial({ oracle: { kind: "artifact-check", verifierId: "producer-a", evidenceDigest: EVIDENCE, independentFromProducer: true } });
  assert.equal(validateQualityTrial(selfVerified).reason, "non_independent_oracle");
  const executorVerified = trial({ oracle: { kind: "artifact-check", verifierId: "executor-a", evidenceDigest: EVIDENCE, independentFromProducer: true } });
  assert.equal(validateQualityTrial(executorVerified).reason, "non_independent_oracle");
  const claimed = trial({ oracle: { kind: "artifact-check", verifierId: "verifier-a", evidenceDigest: EVIDENCE, independentFromProducer: false } });
  assert.equal(validateQualityTrial(claimed).reason, "non_independent_oracle");
  const sameActor = trial({ producer: { id: "one", kind: "agent" }, executor: { id: "one", receiptId: "r", receiptDigest: RECEIPT } });
  assert.equal(validateQualityTrial(sameActor).reason, "non_independent_producer");
});

test("unknown outcomes, negative costs and inconsistent denominators are excluded", () => {
  assert.equal(validateQualityTrial(trial({ outcome: "skipped" })).reason, "unknown_outcome");
  assert.equal(validateQualityTrial(trial({ outcome: "failed", denominator: { planned: 2, passed: 2, failed: 0, error: 0, skipped: 0 } })).reason, "denominator_mismatch");
  assert.equal(validateQualityTrial(trial({ denominator: { planned: 4, passed: 3, failed: 0, error: 0, skipped: 0 } })).reason, "denominator_mismatch");
  assert.equal(
    validateQualityTrial(trial({ cost: { wallMs: 1200, inputTokens: 0, outputTokens: 0, usd: -0.5, measured: true } })).reason,
    "negative_cost",
  );
  assert.equal(
    validateQualityTrial(trial({ cost: { wallMs: -1, inputTokens: 0, outputTokens: 0, usd: 0.5, measured: true } })).reason,
    "negative_cost",
  );
});

test("an unmeasured or unexplained-zero cost is not a measurement", () => {
  assert.equal(validateQualityTrial(trial({ cost: { wallMs: 1200, inputTokens: 0, outputTokens: 0, usd: 0, measured: false } })).reason, "missing_cost");
  assert.equal(validateQualityTrial(trial({ cost: { wallMs: 0, inputTokens: 0, outputTokens: 0, usd: 0, measured: true } })).reason, "missing_cost");
  const explained = trial({ cost: { wallMs: 0, inputTokens: 0, outputTokens: 0, usd: 0, measured: true, zeroCostRationale: "cached fixture" } });
  assert.equal(validateQualityTrial(explained).ok, true);
});

test("the cohort is counts only and accounts for every inspected record", () => {
  const records = [trial(), trial({ outcome: "skipped" }), trial({ cost: { wallMs: 1200, inputTokens: 9, outputTokens: 1, usd: -1, measured: true } })];
  const cohort = projectQualityTrialCohort(records);
  assert.equal(cohort.schema, QUALITY_COHORT_SCHEMA);
  assert.equal(cohort.total, 3);
  assert.equal(cohort.admissible.length, 1);
  assert.equal(cohort.duplicate, 0);
  assert.deepEqual(Object.fromEntries(cohort.excluded.map((entry) => [entry.reason, entry.count])), { unknown_outcome: 1, negative_cost: 1 });
  assert.equal("efficacyClaimsAllowed" in cohort, false);
  const accounted = cohort.admissible.length + cohort.duplicate + cohort.excluded.reduce((sum, entry) => sum + entry.count, 0);
  assert.equal(accounted, cohort.total);
  for (const entry of cohort.excluded) assert.ok(QUALITY_EXCLUSIONS.includes(entry.reason), entry.reason);
});

test("an identical duplicate is counted once; a conflicting duplicate is excluded", () => {
  const record = trial();
  const identical = projectQualityTrialCohort([record, JSON.parse(JSON.stringify(record))]);
  assert.equal(identical.admissible.length, 1);
  assert.equal(identical.duplicate, 1);
  assert.deepEqual(identical.excluded, []);

  const conflict = { ...JSON.parse(JSON.stringify(record)), cost: { ...record.cost, usd: 0.02 } };
  const conflicted = projectQualityTrialCohort([record, conflict]);
  assert.equal(conflicted.admissible.length, 1);
  assert.equal(conflicted.duplicate, 0);
  assert.deepEqual(conflicted.excluded, [{ reason: "conflicting_duplicate", count: 1 }]);
});

test("repeats of one task design are distinct trials, not duplicates", () => {
  const first = trial();
  const second = trial({ repeat: first.repeat + 100 });
  const third = trial({ repeat: first.repeat + 200, split: "holdout" });
  const cohort = projectQualityTrialCohort([first, second, third]);
  assert.equal(cohort.admissible.length, 3);
  assert.equal(cohort.duplicate, 0);
  assert.equal(new Set(cohort.admissible.map((entry) => entry.executionKey)).size, 3);
});
