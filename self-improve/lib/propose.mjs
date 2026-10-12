/**
 * Bounded proposer seam for the automatic loop: proposer-request construction,
 * the `stub` scripted test double, the `cmd` template runner over a fresh
 * `git archive` scratch copy (held-out fixtures excluded), and the proposal
 * validation pipeline (schema, budget, protected-path, hypothesis novelty and
 * the verbatim held-out value scan).
 *
 * Env handling: the cmd proposer receives `sanitizeGuardEnv(process.env)`
 * filtered through an explicit passthrough allowlist. Request files, response
 * metadata and loop logs record only env KEY NAMES, never values.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBudget } from "./budget.mjs";
import { assertNoProtectedTouched, matchesEditable } from "./domain.mjs";
import { checkProposalHistory, countHunks, parsePatchNumstat } from "./engine.mjs";
import { assertIsolatedDestination, sanitizeGuardEnv } from "./isolate.mjs";
import { isPlainObject, sha256Hex, validateProposal } from "./types.mjs";

const SELF_IMPROVE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PROPOSER_MODES = Object.freeze(["stub", "cmd"]);
export const PROPOSER_REQUEST_SCHEMA = "gjc.self-improve.proposer-request.v1";
export const CMD_PROPOSER_TIMEOUT_MS = 300000;
export const MAX_FAILING_CASES = 24;
export const MAX_SUMMARY_CHARS = 240;
export const MAX_PRIOR_ATTEMPTS = 5;

/** Held-out fixtures must never reach the proposer's scratch copy. */
export const PROPOSER_SCRATCH_EXCLUSIONS = Object.freeze(["self-improve/domains"]);

/**
 * Explicit environment passthrough for the cmd proposer. Everything else is
 * dropped from the sanitized environment; values are never logged.
 */
export const PROPOSER_ENV_ALLOWLIST = Object.freeze([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "SHELL",
  "TERM",
  "USER",
  "LOGNAME",
  "CI",
  "NO_COLOR",
  "BUN_INSTALL",
]);

export function proposerEnv(env = process.env) {
  const sanitized = sanitizeGuardEnv(env);
  const out = {};
  for (const key of PROPOSER_ENV_ALLOWLIST) {
    if (sanitized[key] !== undefined) out[key] = sanitized[key];
  }
  return out;
}

export function heldoutFixturePath(repoRoot, adapter) {
  return path.join(repoRoot, "self-improve", "domains", adapter.id, "heldout", "fixtures.json");
}

export function probesFixturePath(repoRoot, adapter) {
  return path.join(repoRoot, "self-improve", "domains", adapter.id, "probes", "fixtures.json");
}

/**
 * Flatten the probe runner's per-case misses into proposer-facing entries
 * `{metric, label, summary}`. The runner's `failureDetails` supplies a short
 * documented-gap summary per case; `failures` (labels) is the fallback. The
 * probe corpus stays excluded from the propose-time scratch, so these entries
 * are the proposer's only view of what is failing — summaries are bounded and
 * never carry held-out material.
 */
export function failureLabelsFromProbeResult(probeResult) {
  const details = probeResult?.failureDetails?.baseline;
  const failures = probeResult?.failures?.baseline;
  const entries = [];
  if (isPlainObject(details)) {
    for (const metric of Object.keys(details).sort()) {
      for (const entry of details[metric] ?? []) {
        if (!isPlainObject(entry) || typeof entry.label !== "string" || entry.label.length === 0) continue;
        const summary = typeof entry.summary === "string" && entry.summary.length > 0 ? entry.summary.slice(0, MAX_SUMMARY_CHARS) : null;
        entries.push({ metric, label: entry.label, ...(summary ? { summary } : {}) });
      }
    }
  } else if (isPlainObject(failures)) {
    for (const metric of Object.keys(failures).sort()) {
      for (const label of failures[metric] ?? []) {
        if (typeof label === "string" && label.length > 0) entries.push({ metric, label });
      }
    }
  }
  return entries.slice(0, MAX_FAILING_CASES);
}

/**
 * Objective the failing cases belong to (`probe.<metric>`), most-failing metric
 * first, restricted to the adapter's declared objectives. Null when nothing is
 * failing or no failing metric has a declared objective.
 */
export function preferredObjectiveFromFailures({ failures = [], adapter }) {
  const counts = new Map();
  for (const entry of failures) {
    if (!entry || typeof entry.metric !== "string") continue;
    counts.set(entry.metric, (counts.get(entry.metric) ?? 0) + 1);
  }
  const order = new Map((adapter?.objectives ?? []).map((objective, index) => [objective, index]));
  const candidates = [...counts.entries()]
    .map(([metric, count]) => ({ metric, objective: `probe.${metric}`, count }))
    .filter((entry) => order.has(entry.objective))
    .sort((left, right) => right.count - left.count || order.get(left.objective) - order.get(right.objective));
  return candidates.length > 0 ? candidates[0].objective : null;
}

/**
 * Probe metric scan over the current repository state (baseline == candidate),
 * used to source the request's failing-case list. Failures are recorded, not
 * fatal: a scan error yields an empty list plus a reason.
 */
export function scanProbeFailures({ repoRoot, adapter, deps = {} }) {
  const runnerRel = adapter.probes?.[0]?.runner;
  if (typeof runnerRel !== "string" || runnerRel.length === 0) {
    return { ok: false, reason: "probe_runner_missing", failures: [] };
  }
  const spawn = deps.spawn ?? spawnSync;
  const runnerPath = path.resolve(SELF_IMPROVE_ROOT, runnerRel);
  const proc = spawn("bun", [runnerPath, "--baseline", repoRoot, "--candidate", repoRoot, "--json"], {
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (proc.status !== 0) return { ok: false, reason: "probe_scan_failed", failures: [] };
  try {
    return { ok: true, reason: null, failures: failureLabelsFromProbeResult(JSON.parse(proc.stdout)) };
  } catch {
    return { ok: false, reason: "probe_scan_invalid_json", failures: [] };
  }
}

export function buildProposerRequest({
  loopId,
  cycleIndex,
  objective,
  baseCommit,
  adapter,
  rung,
  failures = [],
  history = {},
}) {
  const priorAttempts = (history.priorAttempts ?? []).slice(-MAX_PRIOR_ATTEMPTS).map((entry) => ({
    objective: entry.objective,
    decision: entry.decision,
    reasons: entry.reasons ?? [],
    hypothesis: String(entry.hypothesis ?? "").slice(0, 280),
  }));
  return {
    schema: PROPOSER_REQUEST_SCHEMA,
    loopId,
    cycleIndex,
    objective,
    baseCommit,
    budget: { rung: rung.index, maxFiles: rung.maxFiles, maxHunks: rung.maxHunks },
    editableSurfaces: [...adapter.editable],
    failingCases: failures.slice(0, MAX_FAILING_CASES),
    priorAttempts,
    stalledObjectives: [...(history.stalled ?? [])],
    unexploredObjectives: [...(history.unexplored ?? [])],
    constraints: {
      editableOnly: true,
      noNetwork: true,
      noTimers: true,
      noSecrets: true,
      patchMustApplyAt: "HEAD",
      maxFiles: rung.maxFiles,
      maxHunks: rung.maxHunks,
    },
    responseContract: {
      hypothesis: "string: why this edit should move the objective (must be new)",
      objective: "string: defaults to the requested objective",
      commitMessage: "string: conventional commit message for the adoption",
      patch: "string: unified diff text, or patchPath: path inside the scratch copy holding it",
    },
  };
}

/**
 * Fresh `git archive` scratch copy for the proposer. Held-out fixtures
 * (`self-improve/domains/**`) are excluded by pathspec and swept afterwards as
 * a belt-and-braces guarantee; a surviving entry fails closed.
 */
export function createProposerScratch({ repoRoot, destDir, baseRef = "HEAD" }) {
  const resolvedDest = assertIsolatedDestination({ destDir });
  if (fs.existsSync(resolvedDest)) throw new Error(`scratch_destination_exists: ${resolvedDest}`);
  fs.mkdirSync(resolvedDest, { recursive: true, mode: 0o700 });
  const tarPath = path.join(resolvedDest, ".proposer-scratch.tar");
  const args = [
    "-C",
    repoRoot,
    "archive",
    "--format=tar",
    `--output=${tarPath}`,
    baseRef,
    "--",
    ".",
    ...PROPOSER_SCRATCH_EXCLUSIONS.map((rel) => `:(exclude)${rel}/**`),
  ];
  let archive = spawnSync("git", args, { encoding: "utf8" });
  if (archive.status !== 0) {
    archive = spawnSync("git", ["-C", repoRoot, "archive", "--format=tar", `--output=${tarPath}`, baseRef], {
      encoding: "utf8",
    });
  }
  if (archive.status !== 0) throw new Error(`git_archive_failed: ${archive.stderr || archive.status}`);
  const extract = spawnSync("tar", ["-xf", tarPath, "-C", resolvedDest], { encoding: "utf8" });
  fs.rmSync(tarPath, { force: true });
  if (extract.status !== 0) throw new Error(`tar_extract_failed: ${extract.stderr || extract.status}`);
  for (const rel of PROPOSER_SCRATCH_EXCLUSIONS) {
    fs.rmSync(path.join(resolvedDest, rel), { recursive: true, force: true });
  }
  const survivors = listScratchExclusionSurvivors(resolvedDest);
  if (survivors.length > 0) throw new Error(`scratch_exclusion_failed: ${survivors.join(", ")}`);
  const rev = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short=7", baseRef], { encoding: "utf8" });
  if (rev.status !== 0) throw new Error(`git_rev_parse_failed: ${rev.stderr || rev.status}`);
  return { scratchDir: resolvedDest, baseRef, baseCommit: rev.stdout.trim() };
}

/** Any path under the scratch that matches an excluded prefix (fail-closed check). */
export function listScratchExclusionSurvivors(scratchDir) {
  const survivors = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const next = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, name);
      const stat = fs.lstatSync(abs);
      if (stat.isDirectory()) walk(abs, next);
      else if (PROPOSER_SCRATCH_EXCLUSIONS.some((excluded) => next === excluded || next.startsWith(`${excluded}/`))) {
        survivors.push(next);
      }
    }
  };
  if (fs.existsSync(scratchDir)) walk(scratchDir, "");
  return survivors;
}

/** Deterministic first editable, non-text-fixture file present in the repo. */
export function pickEditableFile(repoRoot, adapter) {
  const skip = new Set([".git", "node_modules"]);
  const textFixtures = new Set(adapter.textFixtures ?? []);
  const found = [];
  const walk = (dir, rel) => {
    for (const name of fs.readdirSync(dir).sort()) {
      if (skip.has(name)) continue;
      const next = rel ? `${rel}/${name}` : name;
      const abs = path.join(dir, name);
      if (fs.lstatSync(abs).isDirectory()) walk(abs, next);
      else if (matchesEditable(next, adapter.editable) && !textFixtures.has(next)) found.push(next);
    }
  };
  walk(repoRoot, "");
  return found.sort()[0] ?? null;
}

/** Minimal append-only unified diff that applies cleanly to the given content. */
export function buildAppendPatch({ relPath, original, appendedLine, context = 3 }) {
  const body = original.endsWith("\n") ? original.slice(0, original.length - 1) : original;
  const lines = body === "" ? [] : body.split("\n");
  const kept = Math.min(context, lines.length);
  const start = lines.length - kept + 1;
  const header = [
    `diff --git a/${relPath} b/${relPath}`,
    `--- a/${relPath}`,
    `+++ b/${relPath}`,
    kept === 0 ? "@@ -0,0 +1,1 @@" : `@@ -${start},${kept} +${start},${kept + 1} @@`,
  ];
  const hunk = [...lines.slice(lines.length - kept).map((line) => ` ${line}`), `+${appendedLine}`, ""];
  return `${[...header, ...hunk].join("\n")}\n`;
}

/**
 * Scripted test double: appends one deterministic comment line to the first
 * editable file, so the proposal exercises the real engine path keylessly.
 */
export function runStubProposer({ request, repoRoot, adapter, outDir }) {
  const rel = pickEditableFile(repoRoot, adapter);
  if (!rel) return { ok: false, reason: "stub_no_editable_file" };
  const original = fs.readFileSync(path.join(repoRoot, rel), "utf8");
  const appendedLine = `// self-improve loop stub proposal cycle ${request.cycleIndex} (${request.objective})`;
  const patchText = buildAppendPatch({ relPath: rel, original, appendedLine });
  const patchFile = path.join(outDir, `cycle-${request.cycleIndex}.patch`);
  fs.mkdirSync(path.dirname(patchFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(patchFile, patchText);
  const plugin = rel.split("/")[0];
  return {
    ok: true,
    proposal: {
      source: "agent",
      hypothesis: `stub proposal for ${request.objective} cycle ${request.cycleIndex} at ${request.baseCommit}`,
      objective: request.objective,
      commitMessage: `chore(${plugin}): loop stub change ${request.cycleIndex}`,
      patchFile,
    },
    log: { mode: "stub", relPath: rel, patchFile, envKeys: [] },
  };
}

function renderTemplate(template, values) {
  return template
    .replaceAll("{request}", values.request)
    .replaceAll("{response}", values.response)
    .replaceAll("{scratch}", values.scratch);
}

/**
 * Template-driven proposer. The template runs via `sh -c` inside a fresh
 * scratch copy with the sanitized+allowlisted environment; it must read
 * `{request}` and write its proposal JSON to `{response}`.
 */
export function invokeCmdProposer({
  request,
  template,
  scratchDir,
  outDir,
  env = process.env,
  timeoutMs = CMD_PROPOSER_TIMEOUT_MS,
  deps = {},
}) {
  if (typeof template !== "string" || template.length === 0) return { ok: false, reason: "cmd_template_required" };
  if (!template.includes("{response}")) return { ok: false, reason: "cmd_template_missing_response_placeholder" };
  const spawn = deps.spawn ?? spawnSync;
  const requestFile = path.join(outDir, `cycle-${request.cycleIndex}.request.json`);
  const responseFile = path.join(outDir, `cycle-${request.cycleIndex}.response.json`);
  fs.mkdirSync(path.dirname(requestFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(requestFile, `${JSON.stringify(request, null, 2)}\n`);
  const rendered = renderTemplate(template, { request: requestFile, response: responseFile, scratch: scratchDir });
  const envKeys = Object.keys(proposerEnv(env)).sort();
  const started = Date.now();
  const proc = spawn("sh", ["-c", rendered], {
    cwd: scratchDir,
    env: proposerEnv(env),
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const log = {
    mode: "cmd",
    template,
    scratchDir,
    requestFile,
    responseFile,
    exitCode: proc.status ?? null,
    durationMs: Date.now() - started,
    envKeys,
  };
  if (proc.status !== 0 || proc.error) {
    return { ok: false, reason: "cmd_proposer_failed", log };
  }
  let response;
  try {
    response = JSON.parse(fs.readFileSync(responseFile, "utf8"));
  } catch {
    return { ok: false, reason: "cmd_proposer_no_response", log };
  }
  if (!isPlainObject(response)) return { ok: false, reason: "cmd_proposer_bad_response", log };
  const hypothesis = typeof response.hypothesis === "string" ? response.hypothesis.trim() : "";
  const commitMessage = typeof response.commitMessage === "string" ? response.commitMessage.trim() : "";
  const objective = typeof response.objective === "string" && response.objective.length > 0 ? response.objective : request.objective;
  if (hypothesis.length === 0) return { ok: false, reason: "cmd_proposer_missing_hypothesis", log };
  if (commitMessage.length === 0) return { ok: false, reason: "cmd_proposer_missing_commit_message", log };
  const patchDir = path.join(outDir, "patches");
  fs.mkdirSync(patchDir, { recursive: true, mode: 0o700 });
  const patchFile = path.join(patchDir, `cycle-${request.cycleIndex}.patch`);
  if (typeof response.patch === "string" && response.patch.length > 0) {
    if (Buffer.byteLength(response.patch, "utf8") > 256 * 1024) {
      return { ok: false, reason: "cmd_proposer_patch_too_large", log };
    }
    fs.writeFileSync(patchFile, response.patch.endsWith("\n") ? response.patch : `${response.patch}\n`);
  } else if (typeof response.patchPath === "string" && response.patchPath.length > 0) {
    const resolved = path.resolve(scratchDir, response.patchPath);
    if (!resolved.startsWith(`${path.resolve(scratchDir)}${path.sep}`)) {
      return { ok: false, reason: "cmd_proposer_patch_outside_scratch", log };
    }
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
      return { ok: false, reason: "cmd_proposer_patch_missing", log };
    }
    fs.copyFileSync(resolved, patchFile);
  } else {
    return { ok: false, reason: "cmd_proposer_missing_patch", log };
  }
  return {
    ok: true,
    proposal: { source: "agent", hypothesis, objective, commitMessage, patchFile },
    log,
  };
}

/** Recursively collect string literals from the held-out fixtures (never logged). */
export function collectHeldoutValues(fixtures, minLength = 6) {
  const values = new Set();
  const visit = (value) => {
    if (typeof value === "string") {
      if (value.length >= minLength) values.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (isPlainObject(value)) {
      for (const item of Object.values(value)) visit(item);
    }
  };
  visit(fixtures);
  return [...values];
}

/** Added content lines of a unified diff (never context or removed lines). */
export function addedPatchLines(patchText) {
  return patchText
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
}

/**
 * Verbatim held-out value scan over the patch's ADDED lines only: context lines
 * are copies of existing source and legitimately contain shared vocabulary.
 * Matches are reported as short hashes so loop logs stay opaque.
 */
export function scanHeldoutVerbatim({ patchText, values }) {
  const added = addedPatchLines(patchText).join("\n");
  const matched = [];
  for (const value of values) {
    if (added.includes(value)) matched.push(sha256Hex(value).slice(0, 12));
  }
  return { ok: matched.length === 0, matched };
}

function readFixtureValues(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return collectHeldoutValues(JSON.parse(fs.readFileSync(filePath, "utf8")));
  } catch {
    return [];
  }
}

function proposalShape({ raw, patchText }) {
  const numstat = parsePatchNumstat(patchText);
  const touched = numstat.map((row) => row.path);
  return {
    source: raw.source ?? "agent",
    hypothesis: raw.hypothesis,
    objective: raw.objective,
    commitMessage: raw.commitMessage,
    patchFile: raw.patchFile,
    patchSha256: sha256Hex(patchText),
    files: touched,
    hunks: countHunks(patchText),
  };
}

/**
 * Proposal validation pipeline: schema, budget pre-check, protected-path
 * pre-check, hypothesis-novelty pre-check, verbatim held-out value scan.
 * Returns `{ ok: true, proposal, touched }` or `{ ok: false, reason, ... }`.
 */
export function validateAgentProposal({
  proposal,
  patchText,
  rung,
  adapter,
  repoRoot,
  ledgerPath,
  stallK = 3,
  deps = {},
}) {
  let shaped;
  try {
    shaped = proposalShape({ raw: proposal, patchText });
    validateProposal(shaped);
  } catch (error) {
    return { ok: false, reason: "proposal_schema", detail: error.message };
  }
  if (shaped.files.length === 0) return { ok: false, reason: "empty_patch" };
  const budget = checkBudget({ files: shaped.files, hunks: shaped.hunks }, rung);
  if (!budget.ok) return { ok: false, reason: "budget_precheck", violations: budget.violations };
  const protectedCheck = assertNoProtectedTouched(shaped.files, adapter.protectedPaths);
  if (!protectedCheck.ok) return { ok: false, reason: "protected_precheck", offending: protectedCheck.offending };
  const history = checkProposalHistory({
    ledgerPath,
    proposal: { objective: shaped.objective, hypothesis: shaped.hypothesis },
    adapterObjectives: adapter.objectives ?? [],
    k: stallK,
  });
  if (!history.ok) {
    return {
      ok: false,
      reason: history.reason,
      ...(history.unexplored ? { unexplored: history.unexplored } : {}),
    };
  }
  const fixturePath = deps.heldoutFixturePath ?? heldoutFixturePath(repoRoot, adapter);
  const probePath = deps.probesFixturePath ?? probesFixturePath(repoRoot, adapter);
  // Vocabulary shared with the visible probe corpus (tier names, confidence
  // kinds, plugin-owned endpoints) is not treated as a held-out literal.
  const visible = new Set(readFixtureValues(probePath));
  const values = readFixtureValues(fixturePath).filter((value) => !visible.has(value));
  const scan = scanHeldoutVerbatim({ patchText, values });
  if (!scan.ok) return { ok: false, reason: "heldout_verbatim_scan", matched: scan.matched };
  return { ok: true, proposal: shaped, touched: shaped.files, hypothesisHash: history.hypothesisHash };
}
