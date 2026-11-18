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
import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { budgetResetDecision, checkBudget, rungFor } from "./budget.mjs";
import { buildCriticFindings, decideCycle, evaluateCostRule, evaluateHeldout } from "./gates.mjs";
import { matchesEditable } from "./domain.mjs";
import { buildGuardPlan, runGuards as defaultRunGuards } from "./guards.mjs";
import { createScratchCopy } from "./isolate.mjs";
import {
  COMPOSITION_SCHEMA,
  MAX_COMPOSITION_SOURCES,
  MIN_COMPOSITION_SOURCES,
  appendRow,
  boundedCompositionEvidence,
  candidateProposalId,
  ledgerRowBytes,
  readLedger,
  stripCompositionReasons,
  validateCompositionEvidence,
} from "./ledger.mjs";
import { LEDGER_SCHEMA, MAX_LEDGER_ROW_BYTES, isPlainObject, sha256Hex } from "./types.mjs";

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

/**
 * Bounded measured cost of the composition's candidate-probe phase, recorded on
 * the composed cycle row as `probeCost` next to the row's own `cost`. The two are
 * different phases and are never summed: `cost` covers this cycle's own run,
 * `probeCost` covers the shared baseline plus every candidate scratch. Returns
 * null when any part is unmeasured — an absent field, never a zero stand-in.
 */
function boundedProbeCost(cost) {
  if (!isPlainObject(cost)) return null;
  const candidates = Number.isInteger(cost.candidates) && cost.candidates >= 0 ? cost.candidates : null;
  const wallMs =
    typeof cost.wallMs === "number" && Number.isFinite(cost.wallMs) && cost.wallMs >= 0 ? Math.round(cost.wallMs) : null;
  const bytes =
    typeof cost.bytes === "number" && Number.isFinite(cost.bytes) && cost.bytes >= 0 ? Math.round(cost.bytes) : null;
  if (candidates === null || wallMs === null || bytes === null) return null;
  return { candidates, wallMs, bytes };
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

/**
 * Content fingerprint of a scratch tree: one row per entry carrying its type, its
 * mode and a content digest (file bytes, or the symlink target). Path/size/mtime
 * is not identity: a same-size rewrite with a restored mtime would escape, and an
 * identical rewrite with a new mtime would falsely block. Entries that disappear
 * or cannot be read become distinct rows so the comparison still observes a
 * difference instead of throwing mid-probe.
 */
export function treeFingerprint(dir) {
  if (!fs.existsSync(dir)) return null;
  const rows = [];
  const walk = (abs, rel) => {
    for (const name of fs.readdirSync(abs).sort()) {
      const next = rel ? `${rel}/${name}` : name;
      const target = path.join(abs, name);
      let stat;
      try {
        stat = fs.lstatSync(target);
      } catch {
        rows.push(`${next}\u0000missing`);
        continue;
      }
      const mode = (stat.mode & 0o777).toString(8);
      if (stat.isSymbolicLink()) {
        let link;
        try {
          link = fs.readlinkSync(target);
        } catch {
          rows.push(`${next}\u0000symlink\u0000${mode}\u0000unreadable`);
          continue;
        }
        rows.push(`${next}\u0000symlink\u0000${mode}\u0000${sha256Hex(link)}`);
        continue;
      }
      if (stat.isDirectory()) {
        rows.push(`${next}\u0000dir\u0000${mode}`);
        walk(target, next);
        continue;
      }
      if (!stat.isFile()) {
        rows.push(`${next}\u0000other\u0000${mode}`);
        continue;
      }
      let digest;
      try {
        digest = createHash("sha256").update(fs.readFileSync(target)).digest("hex");
      } catch {
        rows.push(`${next}\u0000unreadable\u0000${mode}`);
        continue;
      }
      rows.push(`${next}\u0000file\u0000${mode}\u0000${digest}`);
    }
  };
  walk(dir, "");
  return sha256Hex(rows.join("\n"));
}

/** Patch text of a candidate or proposal: inline bytes first, then its patch file. */
export function candidatePatchText(source) {
  if (typeof source?.patchText === "string" && source.patchText.length > 0) return source.patchText;
  return readPatchFileText(source?.patchFile);
}

function readPatchFileText(patchFile) {
  if (typeof patchFile !== "string" || patchFile.length === 0) return null;
  const resolved = path.resolve(patchFile);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return fs.readFileSync(resolved, "utf8");
}

export const MAX_CANDIDATE_PATCH_BYTES = 256 * 1024;

/**
 * Merge independently identified candidate patches into one composed patch:
 * sources are ordered by their content id and their bytes are concatenated, so
 * the same candidate set always produces the same composed patch. Two
 * candidates that edit the same file are a composition conflict — the edit
 * regions cannot be proven disjoint without applying them, and a partially
 * applied composition is not evidence. Budget, protected paths and the
 * held-out scan stay in the ordinary proposal pipeline, which the composed
 * patch goes through unchanged.
 */
export function mergeCandidatePatches({ candidates = [] } = {}) {
  if (!Array.isArray(candidates)) return { ok: false, reason: "composition_requires_two_candidates", count: 0 };
  if (candidates.length < MIN_COMPOSITION_SOURCES) {
    return { ok: false, reason: "composition_requires_two_candidates", count: candidates.length };
  }
  if (candidates.length > MAX_COMPOSITION_SOURCES) {
    return { ok: false, reason: "composition_too_many_candidates", count: candidates.length };
  }
  const sources = [];
  const seenIds = new Set();
  const seenShas = new Set();
  for (const candidate of candidates) {
    const patchText = candidatePatchText(candidate);
    if (patchText === null) return { ok: false, reason: "composition_candidate_patch_missing", id: candidate?.id ?? null };
    if (Buffer.byteLength(patchText, "utf8") > MAX_CANDIDATE_PATCH_BYTES) {
      return { ok: false, reason: "composition_candidate_patch_too_large", id: candidate?.id ?? null };
    }
    const objective = candidate?.objective;
    if (typeof objective !== "string" || objective.length === 0) {
      return { ok: false, reason: "composition_candidate_objective_missing", id: candidate?.id ?? null };
    }
    const patchSha256 = sha256Hex(patchText);
    const id = candidateProposalId({ objective, patchSha256 });
    if (typeof candidate.id === "string" && candidate.id.length > 0 && candidate.id !== id) {
      return { ok: false, reason: "composition_candidate_id_mismatch", providedId: candidate.id, expectedId: id };
    }
    if (seenIds.has(id) || seenShas.has(patchSha256)) {
      return { ok: false, reason: "composition_duplicate_candidate", id };
    }
    let shape;
    try {
      shape = { files: parsePatchNumstat(patchText).map((row) => row.path), hunks: countHunks(patchText) };
    } catch (error) {
      return { ok: false, reason: "composition_candidate_patch_invalid", id, detail: error.message };
    }
    if (shape.files.length === 0) return { ok: false, reason: "composition_candidate_empty_patch", id };
    seenIds.add(id);
    seenShas.add(patchSha256);
    sources.push({ id, objective, patchSha256, files: shape.files, hunks: shape.hunks, patchText });
  }
  const owner = new Map();
  const conflicts = new Map();
  for (const source of sources) {
    for (const file of source.files) {
      const held = owner.get(file);
      if (held !== undefined && held !== source.id) {
        if (!conflicts.has(file)) conflicts.set(file, new Set([held, source.id]));
        else conflicts.get(file).add(source.id);
      } else {
        owner.set(file, source.id);
      }
    }
  }
  if (conflicts.size > 0) {
    return {
      ok: false,
      reason: "composition_conflict",
      conflicts: [...conflicts.entries()]
        .map(([file, ids]) => ({ path: file, sources: [...ids].sort() }))
        .sort((left, right) => (left.path < right.path ? -1 : 1)),
    };
  }
  sources.sort((left, right) => (left.id < right.id ? -1 : 1));
  // Union in the same deterministic source-id order the patch bytes use, so the
  // composed patch, this file list and the recorded sources agree.
  const files = [...new Set(sources.flatMap((source) => source.files))];
  const hunks = sources.reduce((sum, source) => sum + source.hunks, 0);
  return {
    ok: true,
    patchText: sources.map((source) => source.patchText).join(""),
    files,
    hunks,
    sources: sources.map(({ id, objective, patchSha256, files: touched, hunks: count }) => ({
      id,
      objective,
      patchSha256,
      files: touched,
      hunks: count,
    })),
  };
}

export function applyPatch(dir, patchText) {
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
    // Stall redirects exploration only while an unexplored probe exists to
    // redirect to. Per the frozen campaign contract (§4.2 "continues to n=20
    // unless a cap breaches"; §16 R1 "per-gap retries bounded by the
    // proposer-call cap"), a fully stalled objective set stays admissible once
    // nothing is left unexplored; the retry is flagged for audit.
    if (unexplored.length > 0) {
      return { ok: false, reason: "forced_exploration", stalled: proposal.objective, unexplored };
    }
    return { ok: true, reason: null, hypothesisHash, forcedExploration: true, stallRetry: true };
  }
  return { ok: true, reason: null, hypothesisHash, forcedExploration: state.stalled.length > 0 };
}

function defaultCycleId(now) {
  const compact = now.replace(/[-:.TZ]/g, "").slice(0, 14);
  return `cyc-${compact}-${randomBytes(2).toString("hex")}`;
}

export async function defaultEvaluateProbes({ adapter, baselineDir, candidateDir }) {
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
    journalEvidence = null,
    composition = null,
    probeCost = null,
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

  // A composition is evidence about this exact patch or it is not recorded: the
  // record's source ids are re-derived, the digest must belong to the bytes
  // above, and the bounded form must still fit one ledger row.
  let compositionEvidence = null;
  if (composition !== null && composition !== undefined) {
    const compositionCheck = validateCompositionEvidence({ composition, patchText });
    if (!compositionCheck.ok) {
      return {
        status: "rejected",
        decision: "reject",
        reasons: [compositionCheck.reason],
        detail: compositionCheck.detail,
        recorded: false,
      };
    }
    const bounded = boundedCompositionEvidence(composition);
    if (!bounded.ok) {
      return { status: "rejected", decision: "reject", reasons: [bounded.reason], bytes: bounded.bytes, recorded: false };
    }
    compositionEvidence = bounded.evidence;
  }
  const compositionProbeCost = compositionEvidence ? boundedProbeCost(probeCost) : null;

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
        ...(compositionEvidence ? { composition: compositionEvidence } : {}),
        ...(compositionProbeCost ? { probeCost: compositionProbeCost } : {}),
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
      ...(compositionEvidence ? { composition: compositionEvidence } : {}),
      ...(compositionProbeCost ? { probeCost: compositionProbeCost } : {}),
      ...(journalEvidence ? { journalEvidence } : {}),
      ...(touched.some((rel) => (adapter.textFixtures ?? []).includes(rel)) ? { labels: ["text_fixture"] } : {}),
      ...(history.forcedExploration ? { forcedExploration: true } : {}),
      createdAt: now(),
    };
    if (compositionEvidence) {
      // The record has to fit one append-only row. Identity survives the first
      // trim; a record that still does not fit fails closed instead of throwing
      // after the cycle already spent its guards and probes.
      let projected = { schema: LEDGER_SCHEMA, ...cycleRow };
      if (ledgerRowBytes(projected) > MAX_LEDGER_ROW_BYTES) {
        compositionEvidence = stripCompositionReasons(compositionEvidence);
        cycleRow.composition = compositionEvidence;
        projected = { schema: LEDGER_SCHEMA, ...cycleRow };
      }
      if (ledgerRowBytes(projected) > MAX_LEDGER_ROW_BYTES) {
        return {
          status: "rejected",
          decision: "reject",
          reasons: ["composition_evidence_too_large"],
          bytes: ledgerRowBytes(projected),
          recorded: false,
        };
      }
    }
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
      ...(compositionProbeCost ? { probeCost: compositionProbeCost } : {}),
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

const composeRefusal = (reason, extra = {}) => ({
  status: "rejected",
  decision: "reject",
  reasons: [reason],
  recorded: false,
  ...extra,
});

/**
 * Harness² M2 composition, offline: every candidate is probed on its own
 * against ONE shared baseline scratch (created once, never patched, fingerprinted
 * before and after the probes), and the composed patch is then handed to the
 * ordinary `runCycle`, which re-creates the baseline at the same commit, applies
 * every existing gate to the composed variant and owns the adoption path. The
 * composed run is deliberately a separate execution: a composition is a new
 * candidate, not a sum of the candidate measurements above.
 *
 * The caller supplies `composed` from the proposal pipeline
 * (`self-improve/lib/propose.mjs` → `composeCandidateProposals`), so the composed
 * patch has already been through schema, budget, protected-path, novelty and
 * held-out-verbatim admission. This function re-derives the provenance binding
 * (ids, source patches, exact concatenation), refuses to record a composition
 * built on an inadmissible candidate, and never treats an individual win as
 * composition evidence.
 *
 * Nothing here calls a model or the network: guards and probes are the injected
 * `deps` (defaults run the repository's own offline checkers).
 *
 * Cost accounting is split, never summed: the composed cycle row's `cost` stays
 * this cycle's own measurement, and `probeCost` (result, row and
 * `composition.json`) is the measured phase cost of the shared baseline plus
 * every candidate scratch/guard/probe. The cost rule is unchanged and still
 * compares only the measured baseline/candidate costs of the run it gates.
 */
export async function runComposeCycle(input = {}) {
  const {
    repoRoot,
    adapter,
    candidates: rawCandidates = [],
    composed = null,
    runRoot = defaultRunRoot(),
    ledgerPath = path.join(repoRoot ?? ".", "self-improve", "ledger.jsonl"),
    dryRun = false,
    includeSmoke = true,
    campaignId = "default",
    install = false,
    minDelta,
    costConfig,
    retention,
    stallK,
    resetBudget,
    deps = {},
  } = input;
  if (!repoRoot || !adapter) throw new Error("run_compose_cycle_requires repoRoot and adapter");
  if (!Array.isArray(rawCandidates) || rawCandidates.length < MIN_COMPOSITION_SOURCES) {
    return composeRefusal("composition_requires_two_candidates", { count: rawCandidates?.length ?? 0 });
  }
  if (!isPlainObject(composed) || !isPlainObject(composed.proposal) || !isPlainObject(composed.composition)) {
    return composeRefusal("composition_proposal_missing");
  }
  const ledgerRel = path.relative(repoRoot, ledgerPath);
  if (ledgerRel.startsWith("..") || path.isAbsolute(ledgerRel)) {
    throw new Error("ledger_must_live_inside_repository");
  }

  const runGuards = deps.runGuards ?? defaultRunGuards;
  const evaluateProbes = deps.evaluateProbes ?? defaultEvaluateProbes;
  const now = deps.now ?? (() => new Date().toISOString());
  const config = loadConfig();
  const effectiveMinDelta = minDelta ?? config.minDelta ?? 0.01;
  const effectiveCostConfig = costConfig ?? {
    wallMsBytesIncreaseRatio: config.cost?.wallMsBytesIncreaseRatio ?? 0.15,
    gainMultipleOfFloor: config.cost?.gainMultipleOfFloor ?? 2,
  };
  const effectiveRetention = retention ?? config.retention?.rawCycles ?? 10;
  const effectiveStallK = stallK ?? config.stall?.k ?? 3;

  // Candidate identity is derived here, never trusted from the record.
  const prepared = [];
  for (const [index, candidate] of rawCandidates.entries()) {
    const patchText = candidatePatchText(candidate);
    if (patchText === null) {
      return composeRefusal("composition_candidate_patch_missing", { candidateIndex: index, id: candidate?.id ?? null });
    }
    if (Buffer.byteLength(patchText, "utf8") > MAX_CANDIDATE_PATCH_BYTES) {
      return composeRefusal("composition_candidate_patch_too_large", { candidateIndex: index });
    }
    const objective = typeof candidate?.objective === "string" && candidate.objective.length > 0
      ? candidate.objective
      : null;
    if (objective === null) return composeRefusal("composition_candidate_objective_missing", { candidateIndex: index });
    const patchSha256 = sha256Hex(patchText);
    const id = candidateProposalId({ objective, patchSha256 });
    if (typeof candidate?.id === "string" && candidate.id.length > 0 && candidate.id !== id) {
      return composeRefusal("composition_candidate_id_mismatch", {
        candidateIndex: index,
        providedId: candidate.id,
        expectedId: id,
      });
    }
    let shape;
    try {
      shape = { files: parsePatchNumstat(patchText).map((row) => row.path), hunks: countHunks(patchText) };
    } catch (error) {
      return composeRefusal("composition_candidate_patch_invalid", { candidateIndex: index, id, detail: error.message });
    }
    if (shape.files.length === 0) return composeRefusal("composition_candidate_empty_patch", { candidateIndex: index, id });
    prepared.push({ index, id, objective, patchText, patchSha256, files: shape.files, hunks: shape.hunks });
  }
  const byId = new Map();
  for (const entry of prepared) {
    if (byId.has(entry.id)) return composeRefusal("composition_duplicate_candidate", { id: entry.id });
    byId.set(entry.id, entry);
  }

  const proposal = composed.proposal;
  const patchText = readPatchFileText(proposal.patchFile);
  if (patchText === null) return composeRefusal("composition_patch_missing");
  const evidenceCheck = validateCompositionEvidence({ composition: composed.composition, patchText, requireBaseline: false });
  if (!evidenceCheck.ok) {
    return composeRefusal(evidenceCheck.reason, { detail: evidenceCheck.detail });
  }

  // Provenance binding: the record must name exactly the supplied candidates,
  // each patch sha must match the supplied bytes, and the composed patch must be
  // the ordered concatenation of those sources. Nothing is probed before this
  // holds, so no result can be reported without a source identity.
  const sources = composed.composition.sources;
  for (const source of sources) {
    const match = byId.get(source.id);
    if (!match) return composeRefusal("composition_provenance_mismatch", { detail: `source_not_supplied:${source.id}` });
    if (match.patchSha256 !== source.patchSha256) {
      return composeRefusal("composition_provenance_mismatch", { detail: `source_patch_mismatch:${source.id}` });
    }
  }
  if (prepared.length !== sources.length) {
    return composeRefusal("composition_source_unrecorded", {
      detail: `${prepared.length} supplied, ${sources.length} recorded`,
    });
  }
  const expectedPatch = sources.map((source) => byId.get(source.id).patchText).join("");
  if (expectedPatch !== patchText) {
    return composeRefusal("composition_provenance_mismatch", { detail: "composed_patch_not_source_concatenation" });
  }

  const repoState = assertRepoState({ repoRoot, baseCommit: proposal.baseCommit });
  if (!repoState.ok) {
    return { status: "aborted", reason: repoState.reason, head: repoState.headShort, dirty: repoState.dirty };
  }

  const cycleId = proposal.cycleId ?? defaultCycleId(now());
  const resetDecision = budgetResetDecision({ resetFlag: resetBudget === true });
  const accepted = resetDecision.reset ? 0 : campaignAcceptedCount(ledgerPath, campaignId);
  const rung = rungFor(accepted, adapter.budget);
  const composeDir = dryRun
    ? fs.mkdtempSync(path.join(os.tmpdir(), "self-improve-compose-"))
    : path.join(runRoot, "runs", cycleId);
  const evalRoot = path.join(composeDir, "compose");
  const guardHomeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "self-improve-guard-home-"));
  const candidateResults = [];
  let baselineFingerprint = null;
  let probedBytes = 0;
  let probeCost = null;
  const phase = (name, extra = {}) => {
    if (!dryRun) writeJson(path.join(composeDir, "phase.json"), { phase: name, at: now(), ...extra });
  };
  const writeEvidence = (outcome) => {
    if (dryRun) return;
    writeJson(path.join(composeDir, "composition.json"), {
      schema: COMPOSITION_SCHEMA,
      composeId: cycleId,
      baseCommit: repoState.headShort,
      budgetRung: rung.index,
      baselineFingerprint,
      probeCost,
      sources: prepared.map(({ index, id, objective, patchSha256, files, hunks }) => ({
        index,
        id,
        objective,
        patchSha256,
        files,
        hunks,
      })),
      results: candidateResults,
      composed: outcome ?? null,
      at: now(),
    });
  };

  try {
    fs.mkdirSync(composeDir, { recursive: true, mode: 0o700 });
    if (!dryRun) {
      try {
        fs.copyFileSync(path.resolve(proposal.patchFile), path.join(composeDir, "composed.patch"));
        writeJson(path.join(composeDir, "proposal.json"), proposal);
        writeJson(path.join(composeDir, "composition-input.json"), composed.composition);
        const patchesDir = path.join(composeDir, "candidate-patches");
        fs.mkdirSync(patchesDir, { recursive: true, mode: 0o700 });
        for (const source of sources) {
          fs.writeFileSync(path.join(patchesDir, `${source.id}.patch`), byId.get(source.id).patchText);
        }
      } catch {
        /* raw evidence copies are best effort */
      }
    }

    phase("compose-scoring");
    // Phase cost starts here: the shared baseline scratch, its guards and every
    // candidate scratch/guard/probe below. It is recorded as `probeCost` on the
    // composed row, separately from that row's own `cost`.
    const probeStartedAt = Date.now();
    // One baseline, shared by every candidate probe. It is never patched. Its
    // content fingerprint is taken after the baseline guards (which legitimately
    // write build outputs into their own scratch) and compared after each probe,
    // so a probe that dirties the shared baseline is reported instead of shifting
    // the reference for the next candidate.
    const baseline = createScratchCopy({ repoRoot, destDir: path.join(evalRoot, "baseline") });
    const baselineStarted = Date.now();
    const baselineGuards = await runGuards({
      guards: buildGuardPlan({
        repoRoot,
        scratchDir: baseline.scratchDir,
        runRoot: path.join(evalRoot, "baseline-eval"),
        includeSmoke,
        homeRoot: guardHomeRoot,
      }),
      runRoot: path.join(evalRoot, "baseline-eval"),
      logDir: path.join(composeDir, "logs", "compose-baseline"),
    });
    const baselineWallMs = Date.now() - baselineStarted;
    const baselineBytes = treeBytes(baseline.scratchDir);
    const baselineVerified = treeFingerprint(baseline.scratchDir);
    baselineFingerprint = baselineVerified;
    if (baselineGuards.some((guard) => guard.status !== "pass")) {
      const outcome = composeRefusal("baseline_guard_fail", {
        cycleId,
        guards: baselineGuards.map(({ id, status }) => ({ id, status })),
        baselineFingerprint,
      });
      phase("done", { outcome: "baseline_guard_fail" });
      writeJson(path.join(composeDir, "failure.json"), { reason: "baseline_guard_fail", at: now() });
      writeEvidence({ status: outcome.status, reasons: outcome.reasons });
      return outcome;
    }

    for (const source of sources) {
      const candidate = byId.get(source.id);
      const scratch = createScratchCopy({ repoRoot, destDir: path.join(evalRoot, "candidates", source.id) });
      try {
        applyPatch(scratch.scratchDir, candidate.patchText);
      } catch (error) {
        const outcome = composeRefusal("composition_candidate_patch_failed", {
          cycleId,
          id: source.id,
          detail: error.message,
        });
        phase("done", { outcome: "composition_candidate_patch_failed" });
        writeEvidence({ status: outcome.status, reasons: outcome.reasons });
        return outcome;
      }
      const candidateStarted = Date.now();
      const guards = await runGuards({
        guards: buildGuardPlan({
          repoRoot,
          scratchDir: scratch.scratchDir,
          runRoot: path.join(evalRoot, "candidate-eval", source.id),
          includeSmoke,
          homeRoot: guardHomeRoot,
        }),
        runRoot: path.join(evalRoot, "candidate-eval", source.id),
        logDir: path.join(composeDir, "logs", "compose", source.id),
      });
      const wallMs = Date.now() - candidateStarted;
      const probes = await evaluateProbes({
        adapter,
        baselineDir: baseline.scratchDir,
        candidateDir: scratch.scratchDir,
        runRoot: evalRoot,
      });
      const baselineObserved = treeFingerprint(baseline.scratchDir);
      if (baselineObserved !== baselineVerified) {
        const outcome = composeRefusal("baseline_mutated", {
          cycleId,
          id: source.id,
          baselineFingerprint: baselineVerified,
          observedFingerprint: baselineObserved,
        });
        phase("done", { outcome: "baseline_mutated" });
        writeJson(path.join(composeDir, "failure.json"), { reason: "baseline_mutated", id: source.id, at: now() });
        writeEvidence({ status: outcome.status, reasons: outcome.reasons, id: source.id });
        return outcome;
      }
      const floor = Math.max(effectiveMinDelta, probes.floor ?? 0);
      const scores = {
        baseline: probes.baseline ?? {},
        candidate: probes.candidate ?? {},
        delta: probes.delta ?? 0,
        floor,
      };
      const candidateBytes = treeBytes(scratch.scratchDir);
      probedBytes += candidateBytes;
      const costRule = evaluateCostRule({
        baselineCost: { wallMs: baselineWallMs, bytes: baselineBytes },
        candidateCost: { wallMs, bytes: candidateBytes },
        delta: scores.delta,
        floor,
        config: effectiveCostConfig,
      });
      const heldout = evaluateHeldout({
        heldoutBaseline: probes.heldout?.baseline ?? {},
        heldoutCandidate: probes.heldout?.candidate ?? {},
      });
      const critic = buildCriticFindings({
        patchText: candidate.patchText,
        touched: candidate.files,
        surface: candidate.files,
        adapter,
        rung,
        hunks: candidate.hunks,
      });
      const budget = checkBudget({ files: candidate.files, hunks: candidate.hunks }, rung);
      const decision = decideCycle({ critic, guards, scores, costRule, heldout, budget });
      // The improvement floor is the composed result's own gate. A candidate is
      // admissible as a source when every other gate holds.
      const hardReasons = decision.reasons.filter((reason) => reason !== "floor_not_met");
      candidateResults.push({
        id: source.id,
        objective: candidate.objective,
        patchSha256: candidate.patchSha256,
        files: candidate.files,
        hunks: candidate.hunks,
        verdict: decision.decision,
        reasons: decision.reasons,
        hardReasons,
        admissible: hardReasons.length === 0,
        improved: scores.delta >= floor,
        scores: { delta: scores.delta, floor: scores.floor },
        heldout: summarizeHeldout(heldout, probes.heldout ?? {}),
        costRule: { ok: costRule.ok, wallIncrease: costRule.wallIncrease, byteIncrease: costRule.byteIncrease },
        guards: guards.map(({ id, status }) => ({ id, status })),
      });
    }

    probeCost = {
      candidates: candidateResults.length,
      wallMs: Date.now() - probeStartedAt,
      bytes: probedBytes,
    };

    const inadmissible = candidateResults.filter((result) => !result.admissible);
    if (inadmissible.length > 0) {
      // Abstention: a composition is not attempted on top of a candidate that
      // already failed a gate, even when the other candidates improved.
      const excluded = inadmissible.map((result) => ({ id: result.id, reasons: result.hardReasons }));
      const outcome = {
        status: "abstained",
        abstained: true,
        decision: "reject",
        cycleId,
        reasons: ["composition_abstained_inadmissible_candidate"],
        excluded,
        candidates: candidateResults,
        baselineFingerprint: baselineVerified,
        recorded: false,
      };
      phase("done", { outcome: "abstained" });
      writeJson(path.join(composeDir, "failure.json"), {
        reason: "composition_abstained_inadmissible_candidate",
        excluded,
        at: now(),
      });
      writeEvidence({ status: outcome.status, reasons: outcome.reasons, excluded });
      return outcome;
    }

    // The composed variant is a new candidate: every existing gate applies again
    // inside runCycle, and only its verdict can adopt. Individual wins above are
    // recorded evidence, never adoption.
    const composition = {
      ...composed.composition,
      baselineFingerprint: baselineVerified,
      sources: composed.composition.sources.map((source) => {
        const result = candidateResults.find((entry) => entry.id === source.id);
        return { ...source, verdict: result.verdict, reasons: result.reasons };
      }),
    };
    phase("compose-validated", { composedSha256: composition.composedSha256 });
    writeEvidence({
      status: "composed-pending",
      composition: {
        composedSha256: composition.composedSha256,
        sources: composition.sources.map(({ id, verdict, reasons }) => ({ id, verdict, reasons })),
      },
    });

    const composedResult = await runCycle({
      repoRoot,
      adapter,
      proposal: {
        ...proposal,
        cycleId,
        campaignId,
        surface: proposal.files ?? [],
        baseCommit: repoState.head,
      },
      composition,
      probeCost,
      runRoot,
      ledgerPath,
      dryRun,
      includeSmoke,
      install,
      minDelta: effectiveMinDelta,
      costConfig: effectiveCostConfig,
      retention: effectiveRetention,
      stallK: effectiveStallK,
      resetBudget: resetBudget === true,
      deps: { runGuards, evaluateProbes, now, runInstall: deps.runInstall },
    });

    const bounded = boundedCompositionEvidence(composition);
    const result = {
      status: composedResult.status,
      composeId: cycleId,
      cycleId: composedResult.cycleId ?? cycleId,
      decision: composedResult.decision ?? "reject",
      reasons: composedResult.reasons ?? [],
      adoption: composedResult.adoption ?? "none",
      abstained: false,
      candidates: candidateResults,
      composition: bounded.ok ? bounded.evidence : null,
      probeCost,
      baselineFingerprint: baselineVerified,
      composed: composedResult,
      recorded: composedResult.status === "ok",
    };
    writeEvidence({
      status: result.status,
      decision: result.decision,
      reasons: result.reasons,
      adoption: result.adoption,
      cycleId: result.cycleId,
      composition: result.composition,
      probeCost: result.probeCost,
    });
    if (!dryRun && !fs.existsSync(path.join(composeDir, "phase.json"))) {
      phase("done", { outcome: result.status });
    }
    return result;
  } finally {
    try {
      fs.rmSync(guardHomeRoot, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    if (dryRun) {
      try {
        fs.rmSync(composeDir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
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
