import test from "node:test";
import assert from "node:assert/strict";
import { summarizeHeldout } from "../../lib/engine.mjs";
import { validateScores } from "../../lib/types.mjs";

test("summarizeHeldout bounds every side, keeps numeric values and caps regressions", () => {
  const wide = {};
  for (let index = 0; index < 40; index += 1) wide[`metric_${String(index).padStart(2, "0")}`] = index / 100;
  wide.notANumber = "dropped";
  const summary = summarizeHeldout(
    {
      ok: false,
      regressions: Array.from({ length: 12 }, (_, index) => ({
        key: `k${index}`,
        baselineValue: 1,
        candidateValue: 0,
      })),
    },
    { baseline: wide, candidate: { only: 0.5 } },
  );
  assert.equal(summary.ok, false);
  assert.equal(summary.regressions.length, 8);
  assert.deepEqual(Object.keys(summary.baseline), Object.keys(wide).sort().slice(0, 8));
  assert.equal("notANumber" in summary.baseline, false);
  assert.deepEqual(summary.candidate, { only: 0.5 });
  validateScores({ baseline: {}, candidate: {}, delta: 0.05, floor: 0.01, heldout: summary });
});

test("summarizeHeldout defaults a missing held-out report and validateScores rejects malformed summaries", () => {
  assert.deepEqual(summarizeHeldout({ ok: true }), {
    ok: true,
    regressions: [],
    baseline: {},
    candidate: {},
  });
  assert.throws(() => validateScores({ baseline: {}, candidate: {}, delta: 0, floor: 0, heldout: "x" }), /heldout/);
  assert.throws(
    () => validateScores({ baseline: {}, candidate: {}, delta: 0, floor: 0, heldout: { ok: "yes" } }),
    /heldout\.ok/,
  );
  assert.throws(
    () => validateScores({ baseline: {}, candidate: {}, delta: 0, floor: 0, heldout: { regressions: {} } }),
    /regressions/,
  );
});
