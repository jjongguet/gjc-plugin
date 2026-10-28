import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { manifestDigest, validateTrialReceipt } from "../lib/behavior-eval.mjs";
import { executionKeyFor, validateQualityTrial } from "../lib/quality-trial.mjs";
import { planCells, planRequests, taskDigestFor } from "./preflight.mjs";
import { compareDecision, digest, publicDecision } from "./pilot-oracle.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const LIMITS = Object.freeze({ requests: 21, cells: 9, inputTokens: 3000, outputTokens: 300, cellWallMs: 90000, pilotWallMs: 2400000, pilotUsd: 1, taskUsd: 5 });
const SOURCE_FILES = ["self-improve/lib/isolation-runtime.mjs", "self-improve/lib/behavior-eval.mjs", "self-improve/lib/quality-trial.mjs", "self-improve/lib/loading-receipt.mjs", "self-improve/lib/isolate.mjs", "self-improve/m1/preflight.mjs", "self-improve/m1/native-pilot.mjs", "self-improve/m1/recording-proxy.mjs", "self-improve/m1/pilot-oracle.mjs", "self-improve/m1/pilot-protocol.mjs", "self-improve/m1/run-pilot.mjs", "self-improve/m1/pilot-rule.txt", "self-improve/m1/pilot-task.json", "self-improve/tests/fixtures/pilot/manifest.json", "self-improve/tests/fixtures/pilot/oracle/decision-probability-boundary-dev10.json"];
export const sourceDigest = () => digest([...SOURCE_FILES, "self-improve/m1/probe-native.mjs"].map((file) => ({ file, digest: digest(readFileSync(path.join(ROOT, file), "utf8")) })));
export const loadJson = (file) => JSON.parse(readFileSync(file, "utf8"));

export function pilotDefinition() {
  const manifest = loadJson(path.join(ROOT, "self-improve/tests/fixtures/pilot/manifest.json"));
  const task = loadJson(path.join(ROOT, "self-improve/m1/pilot-task.json"));
  const selected = manifest.tasks.filter((item) => item.id === task.id && item.split === "development");
  if (selected.length !== 1) throw new Error("pilot_development_identity_mismatch");
  const oracle = loadJson(path.join(ROOT, selected[0].oracle.path));
  const ruleText = readFileSync(path.join(ROOT, "self-improve/m1/pilot-rule.txt"), "utf8");
  const subset = {
    schema: "harness2.m1.subset.v1", taskIds: [task.id],
    manifestDigest: manifestDigest(manifest), taskDigest: taskDigestFor(selected),
    promptInputDigest: digest(task), oracleDigest: digest(oracle),
    ruleContentDigest: digest(ruleText), provenanceDigest: digest(oracle.provenance),
    bundleSourceDigest: sourceDigest(),
  };
  const cells = planCells({ manifest, subset, repeats: 3 });
  const requests = planRequests({ cells: cells.cells });
  if (cells.error || requests.error || cells.count !== 9 || requests.count !== 21) throw new Error("pilot_plan_mismatch");
  return { manifest, task, oracle, ruleText, subset, cells: cells.cells, requests: requests.requests };
}

export function pilotInputs() {
  const inputs = pilotDefinition();
  const pin = loadJson(path.join(ROOT, "self-improve/m1/pilot-subset.json"));
  if (digest(pin) !== digest(inputs.subset)) throw new Error("pilot_subset_pin_stale");
  return inputs;
}

/** Selection has no oracle argument and never consults semantic correctness. */
export function selectPublic(attempts) {
  const successful = attempts.filter((attempt) => attempt.status === "ok");
  return successful.find((attempt) => publicDecision(attempt.output).valid) ?? null;
}

export function checkLiveEvidence({ budget, pricing, nativeProof, sharedDelivery, currentSourceDigest, now = Date.now() }) {
  const fail = (code) => { throw new Error(code); };
  if (!budget || budget.capUsd !== 1 || budget.taskCapUsd !== 5 || budget.maxCalls !== 21) fail("budget_contract_mismatch");
  for (const field of ["priorSpentUsd", "priorReservedUsd", "priorUnresolvedUsd", "cleanupUsd"]) if (typeof budget[field] !== "number" || !Number.isFinite(budget[field]) || budget[field] < 0) fail("prior_cost_unknown");
  if (budget.priorPilotCalls !== 0 || budget.priorPilotSpentUsd !== 0 || budget.priorPilotReservedUsd !== 0 || budget.priorPilotUnresolvedUsd !== 0) fail("pilot_prior_execution_or_unknown");
  if (budget.priorUnresolvedUsd !== 0 || budget.accountingStatus !== "reconciled" || !/^[a-f0-9]{64}$/.test(budget.accountingEvidenceDigest ?? "")) fail("prior_cost_unreconciled");
  const age = now - Date.parse(pricing?.observedAt);
  if (!Number.isFinite(age) || age < 0 || age > 86400000 || pricing?.source !== "https://openrouter.ai/api/v1/models/openai/gpt-4.1-mini/endpoints" || pricing.model !== "openai/gpt-4.1-mini" || pricing.provider !== "OpenAI") fail("pricing_unverified");
  for (const field of ["inputPrice", "outputPrice"]) if (!Number.isFinite(pricing[field]) || pricing[field] <= 0) fail("pricing_unverified");
  const ceiling = 21 * (3000 * pricing.inputPrice + 300 * pricing.outputPrice) + budget.cleanupUsd;
  if (ceiling > 1 || ceiling + budget.priorSpentUsd + budget.priorReservedUsd > 5) fail("aggregate_budget_exceeded");
  if (nativeProof?.passed !== true || nativeProof.sourceDigest !== currentSourceDigest || nativeProof.results?.length !== 3 || !nativeProof.results.every((r, index) => r.arm === ["B0", "B1", "B2"][index] && r.isolation?.status === "pass" && r.native?.code === 0 && r.requests?.length === 1 && r.requests[0].status === "ok" && r.requests[0].rulePresent === (r.arm === "B2"))) fail("native_proof_stale_or_missing");
  if (sharedDelivery?.status !== "verified" || !/^[a-f0-9]{40}$/.test(sharedDelivery.mainSha ?? "") || !/^v\d+\.\d+\.\d+$/.test(sharedDelivery.tag ?? "") || !/^[a-f0-9]{64}$/.test(sharedDelivery.installedSurfaceDigest ?? "") || typeof sharedDelivery.freshUserSession?.id !== "string" || !/^[a-f0-9]{64}$/.test(sharedDelivery.freshUserSession?.projectionDigest ?? "") || sharedDelivery.freshUserSession?.coverageStatus !== "verified") fail("shared_delivery_not_verified");
  return { ceilingUsd: ceiling, pricingDigest: digest(pricing), accountingDigest: digest(budget), nativeProofDigest: digest(nativeProof), sharedDeliveryDigest: digest(sharedDelivery) };
}

export function cellReceipt({ cell, attempts, inputs, loading, isolation, sourceHead, source, harnessDigest, wallMs, mode, executionError = null }) {
  const selected = selectPublic(attempts);
  const complete = attempts.every((attempt) => attempt.status === "ok");
  // Hidden semantics are consulted only after all candidates and public selection are fixed.
  const judged = selected ? compareDecision(selected.output, inputs.oracle) : null;
  const outcome = executionError ? "error" : complete ? judged?.passed ? "passed" : "failed" : attempts.some((attempt) => attempt.status === "error") ? "error" : "skipped";
  const receiptDigest = digest(attempts);
  const oracleEvidence = judged?.evidenceDigest ?? digest({ oracleDigest: digest(inputs.oracle), selected: null });
  const measured = mode === "live" && attempts.every((attempt) => attempt.usage && Number.isFinite(attempt.usage.usd));
  const cost = { measured, wallMs, inputTokens: attempts.reduce((n, a) => n + (a.usage?.input ?? 0), 0), outputTokens: attempts.reduce((n, a) => n + (a.usage?.output ?? 0), 0), usd: measured ? attempts.reduce((n, a) => n + a.usage.usd, 0) : null };
  const record = {
    schema: "gjc.quality_trial.v2", trialId: `${cell.arm}-r${cell.repeat}`, taskId: cell.taskId, taskVersion: "1", split: "development", arm: cell.arm, repeat: cell.repeat, goalRevision: "1",
    producer: { id: "jjo945-frozen-protocol", kind: "consensus-reviewed-harness" },
    executor: { id: "native-gjc-isolated-child", receiptId: `${cell.arm}-r${cell.repeat}`, receiptDigest },
    harness: { sourceDigest: source, harnessDigest, manifestDigest: inputs.subset.manifestDigest, version: "m1-pilot-v1" },
    oracle: { independent: true, independentFromProducer: true, kind: "json-decision", verifierId: "parent-only-json-decision-v1", evidenceDigest: oracleEvidence },
    outcome, denominator: { planned: 1, passed: Number(outcome === "passed"), failed: Number(outcome === "failed"), error: Number(outcome === "error"), skipped: Number(outcome === "skipped") },
    cost, sourceHead, createdAt: new Date().toISOString(), selectedSlot: selected?.slotId ?? null, executionError,
    loadingReceipt: loading, isolation: { denyProbesPassed: isolation?.status === "pass", profileDigest: isolation?.profileDigest ?? null },
    budget: { admitted: mode === "live" && complete && !executionError }, holdout: { usedEarly: false }, outcomes: [outcome],
  };
  record.executionKey = executionKeyFor({ ...record, harnessDigest, oracleDigest: oracleEvidence });
  record.evalid = validateTrialReceipt(record);
  record.quality = validateQualityTrial(record);
  return record;
}
