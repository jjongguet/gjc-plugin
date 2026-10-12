import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { rungFor } from "../../lib/budget.mjs";
import { appendRow } from "../../lib/ledger.mjs";
import {
  MAX_SUMMARY_CHARS,
  buildAppendPatch,
  buildProposerRequest,
  collectHeldoutValues,
  createProposerScratch,
  failureLabelsFromProbeResult,
  invokeCmdProposer,
  listScratchExclusionSurvivors,
  preferredObjectiveFromFailures,
  proposerEnv,
  runStubProposer,
  scanHeldoutVerbatim,
  scanProbeFailures,
  validateAgentProposal,
} from "../../lib/propose.mjs";
import { sha256Hex } from "../../lib/types.mjs";

const HELDOUT_SENTINEL = "https://heldout-sentinel.example/api";
const SHARED_VOCABULARY = "https://shared-vocab.example/api";

function git(cwd, args) {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "self-improve-propose-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "jev-advisor", "lib"), { recursive: true });
  mkdirSync(join(repo, "jev-advisor", "tests"), { recursive: true });
  mkdirSync(join(repo, "verification-receipts", "lib"), { recursive: true });
  mkdirSync(join(repo, "self-improve", "domains", "gjc-plugin", "probes"), { recursive: true });
  mkdirSync(join(repo, "self-improve", "domains", "gjc-plugin", "heldout"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","private":true,"type":"module"}\n');
  writeFileSync(join(repo, "jev-advisor", "lib", "decision.ts"), "export const value = 1;\n");
  writeFileSync(join(repo, "verification-receipts", "lib", "base.ts"), "export const base = 1;\n");
  writeFileSync(join(repo, "jev-advisor", "tests", "decision.test.ts"), "// protected\n");
  writeFileSync(
    join(repo, "self-improve", "domains", "gjc-plugin", "heldout", "fixtures.json"),
    `${JSON.stringify(
      {
        cases: {
          egress_boundary: [
            { endpoint: HELDOUT_SENTINEL, expected: { allowed: false } },
            { endpoint: SHARED_VOCABULARY, expected: { allowed: true } },
          ],
        },
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repo, "self-improve", "domains", "gjc-plugin", "probes", "fixtures.json"),
    `${JSON.stringify({ cases: { egress_boundary: [{ endpoint: SHARED_VOCABULARY, expected: { allowed: true } }] } }, null, 2)}\n`,
  );
  writeFileSync(join(repo, "self-improve", "ledger.jsonl"), "");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture base"]);
  return { root, repo };
}

function appendPatchTo(repo, relPath) {
  const original = readFileSync(join(repo, relPath), "utf8");
  return buildAppendPatch({ relPath, original, appendedLine: "// fixture proposal" });
}

function cycleRow({ cycleId, objective, hypothesis, decision }) {
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

test("failureLabelsFromProbeResult flattens baseline per-case labels deterministically", () => {
  const result = {
    failures: {
      baseline: { decision_accuracy: ["decision_accuracy#3"], extract_coverage: ["extract_coverage#1"] },
      candidate: { decision_accuracy: ["decision_accuracy#9"] },
    },
  };
  assert.deepEqual(failureLabelsFromProbeResult(result), [
    { metric: "decision_accuracy", label: "decision_accuracy#3" },
    { metric: "extract_coverage", label: "extract_coverage#1" },
  ]);
  assert.deepEqual(failureLabelsFromProbeResult({}), []);
});

test("failureLabelsFromProbeResult carries runner summaries and bounds them", () => {
  const result = {
    failures: { baseline: { decision_accuracy: ["decision_accuracy#10"] } },
    failureDetails: {
      baseline: {
        decision_accuracy: [
          { label: "decision_accuracy#10", summary: "decision_accuracy#10: decimal sum sits exactly on the documented tolerance" },
          { label: "decision_accuracy#11", summary: "x".repeat(1000) },
        ],
      },
    },
  };
  const entries = failureLabelsFromProbeResult(result);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].summary, "decision_accuracy#10: decimal sum sits exactly on the documented tolerance");
  assert.equal(entries[1].summary.length, MAX_SUMMARY_CHARS);
  assert.equal(preferredObjectiveFromFailures({ failures: entries, adapter: DOMAIN }), "probe.decision_accuracy");
  // runner without failureDetails (older shape) still works
  assert.deepEqual(failureLabelsFromProbeResult({ failures: result.failures }), [
    { metric: "decision_accuracy", label: "decision_accuracy#10" },
  ]);
});

test("preferredObjectiveFromFailures picks the most-failing declared metric", () => {
  const failures = [
    { metric: "decision_accuracy", label: "decision_accuracy#10" },
    { metric: "decision_accuracy", label: "decision_accuracy#11" },
    { metric: "extract_coverage", label: "extract_coverage#0" },
  ];
  assert.equal(preferredObjectiveFromFailures({ failures, adapter: DOMAIN }), "probe.decision_accuracy");
  assert.equal(preferredObjectiveFromFailures({ failures: [], adapter: DOMAIN }), null);
  assert.equal(preferredObjectiveFromFailures({ failures: [{ metric: "not_a_metric", label: "not_a_metric#0" }], adapter: DOMAIN }), null);
  assert.equal(preferredObjectiveFromFailures({ failures, adapter: { objectives: [] } }), null);
});

test("scanProbeFailures reports an empty list with a reason on runner failure", () => {
  const failing = scanProbeFailures({
    repoRoot: "/nonexistent",
    adapter: DOMAIN,
    deps: { spawn: () => ({ status: 1, stdout: "", stderr: "boom" }) },
  });
  assert.deepEqual(failing, { ok: false, reason: "probe_scan_failed", failures: [] });
  const ok = scanProbeFailures({
    repoRoot: "/nonexistent",
    adapter: DOMAIN,
    deps: {
      spawn: () => ({
        status: 0,
        stdout: JSON.stringify({ failures: { baseline: { decision_accuracy: ["decision_accuracy#0"] } } }),
      }),
    },
  });
  assert.deepEqual(ok.failures, [{ metric: "decision_accuracy", label: "decision_accuracy#0" }]);
});

test("buildProposerRequest carries objective, rung caps, failures and constraints", () => {
  const rung = rungFor(1, DOMAIN.budget);
  const request = buildProposerRequest({
    loopId: "loop-1",
    cycleIndex: 2,
    objective: "probe.decision_accuracy",
    baseCommit: "abcdef0",
    adapter: DOMAIN,
    rung,
    failures: [{ metric: "decision_accuracy", label: "decision_accuracy#3" }],
    history: {
      priorAttempts: Array.from({ length: 7 }, (_, index) => ({
        objective: "probe.decision_accuracy",
        decision: "reject",
        reasons: ["floor_not_met"],
        hypothesis: `attempt ${index}`,
      })),
      stalled: ["probe.extract_coverage"],
      unexplored: ["probe.egress_boundary"],
    },
  });
  assert.equal(request.schema, "gjc.self-improve.proposer-request.v1");
  assert.equal(request.cycleIndex, 2);
  assert.deepEqual(request.budget, { rung: 1, maxFiles: 2, maxHunks: 8 });
  assert.equal(request.constraints.maxFiles, 2);
  assert.equal(request.constraints.patchMustApplyAt, "HEAD");
  assert.equal(request.priorAttempts.length, 5);
  assert.equal(request.priorAttempts.at(-1).hypothesis, "attempt 6");
  assert.deepEqual(request.stalledObjectives, ["probe.extract_coverage"]);
  assert.deepEqual(request.unexploredObjectives, ["probe.egress_boundary"]);
  assert.deepEqual(request.failingCases, [{ metric: "decision_accuracy", label: "decision_accuracy#3" }]);
});

test("createProposerScratch excludes self-improve/domains/** and fails closed on survivors", () => {
  const { root, repo } = makeFixture();
  const scratch = join(root, "scratch");
  const created = createProposerScratch({ repoRoot: repo, destDir: scratch });
  assert.equal(created.baseCommit, git(repo, ["rev-parse", "--short=7", "HEAD"]));
  assert.equal(existsSync(join(scratch, "jev-advisor", "lib", "decision.ts")), true);
  assert.equal(existsSync(join(scratch, "self-improve", "domains")), false);
  assert.deepEqual(listScratchExclusionSurvivors(scratch), []);
  assert.equal(existsSync(join(scratch, "self-improve", "ledger.jsonl")), true);
  rmSync(root, { recursive: true, force: true });
});

test("stub proposer builds an applicable append patch inside the scratch layout", () => {
  const { root, repo } = makeFixture();
  const request = buildProposerRequest({
    loopId: "loop-1",
    cycleIndex: 1,
    objective: "probe.decision_accuracy",
    baseCommit: git(repo, ["rev-parse", "--short=7", "HEAD"]),
    adapter: DOMAIN,
    rung: rungFor(0, DOMAIN.budget),
  });
  const outDir = join(root, "loop");
  const outcome = runStubProposer({ request, repoRoot: repo, adapter: DOMAIN, outDir });
  assert.equal(outcome.ok, true);
  assert.equal(outcome.proposal.source, "agent");
  assert.match(outcome.proposal.patchFile, /cycle-1\.patch$/);
  const patchText = readFileSync(outcome.proposal.patchFile, "utf8");
  const check = spawnSync("git", ["-C", repo, "apply", "--check"], { input: patchText, encoding: "utf8" });
  assert.equal(check.status, 0, check.stderr);
  assert.match(patchText, /self-improve loop stub proposal cycle 1/);
  const other = runStubProposer({ request: { ...request, cycleIndex: 2 }, repoRoot: repo, adapter: DOMAIN, outDir });
  assert.notEqual(readFileSync(other.proposal.patchFile, "utf8"), patchText);
  rmSync(root, { recursive: true, force: true });
});

test("validateAgentProposal enforces schema, budget, protected paths, novelty and the held-out scan", () => {
  const { root, repo } = makeFixture();
  const ledgerPath = join(repo, "self-improve", "ledger.jsonl");
  const rung = rungFor(0, DOMAIN.budget);
  const base = {
    source: "agent",
    objective: "probe.decision_accuracy",
    commitMessage: "chore(jev-advisor): fixture proposal",
  };
  const valid = validateAgentProposal({
    proposal: { ...base, hypothesis: "fresh hypothesis", patchFile: "x.patch" },
    patchText: appendPatchTo(repo, "jev-advisor/lib/decision.ts"),
    rung,
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(valid.ok, true, JSON.stringify(valid));
  assert.deepEqual(valid.touched, ["jev-advisor/lib/decision.ts"]);

  const schema = validateAgentProposal({
    proposal: { ...base, source: "robot", hypothesis: "x" },
    patchText: appendPatchTo(repo, "jev-advisor/lib/decision.ts"),
    rung,
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(schema.ok, false);
  assert.equal(schema.reason, "proposal_schema");

  const budget = validateAgentProposal({
    proposal: { ...base, hypothesis: "oversize" },
    patchText: [
      appendPatchTo(repo, "jev-advisor/lib/decision.ts"),
      appendPatchTo(repo, "verification-receipts/lib/base.ts"),
    ].join(""),
    rung: rungFor(2, DOMAIN.budget),
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(budget.reason, "budget_precheck");

  const protectedCase = validateAgentProposal({
    proposal: { ...base, hypothesis: "protected" },
    patchText: buildAppendPatch({
      relPath: "jev-advisor/tests/decision.test.ts",
      original: "// protected\n",
      appendedLine: "// nope",
    }),
    rung,
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(protectedCase.reason, "protected_precheck");

  const hardcode = validateAgentProposal({
    proposal: { ...base, hypothesis: "hardcode" },
    patchText: buildAppendPatch({
      relPath: "jev-advisor/lib/decision.ts",
      original: "export const value = 1;\n",
      appendedLine: `export const leak = "${HELDOUT_SENTINEL}";`,
    }),
    rung,
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(hardcode.reason, "heldout_verbatim_scan");
  assert.equal(hardcode.matched.length, 1);
  assert.equal(JSON.stringify(hardcode).includes(HELDOUT_SENTINEL), false);

  appendRow(ledgerPath, cycleRow({ cycleId: "c1", objective: "probe.decision_accuracy", hypothesis: "repeat me", decision: "reject" }));
  const duplicate = validateAgentProposal({
    proposal: { ...base, hypothesis: "repeat me" },
    patchText: appendPatchTo(repo, "jev-advisor/lib/decision.ts"),
    rung,
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(duplicate.reason, "history_duplicate_hypothesis");
  rmSync(root, { recursive: true, force: true });
});

test("validateAgentProposal redirects proposals on stalled objectives with the unexplored list", () => {
  const { root, repo } = makeFixture();
  const ledgerPath = join(repo, "self-improve", "ledger.jsonl");
  for (let index = 1; index <= 3; index += 1) {
    appendRow(
      ledgerPath,
      cycleRow({ cycleId: `c${index}`, objective: "probe.decision_accuracy", hypothesis: `h${index}`, decision: "reject" }),
    );
  }
  const result = validateAgentProposal({
    proposal: {
      source: "agent",
      hypothesis: "brand new on a stalled objective",
      objective: "probe.decision_accuracy",
      commitMessage: "chore(jev-advisor): stalled proposal",
    },
    patchText: appendPatchTo(repo, "jev-advisor/lib/decision.ts"),
    rung: rungFor(0, DOMAIN.budget),
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "forced_exploration");
  assert.deepEqual(result.unexplored, ["probe.extract_coverage", "probe.egress_boundary"]);
  rmSync(root, { recursive: true, force: true });
});

test("proposerEnv keeps only allowlisted names and never surfaces secret-like values", () => {
  const env = proposerEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    LANG: "en_US.UTF-8",
    JEV_ADVISOR_API_KEY: "sk-should-not-survive",
    PROPOSER_TEST_SENTINEL: "sentinel-value-1234",
    UNLISTED_VAR: "dropped",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
  assert.equal(JSON.stringify(env).includes("sentinel-value-1234"), false);
});

test("cmd proposer runs in the scratch with a filtered env and no secret leaks in request or log", () => {
  const { root, repo } = makeFixture();
  const loopDir = join(root, "loop");
  const scriptPath = join(root, "proposer.mjs");
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
      "  hypothesis: `cmd smoke for ${request.objective} cycle ${request.cycleIndex}`,",
      "  commitMessage: \"chore(verification-receipts): cmd proposer smoke\",",
      "  patch,",
      "  debug: { cwd: process.cwd(), sentinel: process.env.PROPOSER_TEST_SENTINEL ?? \"absent\", apiKey: process.env.JEV_ADVISOR_API_KEY ?? \"absent\" },",
      "}, null, 2));",
      "",
    ].join("\n"),
  );
  const scratch = join(root, "scratch-cmd");
  createProposerScratch({ repoRoot: repo, destDir: scratch });
  const request = buildProposerRequest({
    loopId: "loop-cmd",
    cycleIndex: 1,
    objective: "probe.decision_accuracy",
    baseCommit: git(repo, ["rev-parse", "--short=7", "HEAD"]),
    adapter: DOMAIN,
    rung: rungFor(0, DOMAIN.budget),
  });
  const sentinel = "sentinel-value-1234";
  const outcome = invokeCmdProposer({
    request,
    template: `node ${scriptPath} {request} {response}`,
    scratchDir: scratch,
    outDir: loopDir,
    env: { ...process.env, PROPOSER_TEST_SENTINEL: sentinel, JEV_ADVISOR_API_KEY: "sk-should-not-survive" },
  });
  assert.equal(outcome.ok, true, JSON.stringify(outcome));
  assert.equal(outcome.log.exitCode, 0);
  assert.equal(outcome.log.envKeys.includes("PROPOSER_TEST_SENTINEL"), false);
  assert.equal(outcome.log.envKeys.includes("JEV_ADVISOR_API_KEY"), false);
  assert.match(outcome.proposal.patchFile, /patches\/cycle-1\.patch$/);
  const requestFile = readFileSync(outcome.log.requestFile, "utf8");
  assert.equal(requestFile.includes(sentinel), false);
  assert.equal(JSON.stringify(outcome.log).includes(sentinel), false);
  const response = JSON.parse(readFileSync(outcome.log.responseFile, "utf8"));
  assert.equal(response.debug.cwd, realpathSync(scratch));
  assert.equal(response.debug.sentinel, "absent");
  assert.equal(response.debug.apiKey, "absent");
  assert.equal(existsSync(join(scratch, "self-improve", "domains")), false);
  const validation = validateAgentProposal({
    proposal: outcome.proposal,
    patchText: readFileSync(outcome.proposal.patchFile, "utf8"),
    rung: rungFor(0, DOMAIN.budget),
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath: join(repo, "self-improve", "ledger.jsonl"),
  });
  assert.equal(validation.ok, true, JSON.stringify(validation));

  const noPlaceholder = invokeCmdProposer({
    request,
    template: "node -e 'process.exit(0)'",
    scratchDir: scratch,
    outDir: loopDir,
  });
  assert.equal(noPlaceholder.reason, "cmd_template_missing_response_placeholder");
  const failing = invokeCmdProposer({
    request,
    template: "node -e 'process.exit(3)' {response}",
    scratchDir: scratch,
    outDir: loopDir,
  });
  assert.equal(failing.reason, "cmd_proposer_failed");
  rmSync(root, { recursive: true, force: true });
});

test("held-out scan only inspects added lines and ignores vocabulary shared with the probe corpus", () => {
  const { root, repo } = makeFixture();
  const ledgerPath = join(repo, "self-improve", "ledger.jsonl");
  const rung = rungFor(0, DOMAIN.budget);
  const base = {
    source: "agent",
    objective: "probe.decision_accuracy",
    commitMessage: "chore(jev-advisor): fixture proposal",
  };
  const contextOnly = validateAgentProposal({
    proposal: { ...base, hypothesis: "context only" },
    patchText: buildAppendPatch({
      relPath: "jev-advisor/lib/decision.ts",
      original: `// context mentions ${HELDOUT_SENTINEL}\nexport const value = 1;\n`,
      appendedLine: "// benign addition",
    }),
    rung,
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(contextOnly.ok, true, JSON.stringify(contextOnly));
  const shared = validateAgentProposal({
    proposal: { ...base, hypothesis: "shared vocabulary" },
    patchText: buildAppendPatch({
      relPath: "jev-advisor/lib/decision.ts",
      original: "export const value = 1;\n",
      appendedLine: `export const shared = "${SHARED_VOCABULARY}";`,
    }),
    rung,
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(shared.ok, true, JSON.stringify(shared));
  const heldoutOnly = validateAgentProposal({
    proposal: { ...base, hypothesis: "held-out literal" },
    patchText: buildAppendPatch({
      relPath: "jev-advisor/lib/decision.ts",
      original: "export const value = 1;\n",
      appendedLine: `export const leak = "${HELDOUT_SENTINEL}";`,
    }),
    rung,
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
  });
  assert.equal(heldoutOnly.reason, "heldout_verbatim_scan");
  rmSync(root, { recursive: true, force: true });
});

test("collectHeldoutValues and scanHeldoutVerbatim stay value-agnostic in their reports", () => {
  const values = collectHeldoutValues({ a: [HELDOUT_SENTINEL, "short"], b: { c: "another-value" } });
  assert.deepEqual(values.sort(), ["another-value", HELDOUT_SENTINEL].sort());
  const hit = scanHeldoutVerbatim({ patchText: `+const x = "${HELDOUT_SENTINEL}";`, values });
  assert.equal(hit.ok, false);
  assert.equal(JSON.stringify(hit).includes(HELDOUT_SENTINEL), false);
  const contextOnly = scanHeldoutVerbatim({
    patchText: ["--- a/x.ts", "+++ b/x.ts", ` context with ${HELDOUT_SENTINEL}`, "+added without it"].join("\n"),
    values,
  });
  assert.equal(contextOnly.ok, true);
  const miss = scanHeldoutVerbatim({ patchText: "+const x = 1;", values });
  assert.equal(miss.ok, true);
});
