import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { runLoop } from "../../lib/loop.mjs";
import { readLedger } from "../../lib/ledger.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HELPER = join(REPO_ROOT, "self-improve", "scripts", "propose-with-gjc.mjs");
const NEW_FILE_PATCH = [
  "diff --git a/verification-receipts/lib/gjc-proposer-smoke.ts b/verification-receipts/lib/gjc-proposer-smoke.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/verification-receipts/lib/gjc-proposer-smoke.ts",
  "@@ -0,0 +1,1 @@",
  "+export const gjcProposerSmoke = 1;",
  "",
].join("\n");

function git(cwd, args) {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "self-improve-loop-cmd-gjc-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "jev-advisor", "lib"), { recursive: true });
  mkdirSync(join(repo, "verification-receipts", "lib"), { recursive: true });
  mkdirSync(join(repo, "self-improve", "domains", "gjc-plugin", "heldout"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","private":true,"type":"module"}\n');
  writeFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "export const value = 1;\n");
  writeFileSync(join(repo, "verification-receipts", "lib", "extra.ts"), "export const extra = 1;\n");
  writeFileSync(join(repo, "self-improve", "domains", "gjc-plugin", "heldout", "fixtures.json"), '{"cases":{"sentinel":"heldout-content-sentinel"}}\n');
  writeFileSync(join(repo, "self-improve", "ledger.jsonl"), "");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture base"]);
  return { root, repo };
}

const flatProbes = async () => ({
  baseline: { decision_accuracy: 0.9 },
  candidate: { decision_accuracy: 0.9 },
  delta: 0,
  heldout: { baseline: {}, candidate: {} },
});

function makeFakeGuards() {
  const state = { calls: 0 };
  const runGuards = async ({ guards }) => {
    state.calls += 1;
    return guards.map((guard) => ({ id: guard.id, status: "pass", exitCode: 0, durationMs: 1, logPath: null }));
  };
  return { runGuards, state };
}

test("the live-proposer helper drives a cycle through a fake gjc shim (no model calls)", async () => {
  const { root, repo } = makeFixture();
  const shim = join(root, "fake-gjc.mjs");
  const argsOut = join(root, "shim-args.json");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env node",
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.SHIM_ARGS_OUT, JSON.stringify(process.argv.slice(2)));",
      `process.stdout.write(JSON.stringify({ hypothesis: 'shim gjc proposal cycle 1', commitMessage: 'chore(verification-receipts): shim gjc proposal', patch: ${JSON.stringify(NEW_FILE_PATCH)} }));`,
      "",
    ].join("\n"),
  );
  chmodSync(shim, 0o755);
  const fake = makeFakeGuards();
  const sentinel = "cmd-gjc-sentinel-value";
  const result = await runLoop({
    repoRoot: repo,
    adapter: DOMAIN,
    proposer: "cmd",
    proposerCmd: `SHIM_ARGS_OUT=${argsOut} GJC_PROPOSER_BIN=${shim} node ${HELPER} {request} {response}`,
    liveApproved: true,
    maxCycles: 1,
    maxProposerCalls: 2,
    runRoot: join(root, "runroot"),
    ledgerPath: join(repo, "self-improve", "ledger.jsonl"),
    includeSmoke: false,
    deps: {
      runGuards: fake.runGuards,
      evaluateProbes: flatProbes,
      scanProbeFailures: () => ({ ok: true, reason: null, failures: [] }),
      proposerEnv: { ...process.env, CMD_GJC_SENTINEL: sentinel },
    },
  });
  assert.equal(result.status, "ok");
  assert.equal(result.counters.cycles, 1);
  assert.equal(result.counters.proposerCalls, 1);
  assert.equal(result.counters.invalidProposals, 0);
  const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].proposal.source, "agent");
  assert.deepEqual(rows[0].proposal.files, ["verification-receipts/lib/gjc-proposer-smoke.ts"]);
  assert.equal(rows[0].verdict.decision, "reject");
  assert.ok(rows[0].verdict.reasons.includes("floor_not_met"), rows[0].verdict.reasons.join(","));

  const response = JSON.parse(readFileSync(join(result.loopRoot, "cycle-1.response.json"), "utf8"));
  assert.equal(response.hypothesis, "shim gjc proposal cycle 1");
  assert.match(response.patch, /verification-receipts\/lib\/gjc-proposer-smoke\.ts/);
  const request = JSON.parse(readFileSync(join(result.loopRoot, "cycle-1.request.json"), "utf8"));
  assert.equal(request.schema, "gjc.self-improve.proposer-request.v1");

  const shimArgs = JSON.parse(readFileSync(argsOut, "utf8"));
  assert.ok(shimArgs.includes("--print"));
  assert.ok(shimArgs.includes("--no-tools"));
  const prompt = shimArgs.at(-1);
  assert.match(prompt, /REQUEST:/);
  assert.ok(prompt.includes(request.objective), "prompt must carry the requested objective");
  assert.ok(prompt.includes(request.baseCommit), "prompt must carry the base commit constraint");
  // the helper embeds the scratch's editable files so the proposer is not blind
  assert.match(prompt, /Current file contents — author your patch against exactly these:/);
  assert.match(prompt, /--- verification-receipts\/lib\/extra\.ts/);
  assert.ok(prompt.includes("export const extra = 1;"), "editable file contents must reach the prompt");
  assert.equal(prompt.includes("heldout-content-sentinel"), false, "held-out content must never be embedded");
  assert.equal(prompt.includes(sentinel), false, "env values must not reach the model prompt");

  const scratchDirs = readdirSync(result.loopRoot).filter((name) => name.startsWith("scratch-cycle-"));
  assert.equal(scratchDirs.length, 1);
  assert.equal(existsSync(join(result.loopRoot, scratchDirs[0], "self-improve", "domains")), false);
  assert.equal(readFileSync(result.logPath, "utf8").includes(sentinel), false);
  assert.equal(readFileSync(result.statePath, "utf8").includes(sentinel), false);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
  rmSync(root, { recursive: true, force: true });
});
