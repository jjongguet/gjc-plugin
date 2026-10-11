#!/usr/bin/env node
/**
 * self-improve CLI (skeleton).
 * M01 provides `report`; `cycle` lands with the engine milestone.
 */
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { ledgerCounts } from "../lib/ledger.mjs";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEDGER = join(SELF_IMPROVE_DIR, "ledger.jsonl");

const USAGE = `usage: node self-improve/scripts/run.mjs <command> [options]

commands:
  report [--json] [--ledger <path>]   counts and chain status from the ledger
  cycle  [--domain <id>] [--proposal <path>] [--dry-run]
                                      run one self-improvement cycle (lands with the engine milestone)
`;

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const options = { json: false, dryRun: false };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--json") options.json = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--ledger" || token === "--domain" || token === "--proposal") {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `${token} requires a value` };
      }
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

function run(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { command, options } = parsed;
  if (command === "report") return runReport(options);
  if (command === "cycle") {
    process.stderr.write(
      "cycle is not implemented yet: the engine milestone provides it. No files were read or written.\n",
    );
    return 2;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

process.exitCode = run(process.argv.slice(2));
