import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";
import { checkLiveEvidence, pilotInputs, selectPublic, sourceDigest, cellReceipt } from "../../m1/pilot-protocol.mjs";
import { runPilot } from "../../m1/run-pilot.mjs";
import { buildLoadingReceipt } from "../../lib/loading-receipt.mjs";

const hex = "a".repeat(64);
function admissionFixture() {
  return {
    budget: { capUsd: 1, taskCapUsd: 5, maxCalls: 21, priorSpentUsd: 0, priorReservedUsd: 0, priorUnresolvedUsd: 0, cleanupUsd: 0, priorPilotCalls: 0, priorPilotSpentUsd: 0, priorPilotReservedUsd: 0, priorPilotUnresolvedUsd: 0, accountingStatus: "reconciled", accountingEvidenceDigest: hex },
    pricing: { observedAt: "2026-10-28T00:00:00Z", source: "https://openrouter.ai/api/v1/models/openai/gpt-4.1-mini/endpoints", model: "openai/gpt-4.1-mini", provider: "OpenAI", inputPrice: 0.0000004, outputPrice: 0.0000016 },
    nativeProof: { passed: true, sourceDigest: hex, results: ["B0", "B1", "B2"].map((arm) => ({ arm, isolation: { status: "pass" }, native: { code: 0 }, requests: [{ status: "ok", rulePresent: arm === "B2" }] })) },
    sharedDelivery: { status: "verified", mainSha: "a".repeat(40), tag: "v1.2.3", installedSurfaceDigest: hex, freshUserSession: { id: "fixture-only", projectionDigest: hex, coverageStatus: "verified" } },
    currentSourceDigest: hex,
    now: Date.parse("2026-10-28T01:00:00Z"),
  };
}

test("only the declared historical development case enters nine cells and twenty-one slots", () => {
  const inputs = pilotInputs();
  assert.equal(inputs.cells.length, 9);
  assert.equal(inputs.requests.length, 21);
  assert.deepEqual([...new Set(inputs.cells.map((c) => c.taskId))], ["decision-probability-boundary-dev10"]);
  assert.equal(inputs.cells.every((c) => c.split === "development"), true);
  assert.equal(inputs.requests.filter((r) => r.arm === "B1").length, 9);
  assert.equal(inputs.requests.filter((r) => r.arm === "B2").length, 9);
  assert.match(sourceDigest(), /^[a-f0-9]{64}$/);
});

test("public selection chooses the first schema-valid candidate, not the oracle-correct one", () => {
  const attempts = [{ status: "ok", output: '{"accept":false}', slotId: "one" }, { status: "ok", output: '{"accept":true,"tier":"fast"}', slotId: "two" }, { status: "ok", output: "malformed", slotId: "three" }];
  assert.equal(selectPublic(attempts).slotId, "one");
  assert.equal(selectPublic([{ status: "error", output: '{"accept":true,"tier":"fast"}' }]), null);
  assert.equal(selectPublic([{ status: "ok", output: "malformed", slotId: "last" }]), null);
});

test("admission includes all twenty-one calls and prior reserved task costs", () => {
  const f = admissionFixture();
  const admitted = checkLiveEvidence(f);
  assert.ok(Math.abs(admitted.ceilingUsd - 0.03528) < 1e-12);
  assert.throws(() => checkLiveEvidence({ ...f, budget: { ...f.budget, priorReservedUsd: 5 } }), /aggregate_budget_exceeded/);
  assert.throws(() => checkLiveEvidence({ ...f, budget: { ...f.budget, priorSpentUsd: null } }), /prior_cost_unknown/);
  assert.throws(() => checkLiveEvidence({ ...f, budget: { ...f.budget, priorUnresolvedUsd: 0.01 } }), /prior_cost_unreconciled/);
  assert.throws(() => checkLiveEvidence({ ...f, budget: { ...f.budget, priorPilotCalls: 1 } }), /pilot_prior_execution_or_unknown/);
  assert.throws(() => checkLiveEvidence({ ...f, pricing: { ...f.pricing, inputPrice: 0 } }), /pricing_unverified/);
  assert.throws(() => checkLiveEvidence({ ...f, now: f.now + 86400000 }), /pricing_unverified/);
});

test("stale native proof and incomplete first shared delivery cannot authorize paid execution", () => {
  const f = admissionFixture();
  assert.throws(() => checkLiveEvidence({ ...f, currentSourceDigest: "b".repeat(64) }), /native_proof_stale_or_missing/);
  assert.throws(() => checkLiveEvidence({ ...f, nativeProof: { ...f.nativeProof, passed: false } }), /native_proof_stale_or_missing/);
  assert.throws(() => checkLiveEvidence({ ...f, sharedDelivery: null }), /shared_delivery_not_verified/);
  assert.throws(() => checkLiveEvidence({ ...f, sharedDelivery: { ...f.sharedDelivery, freshUserSession: null } }), /shared_delivery_not_verified/);
});

test("unapproved live execution is refused before creating artifacts or invoking a provider", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "pilot-admission-"));
  const outputDir = path.join(root, "not-created");
  try {
    await assert.rejects(runPilot({ outputDir, mode: "live", apiKey: "fake-test-only" }), /live_not_authorized/);
    assert.equal(existsSync(outputDir), false);
    const cli = spawnSync(process.execPath, [fileURLToPath(new URL("../../m1/run-pilot.mjs", import.meta.url)), "--live", "--out", outputDir], {
      env: { PATH: process.env.PATH, GIT_DIR: path.join(root, "missing-git"), OPENROUTER_API_KEY: "fake-test-only" },
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(cli.status, 1);
    assert.match(cli.stderr, /live_not_authorized/);
    assert.equal(existsSync(outputDir), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("canonical validators admit measured mock cells and exclude scripted cost-free receipts", () => {
  const inputs = pilotInputs();
  const cell = inputs.cells[0];
  const attempts = [{ status: "ok", slotId: "one", output: '{"accept":true,"tier":"fast"}', usage: { usd: 0.0001, input: 100, output: 10 } }];
  const loading = buildLoadingReceipt({ sourceHead: "a".repeat(40), gjcVersion: "test-fixture", pluginState: { status: "ok", plugins: [] }, harnessDigest: { rootHash: hex, rows: [{ path: "RULES.md", hash: hex }] }, expected: { guards: [{ id: "fixture-native-consumption", resolved: true }] } });
  const args = { cell, attempts, inputs, loading, isolation: { status: "pass", profileDigest: hex }, sourceHead: "a".repeat(40), source: hex, harnessDigest: hex, wallMs: 10 };
  const measured = cellReceipt({ ...args, mode: "live" });
  assert.equal(measured.evalid.valid, true);
  assert.equal(measured.quality.ok, true);
  assert.equal(measured.outcome, "passed");
  const dry = cellReceipt({ ...args, mode: "dry" });
  assert.equal(dry.quality.ok, false);
  assert.equal(dry.quality.reason, "missing_cost");
  const failed = cellReceipt({ ...args, mode: "live", attempts: [{ ...attempts[0], output: '{"accept":false}' }] });
  assert.equal(failed.outcome, "failed");
  assert.equal(failed.quality.ok, true, "a measured semantic failure is retained, not excluded");
});
