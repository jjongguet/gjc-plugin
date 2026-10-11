import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { recoverPendingCycle, runCycle } from "../../lib/engine.mjs";
import { appendRow, readLedger } from "../../lib/ledger.mjs";

function git(cwd, args) {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "self-improve-cycle-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "jev-advisor", "lib"), { recursive: true });
  mkdirSync(join(repo, "jev-advisor", "src"), { recursive: true });
  mkdirSync(join(repo, "jev-advisor", "tests"), { recursive: true });
  mkdirSync(join(repo, "verification-receipts", "lib"), { recursive: true });
  mkdirSync(join(repo, "self-improve"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","private":true,"type":"module"}\n');
  writeFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "export const value = 1;\n");
  writeFileSync(join(repo, "jev-advisor", "src", "alpha.adapter.ts"), "export const alpha = 1;\n");
  writeFileSync(join(repo, "jev-advisor", "src", "beta.adapter.ts"), "export const beta = 1;\n");
  writeFileSync(join(repo, "verification-receipts", "lib", "extra.ts"), "export const extra = 1;\n");
  writeFileSync(join(repo, "jev-advisor", "tests", "decision.test.ts"), "// protected\n");
  writeFileSync(join(repo, "self-improve", "ledger.jsonl"), "");
  mkdirSync(join(repo, "jev-advisor", "hooks"), { recursive: true });
  writeFileSync(join(repo, "jev-advisor", "hooks", "hook.ts"), "// generated v1\n");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture base"]);
  return { root, repo };
}

function writePatch(root, name, content) {
  const file = join(root, name);
  writeFileSync(file, content);
  return file;
}

function patchFor(file, minusLine, plusLine) {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", `-${minusLine}`, `+${plusLine}`, ""].join("\n");
}

const cleanPatch = patchFor("jev-advisor/lib/decision.ts", "export const value = 1;", "export const value = 2;");
const noBenefitPatch = patchFor("jev-advisor/lib/decision.ts", "export const value = 1;", "export const value = 1; // touched");
const protectedPatch = patchFor("jev-advisor/tests/decision.test.ts", "// protected", "// edited");
const hardcodePatch = patchFor("jev-advisor/lib/decision.ts", "export const value = 1;", 'export const value = "HELDOUT_1";');
const oversizePatch = [
  patchFor("jev-advisor/lib/decision.ts", "export const value = 1;", "export const value = 11;"),
  patchFor("jev-advisor/src/alpha.adapter.ts", "export const alpha = 1;", "export const alpha = 11;"),
  patchFor("jev-advisor/src/beta.adapter.ts", "export const beta = 1;", "export const beta = 11;"),
  patchFor("verification-receipts/lib/extra.ts", "export const extra = 1;", "export const extra = 11;"),
].join("");

function makeFakeGuards({ failBuildOnCall = null, mutateOnCall = null } = {}) {
  const state = { calls: 0 };
  const runner = async ({ guards }) => {
    state.calls += 1;
    if (mutateOnCall && mutateOnCall.call === state.calls) {
      writeFileSync(join(mutateOnCall.repo, mutateOnCall.path), `${mutateOnCall.content}\n`);
    }
    return guards.map((guard) => ({
      id: guard.id,
      status: failBuildOnCall === state.calls && guard.id === "build" ? "fail" : "pass",
      exitCode: 0,
      durationMs: 1,
      logPath: null,
    }));
  };
  return { runner, state };
}

const improvingProbes = async () => ({
  baseline: { coverage: 0.9 },
  candidate: { coverage: 0.95 },
  delta: 0.05,
  heldout: { baseline: { safety: 0.5 }, candidate: { safety: 0.5 } },
});
const flatProbes = async () => ({
  baseline: { coverage: 0.9 },
  candidate: { coverage: 0.9 },
  delta: 0,
  heldout: { baseline: {}, candidate: {} },
});

function cycleInput({ root, repo, patchFile, deps, dryRun = false, hypothesis = "fixture hypothesis", objective = "probe.coverage" }) {
  return {
    repoRoot: repo,
    adapter: DOMAIN,
    proposal: {
      source: "manual",
      hypothesis,
      objective,
      commitMessage: "feat(jev-advisor): apply fixture change",
      patchFile,
      campaignId: "default",
    },
    runRoot: join(root, "runroot"),
    ledgerPath: join(repo, "self-improve", "ledger.jsonl"),
    dryRun,
    includeSmoke: false,
    deps,
  };
}

test("no-benefit cycle is rejected, recorded, committed and leaves a clean tree", async () => {
  const { root, repo } = makeFixture();
  const fake = makeFakeGuards();
  const patchFile = writePatch(root, "noop.patch", noBenefitPatch);
  const result = await runCycle(cycleInput({ root, repo, patchFile, deps: { runGuards: fake.runner, evaluateProbes: flatProbes } }));
  assert.equal(result.status, "ok");
  assert.equal(result.decision, "reject");
  assert.ok(result.reasons.includes("floor_not_met"), result.reasons.join(","));
  assert.equal(result.adoption, "none");
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict.decision, "reject");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.match(git(repo, ["log", "-1", "--format=%s"]), /^chore\(self-improve\): cycle .* reject$/);
  rmSync(root, { recursive: true, force: true });
});

test("malicious proposals are rejected: protected edit, held-out hardcode, budget overflow", async () => {
  const { root, repo } = makeFixture();
  const cases = [
    { name: "protected", patch: protectedPatch, probes: flatProbes, expect: /critic_(surface|protected)/ },
    { name: "hardcode", patch: hardcodePatch, probes: improvingProbes, expect: /critic_fixture_hardcode/ },
    { name: "oversize", patch: oversizePatch, probes: improvingProbes, expect: /budget_exceeded|critic_budget/ },
  ];
  for (const testCase of cases) {
    const fake = makeFakeGuards();
    const patchFile = writePatch(root, `${testCase.name}.patch`, testCase.patch);
    const result = await runCycle(
      cycleInput({
        root,
        repo,
        patchFile,
        hypothesis: `${testCase.name} hypothesis`,
        deps: { runGuards: fake.runner, evaluateProbes: testCase.probes },
      }),
    );
    assert.equal(result.decision, "reject", testCase.name);
    assert.ok(result.reasons.some((reason) => testCase.expect.test(reason)), `${testCase.name}: ${result.reasons.join(",")}`);
    assert.equal(result.adoption, "none");
    assert.equal(git(repo, ["status", "--porcelain"]), "", testCase.name);
  }
  assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 3);
  rmSync(root, { recursive: true, force: true });
});

test("reject then adopt: adoption commits code plus adoption row (three-commit pattern)", async () => {
  const { root, repo } = makeFixture();
  const baseCommits = Number(git(repo, ["rev-list", "--count", "HEAD"]));
  const fake1 = makeFakeGuards();
  const noopPatch = writePatch(root, "noop2.patch", noBenefitPatch);
  const rejected = await runCycle(
    cycleInput({ root, repo, patchFile: noopPatch, deps: { runGuards: fake1.runner, evaluateProbes: flatProbes } }),
  );
  assert.equal(rejected.decision, "reject");
  const fake2 = makeFakeGuards();
  const adoptPatch = writePatch(root, "adopt.patch", cleanPatch);
  const adopted = await runCycle(
    cycleInput({
      root,
      repo,
      patchFile: adoptPatch,
      hypothesis: "adopt hypothesis",
      deps: { runGuards: fake2.runner, evaluateProbes: improvingProbes },
    }),
  );
  assert.equal(adopted.decision, "adopt");
  assert.equal(adopted.adoption, "committed");
  assert.ok(adopted.codeCommit);
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  assert.deepEqual(rows.map((row) => row.kind), ["cycle", "cycle", "adoption"]);
  assert.equal(rows[2].commit, adopted.codeCommit);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  const subjects = git(repo, ["log", "--format=%s"]).split("\n");
  assert.match(subjects[0], /^chore\(self-improve\): record adoption /);
  assert.match(subjects[1], /^feat\(jev-advisor\): apply fixture change$/);
  assert.match(subjects[2], /^chore\(self-improve\): cycle .* adopt$/);
  assert.equal(Number(git(repo, ["rev-list", "--count", "HEAD"])), baseCommits + 4);
  assert.equal(readFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "utf8"), "export const value = 2;\n");
  rmSync(root, { recursive: true, force: true });
});

test("post-apply guard failure rolls back, records post_apply_failure and commits nothing but the cycle row", async () => {
  const { root, repo } = makeFixture();
  const fake = makeFakeGuards({ failBuildOnCall: 4 });
  const patchFile = writePatch(root, "rollback.patch", cleanPatch);
  const result = await runCycle(
    cycleInput({ root, repo, patchFile, deps: { runGuards: fake.runner, evaluateProbes: improvingProbes } }),
  );
  assert.equal(result.decision, "adopt");
  assert.equal(result.adoption, "post_apply_failure");
  assert.equal(result.rolledBack, true);
  assert.equal(result.clean, true);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(readFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "utf8"), "export const value = 1;\n");
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].verdict.decision, "adopt");
  const runDirs = readdirSync(join(root, "runroot", "runs"));
  const failure = JSON.parse(readFileSync(join(root, "runroot", "runs", runDirs[0], "failure.json"), "utf8"));
  assert.equal(failure.reason, "post_apply_failure");
  assert.equal(failure.clean, true);
  rmSync(root, { recursive: true, force: true });
});

test("crash recovery rolls back a mid-apply journal", () => {
  const { root, repo } = makeFixture();
  const runRoot = join(root, "runroot");
  const dir = join(runRoot, "runs", "cyc-simulated");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "phase.json"), JSON.stringify({ phase: "applying", at: "simulated" }));
  writeFileSync(
    join(dir, "applied.json"),
    JSON.stringify({ repoRoot: repo, modified: ["jev-advisor/lib/decision.ts"], added: ["jev-advisor/lib/new-file.ts"] }),
  );
  writeFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "export const value = 999;\n");
  writeFileSync(join(repo, "jev-advisor", "lib", "new-file.ts"), "export const n = 1;\n");
  const results = recoverPendingCycle({ runRoot, repoRoot: repo });
  assert.deepEqual(results, [{ cycleId: "cyc-simulated", recovered: true, clean: true }]);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(readFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(existsSync(join(repo, "jev-advisor", "lib", "new-file.ts")), false);
  assert.equal(JSON.parse(readFileSync(join(dir, "phase.json"), "utf8")).phase, "rolled_back");
  rmSync(root, { recursive: true, force: true });
});

test("dry-run writes nothing and commits nothing", async () => {
  const { root, repo } = makeFixture();
  const fake = makeFakeGuards();
  const before = git(repo, ["rev-list", "--count", "HEAD"]);
  const patchFile = writePatch(root, "dry.patch", noBenefitPatch);
  const result = await runCycle(
    cycleInput({ root, repo, patchFile, deps: { runGuards: fake.runner, evaluateProbes: flatProbes }, dryRun: true }),
  );
  assert.equal(result.status, "dry-run");
  assert.equal(result.decision, "reject");
  assert.equal(git(repo, ["rev-list", "--count", "HEAD"]), before);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 0);
  assert.equal(existsSync(join(root, "runroot", "runs")), false);
  rmSync(root, { recursive: true, force: true });
});

test("cycle lock refuses busy and stale holders without stealing", async () => {
  const { root, repo } = makeFixture();
  const runRoot = join(root, "runroot");
  const lockPath = join(runRoot, "locks", "cycle.lock");
  mkdirSync(join(runRoot, "locks"), { recursive: true });
  const fake = makeFakeGuards();
  const patchFile = writePatch(root, "lock.patch", noBenefitPatch);
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: "now" }));
  const busy = await runCycle(
    cycleInput({ root, repo, patchFile, deps: { runGuards: fake.runner, evaluateProbes: flatProbes } }),
  );
  assert.deepEqual(
    { status: busy.status, reason: busy.reason, stale: busy.stale },
    { status: "busy", reason: "cycle_busy", stale: false },
  );
  assert.equal(existsSync(lockPath), true);
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, startedAt: "old" }));
  const stale = await runCycle(
    cycleInput({ root, repo, patchFile, deps: { runGuards: fake.runner, evaluateProbes: flatProbes } }),
  );
  assert.deepEqual(
    { status: stale.status, reason: stale.reason, stale: stale.stale },
    { status: "busy", reason: "cycle_busy_stale", stale: true },
  );
  assert.equal(existsSync(lockPath), true);
  rmSync(root, { recursive: true, force: true });
});

test("duplicate hypothesis is rejected without evaluation and stalls force exploration", async () => {
  const { root, repo } = makeFixture();
  const fake = makeFakeGuards();
  const patchFile = writePatch(root, "history.patch", noBenefitPatch);
  const first = await runCycle(
    cycleInput({ root, repo, patchFile, deps: { runGuards: fake.runner, evaluateProbes: flatProbes } }),
  );
  assert.equal(first.decision, "reject");
  const duplicate = await runCycle(
    cycleInput({ root, repo, patchFile, deps: { runGuards: fake.runner, evaluateProbes: flatProbes } }),
  );
  assert.equal(duplicate.reasons[0], "history_duplicate_hypothesis");
  assert.equal(duplicate.recorded, false);
  assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 1);
  for (const [index, hypothesis] of ["h2", "h3"].entries()) {
    const rejected = await runCycle(
      cycleInput({ root, repo, patchFile, hypothesis, deps: { runGuards: fake.runner, evaluateProbes: flatProbes } }),
    );
    assert.equal(rejected.decision, "reject", `reject ${index + 2}`);
  }
  const stalled = await runCycle(
    cycleInput({ root, repo, patchFile, hypothesis: "h4", deps: { runGuards: fake.runner, evaluateProbes: flatProbes } }),
  );
  assert.equal(stalled.reasons[0], "forced_exploration");
  assert.equal(stalled.recorded, false);
  const redirect = await runCycle(
    cycleInput({
      root,
      repo,
      patchFile,
      hypothesis: "redirect hypothesis",
      objective: "probe.other",
      deps: { runGuards: fake.runner, evaluateProbes: improvingProbes },
    }),
  );
  assert.equal(redirect.decision, "adopt");
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  const lastCycle = rows.filter((row) => row.kind === "cycle").at(-1);
  assert.equal(lastCycle.forcedExploration, true);
  assert.equal(lastCycle.objective, "probe.other");
  rmSync(root, { recursive: true, force: true });
});

test("adopted commits include regenerated surfaces rewritten by the build guard", async () => {
  const { root, repo } = makeFixture();
  const fake = makeFakeGuards({
    mutateOnCall: { call: 4, repo, path: "jev-advisor/hooks/hook.ts", content: "// generated v2" },
  });
  const patchFile = writePatch(root, "regen.patch", cleanPatch);
  const result = await runCycle(
    cycleInput({ root, repo, patchFile, hypothesis: "regen", deps: { runGuards: fake.runner, evaluateProbes: improvingProbes } }),
  );
  assert.equal(result.adoption, "committed");
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  const stat = git(repo, ["show", "--name-only", "--format=%s", "HEAD~1"]);
  assert.ok(stat.includes("jev-advisor/hooks/hook.ts"), stat);
  assert.ok(stat.includes("jev-advisor/lib/decision.ts"), stat);
  assert.equal(readFileSync(join(repo, "jev-advisor", "hooks", "hook.ts"), "utf8"), "// generated v2\n");
  rmSync(root, { recursive: true, force: true });
});

test("unexpected workspace changes abort the adopt and roll everything back", async () => {
  const { root, repo } = makeFixture();
  const baseCommits = Number(git(repo, ["rev-list", "--count", "HEAD"]));
  const fake = makeFakeGuards({ mutateOnCall: { call: 4, repo, path: "notes.txt", content: "stray" } });
  const patchFile = writePatch(root, "stray.patch", cleanPatch);
  const result = await runCycle(
    cycleInput({ root, repo, patchFile, hypothesis: "stray", deps: { runGuards: fake.runner, evaluateProbes: improvingProbes } }),
  );
  assert.equal(result.decision, "adopt");
  assert.equal(result.adoption, "post_apply_failure");
  assert.equal(result.clean, true);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(Number(git(repo, ["rev-list", "--count", "HEAD"])), baseCommits + 1);
  assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 1);
  const runDirs = readdirSync(join(root, "runroot", "runs"));
  const failure = JSON.parse(readFileSync(join(root, "runroot", "runs", runDirs[0], "failure.json"), "utf8"));
  assert.equal(failure.reason, "unexpected_workspace_changes");
  rmSync(root, { recursive: true, force: true });
});

test("concurrent workspace drift aborts the adopt before apply and preserves the foreign edit", async () => {
  const { root, repo } = makeFixture();
  const baseCommits = Number(git(repo, ["rev-list", "--count", "HEAD"]));
  const fake = makeFakeGuards({
    mutateOnCall: { call: 3, repo, path: "jev-advisor/src/alpha.adapter.ts", content: "// drift" },
  });
  const patchFile = writePatch(root, "drift.patch", cleanPatch);
  const result = await runCycle(
    cycleInput({ root, repo, patchFile, hypothesis: "drift", deps: { runGuards: fake.runner, evaluateProbes: improvingProbes } }),
  );
  assert.equal(result.decision, "adopt");
  assert.equal(result.adoption, "aborted_dirty_worktree");
  assert.equal(readFileSync(join(repo, "jev-advisor", "src", "alpha.adapter.ts"), "utf8"), "// drift\n");
  assert.equal(Number(git(repo, ["rev-list", "--count", "HEAD"])), baseCommits + 1);
  git(repo, ["checkout", "--", "jev-advisor/src/alpha.adapter.ts"]);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  rmSync(root, { recursive: true, force: true });
});

test("the install flag records the install state through the seam", async () => {
  const { root, repo } = makeFixture();
  const fake = makeFakeGuards();
  const patchFile = writePatch(root, "install.patch", cleanPatch);
  const result = await runCycle({
    ...cycleInput({ root, repo, patchFile, hypothesis: "install", deps: {} }),
    install: true,
    deps: {
      runGuards: fake.runner,
      evaluateProbes: improvingProbes,
      runInstall: () => ({ install: "upgraded", plugin: "jev-advisor" }),
    },
  });
  assert.equal(result.adoption, "committed");
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  assert.equal(rows.at(-1).install, "upgraded");
  rmSync(root, { recursive: true, force: true });
});

test("recovery reports an uncertain commit state instead of guessing", () => {
  const { root, repo } = makeFixture();
  const runRoot = join(root, "runroot");
  const dir = join(runRoot, "runs", "cyc-uncertain");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "phase.json"), JSON.stringify({ phase: "committing", at: "simulated" }));
  const results = recoverPendingCycle({ runRoot, repoRoot: repo });
  assert.deepEqual(results, [{ cycleId: "cyc-uncertain", recovered: false, clean: true }]);
  assert.equal(JSON.parse(readFileSync(join(dir, "phase.json"), "utf8")).phase, "commit_state_uncertain");
  rmSync(root, { recursive: true, force: true });
});

test("recovery completes a missing adoption chore commit", () => {
  const { root, repo } = makeFixture();
  const runRoot = join(root, "runroot");
  const dir = join(runRoot, "runs", "cyc-adopt-pending");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "phase.json"), JSON.stringify({ phase: "adoption-recorded", at: "simulated" }));
  appendRow(join(repo, "self-improve", "ledger.jsonl"), {
    kind: "adoption",
    cycleId: "cyc-adopt-pending",
    commit: "abcdef0",
    install: "not_attempted",
    createdAt: "2026-10-12T00:00:00.000Z",
  });
  assert.notEqual(git(repo, ["status", "--porcelain"]), "");
  const results = recoverPendingCycle({ runRoot, repoRoot: repo });
  assert.deepEqual(results, [{ cycleId: "cyc-adopt-pending", recovered: true, clean: true }]);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.match(git(repo, ["log", "-1", "--format=%s"]), /^chore\(self-improve\): record adoption cyc-adopt-pending$/);
  assert.equal(JSON.parse(readFileSync(join(dir, "phase.json"), "utf8")).phase, "done");
  rmSync(root, { recursive: true, force: true });
});

test("a ledger outside the repository is refused before any side effects", async () => {
  const { root, repo } = makeFixture();
  const fake = makeFakeGuards();
  const patchFile = writePatch(root, "outside.patch", cleanPatch);
  await assert.rejects(
    runCycle({
      ...cycleInput({ root, repo, patchFile, hypothesis: "outside", deps: {} }),
      ledgerPath: join(root, "outside-ledger.jsonl"),
      deps: { runGuards: fake.runner, evaluateProbes: improvingProbes },
    }),
    /ledger_must_live_inside_repository/,
  );
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  assert.equal(existsSync(join(root, "outside-ledger.jsonl")), false);
  rmSync(root, { recursive: true, force: true });
});
