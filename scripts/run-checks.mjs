#!/usr/bin/env node
/**
 * Runs the repository's `test:*` steps concurrently.
 *
 * `bun run test` used to chain the module suites with `&&`, so the wall clock
 * was the sum of every suite even though the suites only share this checkout.
 * The runner keeps the same step set (every `test:*` script in package.json, in
 * declaration order), bounds how many run at once, and fails the whole run when
 * any step fails. Each step's output is reprinted as one block under its own
 * header, so green runs keep the boundary/skip disclosure the serial chain had
 * and red runs keep the failing suite's full output.
 *
 * `GJC_TEST_CONCURRENCY=<n>` overrides the default fan-out (4, further capped
 * by the machine's parallelism and the step count); `1` restores a serial run.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_CONCURRENCY = 4;
// Bounded retention per step: a suite that floods stdout must not grow the
// runner's memory, and the retained tail is what a failure needs.
const OUTPUT_LIMIT_BYTES = 8 * 1024 * 1024;

const scripts = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).scripts;
const steps = Object.keys(scripts).filter((name) => name.startsWith("test:"));

if (steps.length === 0) {
  process.stderr.write("FAIL: package.json declares no test:* steps\n");
  process.exit(1);
}

const running = new Set();

function resolveConcurrency(stepCount) {
  const raw = process.env.GJC_TEST_CONCURRENCY;
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1) {
      process.stderr.write(`FAIL: GJC_TEST_CONCURRENCY must be a positive integer, got ${JSON.stringify(raw)}\n`);
      process.exit(2);
    }
    return Math.min(parsed, stepCount);
  }
  return Math.max(1, Math.min(DEFAULT_CONCURRENCY, availableParallelism(), stepCount));
}

function killGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {
    // Already exited; nothing to stop.
  }
}

function runStep(name) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("bun", ["run", name], {
      cwd: ROOT,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    running.add(child);
    let output = "";
    let truncated = false;
    let spawnError = null;
    const collect = (chunk) => {
      output += chunk.toString("utf8");
      if (output.length > OUTPUT_LIMIT_BYTES) {
        output = output.slice(-OUTPUT_LIMIT_BYTES);
        truncated = true;
      }
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => {
      running.delete(child);
      resolve({
        name,
        code,
        signal,
        error: spawnError,
        output,
        truncated,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

function printBlock(result, position) {
  const seconds = (result.durationMs / 1000).toFixed(1);
  const heading = result.code === 0 && !result.error ? "ok" : "FAIL";
  process.stdout.write(`\n--- [${position}/${steps.length}] ${heading} ${result.name} (${seconds}s) ---\n`);
  if (result.error) process.stdout.write(`# spawn error: ${result.error.message}\n`);
  if (result.signal) process.stdout.write(`# signal: ${result.signal}\n`);
  if (result.truncated) {
    process.stdout.write(`# output truncated: kept the last ${(OUTPUT_LIMIT_BYTES / (1024 * 1024)).toFixed(0)} MiB\n`);
  }
  if (result.output.length > 0) {
    process.stdout.write(result.output.endsWith("\n") ? result.output : `${result.output}\n`);
  }
}

async function main() {
  const concurrency = resolveConcurrency(steps.length);
  const startedAt = Date.now();
  const mode = concurrency === 1 ? " (serial)" : "";
  process.stdout.write(
    `test: ${steps.length} steps, concurrency ${concurrency}${mode}\n` + `test: ${steps.join(" ")}\n`,
  );

  const pending = [...steps];
  const results = [];
  const worker = async () => {
    while (pending.length > 0) {
      const name = pending.shift();
      const result = await runStep(name);
      results.push(result);
      printBlock(result, results.length);
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const byStep = new Map(results.map((result) => [result.name, result]));
  const failures = steps.filter((name) => {
    const result = byStep.get(name);
    return result.code !== 0 || result.error !== null;
  });
  const wallSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);

  process.stdout.write(`\ntest: ${steps.length} steps, ${failures.length} failed, ${wallSeconds}s wall\n`);
  for (const name of steps) {
    const result = byStep.get(name);
    const status = result.code === 0 && !result.error ? "ok  " : "FAIL";
    const seconds = (result.durationMs / 1000).toFixed(1).padStart(6);
    process.stdout.write(`  ${status} ${name.padEnd(24)} ${seconds}s\n`);
  }
  if (failures.length > 0) {
    process.stdout.write(`\ntest: failed steps: ${failures.join(" ")}\n`);
    process.exitCode = 1;
  }
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    process.stderr.write(`test: ${signal}, stopping ${running.size} step(s)\n`);
    for (const child of running) killGroup(child, "SIGTERM");
    setTimeout(() => {
      for (const child of running) killGroup(child, "SIGKILL");
      process.exit(130);
    }, 2000);
  });
}

await main();
