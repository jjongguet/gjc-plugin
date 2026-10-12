import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { runLoop } from "../../lib/loop.mjs";
import { appendRow, readLedger } from "../../lib/ledger.mjs";
import { sha256Hex } from "../../lib/types.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function git(cwd, args) {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "self-improve-loop-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "jev-advisor", "lib"), { recursive: true });
  mkdirSync(join(repo, "jev-advisor", "src"), { recursive: true });
  mkdirSync(join(repo, "jev-advisor", "tests"), { recursive: true });
  mkdirSync(join(repo, "verification-receipts", "lib"), { recursive: true });
  mkdirSync(join(repo, "self-improve", "domains", "gjc-plugin", "heldout"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","private":true,"type":"module"}\n');
  writeFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "export const value = 1;\n");
  writeFileSync(join(repo, "jev-advisor", "src", "alpha.adapter.ts"), "export const alpha = 1;\n");
  writeFileSync(join(repo, "verification-receipts", "lib", "extra.ts"), "export const extra = 1;\n");
  writeFileSync(join(repo, "jev-advisor", "tests", "decision.test.ts"), "// protected\n");
  writeFileSync(join(repo, "self-improve", "domains", "gjc-plugin", "heldout", "fixtures.json"), '{"cases":{}}\n');
  writeFileSync(join(repo, "self-improve", "ledger.jsonl"), "");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture base"]);
  return { root, repo };
}

const improvingProbes = async () => ({
  baseline: { decision_accuracy: 0.9 },
  candidate: { decision_accuracy: 0.95 },
  delta: 0.05,
  heldout: { baseline: { heldout_coverage: 0.5 }, candidate: { heldout_coverage: 0.5 } },
});
const flatProbes = async () => ({
  baseline: { decision_accuracy: 0.9 },
  candidate: { decision_accuracy: 0.9 },
  delta: 0,
  heldout: { baseline: {}, candidate: {} },
});

function makeFakeGuards({ failBuild = false, flakeText = null } = {}) {
  const state = { calls: 0 };
  const runGuards = async ({ guards, logDir }) => {
    state.calls += 1;
    if (flakeText !== null) {
      mkdirSync(logDir, { recursive: true });
      writeFileSync(join(logDir, "test.log"), flakeText);
    }
    return guards.map((guard) => ({
      id: guard.id,
      status: failBuild && guard.id === "build" ? "fail" : "pass",
      exitCode: failBuild && guard.id === "build" ? 1 : 0,
      durationMs: 1,
      logPath: null,
    }));
  };
  return { runGuards, state };
}

function seedCycleRow({ cycleId, objective, hypothesis, decision }) {
  return {
    kind: "cycle",
    cycleId,
    domain: "gjc-plugin",
    campaignId: "default",
    baseCommit: "abcdef0",
    budgetRung: 0,
    proposal: { source: "agent", patchSha256: "a".repeat(64), files: ["jev-advisor/lib/decision.ts"], hunks: 1 },
    hypothesisHash: sha256Hex(hypothesis),
    objective,
    scores: { baseline: {}, candidate: {}, delta: 0, floor: 0.01 },
    cost: { wallMs: 1, bytes: 1, tokens: null },
    guards: [{ id: "build", status: "pass" }],
    critic: { verdict: "pass", rules: [] },
    verdict: { decision, reasons: ["floor_not_met"] },
    createdAt: "2026-10-13T00:00:00.000Z",
  };
}

function loopInput({ root, repo, deps, ...overrides }) {
  return {
    repoRoot: repo,
    adapter: DOMAIN,
    proposer: "stub",
    runRoot: join(root, "runroot"),
    ledgerPath: join(repo, "self-improve", "ledger.jsonl"),
    maxCycles: 2,
    maxProposerCalls: 4,
    batchSize: 1,
    includeSmoke: false,
    deps: {
      runGuards: deps.runGuards,
      evaluateProbes: deps.evaluateProbes,
      scanProbeFailures: deps.scanProbeFailures ?? (() => ({ ok: true, reason: null, failures: [] })),
      ...(deps.runInstall ? { runInstall: deps.runInstall } : {}),
      ...(deps.proposerEnv ? { proposerEnv: deps.proposerEnv } : {}),
      ...(deps.now ? { now: deps.now } : {}),
    },
    ...overrides,
  };
}

test("stub loop records cycles through the normal engine path with state outside the repo", async () => {
  const { root, repo } = makeFixture();
  const initialBase = git(repo, ["rev-parse", "--short=7", "HEAD"]);
  const fake = makeFakeGuards();
  const result = await runLoop(loopInput({ root, repo, deps: { runGuards: fake.runGuards, evaluateProbes: flatProbes } }));
  assert.equal(result.status, "ok");
  assert.equal(result.stoppedReason, "max_cycles");
  assert.equal(result.counters.cycles, 2);
  assert.equal(result.counters.proposerCalls, 2);
  assert.ok(result.loopRoot.startsWith(join(root, "runroot")), result.loopRoot);
  assert.equal(result.loopRoot.startsWith(repo), false);
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  assert.deepEqual(rows.map((row) => row.kind), ["cycle", "cycle"]);
  for (const row of rows) {
    assert.equal(row.proposal.source, "agent");
    assert.equal(row.campaignId, result.campaignId);
    assert.equal(row.verdict.decision, "reject");
    assert.ok(row.verdict.reasons.includes("floor_not_met"), row.verdict.reasons.join(","));
    assert.equal(row.guards.length, 3);
  }
  assert.equal(rows[0].objective, "probe.decision_accuracy");
  const state = JSON.parse(readFileSync(result.statePath, "utf8"));
  assert.equal(state.schema, "gjc.self-improve.loop.v1");
  assert.equal(state.status, "ok");
  assert.equal(state.stoppedReason, "max_cycles");
  assert.equal(state.cycles.length, 2);
  assert.equal(state.cycles[0].cycleId, rows[0].cycleId);
  assert.equal(state.cycles[0].failureClass, null);
  const logLines = readFileSync(result.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(logLines.some((entry) => entry.type === "loop_start"));
  assert.equal(logLines.filter((entry) => entry.type === "cycle").length, 2);
  assert.ok(logLines.some((entry) => entry.type === "loop_stop"));
  for (const cycleIndex of [1, 2]) {
    const requestFile = join(result.loopRoot, `cycle-${cycleIndex}.request.json`);
    assert.ok(existsSync(requestFile), requestFile);
    const request = JSON.parse(readFileSync(requestFile, "utf8"));
    assert.equal(request.schema, "gjc.self-improve.proposer-request.v1");
    assert.match(request.baseCommit, /^[0-9a-f]{7,}$/);
  }
  assert.equal(JSON.parse(readFileSync(join(result.loopRoot, "cycle-1.request.json"), "utf8")).baseCommit, initialBase);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  const subjects = git(repo, ["log", "--format=%s"]).split("\n");
  assert.match(subjects[0], /^chore\(self-improve\): cycle /);
  assert.match(subjects[1], /^chore\(self-improve\): cycle /);
  rmSync(root, { recursive: true, force: true });
});

test("bounds: max cycles, proposer calls and wall clock each stop the loop", async () => {
  {
    const { root, repo } = makeFixture();
    const fake = makeFakeGuards();
    const result = await runLoop(
      loopInput({ root, repo, deps: { runGuards: fake.runGuards, evaluateProbes: flatProbes }, maxCycles: 1, maxProposerCalls: 5 }),
    );
    assert.equal(result.stoppedReason, "max_cycles");
    assert.equal(result.counters.cycles, 1);
    assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 1);
    rmSync(root, { recursive: true, force: true });
  }
  {
    const { root, repo } = makeFixture();
    const fake = makeFakeGuards();
    const result = await runLoop(
      loopInput({ root, repo, deps: { runGuards: fake.runGuards, evaluateProbes: flatProbes }, maxCycles: 3, maxProposerCalls: 1 }),
    );
    assert.equal(result.stoppedReason, "max_proposer_calls");
    assert.equal(result.counters.cycles, 1);
    assert.equal(result.counters.proposerCalls, 1);
    rmSync(root, { recursive: true, force: true });
  }
  {
    const { root, repo } = makeFixture();
    const fake = makeFakeGuards();
    let tick = 0;
    const result = await runLoop(
      loopInput({
        root,
        repo,
        deps: { runGuards: fake.runGuards, evaluateProbes: flatProbes, now: () => (tick += 9000) },
        maxCycles: 5,
        maxProposerCalls: 5,
        maxWallMs: 8000,
      }),
    );
    assert.equal(result.stoppedReason, "max_wall_ms");
    assert.equal(result.counters.cycles, 0);
    assert.equal(result.counters.proposerCalls, 0);
    rmSync(root, { recursive: true, force: true });
  }
});

test("crash-resume: a pending apply journal is recovered before the loop runs", async () => {
  const { root, repo } = makeFixture();
  const runRoot = join(root, "runroot");
  const pendingDir = join(runRoot, "runs", "cyc-simulated");
  mkdirSync(pendingDir, { recursive: true });
  writeFileSync(join(pendingDir, "phase.json"), JSON.stringify({ phase: "applying", at: "simulated" }));
  writeFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "export const value = 999;\n");
  assert.notEqual(git(repo, ["status", "--porcelain"]), "");
  const fake = makeFakeGuards();
  const result = await runLoop(loopInput({ root, repo, deps: { runGuards: fake.runGuards, evaluateProbes: flatProbes }, maxCycles: 1 }));
  assert.deepEqual(result.recovery, [{ cycleId: "cyc-simulated", recovered: true, clean: true }]);
  assert.equal(JSON.parse(readFileSync(join(pendingDir, "phase.json"), "utf8")).phase, "rolled_back");
  assert.equal(readFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "utf8"), "export const value = 1;\n");
  assert.equal(result.counters.cycles, 1);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  rmSync(root, { recursive: true, force: true });
});

test("an adoption closes the cycle and stop-on-adopt ends the campaign", async () => {
  const { root, repo } = makeFixture();
  const baseCommits = Number(git(repo, ["rev-list", "--count", "HEAD"]));
  const fake = makeFakeGuards();
  const result = await runLoop(
    loopInput({
      root,
      repo,
      deps: { runGuards: fake.runGuards, evaluateProbes: improvingProbes },
      maxCycles: 5,
      maxProposerCalls: 5,
      stopOnAdopt: true,
    }),
  );
  assert.equal(result.stoppedReason, "adopted");
  assert.equal(result.counters.cycles, 1);
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  assert.deepEqual(rows.map((row) => row.kind), ["cycle", "adoption"]);
  assert.equal(rows[0].verdict.decision, "adopt");
  assert.equal(result.cycles[0].adoption, "committed");
  assert.equal(Number(git(repo, ["rev-list", "--count", "HEAD"])), baseCommits + 3);
  assert.match(git(repo, ["log", "--format=%s"]).split("\n")[1], /^chore\(jev-advisor\): loop stub change 1$/);
  assert.match(readFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "utf8"), /loop stub proposal cycle 1/);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  rmSync(root, { recursive: true, force: true });
});

test("guard failures reject without retries and the flake signature is classified in loop state", async () => {
  {
    const { root, repo } = makeFixture();
    const fake = makeFakeGuards({ failBuild: true });
    const result = await runLoop(loopInput({ root, repo, deps: { runGuards: fake.runGuards, evaluateProbes: improvingProbes }, maxCycles: 2 }));
    assert.equal(result.counters.cycles, 2);
    for (const entry of result.cycles) {
      assert.equal(entry.decision, "reject");
      assert.ok(entry.reasons.includes("guard_fail"), entry.reasons.join(","));
      assert.equal(entry.failureClass, "other");
    }
    assert.equal(fake.state.calls, 4);
    assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 2);
    rmSync(root, { recursive: true, force: true });
  }
  {
    const { root, repo } = makeFixture();
    // Verbatim shape of the observed R7 log: file path and assertion on separate lines.
    const flakeText = [
      "shared/tests/results.test.ts:",
      "157 |",
      "158 | test('concurrent appenders serialize without stealing and preserve every reported stored ID', async () => {",
      "error: expect(received).toContain(expected)",
      "      at <anonymous> (shared/tests/results.test.ts:162:66)",
      "(fail) concurrent appenders serialize without stealing and preserve every reported stored ID [47.53ms]",
      "",
    ].join("\n");
    const fake = makeFakeGuards({ failBuild: true, flakeText });
    const result = await runLoop(loopInput({ root, repo, deps: { runGuards: fake.runGuards, evaluateProbes: improvingProbes }, maxCycles: 1 }));
    assert.equal(result.cycles[0].failureClass, "known_flake_suspect");
    assert.equal(JSON.parse(readFileSync(result.statePath, "utf8")).cycles[0].failureClass, "known_flake_suspect");
    rmSync(root, { recursive: true, force: true });
  }
  {
    const { root, repo } = makeFixture();
    const unrelatedText = "shared/tests/results.test.ts:\n 39 pass\n 0 fail\n";
    const fake = makeFakeGuards({ failBuild: true, flakeText: unrelatedText });
    const result = await runLoop(loopInput({ root, repo, deps: { runGuards: fake.runGuards, evaluateProbes: improvingProbes }, maxCycles: 1 }));
    assert.equal(result.cycles[0].failureClass, "other");
    rmSync(root, { recursive: true, force: true });
  }
});

test("live mode refuses without --live-approved and records skipped", async () => {
  const { root, repo } = makeFixture();
  const fake = makeFakeGuards();
  const result = await runLoop(
    loopInput({
      root,
      repo,
      deps: { runGuards: fake.runGuards, evaluateProbes: flatProbes },
      proposer: "cmd",
      proposerCmd: "node -e 'process.exit(0)' {response}",
      liveApproved: false,
    }),
  );
  assert.equal(result.status, "skipped");
  assert.equal(result.reason, "live_not_approved");
  assert.equal(result.counters?.cycles ?? 0, 0);
  const state = JSON.parse(readFileSync(result.statePath, "utf8"));
  assert.equal(state.status, "skipped");
  assert.equal(state.stoppedReason, "live_not_approved");
  assert.equal(state.liveApproved, false);
  assert.equal(fake.state.calls, 0);
  assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 0);
  const logLines = readFileSync(result.logPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(logLines.some((entry) => entry.type === "skipped" && entry.reason === "live_not_approved"));
  rmSync(root, { recursive: true, force: true });
});

test("--install flows from the loop into the adopted cycle row", async () => {
  const { root, repo } = makeFixture();
  const fake = makeFakeGuards();
  const result = await runLoop(
    loopInput({
      root,
      repo,
      deps: {
        runGuards: fake.runGuards,
        evaluateProbes: improvingProbes,
        runInstall: () => ({ install: "upgraded", plugin: "jev-advisor" }),
      },
      maxCycles: 1,
      install: true,
    }),
  );
  assert.equal(result.cycles[0].adoption, "committed");
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  assert.equal(rows.at(-1).kind, "adoption");
  assert.equal(rows.at(-1).install, "upgraded");
  const state = JSON.parse(readFileSync(result.statePath, "utf8"));
  assert.equal(state.caps.install, true);
  rmSync(root, { recursive: true, force: true });
});

test("objective selection prefers the metric that owns the failing probe cases", async () => {
  const seeded = (repo) => {
    const ledgerPath = join(repo, "self-improve", "ledger.jsonl");
    for (let index = 1; index <= 2; index += 1) {
      appendRow(
        ledgerPath,
        seedCycleRow({ cycleId: `cyc-seed-${index}`, objective: "probe.decision_accuracy", hypothesis: `seed ${index}`, decision: "reject" }),
      );
    }
  };
  const { root, repo } = makeFixture();
  seeded(repo);
  const fake = makeFakeGuards();
  const failing = await runLoop(
    loopInput({
      root,
      repo,
      deps: {
        runGuards: fake.runGuards,
        evaluateProbes: flatProbes,
        scanProbeFailures: () => ({
          ok: true,
          reason: null,
          failures: [
            { metric: "decision_accuracy", label: "decision_accuracy#10", summary: "decision_accuracy#10: documented tolerance boundary" },
          ],
        }),
      },
      maxCycles: 1,
      maxProposerCalls: 1,
    }),
  );
  // regularization alone would pick probe.extract_coverage here (0 attempts); the failing-case metric leads instead
  assert.equal(failing.cycles[0].objective, "probe.decision_accuracy");
  assert.equal(failing.cycles[0].selectionReason, "failing_cases");
  const request = JSON.parse(readFileSync(join(failing.loopRoot, "cycle-1.request.json"), "utf8"));
  assert.equal(request.objective, "probe.decision_accuracy");
  assert.deepEqual(request.failingCases, [
    { metric: "decision_accuracy", label: "decision_accuracy#10", summary: "decision_accuracy#10: documented tolerance boundary" },
  ]);
  rmSync(root, { recursive: true, force: true });

  const { root: controlRoot, repo: controlRepo } = makeFixture();
  seeded(controlRepo);
  const controlFake = makeFakeGuards();
  const control = await runLoop(
    loopInput({
      root: controlRoot,
      repo: controlRepo,
      deps: { runGuards: controlFake.runGuards, evaluateProbes: flatProbes },
      maxCycles: 1,
      maxProposerCalls: 1,
    }),
  );
  assert.equal(control.cycles[0].objective, "probe.extract_coverage");
  assert.equal(control.cycles[0].selectionReason, "regularization");
  rmSync(controlRoot, { recursive: true, force: true });
});

test("a non-applying patch is a soft proposal failure: the loop continues and a later proposal still runs", async () => {
  const { root, repo } = makeFixture();
  const scriptPath = join(root, "two-phase-proposer.mjs");
  const callsFile = join(root, "calls.txt");
  writeFileSync(
    scriptPath,
    [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n",
      "import { join } from 'node:path';\n",
      "const [requestPath, responsePath] = process.argv.slice(2);\n",
      "const request = JSON.parse(readFileSync(requestPath, 'utf8'));\n",
      "const calls = existsSync(process.env.CALLS_FILE) ? Number(readFileSync(process.env.CALLS_FILE, 'utf8')) : 0;\n",
      "writeFileSync(process.env.CALLS_FILE, String(calls + 1));\n",
      "const rel = 'jev-advisor/lib/decision.ts';\n",
      "let patch;\n",
      "if (calls === 0) {\n",
      "  // deliberately wrong context: the engine must reject it with patch_check_failed\n",
      "  patch = ['diff --git a/' + rel + ' b/' + rel, '--- a/' + rel, '+++ b/' + rel, '@@ -1,1 +1,1 @@', '-export const value = 999;', '+export const value = 1000;', ''].join('\\n');\n",
      "} else {\n",
      "  const original = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\\n$/, '');\n",
      "  const lines = original.split('\\n');\n",
      "  const kept = lines.slice(-3);\n",
      "  const start = lines.length - kept.length + 1;\n",
      "  patch = ['diff --git a/' + rel + ' b/' + rel, '--- a/' + rel, '+++ b/' + rel, '@@ -' + start + ',' + kept.length + ' +' + start + ',' + (kept.length + 1) + ' @@', ...kept.map((line) => ' ' + line), '+// soft-continue fixture proposal', ''].join('\\n');\n",
      "}\n",
      "writeFileSync(responsePath, JSON.stringify({ hypothesis: 'two-phase proposal ' + (calls + 1), objective: request.objective, commitMessage: 'chore(jev-advisor): soft-continue fixture ' + (calls + 1), patch }));\n",
    ].join(""),
  );
  const fake = makeFakeGuards();
  const result = await runLoop(
    loopInput({
      root,
      repo,
      deps: { runGuards: fake.runGuards, evaluateProbes: improvingProbes },
      proposer: "cmd",
      proposerCmd: `CALLS_FILE=${callsFile} node ${scriptPath} {request} {response}`,
      liveApproved: true,
      maxCycles: 1,
      maxProposerCalls: 2,
    }),
  );
  assert.equal(result.status, "ok");
  assert.equal(result.stoppedReason, "max_cycles", "a non-applying patch must not stop the loop");
  assert.equal(result.counters.invalidProposals, 1);
  assert.equal(result.counters.cycles, 1);
  assert.deepEqual(result.cycles.map((entry) => entry.status), ["proposal_failed", "ok"]);
  assert.equal(result.cycles[0].reason, "patch_check_failed");
  assert.match(result.cycles[0].detail ?? "", /patch failed/);
  assert.match(result.cycles[0].reasons[0], /^patch_check_failed at .*: hunk context mismatch$/);
  assert.equal(result.cycles[1].decision, "adopt");
  const secondRequest = JSON.parse(readFileSync(join(result.loopRoot, "cycle-2.request.json"), "utf8"));
  assert.equal(
    secondRequest.priorAttempts.some((entry) => (entry.reasons ?? []).join(" ").includes("patch_check_failed")),
    true,
    "the non-applying proposal must feed the next request as a prior attempt",
  );
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  rmSync(root, { recursive: true, force: true });
});

test("an invalid (unparseable) patch is a soft proposal failure: the loop continues and feeds the next request", async () => {
  const { root, repo } = makeFixture();
  const scriptPath = join(root, "schema-phase-proposer.mjs");
  const callsFile = join(root, "schema-calls.txt");
  writeFileSync(
    scriptPath,
    [
      "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n",
      "import { join } from 'node:path';\n",
      "const [requestPath, responsePath] = process.argv.slice(2);\n",
      "const request = JSON.parse(readFileSync(requestPath, 'utf8'));\n",
      "const calls = existsSync(process.env.CALLS_FILE) ? Number(readFileSync(process.env.CALLS_FILE, 'utf8')) : 0;\n",
      "writeFileSync(process.env.CALLS_FILE, String(calls + 1));\n",
      "const rel = 'jev-advisor/lib/decision.ts';\n",
      "let patch;\n",
      "if (calls === 0) {\n",
      "  // hunk header with no body: an unparseable / corrupt patch\n",
      "  patch = ['diff --git a/' + rel + ' b/' + rel, '--- a/' + rel, '+++ b/' + rel, '@@ -1,3 +1,3 @@', ''].join('\\n');\n",
      "} else {\n",
      "  const original = readFileSync(join(process.cwd(), rel), 'utf8').replace(/\\n$/, '');\n",
      "  const lines = original.split('\\n');\n",
      "  const kept = lines.slice(-3);\n",
      "  const start = lines.length - kept.length + 1;\n",
      "  patch = ['diff --git a/' + rel + ' b/' + rel, '--- a/' + rel, '+++ b/' + rel, '@@ -' + start + ',' + kept.length + ' +' + start + ',' + (kept.length + 1) + ' @@', ...kept.map((line) => ' ' + line), '+// invalid-schema fixture proposal', ''].join('\\n');\n",
      "}\n",
      "writeFileSync(responsePath, JSON.stringify({ hypothesis: 'schema-phase proposal ' + (calls + 1), objective: request.objective, commitMessage: 'chore(jev-advisor): schema-phase fixture ' + (calls + 1), patch }));\n",
    ].join(""),
  );
  const fake = makeFakeGuards();
  const result = await runLoop(
    loopInput({
      root,
      repo,
      deps: { runGuards: fake.runGuards, evaluateProbes: improvingProbes },
      proposer: "cmd",
      proposerCmd: `CALLS_FILE=${callsFile} node ${scriptPath} {request} {response}`,
      liveApproved: true,
      maxCycles: 1,
      maxProposerCalls: 2,
    }),
  );
  assert.equal(result.status, "ok");
  assert.equal(result.stoppedReason, "max_cycles", "an invalid patch must not stop the loop");
  assert.equal(result.counters.cycles, 1);
  assert.equal(result.cycles[0].status, "proposal_invalid");
  assert.ok((result.cycles[0].reasons ?? []).length > 0, "the invalid proposal must carry a reason");
  const secondRequest = JSON.parse(readFileSync(join(result.loopRoot, "cycle-2.request.json"), "utf8"));
  assert.equal(
    secondRequest.priorAttempts.some((entry) => (entry.reasons ?? []).length > 0),
    true,
    "the invalid proposal must feed the next request as a prior attempt",
  );
  rmSync(root, { recursive: true, force: true });
});

test("the loop CLI --install flag reaches the loop caps", () => {
  const { root, repo } = makeFixture();
  const runRoot = join(root, "cli-runroot");
  const cli = join(REPO_ROOT, "self-improve", "scripts", "run.mjs");
  const proc = spawnSync(
    process.execPath,
    [cli, "loop", "--repo", repo, "--proposer", "cmd", "--proposer-cmd", "true {response}", "--install", "--proposer-timeout-ms", "1234", "--run-root", runRoot, "--json"],
    { encoding: "utf8", timeout: 60000 },
  );
  assert.equal(proc.status, 0, proc.stderr);
  const out = JSON.parse(proc.stdout);
  assert.equal(out.status, "skipped");
  assert.equal(out.reason, "live_not_approved");
  const state = JSON.parse(readFileSync(out.statePath, "utf8"));
  assert.equal(state.caps.install, true);
  assert.equal(state.caps.cmdProposerTimeoutMs, 1234);
  rmSync(root, { recursive: true, force: true });
});

test("cmd proposer smoke: approved trivial template drives one cycle, scratch excludes held-out, no secret leaks", async () => {
  const { root, repo } = makeFixture();
  const scriptPath = join(root, "cmd-proposer.mjs");
  writeFileSync(
    scriptPath,
    [
      "import { readFileSync, writeFileSync } from \"node:fs\";",
      "const [requestPath, responsePath] = process.argv.slice(2);",
      "const request = JSON.parse(readFileSync(requestPath, \"utf8\"));",
      "const patch = [",
      "  \"diff --git a/verification-receipts/lib/cmd-smoke.ts b/verification-receipts/lib/cmd-smoke.ts\",",
      "  \"new file mode 100644\",",
      "  \"--- /dev/null\",",
      "  \"+++ b/verification-receipts/lib/cmd-smoke.ts\",",
      "  \"@@ -0,0 +1,1 @@\",",
      "  \"+export const cmdSmoke = 1;\",",
      "  \"\",",
      "].join(\"\\n\");",
      "writeFileSync(responsePath, JSON.stringify({",
      "  hypothesis: `cmd smoke ${request.objective} cycle ${request.cycleIndex}`,",
      "  commitMessage: \"chore(verification-receipts): cmd proposer smoke\",",
      "  patch,",
      "  debug: { cwd: process.cwd(), sentinel: process.env.LOOP_TEST_SENTINEL ?? \"absent\" },",
      "}, null, 2));",
      "",
    ].join("\n"),
  );
  const sentinel = "loop-test-sentinel-value";
  const fake = makeFakeGuards();
  const result = await runLoop(
    loopInput({
      root,
      repo,
      deps: {
        runGuards: fake.runGuards,
        evaluateProbes: flatProbes,
        proposerEnv: { ...process.env, LOOP_TEST_SENTINEL: sentinel },
      },
      proposer: "cmd",
      proposerCmd: `node ${scriptPath} {request} {response}`,
      liveApproved: true,
      maxCycles: 1,
      maxProposerCalls: 2,
    }),
  );
  assert.equal(result.status, "ok");
  assert.equal(result.counters.cycles, 1);
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proposal.source, "agent");
  assert.deepEqual(rows[0].proposal.files, ["verification-receipts/lib/cmd-smoke.ts"]);
  const scratchDirs = readdirSync(result.loopRoot).filter((name) => name.startsWith("scratch-cycle-"));
  assert.equal(scratchDirs.length, 1);
  const scratch = join(result.loopRoot, scratchDirs[0]);
  assert.equal(existsSync(join(scratch, "self-improve", "domains")), false);
  assert.equal(existsSync(join(scratch, "jev-advisor", "lib", "decision.ts")), true);
  const requestFile = join(result.loopRoot, "cycle-1.request.json");
  assert.equal(readFileSync(requestFile, "utf8").includes(sentinel), false);
  const logText = readFileSync(result.logPath, "utf8");
  assert.equal(logText.includes(sentinel), false);
  const stateText = readFileSync(result.statePath, "utf8");
  assert.equal(stateText.includes(sentinel), false);
  const response = JSON.parse(readFileSync(join(result.loopRoot, "cycle-1.response.json"), "utf8"));
  assert.equal(response.debug.sentinel, "absent");
  rmSync(root, { recursive: true, force: true });
});
