import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkProposalHistory, historyState } from "../../lib/engine.mjs";
import { appendRow } from "../../lib/ledger.mjs";
import { sha256Hex } from "../../lib/types.mjs";

function cycleRow({ cycleId, objective, hypothesis, decision, reasons = [] }) {
  return {
    kind: "cycle",
    cycleId,
    domain: "gjc-plugin",
    campaignId: "default",
    baseCommit: "abcdef0",
    budgetRung: 0,
    proposal: { source: "manual", patchSha256: "a".repeat(64), files: ["jev-advisor/lib/decision.ts"], hunks: 1 },
    hypothesisHash: sha256Hex(hypothesis),
    objective,
    scores: { baseline: {}, candidate: {}, delta: 0, floor: 0.01 },
    cost: { wallMs: 1, bytes: 1, tokens: null },
    guards: [{ id: "build", status: "pass" }],
    critic: { verdict: "pass", rules: [] },
    verdict: { decision, reasons },
    createdAt: "2026-10-12T00:00:00.000Z",
  };
}

test("historyState tracks consecutive rejects per objective and the stalled set", () => {
  const root = mkdtempSync(join(tmpdir(), "self-improve-history-"));
  const ledger = join(root, "ledger.jsonl");
  appendRow(ledger, cycleRow({ cycleId: "c1", objective: "probe.a", hypothesis: "h1", decision: "reject", reasons: ["floor_not_met"] }));
  appendRow(ledger, cycleRow({ cycleId: "c2", objective: "probe.a", hypothesis: "h2", decision: "reject", reasons: ["floor_not_met"] }));
  appendRow(ledger, cycleRow({ cycleId: "c3", objective: "probe.a", hypothesis: "h3", decision: "reject", reasons: ["guard_fail"] }));
  appendRow(ledger, cycleRow({ cycleId: "c4", objective: "probe.b", hypothesis: "h4", decision: "adopt" }));
  const state = historyState(ledger);
  assert.deepEqual(state.stalled, ["probe.a"]);
  assert.equal(state.lastRejects.length, 3);
  assert.deepEqual(state.lastRejects[2].reasons, ["guard_fail"]);
  assert.equal(state.objectives.find((entry) => entry.objective === "probe.b").consecutiveRejects, 0);
  const reset = historyState(ledger);
  assert.equal(reset.objectives.find((entry) => entry.objective === "probe.a").consecutiveRejects, 3);
  rmSync(root, { recursive: true, force: true });
});

test("duplicate hypothesis resubmission is rejected before evaluation", () => {
  const root = mkdtempSync(join(tmpdir(), "self-improve-history-"));
  const ledger = join(root, "ledger.jsonl");
  appendRow(ledger, cycleRow({ cycleId: "c1", objective: "probe.a", hypothesis: "same hypothesis", decision: "reject", reasons: ["floor_not_met"] }));
  const duplicate = checkProposalHistory({ ledgerPath: ledger, proposal: { objective: "probe.a", hypothesis: "same hypothesis" } });
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.reason, "history_duplicate_hypothesis");
  const fresh = checkProposalHistory({ ledgerPath: ledger, proposal: { objective: "probe.a", hypothesis: "different hypothesis" } });
  assert.equal(fresh.ok, true);
  rmSync(root, { recursive: true, force: true });
});

test("stalled objectives are blocked and redirects are marked forced_exploration with unexplored probes", () => {
  const root = mkdtempSync(join(tmpdir(), "self-improve-history-"));
  const ledger = join(root, "ledger.jsonl");
  for (let index = 1; index <= 3; index += 1) {
    appendRow(ledger, cycleRow({ cycleId: `c${index}`, objective: "probe.a", hypothesis: `h${index}`, decision: "reject", reasons: ["floor_not_met"] }));
  }
  const adapterObjectives = ["probe.a", "probe.b", "probe.c"];
  const blocked = checkProposalHistory({
    ledgerPath: ledger,
    proposal: { objective: "probe.a", hypothesis: "brand new" },
    adapterObjectives,
  });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, "forced_exploration");
  assert.deepEqual(blocked.unexplored, ["probe.b", "probe.c"]);
  const redirect = checkProposalHistory({
    ledgerPath: ledger,
    proposal: { objective: "probe.b", hypothesis: "redirect" },
    adapterObjectives,
  });
  assert.equal(redirect.ok, true);
  assert.equal(redirect.forcedExploration, true);
  rmSync(root, { recursive: true, force: true });
});

test("stalled objectives stay admissible when no unexplored probe remains (caps bound retries)", () => {
  const root = mkdtempSync(join(tmpdir(), "self-improve-history-"));
  const ledger = join(root, "ledger.jsonl");
  for (const objective of ["probe.a", "probe.b"]) {
    for (let index = 1; index <= 3; index += 1) {
      appendRow(
        ledger,
        cycleRow({ cycleId: `${objective}-${index}`, objective, hypothesis: `${objective}-h${index}`, decision: "reject", reasons: ["floor_not_met"] }),
      );
    }
  }
  const retry = checkProposalHistory({
    ledgerPath: ledger,
    proposal: { objective: "probe.a", hypothesis: "retry after full stall" },
    adapterObjectives: ["probe.a", "probe.b"],
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.forcedExploration, true);
  assert.equal(retry.stallRetry, true);
  rmSync(root, { recursive: true, force: true });
});
