/**
 * `gjc.quality_trial.v2` receipts for one jev-checkpoint cell each.
 *
 * The shape is owned by `self-improve/lib/quality-trial.mjs`; this module only
 * maps a cell record to that shape and re-validates the batch. Two decisions
 * are local:
 *
 * - Arm mapping (D7): the baseline conditions `a1-off`/`a0-release` are `B0`,
 *   every treatment condition is `B1`. `condition`, `stage` and `errorClass`
 *   stay as raw fields on the receipt, so the arm table keeps the finer
 *   distinction the validator deliberately does not model.
 * - Error cells are `failed:1, error:0` with `success` 0 and the cost still the
 *   ledger value (F4/D7). `error` stays 0 because the validator treats an
 *   `error` count as an unaccounted run, and the checkpoint needs every
 *   executed cell in the denominator.
 *
 * `not_run` cells produce no receipt: a cell that never started has no
 * execution to attest. They are returned in `skipped` so the arm table can
 * record them as `incomplete_pairs`, and `validateAll` never sees a fabricated
 * failed attestation for them.
 *
 * A cell without a settled or reserved cost throws instead of writing a zero
 * cost: a zero would satisfy `missing_cost` on paper and hide a real
 * accounting gap.
 */
import { createHash } from "node:crypto";
import { QUALITY_TRIAL_SCHEMA, executionKeyFor, validateQualityTrial } from "../../lib/quality-trial.mjs";

const DIGEST = /^[a-f0-9]{64}$/;
const HEAD = /^[a-f0-9]{7,64}$/;
const SPLIT_MAP = Object.freeze({ dev: "development", development: "development", holdout: "holdout", training: "training" });
const TREATMENT_CONDITIONS = Object.freeze(["bp-periodic", "de-error", "c3-ensemble", "fz-frozen"]);
const BASELINE_CONDITIONS = Object.freeze(["a1-off", "a0-release"]);
const STAGES = Object.freeze(["S1", "S2", "S3"]);
const TRIAL_ID_MAX = 64;
const RATIONALE = "all four measured cost components are zero for this cell";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const fail = (message) => {
  throw new Error(`receipts: ${message}`);
};

const finiteOrNull = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const countOrZero = (value) => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
const pick = (value, cell) => (typeof value === "function" ? value(cell) : value);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** Arm the validator sees: the two baseline conditions are B0, every treatment is B1. */
export function armFor(condition) {
  if (BASELINE_CONDITIONS.includes(condition)) return "B0";
  if (TREATMENT_CONDITIONS.includes(condition)) return "B1";
  fail(`unknown condition ${JSON.stringify(condition)}`);
}

const requirePath = (context, path) => {
  const value = path.reduce((node, key) => (isObject(node) ? node[key] : undefined), context);
  if (value === undefined || value === null || value === "") fail(`context.${path.join(".")} is required`);
  return value;
};

const requireDigest = (context, path) => {
  const value = requirePath(context, path);
  if (!DIGEST.test(value)) fail(`context.${path.join(".")} must be a 64-char hex digest`);
  return value;
};

/** Validate the caller-supplied provenance once; every field here is required. */
export function requireContext(context) {
  if (!isObject(context)) fail("context object is required (producer, executor, harness, oracle, createdAt, sourceHead)");
  const producer = { id: requirePath(context, ["producer", "id"]), kind: requirePath(context, ["producer", "kind"]) };
  const executor = { id: requirePath(context, ["executor", "id"]) };
  const harness = {
    sourceDigest: requireDigest(context, ["harness", "sourceDigest"]),
    harnessDigest: requireDigest(context, ["harness", "harnessDigest"]),
    manifestDigest: requireDigest(context, ["harness", "manifestDigest"]),
    version: requirePath(context, ["harness", "version"]),
  };
  const oracle = {
    kind: requirePath(context, ["oracle", "kind"]),
    verifierId: requirePath(context, ["oracle", "verifierId"]),
    evidenceDigestFor: context.oracle.evidenceDigestFor,
    evidenceDigest: context.oracle.evidenceDigest,
  };
  if (typeof context.oracle.evidenceDigestFor !== "function" && !DIGEST.test(context.oracle.evidenceDigest ?? "")) {
    fail("context.oracle.evidenceDigestFor(cell) or context.oracle.evidenceDigest is required");
  }
  const createdAt = requirePath(context, ["createdAt"]);
  const sourceHead = requirePath(context, ["sourceHead"]);
  if (typeof createdAt !== "string" && typeof createdAt !== "function") fail("context.createdAt must be a string or a function of the cell");
  if (typeof sourceHead !== "string" && typeof sourceHead !== "function") fail("context.sourceHead must be a string or a function of the cell");
  if (typeof createdAt === "string" && !Number.isFinite(Date.parse(createdAt))) fail("context.createdAt string is not an ISO timestamp");
  if (typeof sourceHead === "string" && !HEAD.test(sourceHead)) fail("context.sourceHead string is not a 7-64 char hex commit");
  if (producer.id === executor.id) fail("producer.id and executor.id must differ (the validator rejects self-produced trials)");
  if (oracle.verifierId === producer.id || oracle.verifierId === executor.id) {
    fail("oracle.verifierId must differ from producer.id and executor.id");
  }
  return { producer, executor, harness, oracle, createdAt, sourceHead, taskVersion: context.taskVersion ?? 1, goalRevision: context.goalRevision ?? "1" };
}

const evidenceFor = (context, cell) => {
  const value = typeof context.oracle.evidenceDigestFor === "function" ? context.oracle.evidenceDigestFor(cell) : context.oracle.evidenceDigest;
  if (!DIGEST.test(value ?? "")) fail(`oracle evidence digest for ${cell.taskId}/${cell.condition}/r${cell.repeat} is not a 64-char hex digest`);
  return value;
};

const trialIdFor = (cell) => {
  const raw = `${cell.stage}.${cell.condition}.${cell.taskId}.r${cell.repeat}`;
  return raw.length <= TRIAL_ID_MAX ? raw : `jexp.${sha256(raw).slice(0, 32)}`;
};

const createdAtFor = (context, cell) => {
  const value = pick(context.createdAt, cell);
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) fail(`createdAt for ${cell.taskId} is not an ISO timestamp`);
  return value;
};

const sourceHeadFor = (context, cell) => {
  const value = pick(context.sourceHead, cell);
  if (typeof value !== "string" || !HEAD.test(value)) fail(`sourceHead for ${cell.taskId} is not a 7-64 char hex commit`);
  return value;
};

/** Cost block: settled ledger value, else the reservation cap; never a silent zero. */
export function costFor(cell) {
  const settled = finiteOrNull(cell.sessionUsd);
  const reserved = finiteOrNull(cell.reservedUsd);
  const usd = settled ?? reserved;
  if (usd === null) fail(`cell ${cell.taskId}/${cell.condition}/r${cell.repeat} has neither a settled nor a reserved cost`);
  if (usd < 0) fail(`cell ${cell.taskId}/${cell.condition}/r${cell.repeat} has a negative cost ${usd}`);
  const cost = {
    measured: true,
    wallMs: finiteOrNull(cell.wallMs) ?? 0,
    inputTokens: countOrZero(cell.inputTokens),
    outputTokens: countOrZero(cell.outputTokens),
    usd,
  };
  if (cost.wallMs === 0 && cost.inputTokens === 0 && cost.outputTokens === 0 && cost.usd === 0) cost.zeroCostRationale = RATIONALE;
  return cost;
}

/** One cell record -> one validated `gjc.quality_trial.v2` payload. */
export function buildReceipt(cell, context) {
  if (!isObject(cell)) fail("cell record must be an object");
  if (!STAGES.includes(cell.stage)) fail(`cell stage must be one of ${STAGES.join("|")}, got ${JSON.stringify(cell.stage)}`);
  if (typeof cell.taskId !== "string" || cell.taskId.length === 0) fail("cell taskId must be a non-empty string");
  if (!Number.isSafeInteger(cell.repeat) || cell.repeat < 1) fail(`cell ${cell.taskId} needs a positive integer repeat`);
  const split = SPLIT_MAP[cell.split];
  if (!split) fail(`cell ${cell.taskId} has unknown split ${JSON.stringify(cell.split)}`);
  if (!["ok", "failed", "not_run"].includes(cell.status)) fail(`cell ${cell.taskId} has unknown status ${JSON.stringify(cell.status)}`);
  const arm = armFor(cell.condition);
  const resolved = requireContext(context);
  const success = finiteOrNull(cell.success) ?? 0;
  if (success < 0 || success > 1) fail(`cell ${cell.taskId}/${cell.condition}/r${cell.repeat} has success outside [0,1]`);
  const passed = cell.status === "ok" && success === 1;
  const evidenceDigest = evidenceFor(resolved, cell);
  const trialId = trialIdFor(cell);
  const cost = costFor(cell);
  const denominator = passed
    ? { planned: 1, passed: 1, failed: 0, error: 0, skipped: 0 }
    : { planned: 1, passed: 0, failed: 1, error: 0, skipped: 0 };
  return {
    schema: QUALITY_TRIAL_SCHEMA,
    trialId,
    taskId: cell.taskId,
    taskVersion: resolved.taskVersion,
    split,
    arm,
    repeat: cell.repeat,
    goalRevision: resolved.goalRevision,
    producer: { ...resolved.producer },
    executor: { id: resolved.executor.id, receiptId: trialId, receiptDigest: sha256(canonicalJson(cell)) },
    harness: { ...resolved.harness },
    oracle: { independentFromProducer: true, kind: resolved.oracle.kind, verifierId: resolved.oracle.verifierId, evidenceDigest },
    executionKey: executionKeyFor({
      taskId: cell.taskId,
      taskVersion: resolved.taskVersion,
      arm,
      repeat: cell.repeat,
      harnessDigest: resolved.harness.harnessDigest,
      oracleDigest: evidenceDigest,
      goalRevision: resolved.goalRevision,
    }),
    outcome: passed ? "passed" : "failed",
    denominator,
    cost,
    createdAt: createdAtFor(resolved, cell),
    sourceHead: sourceHeadFor(resolved, cell),
    // Raw fields (D7): the arm table keeps condition/stage/errorClass and the
    // measured score without widening the canonical v2 shape.
    condition: cell.condition,
    stage: cell.stage,
    errorClass: cell.errorClass ?? null,
    score: finiteOrNull(cell.score) ?? 0,
    success,
  };
}

/**
 * One receipt per executed cell. `not_run` cells are skipped and reported so
 * the caller can record `incomplete_pairs` instead of a failed attestation.
 */
export function buildReceipts(records, context, { includeNotRun = false } = {}) {
  if (!Array.isArray(records)) fail("records must be an array");
  requireContext(context);
  const receipts = [];
  const skipped = [];
  for (const cell of records) {
    if (cell?.status === "not_run" && !includeNotRun) {
      skipped.push({ taskId: cell.taskId ?? null, condition: cell.condition ?? null, repeat: cell.repeat ?? null, stage: cell.stage ?? null, reason: "not_run" });
      continue;
    }
    receipts.push(buildReceipt(cell, context));
  }
  return { receipts, skipped };
}

/**
 * Validate a batch with the canonical validator. `ok` requires zero failures and
 * zero conflicting duplicates; an identical duplicate (the winner reuse D5
 * describes) is allowed and counted. Per-record failures keep their index,
 * trialId, normalization reason and detail for the report.
 */
export function validateAll(receipts) {
  const list = Array.isArray(receipts) ? receipts : [];
  const failures = [];
  const conflicts = [];
  const trials = [];
  const admitted = new Map();
  let duplicates = 0;
  list.forEach((receipt, index) => {
    const checked = validateQualityTrial(receipt);
    if (!checked.ok) {
      failures.push({
        index,
        trialId: typeof receipt?.trialId === "string" ? receipt.trialId : null,
        taskId: typeof receipt?.taskId === "string" ? receipt.taskId : null,
        reason: checked.reason,
        detail: checked.detail,
      });
      return;
    }
    const canonical = canonicalJson(checked.trial);
    const prior = admitted.get(checked.trial.executionKey);
    if (prior === undefined) {
      admitted.set(checked.trial.executionKey, canonical);
      trials.push(checked.trial);
      return;
    }
    if (prior === canonical) duplicates += 1;
    else conflicts.push({ index, trialId: checked.trial.trialId, executionKey: checked.trial.executionKey });
  });
  return {
    ok: failures.length === 0 && conflicts.length === 0,
    total: list.length,
    valid: trials.length,
    duplicates,
    failures,
    conflicts,
    trials,
  };
}

/**
 * AC14/AC18 producer: one `gjc.quality_trial.v2` receipt per executed cell of
 * each paid stage, re-validated as a batch. Throws unless every receipt is
 * valid and no execution key conflicts, so a run can never report a cohort the
 * canonical validator rejects.
 */
export function stageReceipts({ records, manifest, readiness, stageTimes, manifestDigest }) {
  const context = {
    producer: { id: "jexp-runner", kind: "harness" },
    executor: { id: "gjc-cell-session" },
    harness: { sourceDigest: manifest.harnessDigest, harnessDigest: manifest.harnessDigest, manifestDigest, version: manifest.manifestId },
    oracle: { kind: "arm-blind-oracle", verifierId: "jexp-score-cell", evidenceDigestFor: (cell) => cell.oracleDigest },
    createdAt: (cell) => stageTimes[cell.stage],
    sourceHead: readiness.originMain,
  };
  const out = {};
  for (const stage of STAGES) {
    const { receipts, skipped } = buildReceipts(records.filter((record) => record.stage === stage), context);
    // Every treatment condition maps to arm B1, so each (condition) is its own
    // B0/B1 batch: two treatments of one task never share an execution key.
    const validation = { total: 0, valid: 0, duplicates: 0, conflictingDuplicates: 0, failures: 0 };
    for (const condition of [...new Set(receipts.map((receipt) => receipt.condition))]) {
      const checked = validateAll(receipts.filter((receipt) => receipt.condition === condition));
      if (!checked.ok) fail(`stage ${stage} ${condition} receipts invalid: failures=${checked.failures.length} conflicts=${checked.conflicts.length}`);
      validation.total += checked.total;
      validation.valid += checked.valid;
      validation.duplicates += checked.duplicates;
    }
    out[stage] = { receipts, skipped, validation };
  }
  return out;
}
