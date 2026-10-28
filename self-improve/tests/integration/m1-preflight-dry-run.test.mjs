import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { manifestDigestFor, taskDigestFor } from "../../m1/preflight.mjs";

const SELF_IMPROVE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(SELF_IMPROVE, "m1", "run-preflight.mjs");
const MANIFEST = join(SELF_IMPROVE, "tests", "fixtures", "pilot", "manifest.json");
const BUDGET = join(SELF_IMPROVE, "m1", "budget.example.json");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
const budgetDoc = JSON.parse(readFileSync(BUDGET, "utf8"));
const DEV_TASK_ID = manifest.tasks.find((task) => task.split === "development").id;
const devTask = manifest.tasks.find((task) => task.id === DEV_TASK_ID);
const subsetDoc = (overrides = {}) => ({
  schema: "harness2.m1.subset.v1",
  taskIds: [DEV_TASK_ID],
  manifestDigest: manifestDigestFor(manifest),
  taskDigest: taskDigestFor([devTask]),
  ...overrides,
});

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
const readPlan = (dir) => JSON.parse(readFileSync(path.join(dir, "plan.json"), "utf8"));

test("the dry run names every blocker, plans development cells and requests, and makes no model call", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "harness2-preflight-dry-"));
  try {
    const result = run(["--dry-run", "--manifest", MANIFEST, "--budget", BUDGET, "--out", out, "--json"]);
    assert.equal(result.status, 1, result.stderr);
    const plan = readPlan(out);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.cellCount, 36);
    assert.equal(plan.requestCount, 84);
    assert.equal(plan.manifest.holdout.length, 3);
    assert.equal(plan.manifest.holdoutUsedEarly, false);
    assert.equal(plan.manifest.digest, manifestDigestFor(manifest), "the manifest is forwarded unchanged and pinned by its canonical digest");
    assert.equal(plan.subset.provided, false);
    assert.equal(plan.blockerCounts.oracle_kind_unimplemented, 7);
    assert.equal(plan.blockerCounts.prompt_missing, 6);
    assert.equal(plan.blockerCounts.oracle_unresolved, undefined);
    assert.equal(plan.live.code, "live_not_approved");
    // B1 and B2 spend three requests on the same cell, so a budget declared in
    // cells under-counts. The CLI must report the request truth either way.
    assert.equal(plan.budget.requestCount, plan.requestCount);
    assert.equal(budgetDoc.maxCalls, 84);
    assert.equal(plan.budget.refused, null);
    assert.equal(plan.budget.requests.filter((row) => row.allowed).length, 84);
    // Isolation and loading depend on the host (seatbelt, an installed gjc and
    // the expected plugin). The plan stays deterministic; the proof must be
    // internally consistent either way, never a fabricated pass on CI.
    assert.ok(["pass", "fail", "unavailable"].includes(plan.isolation.status), plan.isolation.status);
    if (plan.isolation.status === "pass") assert.match(plan.isolation.profileDigestNormalized, /^[a-f0-9]{64}$/);
    assert.equal(typeof plan.loading.loaded, "boolean");
    if (plan.loading.loaded === true) assert.deepEqual(plan.loading.failures, []);
    else assert.ok(plan.loading.failures.length > 0, "an unloaded receipt names its failures");

    const second = mkdtempSync(path.join(os.tmpdir(), "harness2-preflight-dry2-"));
    try {
      assert.equal(run(["--dry-run", "--manifest", MANIFEST, "--budget", BUDGET, "--out", second, "--json"]).status, 1);
      assert.equal(readFileSync(path.join(out, "plan.json"), "utf8"), readFileSync(path.join(second, "plan.json"), "utf8"), "the dry-run JSON is byte-stable");
    } finally {
      rmSync(second, { recursive: true, force: true });
    }
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("--subset pins one development case and the plan becomes 9 cells / 21 requests", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "harness2-preflight-subset-"));
  try {
    const subsetPath = path.join(root, "subset.json");
    writeFileSync(subsetPath, `${JSON.stringify(subsetDoc(), null, 2)}\n`);
    const out = path.join(root, "out");
    const result = run(["--dry-run", "--manifest", MANIFEST, "--budget", BUDGET, "--subset", subsetPath, "--out", out, "--json"]);
    // The frozen fixture still has unimplemented oracles, so the dry run reports
    // blockers and exits 1; the subset itself must not add any.
    assert.equal(result.status, 1, result.stderr);
    const plan = readPlan(out);
    assert.equal(plan.subset.provided, true);
    assert.deepEqual(plan.subset.taskIds, [DEV_TASK_ID]);
    assert.equal(plan.subset.manifestDigest, manifestDigestFor(manifest));
    assert.equal(plan.cellCount, 9);
    assert.equal(plan.requestCount, 21);
    assert.equal(plan.requests.length, 21);
    assert.deepEqual(new Set(plan.cells.map((cell) => cell.taskId)), new Set([DEV_TASK_ID]));
    assert.equal(plan.blockerCounts.subset_invalid, undefined);
    assert.equal(plan.blockerCounts.subset_manifest_digest_mismatch, undefined);
    assert.equal(plan.blockerCounts.subset_task_digest_mismatch, undefined);
    assert.equal(plan.blockerCounts.subset_holdout_task, undefined);
    assert.equal(plan.manifest.holdout.length, 3);

    const mismatched = path.join(root, "mismatched.json");
    writeFileSync(mismatched, `${JSON.stringify(subsetDoc({ manifestDigest: "f".repeat(64) }), null, 2)}\n`);
    const mismatchOut = path.join(root, "mismatch-out");
    assert.equal(run(["--dry-run", "--manifest", MANIFEST, "--budget", BUDGET, "--subset", mismatched, "--out", mismatchOut, "--json"]).status, 1);
    const mismatchPlan = readPlan(mismatchOut);
    assert.equal(mismatchPlan.cellCount, 0);
    assert.equal(mismatchPlan.requestCount, 0);
    assert.equal(mismatchPlan.blockerCounts.subset_manifest_digest_mismatch, 1);

    const holdout = manifest.tasks.find((task) => task.split === "holdout");
    const holdoutPath = path.join(root, "holdout.json");
    writeFileSync(holdoutPath, `${JSON.stringify(subsetDoc({ taskIds: [holdout.id], taskDigest: taskDigestFor([holdout]) }), null, 2)}\n`);
    const holdoutOut = path.join(root, "holdout-out");
    assert.equal(run(["--dry-run", "--manifest", MANIFEST, "--budget", BUDGET, "--subset", holdoutPath, "--out", holdoutOut, "--json"]).status, 1);
    const holdoutPlan = readPlan(holdoutOut);
    assert.equal(holdoutPlan.requestCount, 0);
    assert.equal(holdoutPlan.blockerCounts.subset_holdout_task, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown flags and flags without a value are refused before any planning", () => {
  const unknown = run(["--dry-run", "--manifest", MANIFEST, "--bogus", "--json"]);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown flag: --bogus/);
  assert.equal(unknown.stdout, "");

  const missingValue = run(["--dry-run", "--manifest", MANIFEST, "--subset", "--json"]);
  assert.equal(missingValue.status, 2);
  assert.match(missingValue.stderr, /missing value for --subset/);
  assert.equal(missingValue.stdout, "");

  const strayArgument = run(["--dry-run", "--manifest", MANIFEST, "extra"]);
  assert.equal(strayArgument.status, 2);
  assert.match(strayArgument.stderr, /unexpected argument: extra/);

  const noManifest = run(["--dry-run", "--json"]);
  assert.equal(noManifest.status, 2);
  assert.match(noManifest.stderr, /--manifest is required/);
});

test("the live path is refused by construction with stable codes", () => {
  const noApproval = run(["--live", "--manifest", MANIFEST, "--budget", BUDGET, "--json"]);
  assert.equal(noApproval.status, 2);
  assert.equal(JSON.parse(noApproval.stdout).live.code, "live_approval_invalid");

  const approvalWithoutLive = run(["--approve-live", "0.5", "--manifest", MANIFEST, "--budget", BUDGET, "--json"]);
  assert.equal(approvalWithoutLive.status, 2);
  assert.equal(JSON.parse(approvalWithoutLive.stdout).live.code, "live_approval_without_live");

  const capTooHigh = run(["--live", "--approve-live", "9", "--manifest", MANIFEST, "--budget", BUDGET, "--json"]);
  assert.equal(capTooHigh.status, 2);
  assert.equal(JSON.parse(capTooHigh.stdout).live.code, "live_cap_exceeds_declared");

  const noExecutor = run(["--live", "--approve-live", "0.5", "--manifest", MANIFEST, "--budget", BUDGET, "--json"]);
  assert.equal(noExecutor.status, 2);
  assert.equal(JSON.parse(noExecutor.stdout).live.code, "live_executor_absent");
});
