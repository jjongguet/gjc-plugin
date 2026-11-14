#!/usr/bin/env node
/**
 * Manifest freeze (G5) — the last step before any paid trial cell.
 *   node self-improve/jev-checkpoint/scripts/freeze.mjs --run-dir <dir>
 *
 * Refuses unless S0/S0b pass on the current harness digest, readiness passes,
 * the catalog is fresh, L0 passes and J0 dev/test exist. Freezes wording,
 * criteria order, the C3 ensemble rule (pre-stated, never chosen on J0-test or
 * holdout), the numeric rule table digests, powerGate=fail, W, prices, the
 * per-cell cap and the cost projection (must be ≤ $3.40).
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertFresh } from "../lib/catalog.mjs";
import { analyzerDigest, bundleDigest, harnessDigest } from "../lib/digest.mjs";
import { DECLARED_EFFECT_PP, POWER_GATE, ruleTableDigest } from "../lib/analyze.mjs";
import { decisiveRunSize, monteCarloA3, signTestPower } from "../lib/power.mjs";
import { FAMILIES, questionDigest } from "../lib/questions.mjs";
import { agreement, loadCases } from "../lib/judge.mjs";
import { priorSpend } from "../lib/ledger-journal.mjs";
import { CHAT_MODEL } from "../lib/decision-routes.mjs";
import { stagePlan } from "../lib/stage-plans.mjs";
import { BUNDLES, FIXTURES_DIR } from "./stage.mjs";
import { PRIOR_EXTERNAL_USD } from "./prepare.mjs";

export const START_GATE_USD = 3.4;
export const PROJECTION_MARGIN = 1.25;
export const OUTPUT_TOKENS_PER_TURN = 500;
export const MAX_DECISION_REQUESTS_PER_CELL = 20;

const read = (runDir, name) => JSON.parse(readFileSync(path.join(runDir, name), "utf8"));
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Price for the start-gate projection: the observed (billed) price, else the list
 * price. A missing price refuses instead of pricing as zero; the hard stop itself
 * still reserves at the maximum of both.
 */
export function projectionPrice(observed, list, name) {
	const usable = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
	if (usable(observed)) return observed;
	if (usable(list)) return list;
	throw new Error(`catalog_price_missing:${name}`);
}

/** AC17: the implemented-estimator Monte Carlo, frozen with a digest so analyze-time reproduction can be checked. */
export function monteCarloWithDigest() {
	const result = monteCarloA3();
	return { ...result, digest: sha256(JSON.stringify(result)) };
}

export function freeze(runDir) {
	const current = harnessDigest().digest;
	const s0 = read(runDir, "s0-pass.json");
	const s0b = read(runDir, "s0b-inertness.json");
	if (!s0.pass || s0.harnessDigest !== current) throw new Error("s0_not_passed_on_current_harness");
	if (!s0b.pass || s0b.harnessDigest !== current) throw new Error("s0b_not_passed_on_current_harness");
	const readiness = read(runDir, "readiness.json");
	if (!readiness.pass) throw new Error("readiness_failed");
	const catalogReceipt = assertFresh(read(runDir, "catalog-latest.json"));
	const l0 = read(runDir, "ledger-l0.json");
	if (!l0.pass) throw new Error("l0_failed");
	const j0Dev = read(runDir, "j0-dev.json");
	const j0Test = read(runDir, "j0-test.json");
	const labels = read(runDir, "j0-labels.json");
	for (const [name, receipt] of [["ledger-l0.json", l0], ["j0-labels.json", labels], ["j0-dev.json", j0Dev], ["j0-test.json", j0Test]]) {
		if (receipt.harnessDigest !== current) throw new Error(`receipt_not_bound_to_harness:${name}`);
	}

	// P1 gate (A2329-20): trial families only (destructive is the jev_check shape, C2329-17); unit = case × repeat, canonical order.
	const cases = loadCases(FIXTURES_DIR);
	const byId = new Map(cases.map((entry) => [entry.id, entry]));
	const testRows = readFileSync(path.join(runDir, "j0-test-rows.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
	const trialRows = testRows.filter((row) => byId.get(row.caseId).family !== "destructive");
	const p1 = agreement(trialRows, byId);
	const c3Adoptable = !(p1.agreementErrorRate.value !== null && p1.agreementErrorRate.value >= 0.1) && !(p1.bothWrongHighConfidence.value !== null && p1.bothWrongHighConfidence.value >= 1 / 30);

	// Cost projection from the S0 request-size distribution and the L0 bytes→tokens calibration.
	const chat = catalogReceipt.entries[CHAT_MODEL];
	const s0Rows = readFileSync(path.join(runDir, "S0", "proxy-rows.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.kind === "chat");
	const perCell = new Map();
	for (const row of s0Rows) {
		const entry = perCell.get(row.cellId) ?? { bytes: 0, turns: 0 };
		entry.bytes += row.requestBytes;
		entry.turns += 1;
		perCell.set(row.cellId, entry);
	}
	const bytesPerToken = l0.chat.bytesPerToken;
	if (!(bytesPerToken > 0)) throw new Error("l0_bytes_per_token_missing");
	const inputPrice = projectionPrice(chat.observedInputPricePerToken, chat.listInputPricePerToken, "chat_input");
	const outputPrice = projectionPrice(chat.observedOutputPricePerToken, chat.listOutputPricePerToken, "chat_output");
	if (perCell.size === 0) throw new Error("s0_chat_rows_missing");
	const cellCosts = [...perCell.values()].map((entry) => (entry.bytes / bytesPerToken) * inputPrice + entry.turns * OUTPUT_TOKENS_PER_TURN * outputPrice);
	const meanCellUsd = cellCosts.reduce((sum, value) => sum + value, 0) / cellCosts.length;
	const decisionWorstPerCell = MAX_DECISION_REQUESTS_PER_CELL * (4096 + 1024) * 0.126e-6;
	const paidCells = ["S1", "S2", "S3"].reduce((sum, stage) => sum + stagePlan(stage).length, 0);
	const spentSoFar = priorSpend(path.join(runDir, "ledger.jsonl")) + PRIOR_EXTERNAL_USD;
	const projectedUsd = spentSoFar + PROJECTION_MARGIN * paidCells * (meanCellUsd + decisionWorstPerCell);
	if (!Number.isFinite(projectedUsd) || projectedUsd > START_GATE_USD) throw new Error(`projection_over_start_gate:${projectedUsd}`);
	const cellUsdCap = Math.max(0.06, 2 * (meanCellUsd + decisionWorstPerCell));

	const wording = { error_repeat: j0Dev.selection.error_repeat.wordingId, goal_state: j0Dev.selection.goal_state.wordingId };
	const questions = {
		goal_state: { wordingId: wording.goal_state, criteriaOrder: [...FAMILIES.goal_state.canonicalOrder] },
		error_repeat: { wordingId: wording.error_repeat, criteriaOrder: [...FAMILIES.error_repeat.canonicalOrder] },
		// Pre-stated in the final plan (D5); J0-test rows for the alternatives are sensitivity only.
		ensembleRule: "primary_override",
	};
	const manifest = {
		schema: "jexp.manifest.v1",
		manifestId: `jjo2329-${randomBytes(4).toString("hex")}`,
		frozenAt: new Date().toISOString(),
		issue: "JJO-2329",
		ralplanRun: "01a1d916-909e-7088-bfe4-667fcb63e4ed",
		finalPlanSha256: "e9bfbf0dc52e5d6f1be7c6516cff16c148040d5cab6afc805ad360a943dad3e1",
		harnessDigest: current,
		analyzerDigest: analyzerDigest(),
		ruleTableDigest: ruleTableDigest(),
		bundles: { jevAdvisor: bundleDigest(BUNDLES.jevAdvisor).digest, jevCheckpoint: bundleDigest(BUNDLES.jevCheckpoint).digest },
		readiness: { originMain: readiness.originMain, releaseTree: readiness.releaseTree, releaseSurface: readiness.releaseSurface },
		catalog: { observedAt: catalogReceipt.observedAt, rawDigest: catalogReceipt.rawDigest, entries: catalogReceipt.entries },
		l0: { bytesPerToken, upstreamMode: l0.upstreamMode },
		questions,
		questionDigests: { goal_state: questionDigest({ family: "goal_state", wordingId: wording.goal_state }), error_repeat: questionDigest({ family: "error_repeat", wordingId: wording.error_repeat }) },
		criteriaOrderDigest: sha256(JSON.stringify({ goal_state: questions.goal_state.criteriaOrder, error_repeat: questions.error_repeat.criteriaOrder, destructive: FAMILIES.destructive.canonicalOrder })),
		j0: { labelSheetDigest: labels.labelSheetDigest, devSelection: j0Dev.selection, p1Gate: { ...p1, c3Adoptable, scope: "trial families (error_repeat, goal_state), canonical order, unit = case × repeat" }, w: j0Test.w },
		powerGate: POWER_GATE,
		power: { holdoutTasks: 6, signTestPowerAtQ08: signTestPower({ n: 6, q: 0.8 }), decisiveRun: decisiveRunSize(), monteCarloA3: monteCarloWithDigest(), declaredEffectPp: DECLARED_EFFECT_PP, declaration: "12 tasks (holdout 6): differences under 25pp are not determinable; with powerGate=fail `adopted` is unreachable and the verdict is capped at insufficient → 현행 유지" },
		cost: { spentSoFarUsd: spentSoFar, priorExternalUsd: PRIOR_EXTERNAL_USD, meanCellUsd, decisionWorstPerCellUsd: decisionWorstPerCell, paidCells, projectedUsd, startGateUsd: START_GATE_USD, hardStopUsd: 4.0 },
		cellUsdCap,
		priorExternalUsd: PRIOR_EXTERNAL_USD,
		x5Signal2: "appendTokenRatio = appended advice tokens (bytes/4) / session tokens (input+output) ≥ 0.10 (parent design §4.3 signal 2); appendRatio (bytes) reported only",
	};
	return manifest;
}

function arg(name, fallback = null) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const runDir = path.resolve(arg("run-dir") ?? "");
	if (!arg("run-dir")) { process.stderr.write("usage: freeze.mjs --run-dir <dir>\n"); process.exit(2); }
	if (existsSync(path.join(runDir, "manifest.json"))) throw new Error("manifest_already_frozen");
	const manifest = freeze(runDir);
	const text = JSON.stringify(manifest, null, 2);
	writeFileSync(path.join(runDir, "manifest.json"), text);
	process.stdout.write(`manifest ${manifest.manifestId} sha256=${sha256(text)} projected=${manifest.cost.projectedUsd.toFixed(4)} cellCap=${manifest.cellUsdCap.toFixed(4)} c3Adoptable=${manifest.j0.p1Gate.c3Adoptable}\n`);
}
