import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { appendRow, readLedger, verifyChain } from "../../lib/ledger.mjs";
import { sha256Hex } from "../../lib/types.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = join(REPO_ROOT, "self-improve", "scripts", "run.mjs");
const [A, B, C] = DOMAIN.objectives;

function cycleRow({ cycleId, objective, hypothesis, decision = "reject", wallMs = 1000 }) {
  return {
    kind: "cycle",
    cycleId,
    domain: "gjc-plugin",
    campaignId: "m3-integration",
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

const adoptionRow = (cycleId) => ({
  kind: "adoption",
  cycleId,
  commit: "abcdef0",
  install: "not_attempted",
  createdAt: "2026-10-13T00:00:00.000Z",
});

function syntheticRows() {
  const rows = [
    cycleRow({ cycleId: "x1", objective: A, hypothesis: "shared-a" }),
    cycleRow({ cycleId: "x2", objective: B, hypothesis: "shared-b" }),
    cycleRow({ cycleId: "x3", objective: C, hypothesis: "shared-c" }),
    cycleRow({ cycleId: "ta1", objective: A, hypothesis: "shared-a" }),
    cycleRow({ cycleId: "tb0", objective: B, hypothesis: "shared-b" }),
    cycleRow({ cycleId: "tb1", objective: B, hypothesis: "shared-b" }),
    cycleRow({ cycleId: "tc1", objective: C, hypothesis: "train-adopt-c", decision: "adopt" }),
    adoptionRow("tc1"),
  ];
  for (let index = 0; index < 7; index += 1) rows.push(cycleRow({ cycleId: `tt${index}`, objective: C, hypothesis: `train-tail-${index}` }));
  rows.push(
    cycleRow({ cycleId: "va1", objective: A, hypothesis: "val-a" }),
    cycleRow({ cycleId: "vb0", objective: B, hypothesis: "shared-b" }),
    cycleRow({ cycleId: "vb1", objective: B, hypothesis: "shared-b" }),
    cycleRow({ cycleId: "vc1", objective: C, hypothesis: "val-adopt-c", decision: "adopt" }),
    adoptionRow("vc1"),
    cycleRow({ cycleId: "vt0", objective: C, hypothesis: "val-tail-0" }),
    cycleRow({ cycleId: "vt1", objective: C, hypothesis: "val-tail-1" }),
  );
  return rows;
}

function runCli(args) {
  const proc = spawnSync(process.execPath, [CLI, ...args], { cwd: REPO_ROOT, encoding: "utf8", timeout: 120000 });
  return proc;
}

test("dream/replay/policy CLI run end-to-end over a synthetic corpus with a byte-identical receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "self-improve-dream-corpus-"));
  try {
    const ledgerPath = join(root, "ledger.jsonl");
    for (const row of syntheticRows()) appendRow(ledgerPath, row);
    const policyDir = join(root, "policies");

    const firstRun = runCli(["dream", "--ledger", ledgerPath, "--seed", "11", "--out", join(root, "receipt.json"), "--write-policy", "pi-11-01", "--policy-dir", policyDir, "--json"]);
    assert.equal(firstRun.status, 0, firstRun.stderr);
    const receipt = JSON.parse(firstRun.stdout);
    assert.equal(receipt.schema, "gjc.self-improve.dream.v1");
    assert.equal(receipt.seed, 11);
    assert.equal(receipt.gate.ok, true, JSON.stringify(receipt.gate));
    assert.equal(receipt.verdict, "met", JSON.stringify(receipt.thresholds));
    assert.equal(receipt.thresholds.evaluated, true);
    assert.equal(receipt.thresholds.attemptsOk, true);
    assert.equal(receipt.thresholds.costOk, true);
    assert.equal(receipt.thresholds.antiFlukeOk, true);
    assert.equal(existsSync(join(policyDir, "pi-11-01.json")), true, "the selected policy artifact is written");
    assert.match(receipt.caveat, /off-policy replays/);

    const secondRun = runCli(["dream", "--ledger", ledgerPath, "--seed", "11", "--out", join(root, "receipt2.json"), "--json"]);
    assert.equal(secondRun.status, 0, secondRun.stderr);
    assert.equal(readFileSync(join(root, "receipt.json"), "utf8"), readFileSync(join(root, "receipt2.json"), "utf8"), "same seed => byte-identical receipt");

    const replayBaselines = runCli(["replay", "--ledger", ledgerPath, "--json"]);
    assert.equal(replayBaselines.status, 0, replayBaselines.stderr);
    const baselines = JSON.parse(replayBaselines.stdout);
    assert.deepEqual(baselines.scores.map((score) => score.policyId), ["B0", "B1"]);
    assert.equal(baselines.corpus.attempts, 20);
    assert.equal(baselines.corpus.adoptions, 2);

    const replaySelected = runCli(["replay", "--ledger", ledgerPath, "--policy", "pi-11-01", "--policy-dir", policyDir, "--json"]);
    assert.equal(replaySelected.status, 0, replaySelected.stderr);
    const selected = JSON.parse(replaySelected.stdout).scores[0];
    const selectedInReceipt = receipt.candidates.find((candidate) => candidate.id === receipt.selected.id);
    assert.equal(selected.attemptsToFirstAdoption, selectedInReceipt.full.attemptsToFirstAdoption);
    assert.equal(selected.adoptionReached, true);

    const deploy = runCli(["policy", "--deploy", "pi-11-01", "--policy-dir", policyDir, "--ledger", ledgerPath, "--json"]);
    assert.equal(deploy.status, 0, deploy.stderr);
    const applied = JSON.parse(deploy.stdout);
    assert.equal(applied.commitMessage, "chore(self-improve): policy pi-11-01 deploy");
    assert.equal(existsSync(join(policyDir, "current.json")), true);
    const rows = readLedger(ledgerPath);
    assert.equal(rows.at(-1).kind, "policy");
    assert.equal(rows.at(-1).policyId, "pi-11-01");
    assert.equal(verifyChain(ledgerPath).ok, true);

    const list = runCli(["policy", "--list", "--policy-dir", policyDir, "--json"]);
    assert.equal(list.status, 0, list.stderr);
    const listed = JSON.parse(list.stdout);
    assert.deepEqual(listed.policies, ["pi-11-01"]);
    assert.equal(listed.current.id, "pi-11-01");

    const beforeDryRun = readLedger(ledgerPath).length;
    const dryRun = runCli(["policy", "--deploy", "pi-11-01", "--policy-dir", policyDir, "--ledger", ledgerPath, "--dry-run", "--json"]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    assert.equal(readLedger(ledgerPath).length, beforeDryRun, "a dry-run deploy appends nothing");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the repository ledger at this commit is below the pass gate, so P2 reports insufficient evidence", () => {
  const run = runCli(["dream", "--json"]);
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(run.stdout);
  assert.equal(receipt.gate.ok, false);
  assert.equal(receipt.gate.reason, "corpus_below_pass_gate");
  assert.equal(receipt.verdict, "insufficient evidence at pass-gate size — thresholds not evaluated");
  assert.equal(receipt.corpus.attempts < receipt.gate.passGateN, true);
  assert.equal(receipt.thresholds.evaluated, false, "the frozen insufficient-evidence path must not present evaluated thresholds");
  assert.equal(typeof receipt.thresholds.advisory?.attemptsOk, "boolean", "advisory numbers are still reported");
  assert.match(receipt.caveat, /no statistical significance is claimed/);
});
