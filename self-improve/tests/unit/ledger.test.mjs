import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendRow, ledgerCounts, readLedger, verifyChain } from "../../lib/ledger.mjs";

function tempLedgerPath() {
  return join(mkdtempSync(join(tmpdir(), "self-improve-ledger-")), "ledger.jsonl");
}

function cycleRow(overrides = {}) {
  return {
    kind: "cycle",
    cycleId: "c-001",
    domain: "gjc-plugin",
    campaignId: "camp-1",
    baseCommit: "b5554dc",
    budgetRung: 0,
    proposal: {
      source: "manual",
      patchSha256: "a".repeat(64),
      files: ["jev-advisor/lib/decision.ts"],
      hunks: 3,
    },
    hypothesisHash: "b".repeat(64),
    objective: "probe.extract_coverage",
    scores: { baseline: { value: 0.9 }, candidate: { value: 0.95 }, delta: 0.05, floor: 0.01 },
    cost: { wallMs: 1000, bytes: 2048, tokens: null },
    guards: [{ id: "root-test", status: "pass" }],
    critic: { verdict: "pass", rules: [] },
    verdict: { decision: "adopt", reasons: [] },
    createdAt: "2026-10-12T00:00:00.000Z",
    ...overrides,
  };
}

test("appendRow links rows with seq and sha256 prev chain", () => {
  const file = tempLedgerPath();
  const first = appendRow(file, cycleRow());
  const second = appendRow(
    file,
    cycleRow({ cycleId: "c-002", verdict: { decision: "reject", reasons: ["floor_not_met"] } }),
  );
  const rows = readLedger(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].seq, 1);
  assert.equal(rows[1].seq, 2);
  assert.equal(rows[0].prev, null);
  assert.equal(rows[1].prev, first.hash);
  assert.ok(second.hash.length === 64);
  assert.deepEqual(verifyChain(file), { ok: true, count: 2, brokenAt: null, reason: null });
});

test("ledgerCounts aggregates verdicts and kinds", () => {
  const file = tempLedgerPath();
  appendRow(file, cycleRow());
  appendRow(file, cycleRow({ cycleId: "c-002", verdict: { decision: "reject", reasons: ["cost_rule"] } }));
  appendRow(file, {
    kind: "adoption",
    cycleId: "c-001",
    commit: "abc1234",
    install: "not_attempted",
    createdAt: "2026-10-12T00:00:00.000Z",
  });
  const counts = ledgerCounts(file);
  assert.equal(counts.total, 3);
  assert.deepEqual(counts.byKind, { cycle: 2, adoption: 1 });
  assert.deepEqual(counts.byVerdict, { adopt: 1, reject: 1, inconclusive: 0 });
  assert.deepEqual(counts.cost, { cycleRows: 2, wallMsMeasured: 2, bytesMeasured: 2, tokensMeasured: 0, tokensNull: 2 });
  assert.equal(counts.chain.ok, true);
});

test("duplicate cycleId is rejected (crash recovery guard)", () => {
  const file = tempLedgerPath();
  appendRow(file, cycleRow());
  assert.throws(() => appendRow(file, cycleRow()), /duplicate_cycle/);
});

test("oversized rows are rejected", () => {
  const file = tempLedgerPath();
  assert.throws(() => appendRow(file, cycleRow({ objective: "x".repeat(3000) })), /ledger_row_too_large/);
});

test("tampered line breaks the chain", () => {
  const file = tempLedgerPath();
  appendRow(file, cycleRow());
  appendRow(file, cycleRow({ cycleId: "c-002" }));
  const lines = readFileSync(file, "utf8").split("\n");
  const tampered = JSON.parse(lines[0]);
  tampered.objective = "probe.tampered";
  lines[0] = JSON.stringify(tampered);
  writeFileSync(file, lines.join("\n"));
  const chain = verifyChain(file);
  assert.equal(chain.ok, false);
  assert.equal(chain.reason, "prev_mismatch");
});

test("cost.tokens may be null but wallMs must be measured", () => {
  const file = tempLedgerPath();
  assert.throws(
    () => appendRow(file, cycleRow({ cost: { wallMs: null, bytes: 10, tokens: null } })),
    /wallMs/,
  );
  appendRow(file, cycleRow({ cost: { wallMs: 0, bytes: 0, tokens: null } }));
  assert.equal(readLedger(file).length, 1);
});
