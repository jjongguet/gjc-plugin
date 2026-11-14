#!/usr/bin/env node
/**
 * J0 judge golden set runs.
 *   node self-improve/jev-checkpoint/scripts/j0.mjs --run-dir <dir> --phase freeze|dev|test
 *
 * freeze: label sheet digest + case digests → j0-labels.json (before any model call).
 * dev:    wording calibration on the dev split (jev-omni, decider-4b) → j0-dev.json.
 * test:   frozen wording, 3 models × 3 repeats × 2 criteria orders → j0-test.json.
 * Keys are read by this process only; spend joins the shared ledger.jsonl.
 */
import { appendFileSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertFresh } from "../lib/catalog.mjs";
import { createLedger, HARD_STOP_USD } from "../lib/accounting.mjs";
import { priorSpend } from "../lib/ledger-journal.mjs";
import { readOpenGatewayKey, readOpenRouterKey } from "../lib/keys.mjs";
import { createDecisionDispatcher } from "../lib/decision-client.mjs";
import { caseDigest, estimateW, j0Report, J0_THRESHOLD, labelSheetDigest, loadCases, plan, selectWordings } from "../lib/judge.mjs";
import { FIXTURES_DIR } from "./stage.mjs";
import { requireS0Harness } from "../lib/digest.mjs";
import { PRIOR_EXTERNAL_USD } from "./prepare.mjs";

export const J0_PHASE_CAP_USD = Object.freeze({ dev: 0.05, test: 0.3 });
const CONCURRENCY = 4;

async function runPlan({ runDir, phase, requests, cases }) {
	const catalog = assertFresh(JSON.parse(readFileSync(path.join(runDir, "catalog-latest.json"), "utf8"))).entries;
	const journalPath = path.join(runDir, "ledger.jsonl");
	const prior = priorSpend(journalPath) + PRIOR_EXTERNAL_USD;
	const ledger = createLedger({ hardStopUsd: Math.min(HARD_STOP_USD, prior + J0_PHASE_CAP_USD[phase]), priorSpentUsd: prior, journalPath, stopPath: path.join(runDir, `stop-j0-${phase}.json`), label: `J0-${phase}` });
	const keys = { opengateway: readOpenGatewayKey(), openrouter: phase === "test" ? readOpenRouterKey() : undefined };
	const dispatcher = createDecisionDispatcher({ surface: "j0", keys, ledger, catalog });
	const byId = new Map(cases.map((entry) => [entry.id, entry]));
	const rowsPath = path.join(runDir, `j0-${phase}-rows.jsonl`);
	const rows = new Array(requests.length);
	let next = 0;
	const worker = async () => {
		while (next < requests.length) {
			const index = next++;
			const request = requests[index];
			const entry = byId.get(request.caseId);
			const row = await dispatcher.decide({ cellId: `j0-${phase}`, model: request.model, family: entry.family, wordingId: request.wordingId, criteriaOrder: request.criteriaOrder, state: entry.state, threshold: J0_THRESHOLD });
			const slim = { ...request, status: row.status, reason: row.reason, choice: row.choice ?? null, confidence: row.confidence ?? null, confidenceKind: row.confidenceKind ?? null, margin: row.margin ?? null, probabilities: row.probabilities ?? null, sumDeviation: row.sumDeviation ?? null, unnormalizedAtSensitivity: row.unnormalizedAtSensitivity ?? null, latencyMs: row.latencyMs, httpStatus: row.httpStatus ?? null, inputTokens: row.inputTokens ?? null, costUsd: row.costUsd, basis: row.basis, transport: row.transport };
			rows[index] = slim;
			appendFileSync(rowsPath, `${JSON.stringify(slim)}\n`, { mode: 0o600 });
		}
	};
	await Promise.all(Array.from({ length: CONCURRENCY }, worker));
	return { rows, spentUsd: ledger.snapshot().spentUsd - prior, stopped: Boolean(ledger.stopped) };
}

function arg(name, fallback = null) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const runDir = path.resolve(arg("run-dir") ?? "");
	const phase = arg("phase");
	if (!arg("run-dir") || !["freeze", "dev", "test"].includes(phase)) { process.stderr.write("usage: j0.mjs --run-dir <dir> --phase freeze|dev|test\n"); process.exit(2); }
	const cases = loadCases(FIXTURES_DIR);
	const sheet = labelSheetDigest(cases);
	const harness = requireS0Harness(runDir);
	if (phase === "freeze") {
		const receipt = { schema: "jexp.j0_labels.v1", frozenAt: new Date().toISOString(), harnessDigest: harness, labelSheetDigest: sheet, cases: cases.map((entry) => ({ id: entry.id, split: entry.split, class: entry.class, label: entry.label, safe: entry.safe ?? null, deterministicVerdict: entry.deterministicVerdict ?? null, digest: caseDigest(entry), sourceRef: entry.source.ref })), counts: { test: cases.filter((entry) => entry.split === "test").length, dev: cases.filter((entry) => entry.split === "dev").length } };
		writeFileSync(path.join(runDir, "j0-labels.json"), JSON.stringify(receipt, null, 2));
		process.stdout.write(`J0 labels frozen ${sheet} test=${receipt.counts.test} dev=${receipt.counts.dev}\n`);
	} else {
		const frozenLabels = JSON.parse(readFileSync(path.join(runDir, "j0-labels.json"), "utf8"));
		if (frozenLabels.labelSheetDigest !== sheet) throw new Error("j0_labels_changed_since_freeze");
		if (existsSync(path.join(runDir, `j0-${phase}-rows.jsonl`))) throw new Error(`j0_${phase}_already_run`);
		if (phase === "dev") {
			const requests = plan(cases, "dev");
			const { rows, spentUsd, stopped } = await runPlan({ runDir, phase, requests, cases });
			const selection = selectWordings(rows, new Map(cases.map((entry) => [entry.id, entry])));
			writeFileSync(path.join(runDir, "j0-dev.json"), JSON.stringify({ schema: "jexp.j0_dev.v1", harnessDigest: harness, labelSheetDigest: sheet, requests: requests.length, spentUsd, stopped, selection, noDecision: rows.filter((row) => row.status === "no_decision").reduce((acc, row) => { acc[row.reason] = (acc[row.reason] ?? 0) + 1; return acc; }, {}) }, null, 2));
			process.stdout.write(`J0-dev requests=${requests.length} spent=${spentUsd} selection=${JSON.stringify(Object.fromEntries(Object.entries(selection).map(([family, value]) => [family, `${value.wordingId}/${value.rule}`])))}\n`);
		} else {
			const dev = JSON.parse(readFileSync(path.join(runDir, "j0-dev.json"), "utf8"));
			const frozen = { error_repeat: dev.selection.error_repeat.wordingId, goal_state: dev.selection.goal_state.wordingId };
			const requests = plan(cases, "test", frozen);
			const { rows, spentUsd, stopped } = await runPlan({ runDir, phase, requests, cases });
			const wReceipt = JSON.parse(readFileSync(path.join(runDir, "w-intervals.json"), "utf8"));
			if (wReceipt.complete !== true) throw new Error("w_intervals_incomplete");
			const w = estimateW(wReceipt.intervals);
			const report = j0Report(rows, cases, w);
			writeFileSync(path.join(runDir, "j0-test.json"), JSON.stringify({ ...report, harnessDigest: harness, labelSheetDigest: sheet, frozenWording: frozen, requests: requests.length, spentUsd, stopped, labelStatus: "owner-sourced, blind second label agreed; owner-confirmation pending" }, null, 2));
			process.stdout.write(`J0-test requests=${requests.length} spent=${spentUsd} stopped=${stopped}\n`);
		}
	}
}
