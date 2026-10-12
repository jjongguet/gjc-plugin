/**
 * Deterministic epoch-partitioned replay simulator (Dream-RSI "replay worlds").
 *
 * Epoch validity rule (plan §4.3, [F3]): an attempt may be replayed only at the
 * code state at which it was recorded. The authoritative boundary is the
 * editable-surface digest, which only adoptions change — ledger-only `chore`
 * commits move HEAD without changing the graded surface, so `baseCommit` is
 * recorded as provenance, never as the epoch key. Observable consequence: an
 * adoption closes its epoch (the next epoch's attempts were recorded on the new
 * surface), reject-only attempts inside an epoch are freely reorderable, and
 * adoption order is preserved in every replay. Cross-epoch replay of an attempt
 * is impossible because later epochs only become available after the adoption
 * that opened them has been played.
 *
 * Reveal protocol: selection may use only ex-ante features (objective/gap id,
 * attempt index within the branch, hypothesis-novelty flag, files/hunks, prior
 * REVEALED outcomes of the same branch, prior guard-failure classes, budget
 * rung). An attempt's recorded outcome is revealed only after it is selected;
 * verdicts, deltas and ledger order of unplayed attempts are sealed.
 *
 * No I/O beyond reading the ledger; no timers; no randomness.
 */
import { sha256Hex } from "./types.mjs";
import { readLedger } from "./ledger.mjs";

export const REPLAY_SCHEMA = "gjc.self-improve.replay.v1";
export const POLICY_ORDERS = Object.freeze(["fixed", "round_robin", "success_greedy", "failure_greedy", "novelty_first"]);
export const POLICY_STOP_RULES = Object.freeze(["first_adoption", "exhaustive"]);
export const DEFAULT_POLICY_CONFIG = Object.freeze({
  order: "fixed",
  batchSize: 1,
  stopRule: "first_adoption",
  stallRedirect: false,
  stallK: 3,
});
export const DEFAULT_BETAS = Object.freeze({ beta1: 0.01, beta2: 0.005 });
export const BASELINE_IDS = Object.freeze(["B0", "B1"]);

/** The two fixed baselines of the plan: recorded order (B0), round-robin (B1). */
export const BASELINE_POLICIES = Object.freeze({
  B0: { id: "B0", config: { ...DEFAULT_POLICY_CONFIG, order: "fixed", batchSize: 1, stopRule: "first_adoption" } },
  B1: { id: "B1", config: { ...DEFAULT_POLICY_CONFIG, order: "round_robin", batchSize: 1, stopRule: "first_adoption" } },
});

function buildAttempt(row, adoptionRow) {
  return {
    seq: row.seq,
    cycleId: row.cycleId,
    objective: row.objective,
    hypothesisHash: row.hypothesisHash,
    baseCommit: row.baseCommit,
    budgetRung: row.budgetRung,
    files: [...(row.proposal?.files ?? [])],
    hunks: row.proposal?.hunks ?? 0,
    wallMs: typeof row.cost?.wallMs === "number" ? row.cost.wallMs : null,
    guardFailures: (row.guards ?? []).filter((guard) => guard.status !== "pass").map((guard) => guard.id),
    decision: row.verdict?.decision ?? "inconclusive",
    delta: row.scores?.delta ?? null,
    adoption: adoptionRow ? { commit: adoptionRow.commit, install: adoptionRow.install } : null,
    createdAt: row.createdAt,
  };
}

/**
 * Load the recorded corpus: attempts in ledger order, partitioned into epochs by
 * adoption boundaries. Trailing attempts after the last adoption form the open
 * epoch (the pool can keep growing, M4).
 */
export function loadCorpus({ ledgerPath }) {
  const rows = readLedger(ledgerPath);
  const adoptionsByCycle = new Map();
  for (const row of rows) {
    if (row.kind === "adoption") adoptionsByCycle.set(row.cycleId, row);
  }
  const attempts = rows
    .filter((row) => row.kind === "cycle")
    .map((row) => buildAttempt(row, adoptionsByCycle.get(row.cycleId) ?? null));
  const epochs = [];
  let current = { index: 0, attempts: [] };
  for (const attempt of attempts) {
    current.attempts.push(attempt);
    if (attempt.adoption) {
      epochs.push(current);
      current = { index: epochs.length, attempts: [] };
    }
  }
  // Trailing attempts after the last adoption form the open epoch (the pool can
  // keep growing); an empty tail adds no world and is dropped.
  if (current.attempts.length > 0) {
    current.index = epochs.length;
    epochs.push(current);
  }
  const adoptionCount = attempts.filter((attempt) => attempt.adoption).length;
  return {
    rows,
    attempts,
    epochs,
    adoptionCount,
    ledgerSha256: sha256Hex(rows.map((row) => JSON.stringify(row)).join("\n")),
  };
}

function branchAttemptsBefore(corpus, attempt, history = []) {
  return [...history, ...corpus.attempts]
    .filter((other) => other.objective === attempt.objective && other.seq < attempt.seq)
    .sort((left, right) => left.seq - right.seq);
}

/**
 * Ex-ante feature view for one attempt. Everything here is knowable before the
 * attempt is played; sealed fields (verdict, delta, unplayed ordering) are not
 * included. `revealed` holds the seqs whose outcomes were already revealed;
 * `history` holds attempts recorded before the replayed slice — they happened
 * earlier, so they are prior knowledge (their branch entries count as
 * revealed by the caller pre-seeding `revealed`).
 */
export function exAnteFeatures({ corpus, attempt, revealed, history = [] }) {
  const branch = branchAttemptsBefore(corpus, attempt, history);
  return {
    objective: attempt.objective,
    gapId: attempt.objective,
    attemptIndexWithinBranch: branch.length,
    hypothesisNovelty: !branch.some((other) => other.hypothesisHash === attempt.hypothesisHash),
    files: [...attempt.files],
    hunks: attempt.hunks,
    priorRevealedOutcomes: branch.filter((other) => revealed.has(other.seq)).map((other) => other.decision),
    priorGuardFailureClasses: [...new Set(branch.flatMap((other) => other.guardFailures))].sort(),
    budgetRung: attempt.budgetRung,
  };
}

function revealedState({ corpus, revealed, attempt, history = [] }) {
  const branch = branchAttemptsBefore(corpus, attempt, history).filter((other) => revealed.has(other.seq));
  let consecutiveRejects = 0;
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    if (branch[index].decision === "reject") consecutiveRejects += 1;
    else break;
  }
  return {
    revealedRejects: branch.filter((other) => other.decision === "reject").length,
    hasRevealedAdoption: branch.some((other) => other.decision === "adopt"),
    consecutiveRejects,
  };
}

function rotationFor({ corpus, adapter, rounds }) {
  const objectives = adapter?.objectives ?? [...new Set(corpus.attempts.map((attempt) => attempt.objective))];
  if (objectives.length === 0) return [];
  const offset = rounds % objectives.length;
  return [...objectives.slice(offset), ...objectives.slice(0, offset)];
}

function orderAvailable({ config, corpus, adapter, available, revealed, rounds, history = [] }) {
  const decorated = available.map((attempt, index) => ({
    attempt,
    index,
    features: exAnteFeatures({ corpus, attempt, revealed, history }),
    state: revealedState({ corpus, revealed, attempt, history }),
  }));
  const objectiveOrder = new Map((adapter?.objectives ?? []).map((objective, index) => [objective, index]));
  const objectiveIndex = (entry) => objectiveOrder.get(entry.attempt.objective) ?? Number.MAX_SAFE_INTEGER;
  const bySeq = (left, right) => left.attempt.seq - right.attempt.seq;
  const rotation = rotationFor({ corpus, adapter, rounds });
  const rotationIndex = (entry) => {
    const position = rotation.indexOf(entry.attempt.objective);
    return position === -1 ? Number.MAX_SAFE_INTEGER : position;
  };
  let ordered;
  switch (config.order) {
    case "round_robin":
      ordered = [...decorated].sort((left, right) => rotationIndex(left) - rotationIndex(right) || objectiveIndex(left) - objectiveIndex(right) || bySeq(left, right));
      break;
    case "success_greedy":
      ordered = [...decorated].sort(
        (left, right) =>
          Number(right.state.hasRevealedAdoption) - Number(left.state.hasRevealedAdoption) ||
          left.state.consecutiveRejects - right.state.consecutiveRejects ||
          objectiveIndex(left) - objectiveIndex(right) ||
          bySeq(left, right),
      );
      break;
    case "failure_greedy":
      ordered = [...decorated].sort(
        (left, right) =>
          right.state.revealedRejects - left.state.revealedRejects || objectiveIndex(left) - objectiveIndex(right) || bySeq(left, right),
      );
      break;
    case "novelty_first":
      ordered = [...decorated].sort(
        (left, right) =>
          Number(right.features.hypothesisNovelty) - Number(left.features.hypothesisNovelty) ||
          left.features.attemptIndexWithinBranch - right.features.attemptIndexWithinBranch ||
          bySeq(left, right),
      );
      break;
    default:
      ordered = [...decorated].sort(bySeq);
      break;
  }
  if (config.stallRedirect !== true) return ordered;
  // Switch rule: an objective with >= stallK consecutive revealed rejects is
  // pushed behind objectives that are not stalled, preserving the order above.
  return [...ordered].sort(
    (left, right) =>
      Number(left.state.consecutiveRejects >= config.stallK) - Number(right.state.consecutiveRejects >= config.stallK) ||
      ordered.indexOf(left) - ordered.indexOf(right),
  );
}

/**
 * Play one policy over the corpus. Returns the recorded metrics plus a per-world
 * breakdown; outcomes are revealed strictly after selection.
 */
export function scorePolicy({ corpus, policy, adapter, betas = DEFAULT_BETAS, history = [] }) {
  const config = { ...DEFAULT_POLICY_CONFIG, ...(policy?.config ?? {}) };
  if (!POLICY_ORDERS.includes(config.order)) throw new Error(`unknown_policy_order: ${config.order}`);
  if (!POLICY_STOP_RULES.includes(config.stopRule)) throw new Error(`unknown_stop_rule: ${config.stopRule}`);
  if (!Number.isInteger(config.batchSize) || config.batchSize < 1) throw new Error("policy_batch_size_must_be_positive");
  // Attempts recorded before the replayed slice are prior knowledge.
  const revealed = new Set(history.map((attempt) => attempt.seq));
  const played = [];
  const worlds = [];
  let rounds = 0;
  let costMs = 0;
  let costMsToFirstAdoption = null;
  let attemptsToFirstAdoption = null;
  let stopped = false;
  for (const epoch of corpus.epochs) {
    const world = { epoch: epoch.index, attempts: epoch.attempts.length, played: [], attemptsToFirstAdoption: null, costMs: 0 };
    while (!stopped) {
      const available = epoch.attempts.filter((attempt) => !revealed.has(attempt.seq));
      if (available.length === 0) break;
      const ordered = orderAvailable({ config, corpus, adapter, available, revealed, rounds, history });
      const batch = ordered.slice(0, config.batchSize).map((entry) => entry.attempt);
      if (batch.length === 0) break;
      rounds += 1;
      for (const attempt of batch) {
        revealed.add(attempt.seq);
        played.push(attempt.seq);
        world.played.push(attempt.seq);
        const wallMs = typeof attempt.wallMs === "number" ? attempt.wallMs : 0;
        costMs += wallMs;
        world.costMs += wallMs;
        if (attempt.adoption && attemptsToFirstAdoption === null) {
          attemptsToFirstAdoption = played.length;
          costMsToFirstAdoption = costMs;
          world.attemptsToFirstAdoption = attemptsToFirstAdoption;
          stopped = config.stopRule === "first_adoption";
          break;
        }
      }
      if (attemptsToFirstAdoption !== null && config.stopRule === "first_adoption") break;
    }
    worlds.push(world);
    if (attemptsToFirstAdoption !== null && config.stopRule === "first_adoption") break;
  }
  const parallelism = played.length === 0 ? 0 : played.length / Math.max(1, rounds);
  const score = {
    schema: REPLAY_SCHEMA,
    policyId: policy?.id ?? "inline",
    config,
    played,
    rounds,
    attemptsPlayed: played.length,
    adoptionReached: attemptsToFirstAdoption !== null,
    attemptsToFirstAdoption,
    costMsToFirstAdoption,
    costMs,
    parallelism,
    worlds,
    historySeqs: history.map((attempt) => attempt.seq),
  };
  score.value = replayValue({ score, betas });
  score.scoreHash = sha256Hex(JSON.stringify(score));
  return score;
}

/**
 * Paper-shaped replay objective reported for reference: V = s - beta1*N +
 * beta2*N/max(1,k) with s = adoption reached, N = attempts played to the first
 * adoption (or all played attempts when none is reached), k = parallelism.
 * Ranking in `dream.mjs` uses the plan's primary metrics; V is reported.
 */
export function replayValue({ score, betas = DEFAULT_BETAS }) {
  const attempts = score.attemptsToFirstAdoption ?? score.attemptsPlayed;
  const parallelism = Math.max(1, score.parallelism);
  const raw = (score.adoptionReached ? 1 : 0) - betas.beta1 * attempts + betas.beta2 * (attempts / parallelism);
  return Number(raw.toFixed(6));
}

/** Evaluate a set of policies over the same recorded worlds (identical set). */
export function scorePolicies({ corpus, policies, adapter, betas = DEFAULT_BETAS }) {
  return policies.map((policy) => scorePolicy({ corpus, policy, adapter, betas }));
}
