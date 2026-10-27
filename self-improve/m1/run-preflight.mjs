#!/usr/bin/env node
/**
 * M1 pilot preflight CLI.
 *
 *   node self-improve/m1/run-preflight.mjs --dry-run \
 *     --manifest self-improve/tests/fixtures/pilot/manifest.json \
 *     --budget self-improve/m1/budget.example.json --out /tmp/pilot-dry
 *
 * Dry run by default: plans cells and budget, resolves oracles, probes the
 * sandbox, attaches the loading receipt, and reports every blocker. It never
 * calls a model. `--live` is refused with a stable code; there is no live
 * executor in this slice.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { manifestDigest } from "../lib/behavior-eval.mjs";
import { probeIsolation } from "../lib/isolation-runtime.mjs";
import { collectLoadingReceipt } from "../lib/loading-receipt.mjs";
import { preflight } from "./preflight.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? null : args[index + 1] ?? null;
};

const manifestPath = valueOf("--manifest");
if (!manifestPath) {
  process.stderr.write("usage: run-preflight.mjs --manifest <path> [--budget <path>] [--out <dir>] [--repeats N] [--live --approve-live <capUsd>] [--json]\n");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.digest = manifestDigest(manifest);
const budgetPath = valueOf("--budget");
const budget = budgetPath ? JSON.parse(readFileSync(budgetPath, "utf8")) : {};
const repeats = valueOf("--repeats") ? Number.parseInt(valueOf("--repeats"), 10) : 3;
const outDir = valueOf("--out");
const live = flag("--live");
const approveRaw = valueOf("--approve-live");
const approveLive = approveRaw === null ? null : Number(approveRaw);

const runRoot = mkdtempSync(path.join(os.tmpdir(), "harness2-preflight-"));
const mountDir = path.join(runRoot, "mount");
let isolation = null;
try {
  isolation = probeIsolation({ mountDir });
} catch (error) {
  isolation = { status: "unavailable", reason: error?.message ? String(error.message).slice(0, 80) : "probe_failed", probes: [] };
}
let loading = null;
try {
  loading = collectLoadingReceipt({
    sourceHead: valueOf("--source-head") ?? null,
    targets: ["gjc-plugins/registry.json", "gjc-plugins/rrsi"],
    expected: { guards: [{ id: "m1-preflight", resolved: true }] },
  });
} catch (error) {
  loading = { loaded: false, sha256: null, failures: ["loading_not_probed"] };
}

const result = preflight({
  manifest,
  budget,
  repeats,
  isolation,
  loading,
  live,
  approveLive,
  executorAvailable: false,
  sourceHead: valueOf("--source-head") ?? null,
});
rmSync(runRoot, { recursive: true, force: true });

const text = `${JSON.stringify(result, null, 2)}\n`;
if (outDir) {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "plan.json"), text);
}
if (flag("--json") || outDir) process.stdout.write(text);
else {
  process.stdout.write(
    `preflight: dryRun=${result.dryRun} cells=${result.cellCount} blockers=${result.blockers.length} ${JSON.stringify(result.blockerCounts)} live=${result.live.status}${result.live.code ? `(${result.live.code})` : ""}\n`,
  );
}
if (result.live.status === "refused") process.exit(result.live.exit);
process.exit(result.blockers.length === 0 ? 0 : 1);
