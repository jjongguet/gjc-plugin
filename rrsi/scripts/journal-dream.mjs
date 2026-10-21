#!/usr/bin/env bun
/**
 * Journal -> dream entry point for the journal-based auto-optimization
 * pipeline. Explicitly invoked; keyless and read-only.
 *
 *   bun rrsi/scripts/journal-dream.mjs [--limit N] [--seed S] \
 *       [--journal-dir <path>] [--out <receipt.json>] [--json]
 *
 * Reads the jev-advisor journal through the rrsi projections (the same core
 * that is inlined into tools/rrsi.ts), merges it into an in-memory store and
 * runs the deterministic Dream-RSI replay. Nothing is persisted: the private
 * store (~/.gjc-plugin/rrsi/store.json) is never rewritten, so captured
 * episodes are never clobbered and reruns over the same journal+seed are
 * byte-identical.
 *
 * This is a DIFFERENT corpus from `self-improve/scripts/run.mjs dream`, which
 * replays the self-improve ledger: journal-dream replays recorded agent-usage
 * records (rrsi source tag `jev-journal`). No network, no credentials, no
 * model calls, no timers.
 *
 * A missing or empty journal fails closed: exit 1 with `no_journal` /
 * `no_records` — never a synthetic substitute.
 */
import * as fs from "node:fs";
import path from "node:path";
import {
  RRSI_LIMITS,
  dreamOverStore,
  emptyStore,
  mergeEpisodes,
  normalizeEpisode,
  projectJournalRecords,
  readJournalRecords,
  rrsiJournalDir,
  storeCounts,
  summarizeReceipt,
} from "../lib/rrsi.ts";

// Deterministic snapshot label: journal-dream never persists state, so this
// constant only feeds the in-memory corpus hashes (byte-identical reruns).
const SNAPSHOT_NOW = "1970-01-01T00:00:00.000Z";

const USAGE =
  "usage: bun rrsi/scripts/journal-dream.mjs [--limit N] [--seed S] [--journal-dir <path>] [--out <receipt.json>] [--json]";

function parseArgs(argv) {
  const options = { limit: 200, seed: 1, journalDir: null, out: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--json") {
      options.json = true;
      continue;
    }
    const value = argv[index + 1];
    if (flag === "--limit" && value !== undefined) {
      options.limit = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (flag === "--seed" && value !== undefined) {
      options.seed = Number.parseInt(value, 10);
      index += 1;
      continue;
    }
    if (flag === "--journal-dir" && value !== undefined) {
      options.journalDir = value;
      index += 1;
      continue;
    }
    if (flag === "--out" && value !== undefined) {
      options.out = value;
      index += 1;
      continue;
    }
    process.stderr.write(`journal-dream: unknown argument ${flag}\n${USAGE}\n`);
    process.exit(2);
  }
  if (!Number.isInteger(options.limit) || options.limit < 1) {
    process.stderr.write(`journal-dream: invalid --limit\n${USAGE}\n`);
    process.exit(2);
  }
  if (!Number.isSafeInteger(options.seed)) {
    process.stderr.write(`journal-dream: invalid --seed\n${USAGE}\n`);
    process.exit(2);
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const journalDir = options.journalDir ?? rrsiJournalDir(process.env);
const journal = readJournalRecords({ journalDir });
if (journal.status !== "ok" || journal.records.length === 0) {
  process.stderr.write(`journal-dream: ${journal.reason ?? "no_journal"} (journal dir: ${journalDir})\n`);
  process.exit(1);
}
const projected = projectJournalRecords(journal.records, { limit: options.limit });
if (projected.attempts.length === 0) {
  process.stderr.write("journal-dream: no_records\n");
  process.exit(1);
}

function chunkAttempts(attempts) {
  const chunkSize = RRSI_LIMITS.maxAttemptsPerEpisode;
  const chunks = [];
  for (let index = 0; index < attempts.length; index += chunkSize) {
    chunks.push(attempts.slice(index, index + chunkSize));
  }
  return chunks;
}

const store = mergeEpisodes({
  store: emptyStore(SNAPSHOT_NOW),
  // One episode keeps at most RRSI_LIMITS.maxAttemptsPerEpisode attempts, so
  // the projection is chunked into bounded episodes instead of silently
  // truncating the requested limit.
  episodes: chunkAttempts(projected.attempts).map((attempts, index) =>
    normalizeEpisode(
      {
        source: "jev-journal",
        goal: `jev-advisor journal (${journal.segments} segment(s)) part ${index + 1}`,
        attempts,
      },
      SNAPSHOT_NOW,
    ),
  ),
  now: SNAPSHOT_NOW,
});

const { receipt: dream } = dreamOverStore({ store, seed: options.seed });

const receipt = {
  schema: "gjc.self-improve.journal-dream.v1",
  provenance: {
    source: "jev-journal",
    segments: journal.segments,
    records: journal.records.length,
    importedAttempts: projected.attempts.length,
    branches: projected.branches,
    limit: options.limit,
    seed: options.seed,
  },
  counts: storeCounts(store),
  dream: summarizeReceipt(dream),
  receiptHash: dream.receiptHash,
};
const body = `${JSON.stringify(receipt, null, 2)}\n`;

if (options.out) {
  const outPath = path.resolve(options.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outPath, body, { mode: 0o600 });
}
if (options.json) {
  process.stdout.write(body);
} else {
  process.stdout.write(
    `journal-dream records=${receipt.provenance.records} attempts=${receipt.provenance.importedAttempts} ` +
      `selected=${dream.selected.id} verdict=${dream.verdict.slice(0, 64)} ` +
      `receipt=${receipt.receiptHash.slice(0, 12)}${options.out ? ` out=${options.out}` : ""}\n`,
  );
}
