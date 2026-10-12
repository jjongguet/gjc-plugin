import test from "node:test";
import assert from "node:assert/strict";
import { assertSurface, matchesEditable, validateAdapterShape } from "../../lib/domain.mjs";

test("matchesEditable supports * within a segment and ** across segments", () => {
  assert.equal(matchesEditable("jev-advisor/lib/decision.ts", ["jev-advisor/lib/decision.ts"]), true);
  assert.equal(matchesEditable("jev-advisor/src/alpha.adapter.ts", ["jev-advisor/src/*.adapter.ts"]), true);
  assert.equal(matchesEditable("jev-advisor/src/nested/alpha.adapter.ts", ["jev-advisor/src/*.adapter.ts"]), false);
  assert.equal(matchesEditable("verification-receipts/lib/runner.ts", ["verification-receipts/lib/**"]), true);
  assert.equal(matchesEditable("shared/tests/results.test.ts", ["verification-receipts/lib/**"]), false);
});

test("assertSurface enforces touched ⊆ surface ⊆ editable", () => {
  const editable = ["jev-advisor/lib/decision.ts", "jev-advisor/src/*.adapter.ts"];
  const ok = assertSurface({
    touched: ["jev-advisor/lib/decision.ts"],
    surface: ["jev-advisor/lib/decision.ts"],
    editable,
  });
  assert.equal(ok.ok, true);
  const outside = assertSurface({ touched: ["README.md"], surface: ["README.md"], editable });
  assert.equal(outside.ok, false);
  assert.equal(outside.reason, "surface_violation");
  assert.deepEqual(outside.offending, [{ path: "README.md", violation: "surface_outside_editable" }]);
  const notInSurface = assertSurface({ touched: ["x.ts"], surface: [], editable });
  assert.equal(notInSurface.ok, false);
  assert.deepEqual(notInSurface.offending, [{ path: "x.ts", violation: "touched_not_in_surface" }]);
});

test("validateAdapterShape reports missing keys and wrong types", () => {
  const shape = validateAdapterShape({
    id: "gjc-plugin",
    root: ".",
    editable: [],
    generated: [],
    protectedPaths: [],
    criticRules: [],
    budget: {},
    probes: [],
    heldout: [],
    guards: [],
    smoke: [],
  });
  assert.deepEqual(shape, { ok: true, missing: [], wrongType: [] });
  const bad = validateAdapterShape({ id: "x", editable: "not-an-array" });
  assert.equal(bad.ok, false);
  assert.ok(bad.missing.includes("guards"));
  assert.deepEqual(bad.wrongType, ["editable"]);
});
