#!/usr/bin/env node
/**
 * Operational-impact audit (final plan H2, AC6): the experiment must leave no
 * trace in the operator's real GJC state. Read-only; outside the harness digest
 * because it never runs inside a cell or touches a measurement.
 *   node self-improve/jev-checkpoint/audit/ops-impact.mjs --run-dir <dir> --since <ISO> --out <file>
 *
 * Checks (each with its own observation; unknown is never a pass):
 *  1 marker scan: no file under the real ~/.gjc/agent/sessions, ~/.gjc-plugin or
 *    ~/.gjc/agent/gjc-plugins modified since --since contains the run dir path
 *    or a cell id (the controlling operator session's own transcript excluded);
 *  2 positive control: the same scanner finds a planted marker;
 *  3 no live cell process remains (pgrep -f <run>/…/cells/);
 *  4 every proxy port recorded in cell models.yml is closed;
 *  5 provider keys appear in no run artifact (in-process byte scan);
 *  6 the real plugin registry does not list jev-checkpoint;
 *  7 no real ~/.gjc-plugin/jev-checkpoint journal exists;
 *  8 no jexp-* tmux session is alive;
 *  9 the cell environment kept no secret-like variable names (isolation receipts).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { keyLeaked, readOpenGatewayKey, readOpenRouterKey } from "../lib/keys.mjs";

const arg = (name, fallback = null) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const runDir = path.resolve(arg("run-dir") ?? "");
const since = Date.parse(arg("since") ?? "");
const out = arg("out");
// The controlling operator session drives the experiment and legitimately records the run dir in its own transcript.
const controller = arg("controller-session", process.env.GJC_SESSION_ID ?? "");
if (!arg("run-dir") || !Number.isFinite(since) || !out) { process.stderr.write("usage: ops-impact.mjs --run-dir <dir> --since <ISO> --out <file>\n"); process.exit(2); }

const home = os.homedir();
const MAX_FILE = 16 * 1024 * 1024;
function* walk(dir, depth = 0) {
	if (depth > 8 || !existsSync(dir)) return;
	let entries;
	try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) yield* walk(full, depth + 1);
		else if (entry.isFile()) yield full;
	}
}

function cellIds() {
	const ids = [];
	for (const stage of readdirSync(runDir, { withFileTypes: true })) {
		const cells = path.join(runDir, stage.name, "cells");
		if (stage.isDirectory() && existsSync(cells)) ids.push(...readdirSync(cells));
	}
	return ids;
}

function scan(roots, needles, sinceMs, exclude = null) {
	const hits = [];
	let scanned = 0;
	const buffers = needles.map((needle) => Buffer.from(needle));
	for (const root of roots) {
		for (const file of walk(root)) {
			let stats;
			try { stats = statSync(file); } catch { continue; }
			if (stats.mtimeMs < sinceMs || stats.size > MAX_FILE) continue;
			// The controller session's transcript file and its artifact directory both carry its id.
			if (exclude && path.relative(root, file).includes(exclude)) continue;
			scanned += 1;
			let data;
			try { data = readFileSync(file); } catch { continue; }
			if (buffers.some((needle) => data.indexOf(needle) !== -1)) hits.push(path.relative(home, file));
		}
	}
	return { scanned, hits };
}

const checks = [];
const check = (id, pass, detail = {}) => checks.push({ id, pass: Boolean(pass), ...detail });
const ids = cellIds();
const needles = [runDir, ...ids];
const roots = [path.join(home, ".gjc", "agent", "sessions"), path.join(home, ".gjc-plugin"), path.join(home, ".gjc", "agent", "gjc-plugins")];
const markerScan = scan(roots, needles, since, controller || null);
check("1_no_markers_in_real_state", markerScan.hits.length === 0, { scannedFiles: markerScan.scanned, cells: ids.length, hits: markerScan.hits.slice(0, 20), excludedControllerSession: controller || null });

const control = mkdtempSync(path.join(os.tmpdir(), "jexp-control-"));
writeFileSync(path.join(control, "planted.txt"), `x ${ids[0] ?? runDir} y`);
const controlScan = scan([control], needles, 0);
rmSync(control, { recursive: true, force: true });
check("2_positive_control", controlScan.hits.length === 1);

// Cell processes (sandbox-exec, gjc, tools) all run with a cell path in argv or cwd; operator tools do not.
const pgrep = spawnSync("/usr/bin/pgrep", ["-f", `${runDir}/[^ ]*/cells/`], { encoding: "utf8" });
check("3_no_live_processes", pgrep.status === 1, { pgrepStatus: pgrep.status, pids: pgrep.stdout.split("\n").filter(Boolean).length });

const ports = new Set();
for (const stage of readdirSync(runDir, { withFileTypes: true })) {
	const cells = path.join(runDir, stage.name, "cells");
	if (!stage.isDirectory() || !existsSync(cells)) continue;
	for (const id of readdirSync(cells)) {
		const models = path.join(cells, id, "mount", "home", ".gjc", "agent", "models.yml");
		if (existsSync(models)) for (const match of readFileSync(models, "utf8").matchAll(/127\.0\.0\.1:(\d+)/g)) ports.add(Number(match[1]));
	}
}
const open = [];
for (const port of ports) {
	const listening = await new Promise((resolve) => {
		const socket = net.connect({ host: "127.0.0.1", port });
		socket.once("connect", () => { socket.destroy(); resolve(true); });
		socket.once("error", () => resolve(false));
		socket.setTimeout(1000, () => { socket.destroy(); resolve(false); });
	});
	if (listening) open.push(port);
}
check("4_proxy_ports_closed", ports.size > 0 && open.length === 0, { ports: ports.size, open });

const keys = [readOpenGatewayKey()];
try { keys.push(readOpenRouterKey()); } catch { /* absent key cannot leak */ }
let artifactFiles = 0;
let leaked = 0;
for (const file of walk(runDir)) {
	let data;
	try { if (statSync(file).size > MAX_FILE) continue; data = readFileSync(file); } catch { continue; }
	artifactFiles += 1;
	if (keys.some((key) => keyLeaked(key, [data]))) leaked += 1;
}
check("5_no_key_material_in_run_artifacts", artifactFiles > 0 && leaked === 0, { artifactFiles, leakedFiles: leaked });

let registryListsCheckpoint = null;
try {
	const listed = JSON.parse(execFileSync("gjc", ["plugin", "list", "--json"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 60000 }));
	registryListsCheckpoint = (listed.gjc ?? []).some((entry) => entry.identity?.name === "jev-checkpoint");
} catch { registryListsCheckpoint = null; }
check("6_real_registry_untouched", registryListsCheckpoint === false);

check("7_no_real_checkpoint_journal", !existsSync(path.join(home, ".gjc-plugin", "jev-checkpoint")));

const tmux = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
const jexp = (tmux.stdout ?? "").split("\n").filter((name) => name.startsWith("jexp-"));
check("8_no_jexp_tmux_sessions", jexp.length === 0, { sessions: jexp });

let receipts = 0;
for (const stage of readdirSync(runDir, { withFileTypes: true })) {
	const results = path.join(runDir, stage.name, "results.jsonl");
	if (!existsSync(results)) continue;
	for (const line of readFileSync(results, "utf8").split("\n").filter(Boolean)) if (JSON.parse(line).isolation?.status === "pass") receipts += 1;
}
const sbFiles = [...walk(runDir)].filter((file) => file.endsWith("live.sb"));
const envLeak = sbFiles.filter((file) => /(OPENGATEWAY|OPENROUTER|JEV_ADVISOR)_API_KEY/.test(readFileSync(file, "utf8"))).length;
check("9_isolation_receipts_and_env", receipts > 0 && envLeak === 0, { isolationReceipts: receipts, profiles: sbFiles.length, profilesNamingKeys: envLeak });

const receipt = { schema: "jexp.ops_impact.v1", at: new Date().toISOString(), since: new Date(since).toISOString(), pass: checks.every((entry) => entry.pass), checks };
writeFileSync(out, JSON.stringify(receipt, null, 2));
process.stdout.write(`ops-impact pass=${receipt.pass} ${checks.filter((entry) => !entry.pass).map((entry) => entry.id).join(",")}\n`);
