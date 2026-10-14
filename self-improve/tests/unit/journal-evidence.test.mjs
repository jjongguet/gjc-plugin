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
