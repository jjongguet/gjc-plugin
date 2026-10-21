import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CANDIDATE_SCHEMA,
  DISTILL_SCHEMA,
  assessProjection,
  candidateIdFor,
  distillTrajectories,
  ledgerEpoch,
  loadCandidatePayload,
  parseMaxLag,
  parseStore,
  readStoreFile,
  separateGroup,
  validateCandidate,
} from "../../lib/distill.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_MJS = resolve(HERE, "../../scripts/run.mjs");
const OBJECTIVE = "probe.decision_accuracy";
const DECLARED = [OBJECTIVE, "probe.extract_coverage", "probe.egress_boundary"];

function tempDir() {
  return mkdtempSync(join(tmpdir(), "self-improve-distill-"));
}

function cycle(seq) {
  return { kind: "cycle", seq, cycleId: `cyc-fixture-${seq}`, verdict: { decision: seq === 1 ? "reject" : "adopt", reasons: [] } };
}

function attempt(index, overrides = {}) {
  const seq = overrides.seq ?? index + 1;
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
    provenance: `cyc-fixture-${seq}`,
    ...overrides,
  };
}

function episode(id, attempts) {
  return { id, source: "capture", goal: `goal ${id}`, createdAt: "2026-10-21T00:00:00.000Z", attempts };
}

function store(episodes) {
  return { schema: "gjc.rrsi.store.v1", updatedAt: "2026-10-21T00:00:00.000Z", episodes };
}

function distill(input) {
  const ledgerRows = input.ledgerRows ?? deriveRows(input.store);
  return distillTrajectories({
    declaredObjectives: DECLARED,
    gatedObjective: OBJECTIVE,
    ...input,
    ledgerRows,
  });
}

/** Ledger rows matching the fixture provenance (`cyc-fixture-<seq>`). */
function deriveRows(fixtureStore) {
  const seqs = new Set();
  for (const episodeRow of fixtureStore.episodes) {
    for (const row of episodeRow.attempts) {
      const match = /^cyc-fixture-(\d+)$/.exec(row.provenance ?? "");
      if (match) seqs.add(Number(match[1]));
    }
  }
  return [...seqs].sort((left, right) => left - right).map((seq) => cycle(seq));
}

test("unanimous separation emits one candidate with distinct-attempt counters", () => {
  const result = distill({
    store: store([
      episode("ep-a", [
        attempt(0, { decision: "adopt", seq: 1 }),
        attempt(1, { guardFailures: ["test"], seq: 2 }),
        attempt(2, { guardFailures: ["test"], seq: 3 }),
        attempt(3, { guardFailures: ["test"], seq: 3 }),
      ]),
    ]),
    ledgerRows: [cycle(1), cycle(2), cycle(3)],
  });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.schema, DISTILL_SCHEMA);
  const candidate = result.candidates[0];
  assert.equal(candidate.schema, CANDIDATE_SCHEMA);
  assert.match(candidate.id, /^cand-[0-9a-f]{12}$/);
  assert.equal(candidate.id, candidateIdFor(candidate));
  assert.deepEqual(candidate.contrast.feature, { kind: "guardFailures", detail: ["test"] });
  assert.deepEqual(candidate.contrast.support, { adopts: 1, rejects: 3 });
  assert.deepEqual(candidate.contrast.contradiction, { adopts: 0, rejects: 0 });
  assert.deepEqual(candidate.contrast.pairs, { total: 3, support: 3, contradiction: 0, unexplained: 0 });
  assert.deepEqual(candidate.evidence, { storeDigest: candidate.evidence.storeDigest, ledgerSeq: 3, ledgerHead: 3, lag: 0, basis: "projection" });
  assert.match(candidate.evidence.storeDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(candidate.expires, { kind: "ledger_seq", after: 3 });
});

test("a null pair classifies the group as contradicted with 1/4/1 counters", () => {
  const result = distill({
    store: store([
      episode("ep-a", [
        attempt(0, { decision: "adopt" }),
        attempt(1, { guardFailures: ["test"] }),
        attempt(2, {}),
        attempt(3, {}),
        attempt(4, {}),
        attempt(5, {}),
        attempt(6, { budgetRung: 1 }),
      ]),
    ]),
  });
  assert.equal(result.candidates.length, 0);
  const skip = result.skipped.find((entry) => entry.objective === OBJECTIVE);
  assert.equal(skip.reason, "contradicted");
  assert.deepEqual(skip.support, { adopts: 1, rejects: 1 });
  assert.deepEqual(skip.contradiction, { adopts: 1, rejects: 4 });
  assert.deepEqual(skip.unexplained, { adopts: 1, rejects: 1 });
  assert.deepEqual(skip.pairs, { total: 6, support: 1, contradiction: 4, unexplained: 1 });
  assert.equal(skip.byFeature.length, 2);
});

test("two signatures with no null pair classify as inconsistent_contrast", () => {
  const result = distill({
    store: store([
      episode("ep-a", [
        attempt(0, { decision: "adopt" }),
        attempt(1, { guardFailures: ["test"] }),
        attempt(2, { budgetRung: 1 }),
      ]),
    ]),
  });
  const skip = result.skipped.find((entry) => entry.objective === OBJECTIVE);
  assert.equal(skip.reason, "inconsistent_contrast");
  assert.deepEqual(skip.contradiction, { adopts: 0, rejects: 0 });
});

test("declared but ungated objectives report objective_not_gated before contrast analysis", () => {
  const result = distill({
    store: store([
      episode("ep-a", [attempt(0, { objective: "probe.extract_coverage", decision: "reject" })]),
      episode("ep-b", [attempt(0, { objective: "probe.egress_boundary", decision: "adopt" })]),
    ]),
  });
  const reasons = Object.fromEntries(result.skipped.map((entry) => [entry.objective, entry.reason]));
  assert.equal(reasons["probe.extract_coverage"], "objective_not_gated");
  assert.equal(reasons["probe.egress_boundary"], "objective_not_gated");
});

test("separateGroup reports missing adopt and missing reject", () => {
  assert.equal(separateGroup([attempt(0, { decision: "reject" })]).reason, "missing_adopt");
  assert.equal(separateGroup([attempt(0, { decision: "adopt" })]).reason, "missing_reject");
});

test("cost-only differences are a null pair and never an emitted rule", () => {
  const result = distill({
    store: store([
      episode("ep-a", [
        attempt(0, { decision: "adopt", wallMs: 1000 }),
        attempt(1, { wallMs: 90000 }),
      ]),
    ]),
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.skipped.find((entry) => entry.objective === OBJECTIVE).reason, "contradicted");
});

test("unbound evidence (no ledger provenance) is never emitted", () => {
  const result = distill({
    store: store([
      episode("ep-a", [
        attempt(0, { decision: "adopt", provenance: "cap-1" }),
        attempt(1, { guardFailures: ["test"], provenance: "cap-2" }),
      ]),
    ]),
    ledgerRows: [cycle(1)],
  });
  const skip = result.skipped.find((entry) => entry.objective === OBJECTIVE);
  assert.equal(skip.reason, "unbound_evidence");
  assert.deepEqual({ bound: skip.bound, unbound: skip.unbound }, { bound: 0, unbound: 2 });
});

test("declared but ungated objectives are objective_not_gated", () => {
  const result = distill({
    store: store([
      episode("ep-a", [
        attempt(0, { objective: "probe.extract_coverage", decision: "adopt" }),
        attempt(1, { objective: "probe.extract_coverage", guardFailures: ["g"] }),
      ]),
    ]),
  });
  const reasons = Object.fromEntries(result.skipped.map((entry) => [entry.objective, entry.reason]));
  assert.equal(reasons["probe.extract_coverage"], "objective_not_gated");
  assert.equal(result.groups.notGated, 1);
});

test("a declared objective with no attempts is no_attempts", () => {
  const result = distill({ store: store([]) });
  assert.deepEqual(
    result.skipped.map((entry) => entry.objective),
    [...DECLARED].sort(),
  );
  assert.ok(result.skipped.every((entry) => entry.reason === "no_attempts"));
});

test("undeclared groups are aggregated, never candidate groups", () => {
  const result = distill({
    store: store([
      episode("ep-a", [attempt(0, { objective: "free text one" }), attempt(1, { objective: "free text one" })]),
    ]),
  });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.undeclared.groups, 1);
  assert.equal(result.undeclared.attempts, 2);
  assert.deepEqual(result.skipped.map((entry) => entry.reason), ["no_attempts", "no_attempts", "no_attempts"]);
});

test("distillation is byte-identical across runs and objectives are sorted", () => {
  const input = {
    store: store([
      episode("ep-b", [attempt(0, { objective: "probe.egress_boundary", decision: "adopt" }), attempt(1, { objective: "probe.egress_boundary", guardFailures: ["g2"] })]),
      episode("ep-a", [attempt(0, { objective: "probe.extract_coverage", decision: "adopt" }), attempt(1, { objective: "probe.extract_coverage", guardFailures: ["g1"] })]),
    ]),
    ledgerRows: [cycle(1), cycle(2)],
  };
  const first = JSON.stringify(distill(input));
  const second = JSON.stringify(distill(input));
  assert.equal(first, second);
  assert.deepEqual(distill(input).scope.declared, [...DECLARED].sort());
});

test("objective filter restricts distillation to one objective", () => {
  const input = {
    store: store([
      episode("ep-a", [attempt(0, { decision: "adopt" }), attempt(1, { guardFailures: ["g1"] })]),
    ]),
  };
  assert.equal(distill(input).candidates.length, 1);
  assert.equal(distill({ ...input, objective: "probe.extract_coverage" }).candidates.length, 0);
});

test("a lagging group is withheld at max-lag 0 and emitted at max-lag >= lag", () => {
  const input = {
    store: store([episode("ep-a", [attempt(0, { decision: "adopt", seq: 1 }), attempt(1, { guardFailures: ["g"], seq: 1 })])]),
    ledgerRows: [cycle(1), cycle(2), cycle(3), cycle(4)],
  };
  const withheld = distill({ ...input, maxLag: 0 });
  assert.equal(withheld.candidates.length, 0);
  assert.deepEqual(withheld.withheld, [{ objective: OBJECTIVE, reason: "store_stale", drawnFrom: 1, ledgerHead: 4, lag: 3 }]);
  const allowed = distill({ ...input, maxLag: 3 });
  assert.equal(allowed.candidates.length, 1);
  assert.equal(allowed.candidates[0].evidence.lag, 3);
});

test("store-level projection label is context only", () => {
  assert.deepEqual(assessProjection({ maxDrawnFrom: 16, ledgerHead: 31, maxLag: 0 }), {
    maxDrawnFrom: 16,
    ledgerHead: 31,
    storeLag: 15,
    label: "stale",
  });
  assert.equal(assessProjection({ maxDrawnFrom: null, ledgerHead: 5, maxLag: 0 }).label, "unbound");
  assert.equal(assessProjection({ maxDrawnFrom: null, ledgerHead: 0, maxLag: 0 }).label, "empty");
  assert.equal(assessProjection({ maxDrawnFrom: 5, ledgerHead: 5, maxLag: 0 }).label, "fresh");
});

test("parseMaxLag accepts 0 and rejects negative or non-integer values", () => {
  assert.deepEqual(parseMaxLag(undefined), { ok: true, value: 0 });
  assert.deepEqual(parseMaxLag("0"), { ok: true, value: 0 });
  assert.deepEqual(parseMaxLag("3"), { ok: true, value: 3 });
  assert.match(parseMaxLag("-1").message, /invalid --max-lag/);
  assert.match(parseMaxLag("1.5").message, /invalid --max-lag/);
  assert.match(parseMaxLag("abc").message, /invalid --max-lag/);
});

test("invalid stores are reported, never repaired", () => {
  assert.deepEqual(parseStore("{"), { status: "invalid", store: null, reason: "corrupt" });
  assert.deepEqual(parseStore(JSON.stringify({ schema: "wrong", episodes: [] })), {
    status: "invalid",
    store: null,
    reason: "corrupt",
  });
  assert.equal(parseStore(JSON.stringify(store([]))).status, "ok");
});

test("a missing store file is a normal first-run state", () => {
  const missing = join(tempDir(), "store.json");
  assert.deepEqual(readStoreFile(missing), { status: "missing", store: null, reason: null });
});

test("ledger epoch and cycle map count cycle rows only", () => {
  assert.equal(ledgerEpoch([{ kind: "cycle", seq: 3 }, { kind: "adoption", seq: 4 }, { kind: "cycle", seq: 7 }]), 7);
  assert.equal(ledgerEpoch([]), 0);
});

test("separateGroup returns the dominant feature and full counters", () => {
  const group = [
    attempt(0, { decision: "adopt" }),
    attempt(1, { guardFailures: ["test"] }),
    attempt(2, { budgetRung: 1 }),
  ];
  const separation = separateGroup(group);
  assert.equal(separation.ok, false);
  assert.equal(separation.reason, "inconsistent_contrast");
  assert.equal(separation.feature.kind, "guardFailures");
  assert.deepEqual(separation.unexplained, { adopts: 1, rejects: 1 });
});

test("candidate loader accepts a bare candidate and rejects ambiguous payloads", () => {
  const base = distill({
    store: store([episode("ep-a", [attempt(0, { decision: "adopt" }), attempt(1, { guardFailures: ["g"] })])]),
    ledgerRows: [cycle(1), cycle(2)],
  });
  const candidate = base.candidates[0];
  assert.equal(loadCandidatePayload(JSON.stringify(candidate)).ok, true);
  assert.equal(loadCandidatePayload(JSON.stringify(base)).ok, true);
  assert.equal(loadCandidatePayload(JSON.stringify({ ...base, candidates: [candidate, candidate] })).reason, "candidate_ambiguous");
  assert.equal(loadCandidatePayload("{").reason, "candidate_unreadable");
});

test("candidate validation catches tampering, contradiction, and staleness", () => {
  const base = distill({
    store: store([episode("ep-a", [attempt(0, { decision: "adopt", seq: 1 }), attempt(1, { guardFailures: ["g"], seq: 1 })])]),
    ledgerRows: [cycle(1)],
  });
  const candidate = base.candidates[0];
  const context = { gatedObjective: OBJECTIVE, ledgerHead: 1, maxLag: 0 };
  assert.equal(validateCandidate(candidate, context), null);
  assert.equal(validateCandidate({ ...candidate, rule: "tampered" }, context), "candidate_tampered");
  const contradicted = {
    ...candidate,
    contrast: { ...candidate.contrast, contradiction: { adopts: 1, rejects: 1 } },
  };
  assert.equal(validateCandidate({ ...contradicted, id: candidateIdFor(contradicted) }, context), "candidate_contradicted");
  assert.equal(validateCandidate(candidate, { ...context, ledgerHead: 9, maxLag: 0 }), "candidate_stale");
  const inflated = { ...candidate, contrast: { ...candidate.contrast, support: { adopts: 9, rejects: 9 } } };
  assert.equal(validateCandidate({ ...inflated, id: candidateIdFor(inflated) }, context), "candidate_contrast_invalid");
  const duplicate = {
    ...candidate,
    contrast: { ...candidate.contrast, adopt: { attemptIds: [candidate.contrast.adopt.attemptIds[0], candidate.contrast.adopt.attemptIds[0]], count: 2 } },
  };
  assert.equal(validateCandidate({ ...duplicate, id: candidateIdFor(duplicate) }, context), "candidate_contrast_invalid");
  const badCount = { ...candidate, contrast: { ...candidate.contrast, adopt: { attemptIds: candidate.contrast.adopt.attemptIds, count: 99 } } };
  assert.equal(validateCandidate({ ...badCount, id: candidateIdFor(badCount) }, context), "candidate_contrast_invalid");
  assert.equal(
    validateCandidate(candidate, { ...context, expectedStoreDigest: "f".repeat(64) }),
    "candidate_store_mismatch",
  );
});

test("CLI emits the v2 payload as JSON and exits 0", () => {
  const dir = tempDir();
  const storePath = join(dir, "store.json");
  const ledgerPath = join(dir, "ledger.jsonl");
  writeFileSync(
    storePath,
    JSON.stringify(store([episode("ep-a", [attempt(0, { decision: "adopt", seq: 1 }), attempt(1, { guardFailures: ["g"], seq: 1 })])])),
  );
  writeFileSync(ledgerPath, `${JSON.stringify(cycle(1))}\n${JSON.stringify(cycle(2))}\n`);
  const run = spawnSync(process.execPath, [RUN_MJS, "distill", "--store", storePath, "--ledger", ledgerPath, "--json"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.schema, DISTILL_SCHEMA);
  assert.equal(payload.scope.gated, OBJECTIVE);
  assert.equal(payload.candidates.length, 0);
  assert.equal(payload.withheld[0].reason, "store_stale");
});

test("CLI refuses an invalid store with exit 3 and an undeclared objective with exit 2", () => {
  const dir = tempDir();
  const storePath = join(dir, "store.json");
  writeFileSync(storePath, "{");
  const corrupt = spawnSync(process.execPath, [RUN_MJS, "distill", "--store", storePath], { encoding: "utf8" });
  assert.equal(corrupt.status, 3);
  assert.match(corrupt.stderr, /store invalid \(corrupt\)/);
  const undeclared = spawnSync(process.execPath, [RUN_MJS, "distill", "--objective", "probe.nope"], { encoding: "utf8" });
  assert.equal(undeclared.status, 2);
  assert.match(undeclared.stderr, /objective_not_declared/);
});
