import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_IMPROVE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI = join(SELF_IMPROVE, "m1", "run-preflight.mjs");
const MANIFEST = join(SELF_IMPROVE, "tests", "fixtures", "pilot", "manifest.json");
const BUDGET = join(SELF_IMPROVE, "m1", "budget.example.json");

const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", timeout: 60_000 });
const readPlan = (dir) => JSON.parse(readFileSync(path.join(dir, "plan.json"), "utf8"));

test("the dry run names every blocker, plans development cells, and makes no model call", () => {
  const out = mkdtempSync(path.join(os.tmpdir(), "harness2-preflight-dry-"));
  try {
    const result = run(["--dry-run", "--manifest", MANIFEST, "--budget", BUDGET, "--out", out, "--json"]);
    assert.equal(result.status, 1, result.stderr);
    const plan = readPlan(out);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.cellCount, 27);
    assert.equal(plan.manifest.holdout.length, 3);
    assert.equal(plan.manifest.holdoutUsedEarly, false);
    assert.deepEqual(plan.blockerCounts, { oracle_kind_unimplemented: 6, prompt_missing: 6 });
    assert.equal(plan.live.code, "live_not_approved");
    assert.equal(plan.isolation.status, "pass");
    assert.equal(plan.loading.loaded, true);
    assert.equal(typeof plan.isolation.profileDigestNormalized, "string");

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
