import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestDigest } from "../../lib/behavior-eval.mjs";
import {
  ARM_ATTEMPTS,
  manifestDigestFor,
  planBudget,
  planCells,
  planRequests,
  preflight,
  resolveLive,
  resolveOracle,
  taskDigestFor,
  validateSubset,
} from "../../m1/preflight.mjs";

const SELF_IMPROVE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(SELF_IMPROVE, "tests/fixtures/pilot/manifest.json"), "utf8"));
const budget = {
  capUsd: 1,
  pricePer1kInputUsd: 0.15,
  pricePer1kOutputUsd: 0.6,
  maxInputTokensPerCall: 2000,
  maxOutputTokensPerCall: 400,
  maxWallMs: 60_000,
  cleanupUsd: 0,
};
// 0.01 USD per call exactly, so every projection below is arithmetic and not a
// rounding guess.
const cheap = {
  capUsd: 1,
  pricePer1kInputUsd: 0.005,
  pricePer1kOutputUsd: 0,
  maxInputTokensPerCall: 2000,
  maxOutputTokensPerCall: 0,
  maxWallMs: 60_000,
  cleanupUsd: 0,
};
const isolation = { runtime: "sandbox-exec-seatbelt.v1", status: "pass", allowlist: { mode: "deny-all", hosts: [] }, profileDigestNormalized: "a".repeat(64), probes: [{ id: "write_outside_mount_denied", passed: true }] };
const loading = { loaded: true, sha256: "b".repeat(64), failures: [] };

const DEV_TASK_ID = "artifact-valid";
const devTask = manifest.tasks.find((task) => task.id === DEV_TASK_ID);
const holdoutId = manifest.tasks.find((task) => task.split === "holdout").id;
const subsetFor = (overrides = {}) => ({
  schema: "harness2.m1.subset.v1",
  taskIds: [DEV_TASK_ID],
  manifestDigest: manifestDigestFor(manifest),
  taskDigest: taskDigestFor([devTask]),
  ...overrides,
});

test("cells are development-only and the holdout stays untouched", () => {
  const planned = planCells({ manifest, repeats: 3 });
  assert.equal(planned.count, 4 * 3 * 3);
  assert.equal(planned.subset.provided, false);
  assert.deepEqual(new Set(planned.cells.map((cell) => cell.split)), new Set(["development"]));
  assert.equal(planned.holdoutTasks.length, 3);
  assert.deepEqual(planned.cells.filter((cell) => cell.taskId === planned.cells[0].taskId).map((cell) => cell.arm), ["B0", "B0", "B0", "B1", "B1", "B1", "B2", "B2", "B2"]);
  assert.equal(planCells({ manifest, repeats: 9 }).error, "invalid_repeats");
  assert.equal(planCells({ manifest, arms: ["B0", "B9"] }).error, "unknown_arm");
});

test("a validated subset selects one development case: 9 cells, 21 request slots", () => {
  const planned = planCells({ manifest, subset: subsetFor(), repeats: 3 });
  assert.equal(planned.error, null);
  assert.equal(planned.count, 9);
  assert.equal(planned.subset.provided, true);
  assert.deepEqual(planned.subset.taskIds, [DEV_TASK_ID]);
  assert.deepEqual(new Set(planned.cells.map((cell) => cell.taskId)), new Set([DEV_TASK_ID]));
  assert.deepEqual(new Set(planned.cells.map((cell) => cell.split)), new Set(["development"]));

  const plan = planRequests({ cells: planned.cells });
  assert.equal(plan.error, null);
  assert.equal(plan.count, 21);
  assert.equal(plan.requests.filter((request) => request.arm === "B0").length, 3);
  assert.equal(plan.requests.filter((request) => request.arm === "B1").length, 9);
  assert.equal(plan.requests.filter((request) => request.arm === "B2").length, 9);
  // B1 and B2 spend the same three calls on one cell.
  assert.equal(ARM_ATTEMPTS.B1, 3);
  assert.equal(ARM_ATTEMPTS.B2, 3);
  const perCell = new Map();
  for (const request of plan.requests) perCell.set(request.cellId, (perCell.get(request.cellId) ?? 0) + 1);
  assert.equal(perCell.size, 9);
  assert.equal(new Set(plan.requests.map((request) => request.slotId)).size, 21, "slot ids are unique");
  for (const request of plan.requests) {
    assert.equal(typeof request.slotId, "string");
    assert.equal(typeof request.cellId, "string");
    assert.equal(request.taskId, DEV_TASK_ID);
    assert.equal(request.split, "development");
    assert.ok(["B0", "B1", "B2"].includes(request.arm));
    assert.ok([1, 2, 3].includes(request.repeat));
    assert.ok([1, 2, 3].includes(request.attempt));
  }
  assert.equal(new Set(plan.requests.filter((request) => request.arm === "B0").map((request) => request.cellId)).size, 3);
});

test("the four-task development dry plan has 36 cells and 84 requests", () => {
  const planned = planCells({ manifest, repeats: 3 });
  const plan = planRequests({ cells: planned.cells });
  assert.equal(plan.count, 84);
  assert.equal(plan.requests.filter((request) => request.arm === "B0").length, 12);
  assert.equal(plan.requests.filter((request) => request.arm === "B1").length, 36);
  assert.equal(plan.requests.filter((request) => request.arm === "B2").length, 36);
});

test("the manifest pin is the canonical manifest digest, never a stripped variant", () => {
  assert.equal(manifestDigestFor(manifest), manifestDigest(manifest));
  assert.equal(manifestDigestFor(manifest), manifestDigestFor({ ...manifest }));
  assert.equal(manifestDigestFor(null), null);
  assert.equal(taskDigestFor([devTask]), manifestDigest([devTask]));
  assert.equal(taskDigestFor(devTask), manifestDigest([devTask]));
});

test("subset validation refuses wrong digests, bad schemas and bad ids", () => {
  const valid = validateSubset({ manifest, subset: subsetFor() });
  assert.equal(valid.ok, true);
  assert.deepEqual(valid.blockers, []);
  assert.equal(valid.identity.taskCount, 1);
  assert.equal(valid.identity.taskDigestCanonical, taskDigestFor([devTask]));

  const cases = [
    [subsetFor({ manifestDigest: "c".repeat(64) }), "subset_manifest_digest_mismatch"],
    [subsetFor({ manifestDigest: "not-a-digest" }), "subset_invalid"],
    [subsetFor({ taskDigest: "d".repeat(64) }), "subset_task_digest_mismatch"],
    [subsetFor({ taskIds: [DEV_TASK_ID, DEV_TASK_ID] }), "subset_duplicate_task"],
    [subsetFor({ taskIds: ["no-such-task"] }), "subset_undeclared_task"],
    [subsetFor({ taskIds: [holdoutId] }), "subset_holdout_task"],
    [subsetFor({ taskIds: [] }), "subset_empty"],
    [subsetFor({ taskIds: [""] }), "subset_empty"],
    [subsetFor({ schema: "harness2.m1.subset.v0" }), "subset_invalid"],
  ];
  for (const [subset, code] of cases) {
    const result = validateSubset({ manifest, subset });
    assert.equal(result.ok, false, code);
    assert.ok(result.blockers.some((blocker) => blocker.code === code), `${code}: ${JSON.stringify(result.blockers)}`);
    const planned = planCells({ manifest, subset, repeats: 3 });
    assert.equal(planned.error, "subset_invalid");
    assert.deepEqual(planned.cells, []);
    assert.equal(planned.count, 0);
    // A refused subset never selects a task, so no oracle payload is reachable.
    assert.deepEqual(planned.subsetTasks, []);
  }
  // Duplicates are named before the id is resolved, and a holdout id never
  // becomes a cell.
  const holdout = planCells({ manifest, subset: subsetFor({ taskIds: [holdoutId] }), repeats: 3 });
  assert.deepEqual(holdout.cells, []);
  assert.equal(holdout.subset.taskIds.length, 1);
});

test("budget accumulation blocks the plan total, not just each cell", () => {
  const cells = Array.from({ length: 6 }, (_, index) => ({ taskId: `t${index}`, arm: "B0", repeat: 1 }));
  const spend = planBudget({ budget: { ...budget, capUsd: 0.05, pricePer1kInputUsd: 0.005, pricePer1kOutputUsd: 0, maxInputTokensPerCall: 2000, maxOutputTokensPerCall: 0, cleanupUsd: 0 }, cells });
  // per call = 0.01; each cell projects +0.01, so cell 6 would cross the 0.05 cap.
  assert.equal(spend.perCallUsd, 0.01);
  assert.equal(spend.refused, "cap_exceeded");
  assert.equal(spend.admitted, false);
  assert.ok(spend.projected <= 0.05 + 1e-9);
  assert.equal(spend.cells.filter((row) => row.allowed).length, 5);
  assert.ok(spend.cells.slice(5).every((row) => row.reason === "cap_exceeded"));
  assert.equal(spend.requestCount, 6);
});

test("the request budget, not the cell count, is what maxCalls admits", () => {
  const cells = planCells({ manifest, subset: subsetFor(), repeats: 3 }).cells;
  assert.equal(cells.length, 9);

  const capped20 = planBudget({ budget: { ...cheap, capUsd: 10, maxCalls: 20 }, cells });
  assert.equal(capped20.requestCount, 21);
  assert.equal(capped20.refused, "call_cap_exceeded");
  assert.equal(capped20.requests.filter((row) => row.allowed).length, 20);
  assert.equal(capped20.admitted, false);

  const capped21 = planBudget({ budget: { ...cheap, capUsd: 10, maxCalls: 21 }, cells });
  assert.equal(capped21.requestCount, 21);
  assert.equal(capped21.refused, null);
  assert.equal(capped21.admitted, true);
  assert.equal(capped21.cells.length, 9);
  assert.equal(capped21.cells.find((row) => row.arm === "B1").requests, 3);

  // Nine admitted calls are a per-cell undercount: nine cells with three-call
  // arms must never be budgeted as nine requests.
  const perCellOnly = planBudget({ budget: { ...cheap, capUsd: 10, maxCalls: 9 }, cells });
  assert.equal(perCellOnly.requestCount, 21);
  assert.equal(perCellOnly.refused, "call_cap_exceeded");

  const invalid = planBudget({ budget: { ...cheap, capUsd: 10, maxCalls: "abc" }, cells });
  assert.equal(invalid.refused, "invalid_max_calls");
  assert.equal(invalid.admitted, false);
});

test("admission counts prior spend, reservations, unresolved charges and cleanup", () => {
  const cells = planCells({ manifest, subset: subsetFor(), repeats: 3 }).cells;
  const baseline = planBudget({ budget: cheap, cells });
  assert.equal(baseline.admitted, true);
  assert.equal(baseline.requestCount, 21);

  for (const [field, value] of [["spentUsd", 1], ["reservedUsd", 1], ["unresolvedUsd", 1], ["cleanupUsd", 1]]) {
    const spend = planBudget({ budget: { ...cheap, [field]: value }, cells });
    assert.equal(spend.refused, "cap_exceeded", field);
    assert.equal(spend.requests.filter((row) => row.allowed).length, 0, field);
    assert.equal(spend.committedUsd, value, field);
  }
  const withPrior = planBudget({ budget: { ...cheap, spentUsd: 0.9 }, cells });
  assert.equal(withPrior.refused, "cap_exceeded");
  assert.ok(withPrior.requests.filter((row) => row.allowed).length > 0);
  assert.ok(withPrior.requests.filter((row) => row.allowed).length < 21);
  assert.ok(withPrior.projected <= 1);
});

test("missing, NaN and negative price bounds are refused, never coerced to zero", () => {
  const cells = planCells({ manifest, subset: subsetFor(), repeats: 3 }).cells;
  const missing = planBudget({ budget: { capUsd: 1, pricePer1kInputUsd: 0.005, pricePer1kOutputUsd: 0, maxInputTokensPerCall: 2000 }, cells });
  assert.equal(missing.refused, "price_bounds_missing");
  assert.equal(missing.perCallUsd, null);
  assert.equal(missing.admitted, false);

  const notANumber = planBudget({ budget: { ...cheap, maxOutputTokensPerCall: Number.NaN }, cells });
  assert.equal(notANumber.refused, "price_bounds_invalid");

  const negative = planBudget({ budget: { ...cheap, pricePer1kInputUsd: -0.001 }, cells });
  assert.equal(negative.refused, "price_bounds_invalid");
  assert.equal(negative.admitted, false);

  const noCap = planBudget({ budget: { ...cheap, capUsd: undefined }, cells });
  assert.equal(noCap.refused, "missing_cap");

  const badUsage = planBudget({ budget: { ...cheap, spentUsd: -1 }, cells });
  assert.equal(badUsage.refused, "usage_invalid");
  const junkUsage = planBudget({ budget: { ...cheap, unresolvedUsd: "soon" }, cells });
  assert.equal(junkUsage.refused, "usage_invalid");
});

test("the frozen fixture reports unimplemented oracles and missing prompts, never oracle_unresolved", () => {
  const oracle = resolveOracle({ manifest });
  assert.equal(oracle.counts.oracle_unresolved, undefined);
  assert.equal(oracle.counts.oracle_kind_unimplemented, 7);
  assert.equal(oracle.counts.prompt_missing, 6);
  assert.equal(oracle.resolved, 0);
});

test("an injected comparator with prompts flips the oracle blockers to zero", () => {
  const injected = {
    ...manifest,
    tasks: manifest.tasks.map((task) => ({ ...task, prompt: "run the check" })),
  };
  const oracle = resolveOracle({ manifest: injected, comparators: { "json-expectation": () => true, "json-decision": () => true } });
  assert.deepEqual(oracle.blockers, []);
  assert.equal(oracle.resolved, 7);
});

test("the call cap is enforced and an invalid cap fails closed", () => {
  const cells = Array.from({ length: 4 }, (_, index) => ({ taskId: `c${index}`, arm: "B0", repeat: 1 }));
  const capped = planBudget({ budget: { ...budget, capUsd: 10, maxCalls: 3 }, cells });
  assert.equal(capped.refused, "call_cap_exceeded");
  assert.equal(capped.cells.filter((row) => row.allowed).length, 3);
  assert.ok(capped.cells.slice(3).every((row) => row.reason === "call_cap_exceeded"));
  const invalid = planBudget({ budget: { ...budget, capUsd: 10, maxCalls: "abc" }, cells });
  assert.equal(invalid.refused, "invalid_max_calls");
  assert.equal(invalid.admitted, false);
});

test("the five live refusal cases are exhaustive", () => {
  assert.deepEqual(resolveLive({ live: false }), { status: "skipped", code: "live_not_approved", exit: 0 });
  assert.deepEqual(resolveLive({ live: false, approveLive: 1 }), { status: "refused", code: "live_approval_without_live", exit: 2 });
  assert.equal(resolveLive({ live: true, approveLive: null }).code, "live_approval_invalid");
  assert.equal(resolveLive({ live: true, approveLive: 2, budget: { capUsd: 1 } }).code, "live_cap_exceeds_declared");
  assert.equal(resolveLive({ live: true, approveLive: 1, budget: { capUsd: 2 }, executorAvailable: false }).code, "live_executor_absent");
});

test("live approval demands isolation and loading evidence; a dry run stays honest", () => {
  const approvedWithoutEvidence = preflight({ manifest, subset: subsetFor(), budget: cheap, live: true, approveLive: 0.5, executorAvailable: true });
  assert.equal(approvedWithoutEvidence.live.status, "approved");
  assert.equal(approvedWithoutEvidence.dryRun, false);
  assert.ok(approvedWithoutEvidence.blockerCounts.isolation_not_proven >= 1);
  assert.ok(approvedWithoutEvidence.blockerCounts.loading_not_proven >= 1);

  const failedEvidence = preflight({
    manifest,
    subset: subsetFor(),
    budget: cheap,
    live: true,
    approveLive: 0.5,
    executorAvailable: true,
    isolation: { status: "unavailable", reason: "no_enforceable_runtime", probes: [] },
    loading: { loaded: false, failures: ["gjc_unavailable"] },
  });
  assert.equal(failedEvidence.live.status, "approved");
  assert.ok(failedEvidence.blockerCounts.isolation_not_proven >= 1);
  assert.ok(failedEvidence.blockerCounts.loading_not_proven >= 1);

  const approvedWithEvidence = preflight({ manifest, subset: subsetFor(), budget: cheap, live: true, approveLive: 0.5, executorAvailable: true, isolation, loading });
  assert.equal(approvedWithEvidence.live.status, "approved");
  assert.equal(approvedWithEvidence.dryRun, false);
  assert.equal(approvedWithEvidence.blockerCounts.isolation_not_proven, undefined);
  assert.equal(approvedWithEvidence.blockerCounts.loading_not_proven, undefined);

  const dry = preflight({ manifest, subset: subsetFor(), budget: cheap });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.isolation.status, "unavailable");
  assert.equal(dry.loading.loaded, false);
  assert.equal(dry.blockerCounts.isolation_not_proven, undefined);
  assert.equal(dry.blockerCounts.loading_not_proven, undefined);
});

test("the preflight is deterministic, counts requests and names its subset", () => {
  const subset = subsetFor();
  const first = preflight({ manifest, subset, budget: cheap, isolation, loading });
  const second = preflight({ manifest, subset, budget: cheap, isolation, loading });
  assert.equal(first.digest, second.digest);
  assert.equal(first.dryRun, true);
  assert.equal(first.cellCount, 9);
  assert.equal(first.requestCount, 21);
  assert.equal(first.requests.length, 21);
  assert.equal(first.manifest.digest, manifestDigest(manifest));
  assert.equal(first.subset.provided, true);
  assert.deepEqual(first.subset.taskIds, [DEV_TASK_ID]);
  assert.equal(first.subset.manifestDigest, manifestDigest(manifest));
  assert.equal(first.subset.taskDigest, taskDigestFor([devTask]));
  assert.equal(first.blockerCounts.budget_refused, undefined);
  assert.equal(first.budget.admitted, true);
  assert.equal(first.blockerCounts.oracle_kind_unimplemented, 1);
  assert.equal(first.blockerCounts.prompt_missing, 1);
  assert.equal(first.live.code, "live_not_approved");
  assert.equal(first.manifest.holdoutUsedEarly, false);
  assert.equal(first.manifest.holdout.length, 3);

  const full = preflight({ manifest, budget: cheap, isolation, loading });
  assert.equal(full.cellCount, 36);
  assert.equal(full.requestCount, 84);
  assert.equal(full.subset.provided, false);

  const badSubset = preflight({ manifest, subset: subsetFor({ manifestDigest: "e".repeat(64) }), budget: cheap, isolation, loading });
  assert.equal(badSubset.cellCount, 0);
  assert.equal(badSubset.requestCount, 0);
  assert.ok(badSubset.blockerCounts.subset_manifest_digest_mismatch >= 1);
  assert.ok(badSubset.blockerCounts.subset_invalid >= 1);

  const broken = preflight({ manifest: { tasks: [] }, budget, isolation: { status: "unavailable", reason: "no_enforceable_runtime", probes: [] }, loading: { loaded: false, failures: ["gjc_unavailable"] } });
  assert.ok(broken.blockerCounts.manifest_invalid >= 1);
  assert.ok(broken.blockerCounts.isolation_not_proven >= 1);
  assert.ok(broken.blockerCounts.loading_not_proven >= 1);
  assert.equal(broken.dryRun, true);
});
