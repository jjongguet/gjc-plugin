import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { distillTrajectories } from "../../lib/distill.mjs";
import { runLoop } from "../../lib/loop.mjs";
import { sha256Hex } from "../../lib/types.mjs";
import { buildFixture } from "../fixtures/distill-fixture.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ECHO_PROPOSER = join(REPO_ROOT, "self-improve", "tests", "fixtures", "proposer-echo.mjs");

function git(cwd, args) {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "self-improve-distill-handoff-"));
  const repo = join(root, "repo");
  mkdirSync(join(root, "shared", "workspace-standard", "validator"), { recursive: true });
  writeFileSync(join(root, "shared", "workspace-standard", "validator", "cli.mjs"), "");
  mkdirSync(join(repo, "jev-advisor", "lib"), { recursive: true });
  mkdirSync(join(repo, "jev-advisor", "src"), { recursive: true });
  mkdirSync(join(repo, "jev-advisor", "tests"), { recursive: true });
  mkdirSync(join(repo, "verification-receipts", "lib"), { recursive: true });
  mkdirSync(join(repo, "self-improve", "domains", "gjc-plugin", "heldout"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","private":true,"type":"module"}\n');
  writeFileSync(join(repo, ".gitignore"), "self-improve/ledger.jsonl\n");
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

function passingGuards() {
  return async ({ guards }) =>
    guards.map((guard) => ({ id: guard.id, status: "pass", exitCode: 0, durationMs: 1, logPath: null }));
}

function writeLedger(repo, rows) {
  writeFileSync(join(repo, "self-improve", "ledger.jsonl"), `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

function handoffInput({ root, repo, candidatePath, maxLag = 0 }) {
  return {
    repoRoot: repo,
    adapter: DOMAIN,
    proposer: "cmd",
    proposerCmd: `node ${ECHO_PROPOSER} {request} {response}`,
    liveApproved: true,
    candidatePath,
    maxLag,
    maxCycles: 1,
    maxProposerCalls: 1,
    batchSize: 1,
    includeSmoke: false,
    dryRun: true,
    runRoot: join(root, "runroot"),
    ledgerPath: join(repo, "self-improve", "ledger.jsonl"),
    deps: {
      runGuards: passingGuards(),
      evaluateProbes: improvingProbes,
      scanProbeFailures: () => ({ ok: true, reason: null, failures: [] }),
    },
  };
}

test("candidate handoff reaches a dry-run decision with the contrast in the request", async () => {
  const { root, repo } = makeFixture();
  const fixture = buildFixture();
  writeLedger(repo, fixture.ledgerRows);
  const ledgerPath = join(repo, "self-improve", "ledger.jsonl");
  const ledgerShaBefore = sha256Hex(readFileSync(ledgerPath, "utf8"));
  const distill = distillTrajectories({
    store: fixture.store,
    ledgerRows: fixture.ledgerRows,
    declaredObjectives: fixture.declared,
    gatedObjective: fixture.gated,
  });
  assert.equal(distill.candidates.length, 1);
  const candidate = distill.candidates[0];
  const candidatePath = join(root, "candidate.json");
  writeFileSync(candidatePath, `${JSON.stringify(candidate, null, 2)}\n`);

  const result = await runLoop(handoffInput({ root, repo, candidatePath }));
  assert.equal(result.status, "ok", JSON.stringify(result));
  assert.equal(result.stoppedReason, "candidate_consumed");
  assert.equal(result.cycles.length, 1);
  assert.equal(result.cycles[0].status, "dry-run");
  assert.equal(result.cycles[0].reasons.includes("forced_exploration"), false);

  const request = JSON.parse(readFileSync(join(result.loopRoot, "cycle-1.request.json"), "utf8"));
  assert.equal(request.contrast.candidateId, candidate.id);
  assert.equal(request.contrast.objective, candidate.objective);
  assert.equal(request.contrast.rule, candidate.rule);
  assert.ok(existsSync(join(result.loopRoot, "patches", "cycle-1.patch")));

  assert.equal(sha256Hex(readFileSync(ledgerPath, "utf8")), ledgerShaBefore);
  assert.equal(git(repo, ["status", "--porcelain"]), "");
});

test("a contradicted, stale, or tampered candidate is refused before any request", async () => {
  const { root, repo } = makeFixture();
  const fixture = buildFixture();
  writeLedger(repo, fixture.ledgerRows);
  const distill = distillTrajectories({
    store: fixture.store,
    ledgerRows: fixture.ledgerRows,
    declaredObjectives: fixture.declared,
    gatedObjective: fixture.gated,
  });
  const candidate = distill.candidates[0];

  const contradicted = {
    ...candidate,
    contrast: { ...candidate.contrast, contradiction: { adopts: 1, rejects: 1 } },
  };
  contradicted.id = `cand-${sha256Hex(JSON.stringify((({ id, ...rest }) => rest)(contradicted))).slice(0, 12)}`;
  const contradictedPath = join(root, "contradicted.json");
  writeFileSync(contradictedPath, JSON.stringify(contradicted));
  const contradictedRun = await runLoop(handoffInput({ root, repo, candidatePath: contradictedPath }));
  assert.equal(contradictedRun.status, "skipped");
  assert.equal(contradictedRun.reason, "candidate_contradicted");

  const tampered = { ...candidate, rule: "tampered rule" };
  const tamperedPath = join(root, "tampered.json");
  writeFileSync(tamperedPath, JSON.stringify(tampered));
  const tamperedRun = await runLoop(handoffInput({ root, repo, candidatePath: tamperedPath }));
  assert.equal(tamperedRun.reason, "candidate_tampered");

  const stale = { ...candidate, expires: { kind: "ledger_seq", after: 0 } };
  stale.id = `cand-${sha256Hex(JSON.stringify((({ id, ...rest }) => rest)(stale))).slice(0, 12)}`;
  const stalePath = join(root, "stale.json");
  writeFileSync(stalePath, JSON.stringify(stale));
  const staleRun = await runLoop(handoffInput({ root, repo, candidatePath: stalePath }));
  assert.equal(staleRun.reason, "candidate_stale");

  assert.equal(existsSync(join(root, "runroot")), false);
});
