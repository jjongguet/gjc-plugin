import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  contrastFor,
  distillTrajectories,
  ledgerEpoch,
  parseStore,
  readStoreFile,
} from "../../lib/distill.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RUN_MJS = resolve(HERE, "../../scripts/run.mjs");
const OBJECTIVE = "probe.extract_coverage";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "self-improve-distill-"));
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
    ...overrides,
  };
}

function episode(id, attempts) {
  return { id, source: "capture", goal: `goal ${id}`, createdAt: "2026-10-21T00:00:00.000Z", attempts };
}

function store(episodes) {
  return { schema: "gjc.rrsi.store.v1", updatedAt: "2026-10-21T00:00:00.000Z", episodes };
}

test("contrast on guard failures yields one candidate with evidence and expiry", () => {
  const result = distillTrajectories({
    store: store([
      episode("ep-a", [attempt(0, { decision: "adopt" }), attempt(1, { guardFailures: ["flaky-test"] })]),
    ]),
    ledgerRows: [{ kind: "cycle", seq: 4 }],
  });
  assert.equal(result.candidates.length, 1);
  const candidate = result.candidates[0];
  assert.match(candidate.id, /^cand-[0-9a-f]{12}$/);
  assert.equal(candidate.objective, OBJECTIVE);
  assert.equal(candidate.contrast.adopt.attemptId, "ep-a#0");
  assert.equal(candidate.contrast.reject.attemptId, "ep-a#1");
  assert.deepEqual(candidate.contrast.feature, { kind: "guardFailures", detail: ["flaky-test"] });
  assert.match(candidate.rule, /flaky-test/);
  assert.match(candidate.evidence.storeDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual(candidate.expires, { kind: "ledger_seq", after: 4 });
});

test("missing adopt or reject attempts are skipped, never synthesized", () => {
  const result = distillTrajectories({
    store: store([
      episode("ep-a", [attempt(0, { objective: "probe.one", decision: "reject" })]),
      episode("ep-b", [attempt(0, { objective: "probe.two", decision: "adopt" })]),
    ]),
  });
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.skipped, [
    { objective: "probe.one", reason: "missing_adopt" },
    { objective: "probe.two", reason: "missing_reject" },
  ]);
});

test("budget rung is the fallback contrast when guard failures match", () => {
  const result = distillTrajectories({
    store: store([
      episode("ep-a", [
        attempt(0, { decision: "adopt", budgetRung: 1 }),
        attempt(1, { decision: "reject", budgetRung: 0 }),
      ]),
    ]),
  });
  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0].contrast.feature, { kind: "budgetRung", detail: [1, 0] });
  assert.match(result.candidates[0].rule, /budget rung 1/);
});

test("cost-only differences are not admissible and are skipped", () => {
  const result = distillTrajectories({
    store: store([
      episode("ep-a", [
        attempt(0, { decision: "adopt", wallMs: 1000 }),
        attempt(1, { decision: "reject", wallMs: 90000 }),
      ]),
    ]),
  });
  assert.equal(result.candidates.length, 0);
  assert.deepEqual(result.skipped, [{ objective: OBJECTIVE, reason: "no_differing_feature" }]);
});

test("distillation is byte-identical across runs and objective order is stable", () => {
  const input = store([
    episode("ep-b", [attempt(0, { objective: "probe.b", decision: "adopt" }), attempt(1, { objective: "probe.b", guardFailures: ["g2"] })]),
    episode("ep-a", [attempt(0, { objective: "probe.a", decision: "adopt" }), attempt(1, { objective: "probe.a", guardFailures: ["g1"] })]),
  ]);
  const first = JSON.stringify(distillTrajectories({ store: input }));
  const second = JSON.stringify(distillTrajectories({ store: input }));
  assert.equal(first, second);
  const objectives = distillTrajectories({ store: input }).candidates.map((candidate) => candidate.objective);
  assert.deepEqual(objectives, ["probe.a", "probe.b"]);
});

test("objective filter restricts distillation to one objective", () => {
  const input = store([
    episode("ep-a", [attempt(0, { objective: "probe.a", decision: "adopt" }), attempt(1, { objective: "probe.a", guardFailures: ["g1"] })]),
    episode("ep-b", [attempt(0, { objective: "probe.b", decision: "adopt" }), attempt(1, { objective: "probe.b", guardFailures: ["g2"] })]),
  ]);
  const result = distillTrajectories({ store: input, objective: "probe.b" });
  assert.deepEqual(result.candidates.map((candidate) => candidate.objective), ["probe.b"]);
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

test("ledger epoch counts cycle rows only", () => {
  assert.equal(ledgerEpoch([{ kind: "cycle", seq: 3 }, { kind: "adoption", seq: 4 }, { kind: "cycle", seq: 7 }]), 7);
  assert.equal(ledgerEpoch([]), 0);
});

test("contrastFor ignores adopting-only guard failures", () => {
  const adopt = { guardFailures: ["only-adopt"], budgetRung: 0, hypothesisNovelty: true };
  const reject = { guardFailures: [], budgetRung: 0, hypothesisNovelty: true };
  assert.equal(contrastFor(adopt, reject), null);
});

test("CLI emits candidates as JSON and exits 0", () => {
  const dir = tempDir();
  const storePath = join(dir, "store.json");
  const ledgerPath = join(dir, "ledger.jsonl");
  writeFileSync(storePath, JSON.stringify(store([episode("ep-a", [attempt(0, { decision: "adopt" }), attempt(1, { guardFailures: ["flaky-test"] })])])));
  writeFileSync(ledgerPath, `${JSON.stringify({ kind: "cycle", seq: 2 })}\n`);
  const run = spawnSync(process.execPath, [RUN_MJS, "distill", "--store", storePath, "--ledger", ledgerPath, "--json"], {
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout);
  assert.equal(payload.store.status, "ok");
  assert.equal(payload.ledger.seq, 2);
  assert.equal(payload.candidates.length, 1);
  assert.equal(payload.candidates[0].contrast.feature.kind, "guardFailures");
});

test("CLI refuses an invalid store with exit 3", () => {
  const dir = tempDir();
  const storePath = join(dir, "store.json");
  writeFileSync(storePath, "{");
  const run = spawnSync(process.execPath, [RUN_MJS, "distill", "--store", storePath], { encoding: "utf8" });
  assert.equal(run.status, 3);
  assert.match(run.stderr, /store invalid \(corrupt\)/);
});
