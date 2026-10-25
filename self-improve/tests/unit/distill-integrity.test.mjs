import test from "node:test";
import assert from "node:assert/strict";
import {
  DISTILL_SCHEMA,
  candidateIdFor,
  distillTrajectories,
  flattenAttempts,
  rederiveSupport,
  validateCandidate,
} from "../../lib/distill.mjs";

const OBJECTIVE = "probe.decision_accuracy";
const DECLARED = [OBJECTIVE, "probe.extract_coverage"];

function cycle(seq) {
  return { kind: "cycle", seq, cycleId: `cyc-fixture-${seq}`, verdict: { decision: "reject", reasons: [] } };
}

function attempt(index, overrides = {}) {
  return {
    index,
    objective: OBJECTIVE,
    hypothesisNovelty: true,
    decision: "reject",
    wallMs: 1000,
    guardFailures: [],
    budgetRung: 0,
    files: 1,
    hunks: 1,
    provenance: "cyc-fixture-1",
    ...overrides,
  };
}

function episode(id, attempts) {
  return { id, source: "capture", goal: `goal ${id}`, createdAt: "2026-10-21T00:00:00.000Z", attempts };
}

function store(episodes) {
  return { schema: "gjc.rrsi.store.v1", updatedAt: "2026-10-21T00:00:00.000Z", episodes };
}

const separatedStore = () =>
  store([episode("ep-a", [attempt(0, { decision: "adopt" }), attempt(1, { guardFailures: ["g"] })])]);

function emittedCandidate(fixtureStore = separatedStore()) {
  const result = distillTrajectories({
    store: fixtureStore,
    ledgerRows: [cycle(1)],
    declaredObjectives: DECLARED,
    gatedObjective: OBJECTIVE,
  });
  assert.equal(result.candidates.length, 1);
  return { candidate: result.candidates[0], fixtureStore, result };
}

const resealed = (body) => ({ ...body, id: candidateIdFor(body) });

test("a genuine candidate re-derives from the store it was distilled from", () => {
  const { candidate, fixtureStore } = emittedCandidate();
  const attempts = flattenAttempts(fixtureStore);
  assert.deepEqual(rederiveSupport(candidate, attempts), { ok: true });
  assert.equal(validateCandidate(candidate, { gatedObjective: OBJECTIVE, ledgerHead: 1, maxLag: 0, attempts }), null);
});

test("empty support attemptIds are rejected: nothing can be re-derived from them", () => {
  const { candidate } = emittedCandidate();
  const emptied = {
    ...candidate,
    contrast: { ...candidate.contrast, adopt: { attemptIds: [], count: 1 } },
  };
  assert.equal(validateCandidate(resealed(emptied), { gatedObjective: OBJECTIVE, ledgerHead: 1, maxLag: 0 }), "candidate_contrast_invalid");
  assert.deepEqual(rederiveSupport(emptied, flattenAttempts(separatedStore())), { ok: false, reason: "support_missing" });
});

test("a future expiry cannot outlive the ledger it claims to expire against", () => {
  const { candidate } = emittedCandidate();
  const future = resealed({ ...candidate, expires: { kind: "ledger_seq", after: 5 } });
  assert.equal(validateCandidate(future, { gatedObjective: OBJECTIVE, ledgerHead: 1, maxLag: 0 }), "candidate_expiry_invalid");
});

test("an expiry before the candidate's own evidence is not an increasing sequence", () => {
  const { candidate } = emittedCandidate();
  const regressed = resealed({
    ...candidate,
    evidence: { ...candidate.evidence, ledgerSeq: 2 },
    expires: { kind: "ledger_seq", after: 1 },
  });
  assert.equal(validateCandidate(regressed, { gatedObjective: OBJECTIVE, ledgerHead: 1, maxLag: 1 }), "candidate_expiry_invalid");
});

test("support that cannot be re-derived from the referenced evidence is refused", () => {
  const { candidate, fixtureStore } = emittedCandidate();
  const inflated = resealed({
    ...candidate,
    contrast: {
      ...candidate.contrast,
      support: { adopts: 2, rejects: 1 },
      adopt: { ...candidate.contrast.adopt, count: 2 },
      pairs: { total: 2, support: 2, contradiction: 0, unexplained: 0 },
    },
  });
  const context = { gatedObjective: OBJECTIVE, ledgerHead: 1, maxLag: 0 };
  assert.equal(validateCandidate(inflated, context), null, "arithmetic alone is not proof");
  const attempts = flattenAttempts(fixtureStore);
  assert.equal(validateCandidate(inflated, { ...context, attempts }), "candidate_support_not_rederivable");
  assert.deepEqual(rederiveSupport(inflated, attempts), { ok: false, reason: "support_count_mismatch" });
});

test("a candidate referencing an attempt that is not in the evidence is refused", () => {
  const { candidate, fixtureStore } = emittedCandidate();
  const foreign = resealed({
    ...candidate,
    contrast: { ...candidate.contrast, adopt: { attemptIds: ["ep-other#0"], count: 1 } },
  });
  const attempts = flattenAttempts(fixtureStore);
  assert.equal(validateCandidate(foreign, { gatedObjective: OBJECTIVE, ledgerHead: 1, maxLag: 0, attempts }), "candidate_support_not_rederivable");
  assert.deepEqual(rederiveSupport(foreign, attempts), { ok: false, reason: "support_unresolved" });
});

test("zero candidates is a normal terminal result, not an error", () => {
  const empty = distillTrajectories({
    store: store([]),
    ledgerRows: [],
    declaredObjectives: DECLARED,
    gatedObjective: OBJECTIVE,
  });
  assert.equal(empty.schema, DISTILL_SCHEMA);
  assert.deepEqual(empty.candidates, []);
  assert.equal(empty.groups.emitted, 0);
  assert.deepEqual(empty.skipped.map((entry) => entry.reason), ["no_attempts", "no_attempts"]);

  const contradicted = distillTrajectories({
    store: store([episode("ep-a", [attempt(0, { decision: "adopt" }), attempt(1, {}), attempt(2, {})])]),
    ledgerRows: [cycle(1)],
    declaredObjectives: DECLARED,
    gatedObjective: OBJECTIVE,
  });
  assert.deepEqual(contradicted.candidates, []);
  assert.equal(contradicted.skipped.find((entry) => entry.objective === OBJECTIVE).reason, "contradicted");
});
