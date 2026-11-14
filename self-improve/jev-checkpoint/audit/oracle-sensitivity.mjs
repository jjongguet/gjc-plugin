#!/usr/bin/env node
/**
 * Report-only sensitivity: recompute the final analysis with the scores of the
 * current (post-review) oracles from rescore-sandboxed.json. The pre-registered
 * verdict in analysis.json is not replaced; this answers whether the oracle fix
 * would have changed it.
 *   node self-improve/jev-checkpoint/audit/oracle-sensitivity.mjs --run-dir <dir> --rescore <file> --out <file>
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { analyzeFinal, analyzeS1 } from "../lib/analyze.mjs";
import { parseTranscript } from "../lib/transcript.mjs";
import { wasteTags } from "../lib/metrics.mjs";
import { HARNESS_ROOT } from "../lib/runner.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const runDir = path.resolve(arg("run-dir") ?? "");
const rescore = JSON.parse(readFileSync(path.resolve(arg("rescore") ?? ""), "utf8"));
const out = arg("out");
const successOf = (score) => (score === 2 ? 1 : score === 1 ? 0.5 : 0);
const key = (row) => `${row.stage}|${row.taskId}|${row.condition}|${row.repeat}`;
const current = new Map(rescore.rows.map((row) => [key(row), row.currentSandboxed]));
const records = [];
const wasteChanges = [];
for (const stage of ["S1", "S2", "S3"]) {
	const file = path.join(runDir, stage, "results.jsonl");
	if (!existsSync(file)) continue;
	for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
		const record = JSON.parse(line);
		if (record.status === "ok") {
			const score = current.get(key(record));
			// Waste is recomputed with the current task spec (e.g. the merge-conflict completion boundary).
			const spec = JSON.parse(readFileSync(path.join(HARNESS_ROOT, "fixtures", "tasks", record.taskId, "spec.json"), "utf8"));
			const parsed = parseTranscript(readFileSync(path.join(runDir, stage, "cells", record.cellId, "transcript.jsonl"), "utf8"));
			const wasteTurns = wasteTags(spec, parsed.toolCalls).filter(Boolean).length;
			if (wasteTurns !== record.wasteTurns) wasteChanges.push({ stage, taskId: record.taskId, condition: record.condition, repeat: record.repeat, recorded: record.wasteTurns, current: wasteTurns });
			records.push({ ...record, score, success: successOf(score), wasteTurns });
		} else records.push(record);
	}
}
const manifest = JSON.parse(readFileSync(path.join(runDir, "manifest.json"), "utf8"));
const fz = JSON.parse(readFileSync(path.join(runDir, "fz-freeze.json"), "utf8"));
const gate = manifest.j0.p1Gate;
const analysis = analyzeFinal({ records, j0: { agreementErrorRate: gate.agreementErrorRate.value, bothWrongHighConfidence: gate.bothWrongHighConfidence.value }, devCondition: fz.fzCondition });
const s1 = analyzeS1(records.filter((record) => record.stage === "S1" || record.stage === "S2"), { j0: { agreementErrorRate: gate.agreementErrorRate.value, bothWrongHighConfidence: gate.bothWrongHighConfidence.value } });
const pick = (id) => ({ value: analysis.rules[id]?.value, passed: analysis.rules[id]?.passed ?? null, fired: analysis.rules[id]?.fired ?? null });
const receipt = { schema: "jexp.oracle_sensitivity.v1", at: new Date().toISOString(), reportOnly: true, changedCells: rescore.currentOracleChanges, wasteChanges, s1: { winner: s1.winner, winnerReason: s1.winnerReason, c3ToFz: s1.c3ToFz?.reason ?? null, candidates: s1.candidates.map((candidate) => ({ condition: candidate.condition, passed: candidate.passed, worseTasks: candidate.worseTasks, wasteMedian: candidate.waste.median })) }, verdict: analysis.verdict, branch: analysis.branch, rules: Object.fromEntries(["A1", "A2", "A3", "A4", "X1", "X2", "X3", "X6"].map((id) => [id, pick(id)])) };
writeFileSync(out, JSON.stringify(receipt, null, 2));
process.stdout.write(`sensitivity verdict=${receipt.verdict} branch=${receipt.branch} changed=${receipt.changedCells.length}\n`);
