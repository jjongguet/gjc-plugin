/**
 * Canonical `gjc.quality_trial.v2` validator and counts-only quality cohort.
 *
 * A trial receipt is the only admissible evidence for task quality: the
 * producer writes the arm, the executor runs it, and a verifier independent of
 * both records the outcome. This module validates that structure and projects a
 * cohort of counts. It never measures anything, never calls a model and never
 * grants a boolean "efficacy allowed" permission — callers get the counts and
 * decide nothing from a single flag.
 *
 * Exclusion taxonomy (a record is admitted at most once, else counted):
 *   legacy_schema             not a well-formed v2 payload (wrong schema,
 *                             missing/malformed required field, or an
 *                             executionKey that does not re-derive)
 *   conflicting_duplicate     same execution cell as an admitted trial with a
 *                             different payload
 *   non_independent_producer  producer.id === executor.id
 *   non_independent_oracle    a bare independence boolean, or a verifier that
 *                             is the producer or the executor
 *   unknown_outcome           outcome is not a decidable passed|failed
 *   negative_cost             any measured cost component is negative
 *   missing_cost              cost is unmeasured, or an all-zero measurement
 *                             without a zeroCostRationale
 *   denominator_mismatch      the declared denominator does not add up or does
 *                             not agree with the outcome
 *
 * Repeats are distinct trials: the identity of one execution is the
 * executionKey, which includes `repeat`. Identical duplicates are collapsed to
 * one admitted trial and counted once; same-cell different-payload records are
 * conflicts, never silent overwrites.
 */
import { createHash } from "node:crypto";

export const QUALITY_TRIAL_SCHEMA = "gjc.quality_trial.v2";
export const QUALITY_COHORT_SCHEMA = "rrsi.quality_cohort.v2";

export const QUALITY_SPLITS = Object.freeze(["training", "development", "holdout"]);
export const QUALITY_ARMS = Object.freeze(["B0", "B1", "B2"]);
export const QUALITY_OUTCOMES = Object.freeze(["passed", "failed"]);

export const QUALITY_EXCLUSIONS = Object.freeze([
  "legacy_schema",
  "conflicting_duplicate",
  "non_independent_producer",
  "non_independent_oracle",
  "unknown_outcome",
  "negative_cost",
  "missing_cost",
  "denominator_mismatch",
]);

export const QUALITY_LIMITS = Object.freeze({
  maxTrials: 4000,
  maxIdChars: 64,
  maxVersionChars: 32,
  maxTextChars: 120,
  maxRationaleChars: 200,
});

const DIGEST_HEX = /^[a-f0-9]{64}$/;
const HEAD_HEX = /^[a-f0-9]{7,64}$/;

/** Shared digest shape: the same predicate pins every pin in a trial receipt. */
export const isDigestHex = (value) => typeof value === "string" && DIGEST_HEX.test(value);

const isPlainRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const qtText = (value, max = QUALITY_LIMITS.maxIdChars) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max ? value.trim() : null;
const qtDigest = (value) => (isDigestHex(value) ? value : null);
const qtCount = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const qtRevision = (value) => (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : qtText(value, QUALITY_LIMITS.maxIdChars));

/** taskVersion accepts `1`, `"1"` or `"v1"`; the key sees one canonical string. */
const qtVersion = (value) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? String(value) : qtText(value, QUALITY_LIMITS.maxVersionChars);

/** One execution cell: repeats are distinct trials because `repeat` is in the key. */
export function executionKeyFor({ taskId, taskVersion, arm, repeat, harnessDigest, oracleDigest, goalRevision }) {
  return sha256(
    JSON.stringify({
      taskId,
      taskVersion: String(taskVersion),
      arm,
      repeat,
      harnessDigest,
      oracleDigest,
      goalRevision: String(goalRevision),
    }),
  );
}

const qtInvalid = (reason, detail = null) => ({ ok: false, reason, detail });

/**
 * Validate one trial record. Structure first (any malformed field is a
 * `legacy_schema` payload), then independence, outcome, denominator and cost.
 */
export function validateQualityTrial(record) {
  if (!isPlainRecord(record) || record.schema !== QUALITY_TRIAL_SCHEMA) return qtInvalid("legacy_schema", "schema");

  const trialId = qtText(record.trialId, QUALITY_LIMITS.maxIdChars);
  const taskId = qtText(record.taskId, QUALITY_LIMITS.maxIdChars);
  const taskVersion = qtVersion(record.taskVersion);
  const split = QUALITY_SPLITS.includes(record.split) ? record.split : null;
  const arm = QUALITY_ARMS.includes(record.arm) ? record.arm : null;
  const repeat = qtCount(record.repeat);
  const goalRevision = qtRevision(record.goalRevision);
  if (!trialId || !taskId || taskVersion === null || !split || !arm || repeat === null || goalRevision === null) {
    return qtInvalid("legacy_schema", "identity");
  }

  const producer = record.producer;
  const executor = record.executor;
  const harness = record.harness;
  const oracle = record.oracle;
  if (!isPlainRecord(producer) || !isPlainRecord(executor) || !isPlainRecord(harness) || !isPlainRecord(oracle)) {
    return qtInvalid("legacy_schema", "blocks");
  }
  const producerId = qtText(producer.id, QUALITY_LIMITS.maxIdChars);
  const producerKind = qtText(producer.kind, QUALITY_LIMITS.maxTextChars);
  const executorId = qtText(executor.id, QUALITY_LIMITS.maxIdChars);
  const receiptId = qtText(executor.receiptId, QUALITY_LIMITS.maxIdChars);
  const receiptDigest = qtDigest(executor.receiptDigest);
  if (!producerId || !producerKind || !executorId || !receiptId || !receiptDigest) return qtInvalid("legacy_schema", "producer_executor");

  const sourceDigest = qtDigest(harness.sourceDigest);
  const harnessDigest = qtDigest(harness.harnessDigest);
  const manifestDigest = qtDigest(harness.manifestDigest);
  const harnessVersion = qtText(harness.version, QUALITY_LIMITS.maxVersionChars);
  if (!sourceDigest || !harnessDigest || !manifestDigest || !harnessVersion) return qtInvalid("legacy_schema", "harness");

  if (typeof oracle.independentFromProducer !== "boolean") return qtInvalid("legacy_schema", "oracle_independence");

  const oracleKind = qtText(oracle.kind, QUALITY_LIMITS.maxTextChars);
  const verifierId = qtText(oracle.verifierId, QUALITY_LIMITS.maxIdChars);
  const evidenceDigest = qtDigest(oracle.evidenceDigest);
  const verifierIndependent = Boolean(verifierId) && verifierId !== producerId && verifierId !== executorId;
  if (oracle.independentFromProducer !== true || !verifierIndependent || !oracleKind || !evidenceDigest) {
    return qtInvalid("non_independent_oracle", "oracle");
  }

  const createdAt = typeof record.createdAt === "string" && Number.isFinite(Date.parse(record.createdAt)) ? record.createdAt : null;
  const sourceHead = typeof record.sourceHead === "string" && HEAD_HEX.test(record.sourceHead) ? record.sourceHead : null;
  if (!createdAt || !sourceHead) return qtInvalid("legacy_schema", "provenance");

  const executionKey = qtText(record.executionKey, 64);
  const derivedKey = executionKeyFor({ taskId, taskVersion, arm, repeat, harnessDigest, oracleDigest: evidenceDigest, goalRevision });
  if (!executionKey || executionKey !== derivedKey) return qtInvalid("legacy_schema", "execution_key");

  if (producerId === executorId) return qtInvalid("non_independent_producer", "producer_is_executor");

  const outcome = record.outcome;
  if (!QUALITY_OUTCOMES.includes(outcome)) return qtInvalid("unknown_outcome", "outcome");

  const rawDenominator = record.denominator;
  if (!isPlainRecord(rawDenominator)) return qtInvalid("legacy_schema", "denominator");
  const denominator = {
    planned: qtCount(rawDenominator.planned),
    passed: qtCount(rawDenominator.passed),
    failed: qtCount(rawDenominator.failed),
    error: qtCount(rawDenominator.error),
    skipped: qtCount(rawDenominator.skipped),
  };
  if (Object.values(denominator).some((value) => value === null)) return qtInvalid("legacy_schema", "denominator");
  const declared = denominator.planned;
  const accounted = denominator.passed + denominator.failed + denominator.error + denominator.skipped;
  const outcomeAgrees =
    outcome === "passed"
      ? denominator.passed >= 1 && denominator.failed === 0 && denominator.error === 0
      : denominator.failed >= 1;
  if (declared < 1 || declared !== accounted || !outcomeAgrees) return qtInvalid("denominator_mismatch", "denominator");

  const rawCost = record.cost;
  if (!isPlainRecord(rawCost) || rawCost.measured !== true) return qtInvalid("missing_cost", "measured");
  const cost = {
    wallMs: rawCost.wallMs,
    inputTokens: rawCost.inputTokens,
    outputTokens: rawCost.outputTokens,
    usd: rawCost.usd,
  };
  if (!Object.values(cost).every((value) => typeof value === "number" && Number.isFinite(value))) {
    return qtInvalid("missing_cost", "unmeasured_component");
  }
  if (Object.values(cost).some((value) => value < 0)) return qtInvalid("negative_cost", "negative_component");
  const zeroCost = cost.wallMs === 0 && cost.inputTokens === 0 && cost.outputTokens === 0 && cost.usd === 0;
  const zeroCostRationale = qtText(rawCost.zeroCostRationale, QUALITY_LIMITS.maxRationaleChars);
  if (zeroCost && !zeroCostRationale) return qtInvalid("missing_cost", "zero_without_rationale");

  return {
    ok: true,
    trial: {
      trialId,
      executionKey,
      taskId,
      taskVersion,
      split,
      arm,
      repeat,
      goalRevision,
      producer: { id: producerId, kind: producerKind },
      executor: { id: executorId, receiptId, receiptDigest },
      harness: { sourceDigest, harnessDigest, manifestDigest, version: harnessVersion },
      oracle: { kind: oracleKind, verifierId, evidenceDigest },
      outcome,
      denominator,
      cost: { ...cost, measured: true, zeroCostRationale },
      createdAt,
      sourceHead,
    },
  };
}

/** Admissible trial -> bounded attempt-shaped row (no boolean permission field). */
function qtAttemptFor(trial) {
  return {
    provenance: trial.trialId,
    objective: trial.taskId,
    taskVersion: trial.taskVersion,
    split: trial.split,
    arm: trial.arm,
    repeat: trial.repeat,
    executionKey: trial.executionKey,
    decision: trial.outcome === "passed" ? "adopt" : "reject",
    wallMs: trial.cost.wallMs,
    usd: trial.cost.usd,
    costMeasured: true,
    sourceDigest: trial.harness.sourceDigest,
    harnessDigest: trial.harness.harnessDigest,
  };
}

/**
 * Counts-only cohort over trial records. Every inspected record lands in
 * exactly one bucket: admissible, one exclusion reason, or `duplicate`.
 */
export function projectQualityTrialCohort(records, { limit = QUALITY_LIMITS.maxTrials } = {}) {
  const admissible = [];
  const counts = new Map();
  const exclude = (reason) => counts.set(reason, (counts.get(reason) ?? 0) + 1);
  const admitted = new Map();
  let total = 0;
  let duplicate = 0;
  for (const record of Array.isArray(records) ? records : []) {
    if (total >= limit) break;
    total += 1;
    const checked = validateQualityTrial(record);
    if (!checked.ok) {
      exclude(checked.reason);
      continue;
    }
    const { trial } = checked;
    const canonical = JSON.stringify(trial);
    const prior = admitted.get(trial.executionKey);
    if (prior === undefined) {
      admitted.set(trial.executionKey, canonical);
      admissible.push(qtAttemptFor(trial));
      continue;
    }
    if (prior === canonical) duplicate += 1;
    else exclude("conflicting_duplicate");
  }
  return {
    schema: QUALITY_COHORT_SCHEMA,
    total,
    admissible,
    excluded: [...counts].map(([reason, tally]) => ({ reason, count: tally })),
    duplicate,
  };
}
