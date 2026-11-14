import test from "node:test";
import assert from "node:assert/strict";
import { parseItems } from "../src/parser.mjs";

test("splits non-empty lines and trims them", () => {
  assert.deepEqual(parseItems(" a \n b "), ["a", "b"]);
});

test("rejects non-string input", () => {
  assert.throws(() => parseItems(undefined), TypeError);
});
