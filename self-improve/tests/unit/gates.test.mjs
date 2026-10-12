import test from "node:test";
import assert from "node:assert/strict";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { rungFor } from "../../lib/budget.mjs";
import { buildCriticFindings, decideCycle, evaluateCostRule, evaluateHeldout, noiseFloor } from "../../lib/gates.mjs";

const rung = rungFor(0);

test("critic blocks protected edits and out-of-surface paths", () => {
  const findings = buildCriticFindings({
    patchText: "diff --git a/jev-advisor/tests/decision.test.ts b/jev-advisor/tests/decision.test.ts\n+// edited\n",
    touched: ["jev-advisor/tests/decision.test.ts"],
    surface: ["jev-advisor/tests/decision.test.ts"],
    adapter: DOMAIN,
    rung,
    hunks: 1,
  });
  assert.equal(findings.verdict, "block");
  const ids = findings.rules.map((rule) => rule.id);
  assert.ok(ids.includes("critic_protected") || ids.includes("critic_surface"), ids.join(","));
});

test("critic blocks secret-like and network additions inside editable diffs", () => {
  const secret = buildCriticFindings({
    patchText: 'diff --git a/jev-advisor/lib/decision.ts b/jev-advisor/lib/decision.ts\n+const API_KEY = "x";\n',
    touched: ["jev-advisor/lib/decision.ts"],
    surface: ["jev-advisor/lib/decision.ts"],
    adapter: DOMAIN,
    rung,
    hunks: 1,
  });
  assert.ok(secret.rules.some((rule) => rule.id === "critic_secret"));
  const timerCall = ["set", "Interval(() => {}, 10)"].join("");
  const network = buildCriticFindings({
    patchText: `diff --git a/jev-advisor/lib/decision.ts b/jev-advisor/lib/decision.ts\n+const x = ${timerCall};\n`,
    touched: ["jev-advisor/lib/decision.ts"],
    surface: ["jev-advisor/lib/decision.ts"],
    adapter: DOMAIN,
    rung,
    hunks: 1,
  });
  assert.ok(network.rules.some((rule) => rule.id === "critic_network"));
});

test("critic passes a clean editable edit and flags held-out literals", () => {
  const clean = buildCriticFindings({
    patchText: "diff --git a/jev-advisor/lib/decision.ts b/jev-advisor/lib/decision.ts\n-const a = 1;\n+const a = 2;\n",
    touched: ["jev-advisor/lib/decision.ts"],
    surface: ["jev-advisor/lib/decision.ts"],
    adapter: DOMAIN,
    rung,
    hunks: 1,
  });
  assert.equal(clean.verdict, "pass");
  const hardcode = buildCriticFindings({
    patchText: 'diff --git a/jev-advisor/lib/decision.ts b/jev-advisor/lib/decision.ts\n+const t = "HELDOUT_1";\n',
    touched: ["jev-advisor/lib/decision.ts"],
    surface: ["jev-advisor/lib/decision.ts"],
    adapter: DOMAIN,
    rung,
    hunks: 1,
  });
  assert.ok(hardcode.rules.some((rule) => rule.id === "critic_fixture_hardcode"));
});

test("noise floor: deterministic minDelta, stochastic spread", () => {
  assert.equal(noiseFloor({ minDelta: 0.01 }), 0.01);
  assert.equal(noiseFloor({ minDelta: 0.01, stochastic: true, baselineRuns: [0.5, 0.62, 0.55] }), 0.12);
  assert.equal(noiseFloor({ minDelta: 0.02, stochastic: true, baselineRuns: [0.5] }), 0.02);
});

test("cost rule requires a 2x-floor gain when cost rises over 15%", () => {
  const baselineCost = { wallMs: 1000, bytes: 1000 };
  const mild = evaluateCostRule({
    baselineCost,
    candidateCost: { wallMs: 1100, bytes: 1000 },
    delta: 0.01,
    floor: 0.01,
    config: { wallMsBytesIncreaseRatio: 0.15, gainMultipleOfFloor: 2 },
  });
  assert.equal(mild.ok, true);
  const costly = evaluateCostRule({
    baselineCost,
    candidateCost: { wallMs: 1300, bytes: 1000 },
    delta: 0.015,
    floor: 0.01,
    config: { wallMsBytesIncreaseRatio: 0.15, gainMultipleOfFloor: 2 },
  });
  assert.equal(costly.ok, false);
  const costlyButWorth = evaluateCostRule({
    baselineCost,
    candidateCost: { wallMs: 1300, bytes: 1000 },
    delta: 0.03,
    floor: 0.01,
    config: { wallMsBytesIncreaseRatio: 0.15, gainMultipleOfFloor: 2 },
  });
  assert.equal(costlyButWorth.ok, true);
});

test("held-out regression flags any regressed metric", () => {
  assert.equal(
    evaluateHeldout({ heldoutBaseline: { coverage: 0.9 }, heldoutCandidate: { coverage: 0.9 } }).ok,
    true,
  );
  const bad = evaluateHeldout({ heldoutBaseline: { coverage: 0.9 }, heldoutCandidate: { coverage: 0.88 } });
  assert.equal(bad.ok, false);
  assert.equal(bad.regressions[0].key, "coverage");
});

test("decision collects every failing gate and adopts only a clean pass", () => {
  const critic = buildCriticFindings({
    patchText: 'diff --git a/jev-advisor/lib/decision.ts b/jev-advisor/lib/decision.ts\n+const t = "HELDOUT_1";\n',
    touched: ["jev-advisor/lib/decision.ts"],
    surface: ["jev-advisor/lib/decision.ts"],
    adapter: DOMAIN,
    rung,
    hunks: 1,
  });
  const rejected = decideCycle({
    critic,
    guards: [{ id: "build", status: "fail" }],
    scores: { delta: 0, floor: 0.01 },
    costRule: { ok: false },
    heldout: { ok: false },
    budget: { ok: false },
  });
  assert.equal(rejected.decision, "reject");
  for (const expected of [
    "critic_fixture_hardcode",
    "guard_fail",
    "floor_not_met",
    "cost_rule",
    "heldout_regression",
    "budget_exceeded",
  ]) {
    assert.ok(rejected.reasons.includes(expected), expected);
  }
  const clean = decideCycle({
    critic: { verdict: "pass", rules: [] },
    guards: [{ id: "build", status: "pass" }],
    scores: { delta: 0.05, floor: 0.01 },
    costRule: { ok: true },
    heldout: { ok: true },
    budget: { ok: true },
  });
  assert.deepEqual(clean, { decision: "adopt", reasons: [] });
});
