#!/usr/bin/env node
/**
 * CLI for the Harness² loading receipt.
 *
 *   node self-improve/scripts/loading-receipt.mjs --json
 *   node self-improve/scripts/loading-receipt.mjs --expect '{"plugins":["rrsi"]}' --targets gjc-plugins/rrsi --out /tmp/lr.json
 *
 * The receipt proves which surfaces the loader resolved and what they contain;
 * it does not prove model use. Exit 0 only when `loaded: true`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { collectLoadingReceipt } from "../lib/loading-receipt.mjs";

const args = process.argv.slice(2);

function valueOf(flag) {
  const index = args.indexOf(flag);
  return index === -1 ? null : args[index + 1] ?? null;
}

function allOf(flag) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag && args[index + 1]) values.push(args[index + 1]);
  }
  return values;
}

const json = args.includes("--json");
const expectRaw = valueOf("--expect");
let expected = { plugins: [], surfaces: [], guards: [] };
if (expectRaw) {
  try {
    expected = JSON.parse(expectRaw.startsWith("{") || expectRaw.startsWith("[") ? expectRaw : readFileSync(expectRaw, "utf8"));
  } catch (error) {
    process.stderr.write(`invalid --expect: ${error.message}\n`);
    process.exit(2);
  }
}
const targets = allOf("--targets").flatMap((value) => value.split(",")).filter(Boolean);
const out = valueOf("--out");
const receipt = collectLoadingReceipt({
  agentDir: valueOf("--agent-dir") ?? undefined,
  repoRoot: valueOf("--repo-root") ?? null,
  sourceHead: valueOf("--source-head") ?? null,
  gjcVersion: valueOf("--gjc-version") ?? null,
  targets,
  expected,
  gjcBin: valueOf("--gjc") ?? "gjc",
});
if (out) writeFileSync(path.resolve(out), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
if (json || out) {
  process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
} else {
  process.stdout.write(`loading receipt: loaded=${receipt.loaded} sha256=${receipt.sha256} failures=${receipt.failures.join(",") || "none"}\n`);
}
process.exit(receipt.loaded === true ? 0 : 1);
