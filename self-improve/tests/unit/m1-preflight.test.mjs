import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planBudget, planCells, preflight, resolveLive, resolveOracle } from "../../m1/preflight.mjs";

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
const isolation = { runtime: "sandbox-exec-seatbelt.v1", status: "pass", allowlist: { mode: "deny-all", hosts: [] }, profileDigestNormalized: "a".repeat(64), probes: [{ id: "write_outside_mount_denied", passed: true }] };
const loading = { loaded: true, sha256: "b".repeat(64), failures: [] };

test("cells are development-only and the holdout stays untouched", () => {
  const planned = planCells({ manifest, repeats: 3 });
  assert.equal(planned.count, 3 * 3 * 3);
  assert.deepEqual(new Set(planned.cells.map((cell) => cell.split)), new Set(["development"]));
  assert.equal(planned.holdoutTasks.length, 3);
  assert.deepEqual(planned.cells.filter((cell) => cell.taskId === planned.cells[0].taskId).map((cell) => cell.arm), ["B0", "B0", "B0", "B1", "B1", "B1", "B2", "B2", "B2"]);
  assert.equal(planCells({ manifest, repeats: 9 }).error, "invalid_repeats");
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
});

test("the frozen fixture reports unimplemented oracles and missing prompts, never oracle_unresolved", () => {
  const oracle = resolveOracle({ manifest });
  assert.equal(oracle.counts.oracle_unresolved, undefined);
  assert.equal(oracle.counts.oracle_kind_unimplemented, 6);
  assert.equal(oracle.counts.prompt_missing, 6);
  assert.equal(oracle.resolved, 0);
});

test("an injected comparator with prompts flips the oracle blockers to zero", () => {
  const injected = {
    ...manifest,
    tasks: manifest.tasks.map((task) => ({ ...task, prompt: "run the check" })),
  };
  const oracle = resolveOracle({ manifest: injected, comparators: { "json-expectation": () => true } });
  assert.deepEqual(oracle.blockers, []);
  assert.equal(oracle.resolved, 6);
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

test("the preflight is deterministic and exposes every blocker it can name", () => {
  const first = preflight({ manifest, budget, isolation, loading });
  const second = preflight({ manifest, budget, isolation, loading });
  assert.equal(first.digest, second.digest);
  assert.equal(first.dryRun, true);
  assert.equal(first.cellCount, 27);
  assert.equal(first.blockerCounts.oracle_kind_unimplemented, 6);
  assert.equal(first.blockerCounts.prompt_missing, 6);
  assert.equal(first.live.code, "live_not_approved");
  assert.equal(first.manifest.holdoutUsedEarly, false);

  const broken = preflight({ manifest: { tasks: [] }, budget, isolation: { status: "unavailable", reason: "no_enforceable_runtime", probes: [] }, loading: { loaded: false, failures: ["gjc_unavailable"] } });
  assert.ok(broken.blockerCounts.manifest_invalid >= 1);
  assert.ok(broken.blockerCounts.isolation_not_proven >= 1);
  assert.ok(broken.blockerCounts.loading_not_proven >= 1);
  assert.equal(broken.dryRun, true);
});
