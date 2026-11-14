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
import { freeze, monteCarloWithDigest, projectCost, projectionPrice } from "../../scripts/freeze.mjs";
import { loadCases } from "../../lib/judge.mjs";
import { FIXTURES_DIR } from "../../scripts/stage.mjs";
import { stageFinishedAt, writeStageReceipts } from "../../scripts/decide.mjs";
import { requireCompleteW } from "../../scripts/j0.mjs";
import { BUNDLES, runStageCli } from "../../scripts/stage.mjs";
import { analyzerDigest, bundleDigest } from "../../lib/digest.mjs";
import { ruleTableDigest } from "../../lib/analyze.mjs";
import { cellMetrics } from "../../lib/metrics.mjs";
import { CHECKPOINT_STATE_LIMIT } from "../../lib/proxy.mjs";
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
	assert.equal(out.S1.validation.batches, 3, "one B0/B1 batch per condition");
	assert.equal(out.S3.validation.valid, 36);
	// A second execution of one cell with a different outcome is a conflicting duplicate and throws.
	const conflicting = [...records, { ...records.at(-1), success: 0, score: 0 }];
	assert.throws(() => stageReceipts({ records: conflicting, manifest, readiness, stageTimes, manifestDigest: "c".repeat(64) }), /conflicts=1/);
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

test("receipts are written only for stages that ran, dated from recorded run data", () => {
	const runDir = tmp("jexp-rcpt-s1-");
	writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ harnessDigest: "a".repeat(64), manifestId: "jjo2329-test" }));
	writeFileSync(path.join(runDir, "readiness.json"), JSON.stringify({ originMain: "5f0652e8f50c16795f303357acb62570c782daa0" }));
	mkdirSync(path.join(runDir, "S1"));
	writeFileSync(path.join(runDir, "S1", "summary.json"), JSON.stringify({ stage: "S1" }));
	let n = 0;
	const records = stagePlan("S1").map((planned) => ({ ...cell({}), ...planned, stage: "S1", oracleDigest: (n++).toString(16).padStart(64, "0") }));
	assert.throws(() => writeStageReceipts(runDir, records), /stage_time_unrecorded:S1/);
	writeFileSync(path.join(runDir, "ledger.jsonl"), `${JSON.stringify({ at: "2026-11-14T10:05:00.000Z", stage: "S1", kind: "settled" })}\n${JSON.stringify({ at: "2026-11-14T10:09:00.000Z", stage: "S1", kind: "settled" })}\n`);
	assert.equal(stageFinishedAt(runDir, "S1"), "2026-11-14T10:09:00.000Z");
	const validation = writeStageReceipts(runDir, records);
	assert.deepEqual(Object.keys(validation), ["S1"], "S2/S3 never ran, so no receipts and no summary reads for them");
	assert.equal(validation.S1.valid, 54);
	writeFileSync(path.join(runDir, "S1", "summary.json"), JSON.stringify({ stage: "S1", at: "2026-11-14T10:10:00.000Z" }));
	assert.equal(stageFinishedAt(runDir, "S1"), "2026-11-14T10:10:00.000Z");
});

test("J0-test refuses a missing or incomplete W receipt (checked before any spend)", () => {
	const runDir = tmp("jexp-w-");
	assert.throws(() => requireCompleteW(runDir), /w_intervals_missing/);
	writeFileSync(path.join(runDir, "w-intervals.json"), JSON.stringify({ complete: false, intervals: [] }));
	assert.throws(() => requireCompleteW(runDir), /w_intervals_incomplete/);
	writeFileSync(path.join(runDir, "w-intervals.json"), JSON.stringify({ complete: true, intervals: [] }));
	assert.equal(requireCompleteW(runDir).complete, true);
	// Anchored on the call site in the test phase, not the declaration.
	const source = readFileSync(path.join(ROOT, "scripts", "j0.mjs"), "utf8");
	const testPhase = source.slice(source.indexOf('const dev = JSON.parse(readFileSync(path.join(runDir, "j0-dev.json")'));
	const call = testPhase.indexOf("estimateW(requireCompleteW(runDir)");
	assert.ok(call > 0 && call < testPhase.indexOf("await runPlan("), "the W check precedes the paid J0-test run");
});

test("X5 signal 2: fires at >= 0.10 of session tokens, not below, and counts unmeasured usage", () => {
	const parsed = (advice) => ({ turns: 2, toolCalls: [{ name: "bash", args: { command: "ls" }, advice: advice ? { text: "x".repeat(advice) } : null }] });
	const spec = { lastRequiredCall: null, allowedTaskCalls: 0 };
	const rows = (tokens) => [{ kind: "chat", inputTokens: tokens, outputTokens: 0, requestBytes: 4 * tokens, costUsd: 0 }];
	const fires = cellMetrics({ parsed: parsed(400), spec, chatRows: rows(900) });
	assert.equal(fires.appendTokenRatio, 100 / 900);
	assert.equal(fires.harnessSignals, 1);
	const quiet = cellMetrics({ parsed: parsed(40), spec, chatRows: rows(900) });
	assert.equal(quiet.harnessSignals, 0);
	const unmeasured = cellMetrics({ parsed: parsed(40), spec, chatRows: [{ kind: "chat", inputTokens: null, outputTokens: null, requestBytes: 3600, costUsd: 0 }] });
	assert.equal(unmeasured.appendTokenRatioMeasured, false);
	assert.equal(unmeasured.appendTokenRatio, null);
	assert.equal(unmeasured.harnessSignals, 1, "unmeasured usage with appended advice counts toward the rejection rule");
	const none = cellMetrics({ parsed: parsed(0), spec, chatRows: [] });
	assert.equal(none.appendTokenRatioMeasured, true);
	assert.equal(none.harnessSignals, 0);
});

test("start-gate projection refuses missing rows, missing calibration and non-finite or over-gate results", () => {
	const chat = { observedInputPricePerToken: 3e-8, listInputPricePerToken: 3e-7, observedOutputPricePerToken: 1.2e-7, listOutputPricePerToken: 1.2e-6 };
	const rows = [{ cellId: "c1", requestBytes: 40000 }, { cellId: "c1", requestBytes: 50000 }, { cellId: "c2", requestBytes: 30000 }];
	const ok = projectCost({ s0ChatRows: rows, bytesPerToken: 4, chat, spentSoFar: 0.02, paidCells: 108 });
	assert.ok(Number.isFinite(ok.projectedUsd) && ok.projectedUsd < 3.4 && ok.cellUsdCap >= 0.06);
	assert.throws(() => projectCost({ s0ChatRows: [], bytesPerToken: 4, chat, spentSoFar: 0, paidCells: 108 }), /s0_chat_rows_missing/);
	assert.throws(() => projectCost({ s0ChatRows: rows, bytesPerToken: 0, chat, spentSoFar: 0, paidCells: 108 }), /l0_bytes_per_token_missing/);
	assert.throws(() => projectCost({ s0ChatRows: rows, bytesPerToken: 4, chat, spentSoFar: Number.NaN, paidCells: 108 }), /projection_over_start_gate:NaN/);
	assert.throws(() => projectCost({ s0ChatRows: rows, bytesPerToken: 4, chat, spentSoFar: 3.39, paidCells: 108 }), /projection_over_start_gate/);
});

test("a live stage refuses a manifest without a finite priorExternalUsd before reading any key", async () => {
	const runDir = tmp("jexp-prior-");
	const { harnessDigest: current } = await import("../../lib/digest.mjs");
	const base = { harnessDigest: current().digest, analyzerDigest: analyzerDigest(), ruleTableDigest: ruleTableDigest(), bundles: Object.fromEntries(Object.entries(BUNDLES).map(([name, dir]) => [name, bundleDigest(dir).digest])) };
	for (const prior of [undefined, null, Number.NaN, -1, "0.02"]) {
		writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ ...base, priorExternalUsd: prior }));
		await assert.rejects(runStageCli({ stage: "S1", runDir }), /invalid_manifest\.priorExternalUsd/);
	}
});

test("the proxy checkpoint state limit equals the plugin's state cap", () => {
	const core = readFileSync(path.join(ROOT, "plugin", "src", "core.ts"), "utf8");
	assert.equal(Number(/export const MAX_STATE_BYTES = (\d+);/.exec(core)?.[1]), CHECKPOINT_STATE_LIMIT);
});

test("a cell that failed before scoring gets a failure attestation receipt; an unscored ok cell is refused", () => {
	const manifest = { harnessDigest: "a".repeat(64), manifestId: "jjo2329-test" };
	const readiness = { originMain: "5f0652e8f50c16795f303357acb62570c782daa0" };
	const stageTimes = { S1: "2026-11-14T10:00:00Z" };
	let n = 0;
	const records = stagePlan("S1").map((planned) => ({ ...cell({}), ...planned, stage: "S1", cellId: `c${n}`, oracleDigest: (n++).toString(16).padStart(64, "0") }));
	records[0] = { ...records[0], status: "failed", errorClass: "setup", success: 0, score: 0, oracleDigest: undefined };
	const out = stageReceipts({ records, manifest, readiness, stageTimes, manifestDigest: "c".repeat(64) });
	assert.equal(out.S1.validation.valid, 54);
	const failed = out.S1.receipts.find((receipt) => receipt.trialId.endsWith(`${records[0].taskId}.r${records[0].repeat}`) && receipt.condition === records[0].condition);
	assert.equal(failed.outcome, "failed");
	assert.equal(failed.errorClass, "setup");
	records[0] = { ...records[0], status: "ok", success: 1, score: 2 };
	assert.throws(() => stageReceipts({ records, manifest, readiness, stageTimes, manifestDigest: "c".repeat(64) }), /oracle evidence digest/);
});

test("freeze() builds a manifest end to end from bound receipts and refuses an unbound one", () => {
	const runDir = tmp("jexp-freeze-e2e-");
	const current = harnessDigest().digest;
	const put = (name, value) => writeFileSync(path.join(runDir, name), typeof value === "string" ? value : JSON.stringify(value));
	put("s0-pass.json", { pass: true, harnessDigest: current });
	put("s0b-inertness.json", { pass: true, harnessDigest: current });
	put("readiness.json", { pass: true, originMain: "5f0652e8f50c16795f303357acb62570c782daa0", releaseTree: "ddd10a63", releaseSurface: "tag_tree" });
	const catalog = JSON.parse(readFileSync(path.join(ROOT, "..", "..", "docs", "plans", "JJO-2329-jev-checkpoint", "results", "catalog-latest.json"), "utf8"));
	put("catalog-latest.json", { ...catalog, observedAt: new Date().toISOString() });
	put("ledger-l0.json", { pass: true, harnessDigest: current, chat: { bytesPerToken: 4.07 }, upstreamMode: "B_stream_false_usage_include" });
	put("j0-dev.json", { harnessDigest: current, selection: { error_repeat: { wordingId: "W1" }, goal_state: { wordingId: "W2" } } });
	put("j0-test.json", { harnessDigest: current, w: { estimated: true, medianMinutes: 63 } });
	put("j0-labels.json", { harnessDigest: current, labelSheetDigest: "d".repeat(64) });
	const trialCase = loadCases(FIXTURES_DIR).find((entry) => entry.split === "test" && entry.family !== "destructive");
	const answer = { caseId: trialCase.id, order: "canonical", repeat: 1, status: "decided", choice: trialCase.label, confidence: 0.9 };
	put("j0-test-rows.jsonl", `${JSON.stringify({ ...answer, model: "sionic-ai/jev-omni" })}\n${JSON.stringify({ ...answer, model: "sionic-ai/decider-4b" })}\n`);
	mkdirSync(path.join(runDir, "S0"));
	put("S0/proxy-rows.jsonl", `${JSON.stringify({ kind: "chat", cellId: "c1", requestBytes: 40000 })}\n${JSON.stringify({ kind: "chat", cellId: "c2", requestBytes: 60000 })}\n`);
	const manifest = freeze(runDir);
	assert.equal(manifest.harnessDigest, current);
	assert.equal(manifest.l0.bytesPerToken, 4.07);
	assert.ok(Number.isFinite(manifest.cost.projectedUsd) && manifest.cost.projectedUsd <= 3.4);
	assert.match(manifest.power.monteCarloA3.digest, /^[a-f0-9]{64}$/);
	assert.equal(manifest.j0.p1Gate.c3Adoptable, true);
	put("j0-test.json", { harnessDigest: "0".repeat(64), w: {} });
	assert.throws(() => freeze(runDir), /receipt_not_bound_to_harness:j0-test\.json/);
});
