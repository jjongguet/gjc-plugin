#!/usr/bin/env node
/**
 * self-improve CLI: report, cycle (single deterministic cycle), recover, prune.
 */
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, resolve } from "node:path";
import * as fs from "node:fs";
import DOMAIN from "../domains/gjc-plugin/adapter.mjs";
import { defaultRunRoot, pruneRuns, recoverPendingCycle, runCycle } from "../lib/engine.mjs";
import { ledgerCounts } from "../lib/ledger.mjs";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEDGER = join(SELF_IMPROVE_DIR, "ledger.jsonl");

const USAGE = `usage: node self-improve/scripts/run.mjs <command> [options]

commands:
  report  [--json] [--ledger <path>]
  cycle   --proposal <path> [--repo <path>] [--run-root <path>] [--ledger <path>]
          [--domain <id>] [--campaign <id>] [--dry-run] [--json]
  recover [--repo <path>] [--run-root <path>] [--json]
  prune   [--run-root <path>] [--keep <n>] [--json]
`;

const VALUED_FLAGS = new Set(["--ledger", "--domain", "--proposal", "--repo", "--run-root", "--campaign", "--keep"]);

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const options = { json: false, dryRun: false };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--json") options.json = true;
    else if (token === "--dry-run") options.dryRun = true;
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
  else process.stdout.write(`removed=${result.removed.length}${result.removed.length ? ` (${result.removed.join(", ")})` : ""}\n`);
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
  if (command === "recover") return runRecoverCommand(options);
  if (command === "prune") return runPruneCommand(options);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

process.exitCode = await run(process.argv.slice(2));
