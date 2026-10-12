import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildTextFixturePrompt, runStochasticEvaluation } from "../../lib/runner.mjs";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = resolve(SELF_IMPROVE_DIR, "..");

test("real gjc trials run against the loopback stub with k>=3 statistics", async () => {
  const runRoot = mkdtempSync(join(tmpdir(), "self-improve-runner-"));
  let passed = false;
  try {
    const fixturePath = join(REPO_ROOT, "jev-advisor", "subskills", "jev-advisor", "SKILL.md");
    const built = buildTextFixturePrompt({ fixturePath });
    const result = await runStochasticEvaluation({
      mode: "local_stub",
      k: 3,
      baselineDir: REPO_ROOT,
      candidateDir: REPO_ROOT,
      runRoot,
      prompt: built.prompt,
      textFixture: built.textFixture,
      deps: { stubOptions: { scriptedTexts: ["value=1", "value=2", "value=3", "value=2", "value=3", "value=4"] } },
    });
    assert.equal(result.skipped, false);
    assert.equal(result.mode, "local_stub");
    assert.equal(result.textFixtureLabel, "text_fixture");
    assert.deepEqual(result.baseline.runs, [1, 2, 3]);
    assert.deepEqual(result.candidate.runs, [2, 3, 4]);
    assert.equal(result.baseline.median, 2);
    assert.equal(result.candidate.median, 3);
    assert.equal(result.delta, 1);
    assert.equal(result.floor, 2);
    assert.equal(result.stubCalls, 6);
    for (const run of [...result.trials.baseline, ...result.trials.candidate]) {
      assert.equal(run.status, "pass");
      assert.ok(existsSync(run.logPath), run.logPath);
    }
    assert.ok(readFileSync(result.trials.baseline[0].logPath, "utf8").includes("value=1"));
    process.stdout.write(
      `runner stub: baseline ${result.baseline.median} candidate ${result.candidate.median} delta ${result.delta} floor ${result.floor} stubCalls ${result.stubCalls}\n`,
    );
    passed = true;
  } finally {
    if (passed) rmSync(runRoot, { recursive: true, force: true });
    else process.stderr.write(`runner scratch retained at ${runRoot}\n`);
  }
});
