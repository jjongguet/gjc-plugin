import test from "node:test";
import assert from "node:assert/strict";
import { admitCall, pairedBenefit } from "../../lib/behavior-eval.mjs";

test("spending admission refuses every negative component instead of netting it out", () => {
  const base = { capUsd: 5, priceUsd: 0.2, reservationUsd: 0.3 };
  assert.equal(admitCall(base).allowed, true);
  // A refund-shaped offset must not reduce the projected spend of a live call.
  assert.deepEqual(admitCall({ ...base, spentUsd: -1 }), { allowed: false, reason: "unknown_usage" });
  assert.deepEqual(admitCall({ ...base, unresolvedUsd: -0.5 }), { allowed: false, reason: "unknown_usage" });
  assert.deepEqual(admitCall({ ...base, cleanupUsd: -0.25 }), { allowed: false, reason: "unknown_usage" });
  assert.deepEqual(admitCall({ ...base, priceUsd: -0.2 }), { allowed: false, reason: "unknown_price" });
  assert.deepEqual(admitCall({ ...base, reservationUsd: -0.3 }), { allowed: false, reason: "invalid_reservation" });
  assert.deepEqual(admitCall({ capUsd: -5, priceUsd: 0.2, reservationUsd: 0.3 }), { allowed: false, reason: "missing_cap" });
});

test("admission still fails closed on unknown numbers and the cap", () => {
  const base = { capUsd: 5, priceUsd: 0.2, reservationUsd: 0.3 };
  assert.equal(admitCall({ ...base, priceUsd: Number.NaN }).reason, "unknown_price");
  assert.equal(admitCall({ ...base, reservationUsd: Number.POSITIVE_INFINITY }).reason, "invalid_reservation");
  assert.equal(admitCall({ ...base, spentUsd: Number.NaN }).reason, "unknown_usage");
  const exceeded = admitCall({ ...base, spentUsd: 4.8 });
  assert.equal(exceeded.reason, "cap_exceeded");
  assert.ok(exceeded.projected > 5);
  const stillUnder = admitCall({ capUsd: 5, priceUsd: 0.2, reservationUsd: 0.3, spentUsd: 4.5 });
  assert.equal(stillUnder.allowed, true);
  assert.ok(Math.abs(stillUnder.remaining - 0.2) < 1e-9, `remaining=${stillUnder.remaining}`);
});

const pair = (over = {}) => ({ id: "p1", task: "a", qualityDelta: 0.1, costRatio: 0.9, ...over });

test("a short declared denominator is insufficient, never a smaller average", () => {
  const two = [pair({ id: "p1" }), pair({ id: "p2", task: "b" })];
  assert.equal(pairedBenefit(two, { plannedPairs: 3 }).reason, "incomplete_pairs");
  assert.equal(pairedBenefit(two, { plannedPairs: 3 }).verdict, "insufficient");
  assert.equal(pairedBenefit(two).verdict, "pass");
  assert.equal(pairedBenefit([...two, pair({ id: "p3", task: "c" })], { plannedPairs: 2 }).reason, "unexpected_pairs");
  assert.equal(pairedBenefit(two, { plannedPairs: 0 }).reason, "invalid_planned_pairs");
});

test("duplicate pair ids are rejected instead of counted twice", () => {
  const duplicated = [pair({ id: "same" }), pair({ id: "same", task: "b" })];
  assert.equal(pairedBenefit(duplicated).reason, "duplicate_pairs");
  assert.equal(pairedBenefit([pair({ id: "p1" }), pair({ id: "p2", task: "b" })]).verdict, "pass");
});

test("a missing cost ratio is never defaulted to 1", () => {
  const missing = [pair({ costRatio: undefined }), pair({ id: "p2", task: "b", costRatio: undefined })];
  assert.equal(pairedBenefit(missing).reason, "invalid_cost_ratio");
  const nan = [pair({ costRatio: Number.NaN }), pair({ id: "p2", task: "b" })];
  assert.equal(pairedBenefit(nan).reason, "invalid_cost_ratio");
});

test("a negative or baseline-zero ratio is insufficient, not a saving", () => {
  const negative = [pair({ costRatio: -0.4 }), pair({ id: "p2", task: "b" })];
  assert.equal(pairedBenefit(negative).reason, "invalid_cost_ratio");
  const zeroBaseline = [pair({ baselineCost: 0 }), pair({ id: "p2", task: "b" })];
  assert.equal(pairedBenefit(zeroBaseline).reason, "baseline_zero");
});

test("incomplete pairs never reach a verdict by dropping the bad row", () => {
  const broken = [pair(), pair({ id: "p2", task: "b", qualityDelta: Number.NaN })];
  assert.equal(pairedBenefit(broken).reason, "invalid_pairs");
  assert.equal(pairedBenefit([pair()]).reason, "too_few_pairs");
  assert.equal(pairedBenefit([]).reason, "no_pairs");
});
