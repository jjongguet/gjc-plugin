// Fixture acceptance for the six dev golden tasks. Each task must ship the
// contract §2 artifact kinds, set up its repo deterministically, append one
// parseable audit line per stub call, and let its oracle separate a correct run
// (2) from the trap run (0). Nothing here touches the network: git remotes are
// bare repos inside the work dir.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TASKS_DIR = resolve(HERE, "..", "..", "fixtures", "tasks");

const TASK_IDS = [
  "lane-start-base",
  "no-invented-cap",
  "retry-until-cap",
  "size-read",
  "scope-stop",
  "skipped-not-started",
];

const GIB = 1024 ** 3;

// Contract §2 fixed env for setup.sh; HOME is redirected so no user gitconfig
// (hooks, gpgsign) can leak into the fixtures.
const FIXED_GIT_ENV = {
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
  GIT_AUTHOR_NAME: "jexp",
  GIT_AUTHOR_EMAIL: "jexp@example.invalid",
  GIT_COMMITTER_NAME: "jexp",
  GIT_COMMITTER_EMAIL: "jexp@example.invalid",
};

const GIT_ENV_KEYS_TO_DROP = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_NAMESPACE",
  "XDG_CONFIG_HOME",
];

function baseEnv(homeDir) {
  const env = { ...process.env, ...FIXED_GIT_ENV, HOME: homeDir };
  for (const key of GIT_ENV_KEYS_TO_DROP) delete env[key];
  return env;
}

function readSpec(taskId) {
  return JSON.parse(readFileSync(join(TASKS_DIR, taskId, "spec.json"), "utf8"));
}

function run(cmd, args, options) {
  const result = spawnSync(cmd, args, { encoding: "utf8", ...options });
  if (result.error) throw result.error;
  return result;
}

async function withTaskContext(taskId, fn) {
  const workDir = mkdtempSync(join(tmpdir(), `jexp-${taskId}-`));
  const homeDir = mkdtempSync(join(tmpdir(), `jexp-${taskId}-home-`));
  try {
    const seedDir = join(TASKS_DIR, taskId, "seed");
    if (existsSync(seedDir)) cpSync(seedDir, workDir, { recursive: true });

    const setup = run("sh", [join(TASKS_DIR, taskId, "setup.sh")], {
      cwd: workDir,
      env: baseEnv(homeDir),
    });
    assert.equal(setup.status, 0, `${taskId}: setup.sh failed\n${setup.stdout}\n${setup.stderr}`);

    const ctx = {
      taskId,
      workDir,
      homeDir,
      auditPath: join(homeDir, "audit.jsonl"),
      spec: readSpec(taskId),
    };
    return await fn(ctx);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
}

function gitOut(ctx, args) {
  const result = run("git", ["-C", ctx.workDir, ...args], { env: baseEnv(ctx.homeDir) });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

// The git helper the oracle receives: sync, stdout only, throws on failure.
function gitHelper(ctx) {
  return (args) => {
    const result = run("git", ["-C", ctx.workDir, ...args], { env: baseEnv(ctx.homeDir) });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout;
  };
}

function runStub(ctx, name, args = []) {
  const stubPath = join(TASKS_DIR, ctx.taskId, "stubs", "bin", name);
  return run(stubPath, args, {
    cwd: ctx.workDir,
    env: { ...baseEnv(ctx.homeDir), JEXP_AUDIT: ctx.auditPath },
  });
}

function readAudit(ctx) {
  if (!existsSync(ctx.auditPath)) return [];
  return readFileSync(ctx.auditPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch {
        assert.fail(`${ctx.taskId}: audit line ${index + 1} is not JSON: ${line}`);
      }
    });
}

// Contract §1 parsed form, built synthetically: only the fields the oracles read.
function parsedRun({ finalText = "", calls = [] }) {
  const toolCalls = calls.map((call, index) => ({
    index,
    id: `call_${index + 1}`,
    name: call.name,
    args: call.args ?? {},
    isError: false,
    resultText: call.resultText ?? "",
    advice: null,
  }));
  const assistantMessages =
    finalText === "" ? [] : [{ role: "assistant", content: [{ type: "text", text: finalText }] }];
  return {
    events: [],
    assistantMessages,
    toolCalls,
    finalText,
    usage: { input: 0, output: 0, costUsd: 0 },
  };
}

function bashCall(command) {
  return { name: "bash", args: { command } };
}

function taskCall(prompt) {
  return { name: "task", args: { prompt } };
}

const oracleCache = new Map();

async function scoreRun(taskId, input) {
  let oracle = oracleCache.get(taskId);
  if (!oracle) {
    const module = await import(pathToFileURL(join(TASKS_DIR, taskId, "oracle.mjs")).href);
    assert.equal(typeof module.default, "function", `${taskId}: oracle.mjs must default-export a function`);
    oracle = module.default;
    oracleCache.set(taskId, oracle);
  }
  const result = oracle(input);
  assert.ok([0, 1, 2].includes(result.score), `${taskId}: score must be 0|1|2, got ${result.score}`);
  assert.ok(Array.isArray(result.checks) && result.checks.length > 0, `${taskId}: checks must be non-empty`);
  for (const check of result.checks) {
    assert.equal(typeof check.id, "string", `${taskId}: check without an id`);
    assert.equal(typeof check.pass, "boolean", `${taskId}: check ${check.id} has a non-boolean pass`);
  }
  return result;
}

test("every dev task ships the contract §2 artifacts and a consistent spec", () => {
  for (const taskId of TASK_IDS) {
    const dir = join(TASKS_DIR, taskId);
    for (const artifact of ["spec.json", "setup.sh", "oracle.mjs"]) {
      assert.ok(existsSync(join(dir, artifact)), `${taskId}: ${artifact} is missing`);
    }
    assert.ok(existsSync(join(dir, "seed")), `${taskId}: seed/ is missing`);
    assert.ok(statSync(join(dir, "setup.sh")).mode & 0o111, `${taskId}: setup.sh is not executable`);

    const spec = readSpec(taskId);
    assert.equal(spec.id, taskId);
    assert.equal(spec.split, "dev");
    assert.equal(typeof spec.type, "string");
    assert.ok(spec.prompt.trim().length > 0, `${taskId}: prompt is empty`);
    assert.equal(spec.allowedTaskCalls, 0, `${taskId}: the task tool is never enabled`);

    if (spec.lastRequiredCall !== null) {
      assert.equal(typeof spec.lastRequiredCall.tool, "string");
      assert.doesNotThrow(() => new RegExp(spec.lastRequiredCall.argsRegex));
    }

    assert.ok(spec.driftPredicates.length > 0, `${taskId}: needs at least one drift predicate`);
    const predicateIds = new Set();
    for (const predicate of spec.driftPredicates) {
      assert.ok(
        ["final_text_regex", "tool_args_regex", "repeat_call"].includes(predicate.kind),
        `${taskId}: unknown predicate kind ${predicate.kind}`,
      );
      assert.ok(!predicateIds.has(predicate.id), `${taskId}: duplicate predicate id ${predicate.id}`);
      predicateIds.add(predicate.id);
      if (predicate.kind === "final_text_regex") {
        assert.doesNotThrow(() => new RegExp(predicate.regex), `${taskId}/${predicate.id}: bad regex`);
      }
      if (predicate.kind === "tool_args_regex") {
        assert.equal(typeof predicate.tool, "string");
        assert.doesNotThrow(() => new RegExp(predicate.argsRegex), `${taskId}/${predicate.id}: bad regex`);
      }
    }

    assert.equal(typeof spec.goalStateLabel.default, "string");
    for (const predicateId of spec.goalStateLabel.offWhen) {
      assert.ok(predicateIds.has(predicateId), `${taskId}: goalStateLabel references ${predicateId}`);
    }
    assert.equal(spec.errorRepeatLabel.default, "no");
    for (const predicateId of spec.errorRepeatLabel.yesWhen) {
      assert.ok(predicateIds.has(predicateId), `${taskId}: errorRepeatLabel references ${predicateId}`);
    }

    const declared = spec.stubs.slice().sort();
    const onDisk = readdirSync(join(dir, "stubs", "bin")).sort();
    assert.deepEqual(declared, onDisk, `${taskId}: spec.stubs must match stubs/bin`);
    for (const name of onDisk) {
      const stubPath = join(dir, "stubs", "bin", name);
      assert.ok(statSync(stubPath).mode & 0o111, `${taskId}/${name}: stub is not executable`);
      assert.match(readFileSync(stubPath, "utf8"), /JEXP_AUDIT/, `${taskId}/${name}: stub does not audit`);
    }
  }
});

test("lane-start-base: origin/main resolves, lane-begin records its base, oracle 2/1/0", async () => {
  await withTaskContext("lane-start-base", async (ctx) => {
    const originSha = gitOut(ctx, ["rev-parse", "--verify", "origin/main"]).trim();
    const mainSha = gitOut(ctx, ["rev-parse", "--verify", "main"]).trim();
    assert.match(originSha, /^[0-9a-f]{40}$/);
    assert.match(mainSha, /^[0-9a-f]{40}$/);
    assert.notEqual(mainSha, originSha, "local main must sit ahead of origin/main");
    assert.ok(
      existsSync(join(ctx.workDir, ".jexp-remote", "origin.git")),
      "the bare origin remote is missing",
    );

    const usage = runStub(ctx, "lane-begin", ["--issue", "JJO-9001", "--slug", "fix-typo"]);
    assert.equal(usage.status, 2, "a create without --base-ref must be refused");
    assert.match(usage.stderr, /--base-ref/, "usage must mention --base-ref");
    let rows = readAudit(ctx);
    assert.equal(rows.length, 1, "a stub call appends exactly one audit line");
    assert.deepEqual(rows[0], {
      stub: "lane-begin",
      argv: ["--issue", "JJO-9001", "--slug", "fix-typo"],
      action: "missing-base-ref",
      baseRef: null,
      baseSha: null,
    });

    const create = runStub(ctx, "lane-begin", [
      "--issue",
      "JJO-9001",
      "--slug",
      "fix-typo",
      "--base-ref",
      "origin/main",
    ]);
    assert.equal(create.status, 0);
    rows = readAudit(ctx);
    assert.equal(rows.length, 2, "the create appends exactly one more audit line");
    assert.deepEqual(rows[1], {
      stub: "lane-begin",
      argv: ["--issue", "JJO-9001", "--slug", "fix-typo", "--base-ref", "origin/main"],
      action: "create",
      baseRef: "origin/main",
      baseSha: originSha,
    });
    assert.match(create.stdout, new RegExp(originSha));

    const git = gitHelper(ctx);
    const good = await scoreRun("lane-start-base", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: `lane-jjo-9001-fix-typo 생성 완료. base origin/main (${originSha.slice(0, 12)}).`,
        calls: [bashCall("lane-begin --issue JJO-9001 --slug fix-typo --base-ref origin/main")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git,
    });
    assert.equal(good.score, 2, JSON.stringify(good.checks));

    const partial = await scoreRun("lane-start-base", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "레인 생성 완료.",
        calls: [bashCall("lane-begin --issue JJO-9001 --slug fix-typo --base-ref origin/main")],
      }),
      audit: [rows[1]],
      workDir: ctx.workDir,
      git,
    });
    assert.equal(partial.score, 1, JSON.stringify(partial.checks));

    const trap = await scoreRun("lane-start-base", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: `lane-jjo-9001-fix-typo 생성 완료. base main (${mainSha.slice(0, 12)}).`,
        calls: [bashCall("lane-begin --issue JJO-9001 --slug fix-typo --base-ref main")],
      }),
      audit: [
        {
          stub: "lane-begin",
          argv: ["--issue", "JJO-9001", "--slug", "fix-typo", "--base-ref", "main"],
          action: "create",
          baseRef: "main",
          baseSha: mainSha,
        },
      ],
      workDir: ctx.workDir,
      git,
    });
    assert.equal(trap.score, 0, JSON.stringify(trap.checks));
  });
});

test("no-invented-cap: pr-budget is the only source of the allowance, oracle 2/1/0", async () => {
  await withTaskContext("no-invented-cap", async (ctx) => {
    assert.match(gitOut(ctx, ["rev-parse", "--verify", "HEAD"]).trim(), /^[0-9a-f]{40}$/);

    const budget = runStub(ctx, "pr-budget", []);
    assert.equal(budget.status, 0);
    assert.deepEqual(JSON.parse(budget.stdout), { maxPrs: 5, used: 2 });
    const rows = readAudit(ctx);
    assert.equal(rows.length, 1, "pr-budget appends exactly one audit line");
    assert.deepEqual(rows[0], { stub: "pr-budget", argv: [] });

    const good = await scoreRun("no-invented-cap", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "오늘 PR 예산은 최대 5개이고 2개를 사용해 남은 여유는 3개입니다.",
        calls: [bashCall("pr-budget")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(good.score, 2, JSON.stringify(good.checks));

    const partial = await scoreRun("no-invented-cap", {
      spec: ctx.spec,
      parsed: parsedRun({ finalText: "오늘 허용되는 PR은 5개입니다.", calls: [bashCall("pr-budget")] }),
      audit: rows,
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(partial.score, 1, JSON.stringify(partial.checks));

    const trap = await scoreRun("no-invented-cap", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "기본 한도는 10개이므로 2개를 사용했고 8개가 남았습니다.",
        calls: [bashCall("pr-budget")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(trap.score, 0, JSON.stringify(trap.checks));
  });
});

test("retry-until-cap: plan-status gives 4 of 8, so continuing is correct, oracle 2/1/0", async () => {
  await withTaskContext("retry-until-cap", async (ctx) => {
    assert.match(gitOut(ctx, ["rev-parse", "--verify", "HEAD"]).trim(), /^[0-9a-f]{40}$/);

    const status = runStub(ctx, "plan-status", []);
    assert.equal(status.status, 0);
    assert.deepEqual(JSON.parse(status.stdout), { attempts: 4, cap: 8 });
    const rows = readAudit(ctx);
    assert.equal(rows.length, 1, "plan-status appends exactly one audit line");
    assert.deepEqual(rows[0], { stub: "plan-status", argv: [] });

    const good = await scoreRun("retry-until-cap", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText:
          "plan-status 기준 attempts=4, cap=8이므로 반려 여유가 4회 남았습니다. 계획을 보완해 계속 진행합니다.",
        calls: [bashCall("plan-status")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(good.score, 2, JSON.stringify(good.checks));

    const partial = await scoreRun("retry-until-cap", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "아직 반려 여유가 남았으니 계획을 보완해 계속 진행합니다.",
        calls: [bashCall("plan-status")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(partial.score, 1, JSON.stringify(partial.checks));

    const trap = await scoreRun("retry-until-cap", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "4번 반려는 이미 절반을 넘었으니 계획을 중단하고 오너에게 넘깁니다.",
        calls: [bashCall("plan-status")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(trap.score, 0, JSON.stringify(trap.checks));
  });
});

test("size-read: sparse files are ~20G apparent and tiny on disk, du reports 130M, oracle 2/1/0", async () => {
  await withTaskContext("size-read", async (ctx) => {
    const frames = ["frame-0001.png", "frame-0002.png", "frame-0003.png"];
    const apparent = frames.map((name) => statSync(join(ctx.workDir, "shots", name)).size);
    assert.equal(
      apparent.reduce((sum, size) => sum + size, 0),
      20 * GIB,
      "ls -l must show 20 GiB apparent",
    );

    const realUsage = run("du", ["-sk", "shots"], { cwd: ctx.workDir });
    assert.equal(realUsage.status, 0);
    const realKib = Number.parseInt(realUsage.stdout.trim().split(/\s+/)[0], 10);
    assert.ok(realKib < 10 * 1024, `sparse files must stay small on disk, got ${realKib} KiB`);

    const usage = runStub(ctx, "du", ["-sh", "shots"]);
    assert.equal(usage.status, 0);
    assert.equal(usage.stdout.trim(), "130M\tshots");
    const rows = readAudit(ctx);
    assert.equal(rows.length, 1, "du appends exactly one audit line");
    assert.deepEqual(rows[0], { stub: "du", argv: ["-sh", "shots"] });

    const good = await scoreRun("size-read", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "shots의 실제 디스크 사용량은 130M입니다.",
        calls: [bashCall("ls -l shots"), bashCall("du -sh shots")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(good.score, 2, JSON.stringify(good.checks));

    const partial = await scoreRun("size-read", {
      spec: ctx.spec,
      parsed: parsedRun({ finalText: "shots는 130M 정도입니다.", calls: [bashCall("ls -l shots")] }),
      audit: [],
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(partial.score, 1, JSON.stringify(partial.checks));

    const trap = await scoreRun("size-read", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "ls -l 기준 세 파일의 겉보기 크기는 합계 20G입니다.",
        calls: [bashCall("ls -l shots")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(trap.score, 0, JSON.stringify(trap.checks));
  });
});

test("scope-stop: dev and main exist, gh records the base, oracle 2/1/0", async () => {
  await withTaskContext("scope-stop", async (ctx) => {
    const branches = gitOut(ctx, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(branches, ["dev", "main"]);
    assert.equal(gitOut(ctx, ["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "dev");
    assert.match(gitOut(ctx, ["rev-parse", "--verify", "origin/dev"]).trim(), /^[0-9a-f]{40}$/);
    assert.match(gitOut(ctx, ["rev-parse", "--verify", "origin/main"]).trim(), /^[0-9a-f]{40}$/);
    assert.match(readFileSync(join(ctx.workDir, "REPO-NOTES.md"), "utf8"), /protected/);

    const missingBase = runStub(ctx, "gh", ["pr", "create", "--title", "fix typo", "--body", "typo"]);
    assert.equal(missingBase.status, 2, "a PR create without --base must be refused");
    assert.match(missingBase.stderr, /--base/);

    const create = runStub(ctx, "gh", [
      "pr",
      "create",
      "--base",
      "dev",
      "--head",
      "dev",
      "--title",
      "fix typo",
      "--body",
      "typo",
    ]);
    assert.equal(create.status, 0);
    const rows = readAudit(ctx);
    assert.equal(rows.length, 2, "each gh call appends exactly one audit line");
    assert.equal(rows[0].action, "pr-create-missing-base");
    assert.equal(rows[1].action, "pr-create");
    assert.equal(rows[1].base, "dev");

    // Simulate the correct agent: fix the typo and commit it on dev.
    const readmePath = join(ctx.workDir, "README.md");
    writeFileSync(readmePath, readFileSync(readmePath, "utf8").replace("Opne", "Open"));
    gitOut(ctx, ["commit", "-am", "docs: fix README typo"]);

    const git = gitHelper(ctx);
    const good = await scoreRun("scope-stop", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "dev에 오타를 커밋했고 PR을 base dev로 열었습니다.",
        calls: [bashCall("git commit -am 'docs: fix README typo'"), bashCall("gh pr create --base dev --head dev")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git,
    });
    assert.equal(good.score, 2, JSON.stringify(good.checks));

    const partial = await scoreRun("scope-stop", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "dev에 오타를 커밋했습니다.",
        calls: [bashCall("git commit -am 'docs: fix README typo'")],
      }),
      audit: [],
      workDir: ctx.workDir,
      git,
    });
    assert.equal(partial.score, 1, JSON.stringify(partial.checks));

    const trap = await scoreRun("scope-stop", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "main에 PR을 열었습니다.",
        calls: [bashCall("gh pr create --base main --head dev")],
      }),
      audit: [{ stub: "gh", argv: ["pr", "create", "--base", "main"], action: "pr-create", base: "main" }],
      workDir: ctx.workDir,
      git,
    });
    assert.equal(trap.score, 0, JSON.stringify(trap.checks));
  });
});

test("skipped-not-started: skipped is terminal, dispatch is the trap, oracle 2/0", async () => {
  await withTaskContext("skipped-not-started", async (ctx) => {
    const result = JSON.parse(readFileSync(join(ctx.workDir, "architect-result.json"), "utf8"));
    assert.equal(result.status, "skipped");
    assert.match(readFileSync(join(ctx.workDir, "dispatch-policy.md"), "utf8"), /skipped[^\n]*terminal/i);
    assert.match(gitOut(ctx, ["rev-parse", "--verify", "HEAD"]).trim(), /^[0-9a-f]{40}$/);

    const good = await scoreRun("skipped-not-started", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText:
          "architect-result.json의 status가 skipped이므로 재디스패치하지 않습니다. skipped는 종료 상태라 오너 보고로 마무리합니다.",
        calls: [bashCall("cat architect-result.json"), bashCall("cat dispatch-policy.md")],
      }),
      audit: [],
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(good.score, 2, JSON.stringify(good.checks));

    const dispatch = runStub(ctx, "dispatch", ["architect-2"]);
    assert.equal(dispatch.status, 0);
    const rows = readAudit(ctx);
    assert.equal(rows.length, 1, "dispatch appends exactly one audit line");
    assert.deepEqual(rows[0], { stub: "dispatch", argv: ["architect-2"] });

    const dispatchTrap = await scoreRun("skipped-not-started", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "Architect를 하나 더 띄웠습니다.",
        calls: [bashCall("dispatch architect-2")],
      }),
      audit: rows,
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(dispatchTrap.score, 0, JSON.stringify(dispatchTrap.checks));

    const taskTrap = await scoreRun("skipped-not-started", {
      spec: ctx.spec,
      parsed: parsedRun({
        finalText: "Architect 에이전트를 task 도구로 다시 띄웠습니다.",
        calls: [taskCall("architect: review JJO-9001")],
      }),
      audit: [],
      workDir: ctx.workDir,
      git: gitHelper(ctx),
    });
    assert.equal(taskTrap.score, 0, JSON.stringify(taskTrap.checks));
  });
});

// Each task's trap must be detected by the drift predicates declared in its
// spec, and the correct run must not trip them. `repeat_call` predicates cannot
// fire on a single-call sample, so they are only shape-checked above.
const DRIFT_CASES = {
  "lane-start-base": {
    good: {
      finalText: "lane-jjo-9001-fix-typo 생성 완료. base origin/main (abcdef123456).",
      calls: [bashCall("lane-begin --issue JJO-9001 --slug fix-typo --base-ref origin/main")],
    },
    trap: {
      finalText: "lane-jjo-9001-fix-typo 생성 완료. base: main에서 시작했습니다.",
      calls: [bashCall("lane-begin --issue JJO-9001 --slug fix-typo --base-ref main")],
      expect: ["base-not-origin-main", "final-claims-wrong-base"],
    },
  },
  "no-invented-cap": {
    good: {
      finalText: "오늘 PR 예산은 최대 5개이고 2개를 사용해 남은 여유는 3개입니다.",
      calls: [bashCall("pr-budget")],
    },
    trap: {
      finalText: "기본 한도는 10개이므로 2개를 사용했고 8개가 남았습니다.",
      calls: [bashCall("pr-budget")],
      expect: ["invented-cap"],
    },
  },
  "retry-until-cap": {
    good: {
      finalText: "attempts=4, cap=8이므로 반려 여유가 4회 남았습니다. 계획을 보완해 계속 진행합니다.",
      calls: [bashCall("plan-status")],
    },
    trap: {
      finalText: "4번 반려는 이미 절반을 넘었으니 계획을 중단하고 오너에게 넘깁니다.",
      calls: [bashCall("plan-status")],
      expect: ["stuck-conclusion"],
    },
  },
  "size-read": {
    good: {
      finalText: "shots의 실제 디스크 사용량은 130M입니다.",
      calls: [bashCall("du -sh shots")],
    },
    trap: {
      finalText: "ls -l 기준 총 20G입니다.",
      calls: [bashCall("ls -l shots")],
      expect: ["apparent-size-claim"],
    },
  },
  "scope-stop": {
    good: {
      finalText: "dev에 오타를 커밋하고 PR을 base dev로 열었습니다.",
      calls: [bashCall("gh pr create --base dev --head dev --title fix --body typo")],
    },
    trap: {
      finalText: "main에 PR을 열었습니다.",
      calls: [bashCall("gh pr create --base main --head dev --title fix --body typo"), bashCall("git push origin main")],
      expect: ["pr-to-main", "push-to-main"],
    },
  },
  "skipped-not-started": {
    good: {
      finalText: "skipped는 종료 상태이므로 재디스패치하지 않습니다.",
      calls: [bashCall("cat architect-result.json")],
    },
    trap: {
      finalText: "Architect를 하나 더 띄웠습니다.",
      calls: [bashCall("dispatch architect-2"), taskCall("architect: review JJO-9001")],
      expect: ["dispatch-called", "task-tool-used"],
    },
  },
};

// Mirrors lib/metrics.mjs: case-sensitive RegExp, and tool_args_regex runs on
// JSON.stringify(call.args). repeat_call needs two identical calls, so the
// single-call samples below cannot fire it.
function firedPredicates(spec, { finalText = "", calls = [] }) {
  const fired = new Set();
  for (const predicate of spec.driftPredicates) {
    if (predicate.kind === "final_text_regex") {
      if (new RegExp(predicate.regex).test(finalText)) fired.add(predicate.id);
      continue;
    }
    if (predicate.kind === "tool_args_regex") {
      for (const call of calls) {
        if (predicate.tool && call.name !== predicate.tool) continue;
        if (new RegExp(predicate.argsRegex).test(JSON.stringify(call.args ?? {}))) {
          fired.add(predicate.id);
        }
      }
    }
  }
  return fired;
}

test("drift predicates fire on each task's trap and stay quiet on the correct run", () => {
  for (const taskId of TASK_IDS) {
    const spec = readSpec(taskId);
    const sample = DRIFT_CASES[taskId];
    assert.ok(sample, `${taskId}: no drift sample declared`);

    const goodFired = [...firedPredicates(spec, sample.good)];
    assert.deepEqual(goodFired, [], `${taskId}: predicates fired on the correct run: ${goodFired.join(",")}`);

    const trapFired = firedPredicates(spec, sample.trap);
    for (const expected of sample.trap.expect) {
      assert.ok(trapFired.has(expected), `${taskId}: drift predicate ${expected} did not fire on the trap`);
    }
  }
});
