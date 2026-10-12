import test from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeAdmissibleActions } from "../../lib/loop.mjs";

const OBJECTIVES = ["probe.extract_coverage", "probe.decision_accuracy", "probe.egress_boundary"];
const ADAPTER = { objectives: OBJECTIVES, stallK: 3 };

function row(objective, index) {
  return {
    kind: "cycle",
    cycleId: `${objective}-${index}`,
    objective,
    hypothesisHash: `${objective}-h${index}`,
    verdict: { decision: "reject", reasons: ["floor_not_met"] },
  };
}

function seedLedger(rejectsPerObjective) {
  const dir = mkdtempSync(join(tmpdir(), "loop-selection-"));
  const ledger = join(dir, "ledger.jsonl");
  for (const objective of OBJECTIVES) {
    for (let index = 1; index <= rejectsPerObjective; index += 1) {
      appendFileSync(ledger, `${JSON.stringify(row(objective, index))}\n`);
    }
  }
  return { dir, ledger };
}

test("when every objective is stalled and nothing is unexplored, the failing-case objective still leads", () => {
  const { dir, ledger } = seedLedger(3);
  const { actions, stalled } = computeAdmissibleActions({
    ledgerPath: ledger,
    adapter: ADAPTER,
    k: 3,
    preferredObjective: "probe.decision_accuracy",
  });
  assert.deepEqual(stalled.sort(), [...OBJECTIVES].sort());
  assert.ok(actions.length > 0, "a fully stalled set must stay admissible (caps bound the retries)");
  assert.equal(actions[0].objective, "probe.decision_accuracy");
  assert.equal(actions[0].reason, "failing_cases");
  rmSync(dir, { recursive: true, force: true });
});

test("while an unexplored probe remains, stall redirects away from the stalled objective", () => {
  const fresh = mkdtempSync(join(tmpdir(), "loop-selection-"));
  const freshLedger = join(fresh, "ledger.jsonl");
  for (let index = 1; index <= 3; index += 1) {
    appendFileSync(freshLedger, `${JSON.stringify(row("probe.decision_accuracy", index))}\n`);
  }
  const { actions } = computeAdmissibleActions({
    ledgerPath: freshLedger,
    adapter: ADAPTER,
    k: 3,
    preferredObjective: "probe.decision_accuracy",
  });
  assert.ok(actions.length > 0);
  assert.notEqual(actions[0].objective, "probe.decision_accuracy");
  rmSync(fresh, { recursive: true, force: true });
});
