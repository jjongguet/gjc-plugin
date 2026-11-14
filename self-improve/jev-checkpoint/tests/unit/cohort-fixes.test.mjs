// Boundary cohort generation-1 fixes: fail-closed gates, imputation counters,
// producers for receipts / ensemble sensitivity / Monte Carlo, test-guard floor.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createLedger } from "../../lib/accounting.mjs";
import { analyzeFinal, analyzeS1, normalizeRecords } from "../../lib/analyze.mjs";
import { harnessDigest, requireS0Harness } from "../../lib/digest.mjs";
import { ensembleSensitivity } from "../../lib/judge.mjs";
import { stageReceipts } from "../../lib/receipts.mjs";
import { stagePlan } from "../../lib/stage-plans.mjs";
import { monteCarloWithDigest, projectionPrice } from "../../scripts/freeze.mjs";
import { fileOk, tapCounts } from "../../scripts/verify.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tmp = (prefix) => mkdtempSync(path.join(os.tmpdir(), prefix));

test("verify guard: a skipped, todo or partially passing file is not ok", () => {
	const tap = (lines) => lines.map((line) => `# ${line}`).join("\n");
	assert.equal(fileOk(0, tapCounts(tap(["tests 2", "pass 2", "fail 0", "skipped 0", "todo 0", "cancelled 0"]))), true);
	assert.equal(fileOk(0, tapCounts(tap(["tests 2", "pass 0", "fail 0", "skipped 2", "todo 0", "cancelled 0"]))), false);
	assert.equal(fileOk(0, tapCounts(tap(["tests 2", "pass 1", "fail 0", "skipped 0", "todo 1", "cancelled 0"]))), false);
	assert.equal(fileOk(0, tapCounts(tap(["tests 2", "pass 2", "fail 0"]))), false, "missing counts are not a pass");
});

test("cost gates: missing prices refuse, NaN caps refuse", () => {
	assert.equal(projectionPrice(3e-8, 3e-7, "x"), 3e-8);
	assert.equal(projectionPrice(null, 3e-7, "x"), 3e-7);
	assert.throws(() => projectionPrice(null, null, "chat_input"), /catalog_price_missing:chat_input/);
	assert.throws(() => projectionPrice(Number.NaN, 0, "chat_output"), /catalog_price_missing/);
	const ledger = createLedger({});
	assert.throws(() => ledger.configureCell("c1", { usdCap: Number.NaN }), /invalid_usdCap/);
	assert.throws(() => ledger.configureCell("c1", { usdCap: 0.06, turnCap: Number.NaN }), /invalid_turnCap/);
	assert.doesNotThrow(() => ledger.configureCell("c1", { usdCap: 0.06, turnCap: 16 }));
});

test("paid pre-manifest steps require the S0 harness", () => {
	const runDir = tmp("jexp-s0bind-");
	assert.throws(() => requireS0Harness(runDir), /s0_pass_missing/);
	writeFileSync(path.join(runDir, "s0-pass.json"), JSON.stringify({ pass: true, harnessDigest: "0".repeat(64) }));
	assert.throws(() => requireS0Harness(runDir), /harness_changed_since_s0/);
	writeFileSync(path.join(runDir, "s0-pass.json"), JSON.stringify({ pass: false, harnessDigest: harnessDigest().digest }));
	assert.throws(() => requireS0Harness(runDir), /harness_changed_since_s0/);
	writeFileSync(path.join(runDir, "s0-pass.json"), JSON.stringify({ pass: true, harnessDigest: harnessDigest().digest }));
	assert.equal(requireS0Harness(runDir), harnessDigest().digest);
});

const cell = (over) => ({ stage: "S3", split: "holdout", taskId: "t1", condition: "a1-off", repeat: 1, status: "ok", success: 1, wasteTurns: 1, sessionUsd: 0.01, jevUsd: 0, wallMs: 1000, tokens: 10, triggerCount: 0, adviceCount: 0, ignoredAdvice: 0, falseStop: 0, falseProceed: 0, labelChecks: 0, labelCorrect: 0, appendTokens: 0, harnessSignals: 0, ...over });

test("analyzer counts every imputed metric instead of defaulting silently", () => {
	const { imputed, observations } = normalizeRecords([cell({}), cell({ repeat: 2, wallMs: undefined, labelChecks: undefined })]);
	assert.equal(imputed.metrics_imputed, 1);
	const row = observations.find((entry) => entry.code === "metric_imputed");
	assert.deepEqual(row.detail.fields.sort(), ["labelChecks", "wallMs"]);
});

test("C3 jev cost per absorbed turn is not evaluable when the winner absorbed none", () => {
	const records = [];
	for (const taskId of ["lane-start-base", "no-invented-cap", "retry-until-cap", "review-rounds", "size-read", "skipped-not-started"]) {
		for (let repeat = 1; repeat <= 3; repeat++) {
			// The winner passes S1 on cost alone (same waste as baseline), so it absorbs 0 waste turns.
			records.push(cell({ stage: "S1", split: "dev", taskId, condition: "a1-off", repeat, wasteTurns: 1, sessionUsd: 0.02 }));
			records.push(cell({ stage: "S1", split: "dev", taskId, condition: "de-error", repeat, wasteTurns: 1, jevUsd: 0.0001, triggerCount: 1, adviceCount: 1 }));
			records.push(cell({ stage: "S1", split: "dev", taskId, condition: "bp-periodic", repeat, wasteTurns: 1, jevUsd: 0.0001, triggerCount: 1, adviceCount: 1 }));
			records.push(cell({ stage: "S2", split: "dev", taskId, condition: "c3-ensemble", repeat, wasteTurns: 0, jevUsd: 0.0001, triggerCount: 1, adviceCount: 1 }));
		}
	}
	const s1 = analyzeS1(records, { j0: { agreementErrorRate: 0, bothWrongHighConfidence: 0 } });
	assert.equal(s1.winner, "de-error");
	assert.equal(s1.c3ToFz.winner.jevUsdPerAbsorbedTurn, null);
	assert.equal(s1.c3ToFz.conditions.jevPerAbsorbedTurnOk, false, "a non-positive winner denominator cannot pass the cost condition");
	assert.equal(s1.c3ToFz.becomeFz, false);
	assert.equal(s1.c3ToFz.reason, "jev_cost_not_evaluable");
	assert.ok(s1.observations.some((entry) => entry.code === "c3_cost_not_evaluable"));
});

test("X4 records a not-applicable ignoredAdvice limb when no advice was appended", () => {
	const records = [];
	for (const taskId of ["claim-evidence", "cost-arith", "destructive-gate", "lifecycle-records", "merge-conflict", "scope-stop"]) {
		for (let repeat = 1; repeat <= 3; repeat++) {
			records.push(cell({ taskId, repeat }));
			records.push(cell({ taskId, repeat, condition: "fz-frozen", triggerCount: 1 }));
		}
	}
	const analysis = analyzeFinal({ records, j0: { agreementErrorRate: 0, bothWrongHighConfidence: 0 }, devCondition: "de-error" });
	assert.equal(analysis.rules.X4.detail.ignoredLimbApplicable, false);
	assert.ok(analysis.observations.some((entry) => entry.code === "x4_ignored_advice_not_applicable"));
});

test("stage receipts validate a full cohort and refuse a cell without an oracle digest", () => {
	const manifest = { harnessDigest: "a".repeat(64), manifestId: "jjo2329-test" };
	const readiness = { originMain: "5f0652e8f50c16795f303357acb62570c782daa0" };
	const stageTimes = { S1: "2026-11-14T10:00:00Z", S2: "2026-11-14T10:10:00Z", S3: "2026-11-14T10:20:00Z" };
	let n = 0;
	const records = ["S1", "S2", "S3"].flatMap((stage) => stagePlan(stage).map((planned) => ({ ...cell({}), ...planned, stage, oracleDigest: (n++).toString(16).padStart(64, "0") })));
	const out = stageReceipts({ records, manifest, readiness, stageTimes, manifestDigest: "c".repeat(64) });
	assert.equal(out.S1.validation.valid, 54);
	assert.equal(out.S3.validation.conflictingDuplicates, 0);
	records[0].oracleDigest = "not-a-digest";
	assert.throws(() => stageReceipts({ records, manifest, readiness, stageTimes, manifestDigest: "c".repeat(64) }), /oracle evidence digest/);
});

test("ensemble sensitivity: an unnormalized voter abstains under the frozen rule but not voter-level", () => {
	const cases = [{ id: "c1", family: "error_repeat", label: "yes" }];
	const row = (model, over) => ({ caseId: "c1", model, order: "canonical", repeat: 1, status: "decided", choice: "yes", confidence: 0.9, reason: null, ...over });
	const rows = [row("sionic-ai/jev-omni"), row("sionic-ai/decider-4b", { status: "no_decision", reason: "unnormalized_probabilities", choice: null, confidence: null })];
	const result = ensembleSensitivity(rows, cases).variants;
	assert.equal(result.primary_override.abstainRate.value, 1);
	assert.equal(result.voter_level_unnormalized.accuracy.value, 1);
	assert.equal(result.single_primary.accuracy.value, 1);
});

test("Monte Carlo A3 is deterministic and digest-bound", () => {
	const first = monteCarloWithDigest();
	assert.equal(first.digest, monteCarloWithDigest().digest);
	assert.equal(first.rows.length, 5);
});

test("score-cell fails a cell whose audit log has an unparsable line", () => {
	const root = tmp("jexp-audit-");
	const taskDir = path.join(ROOT, "fixtures", "tasks", "skipped-not-started");
	const work = path.join(root, "mount", "work");
	mkdirSync(work, { recursive: true });
	cpSync(path.join(taskDir, "seed"), work, { recursive: true });
	const transcript = path.join(root, "transcript.jsonl");
	writeFileSync(transcript, `${JSON.stringify({ type: "agent_end", messages: [{ role: "assistant", content: [{ type: "text", text: "status: skipped 이므로 디스패치하지 않았습니다." }] }] })}\n`);
	const audit = path.join(root, "mount", "audit.jsonl");
	const score = () => JSON.parse(spawnSync(process.execPath, [path.join(ROOT, "scripts", "score-cell.mjs"), taskDir, work, transcript, audit], { encoding: "utf8" }).stdout);
	writeFileSync(audit, "");
	const clean = score();
	writeFileSync(audit, '{"stub":"dispatch","argv":["architect"]\n');
	const corrupted = score();
	assert.equal(corrupted.score, 0);
	assert.equal(corrupted.auditParseErrors, 1);
	assert.equal(corrupted.checks.find((check) => check.id === "audit-intact").pass, false);
	assert.equal(clean.checks.find((check) => check.id === "audit-intact").pass, true);
	assert.ok(readFileSync(audit, "utf8").length > 0);
});
