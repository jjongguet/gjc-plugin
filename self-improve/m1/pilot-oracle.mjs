import { createHash } from "node:crypto";
import { canonicalJson } from "../lib/loading-receipt.mjs";

export const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");

/** Public selection gate: deliberately receives no expected value. */
export function publicDecision(text) {
  let value;
  try { value = JSON.parse(text); } catch { return { valid: false, errors: ["invalid_json"] }; }
  if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.accept !== "boolean") return { valid: false, errors: ["invalid_shape"] };
  const keys = Object.keys(value).sort().join(",");
  if (value.accept ? keys !== "accept,tier" || !["fast", "balanced", "strong"].includes(value.tier) : keys !== "accept") return { valid: false, errors: ["invalid_fields"] };
  return { valid: true, errors: [], value };
}

/** Parent-only semantic oracle, evaluated once after the frozen public selector. */
export function compareDecision(text, oracle) {
  if (oracle?.schema !== "harness2.json-decision.v1" || oracle.independent !== true || !publicDecision(JSON.stringify(oracle.expected)).valid) throw new Error("invalid_oracle");
  const result = publicDecision(text);
  return { passed: result.valid && canonicalJson(result.value) === canonicalJson(oracle.expected), publicCheck: { valid: result.valid, errors: result.errors }, evidenceDigest: digest({ oracle, output: text }) };
}

export function historicalBoundaryControls() {
  const predicate = (probabilities) => Math.abs(probabilities.reduce((a, b) => a + b, 0) - 1) <= 0.001;
  const failing = [0.499, 0.3, 0.2];
  const sum = failing.reduce((a, b) => a + b, 0);
  const cases = [
    { id: "archived-dev10-mismatch", observed: predicate(failing), expectedPredicate: false, documentedAccept: true },
    { id: "within-tolerance-control", observed: predicate([0.5, 0.3, 0.2]), expectedPredicate: true },
    { id: "outside-tolerance-control", observed: predicate([0.498, 0.3, 0.2]), expectedPredicate: false },
  ];
  return { scope: "historical predicate, not full parser replay", sum, error: Math.abs(sum - 1), passed: cases.every((c) => c.observed === c.expectedPredicate), cases };
}
