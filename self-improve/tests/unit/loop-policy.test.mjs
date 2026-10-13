import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { appendRow } from "../../lib/ledger.mjs";
import { computeAdmissibleActions, effectiveStopOnAdopt, loadCurrentLoopPolicy } from "../../lib/loop.mjs";
import { buildPolicyArtifact, policyArtifactPath, policyCurrentPath } from "../../lib/policy.mjs";
import { sha256Hex } from "../../lib/types.mjs";

const [A, B, C] = DOMAIN.objectives;

function cycleRow({ cycleId, objective, hypothesis, decision = "reject" }) {
  return {
    kind: "cycle",
    cycleId,
    domain: "gjc-plugin",
    campaignId: "m4a-test",
    baseCommit: "abcdef0",
    budgetRung: 0,
    proposal: { source: "agent", patchSha256: "a".repeat(64), files: ["jev-advisor/lib/decision.ts"], hunks: 1 },
    hypothesisHash: sha256Hex(hypothesis),
    objective,
    scores: { baseline: {}, candidate: {}, delta: decision === "adopt" ? 0.05 : 0, floor: 0.01 },
    cost: { wallMs: 1000, bytes: 100, tokens: null },
    guards: [{ id: "build", status: "pass" }],
    critic: { verdict: "pass", rules: [] },
    verdict: { decision, reasons: decision === "adopt" ? [] : ["floor_not_met"] },
    createdAt: "2026-10-13T00:00:00.000Z",
  };
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "self-improve-loop-policy-"));
}

function writeLedger(root, rows) {
  const ledgerPath = join(root, "ledger.jsonl");
  for (const row of rows) appendRow(ledgerPath, row);
  return ledgerPath;
}

const orderOf = (result) => result.actions.map((action) => action.objective);

test("computeAdmissibleActions maps each policy order rule deterministically", () => {
  const root = tempRoot();
  try {
    // A: 2 rejects, B: 1 reject, C: 1 adopt (total attempts 4)
    const ledgerPath = writeLedger(root, [
      cycleRow({ cycleId: "a1", objective: A, hypothesis: "a1" }),
      cycleRow({ cycleId: "a2", objective: A, hypothesis: "a2" }),
      cycleRow({ cycleId: "b1", objective: B, hypothesis: "b1" }),
      cycleRow({ cycleId: "c1", objective: C, hypothesis: "c1", decision: "adopt" }),
    ]);
    const base = { ledgerPath, adapter: DOMAIN, preferredObjective: A };
    assert.deepEqual(orderOf(computeAdmissibleActions(base)), [A, B, C], "no policy: failing-case objective first");
    assert.equal(computeAdmissibleActions(base).actions[0].reason, "failing_cases");
    assert.deepEqual(orderOf(computeAdmissibleActions({ ...base, orderRule: "fixed" })), [A, B, C]);
    assert.equal(computeAdmissibleActions({ ...base, orderRule: "fixed" }).actions[0].reason, "policy:fixed");
    assert.deepEqual(orderOf(computeAdmissibleActions({ ...base, orderRule: "round_robin" })), [B, C, A]);
    assert.deepEqual(orderOf(computeAdmissibleActions({ ...base, orderRule: "success_greedy" })), [C, B, A]);
    assert.deepEqual(orderOf(computeAdmissibleActions({ ...base, orderRule: "novelty_first" })), [B, C, A]);
    assert.deepEqual(orderOf(computeAdmissibleActions({ ...base, orderRule: "failure_greedy" })), [A, B, C]);
    // only failure_greedy (and the no-policy default) let the failing-case objective lead
    const withoutPreferred = computeAdmissibleActions({ ...base, preferredObjective: null, orderRule: "success_greedy" });
    assert.deepEqual(orderOf(withoutPreferred), [C, B, A]);
    assert.equal(withoutPreferred.actions[0].reason, "policy:success_greedy");
    assert.equal(computeAdmissibleActions({ ...base, orderRule: "fixed" }).orderRule, "fixed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stallRedirect false proposes stalled objectives by the order rule; true/absent redirects while unexplored", () => {
  const root = tempRoot();
  try {
    const ledgerPath = writeLedger(root, [
      cycleRow({ cycleId: "a1", objective: A, hypothesis: "a1" }),
      cycleRow({ cycleId: "a2", objective: A, hypothesis: "a2" }),
      cycleRow({ cycleId: "a3", objective: A, hypothesis: "a3" }),
      cycleRow({ cycleId: "b1", objective: B, hypothesis: "b1" }),
    ]);
    const state = computeAdmissibleActions({ ledgerPath, adapter: DOMAIN });
    assert.equal(state.stalled.includes(A), true, "three consecutive rejects stall objective A");
    assert.deepEqual(orderOf(state), [C], "default: redirect to the unexplored probe only");
    const redirectedOff = computeAdmissibleActions({ ledgerPath, adapter: DOMAIN, stallRedirect: false });
    assert.deepEqual(orderOf(redirectedOff), [C, B, A], "redirect off: least-attempted order includes the stalled objective last");
    const fixedOff = computeAdmissibleActions({ ledgerPath, adapter: DOMAIN, orderRule: "fixed", stallRedirect: false });
    assert.deepEqual(orderOf(fixedOff), [A, B, C], "redirect off: the order rule decides, even for the stalled objective");
    const noveltyOn = computeAdmissibleActions({ ledgerPath, adapter: DOMAIN, orderRule: "novelty_first", stallRedirect: true });
    assert.deepEqual(orderOf(noveltyOn), [C], "novelty_first with the redirect active still forces the unexplored probe");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadCurrentLoopPolicy reads the deployed pointer, tolerates absence and reports a broken artifact", () => {
  const root = tempRoot();
  try {
    const repoRoot = join(root, "repo");
    const policyDir = join(repoRoot, "self-improve", "policies");
    mkdirSync(policyDir, { recursive: true });
    assert.deepEqual(loadCurrentLoopPolicy({ repoRoot }), { policy: null, error: null, policyDir });

    const artifact = buildPolicyArtifact({
      id: "pi-1-25",
      seed: 1,
      config: { order: "failure_greedy", batchSize: 1, stopRule: "first_adoption", stallRedirect: false, stallK: 3 },
      createdAt: "2026-10-13T00:00:00.000Z",
    });
    const artifactText = `${JSON.stringify(artifact, null, 2)}\n`;
    writeFileSync(policyArtifactPath({ policyDir, id: "pi-1-25" }), artifactText);
    writeFileSync(
      policyCurrentPath({ policyDir }),
      `${JSON.stringify({ id: "pi-1-25", file: "pi-1-25.json", sha256: sha256Hex(artifactText), decision: "deploy" }, null, 2)}\n`,
    );
    const loaded = loadCurrentLoopPolicy({ repoRoot });
    assert.equal(loaded.error, null);
    assert.equal(loaded.policy.id, "pi-1-25");
    assert.deepEqual(loaded.policy.config, artifact.config);

    writeFileSync(policyCurrentPath({ policyDir }), `${JSON.stringify({ id: "missing" }, null, 2)}\n`);
    const broken = loadCurrentLoopPolicy({ repoRoot });
    assert.equal(broken.policy, null);
    assert.match(broken.error, /policy_load_failed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("stop-on-adopt precedence is CLI explicit > policy stop rule > default", () => {
  const firstAdoptionPolicy = { config: { stopRule: "first_adoption" } };
  const exhaustivePolicy = { config: { stopRule: "exhaustive" } };
  assert.equal(effectiveStopOnAdopt({ cliStopOnAdopt: true, policy: null }), true);
  assert.equal(effectiveStopOnAdopt({ cliStopOnAdopt: true, policy: exhaustivePolicy }), true);
  assert.equal(effectiveStopOnAdopt({ cliStopOnAdopt: false, policy: firstAdoptionPolicy }), true);
  assert.equal(effectiveStopOnAdopt({ cliStopOnAdopt: false, policy: exhaustivePolicy }), false);
  assert.equal(effectiveStopOnAdopt({ cliStopOnAdopt: false, policy: null }), false);
  assert.equal(effectiveStopOnAdopt({}), false);
});
