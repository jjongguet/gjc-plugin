#!/usr/bin/env node
import { closeSync, fsyncSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { buildLoadingReceipt, collectPluginState } from "../lib/loading-receipt.mjs";
import { computeHarnessDigest } from "../lib/isolate.mjs";
import { SEATBELT_BIN, startLoopbackListener } from "../lib/isolation-runtime.mjs";
import { projectQualityTrialCohort } from "../lib/quality-trial.mjs";
import { createReservationLedger, startRecordingProxy } from "./recording-proxy.mjs";
import { prepareCell, proveCellIsolation, runNativeAttempt, taskPrompt } from "./native-pilot.mjs";
import { digest, publicDecision } from "./pilot-oracle.mjs";
import { cellReceipt, checkLiveEvidence, LIMITS, loadJson, pilotInputs, ROOT, sourceDigest } from "./pilot-protocol.mjs";

const save = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
function durableAppend(file, value) {
  const fd = openSync(file, "a", 0o600);
  try { writeSync(fd, JSON.stringify(value) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
function gitHead() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8", timeout: 5000 });
  const head = result.stdout?.trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/.test(head ?? "")) throw new Error("source_head_unavailable");
  return head;
}

/** Default is real native execution against a local scripted endpoint, never a paid request. */
export async function runPilot({ outputDir, mode = "dry", budget = null, pricing = null, nativeProof = null, sharedDelivery = null, apiKey = null, approveLive = null, gjcBin = path.join(os.homedir(), ".local/bin/gjc") }) {
  if (!["dry", "live"].includes(mode) || typeof outputDir !== "string") throw new Error("invalid_pilot_arguments");
  if (mode === "dry" && (apiKey || approveLive !== null)) throw new Error("dry_credentials_or_approval_forbidden");
  const inputs = pilotInputs();
  const source = sourceDigest();
  const sourceHead = gitHead();
  let admission = null;
  if (mode === "live") {
    if (approveLive !== 1 || typeof apiKey !== "string" || !apiKey.trim()) throw new Error("live_not_authorized");
    admission = checkLiveEvidence({ budget, pricing, nativeProof, sharedDelivery, currentSourceDigest: source });
  }
  mkdirSync(outputDir, { mode: 0o700 });
  const started = Date.now();
  const eventsFile = path.join(outputDir, "events.jsonl");
  const frozen = {
    schema: "harness2.m1.frozen_pilot.v1", sourceHead, sourceDigest: source, mode,
    efficacy: "NOT ASSESSED", subset: inputs.subset, taskDigest: digest(inputs.task), oracleDigest: digest(inputs.oracle), ruleDigest: digest(inputs.ruleText),
    limits: LIMITS, cells: inputs.cells, requests: inputs.requests, publicSelector: "lowest-index-schema-valid-else-failed", feedback: "B2 only: immediate prior public output and schema errors; no hidden outcome", stop: "any transport, isolation, loading, token, spend or wall violation; no retry", admission,
    createdAt: new Date().toISOString(),
  };
  const harnessDigest = digest(frozen);
  save(path.join(outputDir, "frozen.json"), frozen);
  // This fsynced event precedes any upstream reservation or dispatch.
  durableAppend(eventsFile, { kind: "frozen", digest: harnessDigest, sourceDigest: source });
  const ledger = mode === "live" ? createReservationLedger({ capUsd: 1, taskCapUsd: 5, maxCalls: 21, priorSpentUsd: budget.priorSpentUsd, priorReservedUsd: budget.priorReservedUsd, priorUnresolvedUsd: budget.priorUnresolvedUsd, cleanupUsd: budget.cleanupUsd, inputPrice: pricing.inputPrice, outputPrice: pricing.outputPrice, onEvent: (event) => durableAppend(eventsFile, event) }) : null;
  const attempts = inputs.requests.map((request) => ({ ...request, status: "skipped", reason: "not_started" }));
  const receipts = [];
  let stopped = null;
  for (const plannedCell of inputs.cells) {
    const cellAttempts = attempts.filter((attempt) => attempt.cellId === `${plannedCell.taskId}/${plannedCell.arm}/r${plannedCell.repeat}`);
    const cellStarted = Date.now();
    let loading = null;
    let isolation = null;
    let root = null;
    let proxy = null;
    let other = null;
    let cellError = null;
    try {
      if (stopped) continue;
      if (Date.now() - started >= LIMITS.pilotWallMs) throw new Error("pilot_wall_exceeded");
      if (sourceDigest() !== source) throw new Error("source_changed_after_freeze");
      root = mkdtempSync(path.join(os.tmpdir(), "harness2-pilot-"));
      proxy = await startRecordingProxy({ mode, ruleText: inputs.ruleText, apiKey, ledger, onReceipt: (row) => durableAppend(eventsFile, { kind: "request", ...row }) });
      other = startLoopbackListener();
      if (!other) throw new Error("network_control_unavailable");
      const cell = prepareCell({ root, arm: plannedCell.arm, task: inputs.task, ruleText: inputs.ruleText, proxy, gjcBin, userHome: os.homedir() });
      const proof = proveCellIsolation(cell, { proxy, blockedNetworkHost: other.host });
      isolation = proof.receipt;
      if (!proof.ok) throw new Error(`isolation_${isolation.reason}`);
      const run = (command, args, env) => {
        const result = spawnSync(SEATBELT_BIN, ["-f", proof.profilePath, command, ...args], { cwd: cell.mount, env, encoding: "utf8", timeout: 10000 });
        return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
      };
      let pluginState;
      let version;
      let configured;
      let previous = null;
      for (const attempt of cellAttempts) {
        // --no-session still leaves native runtime metadata. Each attempt gets
        // fresh owned state; only the explicit B2 public feedback survives.
        // Recreate the same canonical mount so the successful profile and
        // environment binding remain byte-for-byte unchanged.
        rmSync(cell.mount, { recursive: true, force: true });
        const freshCell = prepareCell({ root, arm: plannedCell.arm, task: inputs.task, ruleText: inputs.ruleText, proxy, gjcBin, userHome: os.homedir() });
        pluginState = collectPluginState({ gjcBin: freshCell.gjcBin, env: freshCell.env, run });
        if (pluginState.status !== "ok" || pluginState.plugins.length !== 0) throw new Error("child_plugin_state_unexpected");
        version = run(freshCell.gjcBin, ["--version"], freshCell.env);
        if (version.status !== 0) throw new Error("child_version_unavailable");
        configured = computeHarnessDigest({ agentDir: freshCell.agent, targets: ["models.yml", ...(plannedCell.arm === "B2" ? ["RULES.md"] : [])] });
        const remaining = Math.min(LIMITS.cellWallMs - (Date.now() - cellStarted), LIMITS.pilotWallMs - (Date.now() - started));
        if (remaining <= 0) throw new Error("wall_budget_exceeded");
        const token = proxy.armSlot(attempt.slotId, attempt.arm, Math.min(cellStarted + LIMITS.cellWallMs, started + LIMITS.pilotWallMs, Date.now() + 30000));
        const prompt = taskPrompt(inputs.task, attempt.arm === "B2" ? previous : null);
        const result = await runNativeAttempt({ cell: freshCell, isolation: proof, token, prompt, timeoutMs: Math.min(30000, remaining) });
        const rows = proxy.rows.filter((row) => row.slotId === attempt.slotId);
        const row = rows[0];
        Object.assign(attempt, { status: "error", reason: row?.error ?? result.error ?? "native_attempt_failed", nativeExitCode: result.code, wallMs: result.wallMs, stdoutDigest: digest(result.stdout), stderrDigest: digest(result.stderr) });
        if (row) Object.assign(attempt, row);
        attempt.bundleDigest = configured.rootHash;
        if (result.code !== 0 || result.error || rows.length !== 1 || row?.status !== "ok" || result.stdout.trim() !== row.output.trim()) {
          attempt.status = "error";
          throw new Error(attempt.reason);
        }
        attempt.status = "ok";
        delete attempt.reason;
        previous = { output: row.output, errors: publicDecision(row.output).errors };
        durableAppend(eventsFile, { kind: "attempt", ...attempt });
      }
      const consumption = cellAttempts.every((a) => a.status === "ok" && a.rulePresent === (plannedCell.arm === "B2") && a.declaredOutputLimit === 300);
      loading = buildLoadingReceipt({ sourceHead, gjcVersion: version.stdout.trim(), pluginState, harnessDigest: configured, expected: { guards: [{ id: "native-rule-inclusion-exclusion-and-output-cap", resolved: consumption }] }, agentDir: cell.agent });
      if (!loading.loaded) throw new Error("loading_receipt_rejected");
      if (Date.now() - cellStarted > LIMITS.cellWallMs) throw new Error("cell_wall_exceeded");
    } catch (error) {
      stopped = /^[a-z_]+$/.test(error.message) ? error.message : "pilot_execution_failed";
      cellError = stopped;
      durableAppend(eventsFile, { kind: "stopped", cell: plannedCell, reason: stopped });
    } finally {
      other?.stop();
      await proxy?.close();
      if (root) rmSync(root, { recursive: true, force: true });
      const receipt = cellReceipt({ cell: plannedCell, attempts: cellAttempts, inputs, loading, isolation, sourceHead, source, harnessDigest, wallMs: Date.now() - cellStarted, mode, executionError: cellError });
      receipts.push(receipt);
      durableAppend(eventsFile, { kind: "cell", receipt });
    }
  }
  const report = {
    schema: "harness2.m1.pilot_report.v1", mode, efficacy: "NOT ASSESSED", sourceHead, sourceDigest: source, frozenDigest: harnessDigest,
    stopped, limits: LIMITS, wallMs: Date.now() - started, attempts, receipts,
    attemptsDenominator: { planned: 21, ok: attempts.filter((a) => a.status === "ok").length, error: attempts.filter((a) => a.status === "error").length, skipped: attempts.filter((a) => a.status === "skipped").length },
    cellsDenominator: { planned: 9, passed: receipts.filter((r) => r.outcome === "passed").length, failed: receipts.filter((r) => r.outcome === "failed").length, error: receipts.filter((r) => r.outcome === "error").length, skipped: receipts.filter((r) => r.outcome === "skipped").length },
    cost: ledger?.snapshot() ?? { measured: false, scope: "scripted local endpoint; not real-provider usage" },
    cohort: projectQualityTrialCohort(receipts),
  };
  report.cohortIdentityVerified = report.cohort.total === 9 && report.cohort.duplicate === 0 && report.cohort.admissible.length + report.cohort.excluded.reduce((n, row) => n + row.count, 0) === 9;
  if (!report.cohortIdentityVerified) report.stopped ??= "cohort_identity_mismatch";
  if (mode === "live" && (report.cohort.admissible.length !== 9 || !receipts.every((receipt) => receipt.evalid.valid))) report.stopped ??= "live_receipt_invalid";
  writeFileSync(path.join(outputDir, "attempts.jsonl"), attempts.map((attempt) => JSON.stringify(attempt)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  writeFileSync(path.join(outputDir, "receipts.jsonl"), receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
  save(path.join(outputDir, "report.json"), report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const values = new Map();
  const flags = new Set();
  const names = new Set(["--out", "--budget", "--pricing", "--native-proof", "--shared-delivery", "--approve-live"]);
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--live") { if (flags.has(arg)) throw new Error("duplicate_flag"); flags.add(arg); }
    else if (names.has(arg) && args[i + 1] && !args[i + 1].startsWith("--") && !values.has(arg)) values.set(arg, args[++i]);
    else throw new Error("invalid_or_missing_argument");
  }
  if (!values.has("--out")) throw new Error("usage: run-pilot.mjs --out NEW_DIRECTORY [--live --approve-live 1 --budget JSON --pricing JSON --native-proof JSON --shared-delivery JSON]");
  const live = flags.has("--live");
  const json = (flag) => values.has(flag) ? loadJson(values.get(flag)) : null;
  const report = await runPilot({ outputDir: values.get("--out"), mode: live ? "live" : "dry", approveLive: values.has("--approve-live") ? Number(values.get("--approve-live")) : null, budget: json("--budget"), pricing: json("--pricing"), nativeProof: json("--native-proof"), sharedDelivery: json("--shared-delivery"), apiKey: live ? process.env.OPENROUTER_API_KEY : null });
  console.log(JSON.stringify({ mode: report.mode, efficacy: report.efficacy, stopped: report.stopped, attempts: report.attemptsDenominator, cells: report.cellsDenominator, cost: report.cost, cohort: report.cohort }, null, 2));
  process.exitCode = report.stopped ? 1 : 0;
}
