/**
 * Stage runner: schedules planned cells with bounded concurrency against one
 * parent proxy and one ledger, scores each finished cell in a separate
 * arm-blind process, and propagates the global hard stop (final plan C4(b)):
 * on `stop.json` it stops scheduling, kills every running cell's process group,
 * marks in-flight cells `failed/global_stop` and leaves the rest `not_run`.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TURN_CAP, prepareCell, proveIsolation, runSession } from "./cell.mjs";
import { parseTranscript } from "./transcript.mjs";
import { cellMetrics } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SCORE_SCRIPT = path.join(HERE, "..", "scripts", "score-cell.mjs");
export const STOP_POLL_MS = 1000;

const successOf = (score) => (score === 2 ? 1 : score === 1 ? 0.5 : 0);

export function checkpointConfigFor(condition, frozen = null) {
	switch (condition) {
		case "a0-release": return null; // jev-checkpoint not installed
		case "a1-off": return { mode: "off" };
		case "bp-periodic": return { mode: "periodic" };
		case "de-error": return { mode: "error" };
		case "c3-ensemble": return { mode: "ensemble", trigger: frozen?.trigger ?? "periodic" };
		case "fz-frozen": if (!frozen?.config) throw new Error("frozen_config_missing"); return frozen.config;
		default: throw new Error("unknown_condition");
	}
}

export function scoreCell({ taskDir, workDir, transcriptPath, auditPath }) {
	const out = execFileSync(process.execPath, [SCORE_SCRIPT, taskDir, workDir, transcriptPath, auditPath], { encoding: "utf8", timeout: 120000, stdio: ["ignore", "pipe", "pipe"] });
	return JSON.parse(out);
}

export async function runStage({ stage, plan, proxy, ledger, stopPath, stageRoot, fixturesDir, gjcBin, bundlesFor, userHome, laneRoot, concurrency = 3, frozen = null, cellUsdCap = 0.06, onCell = () => {} }) {
	const results = new Array(plan.length).fill(null);
	const running = new Map();
	let stopped = false;
	const watcher = setInterval(() => {
		if (!stopped && existsSync(stopPath)) {
			stopped = true;
			for (const controller of running.values()) controller.abort("global_stop");
		}
	}, STOP_POLL_MS);
	let next = 0;
	async function runOne(index) {
		const planned = plan[index];
		const base = { stage, split: planned.split, taskId: planned.taskId, repeat: planned.repeat, condition: planned.condition, turnCap: TURN_CAP };
		if (stopped || ledger.stopped) { results[index] = { ...base, status: "not_run", errorClass: null }; return; }
		const cellId = randomBytes(12).toString("hex");
		const token = randomBytes(24).toString("hex");
		const taskDir = path.join(fixturesDir, "tasks", planned.taskId);
		const spec = JSON.parse(readFileSync(path.join(taskDir, "spec.json"), "utf8"));
		const checkpointConfig = planned.checkpointConfigOverride ?? checkpointConfigFor(planned.condition, frozen);
		const checkpoint = checkpointConfig ? { mode: checkpointConfig.mode, trigger: checkpointConfig.trigger ?? (checkpointConfig.mode === "error" ? "error" : "periodic") } : { mode: "off", trigger: "periodic" };
		const rootGuess = path.join(realpathSync(stageRoot), "cells", cellId);
		const registration = proxy.registerCell({ cellId, token, checkpoint, usdCap: planned.usdCap ?? cellUsdCap, turnCap: planned.turnCap ?? TURN_CAP, normalization: { root: rootGuess, cellId, port: proxy.port, extra: [[token, "<TOKEN>"]] }, meta: { taskId: planned.taskId, condition: planned.condition, drill: planned.drill ?? null } });
		const controller = new AbortController();
		running.set(index, controller);
		const record = { ...base, cellId, status: "failed", errorClass: null, score: 0, success: 0 };
		try {
			let cell;
			try {
				cell = prepareCell({ stageRoot, cellId, taskDir, spec, condition: planned.condition, checkpointConfig, registration, token, gjcBin, bundles: bundlesFor(planned.condition), userHome, laneRoot });
			} catch (error) {
				record.errorClass = "setup";
				record.detail = String(error.message).slice(0, 200);
				return;
			}
			record.plugins = cell.plugins;
			const isolation = proveIsolation(cell, proxy.host);
			record.isolation = { status: isolation.receipt.status, profileDigest: isolation.receipt.profileDigest ?? null, reason: isolation.receipt.reason ?? null };
			if (!isolation.ok) { record.errorClass = "isolation"; return; }
			const session = await runSession({ cell, isolation, signal: controller.signal });
			proxy.closeCell(cellId);
			const transcriptPath = path.join(cell.root, "transcript.jsonl");
			writeFileSync(transcriptPath, session.stdout, { mode: 0o600 });
			writeFileSync(path.join(cell.root, "stderr.txt"), session.stderrTail, { mode: 0o600 });
			record.wallMs = session.wallMs;
			record.exitCode = session.code;
			const cellRows = proxy.rows.filter((row) => row.cellId === cellId);
			const chatRows = cellRows.filter((row) => row.kind === "chat" && (row.status === "ok" || row.status === "error"));
			const checkpointRows = cellRows.filter((row) => row.kind === "checkpoint");
			const capped = cellRows.some((row) => row.kind === "chat" && row.status === "refused" && row.error === "cell_cap");
			let parsed = null;
			try { parsed = parseTranscript(session.stdout); } catch (error) { record.transcriptError = error.message; }
			const scored = scoreCell({ taskDir, workDir: cell.work, transcriptPath, auditPath: cell.audit });
			record.score = scored.score;
			record.success = successOf(scored.score);
			record.checks = scored.checks;
			record.oracleDigest = scored.evidenceDigest;
			if (parsed) Object.assign(record, cellMetrics({ parsed, spec, chatRows, checkpointRows }));
			else record.wasteTurns = TURN_CAP;
			if (session.failure === "global_stop" || (stopped && session.code !== 0)) record.errorClass = "global_stop";
			else if (capped) record.errorClass = "cell_cap";
			else if (session.failure === "timeout") record.errorClass = "timeout";
			else if (session.failure) record.errorClass = session.failure === "transcript" ? "transcript" : "spawn";
			else if (session.code !== 0 || !parsed?.ended) record.errorClass = "transcript";
			if (record.errorClass) {
				// F4 imputation: success 0, waste = observed (or the turn cap when absent), cost stays the ledger value.
				record.success = 0;
				record.score = 0;
				record.imputed = true;
			}
			record.status = record.errorClass ? "failed" : "ok";
		} catch (error) {
			record.errorClass ??= "harness";
			record.detail = String(error?.message ?? error).slice(0, 200);
		} finally {
			proxy.closeCell(cellId);
			running.delete(index);
			const cellRows = proxy.rows.filter((row) => row.cellId === cellId);
			record.sessionUsd ??= cellRows.filter((row) => row.kind === "chat").reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
			record.jevUsd ??= cellRows.filter((row) => row.kind === "checkpoint").reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
			record.wasteTurns ??= TURN_CAP;
			results[index] = record;
			onCell(record);
		}
	}
	async function worker() {
		while (next < plan.length) {
			const index = next++;
			await runOne(index);
		}
	}
	try {
		await Promise.all(Array.from({ length: Math.min(concurrency, plan.length) }, worker));
	} finally {
		clearInterval(watcher);
	}
	return { results, stopped: stopped || Boolean(ledger.stopped) };
}
