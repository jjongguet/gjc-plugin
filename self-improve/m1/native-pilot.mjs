import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildProbeEnvironment, probeIsolation, runtimeReadRoots, SEATBELT_BIN } from "../lib/isolation-runtime.mjs";
import { digest } from "./pilot-oracle.mjs";

/** Lossless public task content; artifact identity stays in parent receipts. */
export function taskPrompt(task, feedback = null) {
  const text = `${task.raw}\nconfidenceKind=${task.confidenceKind}\n${task.contract}\n${task.outputContract}`;
  return feedback ? `${text}\nPrevious output: ${feedback.output}\nPublic schema errors: ${JSON.stringify(feedback.errors)}` : text;
}

/** Scratch-only configuration; no inherited auth, plugin registry, hooks or session ids. */
export function prepareCell({ root, arm, task, ruleText, proxy, gjcBin, userHome }) {
  root = realpathSync(root);
  const mount = path.join(root, "mount");
  const home = path.join(mount, "home");
  const agent = path.join(home, ".gjc", "agent");
  const temporary = path.join(mount, "tmp");
  const protectedDir = path.join(root, "protected");
  for (const dir of [mount, home, agent, temporary, protectedDir]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const inputPath = path.join(mount, "task.json");
  writeFileSync(inputPath, JSON.stringify(task), { mode: 0o600 });
  const protectedFiles = {};
  for (const key of ["oracle", "credential", "store"]) {
    protectedFiles[key] = path.join(protectedDir, `${key}.txt`);
    writeFileSync(protectedFiles[key], `owned ${key} denial control\n`, { mode: 0o600 });
  }
  if (arm === "B2") writeFileSync(path.join(agent, "RULES.md"), ruleText, { mode: 0o600 });
  // This is the native model configuration, not a prompt append or upstream key.
  writeFileSync(path.join(agent, "models.yml"), [
    "providers:", "  harness-pilot:",
    `    baseUrl: ${JSON.stringify(proxy.url)}`,
    "    api: openai-completions", "    auth: apiKey", "    apiKey: local-pilot-placeholder-not-a-provider-key",
    "    models:", "      - id: gpt-4.1-mini", "        name: Bounded pilot transport",
    "        api: openai-completions", "        reasoning: false", "        input: [text]",
    "        contextWindow: 1000000", "        maxTokens: 300",
    "        cost:", "          input: 0.4", "          output: 1.6",
    "          cacheRead: 0.1", "          cacheWrite: 0", "",
  ].join("\n"), { mode: 0o600 });
  const env = buildProbeEnvironment({
    PATH: "/usr/bin:/bin:/opt/homebrew/bin",
    HOME: home, TMPDIR: temporary, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"), XDG_STATE_HOME: path.join(home, ".local", "state"), XDG_CACHE_HOME: path.join(home, ".cache"),
    GJC_CODING_AGENT_DIR: agent, GJC_AGENT_DIR: agent,
    GJC_MODEL_PRESET_REGISTRY_DISABLED: "1", JEV_ADVISOR_PROVIDER: "off", RRSI_PERIODIC: "off",
    NO_COLOR: "1", CI: "1",
  });
  const readRoots = [...runtimeReadRoots(), realpathSync(gjcBin), realpathSync(mount)];
  const protectedReadRoots = [protectedDir, path.join(userHome, ".gjc"), path.join(userHome, ".ssh"), path.join(userHome, ".gjc-plugin")].filter(existsSync).map((p) => realpathSync(p));
  return { mount, agent, env, inputPath, protectedFiles, readRoots: [...new Set(readRoots)], protectedReadRoots, gjcBin: realpathSync(gjcBin), arm };
}

export function proveCellIsolation(cell, { proxy, blockedNetworkHost }) {
  const receipt = probeIsolation({
    mountDir: cell.mount, readRoots: cell.readRoots, protectedReadRoots: cell.protectedReadRoots,
    protectedFiles: cell.protectedFiles, inputPath: cell.inputPath, runtimePath: realpathSync(process.execPath),
    allowNetwork: true, allowNetworkHosts: [proxy.host], blockedNetworkHost, env: cell.env,
  });
  if (receipt.status !== "pass") return { ok: false, receipt };
  const profilePath = path.join(path.dirname(cell.mount), "live.sb");
  writeFileSync(profilePath, receipt.profile, { mode: 0o600 });
  return { ok: true, receipt, profilePath };
}

/** Starts only the real installed binary under the exact successful probe profile. */
export async function runNativeAttempt({ cell, isolation, token, prompt, timeoutMs = 30000 }) {
  if (!isolation.ok || isolation.receipt.status !== "pass") throw new Error("isolation_not_proven");
  if (digest(readFileSync(isolation.profilePath, "utf8")) !== isolation.receipt.profileDigest) throw new Error("probe_profile_changed");
  const envDigest = digest(JSON.stringify(Object.keys(cell.env).sort().map((key) => [key, cell.env[key]])));
  if (envDigest !== isolation.receipt.envBinding.digest) throw new Error("probe_environment_changed");
  const args = ["-f", isolation.profilePath, cell.gjcBin, "--print", "--no-session", "--no-title", "--no-mcp", "--no-lsp", "--no-pty", "--no-tools", "--model", "harness-pilot/gpt-4.1-mini", "--api-key", token, "--thinking", "off", "--system-prompt", "Return JSON per task contract. No tools.", prompt];
  return await new Promise((resolve) => {
    const started = Date.now();
    let stdout = "";
    let stderr = "";
    let failure = null;
    const child = spawn(SEATBELT_BIN, args, { cwd: cell.mount, env: cell.env, detached: true, shell: false });
    const stop = (reason) => { failure ??= reason; try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); } };
    const timer = setTimeout(() => stop("child_timeout"), timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk; if (Buffer.byteLength(stdout) > 65536) stop("stdout_limit"); });
    child.stderr.on("data", (chunk) => { stderr += chunk; if (Buffer.byteLength(stderr) > 65536) stop("stderr_limit"); });
    child.on("error", (error) => { failure ??= error.code ?? "spawn_failed"; });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, error: failure, wallMs: Date.now() - started, stdout, stderr });
    });
  });
}
