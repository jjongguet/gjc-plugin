import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { runLoop } from "../../lib/loop.mjs";
import { readLedger } from "../../lib/ledger.mjs";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO_ROOT = resolve(SELF_IMPROVE_DIR, "..");
const CLI = join(SELF_IMPROVE_DIR, "scripts", "run.mjs");
const OBJECTIVE = "probe.decision_accuracy";
const HELDOUT_SENTINEL = "HELDOUT_COMPOSE_CLI_271_SENTINEL";

function git(cwd, args) {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function appendPatch(rel, original, appendedLine) {
  const context = original.endsWith("\n") ? original.slice(0, -1) : original;
  return [`diff --git a/${rel} b/${rel}`, `--- a/${rel}`, `+++ b/${rel}`, "@@ -1,1 +1,2 @@", ` ${context}`, `+${appendedLine}`, ""].join(
    "\n",
  );
}

function newFilePatch(rel, line) {
  return [
    `diff --git a/${rel} b/${rel}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${rel}`,
    "@@ -0,0 +1,1 @@",
    `+${line}`,
    "",
  ].join("\n");
}

/**
 * Synthetic repository for the compose CLI. The decision module is a minimal
 * deterministic stand-in so the repository's real probe runner can score it;
 * guards are satisfied by fake `bun`/`gjc` binaries on PATH plus a no-op smoke
 * host, so the CLI run never installs anything and never reaches a provider.
 */
function makeRepo({ heldoutSentinel = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "self-improve-compose-cli-"));
  const repo = join(root, "repo");
  write(join(repo, "package.json"), '{"name":"compose-cli-fixture","private":true,"type":"module"}\n');
  write(
    join(repo, "jev-advisor", "lib", "decision.ts"),
    [
      "export function extractTasks() { return { tasks: [], rejected: [], omittedCount: 0 }; }",
      "export function parseDecision() { return { status: \"no_decision\" }; }",
      "export function isAllowedEndpoint() { return false; }",
      "",
    ].join("\n"),
  );
  write(join(repo, "jev-advisor", "src", "alpha.adapter.ts"), "export const alpha = 1;\n");
  write(join(repo, "verification-receipts", "lib", "extra.ts"), "export const extra = 1;\n");
  write(join(repo, "verification-receipts", "scripts", "smoke-host.mjs"), "process.exit(0);\n");
  write(join(repo, "jev-advisor", "tests", "decision.test.ts"), "// protected\n");
  write(
    join(repo, "self-improve", "domains", "gjc-plugin", "probes", "fixtures.json"),
    `${JSON.stringify({ cases: {} }, null, 2)}\n`,
  );
  write(
    join(repo, "self-improve", "domains", "gjc-plugin", "heldout", "fixtures.json"),
    `${JSON.stringify(
      heldoutSentinel ? { cases: { heldout_coverage: [{ note: HELDOUT_SENTINEL }] } } : { cases: {} },
      null,
      2,
    )}\n`,
  );
  write(join(repo, "self-improve", "ledger.jsonl"), "");
  // This fixture exercises the CLI wiring, not the cost gate: its synthetic probes
  // emit no score delta, so a hosted runner's wall-clock jitter would otherwise make
  // `cost_rule` a hard reason and abstain the composition. The cost gate keeps its
  // real thresholds here; the dedicated compose suite asserts it with injected costs.
  write(join(repo, "self-improve", "rrsi.json"), `${JSON.stringify({ cost: { wallMsBytesIncreaseRatio: 1000 } }, null, 2)}\n`);
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture base"]);
  return { root, repo };
}

function makeFakeTools(root) {
  const bin = join(root, "bin");
  const bunLog = join(root, "bun-calls.log");
  const gjcLog = join(root, "gjc-calls.log");
  write(bunLog, "");
  write(gjcLog, "");
  const which = spawnSync("which", ["bun"], { encoding: "utf8" });
  const realBun = which.status === 0 ? which.stdout.trim() : null;
  if (realBun === null) return { bin, bunLog, gjcLog, realBun };
  write(
    join(bin, "bun"),
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      'import { spawnSync } from "node:child_process";',
      `appendFileSync(${JSON.stringify(bunLog)}, process.argv.slice(2).join(" ") + "\\n");`,
      'if (process.argv[2] === "run") process.exit(0);',
      `const real = ${JSON.stringify(realBun)};`,
      "const result = spawnSync(real, process.argv.slice(2), { stdio: \"inherit\" });",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
  );
  write(
    join(bin, "gjc"),
    [
      "#!/usr/bin/env node",
      'import { appendFileSync } from "node:fs";',
      `appendFileSync(${JSON.stringify(gjcLog)}, process.argv.slice(2).join(" ") + "\\n");`,
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "bun"), 0o755);
  chmodSync(join(bin, "gjc"), 0o755);
  return { bin, bunLog, gjcLog, realBun };
}

function writeProposal(dir, name, proposal) {
  const file = join(dir, name);
  write(file, `${JSON.stringify(proposal, null, 2)}\n`);
  return file;
}

function writeManifest(dir, manifest) {
  const file = join(dir, "compose.json");
  write(file, `${JSON.stringify(manifest, null, 2)}\n`);
  return file;
}

function runCli(args, { env = process.env, timeout = 150000 } = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    env,
    encoding: "utf8",
    timeout,
  });
}

function composeRefusal(root, { candidates, manifestExtra = {}, repo } = {}) {
  return {
    schema: "gjc.self-improve.compose-input.v1",
    objective: OBJECTIVE,
    candidates: candidates ?? [join(root, "a.json"), join(root, "b.json")],
    ...manifestExtra,
    ...(repo ? { repo } : {}),
  };
}

test("compose CLI refuses invalid flags, counts and caller-supplied provenance before executing", () => {
  const { root, repo } = makeRepo();
  try {
    const missing = runCli(["compose", "--json"]);
    assert.equal(missing.status, 2);
    assert.match(missing.stderr, /compose requires --proposals/);

    const unknown = runCli(["compose", "--proposals", join(root, "compose.json"), "--bogus"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown option: --bogus/);

    const proposalA = writeProposal(root, "a.json", {
      hypothesis: "candidate a",
      commitMessage: "chore(verification-receipts): candidate a",
      patchFile: "a.patch",
    });
    write(join(root, "a.patch"), newFilePatch("verification-receipts/lib/a.ts", "export const a = 1;"));
    const proposalB = writeProposal(root, "b.json", {
      hypothesis: "candidate b",
      commitMessage: "chore(verification-receipts): candidate b",
      patchFile: "b.patch",
    });
    write(join(root, "b.patch"), newFilePatch("verification-receipts/lib/b.ts", "export const b = 1;"));

    const wrongSchema = runCli([
      "compose",
      "--proposals",
      writeManifest(root, { ...composeRefusal(root), schema: "wrong-schema" }),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(wrongSchema.status, 2);
    assert.match(wrongSchema.stderr, /compose_input_schema_mismatch/);

    const oneCandidate = runCli([
      "compose",
      "--proposals",
      writeManifest(root, composeRefusal(root, { candidates: [proposalA] })),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(oneCandidate.status, 2);
    assert.match(oneCandidate.stderr, /compose_candidate_count_out_of_range/);
    assert.match(oneCandidate.stderr, /count=1 \(2\.\.4\)/);
    assert.equal(JSON.parse(oneCandidate.stdout).status, "refused");

    const fiveCandidates = runCli([
      "compose",
      "--proposals",
      writeManifest(root, composeRefusal(root, { candidates: [proposalA, proposalB, proposalA, proposalB, proposalA] })),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(fiveCandidates.status, 2);
    assert.match(fiveCandidates.stderr, /compose_candidate_count_out_of_range/);
    assert.match(fiveCandidates.stderr, /count=5 \(2\.\.4\)/);

    const forgedManifest = runCli([
      "compose",
      "--proposals",
      writeManifest(
        root,
        composeRefusal(root, { manifestExtra: { composition: { schema: "gjc.self-improve.compose.v1" } } }),
      ),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(forgedManifest.status, 2);
    assert.match(forgedManifest.stderr, /compose_input_carries_provenance/);

    const forgedCandidate = writeProposal(root, "forged.json", {
      hypothesis: "forged candidate",
      commitMessage: "chore(verification-receipts): forged",
      patchFile: "a.patch",
      patchSha256: "a".repeat(64),
      id: "cand-000000000000",
    });
    const forgedRun = runCli([
      "compose",
      "--proposals",
      writeManifest(root, composeRefusal(root, { candidates: [proposalA, forgedCandidate] })),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(forgedRun.status, 2);
    assert.match(forgedRun.stderr, /compose_candidate_carries_provenance/);

    const missingPatch = writeProposal(root, "missing-patch.json", {
      hypothesis: "no patch",
      commitMessage: "chore(verification-receipts): no patch",
    });
    const missingPatchRun = runCli([
      "compose",
      "--proposals",
      writeManifest(root, composeRefusal(root, { candidates: [proposalA, missingPatch] })),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(missingPatchRun.status, 2);
    assert.match(missingPatchRun.stderr, /compose_candidate_patch_required/);

    const absentPatch = writeProposal(root, "absent-patch.json", {
      hypothesis: "patch file is absent",
      commitMessage: "chore(verification-receipts): absent patch",
      patchFile: "absent.patch",
    });
    const absentPatchRun = runCli([
      "compose",
      "--proposals",
      writeManifest(root, composeRefusal(root, { candidates: [proposalA, absentPatch] })),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(absentPatchRun.status, 2);
    assert.match(absentPatchRun.stderr, /composition_candidate_patch_missing/);

    const objectiveMismatch = writeProposal(root, "other-objective.json", {
      hypothesis: "other objective",
      commitMessage: "chore(verification-receipts): other objective",
      objective: "probe.extract_coverage",
      patchFile: "b.patch",
    });
    const mismatchRun = runCli([
      "compose",
      "--proposals",
      writeManifest(root, composeRefusal(root, { candidates: [proposalA, objectiveMismatch] })),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(mismatchRun.status, 2);
    assert.match(mismatchRun.stderr, /compose_candidate_objective_mismatch/);

    const unreadable = runCli([
      "compose",
      "--proposals",
      writeManifest(root, composeRefusal(root, { candidates: [join(root, "absent.json"), proposalB] })),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(unreadable.status, 3);
    assert.match(unreadable.stderr, /compose_candidate_unreadable/);

    assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 0);
    assert.equal(existsSync(join(root, "bun-calls.log")), false);
    assert.equal(existsSync(join(root, "gjc-calls.log")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compose CLI refuses a composed patch that leaks a held-out value", () => {
  const { root, repo } = makeRepo({ heldoutSentinel: true });
  try {
    const cleanProposal = writeProposal(root, "clean.json", {
      hypothesis: "clean candidate",
      commitMessage: "chore(verification-receipts): clean",
      patchFile: "clean.patch",
    });
    write(join(root, "clean.patch"), newFilePatch("verification-receipts/lib/clean.ts", "export const clean = 1;"));
    const leakProposal = writeProposal(root, "leak.json", {
      hypothesis: "leaking candidate",
      commitMessage: "chore(verification-receipts): leak",
      patchFile: "leak.patch",
    });
    write(
      join(root, "leak.patch"),
      newFilePatch("verification-receipts/lib/leak.ts", `export const leak = ${JSON.stringify(HELDOUT_SENTINEL)};`),
    );
    const proc = runCli([
      "compose",
      "--proposals",
      writeManifest(root, composeRefusal(root, { candidates: [cleanProposal, leakProposal] })),
      "--repo",
      repo,
      "--json",
    ]);
    assert.equal(proc.status, 2);
    assert.match(proc.stderr, /heldout_verbatim_scan/);
    const refused = JSON.parse(proc.stdout);
    assert.equal(refused.status, "refused");
    assert.equal(refused.reason, "heldout_verbatim_scan");
    assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("compose CLI probes each candidate and the composed patch through the real entrypoint", (t) => {
  const { root, repo } = makeRepo();
  const tools = makeFakeTools(root);
  try {
    if (tools.realBun === null) {
      assert.ok(true, "bun is unavailable; the deterministic probe runner cannot be exercised");
      return;
    }
    const alphaOriginal = readFileSync(join(repo, "jev-advisor", "src", "alpha.adapter.ts"), "utf8");
    const extraOriginal = readFileSync(join(repo, "verification-receipts", "lib", "extra.ts"), "utf8");
    write(join(root, "a.patch"), appendPatch("jev-advisor/src/alpha.adapter.ts", alphaOriginal, "export const alphaCandidate = 1;"));
    write(
      join(root, "b.patch"),
      appendPatch("verification-receipts/lib/extra.ts", extraOriginal, "export const extraCandidate = 1;"),
    );
    const proposalA = writeProposal(root, "a.json", {
      hypothesis: "candidate a touches alpha",
      objective: OBJECTIVE,
      commitMessage: "fix(jev-advisor): candidate a",
      patchFile: "a.patch",
    });
    const proposalB = writeProposal(root, "b.json", {
      hypothesis: "candidate b touches extra",
      objective: OBJECTIVE,
      commitMessage: "fix(verification-receipts): candidate b",
      patchFile: "b.patch",
    });
    const manifest = writeManifest(root, {
      schema: "gjc.self-improve.compose-input.v1",
      objective: OBJECTIVE,
      hypothesis: "compose the two independent fixture candidates",
      candidates: ["a.json", "b.json"],
    });
    const proc = runCli(["compose", "--proposals", manifest, "--repo", repo, "--dry-run", "--json"], {
      env: { ...process.env, PATH: `${tools.bin}:${process.env.PATH ?? ""}` },
    });
    const refusal = (() => {
      try {
        const parsed = JSON.parse(proc.stdout);
        return `status=${parsed.status} reason=${parsed.reason ?? "-"} detail=${String(parsed.detail ?? "-").slice(0, 200)}`;
      } catch {
        return `stdout=${String(proc.stdout).slice(0, 200)}`;
      }
    })();
    // Hosted CI only: the refusal reason is otherwise hidden by TAP message truncation.
    t.diagnostic(`gjc-compose-cli-refusal: exit=${proc.status} ${refusal} stderrBytes=${String(proc.stderr ?? "").length}`);
    assert.equal(proc.status, 0, `${refusal} stderr=${String(proc.stderr).slice(0, 300)}`);
    const result = JSON.parse(proc.stdout);
    assert.equal(result.status, "dry-run");
    assert.equal(result.candidates.length, 2);
    assert.ok(result.candidates.every((candidate) => candidate.admissible === true));
    assert.equal(result.candidates.filter((candidate) => candidate.improved === true).length, 0);
    assert.equal(result.composed.status, "dry-run");
    assert.equal(result.composed.decision, "reject");
    assert.ok(result.composed.reasons.includes("floor_not_met"), result.composed.reasons.join(","));
    assert.match(result.composition.composedSha256, /^[0-9a-f]{64}$/);
    assert.equal(result.composition.sources.length, 2);
    assert.match(result.baselineFingerprint, /^[0-9a-f]{64}$/);

    // The fake binaries make the executed commands observable: only guard
    // build/test calls and the repository's own deterministic probe runner ran;
    // the only gjc call is the isolated smoke install attempt.
    const bunCalls = readFileSync(tools.bunLog, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(bunCalls.length > 0);
    assert.ok(
      bunCalls.every(
        (line) =>
          line === "run build" || line === "run test" || line.includes(join("domains", "gjc-plugin", "probes", "run.ts")),
      ),
      bunCalls.join("\n"),
    );
    assert.equal(bunCalls.filter((line) => line.includes(join("domains", "gjc-plugin", "probes", "run.ts"))).length, 3);
    const gjcCalls = readFileSync(tools.gjcLog, "utf8").trim().split("\n").filter(Boolean);
    assert.ok(gjcCalls.length > 0);
    assert.ok(gjcCalls.every((line) => line.startsWith("plugin install ")), gjcCalls.join("\n"));
    assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 0);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function makeLoopRepo() {
  const root = mkdtempSync(join(tmpdir(), "self-improve-compose-loop-"));
  const repo = join(root, "repo");
  write(join(repo, "package.json"), '{"name":"compose-loop-fixture","private":true,"type":"module"}\n');
  write(join(repo, "jev-advisor", "lib", "decision.ts"), "export const value = 1;\n");
  write(join(repo, "jev-advisor", "src", "alpha.adapter.ts"), "export const alpha = 1;\n");
  write(join(repo, "verification-receipts", "lib", "extra.ts"), "export const extra = 1;\n");
  write(join(repo, "jev-advisor", "tests", "decision.test.ts"), "// protected\n");
  write(
    join(repo, "self-improve", "domains", "gjc-plugin", "heldout", "fixtures.json"),
    `${JSON.stringify({ cases: { heldout_coverage: [{ note: HELDOUT_SENTINEL }] } }, null, 2)}\n`,
  );
  write(join(repo, "self-improve", "ledger.jsonl"), "");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture base"]);
  return { root, repo };
}

function makeFakeGuards() {
  const state = { calls: 0 };
  const runGuards = async ({ guards }) => {
    state.calls += 1;
    return guards.map((guard) => ({ id: guard.id, status: "pass", exitCode: 0, durationMs: 1, logPath: null }));
  };
  return { runGuards, state };
}

function probePlan({ candidateDelta = 0.05, composedDelta = 0 } = {}) {
  const calls = [];
  const evaluateProbes = async ({ candidateDir }) => {
    calls.push(candidateDir);
    const delta = candidateDir.endsWith("/candidate") ? composedDelta : candidateDelta;
    return {
      baseline: { decision_accuracy: 0.9 },
      candidate: { decision_accuracy: 0.9 + delta },
      delta,
      heldout: { baseline: { heldout_coverage: 0.5 }, candidate: { heldout_coverage: 0.5 } },
    };
  };
  return { evaluateProbes, calls };
}

function writeCandidateProposer(root) {
  const script = join(root, "candidate-proposer.mjs");
  write(
    script,
    [
      'import { readFileSync, writeFileSync } from "node:fs";',
      "const [requestPath, responsePath] = process.argv.slice(2);",
      'const request = JSON.parse(readFileSync(requestPath, "utf8"));',
      "const index = request.candidate?.index ?? 0;",
      'const files = ["verification-receipts/lib/candidate-a.ts", "verification-receipts/lib/candidate-b.ts"];',
      "const rel = files[index % files.length];",
      "const patch = [",
      "  `diff --git a/${rel} b/${rel}`,",
      '  "new file mode 100644",',
      '  "--- /dev/null",',
      '  `+++ b/${rel}`,',
      '  "@@ -0,0 +1,1 @@",',
      '  `+export const candidate${index} = ${index + 1};`,',
      '  "",',
      '].join("\\n");',
      "writeFileSync(responsePath, JSON.stringify({",
      "  hypothesis: `compose loop candidate ${index} for ${request.objective} cycle ${request.cycleIndex}`,",
      '  commitMessage: `chore(verification-receipts): compose candidate ${index}`,',
      "  patch,",
      "}, null, 2));",
      "",
    ].join("\n"),
  );
  return script;
}

function loopInput({ root, repo, deps, ...overrides }) {
  return {
    repoRoot: repo,
    adapter: DOMAIN,
    proposer: "stub",
    runRoot: join(root, "runroot"),
    ledgerPath: join(repo, "self-improve", "ledger.jsonl"),
    maxCycles: 1,
    maxProposerCalls: 2,
    batchSize: 1,
    includeSmoke: false,
    deps: {
      runGuards: deps.runGuards,
      evaluateProbes: deps.evaluateProbes,
      scanProbeFailures: () => ({ ok: true, reason: null, failures: [] }),
    },
    ...overrides,
  };
}

test("loop --compose-count probes each candidate separately and rejects a regressing composition", async () => {
  const { root, repo } = makeLoopRepo();
  try {
    const proposer = writeCandidateProposer(root);
    const guards = makeFakeGuards();
    const probes = probePlan({ candidateDelta: 0.05, composedDelta: 0 });
    const result = await runLoop(
      loopInput({
        root,
        repo,
        deps: { runGuards: guards.runGuards, evaluateProbes: probes.evaluateProbes },
        proposer: "cmd",
        proposerCmd: `node ${proposer} {request} {response}`,
        liveApproved: true,
        composeCount: 2,
        maxCycles: 1,
        maxProposerCalls: 2,
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.stoppedReason, "max_cycles");
    assert.equal(result.composeCount, 2);
    assert.equal(result.counters.cycles, 1);
    assert.equal(result.counters.proposerCalls, 2);
    const state = JSON.parse(readFileSync(result.statePath, "utf8"));
    assert.equal(state.caps.composeCount, 2);
    const entry = state.cycles[0];
    assert.equal(entry.status, "ok");
    assert.equal(entry.decision, "reject");
    assert.ok(entry.reasons.includes("floor_not_met"), entry.reasons.join(","));
    assert.equal(entry.adoption, "none");
    assert.equal(entry.candidates.length, 2);
    assert.ok(entry.candidates.every((candidate) => candidate.improved === true));
    assert.match(entry.composition.composedSha256, /^[0-9a-f]{64}$/);
    assert.equal(entry.composition.sources.length, 2);

    // Individual candidate probes and the composed probe are separate calls.
    assert.equal(probes.calls.length, 3);
    assert.equal(probes.calls.filter((dir) => dir.endsWith("/candidate")).length, 1);

    const rows = readLedger(join(repo, "self-improve", "ledger.jsonl"));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict.decision, "reject");
    assert.equal(rows[0].composition.schema, "gjc.self-improve.compose.v1");
    assert.equal(rows[0].composition.sources.length, 2);

    // Held-out material never reaches a proposer request or scratch copy.
    const requestFiles = readdirSync(result.loopRoot).filter((name) => name.endsWith(".request.json"));
    assert.equal(requestFiles.length, 2);
    for (const name of requestFiles) {
      assert.equal(readFileSync(join(result.loopRoot, name), "utf8").includes(HELDOUT_SENTINEL), false);
    }
    const scratchDirs = readdirSync(result.loopRoot).filter((name) => name.startsWith("scratch-cycle-"));
    assert.equal(scratchDirs.length, 2);
    for (const name of scratchDirs) {
      assert.equal(existsSync(join(result.loopRoot, name, "self-improve", "domains")), false);
    }
    assert.equal(readFileSync(result.logPath, "utf8").includes(HELDOUT_SENTINEL), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop --compose-count records a conflict refusal without running probes", async () => {
  const { root, repo } = makeLoopRepo();
  try {
    const guards = makeFakeGuards();
    const probes = probePlan();
    const result = await runLoop(
      loopInput({
        root,
        repo,
        deps: { runGuards: guards.runGuards, evaluateProbes: probes.evaluateProbes },
        proposer: "stub",
        composeCount: 2,
        maxCycles: 1,
        maxProposerCalls: 2,
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.stoppedReason, "max_proposer_calls");
    assert.equal(result.counters.cycles, 0);
    assert.equal(result.counters.proposerCalls, 2);
    const state = JSON.parse(readFileSync(result.statePath, "utf8"));
    const entry = state.cycles[0];
    assert.equal(entry.status, "composition_refused");
    assert.equal(entry.reason, "composition_conflict");
    assert.equal(entry.candidates, 2);
    assert.equal(guards.state.calls, 0);
    assert.equal(probes.calls.length, 0);
    assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the one-candidate loop keeps its default path and caps", async () => {
  const { root, repo } = makeLoopRepo();
  try {
    const proposer = writeCandidateProposer(root);
    const guards = makeFakeGuards();
    const probes = probePlan({ candidateDelta: 0, composedDelta: 0 });
    const result = await runLoop(
      loopInput({
        root,
        repo,
        deps: { runGuards: guards.runGuards, evaluateProbes: probes.evaluateProbes },
        proposer: "cmd",
        proposerCmd: `node ${proposer} {request} {response}`,
        liveApproved: true,
        maxCycles: 1,
        maxProposerCalls: 1,
      }),
    );
    assert.equal(result.status, "ok");
    assert.equal(result.stoppedReason, "max_cycles");
    assert.equal(result.composeCount, 1);
    assert.equal(result.counters.proposerCalls, 1);
    assert.equal(result.counters.cycles, 1);
    const state = JSON.parse(readFileSync(result.statePath, "utf8"));
    assert.equal(state.caps.composeCount, 1);
    assert.equal("composeId" in state.cycles[0], false);
    assert.equal(readLedger(join(repo, "self-improve", "ledger.jsonl")).length, 1);
    const requestFiles = readdirSync(result.loopRoot).filter((name) => name.endsWith(".request.json"));
    assert.equal(requestFiles.length, 1);
    const request = JSON.parse(readFileSync(join(result.loopRoot, requestFiles[0]), "utf8"));
    assert.equal("candidate" in request, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop compose bounds and the CLI flag contract fail closed", async () => {
  const { root, repo } = makeLoopRepo();
  try {
    await assert.rejects(
      () => runLoop(loopInput({ root, repo, deps: { runGuards: makeFakeGuards().runGuards, evaluateProbes: probePlan().evaluateProbes }, composeCount: 5 })),
      /compose_count_out_of_range/,
    );
    await assert.rejects(
      () => runLoop(loopInput({ root, repo, deps: { runGuards: makeFakeGuards().runGuards, evaluateProbes: probePlan().evaluateProbes }, composeCount: 0 })),
      /compose_count_out_of_range/,
    );
    const pinned = await runLoop(
      loopInput({
        root,
        repo,
        deps: { runGuards: makeFakeGuards().runGuards, evaluateProbes: probePlan().evaluateProbes },
        composeCount: 2,
        candidatePath: join(root, "candidate.json"),
      }),
    );
    assert.equal(pinned.status, "skipped");
    assert.equal(pinned.reason, "compose_requires_unpinned_objective");

    // Four is the upper bound; a round that cannot fit the remaining proposer
    // calls stops before it invokes the proposer at all.
    const upperBound = await runLoop(
      loopInput({
        root,
        repo,
        deps: { runGuards: makeFakeGuards().runGuards, evaluateProbes: probePlan().evaluateProbes },
        composeCount: 4,
        maxCycles: 1,
        maxProposerCalls: 3,
      }),
    );
    assert.equal(upperBound.status, "ok");
    assert.equal(upperBound.stoppedReason, "max_proposer_calls");
    assert.equal(upperBound.counters.proposerCalls, 0);
    assert.equal(upperBound.counters.cycles, 0);

    const tooMany = runCli(["loop", "--repo", repo, "--compose-count", "5", "--json"]);
    assert.equal(tooMany.status, 2);
    assert.match(tooMany.stderr, /invalid --compose-count: 5 \(1\.\.4\)/);

    const zero = runCli(["loop", "--repo", repo, "--compose-count", "0", "--json"]);
    assert.equal(zero.status, 2);
    assert.match(zero.stderr, /invalid --compose-count: 0/);

    const conflicting = runCli([
      "loop",
      "--repo",
      repo,
      "--compose-count",
      "2",
      "--candidate-file",
      join(root, "candidate.json"),
      "--json",
    ]);
    assert.equal(conflicting.status, 2);
    assert.match(conflicting.stderr, /compose-count requires an unpinned objective/);

    const runRoot = join(root, "cli-runroot");
    const skipped = runCli([
      "loop",
      "--repo",
      repo,
      "--compose-count",
      "2",
      "--proposer",
      "cmd",
      "--proposer-cmd",
      "true {response}",
      "--run-root",
      runRoot,
      "--json",
    ]);
    assert.equal(skipped.status, 0, skipped.stderr);
    const out = JSON.parse(skipped.stdout);
    assert.equal(out.status, "skipped");
    assert.equal(out.reason, "live_not_approved");
    const state = JSON.parse(readFileSync(out.statePath, "utf8"));
    assert.equal(state.caps.composeCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
