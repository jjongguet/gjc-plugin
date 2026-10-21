#!/usr/bin/env node
/**
 * Phase-A audit helper: verify the frozen-corpus reproductions against the
 * committed receipts. Reads only; never writes the repository.
 *
 * Usage: node self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs <workdir>
 *   <workdir> holds ledger-p2b.jsonl, dream-p2b.json, replay-p2b.json,
 *   ledger-p2.jsonl, dream-p2.json (produced by the commands in README.md).
 */
import { readFileSync } from "node:fs";
import path from "node:path";

const workdir = process.argv[2];
if (!workdir) {
  process.stderr.write("usage: verify-reproductions.mjs <workdir>\n");
  process.exit(2);
}

const read = (name) => readFileSync(path.join(workdir, name), "utf8");
const parse = (name) => JSON.parse(read(name));

const P2B_LEDGER = "9fc5668d4542fd1e6e410edd6bcee53d968e13d7e3c9294fb88aa82daf211638";
const P2B_RECEIPT = "d6635a0bac2575a48cfbea0bb777f4b7b6986836662fb42ccea163bdc61df489";
const P2_LEDGER = "6700fb56d668b33e358f7239af7c11a460f32306aeb5754a955c1ace1d263071";
const P2_RECEIPT = "e7f987e5dfc0764bf0cb20ddc8e4e0262313a8134f0e7940dd506ee75dc2761c";

const dreamP2b = parse("dream-p2b.json");
const dreamP2 = parse("dream-p2.json");
const replay = parse("replay-p2b.json");
const committed = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "..", "..", "p2b", "replay-b0b1.json"), "utf8"));

const checks = [
  ["p2b corpus", dreamP2b.corpus.ledgerSha256, P2B_LEDGER],
  ["p2b receiptHash", dreamP2b.receiptHash, P2B_RECEIPT],
  ["p2 corpus", dreamP2.corpus.ledgerSha256, P2_LEDGER],
  ["p2 receiptHash", dreamP2.receiptHash, P2_RECEIPT],
];

let failed = 0;
for (const [name, observed, expected] of checks) {
  const ok = observed === expected;
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name} observed=${String(observed).slice(0, 16)} expected=${expected.slice(0, 16)}\n`);
}

const replayComparable = JSON.parse(JSON.stringify(replay));
if (replayComparable.corpus) delete replayComparable.corpus.ledgerPath;
const committedComparable = JSON.parse(JSON.stringify(committed));
if (committedComparable.corpus) delete committedComparable.corpus.ledgerPath;
const same = JSON.stringify(replayComparable) === JSON.stringify(committedComparable);
if (!same) failed += 1;
process.stdout.write(`${same ? "PASS" : "FAIL"} p2b replay equals evidence/p2b/replay-b0b1.json except corpus.ledgerPath\n`);

process.stdout.write(`verdict=${failed === 0 ? "verified" : "mismatch"} failures=${failed}\n`);
process.exit(failed === 0 ? 0 : 1);
