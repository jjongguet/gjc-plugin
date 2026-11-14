#!/usr/bin/env node
/**
 * Pre-paid preparation steps (final plan G3): readiness, catalog receipt, L0.
 *   node self-improve/jev-checkpoint/scripts/prepare.mjs --run-dir <dir> --step readiness|catalog|l0
 *
 * readiness: PR #65/#66 merge commits are ancestors of origin/main, package
 *   version, the v0.0.28 tag target and the A0 release tree digest.
 * catalog:   GET https://apis.opengateway.ai/v1/models → catalog-<ts>.json and
 *   catalog-latest.json (24h freshness enforced by every paid step).
 * l0:        one decision per trial model, then one real live cell (a1-off on a
 *   dev task) through the proxy upstream path; records usage presence, tool-call
 *   passthrough, bytes→tokens ratio, envelope validity and latency. ≤ $0.05,
 *   spend joins ledger.jsonl.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assertFresh, fetchCatalog } from "../lib/catalog.mjs";
import { createLedger, HARD_STOP_USD } from "../lib/accounting.mjs";
import { priorSpend } from "../lib/ledger-journal.mjs";
import { readOpenGatewayKey } from "../lib/keys.mjs";
import { createDecisionDispatcher } from "../lib/decision-client.mjs";
import { startProxy } from "../lib/proxy.mjs";
import { runStage } from "../lib/runner.mjs";
import { FIXTURES_DIR, LANE_ROOT, SCRIPTED_QUESTIONS, bundlesFor, gjcBinary } from "./stage.mjs";

export const PR65_MERGE = "db17b79";
export const PR66_MERGE = "5f0652e";
export const RELEASE_TAG = "v0.0.28";
export const PRIOR_EXTERNAL_USD = 0.02;
export const L0_CAP_USD = 0.05;

const git = (...args) => execFileSync("git", ["-C", LANE_ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const ancestor = (commit) => { try { execFileSync("git", ["-C", LANE_ROOT, "merge-base", "--is-ancestor", commit, "origin/main"], { stdio: "ignore" }); return true; } catch { return false; } };

export function readiness() {
	git("fetch", "-q", "origin", "main", "--tags");
	const version = JSON.parse(readFileSync(path.join(LANE_ROOT, "package.json"), "utf8")).version;
	let tagCommit = null;
	try { tagCommit = git("rev-list", "-n", "1", RELEASE_TAG); } catch { tagCommit = null; }
	const releaseCommit = tagCommit ?? git("rev-parse", PR65_MERGE);
	const receipt = {
		schema: "jexp.readiness.v1",
		checkedAt: new Date().toISOString(),
		originMain: git("rev-parse", "origin/main"),
		pr65MergeAncestor: ancestor(PR65_MERGE),
		pr66MergeAncestor: ancestor(PR66_MERGE),
		packageVersion: version,
		releaseTag: RELEASE_TAG,
		releaseTagCommit: tagCommit,
		releaseSurface: tagCommit ? "tag_tree" : "merge_commit_tree",
		releaseTree: git("rev-parse", `${releaseCommit}^{tree}`),
		releaseJevAdvisorTree: git("rev-parse", `${releaseCommit}:jev-advisor`),
		laneJevAdvisorTree: git("rev-parse", "HEAD:jev-advisor"),
	};
	receipt.pass = receipt.pr65MergeAncestor && receipt.pr66MergeAncestor && version === "0.0.28";
	return receipt;
}

async function l0(runDir) {
	const catalog = assertFresh(JSON.parse(readFileSync(path.join(runDir, "catalog-latest.json"), "utf8"))).entries;
	const key = readOpenGatewayKey();
	const journalPath = path.join(runDir, "ledger.jsonl");
	const prior = priorSpend(journalPath);
	const ledger = createLedger({ hardStopUsd: Math.min(HARD_STOP_USD, prior + PRIOR_EXTERNAL_USD + L0_CAP_USD), priorSpentUsd: prior + PRIOR_EXTERNAL_USD, journalPath, stopPath: path.join(runDir, "stop-l0.json"), label: "L0" });
	ledger.configureCell("l0", { usdCap: L0_CAP_USD });
	const dispatcher = createDecisionDispatcher({ surface: "trial", keys: { opengateway: key }, ledger, catalog });
	const decisions = [];
	for (const model of ["sionic-ai/jev-omni", "sionic-ai/decider-4b"]) {
		const row = await dispatcher.decide({ cellId: "l0", model, family: "goal_state", wordingId: "W2", state: "Goal: report today's PR budget from the pr-budget tool output.\nRecent actions (oldest first):\n1. bash {\"command\":\"pr-budget\"} → ok: {\"maxPrs\":5,\"used\":2}\n2. bash {\"command\":\"pr-budget\"} → ok: {\"maxPrs\":5,\"used\":2}\n3. bash {\"command\":\"pr-budget\"} → ok: {\"maxPrs\":5,\"used\":2}", threshold: 0.6 });
		decisions.push({ model, status: row.status, reason: row.reason, choice: row.choice ?? null, confidence: row.confidence ?? null, confidenceKind: row.confidenceKind ?? null, sumDeviation: row.sumDeviation ?? null, latencyMs: row.latencyMs, httpStatus: row.httpStatus, inputTokens: row.inputTokens, costUsd: row.costUsd, basis: row.basis });
	}
	// One real live cell (baseline arm, dev task) through the exact proxy upstream path (mode B).
	const stageDir = path.join(runDir, "L0");
	mkdirSync(stageDir, { recursive: true, mode: 0o700 });
	const proxy = await startProxy({ mode: "live", ledger, keys: { opengateway: key }, catalog, questionConfig: SCRIPTED_QUESTIONS, onRow: (row) => appendFileSync(path.join(stageDir, "proxy-rows.jsonl"), `${JSON.stringify(row)}\n`, { mode: 0o600 }) });
	let cell;
	try {
		const outcome = await runStage({ stage: "L0", plan: [{ stage: "L0", split: "dev", taskId: "no-invented-cap", condition: "a1-off", repeat: 1 }], proxy, ledger, stopPath: path.join(runDir, "stop-l0.json"), stageRoot: realpathSync(stageDir), fixturesDir: FIXTURES_DIR, gjcBin: gjcBinary(), bundlesFor, userHome: os.homedir(), laneRoot: LANE_ROOT, concurrency: 1, cellUsdCap: L0_CAP_USD });
		cell = outcome.results[0];
	} finally {
		await proxy.close();
	}
	const chatRows = proxy.rows.filter((row) => row.kind === "chat");
	const settled = chatRows.filter((row) => row.status === "ok");
	const tokens = settled.reduce((sum, row) => sum + (row.inputTokens ?? 0), 0);
	const bytes = settled.reduce((sum, row) => sum + row.requestBytes, 0);
	const chat = {
		turns: chatRows.length,
		ok: settled.length,
		errors: chatRows.filter((row) => row.status !== "ok").map((row) => row.error ?? row.status),
		bases: [...new Set(settled.map((row) => row.basis))],
		inputTokens: tokens,
		outputTokens: settled.reduce((sum, row) => sum + (row.outputTokens ?? 0), 0),
		requestBytes: bytes,
		bytesPerToken: tokens > 0 ? bytes / tokens : null,
		toolCallPassthrough: settled.some((row) => row.toolCalls > 0),
		meanLatencyMs: settled.length ? settled.reduce((sum, row) => sum + row.latencyMs, 0) / settled.length : null,
		costUsd: chatRows.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
	};
	const cellSummary = { status: cell.status, errorClass: cell.errorClass, score: cell.score, toolCalls: cell.toolCalls, wasteTurns: cell.wasteTurns, wallMs: cell.wallMs, sessionUsd: cell.sessionUsd, plugins: cell.plugins };
	const totalUsd = ledger.snapshot().spentUsd - prior - PRIOR_EXTERNAL_USD;
	const pass = cell.status === "ok" && chat.ok === chat.turns && chat.toolCallPassthrough && !chat.bases.includes("computed_bound") && chat.bytesPerToken > 0 && decisions.every((row) => row.status !== "no_decision" || row.reason === "unnormalized_probabilities") && totalUsd <= L0_CAP_USD;
	return { schema: "jexp.l0.v1", at: new Date().toISOString(), upstreamMode: "B_stream_false_usage_include", chat, cell: cellSummary, decisions, totalUsd, pass };
}

function arg(name, fallback = null) {
	const index = process.argv.indexOf(`--${name}`);
	return index >= 0 ? process.argv[index + 1] : fallback;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const runDir = arg("run-dir");
	const step = arg("step");
	if (!runDir || !step) { process.stderr.write("usage: prepare.mjs --run-dir <dir> --step readiness|catalog|l0\n"); process.exit(2); }
	const dir = path.resolve(runDir);
	if (step === "readiness") {
		const receipt = readiness();
		writeFileSync(path.join(dir, "readiness.json"), JSON.stringify(receipt, null, 2));
		process.stdout.write(`readiness pass=${receipt.pass}\n`);
	} else if (step === "catalog") {
		const receipt = await fetchCatalog();
		const stamp = receipt.observedAt.replace(/[:.]/g, "-");
		writeFileSync(path.join(dir, `catalog-${stamp}.json`), JSON.stringify(receipt, null, 2));
		writeFileSync(path.join(dir, "catalog-latest.json"), JSON.stringify(receipt, null, 2));
		process.stdout.write(`catalog ${Object.values(receipt.entries).map((entry) => `${entry.model}:list=${entry.listInputPricePerToken},obs=${entry.observedInputPricePerToken}`).join(" ")}\n`);
	} else if (step === "l0") {
		const receipt = await l0(dir);
		writeFileSync(path.join(dir, "ledger-l0.json"), JSON.stringify(receipt, null, 2));
		process.stdout.write(`L0 pass=${receipt.pass} totalUsd=${receipt.totalUsd}\n`);
	} else {
		process.stderr.write("unknown step\n");
		process.exit(2);
	}
}
