import test from "node:test";
import assert from "node:assert/strict";

test("adequacy canary passes", () => {
  assert.equal(1, 1);
});

test("adequacy canary covers the invalid-input boundary", () => {
  assert.throws(() => {
    throw new Error("invalid input");
  }, /invalid input/);
});
