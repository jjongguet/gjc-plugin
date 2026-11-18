import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXPERIENCE_SCHEMA,
  MAX_EXPERIENCE_ROW_BYTES,
  MIN_LEAK_TOKENS,
  appendExperience,
  assertHeldoutSeparation,
  experienceId,
  experienceRowBytes,
  invalidateExperience,
  readExperience,
  selectExperience,
  supersedeExperience,
  validateExperienceEntry,
  verifyExperienceChain,
} from "../../lib/experience.mjs";
import {
  EXPERIENCE_EVAL_CONTRACT_PATH,
  contractDigest,
  loadExperienceEvalContract,
  runExperienceEval,
} from "../../lib/experience-eval.mjs";
import { MAX_LEDGER_ROW_BYTES } from "../../lib/types.mjs";

function tempStore() {
  return join(mkdtempSync(join(tmpdir(), "self-improve-experience-")), "library.jsonl");
}

function payload(overrides = {}) {
  return {
    cue: "ledger chain prev sha256 seq mismatch",
    lesson: "Rehash the raw row line before comparing the chain.",
    evidence: "self-improve/tests/unit/ledger.test.mjs",
    source: "cycle:c-001",
    version: "1",
    outcome: "adopt",
    domain: "gjc-plugin",
    patchSha256: "a".repeat(64),
    validFrom: "2026-11-19T00:00:00.000Z",
    status: "active",
    ...overrides,
  };
}

function append(store, overrides = {}) {
  const result = appendExperience(store, payload(overrides));
  assert.equal(result.ok, true, JSON.stringify(result));
  return result;
}

function reseal(contract) {
  const copy = structuredClone(contract);
  copy.contractSha256 = contractDigest(copy);
  return copy;
}

test("entry id is deterministic over the canonical payload", () => {
  const first = validateExperienceEntry(payload());
  const second = validateExperienceEntry({ ...payload(), schema: EXPERIENCE_SCHEMA });
  const changed = validateExperienceEntry(payload({ lesson: "A different lesson." }));
  assert.equal(first.ok, true);
  assert.match(first.id, /^exp-[0-9a-f]{12}$/);
  assert.equal(first.id, second.id);
  assert.equal(first.id, experienceId(payload()));
  assert.notEqual(first.id, changed.id);
});

test("an entry requires non-empty cue, lesson and evidence", () => {
  for (const field of ["cue", "lesson", "evidence"]) {
    const missing = validateExperienceEntry(payload({ [field]: "" }));
    assert.deepEqual([missing.ok, missing.reason], [false, `${field}_missing`]);
    const blank = validateExperienceEntry(payload({ [field]: "   " }));
    assert.deepEqual([blank.ok, blank.reason], [false, `${field}_missing`]);
  }
});

test("provenance fields are required and validated", () => {
  const cases = [
    [{ source: "" }, "source_missing"],
    [{ version: "" }, "version_missing"],
    [{ domain: "" }, "domain_missing"],
    [{ domain: "not a domain!" }, "domain_invalid"],
    [{ validFrom: "not-a-date" }, "valid_from_invalid"],
    [{ outcome: "maybe" }, "outcome_invalid"],
    [{ patchSha256: "short" }, "patch_sha256_invalid"],
    [{ status: "retired" }, "status_invalid"],
  ];
  for (const [override, reason] of cases) {
    const checked = validateExperienceEntry(payload(override));
    assert.deepEqual([checked.ok, checked.reason], [false, reason], JSON.stringify(override));
  }
});

test("byte caps refuse an oversized cue/lesson/evidence", () => {
  for (const [field, size, reason] of [
    ["cue", 300, "cue_too_large"],
    ["lesson", 600, "lesson_too_large"],
    ["evidence", 600, "evidence_too_large"],
  ]) {
    const checked = validateExperienceEntry(payload({ [field]: "x".repeat(size) }));
    assert.deepEqual([checked.ok, checked.reason], [false, reason]);
  }
});

test("the row cap is the ledger cap and a maximal legal entry fits it", () => {
  const maximal = payload({
    cue: "c".repeat(256),
    lesson: "l".repeat(512),
    evidence: "e".repeat(512),
    source: "s".repeat(120),
    version: "v".repeat(32),
    domain: "g".repeat(64),
  });
  const checked = validateExperienceEntry(maximal);
  assert.equal(checked.ok, true);
  const row = { schema: EXPERIENCE_SCHEMA, op: "add", id: checked.id, ...checked.entry, seq: 1, prev: null };
  assert.equal(MAX_EXPERIENCE_ROW_BYTES, MAX_LEDGER_ROW_BYTES);
  assert.ok(experienceRowBytes(row) <= MAX_EXPERIENCE_ROW_BYTES);
});

test("append links rows with seq and sha256 prev and the chain verifies", () => {
  const store = tempStore();
  const first = append(store);
  const second = appendExperience(store, payload({ lesson: "Second lesson.", evidence: "b.mjs" }));
  assert.equal(second.ok, true);
  assert.equal(first.seq, 1);
  assert.equal(second.seq, 2);
  const read = readExperience(store);
  assert.equal(read.ok, true);
  assert.equal(read.count, 2);
  assert.equal(read.entries[0].id, first.id);
  assert.equal(read.active.length, 2);
  assert.deepEqual(verifyExperienceChain(store), { ok: true, count: 2, brokenAt: null, reason: null });
});

test("re-appending the identical entry is idempotent", () => {
  const store = tempStore();
  const first = append(store);
  const again = appendExperience(store, payload());
  assert.deepEqual([again.ok, again.duplicate, again.id], [true, true, first.id]);
  assert.equal(readExperience(store).count, 1);
});

test("a tampered row fails closed instead of returning a partial store", () => {
  const store = tempStore();
  append(store);
  appendExperience(store, payload({ lesson: "Second lesson.", evidence: "b.mjs" }));
  const original = readFileSync(store, "utf8");

  // Last row: the chain still links, so the row's own recomputed id is what fails.
  writeFileSync(store, original.replace("Second lesson.", "Tampered lesson."));
  const tampered = readExperience(store);
  assert.equal(tampered.ok, false);
  assert.equal(tampered.reason, "experience_store_corrupt");
  assert.equal(tampered.entries.length, 0);
  assert.equal(tampered.detail.reason, "id_mismatch");

  // First row: its bytes feed the next row's prev, so the chain check fires first.
  writeFileSync(store, original.replace("Rehash the raw row line", "Rehash the wrong row line"));
  assert.equal(readExperience(store).detail.reason, "prev_mismatch");

  writeFileSync(store, original.replace('"seq":2', '"seq":3'));
  assert.equal(verifyExperienceChain(store).reason, "seq_mismatch");
  assert.equal(readExperience(store).ok, false);
});

test("invalidation refuses an unknown target and cannot be self-inflicted", () => {
  const store = tempStore();
  const unknown = invalidateExperience(store, {
    target: "exp-000000000000",
    reason: "contradicted",
    source: "cycle:c-002",
    version: "1",
  });
  assert.deepEqual([unknown.ok, unknown.reason], [false, "unknown_target"]);

  const first = append(store);
  const selfAppend = appendExperience(store, payload({ status: "invalidated" }));
  assert.deepEqual([selfAppend.ok, selfAppend.reason], [false, "self_invalidation"]);
  assert.equal(readExperience(store).entries[0].status, "active");
  assert.equal(readExperience(store).entries[0].id, first.id);
});

test("invalidation is idempotent and drops the entry from selection", () => {
  const store = tempStore();
  const entry = append(store);
  const input = { target: entry.id, reason: "contradicted by cycle c-002", source: "cycle:c-002", version: "1" };
  const first = invalidateExperience(store, input);
  assert.equal(first.ok, true);
  const replay = invalidateExperience(store, input);
  assert.deepEqual([replay.ok, replay.duplicate, replay.target], [true, true, entry.id]);
  const conflicting = invalidateExperience(store, { ...input, reason: "another reason" });
  assert.deepEqual([conflicting.ok, conflicting.reason], [false, "target_not_active"]);

  const read = readExperience(store);
  assert.equal(read.entries[0].status, "invalidated");
  assert.equal(read.active.length, 0);
  const selection = selectExperience({ entries: read.entries, repo: "gjc-plugin", cueText: "ledger chain prev" });
  assert.equal(selection.status, "empty");
  assert.equal(selection.withheld.inactive, 1);
});

test("supersession needs an active replacement and refuses targeting itself", () => {
  const store = tempStore();
  const target = append(store);
  const replacement = appendExperience(store, payload({ lesson: "Replacement lesson.", evidence: "c.mjs" }));
  assert.equal(replacement.ok, true);

  const self = supersedeExperience(store, {
    target: target.id,
    replacement: target.id,
    reason: "self",
    source: "cycle:c-003",
    version: "1",
  });
  assert.deepEqual([self.ok, self.reason], [false, "self_invalidation"]);

  const unknown = supersedeExperience(store, {
    target: target.id,
    replacement: "exp-000000000000",
    reason: "replaced",
    source: "cycle:c-003",
    version: "1",
  });
  assert.deepEqual([unknown.ok, unknown.reason], [false, "unknown_replacement"]);

  const ok = supersedeExperience(store, {
    target: target.id,
    replacement: replacement.id,
    reason: "replaced by the bounded scan",
    source: "cycle:c-003",
    version: "1",
  });
  assert.equal(ok.ok, true);
  const read = readExperience(store);
  assert.equal(read.entries.find((entry) => entry.id === target.id).status, "superseded");
  assert.equal(read.active.length, 1);
  assert.equal(read.active[0].id, replacement.id);
});

test("selection is active-only and counts corrupt entries instead of throwing", () => {
  const good = validateExperienceEntry(payload());
  const selection = selectExperience({
    entries: [null, 42, {}, { ...payload(), lesson: "" }, good.entry, { ...good.entry, status: "superseded" }],
    repo: "gjc-plugin",
    cueText: "ledger chain prev sha256",
  });
  assert.equal(selection.status, "ok");
  assert.equal(selection.selected.length, 1);
  assert.equal(selection.skipped, 4);
  assert.equal(selection.withheld.inactive, 1);
  assert.equal(selection.selected[0].id, good.id);
});

test("selection ranks repo/domain match first, then cue overlap", () => {
  const domain = (cue) => entryFor({ cue, domain: "gjc-plugin" });
  const foreign = entryFor({ cue: "alpha bravo charlie delta", domain: "rules-text" });
  const strong = domain("alpha bravo charlie delta");
  const weak = domain("alpha bravo");
  const selection = selectExperience({
    entries: [foreign.raw, strong.raw, weak.raw],
    repo: "gjc-plugin",
    cueText: "alpha bravo charlie delta",
  });
  assert.deepEqual(
    selection.selected.map((entry) => entry.id),
    [strong.id, weak.id, foreign.id],
  );
});

test("selection breaks ties by id", () => {
  const first = entryFor({ cue: "alpha bravo", evidence: "one.mjs" });
  const second = entryFor({ cue: "alpha bravo", evidence: "two.mjs" });
  const expected = [first.id, second.id].sort();
  const selection = selectExperience({
    entries: [second.raw, first.raw],
    repo: "gjc-plugin",
    cueText: "alpha bravo",
  });
  assert.deepEqual(selection.selected.map((entry) => entry.id), expected);
});

test("selection is bounded by count and lesson bytes and reports truncation", () => {
  const countEntries = Array.from({ length: 8 }, (_, index) =>
    entryFor({ cue: "alpha beta", evidence: `evidence-${index}.mjs` }).raw,
  );
  const limited = selectExperience({ entries: countEntries, repo: "gjc-plugin", cueText: "alpha beta", limit: 3 });
  assert.equal(limited.selected.length, 3);
  assert.equal(limited.truncated, true);
  assert.equal(limited.withheld.countBound, 5);

  const byteEntries = [
    entryFor({ cue: "alpha beta", lesson: "l".repeat(40), evidence: "a.mjs" }).raw,
    entryFor({ cue: "alpha beta", lesson: "m".repeat(40), evidence: "b.mjs" }).raw,
  ];
  const capped = selectExperience({ entries: byteEntries, repo: "gjc-plugin", cueText: "alpha beta", maxBytes: 50 });
  assert.equal(capped.selected.length, 1);
  assert.equal(capped.bytes, 40);
  assert.equal(capped.truncated, true);
  assert.equal(capped.withheld.byteBound, 1);
});

test("selection drops entries with no domain match and no cue overlap", () => {
  const relevant = entryFor({ cue: "alpha beta", domain: "gjc-plugin" });
  const irrelevant = entryFor({ cue: "omega sigma", domain: "rules-text" });
  const selection = selectExperience({
    entries: [relevant.raw, irrelevant.raw],
    repo: "gjc-plugin",
    cueText: "alpha beta",
  });
  assert.deepEqual(selection.selected.map((entry) => entry.id), [relevant.id]);
  assert.equal(selection.withheld.notRelevant, 1);
});

test("a domain match alone does not admit a cue-unrelated entry", () => {
  const unrelated = entryFor({ cue: "omega sigma", domain: "gjc-plugin" });
  const selection = selectExperience({
    entries: [unrelated.raw],
    repo: "gjc-plugin",
    cueText: "alpha beta",
  });
  assert.equal(selection.status, "empty");
  assert.equal(selection.withheld.notRelevant, 1);
  const domainOnly = selectExperience({ entries: [unrelated.raw], repo: "gjc-plugin", cueText: "" });
  assert.deepEqual(domainOnly.selected.map((entry) => entry.id), [unrelated.id]);
});

test("a held-out answer string in the lesson is rejected", () => {
  const heldout = "the frozen answer is 7f3c9a2b41de";
  const result = assertHeldoutSeparation({
    entry: { ...payload(), lesson: `Use the frozen answer: ${heldout}.` },
    heldoutTexts: [heldout],
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "heldout_overlap");
  assert.equal(result.overlaps[0].field, "lesson");
  assert.equal(result.overlaps[0].kind, "literal");
});

test("a held-out token run embedded in the cue is rejected", () => {
  const heldout = "alpha bravo charlie delta echo foxtrot golf hotel india";
  const result = assertHeldoutSeparation({
    entry: payload({ cue: "ALPHA, bravo; charlie delta echo foxtrot golf hotel!" }),
    heldoutTexts: [heldout],
  });
  assert.equal(result.ok, false);
  assert.equal(result.overlaps[0].field, "cue");
  assert.equal(result.overlaps[0].kind, "token_run");
  assert.equal(result.overlaps[0].tokens, MIN_LEAK_TOKENS);
});

test("seven shared tokens pass and eight fail at the default threshold", () => {
  const seven = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];
  const heldout = [...seven, "hotel", "india"].join(" ");
  const sevenResult = assertHeldoutSeparation({
    entry: payload({ lesson: `${seven.join(" ")} and then unrelated words follow here` }),
    heldoutTexts: [heldout],
  });
  assert.equal(sevenResult.ok, true);
  const eightResult = assertHeldoutSeparation({
    entry: payload({ lesson: `${[...seven, "hotel"].join(" ")} and then unrelated words follow` }),
    heldoutTexts: [heldout],
  });
  assert.equal(eightResult.ok, false);
  assert.equal(eightResult.overlaps[0].tokens, 8);
});

test("an unrelated lesson passes and held-out separation fails closed without texts", () => {
  const result = assertHeldoutSeparation({
    entry: payload(),
    heldoutTexts: ["Expected guard policy token c0a1d2e3f405"],
  });
  assert.deepEqual([result.ok, result.overlaps.length], [true, 0]);
  const missing = assertHeldoutSeparation({ entry: payload(), heldoutTexts: [] });
  assert.deepEqual([missing.ok, missing.reason], [false, "heldout_texts_missing"]);
});

test("the frozen contract hashes its content and refuses edits", () => {
  const loaded = loadExperienceEvalContract();
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  assert.match(loaded.contractSha256, /^[0-9a-f]{64}$/);
  assert.equal(loaded.contractSha256, contractDigest(loaded.contract));
  assert.equal(loaded.contract.status, "frozen");
  assert.equal(loaded.contract.issue, "JJO-272");
  assert.equal(loaded.contract.misleading.countsAsGain, false);
  assert.ok(Array.isArray(loaded.contract.exclusions) && loaded.contract.exclusions.includes("heldout_overlap"));
  assert.equal(typeof loaded.contract.stoppingRule, "string");

  const tampered = structuredClone(loaded.contract);
  tampered.thresholds.minCaseGain = 1;
  const path = join(mkdtempSync(join(tmpdir(), "self-improve-contract-")), "contract.json");
  writeFileSync(path, `${JSON.stringify(tampered, null, 2)}\n`);
  const refused = loadExperienceEvalContract(path);
  assert.deepEqual([refused.ok, refused.reason], [false, "contract_hash_mismatch"]);
});

test("two evaluation runs produce byte-identical receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "self-improve-eval-"));
  const first = runExperienceEval({ outPath: join(dir, "receipt-1.json") });
  const second = runExperienceEval({ outPath: join(dir, "receipt-2.json") });
  assert.equal(first.bytes, second.bytes);
  assert.equal(first.text, second.text);
  assert.deepEqual(readFileSync(join(dir, "receipt-1.json")), readFileSync(join(dir, "receipt-2.json")));
  assert.equal(EXPERIENCE_EVAL_CONTRACT_PATH.endsWith("experience-eval-contract.json"), true);
});

test("the misleading lesson contributes no gain and is rejected", () => {
  const { receipt } = runExperienceEval();
  assert.equal(receipt.pass, true, receipt.reason);
  assert.deepEqual(receipt.cases, { planned: 4, passed: 4, failed: 0 });
  assert.deepEqual(receipt.learningOn, { cases: 4, hits: 4, hitRate: 1, misleadingGain: 0 });
  assert.deepEqual(receipt.learningOff, { cases: 4, hits: 0, hitRate: 0 });
  assert.equal(receipt.misleadingControl.selected, true);
  assert.equal(receipt.misleadingControl.verdict, "rejected");
  assert.equal(receipt.misleadingControl.effect, "harm");
  assert.equal(receipt.misleadingControl.countedAsGain, false);
  assert.equal(receipt.misleadingControl.gainContribution, 0);
});

test("the negative control fails when the misleading lesson is counted", () => {
  const honest = runExperienceEval();
  const cheated = runExperienceEval({ countMisleadingAsGain: true });
  assert.equal(honest.receipt.pass, true);
  assert.equal(cheated.receipt.pass, false);
  assert.match(cheated.receipt.reason, /misleading_counted_as_gain/);
  assert.equal(cheated.receipt.misleadingControl.countedAsGain, true);
  assert.equal(cheated.receipt.misleadingControl.gainContribution, 1);
  assert.equal(cheated.receipt.learningOn.misleadingGain, 1);
  assert.notEqual(cheated.text, honest.text);
});

test("a contract that counts the misleading lesson as a gain is refused", () => {
  const loaded = loadExperienceEvalContract();
  const broken = structuredClone(loaded.contract);
  broken.misleading.countsAsGain = true;
  const result = runExperienceEval({ contract: reseal(broken) });
  assert.equal(result.receipt.pass, false);
  assert.match(result.receipt.reason, /misleading_rule_invalid/);
});

test("a contract that is not frozen is refused even with a matching hash", () => {
  const loaded = loadExperienceEvalContract();
  const draft = structuredClone(loaded.contract);
  draft.status = "draft";
  const result = runExperienceEval({ contract: reseal(draft) });
  assert.equal(result.receipt.pass, false);
  assert.match(result.receipt.reason, /contract_not_frozen/);
});

test("a missing measurement is never a pass", () => {
  const loaded = loadExperienceEvalContract();
  assert.equal(loaded.ok, true);
  const broken = structuredClone(loaded.contract);
  broken.cases[0].expectedLesson = "exp-000000000000";
  const result = runExperienceEval({ contract: reseal(broken) });
  assert.equal(result.receipt.pass, false);
  assert.match(result.receipt.reason, /missing_measurement:case-ledger-chain/);
  assert.equal(result.receipt.cases.passed < result.receipt.cases.planned, true);
});

test("an invalid or non-finite threshold is never a pass", () => {
  const loaded = loadExperienceEvalContract();
  const broken = structuredClone(loaded.contract);
  broken.thresholds.minLearningOnHitRate = null;
  const result = runExperienceEval({ contract: reseal(broken) });
  assert.equal(result.receipt.pass, false);
  assert.match(result.receipt.reason, /invalid_threshold:minLearningOnHitRate/);
});

test("a held-out leak in the frozen library is an exclusion", () => {
  const loaded = loadExperienceEvalContract();
  const broken = structuredClone(loaded.contract);
  broken.stubLibrary[0].lesson = `${broken.stubLibrary[0].lesson} Expected ledger repair checksum 7f3c9a2b41de`;
  broken.stubLibrary[0].id = experienceId(broken.stubLibrary[0]);
  broken.cases[0].expectedLesson = broken.stubLibrary[0].id;
  const result = runExperienceEval({ contract: reseal(broken) });
  assert.equal(result.receipt.pass, false);
  assert.match(result.receipt.reason, /heldout_overlap:case-ledger-chain/);
});

/** Build one stored-shape entry plus its derived id for selection tests. */
function entryFor({ cue, lesson = "A short deterministic lesson.", evidence = "e.mjs", domain = "gjc-plugin" }) {
  const raw = payload({ cue, lesson, evidence, domain });
  const checked = validateExperienceEntry(raw);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  return { raw: { ...checked.entry, id: checked.id }, id: checked.id };
}
