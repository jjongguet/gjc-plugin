import test from "node:test";
import assert from "node:assert/strict";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { assertNoProtectedTouched, assertSurface, matchesEditable, validateAdapterShape } from "../../lib/domain.mjs";
import { DEFAULT_SCHEDULE } from "../../lib/budget.mjs";

test("adapter shape is valid and budget matches the annealed default", () => {
  assert.deepEqual(validateAdapterShape(DOMAIN), { ok: true, missing: [], wrongType: [] });
  assert.deepEqual(DOMAIN.budget, [...DEFAULT_SCHEDULE]);
  assert.equal(DOMAIN.id, "gjc-plugin");
});

test("editable allowlist covers exact and glob source paths only", () => {
  assert.equal(matchesEditable("jev-advisor/lib/decision.ts", DOMAIN.editable), true);
  assert.equal(matchesEditable("jev-advisor/src/hook.adapter.ts", DOMAIN.editable), true);
  assert.equal(matchesEditable("verification-receipts/lib/receipts.ts", DOMAIN.editable), true);
  assert.equal(matchesEditable("verification-receipts/src/run.adapter.ts", DOMAIN.editable), true);
  assert.equal(matchesEditable("jev-advisor/subskills/jev-advisor/SKILL.md", DOMAIN.editable), true);
  assert.ok(DOMAIN.textFixtures.includes("jev-advisor/subskills/jev-advisor/SKILL.md"));
  assert.equal(matchesEditable("jev-advisor/hooks/jev-advisor.ts", DOMAIN.editable), false);
  assert.equal(matchesEditable("ui-regression/lib/aside.ts", DOMAIN.editable), false);
  assert.equal(matchesEditable("README.md", DOMAIN.editable), false);
});

test("generated surfaces are declared and excluded from editable", () => {
  for (const candidate of [
    "jev-advisor/hooks/jev-advisor.ts",
    "jev-advisor/tools/jev-advise.ts",
    "verification-receipts/tools/verification-run.ts",
    "verification-receipts/hooks/verification-gate.ts",
    "ui-regression/tools/ui-regression-run.ts",
  ]) {
    assert.equal(matchesEditable(candidate, DOMAIN.generated), true, candidate);
    assert.equal(matchesEditable(candidate, DOMAIN.editable), false, candidate);
  }
});

test("surface gate enforces touched ⊆ surface ⊆ editable", () => {
  const ok = assertSurface({
    touched: ["jev-advisor/lib/decision.ts"],
    surface: ["jev-advisor/lib/decision.ts"],
    editable: DOMAIN.editable,
  });
  assert.equal(ok.ok, true);
  const bad = assertSurface({ touched: ["README.md"], surface: ["README.md"], editable: DOMAIN.editable });
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "surface_violation");
});

test("protected paths hard-reject tests, verifiers, manifests and self-improve itself", () => {
  for (const candidate of [
    "jev-advisor/tests/decision.test.ts",
    "verification-receipts/scripts/verify.ts",
    "package.json",
    "gjc-plugin.json",
    "self-improve/lib/isolate.mjs",
    "jev-advisor/.env",
  ]) {
    const verdict = assertNoProtectedTouched([candidate], DOMAIN.protectedPaths);
    assert.equal(verdict.ok, false, candidate);
    assert.equal(verdict.reason, "protected_path_touched");
  }
  const clean = assertNoProtectedTouched(["jev-advisor/lib/decision.ts"], DOMAIN.protectedPaths);
  assert.equal(clean.ok, true);
});

test("critic rules compile and carry stable ids/reasons", () => {
  assert.ok(DOMAIN.criticRules.length > 0);
  for (const rule of DOMAIN.criticRules) {
    assert.match(rule.id, /^critic_/);
    assert.ok(rule.reason.length > 0);
    assert.doesNotThrow(() => new RegExp(rule.pattern, rule.flags));
  }
  const ids = DOMAIN.criticRules.map((rule) => rule.id);
  assert.equal(new Set(ids).size, ids.length);
});

test("guards declare deterministic checkers plus isolated smoke surfaces", () => {
  assert.deepEqual(
    DOMAIN.guards.map((guard) => guard.id),
    ["build", "test", "validator"],
  );
  assert.deepEqual(
    DOMAIN.smoke.map((entry) => entry.id),
    ["smoke-verification", "smoke-loop", "smoke-advisor", "smoke-metrics"],
  );
  for (const entry of DOMAIN.smoke) {
    assert.ok(entry.plugin.length > 0);
    assert.ok(Array.isArray(entry.args) && entry.args.length === 1);
  }
});
