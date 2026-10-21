/**
 * Bounded automatic loop driver (Dream-RSI online rollout, milestone M1).
 *
 * One iteration: recover sweep → admissible-action selection (stalled
 * objectives, duplicate-hypothesis ban, unexplored list, budget rung) →
 * proposer-request construction → proposer invocation (`stub` | `cmd`) →
 * validation pipeline → serialized `runCycle` calls through the normal engine
 * path → loop-state persistence. Bounds: max cycles, wall clock, proposer
 * calls and batch size (proposal preparation only); the engine's cycle lock
 * keeps evaluations serialized. No timers, no guard-failure retries; a crashed
 * cycle is swept by the existing `recoverPendingCycle` on the next start.
 *
 * Loop state lives only under `<runRoot>/loop-<id>/` and never inside the repo.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import path from "node:path";
import { rungFor } from "./budget.mjs";
import { campaignAcceptedCount, defaultRunRoot, historyState, recoverPendingCycle, runCycle } from "./engine.mjs";
import {
  CMD_PROPOSER_TIMEOUT_MS,
  PROPOSER_MODES,
  buildProposerRequest,
  createProposerScratch,
  invokeCmdProposer,
  preferredObjectiveFromFailures,
  runStubProposer,
  scanProbeFailures,
  validateAgentProposal,
} from "./propose.mjs";
import { readLedger } from "./ledger.mjs";
import { ledgerEpoch, loadCandidatePayload, validateCandidate } from "./distill.mjs";
import { policyArtifactPath, policyCurrentPath, readCurrentPolicy, readPolicyArtifact } from "./policy.mjs";

export const LOOP_STATE_SCHEMA = "gjc.self-improve.loop.v1";
export const LOOP_DEFAULTS = Object.freeze({
  maxCycles: 1,
  maxWallMs: 600000,
  maxProposerCalls: 3,
  batchSize: 1,
});
export const MAX_BATCH_SIZE = 8;
export const HEAD_MOVE_STOP_LIMIT = 3;

/**
 * Known flake (R7): the `shared/tests/results.test.ts:158` concurrency test.
 * Matched on two independent signals because bun's report puts the file path
 * and the failing assertion on different lines. Detection only: rejects stand.
 */
export function isKnownFlakeLog(text) {
  if (typeof text !== "string") return false;
  return text.includes("results.test.ts") && /(concurrent appenders|:158)/i.test(text);
}

export function defaultLoopId(now = new Date()) {
  const compact = now.toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  return `${compact}-${randomBytes(2).toString("hex")}`;
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name}_must_be_a_positive_integer`);
}

function gitHeadShort(repoRoot) {
  const proc = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git_head_failed: ${proc.stderr || proc.status}`);
  return proc.stdout.trim();
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendLog(logPath, entry) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
}

function adoptedObjectives(ledgerPath) {
  return new Set(
    readLedger(ledgerPath)
      .filter((row) => row.kind === "cycle" && row.verdict?.decision === "adopt")
      .map((row) => row.objective),
  );
}

/**
 * Descriptive journal-evidence block attached to loop cycle rows (never to
 * standalone `cycle` runs, and never a gate for adoption): the adoption rate
 * comes from this campaign's self-improve ledger rows; the guard-failure-class
 * distribution comes from prior loop-state cycles. Counts only, bounded. The
 * jev-advisor journal is a different corpus (rrsi source tags: jev-journal vs
 * self-improve-ledger) and is not read here.
 */
export function buildJournalEvidence({ ledgerPath, campaignId, cycles = [] }) {
  const rows = readLedger(ledgerPath).filter((row) => row.kind === "cycle" && row.campaignId === campaignId);
  const adoptions = campaignAcceptedCount(ledgerPath, campaignId);
  const guardFailureClasses = { known_flake_suspect: 0, other: 0 };
  for (const entry of cycles) {
    if (entry?.failureClass === "known_flake_suspect") guardFailureClasses.known_flake_suspect += 1;
    else if (entry?.failureClass) guardFailureClasses.other += 1;
  }
  return {
    schema: "gjc.self-improve.journal-evidence.v1",
    adoptionRate: rows.length > 0 ? Number((adoptions / rows.length).toFixed(4)) : null,
    cycleAttempts: rows.length,
    adoptions,
    guardFailureClasses,
    sources: { adoptionRate: "self-improve-ledger", guardFailureClasses: "loop-state" },
    caveat: "Descriptive only; no statistical significance is claimed; never gates adoption.",
  };
}

/**
 * Load the deployed current policy for this repository (absent file ⇒ null,
 * i.e. today's behavior). A present-but-unreadable pointer is reported, never
 * silently ignored.
 */
export function loadCurrentLoopPolicy({ repoRoot, policyDir = path.join(repoRoot, "self-improve", "policies") }) {
  const currentPath = policyCurrentPath({ policyDir });
  if (!fs.existsSync(currentPath)) return { policy: null, error: null, policyDir };
  try {
    const pointer = readCurrentPolicy({ policyDir });
    if (!pointer || typeof pointer.id !== "string") throw new Error("invalid_current_pointer");
    const { policy } = readPolicyArtifact(policyArtifactPath({ policyDir, id: pointer.id }));
    return { policy: { id: policy.id, config: policy.config }, error: null, policyDir };
  } catch (error) {
    return { policy: null, error: `policy_load_failed: ${error.message}`, policyDir };
  }
}

/**
 * Stop-rule precedence for the live loop: an explicit CLI flag wins, then the
 * deployed policy's stop rule, then the default (do not stop on adoption).
 */
export function effectiveStopOnAdopt({ cliStopOnAdopt = false, policy = null } = {}) {
  if (cliStopOnAdopt === true) return true;
  return policy?.config?.stopRule === "first_adoption";
}

/**
 * Admissible next objectives: stalled objectives are blocked (forced
 * exploration onto unexplored probes); otherwise the least-attempted objective
 * first, adapter order as the tie-break.
 *
 * Selection rule for the automatic loop: when the probe scan reports failing
 * cases, the objective that owns those cases leads the list, because `delta` is
 * computed on PRIMARY=decision_accuracy only, so a fully saturated objective can
 * never adopt. A deployed policy steers the order instead:
 *   fixed          adapter order
 *   round_robin    rotate the starting objective by the recorded attempt count
 *   success_greedy objectives with recorded adoptions first, then least-attempted
 *   failure_greedy the failing-case/preferred objective first, then least-attempted
 *   novelty_first  unexplored objectives first, then least-attempted
 * `stallRedirect:false` (policy) skips the stall redirect entirely, so stalled
 * objectives are proposed again by the order rule; `true`/absent keeps the
 * regularization semantics (redirect only while unexplored probes remain).
 */
export function computeAdmissibleActions({
  ledgerPath,
  adapter,
  k = 3,
  preferredObjective = null,
  orderRule = null,
  stallRedirect = null,
}) {
  const state = historyState(ledgerPath, { k });
  const stalled = new Set(state.stalled);
  const attempts = new Map(state.objectives.map((entry) => [entry.objective, entry.attempts]));
  const seen = new Set([...attempts.keys()]);
  const unexplored = adapter.objectives.filter((objective) => !seen.has(objective));
  const order = new Map(adapter.objectives.map((objective, index) => [objective, index]));
  const adopted = adoptedObjectives(ledgerPath);
  const redirectActive = stallRedirect !== false;
  const live = redirectActive ? adapter.objectives.filter((objective) => !stalled.has(objective)) : [...adapter.objectives];
  const forced = redirectActive && stalled.size > 0 ? unexplored.filter((objective) => !stalled.has(objective)) : [];
  let pool = forced.length > 0 ? forced : live;
  // Stall redirects exploration only while alternatives remain. Once every
  // objective has a stall streak and nothing is unexplored, the campaign
  // continues on the least-attempted set until a cap breaches (§4.2) — the
  // proposer-call cap bounds per-gap retries (§16 R1).
  const stallFallback = pool.length === 0 && adapter.objectives.length > 0;
  if (stallFallback) pool = [...adapter.objectives];
  const leastAttempted = (left, right) =>
    (attempts.get(left) ?? 0) - (attempts.get(right) ?? 0) || order.get(left) - order.get(right);
  const totalAttempts = [...attempts.values()].reduce((sum, value) => sum + value, 0);
  let sorted;
  switch (orderRule) {
    case "fixed":
      sorted = [...pool].sort((left, right) => order.get(left) - order.get(right));
      break;
    case "round_robin": {
      const count = adapter.objectives.length || 1;
      const start = totalAttempts % count;
      const rank = (objective) => ((order.get(objective) ?? 0) - start + count) % count;
      sorted = [...pool].sort((left, right) => rank(left) - rank(right) || leastAttempted(left, right));
      break;
    }
    case "success_greedy":
      sorted = [...pool].sort(
        (left, right) => Number(adopted.has(right)) - Number(adopted.has(left)) || leastAttempted(left, right),
      );
      break;
    case "novelty_first":
      sorted = [...pool].sort((left, right) => {
        const leftUnexplored = unexplored.includes(left) ? 0 : 1;
        const rightUnexplored = unexplored.includes(right) ? 0 : 1;
        return leftUnexplored - rightUnexplored || leastAttempted(left, right);
      });
      break;
    default:
      sorted = [...pool].sort(leastAttempted);
      break;
  }
  const reason = orderRule ? `policy:${orderRule}` : "regularization";
  const actions = sorted.map((objective) => ({
    objective,
    reason,
    forcedExploration: redirectActive && stalled.size > 0,
  }));
  const preferredLeads =
    preferredObjective !== null &&
    (orderRule === null || orderRule === "failure_greedy") &&
    (!stalled.has(preferredObjective) || !redirectActive || stallFallback) &&
    actions.some((action) => action.objective === preferredObjective);
  const ordered = preferredLeads
    ? [
        {
          objective: preferredObjective,
          reason: orderRule ? `policy:${orderRule}` : "failing_cases",
          forcedExploration: redirectActive && stalled.size > 0,
        },
        ...actions.filter((action) => action.objective !== preferredObjective),
      ]
    : actions;
  return {
    actions: ordered,
    stalled: [...stalled],
    unexplored,
    priorAttempts: state.lastRejects,
    orderRule: orderRule ?? null,
  };
}

/**
 * Known soft engine errors: a proposal whose patch does not apply is a common
 * proposer mistake, not a harness failure. These are recorded as proposal
 * failures and the loop continues within its caps; everything else still stops
 * the campaign.
 */
export const SOFT_ENGINE_ERROR_PREFIXES = Object.freeze(["patch_check_failed"]);

export function isSoftEngineError(message) {
  return typeof message === "string" && SOFT_ENGINE_ERROR_PREFIXES.some((prefix) => message.startsWith(prefix));
}

/** Short proposer-facing form of a patch-application failure (bounded, opaque). */
export function boundedPatchFailure(message) {
  const text = String(message ?? "");
  const first = text.split("\n")[0].slice(0, 200);
  const fileMatch = /patch failed: ([^\s:]+(?::\d+)?)/.exec(text);
  const location = fileMatch ? fileMatch[1].slice(0, 80) : "unknown file";
  return { short: `patch_check_failed at ${location}: hunk context mismatch`, detail: first };
}

function classifyGuardFailure({ result, runRoot }) {
  if (!result.reasons?.includes("guard_fail")) return null;
  try {
    const logPath = path.join(runRoot, "runs", result.cycleId, "logs", "candidate", "test.log");
    if (!fs.existsSync(logPath)) return "other";
    return isKnownFlakeLog(fs.readFileSync(logPath, "utf8")) ? "known_flake_suspect" : "other";
  } catch {
    return "other";
  }
}

/**
 * Run the bounded loop. `proposer` is the seam: `stub` is a keyless scripted
 * test double; `cmd` invokes an external template and is treated as live mode,
 * requiring `liveApproved` (otherwise the invocation is recorded `skipped`).
 */
export async function runLoop(input) {
  const {
    repoRoot,
    adapter,
    proposer = "stub",
    proposerCmd = null,
    liveApproved = false,
    maxCycles = LOOP_DEFAULTS.maxCycles,
    maxWallMs = LOOP_DEFAULTS.maxWallMs,
    maxProposerCalls = LOOP_DEFAULTS.maxProposerCalls,
    batchSize = LOOP_DEFAULTS.batchSize,
    cmdProposerTimeoutMs = CMD_PROPOSER_TIMEOUT_MS,
    stopOnAdopt = false,
    runRoot = defaultRunRoot(),
    ledgerPath = path.join(repoRoot, "self-improve", "ledger.jsonl"),
    loopId = defaultLoopId(),
    dryRun = false,
    includeSmoke = true,
    install = false,
    candidatePath = null,
    maxLag = 0,
    deps = {},
  } = input ?? {};
  if (!repoRoot || !adapter) throw new Error("loop_requires repoRoot and adapter");
  if (!PROPOSER_MODES.includes(proposer)) throw new Error(`unknown_proposer_mode: ${proposer}`);
  assertPositiveInteger(maxCycles, "max_cycles");
  assertPositiveInteger(maxProposerCalls, "max_proposer_calls");
  assertPositiveInteger(batchSize, "batch_size");
  if (batchSize > MAX_BATCH_SIZE) throw new Error(`batch_size_exceeds_${MAX_BATCH_SIZE}`);
  if (typeof maxWallMs !== "number" || !(maxWallMs >= 1)) throw new Error("max_wall_ms_must_be_positive");
  if (proposer === "cmd" && (typeof proposerCmd !== "string" || proposerCmd.length === 0)) {
    throw new Error("cmd_proposer_requires --proposer-cmd");
  }

  // Handoff candidate: every check lives here so an in-process caller cannot
  // bypass it. A rejected candidate returns a bounded skip reason and runs no cycle.
  let candidate = null;
  if (candidatePath) {
    let candidateText;
    try {
      candidateText = fs.readFileSync(candidatePath, "utf8");
    } catch {
      return { status: "skipped", reason: "candidate_unreadable", loopId };
    }
    const loaded = loadCandidatePayload(candidateText);
    if (!loaded.ok) return { status: "skipped", reason: loaded.reason, loopId };
    const candidateReason = validateCandidate(loaded.candidate, {
      gatedObjective: adapter.probes?.[0]?.objective,
      ledgerHead: ledgerEpoch(readLedger(ledgerPath)),
      maxLag,
    });
    if (candidateReason) return { status: "skipped", reason: candidateReason, loopId };
    candidate = loaded.candidate;
  }

  const nowMs = deps.now ?? Date.now;
  const head = deps.head ?? (() => gitHeadShort(repoRoot));
  const scanFailures = deps.scanProbeFailures ?? ((scanInput) => scanProbeFailures(scanInput));
  const root = path.resolve(runRoot);
  const loopRoot = path.join(root, `loop-${loopId}`);
  const statePath = path.join(loopRoot, "loop-state.json");
  const logPath = path.join(loopRoot, "loop-log.jsonl");
  const campaignId = `loop-${loopId}`;
  const startedAt = new Date(nowMs()).toISOString();
  const startedMs = nowMs();
  const deadline = startedMs + maxWallMs;

  const state = {
    schema: LOOP_STATE_SCHEMA,
    loopId,
    campaignId,
    repoRoot,
    ledgerPath,
    proposer,
    proposerCmd: proposerCmd ?? null,
    liveApproved: liveApproved === true,
    dryRun: dryRun === true,
    caps: { maxCycles, maxWallMs, maxProposerCalls, batchSize, cmdProposerTimeoutMs, stopOnAdopt: stopOnAdopt === true, install: install === true },
    startedAt,
    updatedAt: startedAt,
    status: "running",
    stoppedReason: null,
    counters: { cycles: 0, proposerCalls: 0, headMoves: 0, invalidProposals: 0 },
    recovery: [],
    probeScan: null,
    cycles: [],
  };
  const persist = () => {
    state.updatedAt = new Date(nowMs()).toISOString();
    writeJson(statePath, state);
  };
  const log = (entry) => appendLog(logPath, { at: new Date(nowMs()).toISOString(), ...entry });
  fs.mkdirSync(loopRoot, { recursive: true, mode: 0o700 });

  if (proposer === "cmd" && liveApproved !== true) {
    state.status = "skipped";
    state.stoppedReason = "live_not_approved";
    persist();
    log({ type: "skipped", reason: "live_not_approved", proposer });
    return {
      status: "skipped",
      reason: "live_not_approved",
      loopId,
      loopRoot,
      campaignId,
      statePath,
      logPath,
      counters: { ...state.counters },
      cycles: [],
    };
  }

  // Deployed-policy wiring (M4a): the repository's current policy steers live
  // selection. Absent file ⇒ today's behavior exactly; a broken pointer is
  // reported and the loop falls back to the default schedule.
  const loadedPolicy =
    deps.currentPolicy !== undefined
      ? { policy: deps.currentPolicy, error: null }
      : loadCurrentLoopPolicy({ repoRoot });
  const activePolicy = loadedPolicy.policy ?? null;
  const orderRule = activePolicy?.config?.order ?? null;
  const stallRedirect = activePolicy?.config?.stallRedirect ?? null;
  const stopOnAdoptEffective = effectiveStopOnAdopt({ cliStopOnAdopt: stopOnAdopt === true, policy: activePolicy });
  state.caps.policy = activePolicy
    ? {
        id: activePolicy.id,
        order: activePolicy.config.order,
        batchSize: activePolicy.config.batchSize,
        stopRule: activePolicy.config.stopRule,
        stallRedirect: activePolicy.config.stallRedirect,
        stallK: activePolicy.config.stallK,
      }
    : null;
  state.caps.stopOnAdoptEffective = stopOnAdoptEffective;
  if (loadedPolicy.error) state.policyError = loadedPolicy.error;
  persist();
  log({
    type: "policy",
    policyId: activePolicy?.id ?? null,
    orderRule,
    stallRedirect,
    stopOnAdoptEffective,
    ...(loadedPolicy.error ? { error: loadedPolicy.error } : {}),
  });

  state.recovery = recoverPendingCycle({ runRoot: root, repoRoot });
  persist();
  log({ type: "recovery", results: state.recovery });
  log({ type: "loop_start", caps: state.caps, proposer, liveApproved: liveApproved === true, dryRun: dryRun === true });

  let stoppedReason = null;
  let emptyRounds = 0;
  let lastBlockReason = null;

  while (stoppedReason === null) {
    if (state.counters.cycles >= maxCycles) {
      stoppedReason = "max_cycles";
      break;
    }
    if (state.counters.proposerCalls >= maxProposerCalls) {
      stoppedReason = "max_proposer_calls";
      break;
    }
    if (nowMs() >= deadline) {
      stoppedReason = "max_wall_ms";
      break;
    }
    const accepted = campaignAcceptedCount(ledgerPath, campaignId);
    const rung = rungFor(accepted, adapter.budget);
    const scan = scanFailures({ repoRoot, adapter, deps });
    state.probeScan = { ok: scan.ok, reason: scan.reason ?? null, count: scan.failures?.length ?? 0 };
    if (!scan.ok) log({ type: "probe_scan", ok: false, reason: scan.reason });
    const preferredObjective = preferredObjectiveFromFailures({ failures: scan.failures ?? [], adapter });
    const { actions: computedActions, stalled, unexplored } = computeAdmissibleActions({
      ledgerPath,
      adapter,
      k: adapter.stallK ?? 3,
      preferredObjective,
      orderRule,
      stallRedirect,
    });
    // A pinned candidate replaces the admissibility ordering, not the history
    // inputs: stalled/unexplored still come from the same computation.
    const actions = candidate ? [{ objective: candidate.objective, reason: `candidate:${candidate.id}` }] : computedActions;
    if (actions.length === 0) {
      stoppedReason = stalled.length > 0 ? "all_objectives_stalled" : "no_admissible_actions";
      break;
    }
    const batch = actions.slice(0, batchSize);
    const runnable = [];
    for (const action of batch) {
      if (state.counters.proposerCalls >= maxProposerCalls) break;
      if (nowMs() >= deadline) break;
      const cycleIndex = state.counters.proposerCalls + 1;
      const request = buildProposerRequest({
        loopId,
        cycleIndex,
        objective: action.objective,
        baseCommit: head(),
        adapter,
        rung,
        failures: scan.failures ?? [],
        contrast: candidate
          ? {
              candidateId: candidate.id,
              objective: candidate.objective,
              rule: candidate.rule,
              feature: candidate.contrast.feature,
              adopt: { attemptIds: candidate.contrast.adopt.attemptIds, count: candidate.contrast.adopt.count },
              reject: { attemptIds: candidate.contrast.reject.attemptIds, count: candidate.contrast.reject.count },
              support: candidate.contrast.support,
              evidence: {
                storeDigest: candidate.evidence.storeDigest,
                ledgerSeq: candidate.evidence.ledgerSeq,
                ledgerHead: candidate.evidence.ledgerHead,
                lag: candidate.evidence.lag,
              },
              expires: candidate.expires,
            }
          : null,
        history: {
          priorAttempts: state.cycles.filter((entry) => entry.decision === "reject" || entry.status === "proposal_failed" || entry.status === "proposal_invalid"),
          stalled,
          unexplored,
        },
      });
      state.counters.proposerCalls += 1;
      writeJson(path.join(loopRoot, `cycle-${cycleIndex}.request.json`), request);
      const outcome = proposer === "stub"
        ? runStubProposer({ request, repoRoot, adapter, outDir: loopRoot })
        : (() => {
          const scratchDir = path.join(loopRoot, `scratch-cycle-${cycleIndex}-call-${state.counters.proposerCalls}`);
          createProposerScratch({ repoRoot, destDir: scratchDir, baseRef: request.baseCommit });
          return invokeCmdProposer({
            request,
            template: proposerCmd,
            scratchDir,
            outDir: loopRoot,
            env: deps.proposerEnv ?? process.env,
            timeoutMs: cmdProposerTimeoutMs,
          });
        })();
      if (!outcome.ok) {
        lastBlockReason = outcome.reason;
        state.counters.invalidProposals += 1;
        state.cycles.push({ cycleIndex, objective: action.objective, status: "proposal_failed", reason: outcome.reason });
        log({ type: "proposal_failed", cycleIndex, objective: action.objective, reason: outcome.reason, log: outcome.log ?? null });
        persist();
        continue;
      }
      const validation = validateAgentProposal({
        proposal: outcome.proposal,
        patchText: fs.readFileSync(outcome.proposal.patchFile, "utf8"),
        rung,
        adapter,
        repoRoot,
        ledgerPath,
        stallK: adapter.stallK ?? 3,
      });
      if (!validation.ok) {
        lastBlockReason = validation.reason;
        state.counters.invalidProposals += 1;
        state.cycles.push({
          cycleIndex,
          objective: action.objective,
          status: "proposal_invalid",
          reason: validation.reason,
          reasons: [validation.reason],
          hypothesis: outcome.proposal.hypothesis,
        });
        log({ type: "proposal_invalid", cycleIndex, objective: action.objective, reason: validation.reason, detail: validation });
        persist();
        continue;
      }
      const headAfter = head();
      if (headAfter !== request.baseCommit) {
        lastBlockReason = "head_moved";
        state.counters.headMoves += 1;
        state.cycles.push({
          cycleIndex,
          objective: action.objective,
          status: "head_moved",
          requestedBase: request.baseCommit,
          observedHead: headAfter,
        });
        log({ type: "head_moved", cycleIndex, requestedBase: request.baseCommit, observedHead: headAfter });
        persist();
        if (state.counters.headMoves >= HEAD_MOVE_STOP_LIMIT) {
          stoppedReason = "head_moved";
          break;
        }
        continue;
      }
      runnable.push({ cycleIndex, objective: action.objective, reason: action.reason ?? null, proposal: validation.proposal, outcome });
    }
    if (stoppedReason !== null) break;
    if (runnable.length === 0) {
      // Plan §4.2: the loop continues until a cap breaches; a blocked round
      // is recorded for diagnostics but never stops the campaign.
      emptyRounds += 1;
      persist();
      continue;
    }
    emptyRounds = 0;
    for (const item of runnable) {
      if (state.counters.cycles >= maxCycles || nowMs() >= deadline) break;
      const journalEvidence = buildJournalEvidence({ ledgerPath, campaignId, cycles: state.cycles });
      let result;
      try {
        result = await runCycle({
          repoRoot,
          adapter,
          proposal: {
            ...item.proposal,
            campaignId,
            surface: validationSurface(item.proposal),
          },
          runRoot: root,
          ledgerPath,
          dryRun: dryRun === true,
          includeSmoke,
          install: install === true,
          journalEvidence,
          deps: { runGuards: deps.runGuards, evaluateProbes: deps.evaluateProbes, now: deps.cycleNow, runInstall: deps.runInstall },
        });
      } catch (error) {
        const message = String(error?.message ?? error);
        if (isSoftEngineError(message)) {
          const failure = boundedPatchFailure(message);
          lastBlockReason = failure.short;
          state.counters.invalidProposals += 1;
          state.cycles.push({
            cycleIndex: item.cycleIndex,
            objective: item.objective,
            hypothesis: item.proposal.hypothesis,
            status: "proposal_failed",
            reason: "patch_check_failed",
            reasons: [failure.short],
            detail: failure.detail,
          });
          log({
            type: "proposal_failed",
            cycleIndex: item.cycleIndex,
            objective: item.objective,
            reason: "patch_check_failed",
            detail: failure.detail,
          });
          persist();
          continue;
        }
        state.cycles.push({
          cycleIndex: item.cycleIndex,
          objective: item.objective,
          hypothesis: item.proposal.hypothesis,
          status: "engine_error",
          reason: message,
        });
        log({ type: "engine_error", cycleIndex: item.cycleIndex, message });
        stoppedReason = "engine_error";
        persist();
        break;
      }
      state.counters.cycles += 1;
      const failureClass = classifyGuardFailure({ result, runRoot: root });
      const entry = {
        cycleIndex: item.cycleIndex,
        objective: item.objective,
        selectionReason: item.reason ?? null,
        policyId: activePolicy?.id ?? null,
        hypothesis: item.proposal.hypothesis,
        status: result.status,
        cycleId: result.cycleId ?? null,
        decision: result.decision ?? null,
        reasons: result.reasons ?? [],
        adoption: result.adoption ?? null,
        scores: result.scores ? { delta: result.scores.delta, floor: result.scores.floor } : null,
        failureClass,
        at: new Date(nowMs()).toISOString(),
      };
      state.cycles.push(entry);
      log({
        type: "cycle",
        cycleIndex: entry.cycleIndex,
        cycleId: entry.cycleId,
        objective: entry.objective,
        selectionReason: entry.selectionReason,
        policyId: entry.policyId,
        decision: entry.decision,
        adoption: entry.adoption,
        failureClass,
        dryRun: dryRun === true,
      });
      persist();
      if (candidate) {
        stoppedReason = "candidate_consumed";
        break;
      }
      if (stopOnAdoptEffective && result.adoption === "committed") {
        stoppedReason = "adopted";
        break;
      }
    }
  }

  state.status = "ok";
  state.stoppedReason = stoppedReason;
  persist();
  log({ type: "loop_stop", stoppedReason, counters: state.counters });
  return {
    status: "ok",
    loopId,
    loopRoot,
    campaignId,
    statePath,
    logPath,
    stoppedReason,
    lastBlockReason,
    counters: { ...state.counters },
    recovery: state.recovery,
    cycles: state.cycles,
  };
}

function validationSurface(proposal) {
  return proposal.files ?? [];
}
