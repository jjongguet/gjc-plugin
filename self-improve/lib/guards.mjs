/**
 * Guard execution for a scratch candidate: deterministic repository-native
 * checkers plus isolated smoke runs, each with a retained log.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { createSmokeEnvironment, sanitizeGuardEnv } from "./isolate.mjs";

/** The workspace-standard validator lives beside the repository, not inside it. */
export function resolveValidatorEntry(repoRoot) {
  const candidates = [
    // Repositories at the workspace root (post-2026-10-12 reorg layout).
    path.resolve(repoRoot, "..", "shared", "workspace-standard", "validator", "cli.mjs"),
    // Session worktrees nested under lanes/ (post-reorg layout).
    path.resolve(repoRoot, "..", "..", "shared", "workspace-standard", "validator", "cli.mjs"),
    // Legacy pre-reorg layout (products/shared beside the workspace repos).
    path.resolve(repoRoot, "..", "products", "shared", "workspace-standard", "validator", "cli.mjs"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

export function buildGuardPlan({ repoRoot, scratchDir, runRoot, includeSmoke = true, env = process.env, homeRoot }) {
  // Guard fixtures must not live under a `.gjc-plugin` path component: plugin
  // result-root boundary detection treats the first such component as the
  // private root, which breaks tests that intentionally relax umbrella modes
  // (e.g. shared/tests/results.test.ts under ~/.gjc-plugin/self-improve).
  const runHome = homeRoot ? path.resolve(homeRoot) : path.join(runRoot, "home");
  fs.mkdirSync(runHome, { recursive: true, mode: 0o700 });
  const guardEnv = { ...sanitizeGuardEnv(env), HOME: runHome, TMPDIR: runHome };
  const guards = [
    { id: "build", cwd: scratchDir, env: guardEnv, timeoutMs: 300000, command: ["bun", "run", "build"] },
    { id: "test", cwd: scratchDir, env: guardEnv, timeoutMs: 300000, command: ["bun", "run", "test"] },
    {
      id: "validator",
      cwd: scratchDir,
      env: guardEnv,
      timeoutMs: 120000,
      command: ["node", resolveValidatorEntry(repoRoot), "validate", "--root", "."],
    },
  ];
  if (includeSmoke) {
    for (const [id, args, plugin] of [
      ["smoke-verification", ["--installed"], "verification-receipts"],
      ["smoke-loop", ["--loop"], "verification-receipts"],
      ["smoke-advisor", ["--advisor"], "jev-advisor"],
      ["smoke-metrics", ["--metrics"], "jev-advisor"],
    ]) {
      guards.push({
        id,
        kind: "smoke",
        plugin,
        cwd: scratchDir,
        env: guardEnv,
        timeoutMs: 240000,
        command: ["node", path.join(scratchDir, "verification-receipts", "scripts", "smoke-host.mjs"), ...args],
      });
    }
  }
  return guards;
}

function writeLog(logDir, name, text) {
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logPath = path.join(logDir, name);
  fs.writeFileSync(logPath, text);
  return logPath;
}

/**
 * Execute a guard plan in order, retaining one log per guard. Every guard runs
 * even after a failure so the full evidence set is available to the caller.
 */
export async function runGuards({ guards, runRoot, logDir }) {
  const results = [];
  let smokeEnv = null;
  const installedIntoSmokeRoot = new Set();
  for (const guard of guards) {
    const started = Date.now();
    let env = guard.env;
    let preLog = "";
    let setupError = null;
    if (guard.kind === "smoke") {
      try {
        if (!smokeEnv) {
          const isolatedRoot = path.join(runRoot, "isolated");
          fs.mkdirSync(isolatedRoot, { recursive: true, mode: 0o700 });
          smokeEnv = await createSmokeEnvironment(isolatedRoot);
        }
        env = smokeEnv;
        if (!installedIntoSmokeRoot.has(guard.plugin)) {
          const install = spawnSync(
            "gjc",
            ["plugin", "install", path.join(guard.cwd, guard.plugin), "--user", "--json"],
            { cwd: guard.cwd, env, encoding: "utf8", timeout: 120000, maxBuffer: 32 * 1024 * 1024 },
          );
          preLog = `$ gjc plugin install ${path.join(guard.cwd, guard.plugin)} --user --json\n${install.stdout ?? ""}\n${install.stderr ?? ""}\n`;
          if (install.status !== 0 || install.error) {
            setupError = `isolated_install_failed: ${install.error ? install.error.message : `exit ${install.status}`}`;
          } else {
            installedIntoSmokeRoot.add(guard.plugin);
          }
        }
      } catch (error) {
        setupError = `smoke_environment_failed: ${error.message}`;
      }
    }
    let proc = null;
    if (!setupError) {
      proc = spawnSync(guard.command[0], guard.command.slice(1), {
        cwd: guard.cwd,
        env,
        encoding: "utf8",
        timeout: guard.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
      });
    }
    const logText = [
      `# guard: ${guard.id}`,
      `# command: ${guard.command.join(" ")}`,
      `# cwd: ${guard.cwd}`,
      preLog,
      proc ? `${proc.stdout ?? ""}\n${proc.stderr ?? ""}` : "",
      setupError ? `# setup error: ${setupError}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    const logPath = writeLog(logDir, `${guard.id}.log`, logText);
    const failed = Boolean(setupError) || !proc || proc.status !== 0 || Boolean(proc.error);
    results.push({
      id: guard.id,
      status: failed ? "fail" : "pass",
      command: guard.command.join(" "),
      exitCode: proc ? (proc.status ?? null) : null,
      signal: proc ? (proc.signal ?? null) : null,
      durationMs: Date.now() - started,
      logPath,
      error: setupError ?? (proc?.error ? String(proc.error.message ?? proc.error) : null),
    });
  }
  return results;
}
