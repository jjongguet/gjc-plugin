import test from "node:test";
import assert from "node:assert/strict";
import { formatName } from "../src/format.mjs";

test("trims the name parts", () => {
  assert.equal(formatName({ first: " Ada ", last: " Lovelace " }), "Ada Lovelace");
});

test("appends the suffix", () => {
  assert.equal(formatName({ first: "Ada", last: "Lovelace" }, "!"), "Ada Lovelace!");
});

test("applies both the trim and the suffix", () => {
  assert.equal(formatName({ first: " Ada ", last: " Lovelace " }, "!"), "Ada Lovelace!");
});
