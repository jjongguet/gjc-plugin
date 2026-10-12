import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildGuardPlan, runGuards } from "../../lib/guards.mjs";
import { computeHarnessDigest, createScratchCopy } from "../../lib/isolate.mjs";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = resolve(SELF_IMPROVE_DIR, "..");

test("scratch-copy guards run green and leave the live harness digest unchanged", async () => {
  const runRoot = mkdtempSync(join(tmpdir(), "self-improve-integration-"));
  let passed = false;
  try {
    const digestBefore = computeHarnessDigest();
    const scratch = createScratchCopy({ repoRoot: REPO_ROOT, destDir: join(runRoot, "repo") });
    assert.match(scratch.baseCommit, /^[0-9a-f]{7,}$/);
    const guards = buildGuardPlan({
      repoRoot: REPO_ROOT,
      scratchDir: scratch.scratchDir,
      runRoot,
      includeSmoke: process.env.SELF_IMPROVE_SKIP_SMOKE !== "1",
    });
    const results = await runGuards({ guards, runRoot, logDir: join(runRoot, "logs") });
    const digestAfter = computeHarnessDigest();
    const summary = results.map((row) => `${row.id}=${row.status}(${row.durationMs}ms)`).join(" ");
    assert.equal(
      digestAfter.rootHash,
      digestBefore.rootHash,
      `live harness digest changed during scratch guards: ${summary}`,
    );
    const failures = results.filter((row) => row.status !== "pass");
    assert.deepEqual(
      failures.map((row) => ({ id: row.id, error: row.error, log: row.logPath })),
      [],
      `guard failures: ${summary}`,
    );
    process.stdout.write(
      `integration guards: ${summary}\nlive digest: ${digestBefore.rootHash}\nlogs: ${join(runRoot, "logs")}\n`,
    );
    passed = true;
  } finally {
    if (passed && process.env.SELF_IMPROVE_KEEP_LOGS !== "1") {
      rmSync(runRoot, { recursive: true, force: true });
    } else {
      process.stderr.write(`integration scratch retained at ${runRoot}\n`);
    }
  }
});
