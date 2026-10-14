import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // A workspace tree beside the repo keeps the validator guard in the plan.
  const repoRoot = join(root, "repo-src");
  mkdirSync(join(root, "shared", "workspace-standard", "validator"), { recursive: true });
  writeFileSync(join(root, "shared", "workspace-standard", "validator", "cli.mjs"), "");
  const plan = buildGuardPlan({
    repoRoot,
    scratchDir: scratch,
    runRoot: join(root, "run"),
    includeSmoke: true,
    env: { PATH: "/usr/bin", HOME: "/real/home", JEV_ADVISOR_API_KEY: "secret" },
  });
  assert.deepEqual(
    plan.map((guard) => guard.id),
    ["build", "test", "validator", "smoke-verification", "smoke-loop", "smoke-advisor", "smoke-metrics"],
  );
  for (const guard of plan) {
    assert.equal(guard.cwd, scratch);
    assert.ok(!("JEV_ADVISOR_API_KEY" in guard.env));
    assert.ok(guard.env.HOME.startsWith(join(root, "run")));
  }
  const validator = plan.find((guard) => guard.id === "validator");
  assert.equal(validator.command[1], resolveValidatorEntry(repoRoot));
  // Without a workspace tree beside the repo (hosted CI checkout), the
  // validator guard is planned out instead of failing on a missing entry file.
  const noSmoke = buildGuardPlan({
    repoRoot: join(root, "absent", "deeper", "repo"),
    scratchDir: scratch,
    runRoot: join(root, "run2"),
    includeSmoke: false,
  });
  assert.deepEqual(noSmoke.map((guard) => guard.id), ["build", "test"]);
  rmSync(root, { recursive: true, force: true });
});

test("resolveValidatorEntry finds the validator across workspace layouts", () => {
  const root = tempRoot();
  const rel = join("workspace-standard", "validator", "cli.mjs");
  try {
    // Repositories at the workspace root: <base>/<repo> with <base>/shared beside them.
    const flatRepo = join(root, "flat", "repo");
    mkdirSync(join(root, "flat", "shared", "workspace-standard", "validator"), { recursive: true });
    writeFileSync(join(root, "flat", "shared", rel), "");
    assert.equal(resolveValidatorEntry(flatRepo), join(root, "flat", "shared", rel));

    // Session worktrees under lanes/: <base>/lanes/<name> with <base>/shared at the top.
    const laneRepo = join(root, "laned", "lanes", "name");
    mkdirSync(join(root, "laned", "shared", "workspace-standard", "validator"), { recursive: true });
    writeFileSync(join(root, "laned", "shared", rel), "");
    assert.equal(resolveValidatorEntry(laneRepo), join(root, "laned", "shared", rel));

    // Legacy pre-reorg layout: <base>/<repo> with <base>/products/shared beside it.
    const legacyRepo = join(root, "legacy", "repo");
    mkdirSync(join(root, "legacy", "products", "shared", "workspace-standard", "validator"), { recursive: true });
    writeFileSync(join(root, "legacy", "products", "shared", rel), "");
    assert.equal(resolveValidatorEntry(legacyRepo), join(root, "legacy", "products", "shared", rel));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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
