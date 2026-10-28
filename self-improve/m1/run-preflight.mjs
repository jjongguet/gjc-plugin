#!/usr/bin/env node
/**
 * M1 pilot preflight CLI.
 *
 *   node self-improve/m1/run-preflight.mjs --dry-run \
 *     --manifest self-improve/tests/fixtures/pilot/manifest.json \
 *     --budget self-improve/m1/budget.example.json --out /tmp/pilot-dry
 *
 *   node self-improve/m1/run-preflight.mjs --dry-run \
 *     --manifest self-improve/tests/fixtures/pilot/manifest.json \
 *     --budget self-improve/m1/budget.example.json --subset /tmp/subset.json --json
 *
 * Dry run by default: plans cells and request slots, budgets every request,
 * resolves oracles, probes the sandbox, attaches the loading receipt, and
 * reports every blocker. It never calls a model. `--live` is refused unless an
 * existing executor is injected through the module API.
 *
 * The manifest is read and forwarded unchanged: no digest is injected, so the
 * pin is always `manifestDigest(manifest)` == `validateManifest(manifest).digest`.
 * Unknown flags and flags without a value are refused before any work happens.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { probeIsolation } from "../lib/isolation-runtime.mjs";
import { collectLoadingReceipt } from "../lib/loading-receipt.mjs";
import { preflight } from "./preflight.mjs";

const USAGE =
  "usage: run-preflight.mjs --manifest <path> [--budget <path>] [--subset <path>] [--out <dir>] [--repeats N] [--expect <json|path>] [--source-head <sha>] [--dry-run] [--json] [--live --approve-live <capUsd>]\n";
const BOOLEAN_FLAGS = new Set(["--dry-run", "--live", "--json"]);
const VALUE_FLAGS = new Set(["--manifest", "--budget", "--subset", "--out", "--repeats", "--expect", "--approve-live", "--source-head"]);

function refuse(message) {
  process.stderr.write(`${message}\n${USAGE}`);
  process.exit(2);
}

const parsed = new Map();
const args = process.argv.slice(2);
for (let index = 0; index < args.length; index += 1) {
  const token = args[index];
  if (typeof token !== "string" || !token.startsWith("--")) refuse(`unexpected argument: ${token}`);
  if (BOOLEAN_FLAGS.has(token)) {
    if (parsed.has(token)) refuse(`duplicate flag: ${token}`);
    parsed.set(token, true);
    continue;
  }
  if (!VALUE_FLAGS.has(token)) refuse(`unknown flag: ${token}`);
  if (parsed.has(token)) refuse(`duplicate flag: ${token}`);
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) refuse(`missing value for ${token}`);
  parsed.set(token, value);
  index += 1;
}

const flag = (name) => parsed.get(name) === true;
const valueOf = (name) => (parsed.has(name) ? parsed.get(name) : null);
const readJson = (target, label) => {
  try {
    return JSON.parse(readFileSync(target, "utf8"));
  } catch (error) {
    refuse(`invalid ${label}: ${error.message}`);
    return null;
  }
};

const manifestPath = valueOf("--manifest");
if (!manifestPath) refuse("--manifest is required");
const manifest = readJson(manifestPath, "--manifest");
const budgetPath = valueOf("--budget");
const budget = budgetPath ? readJson(budgetPath, "--budget") : {};
const subsetPath = valueOf("--subset");
const subset = subsetPath ? readJson(subsetPath, "--subset") : null;
const repeats = valueOf("--repeats") ? Number.parseInt(valueOf("--repeats"), 10) : 3;
const outDir = valueOf("--out");
const live = flag("--live");
const approveRaw = valueOf("--approve-live");
const approveLive = approveRaw === null ? null : Number(approveRaw);

const runRoot = mkdtempSync(path.join(os.tmpdir(), "harness2-preflight-"));
const expectRaw = valueOf("--expect");
let expected = { plugins: ["rrsi"], surfaces: [{ plugin: "rrsi", name: "rrsi" }] };
if (expectRaw) {
  if (expectRaw.startsWith("{") || expectRaw.startsWith("[")) {
    try {
      expected = JSON.parse(expectRaw);
    } catch (error) {
      refuse(`invalid --expect: ${error.message}`);
    }
  } else {
    expected = readJson(expectRaw, "--expect");
  }
}
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
    expected,
  });
} catch (error) {
  loading = { loaded: false, sha256: null, failures: ["loading_not_probed"] };
}

const result = preflight({
  manifest,
  subset,
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
    `preflight: dryRun=${result.dryRun} cells=${result.cellCount} requests=${result.requestCount} subset=${result.subset.provided ? result.subset.taskIds.join(",") : "none"} blockers=${result.blockers.length} ${JSON.stringify(result.blockerCounts)} live=${result.live.status}${result.live.code ? `(${result.live.code})` : ""}\n`,
  );
}
// Let piped JSON drain before exiting; immediate exit truncates larger plans.
process.exitCode = result.live.status === "refused" ? result.live.exit : result.blockers.length === 0 ? 0 : 1;
