/**
 * Stage runner: schedules planned cells with bounded concurrency against one
 * parent proxy and one ledger, scores each finished cell in a separate
 * arm-blind process, and propagates the global hard stop (final plan C4(b)):
 * on `stop.json` it stops scheduling, kills every running cell's process group,
 * marks in-flight cells `failed/global_stop` and leaves the rest `not_run`.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEATBELT_BIN, buildSeatbeltProfile, runtimeReadRoots } from "../../lib/isolation-runtime.mjs";
import { TURN_CAP, prepareCell, proveIsolation, runSession } from "./cell.mjs";
import { parseTranscript } from "./transcript.mjs";
import { cellMetrics } from "./metrics.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const execFileAsync = promisify(execFile);
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

export const HARNESS_ROOT = path.resolve(HERE, "..");

/**
 * Deny-all Seatbelt profile for the arm-blind scorer. Oracles execute
 * cell-written code (`node --test`, imports of model-edited sources), so the
 * scorer gets no network, reads only the runtime, the harness, the task fixture
 * and the cell's own files, and writes only inside the cell mount.
 */
export function scorerProfile({ taskDir, mountDir, transcriptPath, harnessRoot = HARNESS_ROOT, userHome = os.homedir() }) {
	const taskRoot = realpathSync(taskDir);
	const harness = realpathSync(harnessRoot);
	const readRoots = [...new Set([...runtimeReadRoots(), "/opt/homebrew/bin", realpathSync(process.execPath), harness, ...(taskRoot.startsWith(`${harness}${path.sep}`) ? [] : [taskRoot]), realpathSync(mountDir), realpathSync(transcriptPath)])].filter(existsSync);
	const protectedReadRoots = [path.join(userHome, ".gjc"), path.join(userHome, ".ssh"), path.join(userHome, ".gjc-plugin")].filter(existsSync).map((entry) => realpathSync(entry));
	return buildSeatbeltProfile({ mountDir: realpathSync(mountDir), allowNetworkHosts: [], readRoots, protectedReadRoots });
}

export async function scoreCell({ taskDir: rawTaskDir, workDir: rawWorkDir, transcriptPath: rawTranscript, auditPath: rawAudit, harnessRoot: rawHarness = HARNESS_ROOT }) {
	if (!existsSync(SEATBELT_BIN)) throw new Error("scorer_sandbox_unavailable");
	// Seatbelt matches canonical paths only (/tmp is a symlink to /private/tmp).
	const [taskDir, workDir, transcriptPath, auditPath, harnessRoot] = [rawTaskDir, rawWorkDir, rawTranscript, rawAudit, rawHarness].map((entry) => realpathSync(entry));
	const mountDir = path.dirname(workDir);
	const profilePath = path.join(path.dirname(mountDir), "score.sb");
	writeFileSync(profilePath, scorerProfile({ taskDir, mountDir, transcriptPath, harnessRoot }), { mode: 0o600 });
	const scratch = path.join(mountDir, "score-tmp");
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	// Homebrew git first: /usr/bin/git is an xcrun shim that needs developer-tool paths the profile does not grant.
	const env = { PATH: "/opt/homebrew/bin:/usr/bin:/bin", HOME: path.join(mountDir, "home"), TMPDIR: scratch, NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1" };
	const script = path.join(harnessRoot, "scripts", "score-cell.mjs");
	// Asynchronous so the proxy and the stop watchdog keep running while a cell is scored.
	const { stdout } = await execFileAsync(SEATBELT_BIN, ["-f", profilePath, process.execPath, script, taskDir, workDir, transcriptPath, auditPath], { encoding: "utf8", timeout: 120000, env, cwd: mountDir, maxBuffer: 16 * 1024 * 1024 });
	return JSON.parse(stdout);
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
		if (stopped || ledger.stopped) {
			// Recorded like every other cell so the analyzer sees the missing pair.
			results[index] = { ...base, status: "not_run", errorClass: null };
			onCell(results[index]);
			return;
		}
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
			// In-flight requests must settle before this cell's rows are read.
			await proxy.drainCell(cellId);
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
			const scored = await scoreCell({ taskDir, workDir: cell.work, transcriptPath, auditPath: cell.audit });
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
			await proxy.drainCell(cellId);
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
