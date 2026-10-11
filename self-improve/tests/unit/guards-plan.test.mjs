import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildGuardPlan, resolveValidatorEntry, runGuards } from "../../lib/guards.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "self-improve-guards-"));
}

test("buildGuardPlan wires built-in checkers and smoke surfaces with a sanitized env", () => {
  const root = tempRoot();
  const scratch = join(root, "repo");
  mkdirSync(scratch, { recursive: true });
  const plan = buildGuardPlan({
    repoRoot: join(root, "repo-src"),
    scratchDir: scratch,
    runRoot: join(root, "run"),
    includeSmoke: true,
    env: { PATH: "/usr/bin", HOME: "/real/home", JEV_ADVISOR_API_KEY: "secret" },
  });
  assert.deepEqual(
    plan.map((guard) => guard.id),
    ["build", "test", "validator", "smoke-verification", "smoke-advisor", "smoke-metrics"],
  );
  for (const guard of plan) {
    assert.equal(guard.cwd, scratch);
    assert.ok(!("JEV_ADVISOR_API_KEY" in guard.env));
    assert.ok(guard.env.HOME.startsWith(join(root, "run")));
  }
  const validator = plan.find((guard) => guard.id === "validator");
  assert.equal(validator.command[1], resolveValidatorEntry(join(root, "repo-src")));
  const noSmoke = buildGuardPlan({
    repoRoot: root,
    scratchDir: scratch,
    runRoot: join(root, "run2"),
    includeSmoke: false,
  });
  assert.deepEqual(noSmoke.map((guard) => guard.id), ["build", "test", "validator"]);
  rmSync(root, { recursive: true, force: true });
});

test("guard home can be relocated outside the run root", () => {
  const root = tempRoot();
  const scratch = join(root, "repo");
  mkdirSync(scratch, { recursive: true });
  const plan = buildGuardPlan({
    repoRoot: root,
    scratchDir: scratch,
    runRoot: join(root, "run"),
    includeSmoke: false,
    homeRoot: join(root, "elsewhere-home"),
  });
  for (const guard of plan) {
    assert.equal(guard.env.HOME, join(root, "elsewhere-home"));
  }
  rmSync(root, { recursive: true, force: true });
});

test("runGuards executes commands, writes logs and reports failures without stopping", async () => {
  const root = tempRoot();
  const logs = join(root, "logs");
  const guards = [
    {
      id: "ok",
      cwd: root,
      env: process.env,
      timeoutMs: 30000,
      command: [process.execPath, "-e", "process.stdout.write('fine')"],
    },
    { id: "fail", cwd: root, env: process.env, timeoutMs: 30000, command: [process.execPath, "-e", "process.exit(3)"] },
    {
      id: "after",
      cwd: root,
      env: process.env,
      timeoutMs: 30000,
      command: [process.execPath, "-e", "process.stdout.write('still runs')"],
    },
  ];
  const results = await runGuards({ guards, runRoot: root, logDir: logs });
  assert.deepEqual(
    results.map((row) => [row.id, row.status]),
    [
      ["ok", "pass"],
      ["fail", "fail"],
      ["after", "pass"],
    ],
  );
  assert.equal(results[1].exitCode, 3);
  assert.match(readFileSync(join(logs, "ok.log"), "utf8"), /fine/);
  assert.match(readFileSync(join(logs, "after.log"), "utf8"), /still runs/);
  rmSync(root, { recursive: true, force: true });
});
