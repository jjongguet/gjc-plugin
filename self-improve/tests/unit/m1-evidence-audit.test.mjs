import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconcileEvents } from "../../m1/audit-eco-evidence.mjs";
import { validateProtocol } from "../../m1/run-transfer-development.mjs";

const reserve = (id = "call") => ({ kind: "reserved", id, reservationUsd: 0.000126 });
const settle = (usd, basis = "computed_tokens") => ({ kind: "settled", id: "call", usage: { usd, basis, input: 553, output: 11 } });
const unresolved = () => ({ kind: "unresolved", id: "call" });

test("unknown failed calls retain the full bound, including duplicate unresolved events", () => {
  const result = reconcileEvents([reserve(), unresolved(), unresolved()]);
  assert.equal(result.rows.length, 1);
  assert.equal(result.totalNano, 126000);
  assert.equal(result.rows[0].basis, "conservative_unresolved_bound");
});

test("computed token settlement is not double-counted as a reservation or measured billing", () => {
  const result = reconcileEvents([reserve(), settle(0.00001791)]);
  assert.equal(result.totalNano, 17910);
  assert.equal(result.rows[0].basis, "computed_tokens");
  assert.equal(result.rows[0].input, 553);
});

test("legacy provider-reported costs keep their distinct provenance", () => {
  const event = settle(0.001);
  delete event.usage.basis;
  assert.equal(reconcileEvents([reserve(), event]).rows[0].basis, "provider_reported_cost");
});

test("duplicate reservations or settlements cannot silently inflate or replace costs", () => {
  assert.throws(() => reconcileEvents([reserve(), reserve()]), /duplicate_reservation/);
  assert.throws(() => reconcileEvents([reserve(), settle(0.0001), settle(0.0002)]), /duplicate_settlement/);
});

test("settlement or unresolved events without an admitted call fail closed", () => {
  assert.throws(() => reconcileEvents([settle(0.01)]), /event_without_reservation/);
  assert.throws(() => reconcileEvents([unresolved()]), /event_without_reservation/);
});

test("invalid money is not coerced into a zero or refund-shaped offset", () => {
  for (const usd of [null, undefined, -1, NaN, Infinity]) {
    assert.throws(() => reconcileEvents([{ ...reserve(), reservationUsd: usd }]), /unknown_or_negative_cost/);
    assert.throws(() => reconcileEvents([reserve(), settle(usd)]), /unknown_or_negative_cost/);
  }
});

test("fixed development protocol rejects holdout, duplicate ids and unknown expected exits", () => {
  const protocol = JSON.parse(readFileSync(new URL("../../m1/transfer-development.json", import.meta.url)));
  validateProtocol(protocol);
  assert.equal(protocol.cases.length, 19);
  assert.throws(() => validateProtocol({ ...protocol, split: "holdout" }), /development_protocol_required/);
  assert.throws(() => validateProtocol({ ...protocol, cases: [protocol.cases[0], protocol.cases[0]] }), /invalid_case_denominator/);
  assert.throws(() => validateProtocol({ ...protocol, cases: [{ ...protocol.cases[0], expectedExit: 2 }, protocol.cases[1]] }), /invalid_case/);
});
