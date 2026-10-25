/**
 * Trajectory-memory distillation (layer 1): contrastive candidates from
 * recorded attempts.
 *
 * Contract: docs/trajectory-memory.md (JJO-394, plan JJO-394 follow-up).
 *
 * v2 changes, all deliberately conservative:
 * - emission requires group-wide unanimity (every adopt x reject pair carries
 *   the same non-null feature); a single null pair makes the group
 *   `contradicted`, which is strictly stronger than a second signature;
 * - evidence and `expires.after` bind to the group's own drawn-from ledger
 *   epoch, never to the ledger head;
 * - unbound evidence (no ledger provenance) is never emitted;
 * - only the gated primary objective can become a candidate;
 * - no clock value enters the output.
 *
 * Read-only over both inputs. It never patches, adopts, or writes the store or
 * the ledger.
 */
import { readFileSync, lstatSync } from "node:fs";
import { sha256Hex, isPlainObject } from "./types.mjs";

export const DISTILL_SCHEMA = "gjc.trajectory-memory.distill.v2";
export const CANDIDATE_SCHEMA = "gjc.trajectory-memory.candidate.v2";
export const RRSI_STORE_SCHEMA = "gjc.rrsi.store.v1";

export const DISTILL_LIMITS = Object.freeze({
  maxStoreBytes: 512 * 1024,
  maxAttempts: 4096,
  maxCandidates: 64,
  maxRuleChars: 280,
  maxPairs: 1024,
  maxAttemptIdsPerSide: 8,
  maxUndeclaredSample: 20,
  maxWithheld: 64,
});

const DECISIONS = new Set(["adopt", "reject", "inconclusive"]);
const FEATURE_ORDER = Object.freeze(["guardFailures", "budgetRung", "hypothesisNovelty"]);

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
 * The single feature that separates one adopting attempt from one rejected one.
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

/** Canonical feature key. Ordered pairs are never sorted (that would merge [0,1] and [1,0]). */
export function canonicalFeature(feature) {
  const detail = feature.kind === "guardFailures" ? [...feature.detail].sort() : [...feature.detail];
  return JSON.stringify({ kind: feature.kind, detail });
}

function featureRank(kind) {
  const index = FEATURE_ORDER.indexOf(kind);
  return index < 0 ? FEATURE_ORDER.length : index;
}

function attemptIds(attempts) {
  const ids = attempts.map((attempt) => attempt.id).sort();
  const capped = ids.slice(0, DISTILL_LIMITS.maxAttemptIdsPerSide);
  return { attemptIds: capped, count: ids.length, truncated: ids.length > capped.length };
}

function counterBlock(adopts, rejects) {
  return { adopts: adopts.size, rejects: rejects.size };
}

/**
 * Classify one objective group.
 *
 * Order is fixed: a null pair (a reject that looks exactly like an adopt on
 * every admissible feature) is checked before a second feature signature,
 * because it is strictly stronger evidence against a rule.
 */
export function separateGroup(group, { maxPairs = DISTILL_LIMITS.maxPairs } = {}) {
  const adopts = group.filter((attempt) => attempt.decision === "adopt");
  const rejects = group.filter((attempt) => attempt.decision === "reject");
  if (adopts.length === 0) return { ok: false, reason: "missing_adopt", pairs: 0 };
  if (rejects.length === 0) return { ok: false, reason: "missing_reject", pairs: 0 };
  const pairCount = adopts.length * rejects.length;
  if (pairCount > maxPairs) {
    return { ok: false, reason: "pair_cap_exceeded", pairs: pairCount, maxPairs };
  }

  const pairs = [];
  for (const adopt of adopts) {
    for (const reject of rejects) {
      pairs.push({ adopt, reject, feature: contrastFor(adopt, reject) });
    }
  }
  const nullPairs = pairs.filter((pair) => pair.feature === null);
  const nonNull = pairs.filter((pair) => pair.feature !== null);
  const byFeature = new Map();
  for (const pair of nonNull) {
    const key = canonicalFeature(pair.feature);
    if (!byFeature.has(key)) byFeature.set(key, { feature: pair.feature, pairs: [] });
    byFeature.get(key).pairs.push(pair);
  }

  const counters = (chosen, unexplainedPairs) => {
    const supportAdopts = new Set(chosen.map((pair) => pair.adopt.id));
    const supportRejects = new Set(chosen.map((pair) => pair.reject.id));
    const contradictionAdopts = new Set(nullPairs.map((pair) => pair.adopt.id));
    const contradictionRejects = new Set(nullPairs.map((pair) => pair.reject.id));
    const unexplainedAdopts = new Set(unexplainedPairs.map((pair) => pair.adopt.id));
    const unexplainedRejects = new Set(unexplainedPairs.map((pair) => pair.reject.id));
    return {
      support: counterBlock(supportAdopts, supportRejects),
      contradiction: counterBlock(contradictionAdopts, contradictionRejects),
      unexplained: counterBlock(unexplainedAdopts, unexplainedRejects),
      pairs: {
        total: pairs.length,
        support: chosen.length,
        contradiction: nullPairs.length,
        unexplained: unexplainedPairs.length,
      },
    };
  };

  const byFeatureList = [...byFeature.values()]
    .sort((left, right) => {
      if (right.pairs.length !== left.pairs.length) return right.pairs.length - left.pairs.length;
      const rank = featureRank(left.feature.kind) - featureRank(right.feature.kind);
      if (rank !== 0) return rank;
      return canonicalFeature(left.feature) < canonicalFeature(right.feature) ? -1 : 1;
    })
    .map((entry) => ({
      kind: entry.feature.kind,
      detail: entry.feature.detail,
      pairs: entry.pairs.length,
    }));

  if (nullPairs.length > 0) {
    const dominant = byFeatureList.length > 0 ? byFeature.get(canonicalFeature({ kind: byFeatureList[0].kind, detail: byFeatureList[0].detail })) : null;
    const chosen = dominant ? dominant.pairs : [];
    const unexplained = nonNull.filter((pair) => !chosen.includes(pair));
    return {
      ok: false,
      reason: "contradicted",
      feature: dominant ? dominant.feature : null,
      byFeature: byFeatureList,
      ...counters(chosen, unexplained),
    };
  }

  if (byFeature.size > 1) {
    const chosen = byFeatureList.length > 0 ? byFeature.get(canonicalFeature({ kind: byFeatureList[0].kind, detail: byFeatureList[0].detail })).pairs : [];
    const unexplained = nonNull.filter((pair) => !chosen.includes(pair));
    return {
      ok: false,
      reason: "inconsistent_contrast",
      feature: chosen.length > 0 ? chosen[0].feature : null,
      byFeature: byFeatureList,
      ...counters(chosen, unexplained),
    };
  }

  const separated = byFeatureList[0];
  const chosen = byFeature.get(canonicalFeature({ kind: separated.kind, detail: separated.detail })).pairs;
  return {
    ok: true,
    feature: separated,
    byFeature: byFeatureList,
    adoptAttempts: adopts,
    rejectAttempts: rejects,
    ...counters(chosen, []),
  };
}

/**
 * Highest ledger cycle seq represented by the attempts' provenance.
 * Returns null when no attempt carries a ledger cycle id.
 */
export function projectedEpoch(attempts, cycleSeqById) {
  let maxSeq = null;
  let bound = 0;
  let unbound = 0;
  for (const attempt of attempts) {
    const seq = attempt.provenance ? cycleSeqById.get(attempt.provenance) : undefined;
    if (Number.isInteger(seq)) {
      bound += 1;
      if (maxSeq === null || seq > maxSeq) maxSeq = seq;
    } else {
      unbound += 1;
    }
  }
  return { drawnFrom: maxSeq, bound, unbound };
}

/** Ledger cycle rows -> cycleId to seq map. Non-cycle rows are ignored. */
export function cycleSeqMap(rows) {
  const map = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind !== "cycle") continue;
    if (typeof row.cycleId !== "string" || !Number.isInteger(row.seq)) continue;
    map.set(row.cycleId, row.seq);
  }
  return map;
}

/** Highest cycle seq in the ledger; the reader's head. */
export function ledgerEpoch(rows) {
  let epoch = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.kind === "cycle" && Number.isInteger(row.seq) && row.seq > epoch) epoch = row.seq;
  }
  return epoch;
}

/** Store-level context label. No emission decision reads it. */
export function assessProjection({ maxDrawnFrom, ledgerHead, maxLag }) {
  if (!Number.isInteger(maxDrawnFrom)) {
    return { maxDrawnFrom: null, ledgerHead, storeLag: null, label: ledgerHead > 0 ? "unbound" : "empty" };
  }
  const storeLag = ledgerHead - maxDrawnFrom;
  const label = storeLag <= 0 ? "fresh" : storeLag <= maxLag ? "lagging" : "stale";
  return { maxDrawnFrom, ledgerHead, storeLag, label };
}

/** Shared lag parser: accepts 0, rejects negative/non-integer/NaN. */
export function parseMaxLag(raw, name = "max-lag") {
  if (raw === undefined || raw === null) return { ok: true, value: 0 };
  if (typeof raw !== "string" || raw.trim() === "") {
    return { ok: false, message: `invalid --${name}: ${String(raw)}` };
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0) {
    return { ok: false, message: `invalid --${name}: ${raw}` };
  }
  return { ok: true, value };
}

export function ruleFor(objective, feature) {
  let rule;
  if (feature.kind === "guardFailures") {
    rule = `${objective}: rejected attempts failed guard(s) ${feature.detail.join(", ")}; adopting attempts did not.`;
  } else if (feature.kind === "budgetRung") {
    const [adoptRung, rejectRung] = feature.detail;
    rule = `${objective}: adopting attempts used budget rung ${adoptRung}; rejected attempts used rung ${rejectRung}.`;
  } else {
    const [adoptValue, rejectValue] = feature.detail;
    rule = `${objective}: adopting attempts had hypothesisNovelty ${adoptValue}; rejected attempts had hypothesisNovelty ${rejectValue}.`;
  }
  return rule.slice(0, DISTILL_LIMITS.maxRuleChars);
}

function candidateBody({ objective, separation, storeDigest, drawnFrom, ledgerHead }) {
  const firstAdopt = separation.adoptAttempts[0];
  const firstReject = separation.rejectAttempts[0];
  return {
    schema: CANDIDATE_SCHEMA,
    objective,
    contrast: {
      feature: { kind: separation.feature.kind, detail: separation.feature.detail },
      adopt: attemptIds(separation.adoptAttempts),
      reject: attemptIds(separation.rejectAttempts),
      support: separation.support,
      contradiction: separation.contradiction,
      unexplained: separation.unexplained,
      pairs: separation.pairs,
      exemplar: { adopt: firstAdopt.id, reject: firstReject.id },
    },
    rule: ruleFor(objective, separation.feature),
    evidence: {
      storeDigest,
      ledgerSeq: drawnFrom,
      ledgerHead,
      lag: ledgerHead - drawnFrom,
      basis: "projection",
    },
    expires: { kind: "ledger_seq", after: drawnFrom },
  };
}

export function buildCandidate({ objective, separation, storeDigest, drawnFrom, ledgerHead }) {
  const body = candidateBody({ objective, separation, storeDigest, drawnFrom, ledgerHead });
  return { id: `cand-${sha256Hex(JSON.stringify(body)).slice(0, 12)}`, ...body };
}

/** Recompute the content id of a loaded candidate body. */
export function candidateIdFor(body) {
  const { id, ...rest } = body;
  return `cand-${sha256Hex(JSON.stringify(rest)).slice(0, 12)}`;
}

/**
 * Deterministic distillation over declared objectives.
 *
 * `declaredObjectives` is required (no silent default): an empty list means
 * nothing is declared, which yields zero candidates. `gatedObjective` must be a
 * declared member.
 */
export function distillTrajectories({
  store,
  ledgerRows = [],
  objective = null,
  declaredObjectives,
  gatedObjective,
  maxLag = 0,
}) {
  if (!Array.isArray(declaredObjectives)) throw new Error("declaredObjectives_required");
  if (typeof gatedObjective !== "string" || gatedObjective.length === 0) throw new Error("gatedObjective_required");
  if (!declaredObjectives.includes(gatedObjective)) throw new Error("gated_objective_not_declared");

  const attempts = flattenAttempts(store);
  const storeDigest = sha256Hex(JSON.stringify(attempts));
  const ledgerHead = ledgerEpoch(ledgerRows);
  const cycleSeqById = cycleSeqMap(ledgerRows);

  const groups = new Map();
  for (const attempt of attempts) {
    if (!groups.has(attempt.objective)) groups.set(attempt.objective, []);
    groups.get(attempt.objective).push(attempt);
  }

  const declared = [...declaredObjectives].sort();
  const declaredSet = new Set(declared);
  const candidates = [];
  const withheld = [];
  const skipped = [];
  let storeMaxDrawnFrom = null;
  let undeclaredGroups = 0;
  let undeclaredAttempts = 0;
  const undeclaredSample = [];

  for (const [key, group] of [...groups.entries()].sort(([left], [right]) => (left < right ? -1 : 1))) {
    if (declaredSet.has(key)) continue;
    undeclaredGroups += 1;
    undeclaredAttempts += group.length;
    undeclaredSample.push({
      objective: key,
      attempts: group.length,
      adopt: group.filter((attempt) => attempt.decision === "adopt").length,
      reject: group.filter((attempt) => attempt.decision === "reject").length,
    });
  }
  undeclaredSample.sort((left, right) => {
    if (right.attempts !== left.attempts) return right.attempts - left.attempts;
    return left.objective < right.objective ? -1 : 1;
  });

  for (const key of declared) {
    if (objective && key !== objective) continue;
    const group = groups.get(key) ?? [];
    const { drawnFrom, bound, unbound } = projectedEpoch(group, cycleSeqById);
    if (Number.isInteger(drawnFrom) && (storeMaxDrawnFrom === null || drawnFrom > storeMaxDrawnFrom)) {
      storeMaxDrawnFrom = drawnFrom;
    }
    const lag = Number.isInteger(drawnFrom) ? ledgerHead - drawnFrom : null;
    const common = { objective: key, drawnFrom, lag };

    if (group.length === 0) {
      skipped.push({ ...common, reason: "no_attempts" });
      continue;
    }
    if (key !== gatedObjective) {
      skipped.push({ ...common, reason: "objective_not_gated" });
      continue;
    }
    if (unbound > 0) {
      skipped.push({ ...common, reason: "unbound_evidence", basis: "unbound", bound, unbound });
      continue;
    }

    const separation = separateGroup(group);
    if (!separation.ok) {
      const counters = separation.reason === "missing_adopt" || separation.reason === "missing_reject" || separation.reason === "pair_cap_exceeded"
        ? { pairs: separation.pairs ?? 0 }
        : {
            feature: separation.feature,
            support: separation.support,
            contradiction: separation.contradiction,
            unexplained: separation.unexplained,
            pairs: separation.pairs,
            byFeature: separation.byFeature,
          };
      skipped.push({ ...common, reason: separation.reason, ...counters });
      continue;
    }

    if (lag > maxLag) {
      withheld.push({ objective: key, reason: "store_stale", drawnFrom, ledgerHead, lag });
      continue;
    }

    const candidate = buildCandidate({ objective: key, separation, storeDigest, drawnFrom, ledgerHead });
    // Emission is still gated on re-derivation from the same attempt set: a
    // candidate that cannot be reproduced is skipped, never emitted, and an
    // all-skipped run is a normal empty result.
    const derived = rederiveSupport(candidate, attempts);
    if (!derived.ok) {
      skipped.push({ ...common, reason: "support_not_rederivable", detail: derived.reason });
      continue;
    }
    candidates.push(candidate);
    if (candidates.length >= DISTILL_LIMITS.maxCandidates) break;
  }

  const projection = assessProjection({ maxDrawnFrom: storeMaxDrawnFrom, ledgerHead, maxLag });
  const gatedCount = declared.includes(gatedObjective) ? 1 : 0;
  return {
    schema: DISTILL_SCHEMA,
    store: {
      digest: storeDigest,
      episodes: Array.isArray(store?.episodes) ? store.episodes.length : 0,
      attempts: attempts.length,
    },
    ledger: { seq: ledgerHead },
    scope: { declared, gated: gatedObjective },
    projection,
    groups: {
      declared: declared.length,
      gated: gatedCount,
      emitted: candidates.length,
      withheld: withheld.length,
      skipped: skipped.length,
      notGated: skipped.filter((entry) => entry.reason === "objective_not_gated").length,
      undeclared: undeclaredGroups,
    },
    undeclared: {
      groups: undeclaredGroups,
      attempts: undeclaredAttempts,
      sample: undeclaredSample.slice(0, DISTILL_LIMITS.maxUndeclaredSample),
    },
    candidates,
    withheld: withheld.slice(0, DISTILL_LIMITS.maxWithheld),
    skipped,
  };
}

/**
 * Load a candidate file for the handoff. Accepts a bare candidate.v2 object or
 * a distill.v2 payload carrying exactly one candidate.
 */
export function loadCandidatePayload(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "candidate_unreadable" };
  }
  if (!isPlainObject(parsed)) return { ok: false, reason: "candidate_unreadable" };
  if (parsed.schema === CANDIDATE_SCHEMA) return { ok: true, candidate: parsed };
  if (parsed.schema === DISTILL_SCHEMA) {
    const candidates = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    if (candidates.length !== 1) return { ok: false, reason: "candidate_ambiguous" };
    return { ok: true, candidate: candidates[0] };
  }
  return { ok: false, reason: "candidate_schema_unknown" };
}

/**
 * Content re-derivation: every referenced attempt id must resolve to an
 * attempt of this objective on the declared side, and each side's declared
 * count must equal the number of such attempts in the referenced evidence.
 * A candidate whose support cannot be reproduced from the store is a claim,
 * not a lesson.
 */
export function rederiveSupport(candidate, attempts) {
  const rows = Array.isArray(attempts) ? attempts : [];
  const byId = new Map();
  for (const row of rows) {
    if (isPlainObject(row) && typeof row.id === "string") byId.set(row.id, row);
  }
  const contrast = candidate?.contrast;
  if (!isPlainObject(contrast) || !isPlainObject(contrast.adopt) || !isPlainObject(contrast.reject)) {
    return { ok: false, reason: "support_missing" };
  }
  for (const side of ["adopt", "reject"]) {
    const ids = contrast[side].attemptIds;
    if (!Array.isArray(ids) || ids.length === 0) return { ok: false, reason: "support_missing" };
    for (const id of ids) {
      const row = byId.get(id);
      if (!row || row.objective !== candidate.objective || row.decision !== side) {
        return { ok: false, reason: "support_unresolved" };
      }
    }
    const total = rows.filter((row) => row.objective === candidate.objective && row.decision === side).length;
    if (total !== contrast[side].count) return { ok: false, reason: "support_count_mismatch" };
    if (contrast.support?.[`${side}s`] !== contrast[side].count) return { ok: false, reason: "support_count_mismatch" };
  }
  return { ok: true };
}

/**
 * Structural checks shared by the loader and the loop. `expectedStoreDigest` is
 * required in candidate-file mode: the loop recomputes it from the store so a
 * forged digest cannot reach the proposer. `attempts` is optional; when given
 * (the loop always has the store), the contrast support is re-derived from it.
 */
export function validateCandidate(candidate, { gatedObjective, ledgerHead, maxLag, expectedStoreDigest = null, attempts = null }) {
  if (!isPlainObject(candidate)) return "candidate_unreadable";
  if (candidate.schema !== CANDIDATE_SCHEMA) return "candidate_schema_unknown";
  if (candidate.objective !== gatedObjective) return "objective_not_gated";
  if (typeof candidate.rule !== "string" || candidate.rule.trim().length === 0 || candidate.rule.length > DISTILL_LIMITS.maxRuleChars) {
    return "candidate_rule_invalid";
  }
  const contrast = candidate.contrast;
  if (!isPlainObject(contrast) || !isPlainObject(contrast.support) || !isPlainObject(contrast.contradiction) || !isPlainObject(contrast.unexplained)) {
    return "candidate_contrast_invalid";
  }
  const isCount = (value) => Number.isInteger(value) && value >= 0;
  for (const block of [contrast.support, contrast.contradiction, contrast.unexplained]) {
    if (!isCount(block.adopts) || !isCount(block.rejects)) return "candidate_contrast_invalid";
  }
  if (contrast.support.adopts < 1 || contrast.support.rejects < 1) return "candidate_contrast_invalid";
  if (contrast.contradiction.adopts > 0 || contrast.contradiction.rejects > 0) return "candidate_contradicted";
  if (contrast.unexplained.adopts > 0 || contrast.unexplained.rejects > 0) return "candidate_unexplained";
  const pairs = contrast.pairs;
  if (!isPlainObject(pairs) || !["total", "support", "contradiction", "unexplained"].every((key) => isCount(pairs[key]))) {
    return "candidate_contrast_invalid";
  }
  if (pairs.total !== pairs.support + pairs.contradiction + pairs.unexplained || pairs.support < 1) {
    return "candidate_contrast_invalid";
  }
  if (pairs.support !== contrast.support.adopts * contrast.support.rejects) return "candidate_contrast_invalid";
  if (pairs.contradiction !== contrast.contradiction.adopts * contrast.contradiction.rejects) return "candidate_contrast_invalid";
  if (pairs.unexplained !== contrast.unexplained.adopts * contrast.unexplained.rejects) return "candidate_contrast_invalid";
  for (const side of [contrast.adopt, contrast.reject]) {
    if (!isPlainObject(side) || !isCount(side.count) || side.count < 1 || !Array.isArray(side.attemptIds)) {
      return "candidate_contrast_invalid";
    }
    if (side.attemptIds.some((id) => typeof id !== "string" || id.length === 0)) return "candidate_contrast_invalid";
    if (new Set(side.attemptIds).size !== side.attemptIds.length) return "candidate_contrast_invalid";
    // Support must be re-derivable, so at least one referenced attempt is required.
    if (side.attemptIds.length === 0) return "candidate_contrast_invalid";
    if (side.attemptIds.length > side.count) return "candidate_contrast_invalid";
  }
  if (contrast.adopt.count !== contrast.support.adopts || contrast.reject.count !== contrast.support.rejects) {
    return "candidate_contrast_invalid";
  }
  if (!isPlainObject(candidate.evidence) || !/^[0-9a-f]{64}$/.test(candidate.evidence.storeDigest ?? "")) {
    return "candidate_evidence_invalid";
  }
  if (candidateIdFor(candidate) !== candidate.id) return "candidate_tampered";
  const after = candidate.expires?.kind === "ledger_seq" ? candidate.expires.after : null;
  if (!Number.isInteger(after)) return "candidate_expiry_invalid";
  if (ledgerHead - after > maxLag) return "candidate_stale";
  // A future expiry never becomes stale, and an expiry before the candidate's own
  // evidence is not an increasing sequence: both would outlive the proof.
  if (after > ledgerHead) return "candidate_expiry_invalid";
  const drawnFrom = candidate.evidence?.ledgerSeq;
  if (Number.isInteger(drawnFrom) && after < drawnFrom) return "candidate_expiry_invalid";
  if (typeof expectedStoreDigest === "string" && expectedStoreDigest !== candidate.evidence.storeDigest) {
    return "candidate_store_mismatch";
  }
  if (attempts !== null) {
    const derived = rederiveSupport(candidate, attempts);
    if (!derived.ok) return "candidate_support_not_rederivable";
  }
  return null;
}
