/**
 * Deterministic single-cycle engine: baseline/candidate evaluation, gate
 * decisions, ledger recording, replay-gated adoption and crash recovery.
 *
 * Cycle state machine (journaled in `<runRoot>/runs/<cycleId>/phase.json`):
 *   scoring -> cycle-committed -> [replaying -> applying -> committing ->
 *   applied -> adoption-recorded] | replay_failed | rolled_back |
 *   adopt_aborted -> done
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { budgetResetDecision, checkBudget, rungFor } from "./budget.mjs";
import { buildCriticFindings, decideCycle, evaluateCostRule, evaluateHeldout } from "./gates.mjs";
import { matchesEditable } from "./domain.mjs";
import { buildGuardPlan, runGuards as defaultRunGuards } from "./guards.mjs";
import { createScratchCopy } from "./isolate.mjs";
import { appendRow, readLedger } from "./ledger.mjs";
import { sha256Hex } from "./types.mjs";

const SELF_IMPROVE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function defaultRunRoot() {
  return path.join(os.homedir(), ".gjc-plugin", "self-improve");
}

function gitProc(repoRoot, args, options = {}) {
  return spawnSync("git", ["-C", repoRoot, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options });
}

function gitOut(repoRoot, args) {
  const proc = gitProc(repoRoot, args);
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr || proc.status}`);
  return proc.stdout.trim();
}

export function assertRepoState({ repoRoot, baseCommit }) {
  const head = gitOut(repoRoot, ["rev-parse", "HEAD"]);
  const headShort = head.slice(0, 7);
  if (baseCommit && !head.startsWith(baseCommit)) {
    return { ok: false, reason: "base_mismatch", head: headShort };
  }
  const status = gitOut(repoRoot, ["status", "--porcelain"]);
  if (status.length > 0) {
    return { ok: false, reason: "dirty_worktree", head: headShort, dirty: status.split("\n").length };
  }
  return { ok: true, reason: null, head, headShort };
}

export function acquireCycleLock({ lockPath, now = new Date().toISOString(), pid = process.pid }) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify({ pid, startedAt: now }));
    fs.closeSync(fd);
    return {
      acquired: true,
      lockPath,
      release() {
        try {
          fs.rmSync(lockPath);
        } catch {
          /* best effort */
        }
      },
    };
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    let holder = null;
    try {
      holder = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    } catch {
      holder = null;
    }
    let alive = false;
    if (holder && Number.isInteger(holder.pid)) {
      try {
        process.kill(holder.pid, 0);
        alive = true;
      } catch (killError) {
        alive = killError.code === "EPERM";
      }
    }
    // Never steal: a stale lock is reported but left in place for the operator.
    return { acquired: false, lockPath, stale: !alive, holder };
  }
}

export function parsePatchNumstat(patchText) {
  const proc = spawnSync("git", ["apply", "--numstat"], { input: patchText, encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`patch_parse_failed: ${proc.stderr || proc.status}`);
  const files = [];
  for (const line of proc.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [added, deleted, file] = line.split("\t");
    if (!file) throw new Error(`unexpected_numstat_row: ${line}`);
    if (file.includes(" => ")) throw new Error(`rename_patch_unsupported: ${file}`);
    files.push({
      path: file.replaceAll("\\", "/"),
      added: Number.parseInt(added, 10) || 0,
      deleted: Number.parseInt(deleted, 10) || 0,
    });
  }
  return files;
}

export function countHunks(patchText) {
  return (patchText.match(/^@@ /gm) ?? []).length;
}

const HELDOUT_SUMMARY_KEYS = 8;

function boundedHeldoutMap(map) {
  const out = {};
  for (const key of Object.keys(map ?? {}).sort().slice(0, HELDOUT_SUMMARY_KEYS)) {
    const value = map[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

/**
 * Bounded held-out summary recorded on the cycle row (`scores.heldout`): the
 * decision plus at most 8 numeric values per side, so the <=2 KiB ledger row
 * limit holds even when a probe runner emits a wide held-out map.
 */
export function summarizeHeldout({ ok, regressions = [] }, probesHeldout = {}) {
  return {
    ok: ok === true,
    regressions: (regressions ?? []).slice(0, HELDOUT_SUMMARY_KEYS),
    baseline: boundedHeldoutMap(probesHeldout.baseline),
    candidate: boundedHeldoutMap(probesHeldout.candidate),
  };
}

function treeBytes(dir) {
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const target = path.join(dir, name);
    const stat = fs.lstatSync(target);
    if (stat.isDirectory()) total += treeBytes(target);
    else if (stat.isFile()) total += stat.size;
  }
  return total;
}

function applyPatch(dir, patchText) {
  const check = spawnSync("git", ["apply", "--check"], { cwd: dir, input: patchText, encoding: "utf8" });
  if (check.status !== 0) throw new Error(`patch_check_failed: ${check.stderr || check.status}`);
  const apply = spawnSync("git", ["apply"], { cwd: dir, input: patchText, encoding: "utf8" });
  if (apply.status !== 0) throw new Error(`patch_apply_failed: ${apply.stderr || apply.status}`);
}


function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function commitPaths(repoRoot, message, relPaths) {
  const add = gitProc(repoRoot, ["add", "--", ...relPaths]);
  if (add.status !== 0) throw new Error(`git_add_failed: ${add.stderr || add.status}`);
  const proc = gitProc(repoRoot, ["commit", "-m", message]);
  if (proc.status !== 0) throw new Error(`commit_failed: ${proc.stderr || proc.status}`);
  return gitOut(repoRoot, ["rev-parse", "HEAD"]);
}

let cachedConfig;
function loadConfig() {
  if (cachedConfig !== undefined) return cachedConfig;
  try {
    cachedConfig = JSON.parse(fs.readFileSync(path.join(SELF_IMPROVE_ROOT, "rrsi.json"), "utf8"));
  } catch {
    cachedConfig = {};
  }
  return cachedConfig;
}

function porcelainPaths(repoRoot) {
  // Parse the raw porcelain stream: trimming would strip the leading status
  // space of the first line and corrupt that path.
  const proc = gitProc(repoRoot, ["status", "--porcelain"]);
  if (proc.status !== 0) throw new Error(`git status failed: ${proc.stderr || proc.status}`);
  return proc.stdout
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => {
      const rest = line.slice(3);
      return rest.includes(" -> ") ? rest.split(" -> ")[1] : rest;
    });
}

/** Restore tracked paths and remove untracked ones; used for rollback and recovery sweeps. */
function restorePaths(repoRoot, relPaths) {
  for (const rel of relPaths) {
    const tracked = gitProc(repoRoot, ["ls-files", "--error-unmatch", "--", rel]).status === 0;
    if (tracked) {
      const proc = gitProc(repoRoot, ["checkout", "--", rel]);
      if (proc.status !== 0) throw new Error(`rollback_failed: ${proc.stderr || proc.status}`);
    } else {
      fs.rmSync(path.join(repoRoot, rel), { recursive: true, force: true });
    }
  }
}

export function campaignAcceptedCount(ledgerPath, campaignId) {
  const rows = readLedger(ledgerPath);
  const adopted = new Set(rows.filter((row) => row.kind === "adoption").map((row) => row.cycleId));
  return rows.filter(
    (row) =>
      row.kind === "cycle" &&
      row.campaignId === campaignId &&
      row.verdict?.decision === "adopt" &&
      adopted.has(row.cycleId),
  ).length;
}

export function historyState(ledgerPath, { k = 3 } = {}) {
  const cycles = readLedger(ledgerPath).filter((row) => row.kind === "cycle");
  const lastRejects = cycles
    .filter((row) => row.verdict?.decision === "reject")
    .slice(-5)
    .map((row) => ({
      cycleId: row.cycleId,
      objective: row.objective,
      hypothesisHash: row.hypothesisHash,
      reasons: row.verdict.reasons,
    }));
  const perObjective = new Map();
  for (const row of cycles) {
    const entry = perObjective.get(row.objective) ?? {
      objective: row.objective,
      attempts: 0,
      consecutiveRejects: 0,
      hypothesisHashes: [],
    };
    entry.attempts += 1;
    entry.consecutiveRejects = row.verdict?.decision === "reject" ? entry.consecutiveRejects + 1 : 0;
    entry.hypothesisHashes.push(row.hypothesisHash);
    perObjective.set(row.objective, entry);
  }
  const objectives = [...perObjective.values()];
  const stalled = objectives.filter((entry) => entry.consecutiveRejects >= k).map((entry) => entry.objective);
  return { lastRejects, objectives, stalled };
}

/**
 * History conditioning: reject the same (objective, hypothesis) resubmission and
 * force stalled objectives onto an unexplored probe before any evaluation runs.
 */
export function checkProposalHistory({ ledgerPath, proposal, adapterObjectives = [], k = 3 }) {
  const cycles = readLedger(ledgerPath).filter((row) => row.kind === "cycle");
  const hypothesisHash = sha256Hex(proposal.hypothesis);
  if (cycles.some((row) => row.objective === proposal.objective && row.hypothesisHash === hypothesisHash)) {
    return { ok: false, reason: "history_duplicate_hypothesis", hypothesisHash };
  }
  const state = historyState(ledgerPath, { k });
  if (state.stalled.includes(proposal.objective)) {
    const unexplored = adapterObjectives.filter(
      (objective) => !state.objectives.some((entry) => entry.objective === objective),
    );
    return { ok: false, reason: "forced_exploration", stalled: proposal.objective, unexplored };
  }
  return { ok: true, reason: null, hypothesisHash, forcedExploration: state.stalled.length > 0 };
}

function defaultCycleId(now) {
  const compact = now.replace(/[-:.TZ]/g, "").slice(0, 14);
  return `cyc-${compact}-${randomBytes(2).toString("hex")}`;
}

async function defaultEvaluateProbes({ adapter, baselineDir, candidateDir }) {
  if (!Array.isArray(adapter.probes) || adapter.probes.length === 0) {
    return { baseline: {}, candidate: {}, delta: 0, heldout: { baseline: {}, candidate: {} } };
  }
  const runnerRel = adapter.probes[0].runner;
  if (typeof runnerRel !== "string" || runnerRel.length === 0) {
    throw new Error("probe_runner_missing: adapter probes must declare a runner path");
  }
  const runnerPath = path.resolve(SELF_IMPROVE_ROOT, runnerRel);
  const proc = spawnSync("bun", [runnerPath, "--baseline", baselineDir, "--candidate", candidateDir, "--json"], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.status !== 0) throw new Error(`probe_runner_failed: ${proc.stderr || proc.status}`);
  let parsed;
  try {
    parsed = JSON.parse(proc.stdout);
  } catch (error) {
    throw new Error(`probe_runner_invalid_json: ${error.message}`);
  }
  return {
    baseline: parsed.baseline ?? {},
    candidate: parsed.candidate ?? {},
    delta: parsed.delta ?? 0,
    heldout: parsed.heldout ?? { baseline: {}, candidate: {} },
  };
}

function resolvePluginName(touched) {
  return (
    touched
      .map((rel) => rel.split("/")[0])
      .find((name) => /^(jev-advisor|verification-receipts|ui-regression)$/.test(name)) ?? null
  );
}

/** Explicit `--install` path: user-scoped plugin upgrade plus a doctor check. */
function defaultRunInstall({ repoRoot, touched }) {
  const plugin = resolvePluginName(touched);
  if (!plugin) return { install: "failed", reason: "plugin_not_resolved" };
  const upgrade = spawnSync("gjc", ["plugin", "upgrade", plugin, "--user"], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 120000,
  });
  if (upgrade.status !== 0) return { install: "failed", reason: `upgrade_exit_${upgrade.status}`, plugin };
  const doctor = spawnSync("gjc", ["plugin", "doctor"], { cwd: repoRoot, encoding: "utf8", timeout: 120000 });
  if (doctor.status !== 0) return { install: "failed", reason: `doctor_exit_${doctor.status}`, plugin };
  return { install: "upgraded", plugin };
}

export async function runCycle(input) {
  const {
    repoRoot,
    adapter,
    proposal,
    runRoot = defaultRunRoot(),
    ledgerPath = path.join(repoRoot, "self-improve", "ledger.jsonl"),
    dryRun = false,
    includeSmoke = true,
    deps = {},
  } = input;
  if (!repoRoot || !adapter || !proposal) throw new Error("run_cycle_requires repoRoot, adapter and proposal");
  if (!proposal.patchFile || !proposal.hypothesis || !proposal.objective) {
    throw new Error("proposal_requires patchFile, hypothesis and objective");
  }
  if (!proposal.commitMessage) throw new Error("proposal_requires commitMessage");
  const ledgerRel = path.relative(repoRoot, ledgerPath);
  if (ledgerRel.startsWith("..") || path.isAbsolute(ledgerRel)) {
    throw new Error("ledger_must_live_inside_repository");
  }
  const runGuards = deps.runGuards ?? defaultRunGuards;
  const evaluateProbes = deps.evaluateProbes ?? defaultEvaluateProbes;
  const now = deps.now ?? (() => new Date().toISOString());
  const config = loadConfig();
  const minDelta = input.minDelta ?? config.minDelta ?? 0.01;
  const costConfig = input.costConfig ?? {
    wallMsBytesIncreaseRatio: config.cost?.wallMsBytesIncreaseRatio ?? 0.15,
    gainMultipleOfFloor: config.cost?.gainMultipleOfFloor ?? 2,
  };
  const retention = input.retention ?? config.retention?.rawCycles ?? 10;
  const stallK = input.stallK ?? config.stall?.k ?? 3;
  const startedAt = Date.now();

  const patchFile = path.resolve(proposal.patchFile);
  const patchText = fs.readFileSync(patchFile, "utf8");
  const patchSha256 = sha256Hex(patchText);
  const patchBytes = Buffer.byteLength(patchText, "utf8");
  const numstat = parsePatchNumstat(patchText);
  const touched = numstat.map((row) => row.path);
  const hunks = countHunks(patchText);
  if (touched.length === 0) {
    return { status: "rejected", decision: "reject", reasons: ["empty_patch"], recorded: false };
  }

  const history = checkProposalHistory({
    ledgerPath,
    proposal,
    adapterObjectives: adapter.objectives ?? [],
    k: stallK,
  });
  if (!history.ok) {
    return {
      status: "rejected",
      decision: "reject",
      reasons: [history.reason],
      recorded: false,
      ...(history.unexplored ? { unexplored: history.unexplored } : {}),
    };
  }

  const repoState = assertRepoState({ repoRoot, baseCommit: proposal.baseCommit });
  if (!repoState.ok) {
    return { status: "aborted", reason: repoState.reason, head: repoState.headShort, dirty: repoState.dirty };
  }

  const lock = dryRun ? null : acquireCycleLock({ lockPath: path.join(runRoot, "locks", "cycle.lock"), now: now() });
  if (lock && !lock.acquired) {
    return {
      status: "busy",
      reason: lock.stale ? "cycle_busy_stale" : "cycle_busy",
      stale: lock.stale,
      holder: lock.holder,
    };
  }

  const cycleId = proposal.cycleId ?? defaultCycleId(now());
  const campaignId = proposal.campaignId ?? "default";
  const cycleRunDir = dryRun
    ? fs.mkdtempSync(path.join(os.tmpdir(), "self-improve-dry-"))
    : path.join(runRoot, "runs", cycleId);
  const phase = (name, extra = {}) => {
    if (!dryRun) writeJson(path.join(cycleRunDir, "phase.json"), { phase: name, at: now(), ...extra });
  };

  // Guard fixtures live under the OS temp dir, never under a `.gjc-plugin`
  // component: plugin result-root boundary detection would otherwise mis-anchor
  // on this run's own storage tree.
  const guardHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-improve-guard-home-"));

  try {
    if (!dryRun) {
      fs.mkdirSync(cycleRunDir, { recursive: true, mode: 0o700 });
      try {
        fs.copyFileSync(patchFile, path.join(cycleRunDir, "patch.diff"));
        writeJson(path.join(cycleRunDir, "proposal.json"), proposal);
      } catch {
        /* raw evidence copies are best effort */
      }
    }
    phase("scoring");
    const resetDecision = budgetResetDecision({ resetFlag: input.resetBudget === true });
    const accepted = resetDecision.reset ? 0 : campaignAcceptedCount(ledgerPath, campaignId);
    const rung = rungFor(accepted, adapter.budget);
    const budgetReport = checkBudget({ files: touched, hunks }, rung);
    const surface = proposal.surface ?? touched;

    const baseline = createScratchCopy({ repoRoot, destDir: path.join(cycleRunDir, "baseline") });
    const candidate = createScratchCopy({ repoRoot, destDir: path.join(cycleRunDir, "candidate") });
    applyPatch(candidate.scratchDir, patchText);

    const baselineStarted = Date.now();
    const baselineGuards = await runGuards({
      guards: buildGuardPlan({
        repoRoot,
        scratchDir: baseline.scratchDir,
        runRoot: path.join(cycleRunDir, "baseline-eval"),
        includeSmoke,
        homeRoot: guardHomeRoot,
      }),
      runRoot: path.join(cycleRunDir, "baseline-eval"),
      logDir: path.join(cycleRunDir, "logs", "baseline"),
    });
    const baselineWallMs = Date.now() - baselineStarted;
    const candidateStarted = Date.now();
    const candidateGuards = await runGuards({
      guards: buildGuardPlan({
        repoRoot,
        scratchDir: candidate.scratchDir,
        runRoot: path.join(cycleRunDir, "candidate-eval"),
        includeSmoke,
        homeRoot: guardHomeRoot,
      }),
      runRoot: path.join(cycleRunDir, "candidate-eval"),
      logDir: path.join(cycleRunDir, "logs", "candidate"),
    });
    const candidateWallMs = Date.now() - candidateStarted;

    const probes = await evaluateProbes({
      adapter,
      baselineDir: baseline.scratchDir,
      candidateDir: candidate.scratchDir,
      runRoot: cycleRunDir,
    });
    const floor = Math.max(minDelta, probes.floor ?? 0);
    const scores = {
      baseline: probes.baseline ?? {},
      candidate: probes.candidate ?? {},
      delta: probes.delta ?? 0,
      floor,
    };
    const costRule = evaluateCostRule({
      baselineCost: { wallMs: baselineWallMs, bytes: treeBytes(baseline.scratchDir) },
      candidateCost: { wallMs: candidateWallMs, bytes: treeBytes(candidate.scratchDir) },
      delta: scores.delta,
      floor,
      config: costConfig,
    });
    const heldout = evaluateHeldout({
      heldoutBaseline: probes.heldout?.baseline ?? {},
      heldoutCandidate: probes.heldout?.candidate ?? {},
    });
    scores.heldout = summarizeHeldout(heldout, probes.heldout ?? {});
    const critic = buildCriticFindings({ patchText, touched, surface, adapter, rung, hunks });
    const decision = decideCycle({
      critic,
      guards: candidateGuards,
      scores,
      costRule,
      heldout,
      budget: budgetReport,
    });

    if (dryRun) {
      fs.rmSync(cycleRunDir, { recursive: true, force: true });
      return {
        status: "dry-run",
        cycleId,
        decision: decision.decision,
        reasons: decision.reasons,
        scores,
        touched,
        hunks,
        guards: candidateGuards.map(({ id, status }) => ({ id, status })),
        critic,
        costRule,
        heldout,
        budget: budgetReport,
      };
    }

    const cycleRow = {
      kind: "cycle",
      cycleId,
      domain: adapter.id,
      campaignId,
      baseCommit: repoState.headShort,
      budgetRung: rung.index,
      proposal: { source: proposal.source ?? "manual", patchSha256, files: touched, hunks },
      hypothesisHash: sha256Hex(proposal.hypothesis),
      objective: proposal.objective,
      scores,
      cost: { wallMs: Date.now() - startedAt, bytes: patchBytes, tokens: null },
      guards: candidateGuards.map(({ id, status }) => ({ id, status })),
      critic: { verdict: critic.verdict, rules: critic.rules.map(({ id, reason }) => ({ id, reason })) },
      verdict: { decision: decision.decision, reasons: decision.reasons },
      ...(touched.some((rel) => (adapter.textFixtures ?? []).includes(rel)) ? { labels: ["text_fixture"] } : {}),
      ...(history.forcedExploration ? { forcedExploration: true } : {}),
      createdAt: now(),
    };
    const cycleReceipt = appendRow(ledgerPath, cycleRow);
    commitPaths(repoRoot, `chore(self-improve): cycle ${cycleId} ${decision.decision}`, [ledgerRel]);
    phase("cycle-committed", { decision: decision.decision, row: cycleReceipt.seq });
    const postRecordHead = gitOut(repoRoot, ["rev-parse", "HEAD"]).slice(0, 7);

    const result = {
      status: "ok",
      cycleId,
      decision: decision.decision,
      reasons: decision.reasons,
      scores,
      guards: candidateGuards.map(({ id, status }) => ({ id, status })),
      critic,
      adoption: "none",
      rowSeq: cycleReceipt.seq,
    };
    if (decision.decision !== "adopt") {
      phase("done");
      pruneRuns({ runRoot, keep: retention });
      return result;
    }

    phase("replaying");
    const replay = createScratchCopy({ repoRoot, destDir: path.join(cycleRunDir, "replay") });
    applyPatch(replay.scratchDir, patchText);
    const replayGuards = await runGuards({
      guards: buildGuardPlan({
        repoRoot,
        scratchDir: replay.scratchDir,
        runRoot: path.join(cycleRunDir, "replay-eval"),
        includeSmoke,
        homeRoot: guardHomeRoot,
      }),
      runRoot: path.join(cycleRunDir, "replay-eval"),
      logDir: path.join(cycleRunDir, "logs", "replay"),
    });
    if (replayGuards.some((guard) => guard.status !== "pass")) {
      writeJson(path.join(cycleRunDir, "failure.json"), {
        reason: "replay_failed",
        guards: replayGuards.map(({ id, status }) => ({ id, status })),
        at: now(),
      });
      phase("replay_failed");
      result.adoption = "replay_failed";
      return result;
    }

    const preApply = assertRepoState({ repoRoot, baseCommit: postRecordHead });
    if (!preApply.ok) {
      writeJson(path.join(cycleRunDir, "failure.json"), { reason: preApply.reason, stage: "pre-apply", at: now() });
      phase("adopt_aborted", { reason: preApply.reason });
      result.adoption = `aborted_${preApply.reason}`;
      return result;
    }
    phase("applying");
    const modified = touched.filter((rel) => fs.existsSync(path.join(repoRoot, rel)));
    const added = touched.filter((rel) => !fs.existsSync(path.join(repoRoot, rel)));
    writeJson(path.join(cycleRunDir, "applied.json"), { repoRoot, modified, added, at: now() });
    applyPatch(repoRoot, patchText);
    const realGuards = await runGuards({
      guards: buildGuardPlan({
        repoRoot,
        scratchDir: repoRoot,
        runRoot: path.join(cycleRunDir, "real-eval"),
        includeSmoke,
        homeRoot: guardHomeRoot,
      }),
      runRoot: path.join(cycleRunDir, "real-eval"),
      logDir: path.join(cycleRunDir, "logs", "real"),
    });
    if (realGuards.some((guard) => guard.status !== "pass")) {
      restorePaths(repoRoot, porcelainPaths(repoRoot));
      const clean = porcelainPaths(repoRoot).length === 0;
      writeJson(path.join(cycleRunDir, "failure.json"), {
        reason: "post_apply_failure",
        guards: realGuards.map(({ id, status }) => ({ id, status })),
        clean,
        at: now(),
      });
      phase("rolled_back", { clean });
      result.adoption = "post_apply_failure";
      result.rolledBack = true;
      result.clean = clean;
      return result;
    }

    // The adopted commit includes the regenerated surfaces rewritten by the
    // build guard: staging only the patch paths would commit stale generated
    // files and leave the worktree dirty for the next cycle.
    const dirty = porcelainPaths(repoRoot);
    const expected = new Set([...touched, ...dirty.filter((rel) => matchesEditable(rel, adapter.generated))]);
    const unexpected = dirty.filter((rel) => !expected.has(rel));
    if (unexpected.length > 0) {
      restorePaths(repoRoot, dirty);
      const clean = porcelainPaths(repoRoot).length === 0;
      writeJson(path.join(cycleRunDir, "failure.json"), {
        reason: "unexpected_workspace_changes",
        unexpected,
        clean,
        at: now(),
      });
      phase("rolled_back", { clean });
      result.adoption = "post_apply_failure";
      result.rolledBack = true;
      result.clean = clean;
      return result;
    }

    phase("committing");
    const codeCommit = commitPaths(repoRoot, proposal.commitMessage, [...expected]);
    phase("applied", { codeCommit: codeCommit.slice(0, 7) });
    let installState = "not_attempted";
    if (input.install === true) {
      const installer = deps.runInstall ?? defaultRunInstall;
      let installResult;
      try {
        installResult = installer({ repoRoot, touched });
      } catch (error) {
        installResult = { install: "failed", reason: error.message };
      }
      installState = installResult.install === "upgraded" ? "upgraded" : "failed";
      writeJson(path.join(cycleRunDir, "install.json"), { ...installResult, at: now() });
    }
    appendRow(ledgerPath, {
      kind: "adoption",
      cycleId,
      commit: codeCommit.slice(0, 7),
      install: installState,
      createdAt: now(),
    });
    phase("adoption-recorded");
    commitPaths(repoRoot, `chore(self-improve): record adoption ${cycleId}`, [ledgerRel]);
    phase("done");
    result.adoption = "committed";
    result.codeCommit = codeCommit.slice(0, 7);
    pruneRuns({ runRoot, keep: retention });
    return result;
  } catch (error) {
    try {
      if (fs.existsSync(cycleRunDir)) {
        writeJson(path.join(cycleRunDir, "failure.json"), { reason: "engine_error", message: error.message, at: now() });
        phase("failed");
      }
    } catch {
      /* best effort */
    }
    throw error;
  } finally {
    lock?.release();
    try {
      fs.rmSync(guardHomeRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * Roll back or complete cycles that crashed mid-apply or between commits:
 *  - `applying`: sweep every dirty path back to HEAD (the clean precondition
 *    means all dirt came from this cycle) and record the rollback.
 *  - `committing`: a crash spanning the code commit. Dirty paths are rolled
 *    back; a clean tree with the commit possibly landed is reported as
 *    `commit_state_uncertain` for the operator instead of guessing.
 *  - `adoption-recorded`: finish the missing adoption chore commit.
 */
export function recoverPendingCycle({ runRoot = defaultRunRoot(), repoRoot }) {
  const runsRoot = path.join(runRoot, "runs");
  const results = [];
  if (!fs.existsSync(runsRoot)) return results;
  const at = new Date().toISOString();
  for (const name of fs.readdirSync(runsRoot)) {
    const dir = path.join(runsRoot, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const phasePath = path.join(dir, "phase.json");
    if (!fs.existsSync(phasePath)) continue;
    let phaseRecord = null;
    try {
      phaseRecord = JSON.parse(fs.readFileSync(phasePath, "utf8"));
    } catch {
      phaseRecord = null;
    }
    if (!phaseRecord || !phaseRecord.phase) continue;
    const phaseName = phaseRecord.phase;
    if (phaseName === "applying") {
      if (!repoRoot) {
        results.push({ cycleId: name, recovered: false, clean: null });
        continue;
      }
      restorePaths(repoRoot, porcelainPaths(repoRoot));
      const clean = porcelainPaths(repoRoot).length === 0;
      writeJson(phasePath, { ...phaseRecord, phase: "rolled_back", clean, at });
      writeJson(path.join(dir, "failure.json"), { reason: "post_apply_failure", recovered: true, clean, at });
      results.push({ cycleId: name, recovered: true, clean });
      continue;
    }
    if (phaseName === "committing") {
      if (!repoRoot) {
        results.push({ cycleId: name, recovered: false, clean: null });
        continue;
      }
      const dirty = porcelainPaths(repoRoot);
      if (dirty.length > 0) {
        restorePaths(repoRoot, dirty);
        const clean = porcelainPaths(repoRoot).length === 0;
        writeJson(phasePath, { ...phaseRecord, phase: "rolled_back", clean, at });
        writeJson(path.join(dir, "failure.json"), { reason: "post_apply_failure", recovered: true, clean, at });
        results.push({ cycleId: name, recovered: true, clean });
      } else {
        writeJson(phasePath, { ...phaseRecord, phase: "commit_state_uncertain", at });
        writeJson(path.join(dir, "failure.json"), { reason: "commit_state_uncertain", recovered: false, at });
        results.push({ cycleId: name, recovered: false, clean: true });
      }
      continue;
    }
    if (phaseName === "adoption-recorded") {
      if (!repoRoot) {
        results.push({ cycleId: name, recovered: false, clean: null });
        continue;
      }
      const dirty = porcelainPaths(repoRoot);
      const ledgerRel = path.posix.join("self-improve", "ledger.jsonl");
      if (dirty.length > 0 && dirty.every((rel) => rel === ledgerRel)) {
        commitPaths(repoRoot, `chore(self-improve): record adoption ${name}`, [ledgerRel]);
        writeJson(phasePath, { ...phaseRecord, phase: "done", at });
        results.push({ cycleId: name, recovered: true, clean: true });
      } else {
        const settled = dirty.length === 0;
        writeJson(phasePath, { ...phaseRecord, phase: settled ? "done" : "adoption_state_uncertain", at });
        writeJson(path.join(dir, "failure.json"), {
          reason: settled ? "adoption_settled" : "adoption_state_uncertain",
          dirty,
          at,
        });
        results.push({ cycleId: name, recovered: settled, clean: settled, ...(settled ? {} : { dirty }) });
      }
      continue;
    }
  }
  return results;
}

/** Retention: keep the newest `keep` completed run directories; never touch in-flight ones. */
export function pruneRuns({ runRoot = defaultRunRoot(), keep = 10 }) {
  const runsRoot = path.join(runRoot, "runs");
  const removed = [];
  if (!fs.existsSync(runsRoot)) return { removed };
  const finished = new Set(["done", "rolled_back", "replay_failed"]);
  const entries = [];
  for (const name of fs.readdirSync(runsRoot)) {
    const dir = path.join(runsRoot, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    const phasePath = path.join(dir, "phase.json");
    let phaseRecord = null;
    try {
      phaseRecord = JSON.parse(fs.readFileSync(phasePath, "utf8"));
    } catch {
      phaseRecord = null;
    }
    if (!phaseRecord || !finished.has(phaseRecord.phase)) continue;
    entries.push({ name, dir, mtimeMs: fs.statSync(dir).mtimeMs });
  }
  entries.sort((left, right) => left.mtimeMs - right.mtimeMs);
  for (const entry of entries.slice(0, Math.max(0, entries.length - keep))) {
    fs.rmSync(entry.dir, { recursive: true, force: true });
    removed.push(entry.name);
  }
  return { removed };
}
