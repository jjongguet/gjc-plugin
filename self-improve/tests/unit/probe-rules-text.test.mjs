import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RUNNER = join(REPO_ROOT, "self-improve", "domains", "rules-text", "probes", "run.ts");
const FIXTURES = join(REPO_ROOT, "self-improve", "domains", "rules-text", "probes", "fixtures.json");
const HELDOUT = join(REPO_ROOT, "self-improve", "domains", "rules-text", "heldout", "fixtures.json");
const TARGET = "docs/portfolio/AGENTS.md";

// The live migration draft, used for determinism and damage-isolation checks.
const draft = readFileSync(join(REPO_ROOT, TARGET), "utf8");

// A test-owned migration draft that pins the shipped fixture semantics
// independently of the live document (the loop may legitimately repair the
// live draft later): sections 목적/저장소 레이아웃/빌드·테스트/커밋·검증 규칙
// present; 안전 경계 + 기록 규칙 missing; "bun run test" duplicated.
const MINI_DRAFT = [
  "# Mini rules",
  "",
  "## 목적",
  "",
  "- 모든 검증은 `bun run test` 전체 체인으로 수행한다.",
  "",
  "## 저장소 레이아웃",
  "",
  "- 명령 정의는 [package.json](../../package.json)이다.",
  "",
  "## 빌드·테스트",
  "",
  "- 전체 검증: `bun run test`",
  "- 빌드: `bun run build`",
  "- 원장: [ledger](../../self-improve/ledger.jsonl), 설정: [rrsi.json](../../self-improve/rrsi.json)",
  "",
  "## 커밋·검증 규칙",
  "",
  "- 변경 파일만 스테이징한다.",
  "",
].join("\n");

function runRunner(baseline, candidate) {
  return spawnSync("bun", [RUNNER, "--baseline", baseline, "--candidate", candidate, "--json"], {
    encoding: "utf8",
    timeout: 60000,
  });
}

function makeSide(root, name, content) {
  const dir = join(root, name);
  mkdirSync(join(dir, "docs", "portfolio"), { recursive: true });
  if (content !== null) {
    writeFileSync(join(dir, TARGET), content, "utf8");
    // Link targets the mini draft references (relative to docs/portfolio/).
    writeFileSync(join(dir, "package.json"), "{}\n");
    mkdirSync(join(dir, "self-improve"), { recursive: true });
    writeFileSync(join(dir, "self-improve", "ledger.jsonl"), "");
    writeFileSync(join(dir, "self-improve", "rrsi.json"), "{}\n");
  }
  return dir;
}

test("runner is deterministic and emits byte-identical stdout for identical inputs", () => {
  const root = mkdtempSync(join(tmpdir(), "rules-probe-"));
  try {
    const a = makeSide(root, "a", draft);
    const b = makeSide(root, "b", draft);
    const r1 = runRunner(a, b);
    const r2 = runRunner(a, b);
    assert.equal(r1.status, 0, r1.stderr);
    assert.equal(r2.status, 0, r2.stderr);
    assert.equal(r1.stdout, r2.stdout, "identical inputs must yield byte-identical stdout");
    const out = JSON.parse(r1.stdout);
    assert.equal(out.schema, "gjc.self-improve.probe.v1");
    assert.equal(out.primary, "rule_text_integrity");
    assert.equal(out.delta, 0, "delta must be 0 when both sides hold identical content");
    assert.equal(r1.stdout.includes(root), false, "stdout must not embed scratch paths");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a single damaged case flips only its owning label", () => {
  const root = mkdtempSync(join(tmpdir(), "rules-probe-"));
  try {
    // Test-owned draft: the check stays valid even if a later editor renames
    // sections in the live migration draft.
    const clean = makeSide(root, "clean", MINI_DRAFT);
    const damaged = makeSide(root, "damaged", MINI_DRAFT.replace("## 목적\n", ""));
    const r = runRunner(clean, damaged);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const added = out.failures.candidate.rule_text_integrity.filter(
      (label) => !out.failures.baseline.rule_text_integrity.includes(label),
    );
    const removed = out.failures.baseline.rule_text_integrity.filter(
      (label) => !out.failures.candidate.rule_text_integrity.includes(label),
    );
    assert.deepEqual(added, ["rule_text_integrity#0"], "removing ## 목적 flips exactly case 0");
    assert.deepEqual(removed, [], "no other case may flip");
    assert.deepEqual(out.failures.candidate.link_coverage, out.failures.baseline.link_coverage);
    assert.equal(out.heldout.candidate.heldout_rule_text, out.heldout.baseline.heldout_rule_text);
    const cases = JSON.parse(readFileSync(FIXTURES, "utf8")).cases.rule_text_integrity.length;
    assert.equal(out.delta, -1 / cases);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shipped fixtures pin the migration gaps and headroom semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "rules-probe-"));
  try {
    const a = makeSide(root, "a", MINI_DRAFT);
    const b = makeSide(root, "b", MINI_DRAFT);
    const r = runRunner(a, b);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8"));
    const heldout = JSON.parse(readFileSync(HELDOUT, "utf8"));
    assert.equal(out.counts.rule_text_integrity, fixtures.cases.rule_text_integrity.length);
    assert.equal(out.counts.link_coverage, fixtures.cases.link_coverage.length);
    assert.equal(out.counts.heldout_rule_text, heldout.cases.heldout_rule_text.length);
    assert.equal(out.baseline.rule_text_integrity, 0.625, "5 of 8 contract cases hold on the mini draft");
    assert.deepEqual(out.failures.baseline.rule_text_integrity, [
      "rule_text_integrity#3",
      "rule_text_integrity#4",
      "rule_text_integrity#6",
    ]);
    assert.equal(out.baseline.link_coverage, 1);
    assert.equal(out.heldout.baseline.heldout_rule_text, 1);
    for (const entry of out.failureDetails.baseline.rule_text_integrity) {
      assert.ok(entry.summary.startsWith("rule_text_integrity#"));
      assert.ok(entry.summary.length <= 240);
    }
    assert.equal(JSON.stringify(out.failures).includes("heldout"), false, "held-out labels never leak");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing target scores zero without crashing", () => {
  const root = mkdtempSync(join(tmpdir(), "rules-probe-"));
  try {
    const empty = makeSide(root, "empty", null);
    const r = runRunner(empty, empty);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.baseline.rule_text_integrity, 0);
    assert.equal(out.baseline.link_coverage, 0);
    assert.equal(out.counts.rule_text_integrity > 0, true);
    assert.equal(out.failures.baseline.rule_text_integrity.length, out.counts.rule_text_integrity);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
