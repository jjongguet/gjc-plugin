#!/usr/bin/env node
/**
 * self-improve CLI: report, cycle, recover, prune, runner, history.
 */
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as fs from "node:fs";
import DOMAIN from "../domains/gjc-plugin/adapter.mjs";
import { defaultRunRoot, historyState, pruneRuns, recoverPendingCycle, runCycle } from "../lib/engine.mjs";
import { LOOP_DEFAULTS, runLoop } from "../lib/loop.mjs";
import { ledgerCounts } from "../lib/ledger.mjs";
import { buildTextFixturePrompt, runStochasticEvaluation } from "../lib/runner.mjs";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEDGER = join(SELF_IMPROVE_DIR, "ledger.jsonl");

const USAGE = `usage: node self-improve/scripts/run.mjs <command> [options]

commands:
  report  [--json] [--ledger <path>]
  cycle   --proposal <path> [--repo <path>] [--run-root <path>] [--ledger <path>]
          [--domain <id>] [--campaign <id>] [--dry-run] [--install] [--reset-budget] [--json]
  loop    [--repo <path>] [--proposer stub|cmd] [--proposer-cmd '<template>'] [--live-approved]
          [--max-cycles N] [--max-wall-ms T] [--max-proposer-calls C] [--batch-size W] [--proposer-timeout-ms <n>]
          [--stop-on-adopt] [--install] [--loop-id <id>] [--run-root <path>] [--ledger <path>] [--dry-run] [--json]
  recover [--repo <path>] [--run-root <path>] [--json]
  prune   [--run-root <path>] [--keep <n>] [--json]
  runner  --baseline <dir> --candidate <dir> [--mode local_stub|live] [--k <n>]
          [--timeout-ms <n>] [--model <pin>] [--prompt <text> | --text-fixture <path>]
          [--live-approved] [--run-root <path>] [--json]
  history [--json] [--ledger <path>]
`;

const VALUED_FLAGS = new Set([
  "--ledger",
  "--domain",
  "--proposal",
  "--repo",
  "--run-root",
  "--campaign",
  "--keep",
  "--baseline",
  "--candidate",
  "--mode",
  "--k",
  "--timeout-ms",
  "--model",
  "--prompt",
  "--text-fixture",
  "--proposer",
  "--proposer-cmd",
  "--max-cycles",
  "--max-wall-ms",
  "--max-proposer-calls",
  "--proposer-timeout-ms",
  "--batch-size",
  "--loop-id",
]);

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const options = { json: false, dryRun: false, liveApproved: false };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--json") options.json = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--live-approved") options.liveApproved = true;
    else if (token === "--install") options.install = true;
    else if (token === "--reset-budget") options.resetBudget = true;
    else if (token === "--stop-on-adopt") options.stopOnAdopt = true;
    else if (VALUED_FLAGS.has(token)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${token} requires a value` };
      options[token.slice(2)] = value;
      i += 1;
    } else {
      return { error: `unknown option: ${token}` };
    }
  }
  return { command, options };
}

function runReport(options) {
  const ledgerPath = options.ledger ? resolve(options.ledger) : DEFAULT_LEDGER;
  const counts = ledgerCounts(ledgerPath);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ledger: ledgerPath, ...counts }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `ledger=${ledgerPath}\n` +
        `rows=${counts.total} cycles=${counts.byKind.cycle} adoptions=${counts.byKind.adoption}\n` +
        `verdicts: adopt=${counts.byVerdict.adopt} reject=${counts.byVerdict.reject} inconclusive=${counts.byVerdict.inconclusive}\n` +
        `cost: wallMs=${counts.cost.wallMsMeasured}/${counts.cost.cycleRows} bytes=${counts.cost.bytesMeasured}/${counts.cost.cycleRows} tokens=${counts.cost.tokensMeasured} measured/${counts.cost.tokensNull} null\n` +
        `chain: ${counts.chain.ok ? "ok" : "broken"} (${counts.chain.count} rows)\n`,
    );
  }
  return 0;
}

async function runCycleCommand(options) {
  if (!options.proposal) {
    process.stderr.write(`cycle requires --proposal <path>\n\n${USAGE}`);
    return 2;
  }
  if (options.domain && options.domain !== DOMAIN.id) {
    process.stderr.write(`unknown_domain: ${options.domain} (adapter id is ${DOMAIN.id})\n`);
    return 2;
  }
  const repoRoot = resolve(options.repo ?? process.cwd());
  const proposalFile = resolve(options.proposal);
  const proposal = JSON.parse(fs.readFileSync(proposalFile, "utf8"));
  if (options.campaign) proposal.campaignId = options.campaign;
  if (proposal.patchFile && !isAbsolute(proposal.patchFile)) {
    proposal.patchFile = resolve(dirname(proposalFile), proposal.patchFile);
  }
  const result = await runCycle({
    repoRoot,
    adapter: DOMAIN,
    proposal,
    runRoot: options["run-root"] ? resolve(options["run-root"]) : undefined,
    ledgerPath: options.ledger ? resolve(options.ledger) : join(repoRoot, "self-improve", "ledger.jsonl"),
    dryRun: options.dryRun === true,
    install: options.install === true,
    resetBudget: options.resetBudget === true,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `status=${result.status} cycle=${result.cycleId ?? "-"} decision=${result.decision ?? "-"} adoption=${result.adoption ?? "-"}\n` +
        (result.reasons?.length ? `reasons: ${result.reasons.join(", ")}\n` : ""),
    );
  }
  return result.status === "ok" || result.status === "dry-run" ? 0 : 2;
}

function runRecoverCommand(options) {
  const runRoot = options["run-root"] ? resolve(options["run-root"]) : defaultRunRoot();
  const repoRoot = resolve(options.repo ?? process.cwd());
  const results = recoverPendingCycle({ runRoot, repoRoot });
  if (options.json) process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  else process.stdout.write(results.length === 0 ? "no pending cycles\n" : `${JSON.stringify(results)}\n`);
  return 0;
}

function runPruneCommand(options) {
  const runRoot = options["run-root"] ? resolve(options["run-root"]) : defaultRunRoot();
  const keep = options.keep === undefined ? 10 : Number.parseInt(options.keep, 10);
  if (!Number.isInteger(keep) || keep < 0) {
    process.stderr.write(`invalid --keep: ${options.keep}\n`);
    return 2;
  }
  const result = pruneRuns({ runRoot, keep });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else
    process.stdout.write(`removed=${result.removed.length}${result.removed.length ? ` (${result.removed.join(", ")})` : ""}\n`);
  return 0;
}

async function runRunnerCommand(options) {
  if (!options.baseline || !options.candidate) {
    process.stderr.write(`runner requires --baseline <dir> and --candidate <dir>\n\n${USAGE}`);
    return 2;
  }
  const runRoot = options["run-root"] ? resolve(options["run-root"]) : defaultRunRoot();
  let prompt = options.prompt ?? "self-improve local stub trial";
  let textFixture = null;
  if (options["text-fixture"]) {
    const built = buildTextFixturePrompt({ fixturePath: options["text-fixture"] });
    prompt = built.prompt;
    textFixture = built.textFixture;
  }
  const k = options.k === undefined ? undefined : Number.parseInt(options.k, 10);
  if (k !== undefined && (!Number.isInteger(k) || k < 3)) {
    process.stderr.write(`invalid --k: ${options.k} (k >= 3)\n`);
    return 2;
  }
  const timeoutMs = options["timeout-ms"] === undefined ? undefined : Number.parseInt(options["timeout-ms"], 10);
  const result = await runStochasticEvaluation({
    mode: options.mode ?? "local_stub",
    k,
    timeoutMs: Number.isInteger(timeoutMs) ? timeoutMs : undefined,
    modelPin: options.model,
    prompt,
    textFixture,
    liveApproved: options.liveApproved === true,
    baselineDir: resolve(options.baseline),
    candidateDir: resolve(options.candidate),
    runRoot,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `mode=${result.mode ?? "-"} skipped=${result.skipped ?? false}${result.reason ? ` reason=${result.reason}` : ""} ` +
        `baseline=${result.baseline?.median ?? "-"} candidate=${result.candidate?.median ?? "-"} delta=${result.delta ?? "-"} floor=${result.floor ?? "-"}\n`,
    );
  }
  return 0;
}

async function runLoopCommand(options) {
  const repoRoot = resolve(options.repo ?? process.cwd());
  const proposer = options.proposer ?? "stub";
  if (proposer !== "stub" && proposer !== "cmd") {
    process.stderr.write(`unknown --proposer: ${proposer} (stub|cmd)\n`);
    return 2;
  }
  if (proposer === "cmd" && !options["proposer-cmd"]) {
    process.stderr.write(`loop --proposer cmd requires --proposer-cmd '<template>'\n`);
    return 2;
  }
  const numberFlag = (name) => {
    if (options[name] === undefined) return undefined;
    const value = Number.parseInt(options[name], 10);
    if (!Number.isInteger(value) || value < 1) {
      process.stderr.write(`invalid --${name}: ${options[name]}\n`);
      return null;
    }
    return value;
  };
  const maxCycles = numberFlag("max-cycles");
  const maxWallMs = numberFlag("max-wall-ms");
  const maxProposerCalls = numberFlag("max-proposer-calls");
  const batchSize = numberFlag("batch-size");
  const proposerTimeoutMs = numberFlag("proposer-timeout-ms");
  if ([maxCycles, maxWallMs, maxProposerCalls, batchSize, proposerTimeoutMs].includes(null)) return 2;
  const result = await runLoop({
    repoRoot,
    adapter: DOMAIN,
    proposer,
    proposerCmd: options["proposer-cmd"] ?? null,
    liveApproved: options.liveApproved === true,
    maxCycles: maxCycles ?? LOOP_DEFAULTS.maxCycles,
    maxWallMs: maxWallMs ?? LOOP_DEFAULTS.maxWallMs,
    maxProposerCalls: maxProposerCalls ?? LOOP_DEFAULTS.maxProposerCalls,
    batchSize: batchSize ?? LOOP_DEFAULTS.batchSize,
    cmdProposerTimeoutMs: proposerTimeoutMs ?? undefined,
    stopOnAdopt: options.stopOnAdopt === true,
    install: options.install === true,
    loopId: options["loop-id"],
    runRoot: options["run-root"] ? resolve(options["run-root"]) : undefined,
    ledgerPath: options.ledger ? resolve(options.ledger) : join(repoRoot, "self-improve", "ledger.jsonl"),
    dryRun: options.dryRun === true,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `status=${result.status} loop=${result.loopId ?? "-"} cycles=${result.counters?.cycles ?? 0} ` +
        `stopped=${result.stoppedReason ?? result.reason ?? "-"}\n`,
    );
  }
  return 0;
}

function runHistoryCommand(options) {
  const ledgerPath = options.ledger ? resolve(options.ledger) : DEFAULT_LEDGER;
  const state = historyState(ledgerPath);
  if (options.json) process.stdout.write(`${JSON.stringify({ ledger: ledgerPath, ...state }, null, 2)}\n`);
  else
    process.stdout.write(
      `ledger=${ledgerPath} stalled=[${state.stalled.join(", ")}] recentRejects=${state.lastRejects.length}\n`,
    );
  return 0;
}

async function run(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { command, options } = parsed;
  if (command === "report") return runReport(options);
  if (command === "cycle") return await runCycleCommand(options);
  if (command === "loop") return await runLoopCommand(options);
  if (command === "recover") return runRecoverCommand(options);
  if (command === "prune") return runPruneCommand(options);
  if (command === "runner") return await runRunnerCommand(options);
  if (command === "history") return runHistoryCommand(options);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

process.exitCode = await run(process.argv.slice(2));
