/**
 * One experiment cell: an isolated HOME/agent dir inside a private mount, the
 * fixture work dir, installed plugin bundles, a deny-all Seatbelt profile with
 * a single loopback host, and a real `gjc --print --mode json` tool session.
 *
 * Recipe verified by the 2026-11-14 G9 probe (self-improve/m1/native-pilot.mjs
 * lineage): the child gets no provider key (only a per-cell placeholder token),
 * and the parent loopback proxy is its only network path.
 */
import { spawn, execFileSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { SEATBELT_BIN, buildProbeEnvironment, probeIsolation, runtimeReadRoots, startLoopbackListener } from "../../lib/isolation-runtime.mjs";
import { CHAT_MODEL, CHAT_PRICE } from "./decision-routes.mjs";

export const CELL_WALL_MS = 240000;
export const TURN_CAP = 16;
export const CHAT_MAX_TOKENS = 4096;
export const CELL_TOOLS = "read,bash,edit,write,find,search";
export const FIXED_GIT_ENV = Object.freeze({
	GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
	GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
	GIT_AUTHOR_NAME: "jexp",
	GIT_AUTHOR_EMAIL: "jexp@example.invalid",
	GIT_COMMITTER_NAME: "jexp",
	GIT_COMMITTER_EMAIL: "jexp@example.invalid",
	GIT_CONFIG_NOSYSTEM: "1",
});
/** Common cell environment (final plan D1, frozen). */
export const COMMON_ENV = Object.freeze({
	JEV_ALIGNMENT_MODE: "deterministic",
	JEV_ALIGNMENT_LATENCY_BUDGET_MS: "250",
	JEV_ADVISOR_MODE: "shadow",
	RRSI_PERIODIC: "off",
	SELF_IMPROVE_SKIP_SMOKE: "1",
	NO_COLOR: "1",
	CI: "1",
	GJC_MODEL_PRESET_REGISTRY_DISABLED: "1",
});

export function modelsYaml(baseUrl) {
	return [
		"providers:", "  jexp-proxy:",
		`    baseUrl: ${JSON.stringify(baseUrl)}`,
		"    api: openai-completions", "    auth: apiKey", "    apiKey: jexp-cell-placeholder-not-a-provider-key",
		"    models:", `      - id: ${CHAT_MODEL}`, "        name: DeepSeek V4.1 Flash Eco via jexp proxy",
		"        api: openai-completions", "        reasoning: false", "        input: [text]",
		"        contextWindow: 1000000", `        maxTokens: ${CHAT_MAX_TOKENS}`,
		"        cost:", `          input: ${CHAT_PRICE.inputPerToken * 1e6}`, `          output: ${CHAT_PRICE.outputPerToken * 1e6}`,
		"          cacheRead: 0", "          cacheWrite: 0", "",
	].join("\n");
}

/** Cell-invariant template view of models.yml for harnessDigest (port/cell → tokens). */
export function modelsYamlTemplate() {
	return modelsYaml("http://127.0.0.1:<PORT>/c/<CELL>/v1");
}

function run(command, args, options) {
	return execFileSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", ...options });
}

function isolatedEnv(home, extra = {}) {
	return { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: home, GJC_CODING_AGENT_DIR: path.join(home, ".gjc", "agent"), XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"), NO_COLOR: "1", CI: "1", GJC_MODEL_PRESET_REGISTRY_DISABLED: "1", ...extra };
}

/** Install plugin bundles into the cell HOME only (parent side, local copy, no network). */
export function installBundles({ home, bundles, gjcBin }) {
	const receipts = [];
	for (const bundle of bundles) {
		run(gjcBin, ["plugin", "install", bundle, "--user"], { env: isolatedEnv(home), cwd: home, timeout: 60000 });
	}
	const listed = JSON.parse(run(gjcBin, ["plugin", "list", "--json"], { env: isolatedEnv(home), cwd: home, timeout: 60000 }));
	for (const entry of listed.gjc ?? []) receipts.push({ name: entry.identity?.name, version: entry.version, manifestHash: entry.manifestHash, enabled: entry.enabled });
	return receipts.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function prepareCell({ stageRoot, cellId, taskDir, spec, condition, checkpointConfig, registration, token, gjcBin, bundles, userHome, laneRoot }) {
	const root = path.join(stageRoot, "cells", cellId);
	const mount = path.join(root, "mount");
	const home = path.join(mount, "home");
	const agent = path.join(home, ".gjc", "agent");
	const temporary = path.join(mount, "tmp");
	const work = path.join(mount, "work");
	const bin = path.join(mount, "bin");
	const protectedDir = path.join(root, "protected");
	for (const dir of [mount, home, agent, temporary, work, bin, protectedDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
	const audit = path.join(mount, "audit.jsonl");
	writeFileSync(audit, "", { mode: 0o600 });
	const seed = path.join(taskDir, "seed");
	if (existsSync(seed)) cpSync(seed, work, { recursive: true });
	const stubs = path.join(taskDir, "stubs", "bin");
	if (existsSync(stubs)) for (const name of readdirSync(stubs)) { cpSync(path.join(stubs, name), path.join(bin, name)); chmodSync(path.join(bin, name), 0o755); }
	const setup = path.join(taskDir, "setup.sh");
	if (existsSync(setup)) run("/bin/sh", [setup], { cwd: work, env: { PATH: "/usr/bin:/bin:/opt/homebrew/bin", HOME: home, ...FIXED_GIT_ENV, JEXP_AUDIT: audit }, timeout: 60000 });
	writeFileSync(path.join(agent, "models.yml"), modelsYaml(registration.baseUrl), { mode: 0o600 });
	const plugins = installBundles({ home, bundles, gjcBin });
	if (checkpointConfig) {
		mkdirSync(path.join(agent, "jev-checkpoint"), { recursive: true, mode: 0o700 });
		writeFileSync(path.join(agent, "jev-checkpoint", "config.json"), JSON.stringify(checkpointConfig), { mode: 0o600 });
	}
	const promptPath = path.join(mount, "prompt.txt");
	writeFileSync(promptPath, spec.prompt, { mode: 0o600 });
	const protectedFiles = {};
	for (const key of ["oracle", "credential", "store"]) {
		protectedFiles[key] = path.join(protectedDir, `${key}.txt`);
		writeFileSync(protectedFiles[key], `owned ${key} denial control\n`, { mode: 0o600 });
	}
	const env = buildProbeEnvironment({
		...isolatedEnv(home, COMMON_ENV),
		PATH: `${bin}:/usr/bin:/bin:/opt/homebrew/bin`,
		TMPDIR: temporary,
		JEXP_AUDIT: audit,
		JEV_CHECKPOINT_ENDPOINT: registration.checkpointUrl,
		...FIXED_GIT_ENV,
	});
	const readRoots = [...new Set([...runtimeReadRoots(), "/opt/homebrew/bin", realpathSync(gjcBin), realpathSync(mount)])];
	const protectedReadRoots = [protectedDir, path.join(userHome, ".gjc"), path.join(userHome, ".ssh"), path.join(userHome, ".gjc-plugin"), laneRoot].filter(existsSync).map((entry) => realpathSync(entry));
	return { cellId, root: realpathSync(root), mount: realpathSync(mount), home, agent, work: realpathSync(work), audit, promptPath, env, readRoots, protectedReadRoots, protectedFiles, gjcBin: realpathSync(gjcBin), condition, plugins, token };
}

export function proveIsolation(cell, proxyHost) {
	const other = startLoopbackListener({ timeoutMs: 20000 });
	try {
		const receipt = probeIsolation({
			mountDir: cell.mount, readRoots: cell.readRoots, protectedReadRoots: cell.protectedReadRoots, protectedFiles: cell.protectedFiles,
			inputPath: cell.promptPath, runtimePath: realpathSync(process.execPath), allowNetwork: true, allowNetworkHosts: [proxyHost], blockedNetworkHost: other.host, env: cell.env,
		});
		if (receipt.status !== "pass") return { ok: false, receipt };
		const profilePath = path.join(cell.root, "live.sb");
		writeFileSync(profilePath, receipt.profile, { mode: 0o600 });
		return { ok: true, receipt, profilePath };
	} finally {
		other.stop?.();
	}
}

/** Run the real session; resolves with stdout/stderr/exit, kills the whole group on wall cap or abort. */
export function runSession({ cell, isolation, signal = null, wallMs = CELL_WALL_MS }) {
	if (!isolation?.ok) throw new Error("isolation_not_proven");
	const digest = createHash("sha256").update(readFileSync(isolation.profilePath, "utf8")).digest("hex");
	if (digest !== isolation.receipt.profileDigest) throw new Error("probe_profile_changed");
	const prompt = readFileSync(cell.promptPath, "utf8");
	const args = ["-f", isolation.profilePath, cell.gjcBin, "--print", "--mode", "json", "--no-session", "--no-title", "--no-mcp", "--no-lsp", "--no-pty", "--tools", CELL_TOOLS, "--model", `jexp-proxy/${CHAT_MODEL}`, "--api-key", cell.token, "--thinking", "off", prompt];
	return new Promise((resolve) => {
		const started = Date.now();
		let stdout = "";
		let stderr = "";
		let failure = null;
		const child = spawn(SEATBELT_BIN, args, { cwd: cell.work, env: cell.env, detached: true, shell: false });
		const kill = (reason) => {
			failure ??= reason;
			try { process.kill(-child.pid, "SIGTERM"); } catch { /* gone */ }
			setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* gone */ } }, 2000).unref();
		};
		const timer = setTimeout(() => kill("timeout"), wallMs);
		const onAbort = () => kill(signal?.reason ?? "aborted");
		signal?.addEventListener("abort", onAbort, { once: true });
		child.stdout.on("data", (chunk) => { stdout += chunk; if (stdout.length > 8 * 1024 * 1024) kill("transcript"); });
		child.stderr.on("data", (chunk) => { stderr += chunk; if (stderr.length > 1024 * 1024) stderr = stderr.slice(-262144); });
		child.on("error", (error) => { failure ??= error.code ?? "spawn"; });
		child.on("close", (code, sig) => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve({ code, signal: sig, failure, wallMs: Date.now() - started, stdout, stderrTail: stderr.slice(-4000), pid: child.pid });
		});
	});
}
