/**
 * Committed fixture builder for the trajectory-distill handoff tests.
 *
 * Keeps every declared objective explored and the gated objective below the
 * stall threshold, so the loop's `forced_exploration` redirect is unreachable
 * and the request/proposer/validation path can be exercised hermetically.
 */
export const FIXTURE_GUARD = "fixture-guard";

export function cycleRow(seq, decision = "reject", objective = "probe.decision_accuracy") {
  return {
    kind: "cycle",
    schema: "gjc.self-improve.ledger.v1",
    seq,
    cycleId: `cyc-fixture-${seq}`,
    domain: "gjc-plugin",
    campaignId: "fixture",
    baseCommit: "abcdef0",
    budgetRung: 0,
    proposal: { source: "agent", patchSha256: "a".repeat(64), files: ["verification-receipts/lib/extra.ts"], hunks: 1 },
    hypothesisHash: "b".repeat(64),
    objective,
    scores: { baseline: {}, candidate: {}, delta: 0, floor: 0.01 },
    cost: { wallMs: 1, bytes: 1, tokens: null },
    guards: [{ id: "build", status: decision === "adopt" ? "pass" : "fail" }],
    critic: { verdict: "pass", rules: [] },
    verdict: { decision, reasons: decision === "adopt" ? [] : ["floor_not_met"] },
    createdAt: "2026-10-21T00:00:00.000Z",
  };
}

/**
 * One separated group: every adopt x reject pair differs by the guard label.
 * `rejects` stays below the stall threshold (k=3) on purpose.
 */
export function buildGroup({ objective, seqBase = 1, adopts = 1, rejects = 2, guard = FIXTURE_GUARD } = {}) {
  const attempts = [];
  const ledgerRows = [];
  let seq = seqBase;
  for (let i = 0; i < adopts; i += 1) {
    ledgerRows.push(cycleRow(seq, "adopt", objective));
    attempts.push({
      index: attempts.length,
      objective,
      decision: "adopt",
      hypothesisNovelty: true,
      guardFailures: [],
      budgetRung: 0,
      wallMs: 1,
      files: 1,
      hunks: 1,
      provenance: `cyc-fixture-${seq}`,
    });
    seq += 1;
  }
  for (let i = 0; i < rejects; i += 1) {
    ledgerRows.push(cycleRow(seq, "reject", objective));
    attempts.push({
      index: attempts.length,
      objective,
      decision: "reject",
      hypothesisNovelty: true,
      guardFailures: [guard],
      budgetRung: 0,
      wallMs: 1,
      files: 1,
      hunks: 1,
      provenance: `cyc-fixture-${seq}`,
    });
    seq += 1;
  }
  return { attempts, ledgerRows, nextSeq: seq };
}

/**
 * Store + ledger for the handoff test: one separated gated group and a single
 * adopting attempt for every other declared objective (so none is unexplored).
 */
export function buildFixture({
  gated = "probe.decision_accuracy",
  declared = ["probe.decision_accuracy", "probe.extract_coverage", "probe.egress_boundary"],
} = {}) {
  const episodes = [];
  const ledgerRows = [];
  let seq = 1;
  // Other declared objectives come first so the gated group's drawn-from epoch
  // lands on the ledger head (lag 0), exactly like the handoff fixture requires.
  for (const objective of declared.filter((entry) => entry !== gated)) {
    ledgerRows.push(cycleRow(seq, "adopt", objective));
    episodes.push({
      id: `ep-fixture-${objective.replace(/\./g, "-")}`,
      source: "capture",
      goal: "fixture",
      createdAt: "2026-10-21T00:00:00.000Z",
      attempts: [
        {
          index: 0,
          objective,
          decision: "adopt",
          hypothesisNovelty: true,
          guardFailures: [],
          budgetRung: 0,
          wallMs: 1,
          files: 1,
          hunks: 1,
          provenance: `cyc-fixture-${seq}`,
        },
      ],
    });
    seq += 1;
  }
  const gatedGroup = buildGroup({ objective: gated, seqBase: seq });
  ledgerRows.push(...gatedGroup.ledgerRows);
  episodes.push({ id: "ep-fixture-gated", source: "capture", goal: "fixture", createdAt: "2026-10-21T00:00:00.000Z", attempts: gatedGroup.attempts });
  return {
    store: { schema: "gjc.rrsi.store.v1", updatedAt: "2026-10-21T00:00:00.000Z", episodes },
    ledgerRows,
    declared,
    gated,
  };
}

/** Same shape, but the group's evidence is three epochs behind the ledger head. */
export function buildLaggingFixture(options = {}) {
  const fixture = buildFixture(options);
  const head = Math.max(...fixture.ledgerRows.map((row) => row.seq));
  fixture.ledgerRows.push(cycleRow(head + 1, "reject"), cycleRow(head + 2, "reject"), cycleRow(head + 3, "reject"));
  return fixture;
}
