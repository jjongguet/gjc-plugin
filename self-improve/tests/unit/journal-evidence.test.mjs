import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildJournalEvidence } from "../../lib/loop.mjs";

function row(kind, fields) {
  return JSON.stringify({ schema: "gjc.self-improve.ledger.v1", kind, ...fields });
}

test("buildJournalEvidence derives adoption rate from the campaign ledger and classes from loop state", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-evidence-"));
  try {
    const ledgerPath = join(root, "ledger.jsonl");
    writeFileSync(
      ledgerPath,
      [
        row("cycle", { cycleId: "c1", campaignId: "camp-a", objective: "o", verdict: { decision: "adopt", reasons: [] } }),
        row("adoption", { cycleId: "c1", commit: "abc1234", install: "not_attempted", createdAt: "x" }),
        row("cycle", { cycleId: "c2", campaignId: "camp-a", objective: "o", verdict: { decision: "reject", reasons: ["floor_not_met"] } }),
        row("cycle", { cycleId: "c3", campaignId: "camp-b", objective: "o", verdict: { decision: "reject", reasons: [] } }),
      ].join("\n") + "\n",
    );
    const evidence = buildJournalEvidence({
      ledgerPath,
      campaignId: "camp-a",
      cycles: [{ failureClass: "known_flake_suspect" }, { failureClass: "other" }, {}],
    });
    assert.equal(evidence.schema, "gjc.self-improve.journal-evidence.v1");
    assert.equal(evidence.adoptionRate, 0.5);
    assert.equal(evidence.cycleAttempts, 2, "only the campaign's cycle rows count");
    assert.equal(evidence.adoptions, 1);
    assert.deepEqual(evidence.guardFailureClasses, { known_flake_suspect: 1, other: 1 });
    assert.deepEqual(evidence.sources, {
      adoptionRate: "self-improve-ledger",
      guardFailureClasses: "loop-state",
    });
    assert.match(evidence.caveat, /never gates adoption/);
    assert.ok(JSON.stringify(evidence).length < 400, "bounded block for the 2048-byte ledger row");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("no campaign rows yields a null adoption rate (missing is not zero)", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-evidence-"));
  try {
    const ledgerPath = join(root, "ledger.jsonl");
    writeFileSync(ledgerPath, "");
    const evidence = buildJournalEvidence({ ledgerPath, campaignId: "empty-campaign", cycles: [] });
    assert.equal(evidence.adoptionRate, null);
    assert.equal(evidence.cycleAttempts, 0);
    assert.equal(evidence.adoptions, 0);
    assert.deepEqual(evidence.guardFailureClasses, { known_flake_suspect: 0, other: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fat loop cycle row with evidence stays within the 2048-byte ledger bound", () => {
  const root = mkdtempSync(join(tmpdir(), "journal-evidence-"));
  try {
    const ledgerPath = join(root, "ledger.jsonl");
    writeFileSync(ledgerPath, "");
    const evidence = buildJournalEvidence({ ledgerPath, campaignId: "fat-campaign", cycles: [] });
    // Worst plausible loop-path shape: 3-file patch, max budget rung, one
    // critic rule, seven guards, heldout map — measured against the engine's
    // MAX_LEDGER_ROW_BYTES=2048 constraint (appendRow throws on overflow).
    const row = {
      schema: "gjc.self-improve.ledger.v1",
      kind: "cycle",
      cycleId: "cyc-20261014090000-abcd",
      domain: "rules-text",
      campaignId: "loop-20261014090000-abcd",
      baseCommit: "abcdef1",
      budgetRung: 2,
      proposal: {
        source: "agent",
        patchSha256: "a".repeat(64),
        files: ["docs/portfolio/AGENTS.md", "x/y.md", "z/w.md"],
        hunks: 12,
      },
      hypothesisHash: "b".repeat(64),
      objective: "probe.rule_text_integrity",
      scores: {
        baseline: { rule_text_integrity: 0.625, link_coverage: 1, heldout_rule_text: 1 },
        candidate: { rule_text_integrity: 0.75, link_coverage: 1, heldout_rule_text: 1 },
        delta: 0.125,
        floor: 0.01,
        heldout: { ok: true, regressions: [], baseline: { heldout_rule_text: 1 }, candidate: { heldout_rule_text: 1 } },
      },
      cost: { wallMs: 123456, bytes: 4096, tokens: null },
      guards: ["build", "test", "validator", "smoke-verification", "smoke-loop", "smoke-advisor", "smoke-metrics"].map(
        (id) => ({ id, status: "pass" }),
      ),
      critic: { verdict: "pass", rules: [{ id: "critic_network", reason: "network or timer addition" }] },
      verdict: { decision: "adopt", reasons: [] },
      labels: ["text_fixture"],
      journalEvidence: evidence,
      createdAt: "2026-10-14T00:00:00.000Z",
      seq: 42,
      prev: "c".repeat(64),
    };
    const bytes = Buffer.byteLength(JSON.stringify(row), "utf8");
    assert.ok(bytes <= 2048, `fat row must fit the ledger bound (got ${bytes} bytes)`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
