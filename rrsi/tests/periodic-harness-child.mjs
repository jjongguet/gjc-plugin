#!/usr/bin/env bun
// Child for the node:test receipt harness (rrsi/tests/periodic.test.mjs).
// HOME and TMPDIR are provided by the parent (isolated); this process never
// overrides HOME after start so the plugin's private-journal storage resolves
// from the same process-owned home as the plugin runtime.
// Observes one full periodic cycle: no_input -> ran -> skipped_due -> unchanged,
// with artifact counts and byte-stability of the store across the rerun.
import * as fs from "node:fs";
import * as path from "node:path";

const plugin = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const HOME = process.env.HOME;
if (!HOME || !HOME.includes("rrsi-periodic-child")) {
  console.error(`refusing to run without an isolated HOME (got: ${HOME ?? "unset"})`);
  process.exit(2);
}

const hook = await import(path.join(plugin, "hooks", "rrsi-periodic.ts"));
const root = path.join(HOME, ".gjc-plugin", "rrsi");
const journalDir = path.join(HOME, ".gjc-plugin", "jev-advisor", "journal", "v1");
const statePath = path.join(root, "periodic.json");
const storePath = path.join(root, "store.json");
const receiptsDir = path.join(root, "runs", "v1");
const outcomeJournal = path.join(root, "journal", "v1");

const backdate = (ms) => {
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.lastAttemptAt = new Date(Date.now() - ms).toISOString();
  state.lastSuccessAt = state.lastAttemptAt;
  state.nextRetryAt = null;
  fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
};
const countReceipts = () => { try { return fs.readdirSync(receiptsDir).filter((n) => n.endsWith(".json")).length; } catch { return 0; } };
const countOutcomes = () => { try { return fs.readdirSync(outcomeJournal).filter((n) => n.endsWith(".jsonl")).flatMap((n) => fs.readFileSync(path.join(outcomeJournal, n), "utf8").split("\n")).filter(Boolean).length; } catch { return 0; } };
const readSafe = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return null; } };

const empty = await hook.runPeriodic({ env: process.env, mode: "inline" });
fs.mkdirSync(journalDir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(journalDir, "s.jsonl"), `${Array.from({ length: 12 }, (_, i) => JSON.stringify({ id: `r${i}`, operation: "run", durationMs: 5, advice: { status: "decision", tier: "fast" } })).join("\n")}\n`);
backdate(25 * 60 * 60 * 1000);
const first = await hook.runPeriodic({ env: process.env, mode: "inline" });
const second = await hook.runPeriodic({ env: process.env, mode: "inline" });
backdate(25 * 60 * 60 * 1000);
const storeBefore = readSafe(storePath);
const third = await hook.runPeriodic({ env: process.env, mode: "inline" });
const storeAfter = readSafe(storePath);

console.log(JSON.stringify({
  empty: empty.status,
  first: first.status,
  firstStoreWrite: first.storeWrite,
  firstJournalStorage: first.journalStorage ?? null,
  second: second.status,
  third: third.status,
  thirdStoreWrite: third.storeWrite,
  storeStable: storeBefore !== null && storeBefore === storeAfter,
  receipts: countReceipts(),
  outcomes: countOutcomes(),
}));
