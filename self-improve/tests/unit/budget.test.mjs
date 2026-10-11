import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_SCHEDULE, budgetResetDecision, checkBudget, rungFor } from "../../lib/budget.mjs";

test("rung tightens monotonically with accepted cycles and clamps at the last rung", () => {
  assert.deepEqual(rungFor(0), { index: 0, maxFiles: 3, maxHunks: 12 });
  assert.deepEqual(rungFor(1), { index: 1, maxFiles: 2, maxHunks: 8 });
  assert.deepEqual(rungFor(2), { index: 2, maxFiles: 1, maxHunks: 4 });
  assert.deepEqual(rungFor(7), { index: 2, maxFiles: 1, maxHunks: 4 });
  assert.equal(DEFAULT_SCHEDULE.length, 3);
  assert.throws(() => rungFor(-1), /non-negative integer/);
});

test("checkBudget flags files and hunks over the rung", () => {
  const rung = rungFor(1);
  assert.deepEqual(checkBudget({ files: ["a", "b"], hunks: 8 }, rung), {
    ok: true,
    reason: null,
    violations: [],
  });
  const over = checkBudget({ files: ["a", "b", "c"], hunks: 9 }, rung);
  assert.equal(over.ok, false);
  assert.equal(over.reason, "budget_exceeded");
  assert.deepEqual(over.violations, ["files:3>2", "hunks:9>8"]);
});

test("budget resets require explicit auditable reasons", () => {
  assert.deepEqual(budgetResetDecision({}), { reset: false, reasons: [] });
  assert.deepEqual(budgetResetDecision({ campaignClosed: true, resetFlag: true }), {
    reset: true,
    reasons: ["campaign_closed", "reset_flag"],
  });
});
