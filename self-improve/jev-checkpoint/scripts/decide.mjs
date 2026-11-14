#!/usr/bin/env node
/**
 * Frozen decisions between and after the paid stages.
 *   node self-improve/jev-checkpoint/scripts/decide.mjs --run-dir <dir> --phase s1|fz|final
 *
 * s1:    F5 over S1 → s1-decision.json (winner, its trigger, whether S2 runs).
 * fz:    F5 with S2 → fz-freeze.json (C3 or the S1 winner becomes Fz) before S3.
 * final: analyzeFinal over S1–S3 → analysis.json, arm-table.md, summary.json.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeFinal, analyzeS1, POWER_GATE, ruleTableDigest } from "../lib/analyze.mjs";
import { nRequired } from "../lib/power.mjs";
import { spendTable, priorSpend } from "../lib/ledger-journal.mjs";
import { stagePlan } from "../lib/stage-plans.mjs";
import { stageReceipts } from "../lib/receipts.mjs";
import { analyzerDigest, harnessDigest } from "../lib/digest.mjs";

const readJsonl = (file) => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const read = (runDir, name) => JSON.parse(readFileSync(path.join(runDir, name), "utf8"));
const TRIGGER_OF = Object.freeze({ "bp-periodic": "periodic", "de-error": "error" });
const CONFIG_OF = Object.freeze({ "bp-periodic": { mode: "periodic" }, "de-error": { mode: "error" } });

function p1Input(manifest) {
	const gate = manifest.j0.p1Gate;
	return { agreementErrorRate: gate.agreementErrorRate.value, bothWrongHighConfidence: gate.bothWrongHighConfidence.value };
}

function stageRecords(runDir, stage) {
	return readJsonl(path.join(runDir, stage, "results.jsonl"));
}

const fmt = (value, digits = 4) => (value === null || value === undefined || !Number.isFinite(value) ? "—" : Number(value).toFixed(digits));

/** Per-arm metric table: the issue's 8 metrics plus no-decision, false-stop and imputation columns. */
export function armTable(records, w) {
	const groups = new Map();
	for (const record of records) {
		const key = `${record.stage}|${record.split}|${record.condition}`;
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(record);
	}
	const lines = [
		"| stage | split | condition | cells ok/failed/not_run | success (mean) | wasteTurns (mean) | toolCalls (mean) | tokens (mean) | sessionUsd (sum) | wall s (mean) | jevUsd (sum) | 오판 falseStop/falseProceed | labelCorrect/labelChecks | noDecision | expectedStallMinutes (assumption: falseStops × W, W = lower-bound median; report-only) | waste_error_imputed |",
		"|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
	];
	for (const [key, list] of [...groups.entries()].sort()) {
		const [stage, split, condition] = key.split("|");
		const ran = list.filter((record) => record.status !== "not_run");
		// Means over recorded values only; a missing value is never averaged in as 0.
		const mean = (field) => {
			const values = ran.map((record) => record[field]).filter((value) => Number.isFinite(value));
			return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
		};
		const sum = (field) => list.reduce((total, record) => total + (Number.isFinite(record[field]) ? record[field] : 0), 0);
		const noDecision = {};
		for (const record of list) for (const [reason, count] of Object.entries(record.noDecision ?? {})) noDecision[reason] = (noDecision[reason] ?? 0) + count;
		const falseStops = sum("falseStop");
		const stall = w?.estimated ? `${falseStops}×${w.medianMinutes}=${falseStops * w.medianMinutes}m` : `${falseStops}×{15,60,240}m (가정값, W 미추정)`;
		lines.push(`| ${stage} | ${split} | ${condition} | ${list.filter((r) => r.status === "ok").length}/${list.filter((r) => r.status === "failed").length}/${list.filter((r) => r.status === "not_run").length} | ${fmt(mean("success"), 3)} | ${fmt(mean("wasteTurns"), 2)} | ${fmt(mean("toolCalls"), 2)} | ${fmt(mean("tokens"), 0)} | ${fmt(sum("sessionUsd"), 5)} | ${fmt((mean("wallMs") ?? 0) / 1000, 1)} | ${fmt(sum("jevUsd"), 6)} | ${falseStops}/${sum("falseProceed")} | ${sum("labelCorrect")}/${sum("labelChecks")} | ${Object.entries(noDecision).map(([reason, count]) => `${reason}:${count}`).join(", ") || "—"} | ${stall} | ${list.filter((r) => r.imputed).length} |`);
	}
	return lines.join("\n");
}

/**
 * Every planned (task, condition, repeat) of the given stages must have a record;
 * an interrupted stage that left neither stop.json nor not_run rows is still
 * incomplete and maps to early termination, never to a definitive verdict.
 */
/** AC14/AC18: write validated per-stage receipts; throws when the validator rejects any. */
export function writeStageReceipts(runDir, records) {
	const manifestText = readFileSync(path.join(runDir, "manifest.json"), "utf8");
	const stageTimes = Object.fromEntries(["S1", "S2", "S3"].map((stage) => [stage, read(runDir, `${stage}/summary.json`).at ?? statSync(path.join(runDir, stage, "results.jsonl")).mtime.toISOString()]));
	const out = stageReceipts({ records, manifest: JSON.parse(manifestText), readiness: read(runDir, "readiness.json"), stageTimes, manifestDigest: createHash("sha256").update(manifestText).digest("hex") });
	mkdirSync(path.join(runDir, "receipts"), { recursive: true });
	const validation = {};
	for (const [stage, entry] of Object.entries(out)) {
		writeFileSync(path.join(runDir, "receipts", `${stage}.jsonl`), entry.receipts.map((receipt) => JSON.stringify(receipt)).join("\n") + "\n");
		validation[stage] = { ...entry.validation, skippedNotRun: entry.skipped.length };
	}
	writeFileSync(path.join(runDir, "receipts", "validation.json"), JSON.stringify({ schema: "jexp.receipts_validation.v1", validator: "gjc.quality_trial.v2", stages: validation }, null, 2));
	return validation;
}

export function cohortCompleteness(records, stages) {
	const counts = new Map();
	for (const record of records) {
		const key = `${record.stage}|${record.taskId}|${record.condition}|${record.repeat}`;
		counts.set(key, (counts.get(key) ?? 0) + 1);
	}
	const missing = [];
	for (const stage of stages) for (const cell of stagePlan(stage)) if (!counts.has(`${stage}|${cell.taskId}|${cell.condition}|${cell.repeat}`)) missing.push({ stage, taskId: cell.taskId, condition: cell.condition, repeat: cell.repeat });
	// A duplicated execution would be averaged into the task mean, so it is not a complete cohort either.
	const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
	return { complete: missing.length === 0 && duplicates.length === 0, missing, duplicates };
}

function arg(name, fallback = null) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const runDir = path.resolve(arg("run-dir") ?? "");
	const phase = arg("phase");
	if (!arg("run-dir") || !["s1", "fz", "final"].includes(phase)) { process.stderr.write("usage: decide.mjs --run-dir <dir> --phase s1|fz|final\n"); process.exit(2); }
	const manifest = read(runDir, "manifest.json");
	if (manifest.analyzerDigest !== analyzerDigest() || manifest.ruleTableDigest !== ruleTableDigest()) throw new Error("analyzer_changed_since_freeze");
	if (manifest.harnessDigest !== harnessDigest().digest) throw new Error("harness_changed_since_freeze");
	const j0 = p1Input(manifest);
	if (phase === "s1") {
		const s1 = analyzeS1(stageRecords(runDir, "S1"), { j0 });
		const stopped = existsSync(path.join(runDir, "stop.json"));
		const decision = { schema: "jexp.s1_decision.v1", at: new Date().toISOString(), winner: s1.winner, winnerReason: s1.winnerReason, winnerTrigger: s1.winner ? TRIGGER_OF[s1.winner] : null, runS2: Boolean(s1.winner) && !stopped, stopped, analysis: s1 };
		writeFileSync(path.join(runDir, "s1-decision.json"), JSON.stringify(decision, null, 2));
		process.stdout.write(`S1 winner=${s1.winner} reason=${s1.winnerReason} runS2=${decision.runS2}\n`);
	} else if (phase === "fz") {
		const decision = read(runDir, "s1-decision.json");
		if (!decision.winner) throw new Error("no_s1_winner");
		const s12 = analyzeS1([...stageRecords(runDir, "S1"), ...stageRecords(runDir, "S2")], { j0 });
		const becomeFz = Boolean(s12.c3ToFz?.becomeFz);
		const fz = { schema: "jexp.fz_freeze.v1", at: new Date().toISOString(), fzCondition: becomeFz ? "c3-ensemble" : decision.winner, config: becomeFz ? { mode: "ensemble", trigger: decision.winnerTrigger } : CONFIG_OF[decision.winner], c3ToFz: s12.c3ToFz, manifestId: manifest.manifestId };
		writeFileSync(path.join(runDir, "fz-freeze.json"), JSON.stringify(fz, null, 2));
		process.stdout.write(`Fz=${fz.fzCondition} config=${JSON.stringify(fz.config)} c3=${s12.c3ToFz?.reason}\n`);
	} else {
		const records = ["S1", "S2", "S3"].flatMap((stage) => stageRecords(runDir, stage));
		const decision = existsSync(path.join(runDir, "s1-decision.json")) ? read(runDir, "s1-decision.json") : null;
		const stopped = existsSync(path.join(runDir, "stop.json"));
		let analysis;
		if (!decision?.winner || stageRecords(runDir, "S3").length === 0) {
			// F3 branch 5 / early termination: no Fz on holdout → insufficient, observations kept.
			analysis = { verdict: "insufficient → 현행 유지", branch: !decision?.winner ? "no_s1_winner" : "early_termination", s1: decision?.analysis ?? null, powerGate: POWER_GATE, stopped };
		} else {
			const fz = read(runDir, "fz-freeze.json");
			// X2's dev half compares the same mechanism that became Fz.
			const cohort = cohortCompleteness(records, ["S1", ...(decision.runS2 ? ["S2"] : []), "S3"]);
			const termination = stopped ? { terminated: true, reason: "global_stop" } : !cohort.complete ? { terminated: true, reason: cohort.duplicates.length ? "duplicate_executions" : "incomplete_cohort" } : null;
			analysis = analyzeFinal({ records, j0, devCondition: fz.fzCondition, termination });
			analysis.cohort = { complete: cohort.complete, missing: cohort.missing.length, duplicates: cohort.duplicates.length };
			analysis.powerGate = POWER_GATE;
		}
		const devBaseline = records.filter((record) => record.stage === "S1" && record.condition === "a1-off" && record.status === "ok").map((record) => record.wasteTurns);
		const sd = (() => { if (devBaseline.length < 2) return null; const mean = devBaseline.reduce((a, b) => a + b, 0) / devBaseline.length; return Math.sqrt(devBaseline.reduce((acc, value) => acc + (value - mean) ** 2, 0) / (devBaseline.length - 1)); })();
		const meanBaselineWaste = devBaseline.length ? devBaseline.reduce((a, b) => a + b, 0) / devBaseline.length : null;
		analysis.postS1Power = { reportOnly: true, sigmaWasteTurns: sd, delta: meanBaselineWaste !== null ? 0.2 * meanBaselineWaste : null, nRequired: sd && meanBaselineWaste ? nRequired({ sigma: sd, delta: Math.max(1e-9, 0.2 * meanBaselineWaste) }) : null, formula: "ceil((z0.95+z0.80)^2 σ^2 / Δ^2), Δ = 20% of the dev baseline waste mean" };
		analysis.receipts = writeStageReceipts(runDir, records);
		writeFileSync(path.join(runDir, "analysis.json"), JSON.stringify(analysis, null, 2));
		const w = read(runDir, "j0-test.json").w;
		writeFileSync(path.join(runDir, "arm-table.md"), `${armTable(records, w)}\n`);
		const spend = spendTable(path.join(runDir, "ledger.jsonl"));
		const summary = { schema: "jexp.summary.v1", at: new Date().toISOString(), manifestId: manifest.manifestId, verdict: analysis.verdict, branch: analysis.branch ?? null, cells: records.length, statusCounts: records.reduce((acc, record) => { const key = `${record.stage}:${record.status}${record.errorClass ? `/${record.errorClass}` : ""}`; acc[key] = (acc[key] ?? 0) + 1; return acc; }, {}), spendByStageKindBasis: spend, totalSpentUsd: priorSpend(path.join(runDir, "ledger.jsonl")), priorExternalUsd: manifest.priorExternalUsd, stopped };
		writeFileSync(path.join(runDir, "summary.json"), JSON.stringify(summary, null, 2));
		process.stdout.write(`verdict=${analysis.verdict} branch=${analysis.branch ?? "-"} spent=${summary.totalSpentUsd.toFixed(5)}\n`);
	}
}
