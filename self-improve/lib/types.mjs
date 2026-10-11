/**
 * Shared enums and shape validators for the self-improve ledger and proposals.
 * Runs on plain Node (node: builtins only).
 */
import { createHash } from "node:crypto";

export const LEDGER_SCHEMA = "gjc.self-improve.ledger.v1";
export const MAX_LEDGER_ROW_BYTES = 2048;

export const ROW_KINDS = Object.freeze(["cycle", "adoption"]);
export const VERDICTS = Object.freeze(["adopt", "reject", "inconclusive"]);
export const INSTALL_STATES = Object.freeze(["not_attempted", "upgraded", "failed"]);

export const REJECT_REASONS = Object.freeze([
  "critic_leakage",
  "critic_protected",
  "critic_generated_edit",
  "critic_surface",
  "critic_special_case",
  "critic_secret",
  "critic_network",
  "guard_fail",
  "floor_not_met",
  "cost_rule",
  "heldout_regression",
  "budget_exceeded",
  "base_mismatch",
  "history_duplicate_hypothesis",
  "post_apply_failure",
  "dirty_worktree",
  "replay_failed",
  "empty_patch",
]);

export function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const HEX_REVISION = /^[0-9a-f]{7,64}$/;
const HEX256 = /^[0-9a-f]{64}$/;

export function validateProposal(proposal) {
  assert(isPlainObject(proposal), "proposal must be an object");
  assert(proposal.source === "manual" || proposal.source === "agent", "proposal.source must be manual|agent");
  assert(
    typeof proposal.patchSha256 === "string" && HEX256.test(proposal.patchSha256),
    "proposal.patchSha256 must be a sha256 hex",
  );
  assert(Array.isArray(proposal.files) && proposal.files.length > 0, "proposal.files must be a non-empty array");
  for (const file of proposal.files) {
    assert(typeof file === "string" && file.length > 0, "proposal.files entries must be non-empty strings");
  }
  assert(Number.isInteger(proposal.hunks) && proposal.hunks >= 0, "proposal.hunks must be a non-negative integer");
}

export function validateCost(cost) {
  assert(isPlainObject(cost), "cost must be an object");
  assert(
    typeof cost.wallMs === "number" && cost.wallMs >= 0,
    "cost.wallMs must be measured (number); null is not allowed for executed cycles",
  );
  assert(typeof cost.bytes === "number" && cost.bytes >= 0, "cost.bytes must be measured (number)");
  assert(
    cost.tokens === null || (typeof cost.tokens === "number" && cost.tokens >= 0),
    "cost.tokens must be a number or null (null means unmeasured)",
  );
}

export function validateScores(scores) {
  assert(isPlainObject(scores), "scores must be an object");
  assert(typeof scores.delta === "number", "scores.delta must be a number");
  assert(typeof scores.floor === "number" && scores.floor >= 0, "scores.floor must be a non-negative number");
  assert(isPlainObject(scores.baseline), "scores.baseline object required");
  assert(isPlainObject(scores.candidate), "scores.candidate object required");
  if (scores.heldout !== undefined) {
    assert(isPlainObject(scores.heldout), "scores.heldout must be an object when present");
  }
}

export function validateCycleRow(row) {
  assert(isPlainObject(row), "cycle row must be an object");
  assert(row.kind === "cycle", "cycle row kind must be cycle");
  assert(row.schema === LEDGER_SCHEMA, `cycle row schema must be ${LEDGER_SCHEMA}`);
  assert(typeof row.cycleId === "string" && row.cycleId.length > 0, "cycleId required");
  assert(typeof row.domain === "string" && row.domain.length > 0, "domain required");
  assert(typeof row.campaignId === "string" && row.campaignId.length > 0, "campaignId required");
  assert(typeof row.baseCommit === "string" && HEX_REVISION.test(row.baseCommit), "baseCommit must be a hex revision");
  assert(Number.isInteger(row.budgetRung) && row.budgetRung >= 0, "budgetRung must be a non-negative integer");
  validateProposal(row.proposal);
  assert(
    typeof row.hypothesisHash === "string" && HEX256.test(row.hypothesisHash),
    "hypothesisHash must be a sha256 hex",
  );
  assert(typeof row.objective === "string" && row.objective.length > 0, "objective required");
  validateScores(row.scores);
  validateCost(row.cost);
  assert(Array.isArray(row.guards), "guards must be an array");
  for (const guard of row.guards) {
    assert(
      isPlainObject(guard) && typeof guard.id === "string" && typeof guard.status === "string",
      "guard entries need string id/status",
    );
  }
  assert(
    isPlainObject(row.critic) && typeof row.critic.verdict === "string" && Array.isArray(row.critic.rules),
    "critic {verdict, rules} required",
  );
  assert(
    isPlainObject(row.verdict) && VERDICTS.includes(row.verdict.decision),
    `verdict.decision must be one of ${VERDICTS.join("|")}`,
  );
  assert(Array.isArray(row.verdict.reasons), "verdict.reasons must be an array");
  for (const reason of row.verdict.reasons) {
    assert(typeof reason === "string" && reason.length > 0, "verdict.reasons entries must be non-empty strings");
  }
  if (row.forcedExploration !== undefined) {
    assert(typeof row.forcedExploration === "boolean", "forcedExploration must be boolean");
  }
  if (row.labels !== undefined) {
    assert(
      Array.isArray(row.labels) && row.labels.every((label) => typeof label === "string" && label.length > 0),
      "labels must be an array of non-empty strings when present",
    );
  }
  assert(typeof row.createdAt === "string" && row.createdAt.length > 0, "createdAt required");
}

export function validateAdoptionRow(row) {
  assert(isPlainObject(row), "adoption row must be an object");
  assert(row.kind === "adoption", "adoption row kind must be adoption");
  assert(row.schema === LEDGER_SCHEMA, `adoption row schema must be ${LEDGER_SCHEMA}`);
  assert(typeof row.cycleId === "string" && row.cycleId.length > 0, "cycleId required");
  assert(typeof row.commit === "string" && HEX_REVISION.test(row.commit), "commit must be a hex revision");
  assert(INSTALL_STATES.includes(row.install), `install must be one of ${INSTALL_STATES.join("|")}`);
  assert(typeof row.createdAt === "string" && row.createdAt.length > 0, "createdAt required");
}
