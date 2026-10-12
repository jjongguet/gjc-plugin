/**
 * Annealed edit budget: the rung tightens with the number of accepted cycles
 * inside the current campaign. Reset decisions are explicit and auditable.
 */
export const DEFAULT_SCHEDULE = Object.freeze([
  Object.freeze({ maxFiles: 3, maxHunks: 12 }),
  Object.freeze({ maxFiles: 2, maxHunks: 8 }),
  Object.freeze({ maxFiles: 1, maxHunks: 4 }),
]);

export function rungFor(acceptedCount, schedule = DEFAULT_SCHEDULE) {
  if (!Number.isInteger(acceptedCount) || acceptedCount < 0) {
    throw new Error("acceptedCount must be a non-negative integer");
  }
  const index = Math.min(acceptedCount, schedule.length - 1);
  return { index, ...schedule[index] };
}

export function checkBudget(proposal, rung) {
  const violations = [];
  const files = Array.isArray(proposal?.files) ? proposal.files.length : Infinity;
  const hunks = Number.isInteger(proposal?.hunks) ? proposal.hunks : Infinity;
  if (files > rung.maxFiles) violations.push(`files:${files}>${rung.maxFiles}`);
  if (hunks > rung.maxHunks) violations.push(`hunks:${hunks}>${rung.maxHunks}`);
  return {
    ok: violations.length === 0,
    reason: violations.length === 0 ? null : "budget_exceeded",
    violations,
  };
}

export function budgetResetDecision({ campaignClosed = false, objectiveSetChanged = false, resetFlag = false }) {
  const reasons = [];
  if (campaignClosed) reasons.push("campaign_closed");
  if (objectiveSetChanged) reasons.push("objective_set_changed");
  if (resetFlag) reasons.push("reset_flag");
  return { reset: reasons.length > 0, reasons };
}
