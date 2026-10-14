import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import RULES_TEXT_DOMAIN from "../../domains/rules-text/adapter.mjs";
import { assertNoProtectedTouched, matchesEditable, validateAdapterShape } from "../../lib/domain.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

test("rules-text adapter satisfies the full domain shape contract", () => {
  const shape = validateAdapterShape(RULES_TEXT_DOMAIN);
  assert.deepEqual(shape, { ok: true, missing: [], wrongType: [] });
  assert.equal(RULES_TEXT_DOMAIN.id, "rules-text");
  assert.deepEqual([...RULES_TEXT_DOMAIN.editable], ["docs/portfolio/AGENTS.md"]);
  assert.deepEqual([...RULES_TEXT_DOMAIN.textFixtures], ["docs/portfolio/AGENTS.md"]);
  assert.deepEqual([...RULES_TEXT_DOMAIN.generated], []);
  assert.deepEqual(RULES_TEXT_DOMAIN.objectives, ["probe.rule_text_integrity", "probe.rule_link_coverage"]);
  assert.equal(RULES_TEXT_DOMAIN.probes[0].runner, "domains/rules-text/probes/run.ts");
  assert.equal(RULES_TEXT_DOMAIN.heldout[0].runner, "domains/rules-text/probes/run.ts");
  const schedule = RULES_TEXT_DOMAIN.budget;
  assert.equal(schedule.length, 3);
  for (let index = 1; index < schedule.length; index += 1) {
    assert.ok(schedule[index].maxFiles <= schedule[index - 1].maxFiles, "rungs tighten with acceptances");
    assert.ok(schedule[index].maxHunks <= schedule[index - 1].maxHunks, "rungs tighten with acceptances");
  }
});

test("editable covers exactly the rule-text target; root AGENTS.md stays excluded", () => {
  assert.equal(matchesEditable("docs/portfolio/AGENTS.md", RULES_TEXT_DOMAIN.editable), true);
  assert.equal(matchesEditable("AGENTS.md", RULES_TEXT_DOMAIN.editable), false, "untracked root AGENTS.md is not editable");
  assert.equal(matchesEditable("self-improve/lib/engine.mjs", RULES_TEXT_DOMAIN.editable), false);
});

test("protected paths still hard-reject engine and manifest edits", () => {
  assert.equal(assertNoProtectedTouched(["self-improve/lib/engine.mjs"], RULES_TEXT_DOMAIN.protectedPaths).ok, false);
  assert.equal(assertNoProtectedTouched(["package.json"], RULES_TEXT_DOMAIN.protectedPaths).ok, false);
  assert.equal(
    assertNoProtectedTouched(["docs/portfolio/AGENTS.md"], RULES_TEXT_DOMAIN.protectedPaths).ok,
    true,
  );
});

test("every editable path is tracked at HEAD", () => {
  for (const rel of RULES_TEXT_DOMAIN.editable) {
    assert.ok(existsSync(join(REPO_ROOT, rel)), `${rel} must exist`);
    const proc = spawnSync("git", ["-C", REPO_ROOT, "ls-files", "--error-unmatch", rel], { encoding: "utf8" });
    assert.equal(proc.status, 0, `${rel} must be tracked at HEAD (git add needs no -f): ${proc.stderr}`);
  }
});

test("probe runner path resolves to a real file", () => {
  const runner = join(REPO_ROOT, "self-improve", RULES_TEXT_DOMAIN.probes[0].runner);
  assert.ok(existsSync(runner), `${runner} must exist`);
});
