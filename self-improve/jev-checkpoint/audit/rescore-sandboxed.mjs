#!/usr/bin/env node
/**
 * Post-review re-scoring of a finished run under the sandboxed scorer
 * (PR #67 review: oracles execute cell-written code). Read-only over the run.
 *   node self-improve/jev-checkpoint/audit/rescore-sandboxed.mjs --run-dir <dir> --frozen-harness <dir> --out <file>
 *
 * For every paid cell (S1–S3) it scores twice under the deny-all scorer
 * profile: with the frozen fixture oracles of the measured run (must equal the
 * recorded score — proves the sandbox changes nothing and no cell needed to
 * escape) and with the current oracles (sensitivity for oracle fixes made after
 * the run). The frozen verdict is not recomputed here.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { HARNESS_ROOT, scoreCell } from "../lib/runner.mjs";

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; };
const runDir = path.resolve(arg("run-dir") ?? "");
const frozenHarness = path.resolve(arg("frozen-harness") ?? "");
const out = arg("out");
if (!arg("run-dir") || !arg("frozen-harness") || !out) { process.stderr.write("usage: rescore-sandboxed.mjs --run-dir <dir> --frozen-harness <dir> --out <file>\n"); process.exit(2); }

const rows = [];
for (const stage of ["S1", "S2", "S3"]) {
	const file = path.join(runDir, stage, "results.jsonl");
	if (!existsSync(file)) continue;
	for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
		const record = JSON.parse(line);
		const cell = path.join(runDir, stage, "cells", record.cellId);
		const args = { workDir: path.join(cell, "mount", "work"), transcriptPath: path.join(cell, "transcript.jsonl"), auditPath: path.join(cell, "mount", "audit.jsonl") };
		const frozen = scoreCell({ ...args, taskDir: path.join(frozenHarness, "fixtures", "tasks", record.taskId), harnessRoot: frozenHarness });
		const current = scoreCell({ ...args, taskDir: path.join(HARNESS_ROOT, "fixtures", "tasks", record.taskId), harnessRoot: HARNESS_ROOT });
		rows.push({ stage, taskId: record.taskId, condition: record.condition, repeat: record.repeat, status: record.status, recorded: record.score, frozenSandboxed: frozen.score, currentSandboxed: current.score });
	}
}
const receipt = {
	schema: "jexp.rescore_sandboxed.v1",
	at: new Date().toISOString(),
	cells: rows.length,
	// Failed cells carry the F4-imputed score 0 whatever the oracle says, so only ok cells are comparable.
	comparedOkCells: rows.filter((row) => row.status === "ok").length,
	frozenMismatches: rows.filter((row) => row.status === "ok" && row.frozenSandboxed !== row.recorded).length,
	currentOracleChanges: rows.filter((row) => row.status === "ok" && row.currentSandboxed !== row.recorded).map((row) => ({ stage: row.stage, taskId: row.taskId, condition: row.condition, repeat: row.repeat, recorded: row.recorded, current: row.currentSandboxed })),
	rows,
};
writeFileSync(out, JSON.stringify(receipt, null, 2));
process.stdout.write(`cells=${receipt.cells} okCompared=${receipt.comparedOkCells} frozenMismatches=${receipt.frozenMismatches} currentOracleChanges=${receipt.currentOracleChanges.length}\n`);
