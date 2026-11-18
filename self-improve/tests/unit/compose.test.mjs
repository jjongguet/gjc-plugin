import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeCandidatePatches } from "../../lib/engine.mjs";
import {
  MAX_COMPOSITION_EVIDENCE_BYTES,
  candidateProposalId,
  boundedCompositionEvidence,
  validateCompositionEvidence,
} from "../../lib/ledger.mjs";
import {
  MAX_COMPOSED_COMMIT_MESSAGE_CHARS,
  buildCandidateRequests,
  buildProposerRequest,
  collectCandidateProposals,
  composeCandidateProposals,
} from "../../lib/propose.mjs";
import { sha256Hex } from "../../lib/types.mjs";

const RUNG = { index: 0, maxFiles: 3, maxHunks: 12 };
const ADAPTER = {
  id: "fixture",
  editable: ["pkg/lib/**"],
  protectedPaths: ["**/tests/**"],
  objectives: ["probe.accuracy"],
  criticRules: [],
};
const HELDOUT_SENTINEL = "heldout-sentinel-value-9471";

function patchFor(file, from, to) {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", `-${from}`, `+${to}`, ""].join(
    "\n",
  );
}

function candidateFor({ file = "pkg/lib/a.ts", from = "export const a = 1;", to = "export const a = 2;", objective = "probe.accuracy" } = {}) {
  const patchText = patchFor(file, from, to);
  const patchSha256 = sha256Hex(patchText);
  return { id: candidateProposalId({ objective, patchSha256 }), objective, patchText, patchSha256 };
}

function makeRepo({ heldout = {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "self-improve-compose-unit-"));
  mkdirSync(join(root, "self-improve", "domains", "fixture", "heldout"), { recursive: true });
  mkdirSync(join(root, "pkg", "lib"), { recursive: true });
  mkdirSync(join(root, "pkg", "tests"), { recursive: true });
  writeFileSync(join(root, "pkg", "lib", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(root, "pkg", "lib", "b.ts"), "export const b = 1;\n");
  writeFileSync(join(root, "pkg", "tests", "a.test.ts"), "// protected\n");
  writeFileSync(
    join(root, "self-improve", "domains", "fixture", "heldout", "fixtures.json"),
    `${JSON.stringify(heldout, null, 2)}\n`,
  );
  return root;
}

function requestInput(overrides = {}) {
  return {
    loopId: "loop-fixture",
    cycleIndex: 4,
    objective: "probe.accuracy",
    baseCommit: "abcdef0",
    adapter: ADAPTER,
    rung: RUNG,
    failures: [],
    history: { priorAttempts: [], stalled: [], unexplored: [] },
    ...overrides,
  };
}

test("candidate identity is derived from objective and patch bytes only", () => {
  const patchSha256 = sha256Hex("patch-body");
  const first = candidateProposalId({ objective: "probe.accuracy", patchSha256 });
  assert.match(first, /^cand-[0-9a-f]{12}$/);
  assert.equal(candidateProposalId({ objective: "probe.accuracy", patchSha256 }), first);
  assert.notEqual(candidateProposalId({ objective: "probe.other", patchSha256 }), first);
  assert.notEqual(candidateProposalId({ objective: "probe.accuracy", patchSha256: sha256Hex("other") }), first);
  assert.throws(() => candidateProposalId({ objective: "", patchSha256 }), /candidate_objective_required/);
  assert.throws(() => candidateProposalId({ objective: "probe.accuracy", patchSha256: "abc" }), /candidate_patch_sha256_invalid/);
});

test("candidate requests reuse the proposer seam and stay additive", () => {
  const requests = buildCandidateRequests({ ...requestInput(), count: 3 });
  assert.equal(requests.length, 3);
  const groupIds = new Set(requests.map((entry) => entry.groupId));
  assert.equal(groupIds.size, 1);
  assert.deepEqual(
    requests.map((entry) => entry.request.cycleIndex),
    [4, 5, 6],
  );
  for (const [index, entry] of requests.entries()) {
    assert.equal(entry.request.schema, "gjc.self-improve.proposer-request.v1");
    assert.deepEqual(entry.request.candidate, { index, count: 3, groupId: entry.groupId });
    assert.match(entry.request.responseContract.candidateRule, /independent patch/);
    assert.equal("contrast" in entry.request, false);
  }
  assert.equal("candidate" in buildProposerRequest(requestInput()), false);
  assert.throws(() => buildCandidateRequests({ ...requestInput(), count: 1 }), /candidate_count_out_of_range/);
  assert.throws(() => buildCandidateRequests({ ...requestInput(), count: 5 }), /candidate_count_out_of_range/);
});

test("collected candidates carry independent ids and failed answers stay failures", () => {
  const requests = buildCandidateRequests({ ...requestInput(), count: 2 });
  const answers = new Map([
    [4, { ok: true, proposal: { hypothesis: "h-one", objective: "probe.accuracy", commitMessage: "fix(pkg): one", patchText: patchFor("pkg/lib/a.ts", "export const a = 1;", "export const a = 2;") } }],
    [5, { ok: true, proposal: { hypothesis: "h-two", objective: "probe.accuracy", commitMessage: "fix(pkg): two", patchText: patchFor("pkg/lib/b.ts", "export const b = 1;", "export const b = 2;") } }],
  ]);
  const collected = collectCandidateProposals({
    requests,
    propose: (request) => answers.get(request.cycleIndex),
  });
  assert.equal(collected.failures.length, 0);
  assert.equal(collected.candidates.length, 2);
  assert.notEqual(collected.candidates[0].id, collected.candidates[1].id);
  assert.equal(collected.candidates[0].groupId, requests[0].groupId);
  assert.deepEqual(collected.candidates[0].files, ["pkg/lib/a.ts"]);
  assert.equal(collected.candidates[0].hunks, 1);

  const incomplete = collectCandidateProposals({
    requests,
    propose: (request) => (request.cycleIndex === 4 ? { ok: false, reason: "cmd_proposer_failed" } : {
      ok: true,
      proposal: { hypothesis: "", objective: "probe.accuracy", commitMessage: "fix(pkg): two", patchText: patchFor("pkg/lib/b.ts", "export const b = 1;", "export const b = 2;") },
    }),
  });
  assert.equal(incomplete.candidates.length, 0);
  assert.deepEqual(
    incomplete.failures.map((failure) => failure.reason),
    ["cmd_proposer_failed", "candidate_proposal_incomplete"],
  );
  assert.throws(() => collectCandidateProposals({ requests, propose: null }), /candidate_proposer_required/);
});

test("merge concatenates by content id and rejects conflicts, duplicates and forged ids", () => {
  const a = candidateFor({ file: "pkg/lib/a.ts", to: "export const a = 2;" });
  const b = candidateFor({ file: "pkg/lib/b.ts", from: "export const b = 1;", to: "export const b = 2;" });
  const merged = mergeCandidatePatches({ candidates: [b, a] });
  assert.equal(merged.ok, true);
  // Deterministic source-id order, independent of the argument order: the file
  // union and the byte concatenation follow the same order.
  assert.deepEqual(merged.files, merged.sources.flatMap((source) => source.files));
  assert.deepEqual([...merged.files].sort(), ["pkg/lib/a.ts", "pkg/lib/b.ts"]);
  assert.equal(merged.hunks, 2);
  assert.deepEqual(
    merged.sources.map((source) => source.id),
    [a.id, b.id].sort(),
  );
  assert.equal(merged.patchText, [a, b].sort((left, right) => (left.id < right.id ? -1 : 1)).map((entry) => entry.patchText).join(""));

  const sameFile = candidateFor({ file: "pkg/lib/a.ts", to: "export const a = 3;" });
  const conflict = mergeCandidatePatches({ candidates: [a, sameFile] });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.reason, "composition_conflict");
  assert.deepEqual(conflict.conflicts, [{ path: "pkg/lib/a.ts", sources: [a.id, sameFile.id].sort() }]);

  const duplicate = mergeCandidatePatches({ candidates: [a, { ...a }] });
  assert.equal(duplicate.reason, "composition_duplicate_candidate");

  const forged = mergeCandidatePatches({ candidates: [a, { ...b, id: a.id }] });
  assert.equal(forged.reason, "composition_candidate_id_mismatch");

  assert.equal(mergeCandidatePatches({ candidates: [a] }).reason, "composition_requires_two_candidates");
  const tooMany = [a, b, candidateFor({ file: "pkg/lib/c.ts" }), candidateFor({ file: "pkg/lib/d.ts" }), candidateFor({ file: "pkg/lib/e.ts" })];
  assert.equal(mergeCandidatePatches({ candidates: tooMany }).reason, "composition_too_many_candidates");
});

test("composeCandidateProposals admits a clean composition through the ordinary pipeline", () => {
  const root = makeRepo();
  try {
    const a = candidateFor({ file: "pkg/lib/a.ts", to: "export const a = 2;" });
    const b = candidateFor({ file: "pkg/lib/b.ts", from: "export const b = 1;", to: "export const b = 2;" });
    const composed = composeCandidateProposals({
      candidates: [a, b],
      objective: "probe.accuracy",
      rung: RUNG,
      adapter: ADAPTER,
      repoRoot: root,
      ledgerPath: join(root, "self-improve", "ledger.jsonl"),
      patchDir: join(root, "patches"),
    });
    assert.equal(composed.ok, true, composed.reason);
    assert.equal(composed.composition.schema, "gjc.self-improve.compose.v1");
    assert.equal(composed.proposal.patchSha256, sha256Hex(composed.patchText));
    assert.equal(composed.proposal.patchSha256, composed.composition.composedSha256);
    // The composed patch is the ordered concatenation of the recorded sources by
    // content id, so the shaped proposal reports files in that same deterministic
    // order — not the caller's argument order. The set is unchanged.
    const composedFileOrder = composed.composition.sources.flatMap((source) => source.files);
    assert.deepEqual(composed.proposal.files, composedFileOrder);
    assert.deepEqual([...composedFileOrder].sort(), ["pkg/lib/a.ts", "pkg/lib/b.ts"]);
    assert.deepEqual(
      composed.composition.sources.map((source) => source.id),
      [a.id, b.id].sort(),
    );
    // A source-id order that differs from the input order must still be the order
    // of the applied patch, so the byte concatenation follows it too.
    assert.equal(
      composed.patchText,
      composed.composition.sources.map((source) => (source.id === a.id ? a.patchText : b.patchText)).join(""),
    );
    assert.equal(composed.proposal.objective, "probe.accuracy");
    assert.match(composed.proposal.hypothesis, /^composed cand-/);
    assert.ok(composed.proposal.commitMessage.length <= MAX_COMPOSED_COMMIT_MESSAGE_CHARS);

    // The proposal pipeline owns candidate identity and the patch digest; the
    // baseline fingerprint is stamped only by the candidate-probe phase, so the
    // pre-probe record validates on identity + digest here ...
    const preProbe = validateCompositionEvidence({
      composition: composed.composition,
      patchText: composed.patchText,
      requireBaseline: false,
    });
    assert.equal(preProbe.ok, true, preProbe.detail);
    assert.equal(preProbe.reason, null);
    // ... while the recording boundary refuses the same record until that phase
    // has run, rather than silently recording an unbound composition.
    const atRecordingBoundary = validateCompositionEvidence({
      composition: composed.composition,
      patchText: composed.patchText,
    });
    assert.equal(atRecordingBoundary.ok, false);
    assert.equal(atRecordingBoundary.reason, "composition_provenance_missing");
    assert.equal(atRecordingBoundary.detail, "baseline_fingerprint_missing");
    // The recorded digest is the digest of the exact bytes the engine applies —
    // the shipped patch file, not a normalized or re-ordered copy.
    const appliedBytes = readFileSync(composed.proposal.patchFile, "utf8");
    assert.equal(composed.patchText, appliedBytes);
    assert.equal(composed.composition.composedSha256, sha256Hex(appliedBytes));
    assert.equal(composed.proposal.patchSha256, sha256Hex(appliedBytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the composed patch still has to pass budget, protected-path and held-out admission", () => {
  const root = makeRepo({ heldout: { cases: { egress: [{ endpoint: HELDOUT_SENTINEL }] } } });
  try {
    const a = candidateFor({ file: "pkg/lib/a.ts", to: "export const a = 2;" });
    const b = candidateFor({ file: "pkg/lib/b.ts", from: "export const b = 1;", to: "export const b = 2;" });
    const base = {
      candidates: [a, b],
      objective: "probe.accuracy",
      adapter: ADAPTER,
      repoRoot: root,
      ledgerPath: join(root, "self-improve", "ledger.jsonl"),
    };
    const tight = composeCandidateProposals({ ...base, rung: { index: 2, maxFiles: 1, maxHunks: 12 }, patchDir: join(root, "p1") });
    assert.equal(tight.ok, false);
    assert.equal(tight.reason, "budget_precheck");

    const protectedCandidate = candidateFor({ file: "pkg/tests/a.test.ts", from: "// protected", to: "// edited" });
    const protectedComposition = composeCandidateProposals({
      ...base,
      candidates: [a, protectedCandidate],
      rung: RUNG,
      patchDir: join(root, "p2"),
    });
    assert.equal(protectedComposition.ok, false);
    assert.equal(protectedComposition.reason, "protected_precheck");

    const leaking = candidateFor({ file: "pkg/lib/b.ts", from: "export const b = 1;", to: `export const b = "${HELDOUT_SENTINEL}";` });
    const leaked = composeCandidateProposals({
      ...base,
      candidates: [a, leaking],
      rung: RUNG,
      patchDir: join(root, "p3"),
    });
    assert.equal(leaked.ok, false);
    assert.equal(leaked.reason, "heldout_verbatim_scan");

    const noObjective = composeCandidateProposals({ ...base, objective: "", rung: RUNG, patchDir: join(root, "p4") });
    assert.equal(noObjective.reason, "compose_objective_required");
    const noDir = composeCandidateProposals({ ...base, rung: RUNG, patchDir: "" });
    assert.equal(noDir.reason, "compose_patch_dir_required");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function compositionFor({ composedSha256 = null, patchText = "", sources = null, baselineFingerprint = "a".repeat(64) } = {}) {
  return {
    schema: "gjc.self-improve.compose.v1",
    composedSha256: composedSha256 ?? sha256Hex(patchText),
    baselineFingerprint,
    sources:
      sources ??
      [candidateFor({ file: "pkg/lib/a.ts" }), candidateFor({ file: "pkg/lib/b.ts", from: "export const b = 1;", to: "export const b = 2;" })].map(
        (candidate) => ({ id: candidate.id, objective: candidate.objective, patchSha256: candidate.patchSha256 }),
      ),
  };
}

test("composition provenance is refused when missing or forged", () => {
  const patchText = "composed-patch-bytes\n";
  assert.equal(validateCompositionEvidence({ composition: null, patchText }).reason, "composition_provenance_missing");
  assert.equal(
    validateCompositionEvidence({ composition: { ...compositionFor({ patchText }), schema: "other" }, patchText }).detail,
    "schema_mismatch",
  );
  assert.equal(
    validateCompositionEvidence({ composition: compositionFor({ patchText, sources: [] }), patchText }).detail,
    "sources_missing",
  );
  const noBaseline = { ...compositionFor({ patchText }), baselineFingerprint: undefined };
  assert.equal(validateCompositionEvidence({ composition: noBaseline, patchText }).detail, "baseline_fingerprint_missing");

  const forgedId = compositionFor({ patchText });
  forgedId.sources[0] = { ...forgedId.sources[0], id: "cand-000000000000" };
  assert.equal(validateCompositionEvidence({ composition: forgedId, patchText }).reason, "composition_provenance_mismatch");
  assert.equal(validateCompositionEvidence({ composition: forgedId, patchText }).detail, `source_id_not_recomputable:cand-000000000000`);

  const wrongPatch = compositionFor({ composedSha256: sha256Hex("some other patch"), patchText });
  assert.equal(validateCompositionEvidence({ composition: wrongPatch, patchText }).detail, "composed_patch_mismatch");

  const duplicated = compositionFor({ patchText });
  duplicated.sources[1] = { ...duplicated.sources[0] };
  assert.equal(validateCompositionEvidence({ composition: duplicated, patchText }).detail.startsWith("source_duplicate"), true);

  const badVerdict = compositionFor({ patchText });
  badVerdict.sources[0] = { ...badVerdict.sources[0], verdict: "maybe" };
  assert.equal(validateCompositionEvidence({ composition: badVerdict, patchText }).detail.startsWith("source_verdict_invalid"), true);
});

test("the ledger form of a composition is bounded and keeps identity", () => {
  const patchText = "composed-patch-bytes\n";
  const composition = compositionFor({ patchText });
  composition.sources = composition.sources.map((source, index) => ({
    ...source,
    objective: `probe.${"x".repeat(120)}${index}`,
    verdict: index === 0 ? "adopt" : "reject",
    reasons: ["floor_not_met", "guard_fail", "cost_rule", "heldout_regression"],
  }));
  const bounded = boundedCompositionEvidence(composition);
  assert.equal(bounded.ok, true);
  assert.ok(bounded.bytes <= MAX_COMPOSITION_EVIDENCE_BYTES, `${bounded.bytes} bytes`);
  assert.ok(JSON.stringify(bounded.evidence).length <= MAX_COMPOSITION_EVIDENCE_BYTES);
  assert.deepEqual(
    bounded.evidence.sources.map((source) => source.id),
    composition.sources.map((source) => source.id),
  );
  assert.ok(bounded.evidence.sources.every((source) => source.sha12.length === 12));
  assert.ok(bounded.evidence.sources.every((source) => source.objective.length <= 40));
  const withReasons = bounded.evidence.sources.some((source) => source.reasons !== undefined);
  if (withReasons) assert.ok(bounded.evidence.sources.every((source) => source.reasons.length <= 2));
});
