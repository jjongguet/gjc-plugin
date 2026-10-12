import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MODEL_PIN,
  assertLoopbackBaseUrl,
  buildTextFixturePrompt,
  buildTrialCommand,
  median,
  runStochasticEvaluation,
  spread,
} from "../../lib/runner.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "self-improve-runner-unit-"));
}

test("median and spread use finite samples with a deterministic lower-middle median", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2);
  assert.equal(median([null, Number.NaN, 5]), 5);
  assert.equal(median([null]), null);
  assert.equal(spread([1, 3, 2]), 2);
  assert.equal(spread([7]), 0);
  assert.equal(spread([]), 0);
});

test("trial command carries the pinned surface and the model pin", () => {
  const command = buildTrialCommand({ prompt: "hello" });
  assert.equal(command[0], "gjc");
  for (const flag of [
    "--print",
    "--no-session",
    "--no-skills",
    "--no-rules",
    "--no-tools",
    "--no-mcp",
    "--no-lsp",
    "--no-pty",
  ]) {
    assert.ok(command.includes(flag), flag);
  }
  assert.deepEqual(
    command.slice(command.indexOf("--thinking"), command.indexOf("--thinking") + 2),
    ["--thinking", "off"],
  );
  assert.deepEqual(command.slice(command.indexOf("--model"), command.indexOf("--model") + 2), ["--model", DEFAULT_MODEL_PIN]);
  assert.equal(command.at(-1), "hello");
  assert.throws(() => buildTrialCommand({ prompt: "" }), /trial_prompt_required/);
});

test("the stub base URL is constrained to loopback", () => {
  assert.equal(assertLoopbackBaseUrl("http://127.0.0.1:9/v1"), "http://127.0.0.1:9/v1");
  assert.throws(() => assertLoopbackBaseUrl("http://example.com/v1"), /nonlocal_stub_base_url/);
  assert.throws(() => assertLoopbackBaseUrl("http://user:key@127.0.0.1:9/v1"), /nonlocal_stub_base_url/);
  assert.throws(() => assertLoopbackBaseUrl("https://127.0.0.1:9/v1"), /nonlocal_stub_base_url/);
});

test("text fixture prompts carry the labeling marker", () => {
  const root = tempRoot();
  const file = join(root, "SKILL.md");
  writeFileSync(file, "# fixture content\n");
  const built = buildTextFixturePrompt({ fixturePath: file });
  assert.equal(built.textFixture, file);
  assert.ok(built.prompt.startsWith(`text_fixture:${file}`));
  assert.ok(built.prompt.includes("# fixture content"));
  rmSync(root, { recursive: true, force: true });
});

test("k below three is rejected and live mode without approval is skipped without spawning", async () => {
  const root = tempRoot();
  await assert.rejects(
    runStochasticEvaluation({ k: 2, baselineDir: root, candidateDir: root, runRoot: root, prompt: "x" }),
    /stochastic_k_must_be_at_least_3/,
  );
  let spawnCalls = 0;
  const result = await runStochasticEvaluation({
    mode: "live",
    k: 3,
    baselineDir: root,
    candidateDir: root,
    runRoot: root,
    prompt: "x",
    deps: {
      spawnTrial: () => {
        spawnCalls += 1;
        return { status: "pass", exitCode: 0, text: "value=1", durationMs: 1, logPath: null };
      },
    },
  });
  assert.deepEqual({ skipped: result.skipped, reason: result.reason }, { skipped: true, reason: "live_not_approved" });
  assert.equal(spawnCalls, 0);
  rmSync(root, { recursive: true, force: true });
});

test("local_stub statistics use injected trials and record the stub environment", async () => {
  const root = tempRoot();
  const scripted = [1, 2, 3, 2, 3, 4];
  let call = 0;
  const seen = [];
  const result = await runStochasticEvaluation({
    mode: "local_stub",
    k: 3,
    baselineDir: root,
    candidateDir: root,
    runRoot: root,
    prompt: "x",
    deps: {
      startStub: async () => ({ baseUrl: "http://127.0.0.1:1/v1", calls: () => call, close: async () => {} }),
      spawnTrial: ({ env, command }) => {
        seen.push({ notify: env.GJC_NOTIFY, baseUrl: env.OPENAI_BASE_URL, hasNoSkills: command.includes("--no-skills") });
        const value = scripted[call];
        call += 1;
        return { status: "pass", exitCode: 0, text: `value=${value}`, durationMs: 1, logPath: join(root, "log.txt") };
      },
    },
  });
  assert.equal(result.skipped, false);
  assert.equal(result.mode, "local_stub");
  assert.deepEqual(result.baseline.runs, [1, 2, 3]);
  assert.deepEqual(result.candidate.runs, [2, 3, 4]);
  assert.equal(result.baseline.median, 2);
  assert.equal(result.candidate.median, 3);
  assert.equal(result.delta, 1);
  assert.equal(result.floor, 2);
  assert.ok(seen.every((entry) => entry.notify === "off" && entry.baseUrl === "http://127.0.0.1:1/v1" && entry.hasNoSkills));
  rmSync(root, { recursive: true, force: true });
});

test("failed and timed-out trials surface as null values and keep their status", async () => {
  const root = tempRoot();
  let call = 0;
  const statuses = ["pass", "timeout", "fail", "pass", "pass", "pass"];
  const result = await runStochasticEvaluation({
    mode: "local_stub",
    k: 3,
    baselineDir: root,
    candidateDir: root,
    runRoot: root,
    prompt: "x",
    deps: {
      startStub: async () => ({ baseUrl: "http://127.0.0.1:1/v1", calls: () => call, close: async () => {} }),
      spawnTrial: () => {
        const status = statuses[call];
        call += 1;
        return {
          status,
          exitCode: status === "pass" ? 0 : 1,
          text: status === "pass" ? "value=5" : "boom",
          durationMs: 1,
          logPath: join(root, "log.txt"),
        };
      },
    },
  });
  assert.equal(result.baseline.runs[1], null);
  assert.equal(result.trials.baseline[1].status, "timeout");
  assert.equal(result.baseline.median, 5);
  rmSync(root, { recursive: true, force: true });
});
