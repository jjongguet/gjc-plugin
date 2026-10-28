import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  admitCall,
  isolationPreflight,
  manifestDigest,
  pairedBenefit,
  planTrial,
  selectLessons,
  validateManifest,
  validateTrialReceipt,
} from "../../lib/behavior-eval.mjs";
import { buildLoadingReceipt } from "../../lib/loading-receipt.mjs";

const SELF_IMPROVE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(readFileSync(join(SELF_IMPROVE, "tests/fixtures/pilot/manifest.json"), "utf8"));

test("the pilot manifest preserves class/split coverage and pins the added development case", () => {
  const result = validateManifest(manifest);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, {
    "artifact-check": { development: 2, holdout: 1 },
    "eligible-adequacy": { development: 1, holdout: 1 },
    "small-repo-task": { development: 1, holdout: 1 },
  });
  assert.match(result.digest, /^[a-f0-9]{64}$/);
  assert.equal(result.digest, manifestDigest(manifest));
  // Every oracle remains a repository file. Holdout payloads stay unopened;
  // only development expectations are inspected during this bounded pilot.
  for (const task of manifest.tasks) {
    assert.equal(statSync(join(SELF_IMPROVE, "..", task.oracle.path)).isFile(), true, task.id);
    if (task.split === "holdout") continue;
    const oracle = JSON.parse(readFileSync(join(SELF_IMPROVE, "..", task.oracle.path), "utf8"));
    assert.equal(oracle.independent, true, task.id);
    assert.equal(oracle.task, task.id);
  }
});

test("manifest validation rejects holdout leakage, duplicates and an unbalanced class", () => {
  const leaked = { schema: "harness2.pilot.v1", tasks: manifest.tasks.map((task) => task.split === "holdout" ? { ...task, oracle: { ...task.oracle, path: "scratch/oracle.json" } } : task) };
  assert.match(validateManifest(leaked).errors.join("\n"), /must stay under self-improve\/tests\/fixtures\/pilot|never live inside the trial mount/);
  const duplicate = { schema: "harness2.pilot.v1", tasks: [manifest.tasks[0], { ...manifest.tasks[1], id: manifest.tasks[0].id }] };
  assert.match(validateManifest(duplicate).errors.join("\n"), /duplicates/);
  const oneClass = { schema: "harness2.pilot.v1", tasks: manifest.tasks.filter((task) => task.klass === "artifact-check") };
  assert.match(validateManifest(oneClass).errors.join("\n"), /needs at least one development task/);
});

test("B1 and B2 plan under the same ceiling and count every stage", () => {
  const digest = manifestDigest(manifest);
  const b0 = planTrial({ arm: "B0", manifestDigest: digest, totalResourceMs: 60_000 });
  const b1 = planTrial({ arm: "B1", manifestDigest: digest, totalResourceMs: 60_000 });
  const b2 = planTrial({ arm: "B2", manifestDigest: digest, totalResourceMs: 60_000 });
  assert.equal(b0.plan.selection, "single-attempt");
  assert.equal(b1.plan.selection, "first-public-check-pass");
  assert.equal(b1.plan.actualSpendMs, 0);
  assert.equal(b2.plan.countsAllStages, true);
  assert.equal(b1.plan.totalResourceMs, b2.plan.totalResourceMs);
  assert.equal(planTrial({ arm: "B9", manifestDigest: digest, totalResourceMs: 1 }).reason, "unknown_arm");
  assert.equal(planTrial({ arm: "B1", manifestDigest: digest, totalResourceMs: 0 }).reason, "invalid_ceiling");
});

test("spending admission fails closed on unknown price, usage or cap", () => {
  assert.equal(admitCall({ capUsd: 5, priceUsd: 0.2, reservationUsd: 0.3 }).allowed, true);
  assert.equal(admitCall({ capUsd: 5, priceUsd: Number.NaN, reservationUsd: 0.3 }).reason, "unknown_price");
  assert.equal(admitCall({ capUsd: 5, priceUsd: 0.2, reservationUsd: 0.3, unresolvedUsd: Number.NaN }).reason, "unknown_usage");
  assert.equal(admitCall({ capUsd: 5, priceUsd: 4, reservationUsd: 4, spentUsd: 3 }).reason, "cap_exceeded");
  assert.equal(admitCall({ capUsd: -1, priceUsd: 0.1, reservationUsd: 0.1 }).reason, "missing_cap");
});

test("a trial is invalid without loading, isolation, budget or measured cost evidence", () => {
  const loadingReceipt = buildLoadingReceipt({
    pluginState: {
      status: "ok",
      reason: null,
      plugins: [
        {
          name: "rrsi",
          version: "0.0.4",
          enabled: true,
          quarantined: false,
          manifestHash: "1".repeat(64),
          targetFingerprint: "2".repeat(64),
          surfaces: [{ kind: "tool", name: "rrsi", enabled: true, quarantined: false }],
        },
      ],
    },
    harnessDigest: { rootHash: "3".repeat(64), rows: [{ path: "gjc-plugins/rrsi", sha256: "4".repeat(64), size: 10 }] },
    expected: { plugins: ["rrsi"] },
  });
  const good = {
    loadingReceipt,
    harness: { sourceDigest: "b".repeat(64), harnessDigest: "c".repeat(64) },
    isolation: { denyProbesPassed: true },
    producer: { id: "producer-a" },
    executor: { id: "executor-a", receiptDigest: "d".repeat(64) },
    oracle: { independent: true, kind: "artifact-check", verifierId: "verifier-a", evidenceDigest: "e".repeat(64) },
    budget: { admitted: true },
    holdout: { usedEarly: false },
    outcomes: [{ task: "t", passed: true }],
    denominator: { planned: 1, passed: 1, failed: 0, error: 0, skipped: 0 },
    cost: { measured: true, usd: 0.01, wallMs: 1200 },
  };
  assert.deepEqual(validateTrialReceipt(good), { valid: true, failures: [] });
  const bad = { ...good, isolation: { denyProbesPassed: false }, cost: { measured: false }, holdout: { usedEarly: true } };
  assert.deepEqual(validateTrialReceipt(bad).failures, ["isolation_not_proven", "holdout_used_early", "cost_not_measured"]);

  // A boolean is not independence evidence, and the identity/measurement pins are required.
  const bareBoolean = { ...good, oracle: { independent: true } };
  assert.deepEqual(validateTrialReceipt(bareBoolean).failures, [
    "oracle_not_independent",
    "oracle_verifier_missing",
    "oracle_kind_missing",
    "oracle_evidence_missing",
  ]);
  const selfVerified = { ...good, oracle: { ...good.oracle, verifierId: "producer-a" } };
  assert.deepEqual(validateTrialReceipt(selfVerified).failures, ["oracle_not_independent"]);
  const missingPins = { ...good, harness: {}, executor: { id: "executor-a" } };
  assert.deepEqual(validateTrialReceipt(missingPins).failures, ["missing_source_digest", "missing_harness_digest", "missing_executor_receipt_digest"]);
  const shortDenominator = { ...good, outcomes: [{ task: "a", passed: true }], denominator: { planned: 2, passed: 1, failed: 0, error: 0, skipped: 0 } };
  assert.deepEqual(validateTrialReceipt(shortDenominator).failures, ["denominator_mismatch"]);
  const negativeCost = { ...good, cost: { measured: true, usd: -0.01, wallMs: 1200 } };
  assert.deepEqual(validateTrialReceipt(negativeCost).failures, ["invalid_cost"]);

  // The loading gate is re-derived, not trusted: an unloaded receipt, a missing
  // payload and a tampered payload are all rejected.
  const unloaded = { ...good, loadingReceipt: { ...loadingReceipt, loaded: false } };
  assert.deepEqual(validateTrialReceipt(unloaded).failures, ["loading_not_proven"]);
  const noPayload = { ...good, loadingReceipt: { sha256: "a".repeat(64), loaded: true } };
  assert.deepEqual(validateTrialReceipt(noPayload).failures, ["loading_payload_missing"]);
  const tampered = { ...good, loadingReceipt: { ...loadingReceipt, payload: { ...loadingReceipt.payload, sourceHead: "deadbeef" } } };
  assert.deepEqual(validateTrialReceipt(tampered).failures, ["loading_payload_mismatch"]);
});

test("component wins never rescue a regressing or costlier composite", () => {
  const compositeRegression = [
    { task: "a", qualityDelta: 0.5, costRatio: 0.9 },
    { task: "b", qualityDelta: -0.2, costRatio: 0.9 },
  ];
  assert.deepEqual(pairedBenefit(compositeRegression).verdict, "no-gain");
  assert.equal(pairedBenefit(compositeRegression).reason, "regression");
  assert.equal(pairedBenefit([{ task: "a", qualityDelta: 0.1, costRatio: 0.9 }]).verdict, "insufficient");
  assert.equal(pairedBenefit([{ task: "a", qualityDelta: 0.1, costRatio: 1.4 }, { task: "b", qualityDelta: 0.1, costRatio: 1.4 }]).reason, "cost_ratio");
  assert.equal(pairedBenefit([{ task: "a", qualityDelta: 0.2, costRatio: 0.8 }, { task: "b", qualityDelta: 0.1, costRatio: 0.9 }]).verdict, "pass");
});

test("lesson reuse is bounded by objective, version, count and bytes, and withholds bad lessons", () => {
  const scope = { objective: "probe.docs_links", version: "1.2.3" };
  const lessons = [
    { id: "l1", ...scope, outcome: "supported", lesson: "check anchors first", cue: "docs", evidence: "t1" },
    { id: "l2", ...scope, outcome: "contradicted", lesson: "skip anchors", cue: "docs", evidence: "t2" },
    { id: "l3", ...scope, outcome: "stale", lesson: "old rule", cue: "docs", evidence: "t3" },
    { id: "l4", ...scope, outcome: "supported", lesson: "x".repeat(1500), cue: "docs", evidence: "t4" },
    { id: "l5", ...scope, outcome: "supported", lesson: "ok", cue: "docs", evidence: "t5" },
    { id: "l6", objective: "other", version: "1.2.3", outcome: "supported", lesson: "n/a", cue: "x", evidence: "t6" },
  ];
  const chosen = selectLessons(lessons, { ...scope });
  assert.deepEqual(chosen.selected.map((lesson) => lesson.id), ["l1", "l4", "l5"]);
  assert.deepEqual(chosen.withheld.map((entry) => entry.reason).sort(), ["contradicted", "not_applicable", "stale"]);
  const tight = selectLessons(lessons, { ...scope, maxBytes: 120 });
  assert.deepEqual(tight.selected.map((lesson) => lesson.id), ["l1", "l5"]);
  assert.ok(tight.withheld.some((entry) => entry.reason === "byte_bound"));
  assert.ok(chosen.bytes <= 2048);
  const capped = selectLessons(lessons.filter((lesson) => lesson.outcome === "supported" && lesson.objective === scope.objective), { ...scope, maxLessons: 1 });
  assert.equal(capped.selected.length, 1);
  assert.ok(capped.withheld.some((entry) => entry.reason === "count_bound"));
});

test("live trials stay forbidden without an enforceable runtime and passing deny probes", () => {
  assert.deepEqual(isolationPreflight({}), { status: "unavailable", reason: "no_enforceable_runtime", liveTrialsAllowed: false });
  assert.equal(isolationPreflight({ runtime: "container-run" }).reason, "no_deny_probes");
  assert.equal(isolationPreflight({ runtime: "container-run", denyProbes: [{ id: "host-file", passed: false }] }).status, "fail");
  assert.equal(isolationPreflight({ runtime: "container-run", denyProbes: [{ id: "host-file", passed: true }, { id: "egress", passed: true }] }).liveTrialsAllowed, true);
});
