import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { appendRow, readLedger } from "../../lib/ledger.mjs";
import { exAnteFeatures, loadCorpus, scorePolicy } from "../../lib/replay.mjs";
import { sha256Hex } from "../../lib/types.mjs";

const OBJECTIVES = DOMAIN.objectives; // [probe.decision_accuracy, probe.extract_coverage, probe.egress_boundary]

function cycleRow({ cycleId, objective, hypothesis, decision = "reject", wallMs = 1000, guards = [] }) {
  return {
    kind: "cycle",
    cycleId,
    domain: "gjc-plugin",
    campaignId: "m3-test",
    baseCommit: "abcdef0",
    budgetRung: 0,
    proposal: { source: "agent", patchSha256: "a".repeat(64), files: ["jev-advisor/lib/decision.ts"], hunks: 1 },
    hypothesisHash: sha256Hex(hypothesis),
    objective,
    scores: { baseline: {}, candidate: {}, delta: decision === "adopt" ? 0.05 : 0, floor: 0.01 },
    cost: { wallMs, bytes: 100, tokens: null },
    guards: guards.length > 0 ? guards : [{ id: "build", status: "pass" }],
    critic: { verdict: "pass", rules: [] },
    verdict: { decision, reasons: decision === "adopt" ? [] : ["floor_not_met"] },
    createdAt: "2026-10-13T00:00:00.000Z",
  };
}

const adoptionRow = ({ cycleId }) => ({
  kind: "adoption",
  cycleId,
  commit: "abcdef0",
  install: "not_attempted",
  createdAt: "2026-10-13T00:00:00.000Z",
});

function writeCorpus(root, rows) {
  const ledgerPath = join(root, "ledger.jsonl");
  for (const row of rows) appendRow(ledgerPath, row);
  return ledgerPath;
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "self-improve-replay-"));
}

test("epochs are split by adoptions: adoption order is preserved and later epochs wait", () => {
  const root = tempRoot();
  const ledgerPath = writeCorpus(root, [
    cycleRow({ cycleId: "c1", objective: OBJECTIVES[0], hypothesis: "a1", wallMs: 100 }),
    cycleRow({ cycleId: "c2", objective: OBJECTIVES[0], hypothesis: "a2", decision: "adopt", wallMs: 200 }),
    adoptionRow({ cycleId: "c2" }),
    cycleRow({ cycleId: "c3", objective: OBJECTIVES[1], hypothesis: "b1", wallMs: 300 }),
    cycleRow({ cycleId: "c4", objective: OBJECTIVES[1], hypothesis: "b2", decision: "adopt", wallMs: 400 }),
    adoptionRow({ cycleId: "c4" }),
  ]);
  const corpus = loadCorpus({ ledgerPath });
  assert.equal(corpus.attempts.length, 4);
  assert.equal(corpus.adoptionCount, 2);
  assert.deepEqual(
    corpus.epochs.map((epoch) => epoch.attempts.map((attempt) => attempt.cycleId)),
    [["c1", "c2"], ["c3", "c4"]],
  );
  for (const policy of [
    { id: "B0", config: { order: "fixed", batchSize: 1, stopRule: "first_adoption", stallRedirect: false, stallK: 3 } },
    { id: "novel", config: { order: "novelty_first", batchSize: 1, stopRule: "first_adoption", stallRedirect: false, stallK: 3 } },
  ]) {
    const score = scorePolicy({ corpus, policy, adapter: DOMAIN });
    assert.equal(score.attemptsToFirstAdoption, 2, policy.id);
    const playedSeq = new Map(corpus.attempts.map((attempt) => [attempt.cycleId, attempt.seq]));
    assert.ok(score.played.includes(playedSeq.get("c2")), `${policy.id}: the adoption is played`);
    assert.equal(
      score.played.includes(playedSeq.get("c3")),
      false,
      `${policy.id}: later-epoch attempts are unreachable before the adoption that opened them`,
    );
    assert.equal(score.costMsToFirstAdoption, 300, policy.id);
    assert.deepEqual(score.worlds.map((world) => world.played.length), [2], `${policy.id}: replay stops at the first adoption`);
    assert.equal(score.played.includes(playedSeq.get("c3")), false, `${policy.id}: later-epoch attempts stay unplayed`);
  }
  rmSync(root, { recursive: true, force: true });
});

test("known optima: recorded order needs 3 attempts, round-robin and novelty reach the adoption faster", () => {
  const root = tempRoot();
  const ledgerPath = writeCorpus(root, [
    cycleRow({ cycleId: "d0", objective: OBJECTIVES[0], hypothesis: "dup", wallMs: 500 }),
    cycleRow({ cycleId: "d1", objective: OBJECTIVES[0], hypothesis: "dup", wallMs: 500 }),
    cycleRow({ cycleId: "e1", objective: OBJECTIVES[1], hypothesis: "fresh-optimum", decision: "adopt", wallMs: 200 }),
    adoptionRow({ cycleId: "e1" }),
  ]);
  const corpus = loadCorpus({ ledgerPath });
  const b0 = scorePolicy({ corpus, policy: { id: "B0", config: { order: "fixed", batchSize: 1, stopRule: "first_adoption", stallRedirect: false, stallK: 3 } }, adapter: DOMAIN });
  const b1 = scorePolicy({ corpus, policy: { id: "B1", config: { order: "round_robin", batchSize: 1, stopRule: "first_adoption", stallRedirect: false, stallK: 3 } }, adapter: DOMAIN });
  const novelty = scorePolicy({ corpus, policy: { id: "pi", config: { order: "novelty_first", batchSize: 1, stopRule: "first_adoption", stallRedirect: false, stallK: 3 } }, adapter: DOMAIN });
  assert.equal(b0.attemptsToFirstAdoption, 3);
  assert.equal(b0.costMsToFirstAdoption, 1200);
  assert.equal(b1.attemptsToFirstAdoption, 2, "round-robin skips the repeated first objective after one attempt");
  assert.equal(novelty.attemptsToFirstAdoption, 2, "the leading attempt is novel too, so novelty ties round-robin here");
  assert.equal(novelty.costMsToFirstAdoption, 700);
  assert.ok(novelty.value > b0.value, "replay value follows the plan's primary ordering");
  assert.ok(b1.value > b0.value);
  rmSync(root, { recursive: true, force: true });
});

test("ex-ante features expose only the allowed fields and ignore sealed outcomes", () => {
  const root = tempRoot();
  const ledgerPath = writeCorpus(root, [
    cycleRow({ cycleId: "x1", objective: OBJECTIVES[0], hypothesis: "same", decision: "reject", guards: [{ id: "build", status: "fail" }, { id: "test", status: "pass" }] }),
    cycleRow({ cycleId: "x2", objective: OBJECTIVES[0], hypothesis: "same", decision: "adopt" }),
    cycleRow({ cycleId: "y1", objective: OBJECTIVES[1], hypothesis: "other", decision: "adopt" }),
  ]);
  const corpus = loadCorpus({ ledgerPath });
  const attempt = corpus.attempts[1];
  const features = exAnteFeatures({ corpus, attempt, revealed: new Set([corpus.attempts[0].seq]) });
  assert.deepEqual(Object.keys(features).sort(), [
    "attemptIndexWithinBranch",
    "budgetRung",
    "files",
    "gapId",
    "hunks",
    "hypothesisNovelty",
    "objective",
    "priorGuardFailureClasses",
    "priorRevealedOutcomes",
  ]);
  assert.equal(features.attemptIndexWithinBranch, 1);
  assert.equal(features.hypothesisNovelty, false);
  assert.deepEqual(features.priorRevealedOutcomes, ["reject"]);
  assert.deepEqual(features.priorGuardFailureClasses, ["build"]);
  // sealed fields never reach the feature view: two attempts differing only in
  // verdict/delta produce identical ex-ante features
  const other = corpus.attempts[2];
  const otherFeatures = exAnteFeatures({ corpus, attempt: other, revealed: new Set() });
  assert.equal(JSON.stringify(features).includes("verdict"), false);
  assert.equal(JSON.stringify(otherFeatures).includes("adopt"), false);
  assert.equal(otherFeatures.priorRevealedOutcomes.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("replay is deterministic and the batch size changes parallelism, not the recorded set", () => {
  const root = tempRoot();
  const ledgerPath = writeCorpus(root, [
    cycleRow({ cycleId: "p1", objective: OBJECTIVES[0], hypothesis: "p1", wallMs: 100 }),
    cycleRow({ cycleId: "p2", objective: OBJECTIVES[0], hypothesis: "p2", wallMs: 100 }),
    cycleRow({ cycleId: "p3", objective: OBJECTIVES[1], hypothesis: "p3", decision: "adopt", wallMs: 100 }),
    adoptionRow({ cycleId: "p3" }),
  ]);
  const corpus = loadCorpus({ ledgerPath });
  const serial = { id: "serial", config: { order: "fixed", batchSize: 1, stopRule: "first_adoption", stallRedirect: false, stallK: 3 } };
  const batched = { id: "batched", config: { order: "fixed", batchSize: 3, stopRule: "first_adoption", stallRedirect: false, stallK: 3 } };
  const first = scorePolicy({ corpus, policy: serial, adapter: DOMAIN });
  const second = scorePolicy({ corpus, policy: serial, adapter: DOMAIN });
  assert.equal(first.scoreHash, second.scoreHash);
  assert.deepEqual(first.played, second.played);
  const wide = scorePolicy({ corpus, policy: batched, adapter: DOMAIN });
  assert.equal(wide.attemptsPlayed, first.attemptsPlayed);
  assert.ok(wide.rounds < first.rounds, "a batch reveals several attempts per round");
  assert.ok(wide.parallelism > first.parallelism);
  assert.equal(wide.attemptsToFirstAdoption, first.attemptsToFirstAdoption);
  // the corpus is a pure read model: scoring never mutates it
  assert.equal(readLedger(ledgerPath).length, 4);
  assert.deepEqual(
    corpus.attempts.map((attempt) => attempt.cycleId),
    ["p1", "p2", "p3"],
  );
  rmSync(root, { recursive: true, force: true });
});
