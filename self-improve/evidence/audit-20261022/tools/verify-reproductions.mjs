#!/usr/bin/env node
/**
 * Verify the frozen-corpus reproductions end to end.
 *
 * Usage: node self-improve/evidence/audit-20261022/tools/verify-reproductions.mjs [workdir]
 *
 * With no workdir it creates a temporary directory, extracts the two freeze
 * blobs from git, runs dream/replay, and verifies the receipts. A supplied
 * workdir must already contain the five artifacts (documented in README.md).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..", "..");
const supplied = process.argv[2];
const workdir = supplied ? path.resolve(supplied) : mkdtempSync(path.join(os.tmpdir(), "rrsi-audit-"));
const generated = !supplied;

const P2B_LEDGER = "9fc5668d4542fd1e6e410edd6bcee53d968e13d7e3c9294fb88aa82daf211638";
const P2B_RECEIPT = "d6635a0bac2575a48cfbea0bb777f4b7b6986836662fb42ccea163bdc61df489";
const P2_LEDGER = "6700fb56d668b33e358f7239af7c11a460f32306aeb5754a955c1ace1d263071";
const P2_RECEIPT = "e7f987e5dfc0764bf0cb20ddc8e4e0262313a8134f0e7940dd506ee75dc2761c";
const P2_RAW = "72e25ab9092fac9a2f9ac3a9903a9e5aa2c3fffae3038ecd25a9c91a5b2da72e";

const git = (args) => execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const run = (args, out) => execFileSync(process.execPath, args, { cwd: repoRoot, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });

if (generated) {
  writeFileSync(path.join(workdir, "ledger-p2b.jsonl"), git(["show", "e6675cb:self-improve/ledger.jsonl"]));
  writeFileSync(path.join(workdir, "ledger-p2.jsonl"), git(["show", "7f2f97f:self-improve/ledger.jsonl"]));
  writeFileSync(path.join(workdir, "dream-p2b.json"), run(["self-improve/scripts/run.mjs", "dream", "--seed", "1", "--ledger", path.join(workdir, "ledger-p2b.jsonl"), "--json"]));
  writeFileSync(path.join(workdir, "replay-p2b.json"), run(["self-improve/scripts/run.mjs", "replay", "--ledger", path.join(workdir, "ledger-p2b.jsonl"), "--json"]));
  writeFileSync(path.join(workdir, "dream-p2.json"), run(["self-improve/scripts/run.mjs", "dream", "--seed", "1", "--ledger", path.join(workdir, "ledger-p2.jsonl"), "--json"]));
}

const read = (name) => readFileSync(path.join(workdir, name), "utf8");
const parse = (name) => JSON.parse(read(name));

const checks = [
  ["p2b corpus", parse("dream-p2b.json").corpus.ledgerSha256, P2B_LEDGER],
  ["p2b receiptHash", parse("dream-p2b.json").receiptHash, P2B_RECEIPT],
  ["p2 corpus", parse("dream-p2.json").corpus.ledgerSha256, P2_LEDGER],
  ["p2 receiptHash", parse("dream-p2.json").receiptHash, P2_RECEIPT],
];

let failed = 0;
for (const [name, observed, expected] of checks) {
  const ok = observed === expected;
  if (!ok) failed += 1;
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name} observed=${String(observed).slice(0, 16)} expected=${expected.slice(0, 16)}\n`);
}

const raw = await import("node:crypto").then(({ createHash }) => createHash("sha256").update(read("ledger-p2.jsonl")).digest("hex"));
const rawOk = raw === P2_RAW;
if (!rawOk) failed += 1;
process.stdout.write(`${rawOk ? "PASS" : "FAIL"} p2 raw-file sha256 observed=${raw.slice(0, 16)} expected=${P2_RAW.slice(0, 16)}\n`);

const replay = parse("replay-p2b.json");
const committed = JSON.parse(readFileSync(path.join(repoRoot, "self-improve", "evidence", "p2b", "replay-b0b1.json"), "utf8"));
const comparable = (value) => {
  const copy = JSON.parse(JSON.stringify(value));
  if (copy.corpus) delete copy.corpus.ledgerPath;
  return copy;
};
const same = JSON.stringify(comparable(replay)) === JSON.stringify(comparable(committed));
if (!same) failed += 1;
process.stdout.write(`${same ? "PASS" : "FAIL"} p2b replay equals evidence/p2b/replay-b0b1.json except corpus.ledgerPath\n`);

process.stdout.write(`verdict=${failed === 0 ? "verified" : "mismatch"} failures=${failed} workdir=${generated ? "temporary" : workdir}\n`);
if (generated) rmSync(workdir, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
