import test from "node:test";
import assert from "node:assert/strict";
import { buildProposerRequest } from "../../lib/propose.mjs";

const ADAPTER = { id: "fixture", editable: ["verification-receipts/lib/**"] };
const RUNG = { index: 0, maxFiles: 3, maxHunks: 12 };

function request(contrast) {
  return buildProposerRequest({
    loopId: "loop-fixture",
    cycleIndex: 1,
    objective: "probe.decision_accuracy",
    baseCommit: "abcdef0",
    adapter: ADAPTER,
    rung: RUNG,
    failures: [],
    history: { priorAttempts: [], stalled: [], unexplored: [] },
    contrast,
  });
}

test("requests without a contrast keep the pre-candidate shape byte-for-byte", () => {
  const requestNoContrast = request(null);
  assert.equal("contrast" in requestNoContrast, false);
  assert.equal("rule" in requestNoContrast.responseContract, false);
  assert.equal(JSON.stringify(requestNoContrast), JSON.stringify(request(undefined)));
});

test("a candidate adds the contrast field and one conditional contract line", () => {
  const contrast = {
    candidateId: "cand-0123456789ab",
    objective: "probe.decision_accuracy",
    rule: "probe.decision_accuracy: rejected attempts failed guard(s) g; adopting attempts did not.",
    feature: { kind: "guardFailures", detail: ["g"] },
    adopt: { attemptIds: ["ep-a#0"], count: 1 },
    reject: { attemptIds: ["ep-a#1"], count: 1 },
    support: { adopts: 1, rejects: 1 },
    evidence: { storeDigest: "a".repeat(64), ledgerSeq: 1, ledgerHead: 1, lag: 0 },
    expires: { kind: "ledger_seq", after: 1 },
  };
  const withContrast = request(contrast);
  assert.deepEqual(withContrast.contrast, contrast);
  assert.match(withContrast.responseContract.rule, /contrast\.rule/);
  assert.equal(withContrast.schema, "gjc.self-improve.proposer-request.v1");
});
