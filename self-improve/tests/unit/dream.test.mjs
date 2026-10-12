import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { appendRow, readLedger, verifyChain } from "../../lib/ledger.mjs";
import { candidatePolicies, enumerateCandidates, runDream } from "../../lib/dream.mjs";
import { loadCorpus } from "../../lib/replay.mjs";
import {
  applyPolicyDeploy,
  buildPolicyArtifact,
  planPolicyDeploy,
  readCurrentPolicy,
  validatePolicyShape,
} from "../../lib/policy.mjs";
import { sha256Hex } from "../../lib/types.mjs";

const [A, B, C] = DOMAIN.objectives;

function cycleRow({ cycleId, objective, hypothesis, decision = "reject", wallMs = 1000 }) {
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
    guards: [{ id: "build", status: "pass" }],
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

/**
 * Pass-gate corpus (20 attempts). Train (14): a first epoch that seeds branch
 * hypotheses (`shared-a`, `shared-b`, `shared-c`, 3 attempts), then the epoch
 * that carries the train adoption (`train-adopt-c`, novel), then 7 trailing
 * rejects. Validation (6): `val-a` (novel), two `shared-b` repeats (non-novel
 * because the train history already used that hypothesis), `val-adopt-c`
 * (novel, adopting) and two tails. The shape rewards the novelty-first rule in
 * both splits: recorded order (B0) needs 4 validation attempts, round-robin
 * (B1) 3, novelty 2.
 */
function corpusRows({ train = true, validation = true } = {}) {
  const rows = [];
  if (train) {
    rows.push(
      cycleRow({ cycleId: "x1", objective: A, hypothesis: "shared-a" }),
      cycleRow({ cycleId: "x2", objective: B, hypothesis: "shared-b" }),
      cycleRow({ cycleId: "x3", objective: C, hypothesis: "shared-c" }),
      cycleRow({ cycleId: "ta1", objective: A, hypothesis: "shared-a" }),
      cycleRow({ cycleId: "tb0", objective: B, hypothesis: "shared-b" }),
      cycleRow({ cycleId: "tb1", objective: B, hypothesis: "shared-b" }),
      cycleRow({ cycleId: "tc1", objective: C, hypothesis: "train-adopt-c", decision: "adopt" }),
      adoptionRow({ cycleId: "tc1" }),
    );
    for (let index = 0; index < 7; index += 1) {
      rows.push(cycleRow({ cycleId: `tt${index}`, objective: C, hypothesis: `train-tail-${index}` }));
    }
  }
  if (validation) {
    rows.push(
      cycleRow({ cycleId: "va1", objective: A, hypothesis: "val-a" }),
      cycleRow({ cycleId: "vb0", objective: B, hypothesis: "shared-b" }),
      cycleRow({ cycleId: "vb1", objective: B, hypothesis: "shared-b" }),
      cycleRow({ cycleId: "vc1", objective: C, hypothesis: "val-adopt-c", decision: "adopt" }),
      adoptionRow({ cycleId: "vc1" }),
      cycleRow({ cycleId: "vt0", objective: C, hypothesis: "val-tail-0" }),
      cycleRow({ cycleId: "vt1", objective: C, hypothesis: "val-tail-1" }),
    );
  }
  return rows;
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "self-improve-dream-"));
}

function writeCorpus(root, rows, name = "ledger.jsonl") {
  const ledgerPath = join(root, name);
  for (const row of rows) appendRow(ledgerPath, row);
  return ledgerPath;
}

test("dream is deterministic and evaluates the frozen thresholds at pass-gate size", () => {
  const root = tempRoot();
  try {
    const ledgerPath = writeCorpus(root, corpusRows());
    const corpus = loadCorpus({ ledgerPath });
    assert.equal(corpus.attempts.length, 20);
    assert.equal(corpus.adoptionCount, 2);
    const first = runDream({ corpus, adapter: DOMAIN, seed: 7 });
    const second = runDream({ corpus, adapter: DOMAIN, seed: 7 });
    assert.equal(JSON.stringify(first), JSON.stringify(second), "same seed must be byte-identical");
    assert.equal(first.receiptHash, second.receiptHash);
    assert.deepEqual(first.selected, second.selected);
    assert.equal(first.candidateCount, 40);
    assert.ok(first.candidateCount <= 48);
    assert.equal(first.rankings.length, 40);
    assert.equal(new Set(enumerateCandidates().map((config) => config.order)).size, 5, "every order rule stays in the space");
    assert.equal(candidatePolicies({ seed: 7 })[0].id, "pi-7-01");
    assert.equal(first.corpus.trainN, 14);
    assert.equal(first.corpus.validationN, 6);
    assert.equal(first.gate.ok, true, JSON.stringify(first.gate));
    assert.equal(first.verdict, "met", JSON.stringify(first.thresholds));
    assert.equal(first.thresholds.evaluated, true);
    assert.equal(first.thresholds.attemptsOk, true);
    assert.equal(first.thresholds.costOk, true);
    assert.equal(first.thresholds.antiFlukeOk, true);
    const selected = first.candidates.find((candidate) => candidate.id === first.selected.id);
    assert.equal(selected.validation.attemptsToFirstAdoption, 2);
    assert.equal(first.baselines.B0.validation.attemptsToFirstAdoption, 4);
    assert.equal(first.baselines.B1.validation.attemptsToFirstAdoption, 3);
    assert.match(first.caveat, /no statistical significance is claimed/);
    assert.equal(first.calibration.length >= 3, true, "calibration carries the selected policy plus both baselines");
    assert.equal(first.corpus.ledgerSha256, corpus.ledgerSha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("selection uses the train split only; the validation tail cannot change pi*", () => {
  const root = tempRoot();
  try {
    const baseLedger = writeCorpus(root, corpusRows(), "base.jsonl");
    const shiftedRows = corpusRows();
    // change only the validation tail: different walls, an extra reject, different hypotheses
    const shifted = shiftedRows.map((row) =>
      row.kind === "cycle" && ["vt0", "vt1"].includes(row.cycleId)
        ? { ...row, cost: { ...row.cost, wallMs: 9 }, hypothesisHash: sha256Hex(`shifted-${row.cycleId}`) }
        : row,
    );
    shifted.splice(shifted.length - 3, 0, cycleRow({ cycleId: "vt-extra", objective: A, hypothesis: "val-extra" }));
    const shiftedLedger = writeCorpus(root, shifted, "shifted.jsonl");
    const base = runDream({ corpus: loadCorpus({ ledgerPath: baseLedger }), adapter: DOMAIN, seed: 3 });
    const shiftedRun = runDream({ corpus: loadCorpus({ ledgerPath: shiftedLedger }), adapter: DOMAIN, seed: 3 });
    assert.equal(base.selected.id, shiftedRun.selected.id, "the validation tail must not influence selection");
    assert.deepEqual(base.selected.config, shiftedRun.selected.config);
    assert.notEqual(
      JSON.stringify(base.candidates.map((candidate) => candidate.validation)),
      JSON.stringify(shiftedRun.candidates.map((candidate) => candidate.validation)),
      "the validation data itself did change, so the equality above is meaningful",
    );
    assert.equal(base.corpus.ledgerSha256 !== shiftedRun.corpus.ledgerSha256, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the pass gate reports insufficient evidence instead of evaluating thresholds", () => {
  const root = tempRoot();
  try {
    const smallLedger = writeCorpus(root, corpusRows({ train: true, validation: false }).slice(0, 8), "small.jsonl");
    const small = runDream({ corpus: loadCorpus({ ledgerPath: smallLedger }), adapter: DOMAIN, seed: 1 });
    assert.equal(small.gate.ok, false);
    assert.equal(small.gate.reason, "corpus_below_pass_gate");
    assert.equal(small.verdict, "insufficient evidence at pass-gate size — thresholds not evaluated");
    assert.equal(small.candidates.length, 40, "measured scores are still reported");
    assert.equal(small.candidates[0].train.attemptsToFirstAdoption !== undefined, true);
    assert.equal(small.thresholds.evaluated, false, "the gate failure must not present evaluated thresholds");
    assert.equal(small.thresholds.advisory.attemptsOk !== undefined, true, "advisory numbers stay visible");

    const noAdoptionRows = corpusRows({ validation: false }).concat(
      corpusRows({ train: false, validation: true })
        .filter((row) => row.kind === "cycle")
        .map((row) => (row.cycleId === "vc1" ? { ...row, verdict: { decision: "reject", reasons: ["floor_not_met"] } } : row)),
    );
    const noAdoptionLedger = writeCorpus(root, noAdoptionRows, "no-adoption.jsonl");
    const noAdoption = runDream({ corpus: loadCorpus({ ledgerPath: noAdoptionLedger }), adapter: DOMAIN, seed: 1 });
    assert.equal(noAdoption.gate.ok, false);
    assert.equal(noAdoption.gate.reason, "validation_without_adoption");
    assert.equal(noAdoption.verdict, "insufficient evidence at pass-gate size — thresholds not evaluated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("policy artifacts validate, deploy exactly once, and the chain carries the policy row", () => {
  const root = tempRoot();
  try {
    const policyDir = join(root, "policies");
    const ledgerPath = join(root, "ledger.jsonl");
    const artifact = buildPolicyArtifact({
      id: "pi-7-01",
      seed: 7,
      config: { order: "novelty_first", batchSize: 1, stopRule: "first_adoption", stallRedirect: false, stallK: 3 },
      createdAt: "2026-10-13T00:00:00.000Z",
    });
    assert.equal(validatePolicyShape(artifact).ok, true, JSON.stringify(validatePolicyShape(artifact)));
    const bad = { ...artifact, config: { ...artifact.config, order: "bogus" } };
    assert.equal(validatePolicyShape(bad).ok, false);
    assert.match(validatePolicyShape(bad).errors.join(";"), /order/);

    const plan = planPolicyDeploy({ policyDir, policy: artifact, createdAt: "2026-10-13T00:00:00.000Z" });
    assert.equal(plan.commitMessage, "chore(self-improve): policy pi-7-01 deploy");
    const applied = applyPolicyDeploy({ plan, ledgerPath });
    assert.equal(existsSync(plan.artifactPath), true);
    assert.equal(existsSync(plan.currentPath), true);
    const current = readCurrentPolicy({ policyDir });
    assert.equal(current.id, "pi-7-01");
    assert.equal(current.sha256, sha256Hex(plan.artifactText));
    assert.equal(readFileSync(plan.artifactPath, "utf8"), plan.artifactText);
    const rows = readLedger(ledgerPath);
    assert.deepEqual(rows.map((row) => row.kind), ["policy"]);
    assert.equal(rows[0].policyId, "pi-7-01");
    assert.equal(rows[0].decision, "deploy");
    assert.equal(verifyChain(ledgerPath).ok, true);
    assert.equal(applied.rowSeq, 1);
    assert.throws(() => applyPolicyDeploy({ plan, ledgerPath }), /duplicate_policy/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
