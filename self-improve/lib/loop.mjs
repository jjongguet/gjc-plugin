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

export const LOOP_STATE_SCHEMA = "gjc.self-improve.loop.v1";
export const LOOP_DEFAULTS = Object.freeze({
  maxCycles: 1,
  maxWallMs: 600000,
  maxProposerCalls: 3,
  batchSize: 1,
});
export const MAX_BATCH_SIZE = 8;
export const HEAD_MOVE_STOP_LIMIT = 3;
export const EMPTY_ROUND_LIMIT = 2;

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

/**
 * Admissible next objectives: stalled objectives are blocked (forced
 * exploration onto unexplored probes); otherwise the least-attempted objective
 * first, adapter order as the tie-break.
 *
 * Selection rule for the automatic loop: when the probe scan reports failing
 * cases, the objective that owns those cases leads the list, because `delta` is
 * computed on PRIMARY=decision_accuracy only, so a fully saturated objective can
 * never adopt. Stall and duplicate rules still win — a stalled preferred
 * objective is dropped and the regularization order (forced exploration, then
 * least-attempted) applies.
 */
export function computeAdmissibleActions({ ledgerPath, adapter, k = 3, preferredObjective = null }) {
  const state = historyState(ledgerPath, { k });
  const stalled = new Set(state.stalled);
  const attempts = new Map(state.objectives.map((entry) => [entry.objective, entry.attempts]));
  const seen = new Set([...attempts.keys()]);
  const unexplored = adapter.objectives.filter((objective) => !seen.has(objective));
  const order = new Map(adapter.objectives.map((objective, index) => [objective, index]));
  const live = adapter.objectives.filter((objective) => !stalled.has(objective));
  const forced = stalled.size > 0 ? unexplored.filter((objective) => !stalled.has(objective)) : [];
  const pool = forced.length > 0 ? forced : live;
  const actions = [...pool]
    .sort((left, right) => (attempts.get(left) ?? 0) - (attempts.get(right) ?? 0) || order.get(left) - order.get(right))
    .map((objective) => ({ objective, reason: "regularization", forcedExploration: stalled.size > 0 }));
  const preferredAvailable =
    preferredObjective !== null && !stalled.has(preferredObjective) && actions.some((action) => action.objective === preferredObjective);
  const ordered = preferredAvailable
    ? [
        { objective: preferredObjective, reason: "failing_cases", forcedExploration: stalled.size > 0 },
        ...actions.filter((action) => action.objective !== preferredObjective),
      ]
    : actions;
  return { actions: ordered, stalled: [...stalled], unexplored, priorAttempts: state.lastRejects };
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
    const { actions, stalled, unexplored } = computeAdmissibleActions({
      ledgerPath,
      adapter,
      k: adapter.stallK ?? 3,
      preferredObjective,
    });
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
        history: {
          priorAttempts: state.cycles.filter((entry) => entry.decision === "reject" || entry.status === "proposal_failed"),
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
      emptyRounds += 1;
      if (emptyRounds >= EMPTY_ROUND_LIMIT) {
        stoppedReason = lastBlockReason ?? "no_runnable_proposals";
        break;
      }
      continue;
    }
    emptyRounds = 0;
    for (const item of runnable) {
      if (state.counters.cycles >= maxCycles || nowMs() >= deadline) break;
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
        decision: entry.decision,
        adoption: entry.adoption,
        failureClass,
        dryRun: dryRun === true,
      });
      persist();
      if (stopOnAdopt === true && result.adoption === "committed") {
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
    counters: { ...state.counters },
    recovery: state.recovery,
    cycles: state.cycles,
  };
}

function validationSurface(proposal) {
  return proposal.files ?? [];
}
