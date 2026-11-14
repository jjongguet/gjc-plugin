#!/usr/bin/env node
/**
 * Run one experiment stage.
 *   node self-improve/jev-checkpoint/scripts/stage.mjs --stage S0|S0b|S1|S2|S3 --run-dir /tmp/jexp-<runId> [--concurrency 3]
 *
 * S0/S0b: scripted proxy, no key, no upstream client ($0).
 * S1–S3 (live): require run-dir/manifest.json (frozen), a fresh catalog receipt,
 * s0-pass.json and s0b-inertness.json; the OpenGateway key is read by this
 * process only. The cost ledger journal `run-dir/ledger.jsonl` is shared by all
 * paid steps (L0, J0, S1–S3), so the $4.00 hard stop is cumulative.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLedger, HARD_STOP_USD } from "../lib/accounting.mjs";
import { startProxy } from "../lib/proxy.mjs";
import { runStage } from "../lib/runner.mjs";
import { stagePlan } from "../lib/stage-plans.mjs";
import { createScriptedChat, createScriptedDecision } from "../lib/scripted.mjs";
import { assertFresh } from "../lib/catalog.mjs";
import { readOpenGatewayKey } from "../lib/keys.mjs";
import { priorSpend } from "../lib/ledger-journal.mjs";
import { analyzerDigest, bundleDigest, harnessDigest } from "../lib/digest.mjs";
import { ruleTableDigest } from "../lib/analyze.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const HARNESS_ROOT = path.resolve(HERE, "..");
export const LANE_ROOT = path.resolve(HARNESS_ROOT, "..", "..");
export const FIXTURES_DIR = path.join(HARNESS_ROOT, "fixtures");
export const BUNDLES = Object.freeze({ jevAdvisor: path.join(LANE_ROOT, "jev-advisor"), jevCheckpoint: path.join(HARNESS_ROOT, "plugin") });
export const SCRIPTED_QUESTIONS = Object.freeze({ goal_state: { wordingId: "W2", criteriaOrder: null }, error_repeat: { wordingId: "W2", criteriaOrder: null }, ensembleRule: "primary_override" });

export function bundlesFor(condition) {
	return condition === "a0-release" ? [BUNDLES.jevAdvisor] : [BUNDLES.jevAdvisor, BUNDLES.jevCheckpoint];
}

export function gjcBinary() {
	return execFileSync("/usr/bin/which", ["gjc"], { encoding: "utf8" }).trim();
}

const appendJsonl = (file) => (row) => appendFileSync(file, `${JSON.stringify(row)}\n`, { mode: 0o600 });

/**
 * @param {object} options
 * @param {string} options.stage
 * @param {string} options.runDir
 * @param {object[]} [options.plan]            override the frozen plan (drills only)
 * @param {Function} [options.scriptedOverrides] scripted decision overrides (drills only)
 * @param {object} [options.ledgerOptions]     ledger overrides (drills only)
 * @param {object} [options.scriptedPlans]     scripted chat plans (drills only)
 */
export async function runStageCli({ stage, runDir, label = stage, concurrency = 3, plan = null, scriptedOverrides = null, ledgerOptions = {}, scriptedPlans = undefined, cellUsdCap = 0.06 }) {
	mkdirSync(runDir, { recursive: true, mode: 0o700 });
	const stageDir = path.join(runDir, label);
	// A stage runs once per run dir: re-running would append a second execution of
	// the same cells to results.jsonl. Recovery means a new run dir and manifest.
	if (existsSync(path.join(stageDir, "results.jsonl"))) throw new Error(`stage_already_run:${label}`);
	mkdirSync(stageDir, { recursive: true, mode: 0o700 });
	const live = !["S0", "S0b"].includes(stage);
	let manifest = null;
	let catalog = {};
	let keys = {};
	if (live) {
		manifest = JSON.parse(readFileSync(path.join(runDir, "manifest.json"), "utf8"));
		const current = harnessDigest().digest;
		if (manifest.harnessDigest !== current) throw new Error("harness_changed_since_freeze");
		if (manifest.analyzerDigest !== analyzerDigest() || manifest.ruleTableDigest !== ruleTableDigest()) throw new Error("analyzer_changed_since_freeze");
		// The installed advisor bundle sits outside the harness digest; every cell installs it, so it is frozen too.
		for (const [name, dir] of Object.entries(BUNDLES)) if (manifest.bundles?.[name] !== bundleDigest(dir).digest) throw new Error(`bundle_changed_since_freeze:${name}`);
		for (const gate of ["s0-pass.json", "s0b-inertness.json"]) {
			const receipt = JSON.parse(readFileSync(path.join(runDir, gate), "utf8"));
			if (receipt.pass !== true) throw new Error(`gate_failed:${gate}`);
			if (receipt.harnessDigest !== current) throw new Error(`gate_stale:${gate}`);
		}
		catalog = assertFresh(JSON.parse(readFileSync(path.join(runDir, "catalog-latest.json"), "utf8"))).entries;
		keys = { opengateway: readOpenGatewayKey() };
	}
	const journalPath = live ? path.join(runDir, "ledger.jsonl") : path.join(stageDir, "ledger-scripted.jsonl");
	const stopPath = live ? path.join(runDir, "stop.json") : path.join(stageDir, "stop.json");
	if (existsSync(stopPath)) throw new Error("global_stop_already_reached");
	const ledger = createLedger({ hardStopUsd: HARD_STOP_USD, priorSpentUsd: live ? priorSpend(journalPath) + requireFinite(manifest.priorExternalUsd, "manifest.priorExternalUsd") : 0, journalPath, stopPath, label, ...ledgerOptions });
	const proxy = await startProxy({
		mode: live ? "live" : "scripted",
		ledger,
		keys,
		catalog,
		questionConfig: live ? manifest.questions : SCRIPTED_QUESTIONS,
		scriptedChat: live ? null : createScriptedChat(scriptedPlans),
		scriptedDecision: live ? null : createScriptedDecision(scriptedOverrides ?? (() => null)),
		onRow: appendJsonl(path.join(stageDir, "proxy-rows.jsonl")),
	});
	const cells = plan ?? stagePlan(stage);
	const reprojector = stage === "S1" && live ? createReprojector({ ledger, stageDir, plannedCells: cells }) : null;
	const started = Date.now();
	let outcome;
	try {
		outcome = await runStage({
			stage,
			plan: cells,
			proxy,
			ledger,
			stopPath,
			stageRoot: realpathSync(stageDir),
			fixturesDir: FIXTURES_DIR,
			gjcBin: gjcBinary(),
			bundlesFor,
			userHome: os.homedir(),
			laneRoot: LANE_ROOT,
			concurrency,
			frozen: frozenFor(stage, runDir),
			cellUsdCap: manifest?.cellUsdCap ?? cellUsdCap,
			onCell: (record) => { appendJsonl(path.join(stageDir, "results.jsonl"))(record); if (reprojector) reprojector(record); },
		});
	} finally {
		await proxy.close();
	}
	const statusCounts = {};
	for (const record of outcome.results) {
		const key = `${record.status}${record.errorClass ? `/${record.errorClass}` : ""}`;
		statusCounts[key] = (statusCounts[key] ?? 0) + 1;
	}
	const summary = { stage, label, live, cells: cells.length, wallMs: Date.now() - started, stopped: outcome.stopped, upstreamCalls: proxy.upstreamCalls, decisionTransportCalls: proxy.decisionTransportCalls, ledger: ledger.snapshot(), statusCounts };
	writeFileSync(path.join(stageDir, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
	return { summary, results: outcome.results, rows: proxy.rows, stageDir };
}

/** S2 runs C3 on the S1 winner's trigger; S3 runs the frozen candidate. Both come from post-S1 decision files. */
export function frozenFor(stage, runDir) {
	if (stage === "S2") {
		const decision = JSON.parse(readFileSync(path.join(runDir, "s1-decision.json"), "utf8"));
		if (!decision.runS2) throw new Error("s2_not_admitted");
		return { trigger: decision.winnerTrigger };
	}
	if (stage === "S3") {
		const fz = JSON.parse(readFileSync(path.join(runDir, "fz-freeze.json"), "utf8"));
		if (!fz.config) throw new Error("fz_not_frozen");
		return { config: fz.config };
	}
	return null;
}

export const REPROJECTION_CELLS_PER_ARM = 2;
export const REPROJECTION_GATE_USD = 3.4;

/**
 * S1 re-projection checkpoint (K4): once every arm has 2 finished cells, the
 * remaining paid cells are projected at the observed mean cell cost × 1.25. Above
 * the gate the ledger stops (no further cell starts) and the stop propagates.
 */
export function createReprojector({ ledger, stageDir, plannedCells, remainingAfterStage = 54, margin = 1.25 }) {
	const done = new Map();
	let checked = false;
	return (record) => {
		if (checked || record.status === "not_run") return;
		const list = done.get(record.condition) ?? [];
		list.push((record.sessionUsd ?? 0) + (record.jevUsd ?? 0));
		done.set(record.condition, list);
		const conditions = [...new Set(plannedCells.map((cell) => cell.condition))];
		if (!conditions.every((condition) => (done.get(condition) ?? []).length >= REPROJECTION_CELLS_PER_ARM)) return;
		checked = true;
		const all = [...done.values()].flat();
		const mean = all.reduce((sum, value) => sum + value, 0) / all.length;
		const finished = all.length;
		const remaining = plannedCells.length - finished + remainingAfterStage;
		const snapshot = ledger.snapshot();
		const projected = snapshot.spentUsd + snapshot.reservedUsd + margin * remaining * mean;
		const receipt = { at: new Date().toISOString(), finishedCells: finished, meanCellUsd: mean, remainingCells: remaining, projectedUsd: projected, gateUsd: REPROJECTION_GATE_USD, pass: projected <= REPROJECTION_GATE_USD };
		writeFileSync(path.join(stageDir, "reprojection.json"), JSON.stringify(receipt, null, 2), { mode: 0o600 });
		if (!receipt.pass) ledger.stop("reprojection_over_gate", projected);
	};
}

function requireFinite(value, name) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`invalid_${name}`);
	return value;
}

function arg(name, fallback = null) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const stage = arg("stage");
	const runDir = arg("run-dir");
	if (!stage || !runDir) {
		process.stderr.write("usage: stage.mjs --stage <S0|S0b|S1|S2|S3> --run-dir <dir>\n");
		process.exit(2);
	}
	const { summary } = await runStageCli({ stage, runDir: path.resolve(runDir), concurrency: Number(arg("concurrency", "3")) });
	process.stdout.write(`${JSON.stringify(summary)}\n`);
}
