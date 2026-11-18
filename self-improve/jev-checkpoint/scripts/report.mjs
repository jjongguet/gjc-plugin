#!/usr/bin/env node
/**
 * Copy the run's result artifacts into the repository record and seal them.
 *   node self-improve/jev-checkpoint/scripts/report.mjs --run-dir <dir> --out docs/plans/JJO-2329-jev-checkpoint/results
 *
 * Copies only aggregate receipts (no transcripts, no cell trees, no proxy
 * bodies), scans every copied byte for the provider keys in process (the keys
 * never leave this process), rewrites absolute temp paths to <RUN>, and writes
 * SHA256SUMS. Vocabulary guard: unless the verdict is `adopted`, the copied
 * summary must not claim improvement.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyLeaked, readOpenGatewayKey, readOpenRouterKey } from "../lib/keys.mjs";

export const ARTIFACTS = Object.freeze([
	"manifest.json", "readiness.json", "catalog-latest.json", "ledger-l0.json", "w-intervals.json",
	"s0-pass.json", "s0b-inertness.json", "j0-labels.json", "j0-dev.json", "j0-test.json",
	"s1-decision.json", "fz-freeze.json", "analysis.json", "arm-table.md", "summary.json",
	"S1/summary.json", "S1/reprojection.json", "S2/summary.json", "S3/summary.json",
	"receipts/S1.jsonl", "receipts/S2.jsonl", "receipts/S3.jsonl", "receipts/validation.json",
	// Post-run audits (report-only): operational impact, holdout guard, re-scoring, sensitivity.
	"ops-impact.json", "holdout-access-pre-s3.json", "rescore.json", "rescore-sandboxed.json", "oracle-sensitivity.json", "post-review-outputs.json",
]);
export const VOCABULARY = /(개선|improve|better)/i;

function arg(name, fallback = null) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const runDir = path.resolve(arg("run-dir") ?? "");
	const out = path.resolve(arg("out") ?? "");
	if (!arg("run-dir") || !arg("out")) { process.stderr.write("usage: report.mjs --run-dir <dir> --out <dir>\n"); process.exit(2); }
	const keys = [readOpenGatewayKey()];
	try { keys.push(readOpenRouterKey()); } catch { /* J0 key absent: nothing to scan for */ }
	mkdirSync(out, { recursive: true });
	const copied = [];
	for (const name of ARTIFACTS) {
		const source = path.join(runDir, name);
		if (!existsSync(source)) continue;
		const text = readFileSync(source, "utf8").split(realpathSync(runDir)).join("<RUN>").split(runDir).join("<RUN>");
		if (keys.some((key) => keyLeaked(key, [Buffer.from(text)]))) throw new Error(`key_material_in_artifact:${name}`);
		const target = path.join(out, name.replace("/", "-"));
		if (/\/Users\/|\/home\//.test(text)) throw new Error(`absolute_home_path_in_artifact:${name}`);
		writeFileSync(target, text);
		copied.push(path.basename(target));
	}
	const summary = JSON.parse(readFileSync(path.join(out, "summary.json"), "utf8"));
	if (!String(summary.verdict).startsWith("adopted")) {
		for (const name of ["summary.json", "arm-table.md"]) if (VOCABULARY.test(readFileSync(path.join(out, name), "utf8"))) throw new Error(`vocabulary_guard:${name}`);
	}
	const sums = readdirSync(out).filter((name) => name !== "SHA256SUMS").sort().map((name) => `${createHash("sha256").update(readFileSync(path.join(out, name))).digest("hex")}  ${name}`);
	writeFileSync(path.join(out, "SHA256SUMS"), `${sums.join("\n")}\n`);
	process.stdout.write(`copied ${copied.length} artifacts; SHA256SUMS ${sums.length} lines\n`);
}
