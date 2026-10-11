/**
 * Stochastic evaluation runner: k >= 3 pinned `gjc --print` trials against the
 * loopback scripted provider (local_stub) with median/spread statistics.
 * Live provider calls require explicit approval; without it the run is recorded
 * as skipped instead of fabricating values.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import path from "node:path";
import { createSmokeEnvironment } from "./isolate.mjs";
import { startStubProvider } from "./stub-provider.mjs";

export const DEFAULT_K = 3;
export const DEFAULT_TIMEOUT_MS = 60000;
export const DEFAULT_MODEL_PIN = "openai/gpt-4o";
export const TEXT_FIXTURE_LABEL = "text_fixture";

export function assertLoopbackBaseUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || url.username || url.password) {
    throw new Error(`nonlocal_stub_base_url: ${baseUrl}`);
  }
  return baseUrl;
}

export function buildTrialCommand({ modelPin = DEFAULT_MODEL_PIN, prompt }) {
  if (typeof prompt !== "string" || prompt.length === 0) throw new Error("trial_prompt_required");
  return [
    "gjc",
    "--print",
    "--no-session",
    "--no-title",
    "--no-mcp",
    "--no-lsp",
    "--no-pty",
    "--no-skills",
    "--no-rules",
    "--no-tools",
    "--thinking",
    "off",
    "--model",
    modelPin,
    prompt,
  ];
}

export function buildTextFixturePrompt({ fixturePath }) {
  const absolute = path.resolve(fixturePath);
  const content = fs.readFileSync(absolute, "utf8");
  return { prompt: `${TEXT_FIXTURE_LABEL}:${absolute}\n\n${content}`, textFixture: absolute };
}

export function median(values) {
  const finite = values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
  if (finite.length === 0) return null;
  if (finite.length % 2 === 1) return finite[(finite.length - 1) / 2];
  return finite[finite.length / 2 - 1];
}

export function spread(values) {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length < 2) return 0;
  return Math.max(...finite) - Math.min(...finite);
}

export function extractStubValue(text) {
  const match = /value=(-?\d+(?:\.\d+)?)/.exec(text ?? "");
  return match ? Number.parseFloat(match[1]) : null;
}

function writeLog(logPath, text) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(logPath, text);
  return logPath;
}

function defaultSpawnTrial({ command, cwd, env, timeoutMs, logPath }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    const cap = 16 * 1024 * 1024;
    const finish = (status, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const text = `${stdout}\n${stderr}`;
      writeLog(logPath, `# command: ${command.join(" ")}\n# cwd: ${cwd}\n${text}`);
      resolve({
        status,
        exitCode: extra.exitCode ?? null,
        signal: extra.signal ?? null,
        error: extra.error ?? null,
        text,
        durationMs: Date.now() - started,
        logPath,
      });
    };
    // Never block the parent event loop here: the loopback stub provider lives in
    // this process, so a synchronous wait would deadlock the model call.
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (stdout.length < cap) stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < cap) stderr += chunk;
    });
    child.on("error", (error) => finish("fail", { error }));
    child.on("close", (code, signal) => {
      finish(timedOut ? "timeout" : code === 0 ? "pass" : "fail", { exitCode: code, signal });
    });
  });
}

export async function runStochasticEvaluation(input) {
  const {
    mode = "local_stub",
    k = DEFAULT_K,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    modelPin = DEFAULT_MODEL_PIN,
    prompt,
    textFixture = null,
    liveApproved = false,
    baselineDir,
    candidateDir,
    runRoot,
    minDelta = 0.01,
    deps = {},
  } = input;
  if (!Number.isInteger(k) || k < 3) throw new Error("stochastic_k_must_be_at_least_3");
  if (!baselineDir || !candidateDir || !runRoot) {
    throw new Error("runner_requires baselineDir, candidateDir and runRoot");
  }
  if (mode !== "local_stub" && mode !== "live") throw new Error(`unknown_runner_mode: ${mode}`);
  if (mode === "live" && !liveApproved) {
    return { skipped: true, reason: "live_not_approved", mode, k, runs: [] };
  }

  const spawnTrial = deps.spawnTrial ?? defaultSpawnTrial;
  const extract = deps.extract ?? extractStubValue;
  const logDir = path.join(runRoot, "runner");
  fs.mkdirSync(logDir, { recursive: true, mode: 0o700 });

  let stub = null;
  try {
    const isolatedRoot = path.join(runRoot, "isolated");
    fs.mkdirSync(isolatedRoot, { recursive: true, mode: 0o700 });
    let baseEnv = { ...(await createSmokeEnvironment(isolatedRoot)) };
    if (mode === "local_stub") {
      stub = deps.startStub ? await deps.startStub() : await startStubProvider(deps.stubOptions);
      baseEnv = { ...baseEnv, OPENAI_BASE_URL: assertLoopbackBaseUrl(stub.baseUrl) };
    }
    baseEnv.GJC_NOTIFY = "off";

    const evaluateSide = async (dir, label) => {
      const runs = [];
      for (let index = 0; index < k; index += 1) {
        const trial = await spawnTrial({
          command: buildTrialCommand({ modelPin, prompt }),
          cwd: dir,
          env: baseEnv,
          timeoutMs,
          logPath: path.join(logDir, `${label}-trial-${index + 1}.log`),
        });
        runs.push({
          status: trial.status,
          exitCode: trial.exitCode,
          signal: trial.signal,
          value: trial.status === "pass" ? extract(trial.text) : null,
          durationMs: trial.durationMs,
          logPath: trial.logPath,
        });
      }
      return runs;
    };

    const baselineRuns = await evaluateSide(baselineDir, "baseline");
    const candidateRuns = await evaluateSide(candidateDir, "candidate");
    const summarize = (runs) => {
      const values = runs.map((run) => run.value);
      return { runs: values, median: median(values), spread: spread(values) };
    };
    const baseline = summarize(baselineRuns);
    const candidate = summarize(candidateRuns);
    const delta =
      baseline.median === null || candidate.median === null ? null : candidate.median - baseline.median;

    return {
      skipped: false,
      mode,
      k,
      modelPin,
      textFixtureLabel: textFixture ? TEXT_FIXTURE_LABEL : null,
      textFixture,
      baseline,
      candidate,
      delta,
      floor: Math.max(minDelta, baseline.spread),
      trials: { baseline: baselineRuns, candidate: candidateRuns },
      logs: [...baselineRuns, ...candidateRuns].map((run) => run.logPath),
      stubCalls: stub ? stub.calls() : null,
    };
  } finally {
    if (stub) await stub.close();
  }
}
