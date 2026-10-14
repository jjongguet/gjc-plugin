import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import RULES_TEXT_DOMAIN from "../../domains/rules-text/adapter.mjs";
import { runCycle } from "../../lib/engine.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI = join(REPO_ROOT, "self-improve", "scripts", "run.mjs");

const FIXTURE_DOC = ["# Fixture rules", "", "## 목적", "", "- line one", ""].join("\n");
const FIXTURE_PATCH = [
  "diff --git a/docs/portfolio/AGENTS.md b/docs/portfolio/AGENTS.md",
  "--- a/docs/portfolio/AGENTS.md",
  "+++ b/docs/portfolio/AGENTS.md",
  "@@ -1,3 +1,3 @@",
  "-# Fixture rules",
  "+# Fixture rules updated",
  " ",
  " ## 목적",
  "",
].join("\n");

function git(cwd, args) {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "rules-text-cycle-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "docs", "portfolio"), { recursive: true });
  mkdirSync(join(repo, "self-improve"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","private":true,"type":"module"}\n');
  writeFileSync(join(repo, "docs", "portfolio", "AGENTS.md"), FIXTURE_DOC);
  writeFileSync(join(repo, "self-improve", "ledger.jsonl"), "");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture base"]);
  return { root, repo };
}

function fakeGuards() {
  const runner = async ({ guards }) =>
    guards.map((guard) => ({ id: guard.id, status: "pass", exitCode: 0, durationMs: 1, logPath: null }));
  return { runner };
}

const improvingProbes = async () => ({
  baseline: { rule_text_integrity: 0.625 },
  candidate: { rule_text_integrity: 0.75 },
  delta: 0.125,
  heldout: { baseline: { heldout_rule_text: 1 }, candidate: { heldout_rule_text: 1 } },
});

function cycleInput({ root, repo, patchFile, deps, journalEvidence }) {
  return {
    repoRoot: repo,
    adapter: RULES_TEXT_DOMAIN,
    proposal: {
      source: "manual",
      hypothesis: "fixture doc hypothesis",
      objective: "probe.rule_text_integrity",
      commitMessage: "docs(rules-text): apply fixture change",
      patchFile,
      campaignId: "camp-doc",
    },
    runRoot: join(root, "runroot"),
    ledgerPath: join(repo, "self-improve", "ledger.jsonl"),
    ...(journalEvidence ? { journalEvidence } : {}),
    includeSmoke: false,
    deps,
  };
}

test("unknown --domain exits 2 without touching a proposal file", () => {
  const proc = spawnSync(
    "node",
    [CLI, "cycle", "--domain", "nope", "--proposal", "/nonexistent/proposal.json", "--dry-run", "--json"],
    { encoding: "utf8", cwd: REPO_ROOT, timeout: 60000 },
  );
  assert.equal(proc.status, 2);
  assert.match(proc.stderr, /unknown_domain: nope/);
});

test("cycle --domain rules-text --dry-run reaches evaluation with the text probe", () => {
  const { root, repo } = makeFixture();
  try {
    const patchFile = join(root, "doc.patch");
    writeFileSync(patchFile, FIXTURE_PATCH);
    const proposalFile = join(root, "proposal.json");
    writeFileSync(
      proposalFile,
      JSON.stringify({
        source: "manual",
        hypothesis: "fixture cli hypothesis",
        objective: "probe.rule_text_integrity",
        commitMessage: "docs(rules-text): cli fixture change",
        patchFile: "doc.patch",
      }),
    );
    const proc = spawnSync(
      "node",
      [CLI, "cycle", "--domain", "rules-text", "--proposal", proposalFile, "--repo", repo, "--dry-run", "--json"],
      { encoding: "utf8", cwd: REPO_ROOT, timeout: 240000 },
    );
    assert.equal(proc.status, 0, proc.stderr);
    const result = JSON.parse(proc.stdout);
    assert.equal(result.status, "dry-run");
    const baseline = result.scores?.baseline ?? {};
    assert.ok(
      typeof baseline.rule_text_integrity === "number" && baseline.rule_text_integrity >= 0 && baseline.rule_text_integrity <= 1,
      `rules-text probe must run on the scratch dirs: ${JSON.stringify(result.scores)}`,
    );
    assert.equal(git(repo, ["status", "--porcelain"]), "", "dry-run must not touch the fixture repo");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loop-style journalEvidence lands on the cycle row and never changes the verdict", async () => {
  const withEvidence = makeFixture();
  const withoutEvidence = makeFixture();
  try {
    const evidence = {
      schema: "gjc.self-improve.journal-evidence.v1",
      adoptionRate: 0.5,
      cycleAttempts: 2,
      adoptions: 1,
      guardFailureClasses: { known_flake_suspect: 0, other: 0 },
      sources: { adoptionRate: "self-improve-ledger", guardFailureClasses: "loop-state" },
      caveat: "Descriptive only; no statistical significance is claimed; never gates adoption.",
    };
    const patchA = join(withEvidence.root, "doc.patch");
    writeFileSync(patchA, FIXTURE_PATCH);
    const resultA = await runCycle(
      cycleInput({
        root: withEvidence.root,
        repo: withEvidence.repo,
        patchFile: patchA,
        deps: { runGuards: fakeGuards().runner, evaluateProbes: improvingProbes },
        journalEvidence: evidence,
      }),
    );
    assert.equal(resultA.status, "ok");
    assert.equal(resultA.decision, "adopt");
    assert.equal(resultA.adoption, "committed");

    const rowsA = readFileSync(join(withEvidence.repo, "self-improve", "ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const cycleRow = rowsA.find((row) => row.kind === "cycle");
    assert.deepEqual(cycleRow.journalEvidence, evidence);
    assert.deepEqual(cycleRow.labels, ["text_fixture"]);
    const lineBytes = Buffer.byteLength(JSON.stringify(cycleRow), "utf8");
    assert.ok(lineBytes <= 2048, `cycle row must stay within the ledger bound (got ${lineBytes} bytes)`);

    const patchB = join(withoutEvidence.root, "doc.patch");
    writeFileSync(patchB, FIXTURE_PATCH);
    const resultB = await runCycle(
      cycleInput({
        root: withoutEvidence.root,
        repo: withoutEvidence.repo,
        patchFile: patchB,
        deps: { runGuards: fakeGuards().runner, evaluateProbes: improvingProbes },
      }),
    );
    assert.equal(resultB.decision, resultA.decision, "journalEvidence must not gate the verdict");
    const rowsB = readFileSync(join(withoutEvidence.repo, "self-improve", "ledger.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    const cycleRowB = rowsB.find((row) => row.kind === "cycle");
    assert.equal(cycleRowB.journalEvidence, undefined, "standalone cycles carry no evidence block");
  } finally {
    rmSync(withEvidence.root, { recursive: true, force: true });
    rmSync(withoutEvidence.root, { recursive: true, force: true });
  }
});
