import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RRSI_LIMITS } from "../lib/rrsi";
import { RRSI_PERIODIC_DEFAULTS, resolveIntervalMs } from "../lib/periodic";

const readme = readFileSync(path.join(import.meta.dir, "..", "README.md"), "utf8");
const selfImprove = readFileSync(path.join(import.meta.dir, "..", "..", "self-improve", "README.md"), "utf8");

test("documented identifier and label caps match the implementation", () => {
  expect(RRSI_LIMITS.maxIdChars).toBe(64);
  expect(readme).toContain("64-char identifiers, 40-char labels");
});

test("documented projection limit and interval behaviour match the implementation", () => {
  expect(RRSI_PERIODIC_DEFAULTS.projectionLimit).toBe(160);
  expect(readme).toContain("limit = 160");
  expect(resolveIntervalMs({ RRSI_PERIODIC_INTERVAL_MS: "1000" })).toBe(RRSI_PERIODIC_DEFAULTS.intervalMs);
  expect(resolveIntervalMs({ RRSI_PERIODIC_INTERVAL_MS: String(31 * 24 * 60 * 60 * 1000) })).toBe(30 * 24 * 60 * 60 * 1000);
  expect(readme).toContain("below the floor fall back to the 24 h default");
});

test("import coverage and adoption counting are documented", () => {
  expect(readme).toContain("`import` returns the same");
  expect(readme).toContain("counts attempts whose `decision` is `adopt`");
});

test("sub-gate advisory numbers keep the train/full label and the advisory pair", () => {
  expect(selfImprove).toContain("π* 6 attempts / 408s vs baselines 12 / 874s, labelled train/full");
  expect(selfImprove).toContain("advisory validation pair is π* 3 attempts / 223s vs baselines 5 attempts / 377s");
});
