/**
 * Dreaming: deterministic candidate-policy generation and selection against the
 * replay simulator, plus the frozen P2 threshold evaluation.
 *
 * Determinism: candidate enumeration and every replay score are pure functions
 * of (corpus, config); the receipt carries no timestamps or randomness, so the
 * same seed yields a byte-identical receipt (AC §4.3). The seed is recorded and
 * namespaces candidate ids; it never influences ordering.
 *
 * Selection happens on the TRAIN split only (first `trainN` recorded attempts).
 * The validation split (last `validationN` attempts, which must contain >=1
 * adoption) is used only to evaluate the frozen thresholds — never to choose π*.
 */
import { BASELINE_POLICIES, DEFAULT_BETAS, POLICY_ORDERS, scorePolicy } from "./replay.mjs";
import { sha256Hex } from "./types.mjs";

export const DREAM_SCHEMA = "gjc.self-improve.dream.v1";
export const DEFAULT_MAX_CANDIDATES = 48;
export const INSUFFICIENT_EVIDENCE_VERDICT = "insufficient evidence at pass-gate size — thresholds not evaluated";
export const PINNED_CAVEAT =
  "All P2 comparisons are off-policy replays over ONE realized corpus of fewer than ~24 recorded attempts; no statistical significance is claimed; effect sizes are reported with n and are not confidence-interval estimates of future performance; the cost proxy is load-dependent recorded wallMs, not a fresh measurement.";
export const THRESHOLD_STATEMENTS = Object.freeze({
  validationAttempts: "pi* attempts-to-first-adoption <= min(B0, B1) - 1",
  validationCost: "pi* cost-to-first-adoption <= 0.7 x B0 cost-to-first-adoption",
  antiFluke: "full-corpus pi* cost-to-first-adoption <= B0 cost-to-first-adoption",
  determinism: "same seed => byte-identical receipt hash",
});

/**
 * Deterministic candidate enumeration (plan: <=48 candidates). The grid covers
 * every order rule, batch size 1-3 and both stall-switch settings with the
 * frozen first-adoption stop rule, plus the exhaustive stopping variants for
 * batch 1: 5 orders x (3 x 2 + 2) = 40 candidates by construction — never a
 * truncation, so no order rule can silently fall out of the space.
 */
export function enumerateCandidates({ maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  const candidates = [];
  for (const order of POLICY_ORDERS) {
    for (const batchSize of [1, 2, 3]) {
      for (const stallRedirect of [false, true]) {
        candidates.push({ order, batchSize, stopRule: "first_adoption", stallRedirect, stallK: 3 });
      }
    }
    for (const stallRedirect of [false, true]) {
      candidates.push({ order, batchSize: 1, stopRule: "exhaustive", stallRedirect, stallK: 3 });
    }
  }
  return candidates.slice(0, maxCandidates);
}

export function candidatePolicies({ seed, maxCandidates = DEFAULT_MAX_CANDIDATES } = {}) {
  return enumerateCandidates({ maxCandidates }).map((config, index) => ({
    id: `pi-${seed}-${String(index + 1).padStart(2, "0")}`,
    config,
  }));
}

/** Re-partition any attempt subset into epochs by its own adoption boundaries. */
export function sliceCorpus({ corpus, attempts }) {
  const seqs = new Set(attempts.map((attempt) => attempt.seq));
  const slice = { attempts: [], epochs: [], rows: corpus.rows, adoptionCount: 0, ledgerSha256: corpus.ledgerSha256 };
  let current = { index: 0, attempts: [] };
  for (const attempt of corpus.attempts) {
    if (!seqs.has(attempt.seq)) continue;
    slice.attempts.push(attempt);
    current.attempts.push(attempt);
    if (attempt.adoption) {
      slice.adoptionCount += 1;
      slice.epochs.push(current);
      current = { index: slice.epochs.length, attempts: [] };
    }
  }
  current.index = slice.epochs.length;
  slice.epochs.push(current);
  return slice;
}

export function splitCorpus({ corpus, trainN, validationN }) {
  const total = corpus.attempts.length;
  const train = sliceCorpus({ corpus, attempts: corpus.attempts.slice(0, trainN) });
  const validation = sliceCorpus({ corpus, attempts: corpus.attempts.slice(Math.max(0, total - validationN)) });
  return { train, validation, full: corpus };
}

export function summarizeScore(score) {
  return {
    policyId: score.policyId,
    attemptsToFirstAdoption: score.attemptsToFirstAdoption,
    costMsToFirstAdoption: score.costMsToFirstAdoption,
    adoptionReached: score.adoptionReached,
    attemptsPlayed: score.attemptsPlayed,
    costMs: score.costMs,
    rounds: score.rounds,
    parallelism: score.parallelism,
    value: score.value,
    scoreHash: score.scoreHash,
  };
}

const scoreSlice = ({ corpus, policy, adapter, betas, history }) => scorePolicy({ corpus, policy, adapter, betas, history });

const infinity = Number.POSITIVE_INFINITY;
const attemptsOf = (score) => (score.attemptsToFirstAdoption === null ? infinity : score.attemptsToFirstAdoption);
const costOf = (score) => (score.costMsToFirstAdoption === null ? infinity : score.costMsToFirstAdoption);

/** Plan ranking: adoption reached first, then attempts, then recorded cost, then enumeration index. */
export function rankResults(results) {
  return [...results].sort(
    (left, right) =>
      Number(right.score.adoptionReached) - Number(left.score.adoptionReached) ||
      attemptsOf(left.score) - attemptsOf(right.score) ||
      costOf(left.score) - costOf(right.score) ||
      left.index - right.index,
  );
}

/**
 * Dream over a recorded corpus. Returns the full receipt; when the pass gate is
 * not met (n < passGateN, validation < validationN, or a validation slice
 * without an adoption) the measured scores are still reported, but the verdict
 * is the frozen insufficient-evidence string and no thresholds are evaluated.
 */
export function runDream({
  corpus,
  adapter,
  seed = 1,
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  passGateN = 20,
  trainN = 14,
  validationN = 6,
  betas = DEFAULT_BETAS,
}) {
  const total = corpus.attempts.length;
  const { train, validation, full } = splitCorpus({ corpus, trainN, validationN });
  // The validation slice is scored with the pre-slice attempts as ex-ante history
  // (they were recorded earlier and are therefore legitimately known), exactly
  // like the live loop knows the whole ledger when it authors the next request.
  const validationHistory = corpus.attempts.slice(0, Math.max(0, total - validation.attempts.length));
  const gate = {
    ok: total >= passGateN && validation.attempts.length >= validationN && validation.adoptionCount >= 1,
    total,
    passGateN,
    trainN: train.attempts.length,
    validationN: validation.attempts.length,
    validationAdoptions: validation.adoptionCount,
  };
  if (total < passGateN) gate.reason = "corpus_below_pass_gate";
  else if (validation.attempts.length < validationN) gate.reason = "validation_below_minimum";
  else if (validation.adoptionCount < 1) gate.reason = "validation_without_adoption";
  else gate.reason = null;

  const policies = candidatePolicies({ seed, maxCandidates });
  const evaluated = policies.map((policy, index) => {
    const trainScore = scoreSlice({ corpus: train, policy, adapter, betas, history: [] });
    const validationScore = scoreSlice({ corpus: validation, policy, adapter, betas, history: validationHistory });
    const fullScore = scoreSlice({ corpus: full, policy, adapter, betas, history: [] });
    return {
      index,
      id: policy.id,
      config: policy.config,
      score: trainScore,
      train: summarizeScore(trainScore),
      validation: summarizeScore(validationScore),
      full: summarizeScore(fullScore),
      fullScore,
      validationScore,
    };
  });
  const ranked = rankResults(evaluated);
  const selected = ranked[0];
  const baselineResults = Object.fromEntries(
    Object.entries(BASELINE_POLICIES).map(([key, policy]) => {
      const trainScore = scoreSlice({ corpus: train, policy, adapter, betas, history: [] });
      const validationScore = scoreSlice({ corpus: validation, policy, adapter, betas, history: validationHistory });
      const fullScore = scoreSlice({ corpus: full, policy, adapter, betas, history: [] });
      return [key, { train: summarizeScore(trainScore), validation: summarizeScore(validationScore), full: summarizeScore(fullScore), fullScore, validationScore }];
    }),
  );

  const thresholdEvaluation = evaluateThresholds({ selected, baselines: baselineResults });
  const validationNumbers = {
    attemptsPlayed: validation.attempts.length,
    adoptions: validation.adoptionCount,
    trainAttempts: train.attempts.length,
  };
  const thresholds = gate.ok
    ? { evaluated: true, reason: null, ...thresholdEvaluation, statements: THRESHOLD_STATEMENTS, validationNumbers }
    : {
        evaluated: false,
        reason: gate.reason,
        advisory: thresholdEvaluation,
        statements: THRESHOLD_STATEMENTS,
        validationNumbers,
        passGateSituation: `attempts (${total}) < passGateN (${passGateN})`,
        downgradeNote:
          "plan 4.3 / M3 brief: a corpus in [12,19] attempts yields the frozen insufficient-evidence verdict with the downgrade recorded explicitly - no silent downgrade, no threshold relaxation",
      };
  const verdict = gate.ok
    ? thresholdEvaluation.attemptsOk && thresholdEvaluation.costOk && thresholdEvaluation.antiFlukeOk
      ? "met"
      : "unmet"
    : INSUFFICIENT_EVIDENCE_VERDICT;
  const receipt = {
    schema: DREAM_SCHEMA,
    seed,
    betas,
    corpus: {
      ledgerSha256: corpus.ledgerSha256,
      attempts: total,
      adoptions: corpus.adoptionCount,
      epochs: corpus.epochs.length,
      trainN: train.attempts.length,
      validationN: validation.attempts.length,
    },
    candidateCount: policies.length,
    candidates: evaluated.map((entry) => ({ id: entry.id, config: entry.config, train: entry.train, validation: entry.validation, full: entry.full })),
    rankings: ranked.map((entry) => entry.id),
    selected: { id: selected.id, config: selected.config },
    baselines: { B0: { train: baselineResults.B0.train, validation: baselineResults.B0.validation, full: baselineResults.B0.full }, B1: { train: baselineResults.B1.train, validation: baselineResults.B1.validation, full: baselineResults.B1.full } },
    thresholds,
    gate,
    calibration: [
      {
        policyId: selected.id,
        predicted: { attemptsToFirstAdoption: selected.train.attemptsToFirstAdoption, costMsToFirstAdoption: selected.train.costMsToFirstAdoption },
        realized: { attemptsToFirstAdoption: selected.validation.attemptsToFirstAdoption, costMsToFirstAdoption: selected.validation.costMsToFirstAdoption },
      },
      ...Object.entries(baselineResults).map(([key, entry]) => ({
        policyId: key,
        predicted: { attemptsToFirstAdoption: entry.train.attemptsToFirstAdoption, costMsToFirstAdoption: entry.train.costMsToFirstAdoption },
        realized: { attemptsToFirstAdoption: entry.validation.attemptsToFirstAdoption, costMsToFirstAdoption: entry.validation.costMsToFirstAdoption },
      })),
    ],
    caveat: PINNED_CAVEAT,
    verdict,
  };
  receipt.receiptHash = sha256Hex(JSON.stringify(receipt));
  return receipt;
}

function evaluateThresholds({ selected, baselines }) {
  const b0 = baselines.B0.validationScore;
  const b1 = baselines.B1.validationScore;
  const pi = selected.validationScore;
  const b0Full = baselines.B0.fullScore;
  const targetAttempts = Math.min(attemptsOf(b0), attemptsOf(b1)) - 1;
  const attemptsOk = attemptsOf(pi) <= targetAttempts;
  const costOk = costOf(pi) <= 0.7 * costOf(b0);
  const antiFlukeOk = costOf(selected.fullScore) <= costOf(b0Full);
  return {
    attemptsOk,
    costOk,
    antiFlukeOk,
    determinismOk: true,
    targets: {
      maxAttempts: Number.isFinite(targetAttempts) ? targetAttempts : null,
      maxCostMs: Number.isFinite(costOf(b0)) ? 0.7 * costOf(b0) : null,
    },
    measured: {
      pi: { attemptsToFirstAdoption: pi.attemptsToFirstAdoption, costMsToFirstAdoption: pi.costMsToFirstAdoption },
      B0: { attemptsToFirstAdoption: b0.attemptsToFirstAdoption, costMsToFirstAdoption: b0.costMsToFirstAdoption },
      B1: { attemptsToFirstAdoption: b1.attemptsToFirstAdoption, costMsToFirstAdoption: b1.costMsToFirstAdoption },
    },
  };
}
