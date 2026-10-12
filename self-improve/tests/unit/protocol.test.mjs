import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = resolve(SELF_IMPROVE_DIR, "..");

function readJson(relPath) {
  return JSON.parse(readFileSync(join(REPO_ROOT, relPath), "utf8"));
}

function sha256File(relPath) {
  return createHash("sha256").update(readFileSync(join(REPO_ROOT, relPath))).digest("hex");
}

test("rrsi-protocol freezes the plan's caps, dual-floor rule and escalation", () => {
  const protocol = readJson("self-improve/rrsi-protocol.json");
  assert.equal(protocol.schema, "gjc.self-improve.rrsi-protocol.v1");
  assert.equal(protocol.primary, "decision_accuracy");
  assert.equal(protocol.floor, 0.01);
  assert.deepEqual(
    { pass: protocol.dualFloor.pass, degraded: protocol.dualFloor.degraded, fail: protocol.dualFloor.fail },
    {
      pass: ">=2 adoption cycles",
      degraded: "exactly 1 adoption cycle with a documented cause (recorded, not proof-grade)",
      fail: "0 adoption cycles",
    },
  );
  assert.ok(protocol.dualFloor.perAdoption.some((entry) => entry.includes("--install")));
  assert.deepEqual(
    { cycles: protocol.caps.m2.maxCycles, calls: protocol.caps.m2.maxProposerCalls, wall: protocol.caps.m2.maxWallMs },
    { cycles: 20, calls: 24, wall: 9000000 },
  );
  assert.deepEqual(
    { cycles: protocol.caps.m4.maxCycles, calls: protocol.caps.m4.maxProposerCalls, wall: protocol.caps.m4.maxWallMs },
    { cycles: 6, calls: 8, wall: 2400000 },
  );
  assert.equal(protocol.caps.m2.stopOnAdopt, false);
  assert.equal(protocol.caps.m4.stopOnAdopt, false);
  assert.equal(protocol.caps.m2.cli, "--max-cycles 20 --max-proposer-calls 24 --max-wall-ms 9000000");
  assert.match(protocol.caps.invariant, /proposerCalls >= cycles/);
  for (const key of ["m2", "m4"]) {
    assert.ok(protocol.caps[key].maxProposerCalls >= protocol.caps[key].maxCycles, `${key}: proposerCalls >= cycles`);
    assert.equal(protocol.caps[key].invariantHolds, true, `${key}: invariantHolds`);
  }
  assert.match(protocol.autoStop, /stopped_reason/);
  assert.match(protocol.escalation, /stops the campaign/);
  assert.ok(protocol.p2.passGateN >= 20 && protocol.p2.train === 14 && protocol.p2.validation === 6);
  assert.equal(protocol.p2.validationRequiresAdoption, true);
  assert.equal(protocol.live.requiresFlag, "--live-approved");
  assert.equal(protocol.live.proposerSeam, "cmd");
  assert.match(protocol.live.template, /propose-with-gjc\.mjs \{request\} \{response\}/);
  assert.equal(
    protocol.noPostHocEdits,
    "No post-hoc threshold edits: thresholds are frozen by this file's commit and re-hashed in the evidence map.",
  );
});

test("rrsi-protocol headroom numbers re-derive from the live fixture corpus", () => {
  const protocol = readJson("self-improve/rrsi-protocol.json");
  const probes = readJson("self-improve/domains/gjc-plugin/probes/fixtures.json");
  const denominator = probes.cases.decision_accuracy.length;
  assert.equal(protocol.headroom.denominator, denominator, "denominator must equal the probe decision_accuracy case count");
  assert.equal(protocol.headroom.perCaseDelta, 1 / denominator);
  assert.equal(protocol.headroom.requiredRepairedCases, Math.ceil(protocol.floor * denominator));
  assert.ok(protocol.headroom.requiredRepairedCases >= 1);
  assert.ok(Number.isInteger(protocol.headroom.gapClusters) && protocol.headroom.gapClusters >= 0);
});

test("rrsi-protocol headroom clusters each cross the floor and match the measured drift count", () => {
  const protocol = readJson("self-improve/rrsi-protocol.json");
  const denominator = protocol.headroom.denominator;
  assert.equal(protocol.headroom.gapClusters, protocol.headroom.clusters.length);
  assert.equal(protocol.headroom.gapClusters, 2, "the accepted honest cluster count");
  assert.match(protocol.headroom.clusterCountDeviation, /R1/);
  assert.match(protocol.headroom.clusterCountDeviation, />=2 adoptions|>=2|1:1/);
  let cases = 0;
  for (const cluster of protocol.headroom.clusters) {
    assert.ok(typeof cluster.id === "string" && cluster.id.length > 0);
    assert.ok(Number.isInteger(cluster.cases) && cluster.cases >= 1, cluster.id);
    assert.ok(cluster.cases / denominator >= protocol.floor, `${cluster.id}: single-cluster headroom below the floor`);
    assert.equal(cluster.headroom, cluster.cases / denominator, cluster.id);
    assert.match(cluster.source, /jev-advisor\//, cluster.id);
    assert.match(cluster.repairSurface, /jev-advisor\//, cluster.id);
    cases += cluster.cases;
  }
  assert.equal(protocol.headroom.measuredBaseline.driftCases, cases, "measured drift must equal the cluster case count");
  assert.ok(protocol.headroom.measuredBaseline.decisionAccuracy < 1, "baseline must be non-saturated");
});

test("rrsi-protocol corpus hashes match the current fixture bytes", () => {
  const protocol = readJson("self-improve/rrsi-protocol.json");
  assert.equal(sha256File(protocol.corpus.probes), protocol.corpus.sha256.probes, "probes hash drifted from the frozen value");
  assert.equal(sha256File(protocol.corpus.heldout), protocol.corpus.sha256.heldout, "heldout hash drifted from the frozen value");
});
