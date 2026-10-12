/**
 * Pure gate evaluation for a cycle: leakage critic findings, noise floor,
 * cost rule, held-out non-regression and the final adopt/reject decision.
 * No filesystem access; the engine supplies measurements.
 */
import { checkBudget } from "./budget.mjs";
import { assertNoProtectedTouched, assertSurface } from "./domain.mjs";

export function buildCriticFindings({ patchText, touched, surface, adapter, rung, hunks }) {
  const findings = [];
  for (const rule of adapter.criticRules) {
    const regex = new RegExp(rule.pattern, rule.flags);
    if (regex.test(patchText)) findings.push({ id: rule.id, reason: rule.reason });
  }
  const surfaceCheck = assertSurface({ touched, surface, editable: adapter.editable });
  if (!surfaceCheck.ok) {
    findings.push({ id: "critic_surface", reason: surfaceCheck.reason, offending: surfaceCheck.offending });
  }
  const protectedCheck = assertNoProtectedTouched(touched, adapter.protectedPaths);
  if (!protectedCheck.ok) {
    findings.push({ id: "critic_protected", reason: protectedCheck.reason, offending: protectedCheck.offending });
  }
  if (hunks !== undefined || touched !== undefined) {
    const budget = checkBudget({ files: touched, hunks }, rung);
    if (!budget.ok) findings.push({ id: "critic_budget", reason: "budget_exceeded", violations: budget.violations });
  }
  return { verdict: findings.length === 0 ? "pass" : "block", rules: findings };
}

export function noiseFloor({ minDelta, stochastic = false, baselineRuns = [] }) {
  if (!stochastic) return minDelta;
  const values = baselineRuns.filter((value) => Number.isFinite(value));
  if (values.length < 2) return minDelta;
  const spread = Math.max(...values) - Math.min(...values);
  return Math.max(minDelta, spread);
}

export function evaluateCostRule({ baselineCost, candidateCost, delta, floor, config }) {
  const ratio = config?.wallMsBytesIncreaseRatio ?? 0.15;
  const multiple = config?.gainMultipleOfFloor ?? 2;
  const wallIncrease =
    baselineCost.wallMs > 0 ? (candidateCost.wallMs - baselineCost.wallMs) / baselineCost.wallMs : 0;
  const byteIncrease = baselineCost.bytes > 0 ? (candidateCost.bytes - baselineCost.bytes) / baselineCost.bytes : 0;
  const overBudget = wallIncrease > ratio || byteIncrease > ratio;
  const paid = delta >= multiple * floor;
  return { ok: !overBudget || paid, wallIncrease, byteIncrease, requiredMultiple: multiple };
}

export function evaluateHeldout({ heldoutBaseline, heldoutCandidate, tolerance = 0 }) {
  const regressions = [];
  for (const [key, baselineValue] of Object.entries(heldoutBaseline ?? {})) {
    const candidateValue = heldoutCandidate?.[key];
    if (typeof baselineValue !== "number" || typeof candidateValue !== "number") continue;
    if (candidateValue < baselineValue - tolerance) regressions.push({ key, baselineValue, candidateValue });
  }
  return { ok: regressions.length === 0, regressions };
}

export function decideCycle({ critic, guards, scores, costRule, heldout, budget, extraReasons = [] }) {
  const reasons = [];
  for (const finding of critic?.rules ?? []) reasons.push(finding.id);
  if ((guards ?? []).some((guard) => guard.status !== "pass")) reasons.push("guard_fail");
  const measured = typeof scores?.delta === "number" && typeof scores?.floor === "number";
  if (!measured || scores.delta < scores.floor) reasons.push("floor_not_met");
  if (costRule && costRule.ok === false) reasons.push("cost_rule");
  if (heldout && heldout.ok === false) reasons.push("heldout_regression");
  if (budget && budget.ok === false) reasons.push("budget_exceeded");
  reasons.push(...extraReasons);
  const unique = [...new Set(reasons)];
  return { decision: unique.length === 0 ? "adopt" : "reject", reasons: unique };
}
