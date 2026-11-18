#!/usr/bin/env node
/**
 * $0 gate stages: S0 (18 scripted cells + 6 drills) and S0b (12 inertness cells).
 *   node self-improve/jev-checkpoint/scripts/s0.mjs --run-dir /tmp/jexp-<runId> [--only S0|S0b]
 * Writes run-dir/s0-pass.json and run-dir/s0b-inertness.json; both must be
 * `pass: true` before any paid stage (G0c, G2). No key is read; the proxy has
 * no upstream client.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runStageCli } from "./stage.mjs";
import { scriptedEnvelope } from "../lib/scripted.mjs";
import { createLedger } from "../lib/accounting.mjs";
import { startProxy } from "../lib/proxy.mjs";
import { SCRIPTED_QUESTIONS } from "./stage.mjs";
import { createScriptedChat, createScriptedDecision } from "../lib/scripted.mjs";
import { analyzeFinal } from "../lib/analyze.mjs";
import { harnessDigest } from "../lib/digest.mjs";

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/** Live process count, or null when pgrep itself failed (exit 2/3): unknown is never 0. */
function liveProcesses(marker) {
	const run = spawnSync("/usr/bin/pgrep", ["-f", marker], { encoding: "utf8" });
	if (run.status === 1) return 0;
	if (run.status === 0) return run.stdout.split("\n").filter(Boolean).length;
	return null;
}

function cellEnvKeysClean(stageDir) {
	// The child env is fixed by lib/cell.mjs; check the recorded profile receipts and transcripts for secret-like names.
	const cells = path.join(stageDir, "cells");
	if (!existsSync(cells)) return true;
	for (const id of readdirSync(cells)) {
		const transcript = path.join(cells, id, "transcript.jsonl");
		if (existsSync(transcript) && /opengateway-key|OPENROUTER_API_KEY|OPENGATEWAY_API_KEY/.test(readFileSync(transcript, "utf8"))) return false;
	}
	return true;
}

const checkpointRowsOf = (rows, cellId) => rows.filter((row) => row.kind === "checkpoint" && row.cellId === cellId);
const S0_EXPECTED_SCORE = 2;

async function runS0(runDir) {
	const checks = [];
	const check = (id, pass, detail = {}) => { checks.push({ id, pass: Boolean(pass), ...detail }); return Boolean(pass); };

	// Main 18 cells.
	const main = await runStageCli({ stage: "S0", runDir, label: "S0" });
	const byCondition = (condition) => main.results.filter((record) => record.condition === condition);
	check("s0_18_of_18_ok", main.results.length === 18 && main.results.every((record) => record.status === "ok"), { statusCounts: main.summary.statusCounts });
	check("s0_scores_scripted", main.results.every((record) => record.score === S0_EXPECTED_SCORE));
	check("s0_upstream_zero", main.summary.upstreamCalls === 0, { upstreamCalls: main.summary.upstreamCalls });
	check("s0_isolation_pass", main.results.every((record) => record.isolation?.status === "pass"));
	check("s0_off_no_checkpoint", byCondition("a1-off").every((record) => checkpointRowsOf(main.rows, record.cellId).length === 0 && record.adviceCount === 0));
	check("s0_periodic_fires_and_appends", byCondition("bp-periodic").every((record) => checkpointRowsOf(main.rows, record.cellId).length >= 1 && record.adviceCount >= 1));
	check("s0_error_fires_and_appends", byCondition("de-error").every((record) => checkpointRowsOf(main.rows, record.cellId).length >= 1 && record.adviceCount >= 1));
	check("s0_goal_from_branch", main.rows.filter((row) => row.kind === "checkpoint").every((row) => row.goalSource === "branch"));
	check("s0_plugins_loaded", main.results.every((record) => (record.plugins ?? []).some((plugin) => plugin.name === "jev-advisor") && (record.plugins ?? []).some((plugin) => plugin.name === "jev-checkpoint")));
	check("s0_tools_include_jev_check", main.rows.filter((row) => row.kind === "chat").every((row) => row.toolNames.includes("jev_check")));
	check("s0_no_key_in_child", cellEnvKeysClean(main.stageDir));
	check("s0_no_live_children", liveProcesses(realpathSync(main.stageDir)) === 0);
	// Negative control for the S0b normalization: it must not erase real differences.
	const digestsOf = (cellId) => main.rows.filter((row) => row.kind === "chat" && row.cellId === cellId).sort((a, b) => a.turn - b.turn).map((row) => row.normalizedDigest);
	const cellFor = (condition, taskId, repeat) => main.results.find((record) => record.condition === condition && record.taskId === taskId && record.repeat === repeat)?.cellId;
	const offA = digestsOf(cellFor("a1-off", "no-invented-cap", 1));
	check("s0_normalization_controls", JSON.stringify(offA) === JSON.stringify(digestsOf(cellFor("a1-off", "no-invented-cap", 2))) && JSON.stringify(offA) !== JSON.stringify(digestsOf(cellFor("bp-periodic", "no-invented-cap", 1))) && JSON.stringify(offA) !== JSON.stringify(digestsOf(cellFor("a1-off", "retry-until-cap", 1))));

	// Drill 1: per-cell USD cap only fails that cell.
	const capPlan = [0, 1, 2].map((index) => ({ stage: "S0", split: "dev", taskId: "no-invented-cap", condition: "bp-periodic", repeat: index + 1, usdCap: index === 0 ? 1e-7 : undefined }));
	const capRun = await runStageCli({ stage: "S0", runDir, label: "drill-cell-cap", plan: capPlan });
	check("drill1_cell_cap_isolated", capRun.results[0].status === "failed" && capRun.results[0].errorClass === "cell_cap" && capRun.results.slice(1).every((record) => record.status === "ok"), { statusCounts: capRun.summary.statusCounts });

	// Drill 2: global hard stop propagates (stop.json, upstream 0, children gone, not_run kept, insufficient).
	const stopPlan = [1, 2, 3, 4, 5, 6].map((repeat) => ({ stage: "S0", split: "dev", taskId: repeat % 2 ? "no-invented-cap" : "retry-until-cap", condition: "a1-off", repeat }));
	const stopRun = await runStageCli({ stage: "S0", runDir, label: "drill-global-stop", plan: stopPlan, ledgerOptions: { hardStopUsd: 0.004 } });
	const stopFile = path.join(stopRun.stageDir, "stop.json");
	const terminatedStatuses = stopRun.results.map((record) => `${record.status}/${record.errorClass}`);
	const partial = analyzeFinal({ records: stopRun.results.map((record) => ({ ...record, stage: "S3", split: "holdout" })), termination: { reason: "global_stop" } });
	check("drill2_global_stop", existsSync(stopFile) && stopRun.summary.stopped && stopRun.summary.upstreamCalls === 0 && stopRun.results.some((record) => record.status === "not_run" || record.errorClass === "global_stop") && liveProcesses(realpathSync(stopRun.stageDir)) === 0 && partial.verdict.startsWith("insufficient"), { terminatedStatuses, verdict: partial.verdict });

	// Drill 3: allowlist — a non-allowlisted model never reaches transport; a config naming models is refused by the plugin.
	const ledger = createLedger({});
	const proxy = await startProxy({ mode: "scripted", ledger, questionConfig: SCRIPTED_QUESTIONS, scriptedChat: createScriptedChat(), scriptedDecision: createScriptedDecision() });
	const reg = proxy.registerCell({ cellId: "d3d3d3d3d3d3d3d3d3d3d3d3", token: "t", checkpoint: { mode: "periodic", trigger: "periodic" }, usdCap: 1, turnCap: 16 });
	const post = async (body) => { const response = await fetch(reg.checkpointUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); return { status: response.status, json: await response.json() }; };
	const refusedOther = await post({ mode: "periodic", family: "goal_state", trigger: "periodic", callIndex: 8, models: ["typesafe/jev-1.14"], state: "Goal: x" });
	const refusedExtra = await post({ mode: "periodic", family: "goal_state", trigger: "periodic", callIndex: 8, models: ["sionic-ai/jev-omni", "sionic-ai/decider-4b"], state: "Goal: x" });
	const refusedMode = await post({ mode: "ensemble", family: "goal_state", trigger: "periodic", callIndex: 8, models: ["sionic-ai/jev-omni", "sionic-ai/decider-4b"], state: "Goal: x" });
	const transportAfterRefusals = proxy.decisionTransportCalls;
	await proxy.close();
	const badConfigRun = await runStageCli({ stage: "S0", runDir, label: "drill-allowlist", plan: [{ stage: "S0", split: "dev", taskId: "no-invented-cap", condition: "bp-periodic", repeat: 1, checkpointConfigOverride: { mode: "periodic", models: ["typesafe/jev-1.14"] } }] });
	check("drill3_allowlist", refusedOther.status === 403 && refusedOther.json.reason === "route_not_allowed" && refusedExtra.json.reason === "route_not_allowed" && refusedMode.json.reason === "mode_mismatch" && transportAfterRefusals === 0 && checkpointRowsOf(badConfigRun.rows, badConfigRun.results[0].cellId).length === 0 && badConfigRun.results[0].status === "ok");

	// Drill 4: ensemble — exactly 2 voter requests per invocation; an unnormalized voter forces abstain.
	const ensembleRun = await runStageCli({
		stage: "S0", runDir, label: "drill-ensemble",
		plan: [{ stage: "S0", split: "dev", taskId: "no-invented-cap", condition: "c3-ensemble", repeat: 1 }, { stage: "S0", split: "dev", taskId: "no-invented-cap", condition: "c3-ensemble", repeat: 2, drill: "aux_unnormalized" }],
		scriptedOverrides: ({ model, meta, body }) => (meta?.drill === "aux_unnormalized" && model === "sionic-ai/decider-4b" ? scriptedEnvelope(Object.keys(body.questions)[0], "off_track", { on_track: 0.1, off_track: 0.902 }, 0.8) : null),
	});
	const ensembleRows = ensembleRun.rows.filter((row) => row.kind === "checkpoint");
	const normalCell = ensembleRun.results[0].cellId;
	const drilledCell = ensembleRun.results[1].cellId;
	check("drill4_ensemble", ensembleRows.length >= 2 && ensembleRows.every((row) => row.voters.length === 2 && row.voters.filter((voter) => voter.transport).length === 2) && ensembleRows.filter((row) => row.cellId === normalCell).every((row) => row.branch === "agree") && ensembleRows.filter((row) => row.cellId === drilledCell).every((row) => row.branch === "abstain" && row.reason === "unnormalized_probabilities") && ensembleRun.results.every((record) => record.status === "ok"));

	// Drill 5: unnormalized boundary in a single-voter arm (1, 1+1e-6 valid; 1+2e-6, 1.002 unnormalized), never invalidating the cell.
	const sums = { a: [0, 1e-6], b: [2e-6, 0.002] };
	const boundaryRun = await runStageCli({
		stage: "S0", runDir, label: "drill-unnormalized",
		plan: [{ stage: "S0", split: "dev", taskId: "no-invented-cap", condition: "de-error", repeat: 1, drill: "a" }, { stage: "S0", split: "dev", taskId: "no-invented-cap", condition: "de-error", repeat: 2, drill: "b" }],
		scriptedOverrides: ({ meta, body }) => {
			const excess = sums[meta?.drill]?.[(meta?.invocation ?? 1) - 1];
			return excess === undefined ? null : scriptedEnvelope(Object.keys(body.questions)[0], "yes", { yes: 0.9, no: 0.1 + excess }, 0.8);
		},
	});
	const reasonOf = (cellId) => checkpointRowsOf(boundaryRun.rows, cellId).map((row) => row.voters[0].reason ?? row.voters[0].status);
	const aReasons = reasonOf(boundaryRun.results[0].cellId);
	const bReasons = reasonOf(boundaryRun.results[1].cellId);
	check("drill5_unnormalized_boundary", JSON.stringify(aReasons) === JSON.stringify(["decided", "decided"]) && JSON.stringify(bReasons) === JSON.stringify(["unnormalized_probabilities", "unnormalized_probabilities"]) && boundaryRun.results.every((record) => record.status === "ok") && (boundaryRun.results[1].noDecision?.unnormalized_probabilities ?? 0) === 2, { aReasons, bReasons });

	// Drill 6: turn cap fails only that cell.
	const turnRun = await runStageCli({ stage: "S0", runDir, label: "drill-turn-cap", plan: [{ stage: "S0", split: "dev", taskId: "retry-until-cap", condition: "a1-off", repeat: 1, turnCap: 3 }] });
	check("drill6_turn_cap", turnRun.results[0].status === "failed" && turnRun.results[0].errorClass === "cell_cap");

	return { schema: "jexp.s0_pass.v1", pass: checks.every((entry) => entry.pass), checks, upstreamCalls: main.summary.upstreamCalls, harnessDigest: harnessDigest().digest, createdAt: new Date().toISOString() };
}

async function runS0b(runDir) {
	const checks = [];
	const check = (id, pass, detail = {}) => { checks.push({ id, pass: Boolean(pass), ...detail }); return Boolean(pass); };
	const run = await runStageCli({ stage: "S0b", runDir, label: "S0b" });
	check("s0b_12_ok", run.results.length === 12 && run.results.every((record) => record.status === "ok"), { statusCounts: run.summary.statusCounts });
	const comparisons = [];
	for (const record of run.results.filter((entry) => entry.condition === "a0-release")) {
		const twin = run.results.find((entry) => entry.condition === "a1-off" && entry.taskId === record.taskId && entry.repeat === record.repeat);
		const digests = (cellId) => run.rows.filter((row) => row.kind === "chat" && row.cellId === cellId).sort((a, b) => a.turn - b.turn).map((row) => row.normalizedDigest);
		const a0 = digests(record.cellId);
		const a1 = digests(twin.cellId);
		comparisons.push({ taskId: record.taskId, repeat: record.repeat, turns: a0.length, equal: a0.length > 0 && JSON.stringify(a0) === JSON.stringify(a1), scoreEqual: record.score === twin.score });
	}
	check("s0b_normalized_bodies_equal", comparisons.length === 6 && comparisons.every((entry) => entry.equal), { comparisons });
	check("s0b_scores_equal", comparisons.every((entry) => entry.scoreEqual));
	const offCells = run.results.filter((entry) => entry.condition === "a1-off");
	check("s0b_off_io_zero", offCells.every((record) => !existsSync(path.join(run.stageDir, "cells", record.cellId, "mount", "home", ".gjc-plugin", "jev-checkpoint")) && checkpointRowsOf(run.rows, record.cellId).length === 0 && record.adviceCount === 0));
	check("s0b_upstream_zero", run.summary.upstreamCalls === 0);
	return { schema: "jexp.s0b_inertness.v1", pass: checks.every((entry) => entry.pass), checks, harnessDigest: harnessDigest().digest, createdAt: new Date().toISOString() };
}

function arg(name, fallback = null) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const runDir = path.resolve(arg("run-dir") ?? "");
	if (!arg("run-dir")) { process.stderr.write("usage: s0.mjs --run-dir <dir> [--only S0|S0b]\n"); process.exit(2); }
	const only = arg("only");
	if (!only || only === "S0") {
		const receipt = await runS0(runDir);
		writeFileSync(path.join(runDir, "s0-pass.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
		process.stdout.write(`S0 pass=${receipt.pass} ${receipt.checks.filter((entry) => !entry.pass).map((entry) => entry.id).join(",")}\n`);
	}
	if (!only || only === "S0b") {
		const receipt = await runS0b(runDir);
		writeFileSync(path.join(runDir, "s0b-inertness.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
		process.stdout.write(`S0b pass=${receipt.pass} ${receipt.checks.filter((entry) => !entry.pass).map((entry) => entry.id).join(",")}\n`);
	}
}

export { runS0, runS0b };
