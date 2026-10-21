/**
 * Trajectory-memory distillation (layer 1): contrastive candidates from
 * recorded attempts.
 *
 * Read-only over the rrsi store and the self-improve ledger. Emits candidates
 * only; it never edits source, never writes to either input, and never adopts
 * anything. Patch synthesis and adoption stay with the existing proposer and
 * gate path (`cycle` / `loop`).
 *
 * Contract: docs/trajectory-memory.md (JJO-394).
 */
import { readFileSync, lstatSync } from "node:fs";
import { sha256Hex, isPlainObject } from "./types.mjs";

export const DISTILL_SCHEMA = "gjc.trajectory-memory.distill.v1";
export const CANDIDATE_SCHEMA = "gjc.trajectory-memory.candidate.v1";
export const RRSI_STORE_SCHEMA = "gjc.rrsi.store.v1";

export const DISTILL_LIMITS = Object.freeze({
  maxStoreBytes: 512 * 1024,
  maxAttempts: 4096,
  maxCandidates: 64,
  maxRuleChars: 280,
});

const DECISIONS = new Set(["adopt", "reject", "inconclusive"]);

function boundedText(value, max = 280) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function boundedInteger(value, fallback = 0) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
}

/** Strict parse: invalid input is reported, never repaired. */
export function parseStore(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "invalid", store: null, reason: "corrupt" };
  }
  if (!isPlainObject(parsed) || parsed.schema !== RRSI_STORE_SCHEMA || !Array.isArray(parsed.episodes)) {
    return { status: "invalid", store: null, reason: "corrupt" };
  }
  return { status: "ok", store: parsed, reason: null };
}

/** Read the private rrsi store by path. Symlinks and oversized files are refused. */
export function readStoreFile(filePath) {
  if (typeof filePath !== "string" || filePath.length === 0) {
    return { status: "unavailable", store: null, reason: "no_path" };
  }
  let info;
  try {
    info = lstatSync(filePath);
  } catch (error) {
    return error && error.code === "ENOENT"
      ? { status: "missing", store: null, reason: null }
      : { status: "unavailable", store: null, reason: "io_error" };
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > DISTILL_LIMITS.maxStoreBytes) {
    return {
      status: "invalid",
      store: null,
      reason: info.size > DISTILL_LIMITS.maxStoreBytes ? "oversized" : "unsafe_path",
    };
  }
  try {
    return parseStore(readFileSync(filePath, "utf8"));
  } catch {
    return { status: "unavailable", store: null, reason: "io_error" };
  }
}

/** Flatten store episodes into bounded attempt records with stable ids. */
export function flattenAttempts(store) {
  const episodes = Array.isArray(store?.episodes) ? store.episodes : [];
  const attempts = [];
  for (const episode of episodes) {
    if (!isPlainObject(episode)) continue;
    const episodeId = boundedText(episode.id, 64) || "ep-unknown";
    const source = boundedText(episode.source, 40) || "capture";
    const rows = Array.isArray(episode.attempts) ? episode.attempts : [];
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      if (!isPlainObject(row)) continue;
      const guardFailures = Array.isArray(row.guardFailures)
        ? [
            ...new Set(
              row.guardFailures
                .filter((value) => typeof value === "string" && value.length > 0)
                .map((value) => value.slice(0, 40)),
            ),
          ].sort()
        : [];
      attempts.push({
        id: `${episodeId}#${boundedInteger(row.index, i)}`,
        episodeId,
        source,
        objective: boundedText(row.objective, 120) || "unlabeled",
        decision: DECISIONS.has(row.decision) ? row.decision : "inconclusive",
        guardFailures,
        budgetRung: boundedInteger(row.budgetRung, 0),
        hypothesisNovelty: row.hypothesisNovelty !== false,
        wallMs: boundedInteger(row.wallMs, 0),
        files: boundedInteger(row.files, 0),
        hunks: boundedInteger(row.hunks, 0),
        provenance: typeof row.provenance === "string" ? row.provenance.slice(0, 64) : null,
      });
      if (attempts.length >= DISTILL_LIMITS.maxAttempts) return attempts;
    }
  }
  return attempts;
}

/**
 * The single feature that separates an adopting attempt from a rejected one.
 * Ordered by explanatory value. Cost and edit size are deliberately excluded:
 * a rule justified by wall-clock or hunk counts alone is not admissible.
 */
export function contrastFor(adopt, reject) {
  const rejectOnly = reject.guardFailures.filter((guard) => !adopt.guardFailures.includes(guard));
  if (rejectOnly.length > 0) return { kind: "guardFailures", detail: rejectOnly };
  if (adopt.budgetRung !== reject.budgetRung) {
    return { kind: "budgetRung", detail: [adopt.budgetRung, reject.budgetRung] };
  }
  if (adopt.hypothesisNovelty !== reject.hypothesisNovelty) {
    return { kind: "hypothesisNovelty", detail: [adopt.hypothesisNovelty, reject.hypothesisNovelty] };
  }
  return null;
}

export function ruleFor(objective, adopt, reject, feature) {
  let rule;
  if (feature.kind === "guardFailures") {
    rule = `${objective}: the rejected attempt failed guard(s) ${feature.detail.join(", ")}; the adopting attempt did not.`;
  } else if (feature.kind === "budgetRung") {
    const [adoptRung, rejectRung] = feature.detail;
    rule = `${objective}: prefer budget rung ${adoptRung}; rung ${rejectRung} was rejected.`;
  } else {
    const [adoptValue, rejectValue] = feature.detail;
    rule = `${objective}: hypothesisNovelty ${adoptValue} was adopted; hypothesisNovelty ${rejectValue} was rejected.`;
  }
  return rule.slice(0, DISTILL_LIMITS.maxRuleChars);
}

export function buildCandidate({ objective, adopt, reject, feature, storeDigest, ledgerSeq }) {
  const body = {
    schema: CANDIDATE_SCHEMA,
    objective,
    contrast: {
      adopt: { attemptId: adopt.id, provenance: adopt.provenance },
      reject: { attemptId: reject.id, provenance: reject.provenance },
      feature: { kind: feature.kind, detail: feature.detail },
    },
    rule: ruleFor(objective, adopt, reject, feature),
    evidence: { storeDigest, ledgerSeq },
    expires: { kind: "ledger_seq", after: ledgerSeq },
  };
  const id = `cand-${sha256Hex(JSON.stringify(body)).slice(0, 12)}`;
  return { id, ...body };
}

/** Highest cycle seq in the ledger; the epoch a rule goes stale after. */
export function ledgerEpoch(rows) {
  let epoch = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind === "cycle" && Number.isInteger(row.seq) && row.seq > epoch) epoch = row.seq;
  }
  return epoch;
}

/**
 * Deterministic distillation. Objectives are sorted, adopt/reject attempts are
 * the first recorded of each decision, and no clock value enters the output, so
 * identical inputs produce byte-identical JSON.
 */
export function distillTrajectories({ store, ledgerRows = [], objective = null }) {
  const attempts = flattenAttempts(store);
  const storeDigest = sha256Hex(JSON.stringify(attempts));
  const ledgerSeq = ledgerEpoch(ledgerRows);
  const groups = new Map();
  for (const attempt of attempts) {
    if (objective && attempt.objective !== objective) continue;
    if (!groups.has(attempt.objective)) groups.set(attempt.objective, []);
    groups.get(attempt.objective).push(attempt);
  }
  const candidates = [];
  const skipped = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key);
    const adopt = group.find((attempt) => attempt.decision === "adopt") ?? null;
    const reject = group.find((attempt) => attempt.decision === "reject") ?? null;
    if (!adopt) {
      skipped.push({ objective: key, reason: "missing_adopt" });
      continue;
    }
    if (!reject) {
      skipped.push({ objective: key, reason: "missing_reject" });
      continue;
    }
    const feature = contrastFor(adopt, reject);
    if (feature === null) {
      skipped.push({ objective: key, reason: "no_differing_feature" });
      continue;
    }
    candidates.push(buildCandidate({ objective: key, adopt, reject, feature, storeDigest, ledgerSeq }));
    if (candidates.length >= DISTILL_LIMITS.maxCandidates) break;
  }
  return {
    schema: DISTILL_SCHEMA,
    store: {
      digest: storeDigest,
      episodes: Array.isArray(store?.episodes) ? store.episodes.length : 0,
      attempts: attempts.length,
    },
    ledger: { seq: ledgerSeq },
    candidates,
    skipped,
  };
}
