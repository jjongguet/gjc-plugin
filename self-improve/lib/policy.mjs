/**
 * Policy artifact model and deploy bookkeeping.
 *
 * A policy is a committed artifact (`self-improve/policies/<id>.json`) plus a
 * `current.json` pointer, and every deploy records a `kind:"policy"` ledger row
 * (<=2 KiB) so the chain carries the selection decision. Rendering is pure;
 * `applyPolicyDeploy` performs the writes and the single ledger append.
 */
import * as fs from "node:fs";
import path from "node:path";
import { appendRow } from "./ledger.mjs";
import { POLICY_ORDERS, POLICY_STOP_RULES } from "./replay.mjs";
import { isPlainObject, sha256Hex } from "./types.mjs";

export const POLICY_SCHEMA = "gjc.self-improve.policy.v1";
export const POLICY_DECISIONS = Object.freeze(["deploy", "retire"]);
export const DEFAULT_POLICY_DIR = path.join("self-improve", "policies");

export function validatePolicyShape(policy) {
  const errors = [];
  if (!isPlainObject(policy)) return { ok: false, errors: ["policy must be an object"] };
  if (policy.schema !== POLICY_SCHEMA) errors.push(`policy.schema must be ${POLICY_SCHEMA}`);
  if (typeof policy.id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(policy.id)) {
    errors.push("policy.id must be a lowercase slug (3-64 chars)");
  }
  if (!Number.isInteger(policy.seed)) errors.push("policy.seed must be an integer");
  if (!isPlainObject(policy.config)) errors.push("policy.config must be an object");
  else {
    if (!POLICY_ORDERS.includes(policy.config.order)) errors.push(`policy.config.order must be one of ${POLICY_ORDERS.join("|")}`);
    if (!POLICY_STOP_RULES.includes(policy.config.stopRule)) {
      errors.push(`policy.config.stopRule must be one of ${POLICY_STOP_RULES.join("|")}`);
    }
    if (!Number.isInteger(policy.config.batchSize) || policy.config.batchSize < 1) {
      errors.push("policy.config.batchSize must be a positive integer");
    }
    if (typeof policy.config.stallRedirect !== "boolean") errors.push("policy.config.stallRedirect must be boolean");
    if (!Number.isInteger(policy.config.stallK) || policy.config.stallK < 1) errors.push("policy.config.stallK must be a positive integer");
  }
  if (typeof policy.createdAt !== "string" || policy.createdAt.length === 0) errors.push("policy.createdAt required");
  return { ok: errors.length === 0, errors };
}

export function policyArtifactPath({ policyDir = DEFAULT_POLICY_DIR, id }) {
  return path.join(policyDir, `${id}.json`);
}

export function policyCurrentPath({ policyDir = DEFAULT_POLICY_DIR }) {
  return path.join(policyDir, "current.json");
}

export function buildPolicyArtifact({ id, seed, config, createdAt, source = null }) {
  return {
    schema: POLICY_SCHEMA,
    id,
    seed,
    config: { ...config },
    ...(source ? { source } : {}),
    createdAt,
  };
}

export function readPolicyArtifact(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  const policy = JSON.parse(raw);
  const validation = validatePolicyShape(policy);
  if (!validation.ok) throw new Error(`invalid_policy_artifact: ${validation.errors.join("; ")}`);
  return { policy, sha256: sha256Hex(raw), text: raw };
}

export function listPolicyArtifacts({ policyDir = DEFAULT_POLICY_DIR } = {}) {
  if (!fs.existsSync(policyDir)) return [];
  return fs
    .readdirSync(policyDir)
    .filter((name) => name.endsWith(".json") && name !== "current.json")
    .map((name) => name.slice(0, -".json".length))
    .sort();
}

export function readCurrentPolicy({ policyDir = DEFAULT_POLICY_DIR } = {}) {
  const filePath = policyCurrentPath({ policyDir });
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function buildPolicyRow({ policy, decision, artifactPath, artifactText, createdAt }) {
  return {
    kind: "policy",
    policyId: policy.id,
    decision,
    seed: policy.seed,
    configHash: sha256Hex(JSON.stringify(policy.config)),
    artifact: { path: artifactPath, sha256: sha256Hex(artifactText) },
    createdAt,
  };
}

/**
 * Pure deploy plan: artifact text, current pointer text, the ledger row and the
 * conventional commit message. No writes happen here.
 */
export function planPolicyDeploy({ policyDir = DEFAULT_POLICY_DIR, policy, decision = "deploy", createdAt }) {
  const validation = validatePolicyShape(policy);
  if (!validation.ok) throw new Error(`invalid_policy: ${validation.errors.join("; ")}`);
  if (!POLICY_DECISIONS.includes(decision)) throw new Error(`unknown_policy_decision: ${decision}`);
  const artifactPath = policyArtifactPath({ policyDir, id: policy.id });
  const artifactText = `${JSON.stringify(policy, null, 2)}\n`;
  const currentPath = policyCurrentPath({ policyDir });
  const currentText = `${JSON.stringify({ id: policy.id, file: path.basename(artifactPath), sha256: sha256Hex(artifactText), decision }, null, 2)}\n`;
  const row = buildPolicyRow({ policy, decision, artifactPath, artifactText, createdAt });
  return {
    artifactPath,
    artifactText,
    currentPath,
    currentText,
    row,
    commitMessage: `chore(self-improve): policy ${policy.id} ${decision}`,
  };
}

/** Apply a deploy plan: write both artifacts, then append exactly one policy row. */
export function applyPolicyDeploy({ plan, ledgerPath }) {
  fs.mkdirSync(path.dirname(plan.artifactPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(plan.artifactPath, plan.artifactText);
  fs.mkdirSync(path.dirname(plan.currentPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(plan.currentPath, plan.currentText);
  const receipt = appendRow(ledgerPath, plan.row);
  return { artifactPath: plan.artifactPath, currentPath: plan.currentPath, rowSeq: receipt.seq, commitMessage: plan.commitMessage };
}
