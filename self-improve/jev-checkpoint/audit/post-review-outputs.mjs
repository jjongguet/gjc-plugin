#!/usr/bin/env node
/**
 * Post-review producers for outputs the plan named but the measured run did not
 * emit (cohort gen-1 B3/A3/A11). Report-only over a finished run; the
 * pre-registered verdict is not recomputed:
 *   - receipts/{S1,S2,S3}.jsonl + validation.json (AC14/AC18, gjc.quality_trial.v2)
 *   - J0 ensemble rule sensitivity rows (AC5) from the run's own J0-test responses
 *   - the A3 Monte Carlo with its digest (AC17)
 *   - X6 decided-only accuracy, derived from the sealed X6 counts
 *   node self-improve/jev-checkpoint/audit/post-review-outputs.mjs --run-dir <dir>
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ensembleSensitivity, loadCases } from "../lib/judge.mjs";
import { FIXTURES_DIR } from "../scripts/stage.mjs";
import { monteCarloWithDigest } from "../scripts/freeze.mjs";
import { writeStageReceipts } from "../scripts/decide.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const runDir = path.resolve(arg("run-dir") ?? "");
if (!arg("run-dir")) { process.stderr.write("usage: post-review-outputs.mjs --run-dir <dir>\n"); process.exit(2); }
const jsonl = (file) => readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const records = ["S1", "S2", "S3"].flatMap((stage) => jsonl(path.join(runDir, stage, "results.jsonl")));
const receipts = writeStageReceipts(runDir, records);
const ensemble = ensembleSensitivity(jsonl(path.join(runDir, "j0-test-rows.jsonl")), loadCases(FIXTURES_DIR));
const x6 = JSON.parse(readFileSync(path.join(runDir, "analysis.json"), "utf8")).rules.X6.detail;
const decided = x6.labelChecks - x6.noDecisionTotal;
const out = {
	schema: "jexp.post_review_outputs.v1",
	at: new Date().toISOString(),
	reportOnly: true,
	receipts,
	ensembleSensitivity: ensemble,
	monteCarloA3: monteCarloWithDigest(),
	x6DecidedOnly: { decided, correct: x6.labelCorrect, accuracy: decided > 0 ? x6.labelCorrect / decided : null, note: "all correct labels are decided ones; the frozen X6 counts abstains as wrong (7/21)" },
};
writeFileSync(path.join(runDir, "post-review-outputs.json"), JSON.stringify(out, null, 2));
process.stdout.write(`receipts ${JSON.stringify(Object.fromEntries(Object.entries(receipts).map(([stage, v]) => [stage, `${v.valid}/${v.total}`])))} ensemble ${Object.entries(ensemble.variants).map(([name, v]) => `${name}=${v.accuracy.value?.toFixed(3)}`).join(" ")} mc=${out.monteCarloA3.digest.slice(0, 12)} x6decided=${out.x6DecidedOnly.correct}/${decided}\n`);
