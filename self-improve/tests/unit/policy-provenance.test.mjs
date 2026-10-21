import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const readJson = (relative) => JSON.parse(readFileSync(path.join(repoRoot, relative), "utf8"));

const policy = readJson("self-improve/policies/pi-1-25.json");
const current = readJson("self-improve/policies/current.json");
const receipt = readJson("self-improve/evidence/p2/dream-receipt-20261012.json");

test("deployed policy is the committed current pointer", () => {
  assert.equal(current.id, policy.id);
  assert.equal(current.file, "pi-1-25.json");
});

test("policy provenance matches the committed 13-attempt receipt", () => {
  assert.equal(policy.schema, "gjc.self-improve.policy.v1");
  assert.equal(receipt.schema, "gjc.self-improve.dream.v1");
  assert.equal(policy.source.corpus, receipt.corpus.ledgerSha256);
  assert.equal(policy.source.receiptHash, receipt.receiptHash);
  assert.equal(policy.source.verdict, receipt.verdict);
});

test("receipt corpus is the 13-attempt below-gate freeze", () => {
  assert.equal(receipt.corpus.attempts, 13);
  assert.equal(receipt.corpus.adoptions, 1);
  assert.equal(receipt.corpus.epochs, 2);
  assert.equal(receipt.gate.ok, false);
  assert.equal(receipt.gate.reason, "corpus_below_pass_gate");
  assert.equal(receipt.gate.validationAdoptions, 1);
});

test("receipt selected the deployed policy identity", () => {
  assert.equal(receipt.selected.id, policy.id);
  assert.deepEqual(receipt.selected.config, policy.config);
  assert.equal(receipt.seed, policy.seed);
});

test("receipt file matches its recorded digest", async () => {
  const { createHash } = await import("node:crypto");
  const bytes = readFileSync(path.join(repoRoot, "self-improve/evidence/p2/dream-receipt-20261012.json"));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "cff80dfbec86402194c509f695aa3d18431c50a023f13d347cff541b5f007b6e");
});
