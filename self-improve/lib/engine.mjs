/**
 * Deterministic single-cycle engine: baseline/candidate evaluation, gate
 * decisions, ledger recording, replay-gated adoption and crash recovery.
 *
 * Cycle state machine (journaled in `<runRoot>/runs/<cycleId>/phase.json`):
 *   scoring -> cycle-committed -> [replaying -> applying -> applied ->
 *   adoption-committed] | replay_failed | rolled_back -> done
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { checkBudget, rungFor } from "./budget.mjs";
import { buildCriticFindings, decideCycle, evaluateCostRule, evaluateHeldout } from "./gates.mjs";
import { buildGuardPlan, runGuards as defaultRunGuards } from "./guards.mjs";
import { createScratchCopy } from "./isolate.mjs";
import { appendRow, readLedger } from "./ledger.mjs";
import { sha256Hex } from "./types.mjs";

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

function revertWorkspace({ repoRoot, modified, added }) {
  for (const rel of added) {
    try {
      fs.rmSync(path.join(repoRoot, rel), { force: true });
    } catch {
      /* best effort */
    }
  }
  if (modified.length > 0) {
    const proc = gitProc(repoRoot, ["checkout", "--", ...modified]);
    if (proc.status !== 0) throw new Error(`rollback_failed: ${proc.stderr || proc.status}`);
  }
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

export function campaignAcceptedCount(ledgerPath, campaignId) {
  return readLedger(ledgerPath).filter(
    (row) => row.kind === "cycle" && row.campaignId === campaignId && row.verdict?.decision === "adopt",
  ).length;
}

function defaultCycleId(now) {
  const compact = now.replace(/[-:.TZ]/g, "").slice(0, 14);
  return `cyc-${compact}-${randomBytes(2).toString("hex")}`;
}

async function defaultEvaluateProbes({ adapter }) {
  if (!Array.isArray(adapter.probes) || adapter.probes.length === 0) {
    return { baseline: {}, candidate: {}, delta: 0, heldout: { baseline: {}, candidate: {} } };
  }
  throw new Error("probe_evaluator_missing: adapter declares probes but no evaluator is wired");
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
  const runGuards = deps.runGuards ?? defaultRunGuards;
  const evaluateProbes = deps.evaluateProbes ?? defaultEvaluateProbes;
  const now = deps.now ?? (() => new Date().toISOString());
  const minDelta = input.minDelta ?? 0.01;
  const costConfig = input.costConfig ?? { wallMsBytesIncreaseRatio: 0.15, gainMultipleOfFloor: 2 };
  const retention = input.retention ?? 10;
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
  const ledgerRel = path.relative(repoRoot, ledgerPath);
  const phase = (name, extra = {}) => {
    if (!dryRun) writeJson(path.join(cycleRunDir, "phase.json"), { phase: name, at: now(), ...extra });
  };

  try {
    if (!dryRun) fs.mkdirSync(cycleRunDir, { recursive: true, mode: 0o700 });
    phase("scoring");
    const accepted = campaignAcceptedCount(ledgerPath, campaignId);
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
      createdAt: now(),
    };
    const cycleReceipt = appendRow(ledgerPath, cycleRow);
    commitPaths(repoRoot, `chore(self-improve): cycle ${cycleId} ${decision.decision}`, [ledgerRel]);
    phase("cycle-committed", { decision: decision.decision, row: cycleReceipt.seq });

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
      }),
      runRoot: path.join(cycleRunDir, "real-eval"),
      logDir: path.join(cycleRunDir, "logs", "real"),
    });
    if (realGuards.some((guard) => guard.status !== "pass")) {
      revertWorkspace({ repoRoot, modified, added });
      const clean = gitOut(repoRoot, ["status", "--porcelain"]).length === 0;
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

    const codeCommit = commitPaths(repoRoot, proposal.commitMessage, touched);
    phase("applied", { codeCommit: codeCommit.slice(0, 7) });
    appendRow(ledgerPath, {
      kind: "adoption",
      cycleId,
      commit: codeCommit.slice(0, 7),
      install: "not_attempted",
      createdAt: now(),
    });
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
  }
}

/**
 * Roll back a cycle that crashed mid-apply: any run directory whose phase is
 * `applying` has its journaled paths restored before the run can continue.
 */
export function recoverPendingCycle({ runRoot = defaultRunRoot(), repoRoot }) {
  const runsRoot = path.join(runRoot, "runs");
  const results = [];
  if (!fs.existsSync(runsRoot)) return results;
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
    if (!phaseRecord || phaseRecord.phase !== "applying") continue;
    const journalPath = path.join(dir, "applied.json");
    if (repoRoot && fs.existsSync(journalPath)) {
      const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
      revertWorkspace({ repoRoot, modified: journal.modified ?? [], added: journal.added ?? [] });
      const clean = gitOut(repoRoot, ["status", "--porcelain"]).length === 0;
      writeJson(phasePath, { ...phaseRecord, phase: "rolled_back", clean, at: new Date().toISOString() });
      writeJson(path.join(dir, "failure.json"), {
        reason: "post_apply_failure",
        recovered: true,
        clean,
        at: new Date().toISOString(),
      });
      results.push({ cycleId: name, recovered: true, clean });
    } else {
      writeJson(path.join(dir, "failure.json"), {
        reason: "recovery_journal_missing",
        recovered: false,
        at: new Date().toISOString(),
      });
      results.push({ cycleId: name, recovered: false, clean: null });
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
