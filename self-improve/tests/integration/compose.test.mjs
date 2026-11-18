import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import DOMAIN from "../../domains/gjc-plugin/adapter.mjs";
import { runComposeCycle, runCycle } from "../../lib/engine.mjs";
import { readLedger } from "../../lib/ledger.mjs";
import { composeCandidateProposals } from "../../lib/propose.mjs";
import { sha256Hex } from "../../lib/types.mjs";

function git(cwd, args) {
  const proc = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (proc.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${proc.stderr}`);
  return proc.stdout.trim();
}

const FILES = {
  decision: "jev-advisor/lib/decision.ts",
  alpha: "jev-advisor/src/alpha.adapter.ts",
  base: "verification-receipts/lib/base.ts",
  beta: "verification-receipts/lib/beta.ts",
};

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), "self-improve-compose-"));
  const repo = join(root, "repo");
  mkdirSync(join(repo, "jev-advisor", "lib"), { recursive: true });
  mkdirSync(join(repo, "jev-advisor", "src"), { recursive: true });
  mkdirSync(join(repo, "jev-advisor", "tests"), { recursive: true });
  mkdirSync(join(repo, "verification-receipts", "lib"), { recursive: true });
  mkdirSync(join(repo, "self-improve"), { recursive: true });
  writeFileSync(join(repo, "package.json"), '{"name":"fixture","private":true,"type":"module"}\n');
  writeFileSync(join(repo, FILES.decision), "export const decision = 1;\n");
  writeFileSync(join(repo, FILES.alpha), "export const alpha = 1;\n");
  writeFileSync(join(repo, FILES.base), "export const base = 1;\n");
  writeFileSync(join(repo, FILES.beta), "export const beta = 1;\n");
  writeFileSync(join(repo, "jev-advisor", "tests", "decision.test.ts"), "// protected\n");
  writeFileSync(join(repo, "self-improve", "ledger.jsonl"), "");
  git(repo, ["init", "-q"]);
  git(repo, ["config", "user.name", "fixture"]);
  git(repo, ["config", "user.email", "fixture@example.invalid"]);
  git(repo, ["add", "."]);
  git(repo, ["commit", "-qm", "fixture base"]);
  return { root, repo, ledgerPath: join(repo, "self-improve", "ledger.jsonl") };
}

/** Append-only unified diff for a single-line fixture file. */
function appendPatch(rel, original, appendedLine) {
  const context = original.endsWith("\n") ? original.slice(0, -1) : original;
  return [
    `diff --git a/${rel} b/${rel}`,
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -1,1 +1,2 @@`,
    ` ${context}`,
    `+${appendedLine}`,
    "",
  ].join("\n");
}

function candidate({ rel, original, line, objective = "probe.decision_accuracy" }) {
  const patchText = appendPatch(rel, original, line);
  return { objective, hypothesis: `independent candidate for ${rel}`, patchText, commitMessage: `fix(${rel.split("/")[0]}): candidate` };
}

function guardPlan({ failSuffix = null } = {}) {
  const calls = [];
  const runGuards = async ({ guards }) => {
    const cwd = guards[0]?.cwd ?? "";
    calls.push(cwd);
    const failed = failSuffix !== null && cwd.endsWith(failSuffix);
    return guards.map((guard) => ({
      id: guard.id,
      status: failed ? "fail" : "pass",
      exitCode: failed ? 1 : 0,
      durationMs: 1,
      logPath: null,
    }));
  };
  return { runGuards, calls };
}

const improving = (delta, heldout = { baseline: {}, candidate: {} }) => ({
  baseline: { accuracy: 0.9 },
  candidate: { accuracy: 0.9 + delta },
  delta,
  heldout,
});

function probePlan({ perCandidate = {}, composed = improving(0.05), onCall = null } = {}) {
  const calls = [];
  const evaluateProbes = async ({ baselineDir, candidateDir }) => {
    calls.push({ baselineDir, candidateDir });
    if (onCall) onCall(calls.length, { baselineDir, candidateDir });
    const id = candidateDir.split("/").pop();
    if (perCandidate[id]) return perCandidate[id];
    if (id === "candidate") return composed;
    return improving(0);
  };
  return { evaluateProbes, calls };
}

function compose({ repo, root, ledgerPath, candidates, rung = { index: 0, maxFiles: 3, maxHunks: 12 }, patchDir = "patches" }) {
  return composeCandidateProposals({
    candidates,
    objective: "probe.decision_accuracy",
    rung,
    adapter: DOMAIN,
    repoRoot: repo,
    ledgerPath,
    patchDir: join(root, patchDir),
  });
}

const twoCandidates = () => [
  candidate({ rel: FILES.decision, original: "export const decision = 1;", line: "export const decision = 2;" }),
  candidate({ rel: FILES.base, original: "export const base = 1;", line: "export const base = 2;" }),
];

test("individual wins are probed against one shared baseline and never adopt a regressing composition", async () => {
  const { root, repo, ledgerPath } = makeFixture();
  try {
    const candidates = twoCandidates();
    const composed = compose({ repo, root, ledgerPath, candidates });
    assert.equal(composed.ok, true, composed.reason);

    const ids = composed.composition.sources.map((source) => source.id);
    const probes = probePlan({
      perCandidate: { [ids[0]]: improving(0.05), [ids[1]]: improving(0.06) },
      composed: improving(0),
    });
    const guards = guardPlan();
    const result = await runComposeCycle({
      repoRoot: repo,
      adapter: DOMAIN,
      candidates,
      composed,
      runRoot: join(root, "runroot"),
      ledgerPath,
      includeSmoke: false,
      deps: { runGuards: guards.runGuards, evaluateProbes: probes.evaluateProbes, now: () => "2026-11-19T00:00:00.000Z" },
    });

    assert.equal(result.status, "ok");
    assert.equal(result.decision, "reject");
    assert.ok(result.reasons.includes("floor_not_met"), result.reasons.join(","));
    assert.equal(result.adoption, "none");
    assert.equal(result.candidates.length, 2);
    assert.ok(result.candidates.every((entry) => entry.improved));
    assert.ok(result.candidates.every((entry) => entry.admissible));
    assert.ok(result.candidates.every((entry) => entry.verdict === "adopt"));

    // Every candidate was probed against the identical baseline scratch.
    const candidateCalls = probes.calls.filter((call) => /\/candidates\/cand-/.test(call.candidateDir));
    assert.equal(candidateCalls.length, 2);
    const baselineDirs = new Set(candidateCalls.map((call) => call.baselineDir));
    assert.equal(baselineDirs.size, 1);
    const [sharedBaseline] = baselineDirs;
    assert.match(sharedBaseline, /\/compose\/baseline$/);
    assert.ok(existsSync(sharedBaseline), "shared baseline survives the probes");

    // The composed variant is probed separately, in its own scratch.
    const composedCall = probes.calls.find((call) => call.candidateDir.endsWith("/candidate"));
    assert.ok(composedCall);
    assert.match(composedCall.candidateDir, /\/runs\/[^/]+\/candidate$/);

    const rows = readLedger(ledgerPath);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].verdict.decision, "reject");
    assert.equal(rows[0].composition.schema, "gjc.self-improve.compose.v1");
    assert.equal(rows[0].composition.composedSha256, composed.composition.composedSha256);
    assert.match(rows[0].composition.baselineFingerprint, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      rows[0].composition.sources.map((source) => source.id).sort(),
      [...ids].sort(),
    );
    assert.ok(rows[0].composition.sources.every((source) => source.verdict === "adopt"));
    assert.ok(rows[0].composition.sources.every((source) => /^[0-9a-f]{12}$/.test(source.sha12)));
    // Cost accounting: the row keeps its own phase cost and records the
    // candidate-probe phase separately, measured — never a zero stand-in.
    assert.equal(typeof rows[0].cost.wallMs, "number");
    assert.deepEqual(Object.keys(rows[0].probeCost).sort(), ["bytes", "candidates", "wallMs"]);
    assert.equal(rows[0].probeCost.candidates, 2);
    assert.equal(typeof rows[0].probeCost.wallMs, "number");
    assert.ok(rows[0].probeCost.bytes > 0);
    assert.equal(result.probeCost.candidates, 2);
    assert.ok(Buffer.byteLength(JSON.stringify(rows[0]), "utf8") <= 2048);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a probe that writes into the shared baseline fails the cycle instead of being absorbed", async () => {
  const { root, repo, ledgerPath } = makeFixture();
  try {
    const candidates = twoCandidates();
    const composed = compose({ repo, root, ledgerPath, candidates });
    assert.equal(composed.ok, true, composed.reason);
    const probes = probePlan({
      onCall: (count, { baselineDir }) => {
        if (count === 1) writeFileSync(join(baselineDir, "leaked.txt"), "mutated\n");
      },
    });
    const guards = guardPlan();
    const result = await runComposeCycle({
      repoRoot: repo,
      adapter: DOMAIN,
      candidates,
      composed,
      runRoot: join(root, "runroot"),
      ledgerPath,
      includeSmoke: false,
      deps: { runGuards: guards.runGuards, evaluateProbes: probes.evaluateProbes },
    });
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.reasons, ["baseline_mutated"]);
    assert.equal(result.recorded, false);
    assert.equal(probes.calls.filter((call) => call.candidateDir.endsWith("/candidate")).length, 0);
    assert.equal(readLedger(ledgerPath).length, 0);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("baseline identity is content-based: same-size rewrites with a restored mtime are caught, identical touches are not", async () => {
  // Same bytes count + restored mtime is exactly what a path/size/mtime identity
  // would miss, so this fixture is the fingerprint's regression test.
  const rewriteFixture = makeFixture();
  try {
    const candidates = twoCandidates();
    const composed = compose({
      repo: rewriteFixture.repo,
      root: rewriteFixture.root,
      ledgerPath: rewriteFixture.ledgerPath,
      candidates,
    });
    assert.equal(composed.ok, true, composed.reason);
    // Admissible candidates: each candidate must clear the improvement floor and
    // buy any byte growth (on this tiny fixture a one-line patch is a >15% tree
    // increase, so an unimproving candidate would be inadmissible on cost).
    const rewriteIds = composed.composition.sources.map((source) => source.id);
    const probes = probePlan({
      perCandidate: { [rewriteIds[0]]: improving(0.05), [rewriteIds[1]]: improving(0.06) },
      onCall: (count, { baselineDir }) => {
        if (count !== 1) return;
        const target = join(baselineDir, "package.json");
        const original = readFileSync(target);
        const stat = statSync(target);
        const rewritten = Buffer.from(original);
        rewritten[0] = rewritten[0] === 0x7b ? 0x5b : 0x7b;
        writeFileSync(target, rewritten);
        utimesSync(target, stat.atimeMs / 1000, stat.mtimeMs / 1000);
        // Same length, same millisecond timestamp: only the content differs.
        assert.equal(statSync(target).size, stat.size);
        assert.equal(Math.floor(statSync(target).mtimeMs), Math.floor(stat.mtimeMs));
      },
    });
    const result = await runComposeCycle({
      repoRoot: rewriteFixture.repo,
      adapter: DOMAIN,
      candidates,
      composed,
      runRoot: join(rewriteFixture.root, "runroot"),
      ledgerPath: rewriteFixture.ledgerPath,
      includeSmoke: false,
      deps: { runGuards: guardPlan().runGuards, evaluateProbes: probes.evaluateProbes },
    });
    assert.equal(result.status, "rejected");
    assert.deepEqual(result.reasons, ["baseline_mutated"]);
    assert.equal(probes.calls.filter((call) => call.candidateDir.endsWith("/candidate")).length, 0);
    assert.equal(readLedger(rewriteFixture.ledgerPath).length, 0);
    assert.equal(git(rewriteFixture.repo, ["status", "--porcelain"]), "");
  } finally {
    rmSync(rewriteFixture.root, { recursive: true, force: true });
  }

  // An identical rewrite with a new timestamp is not a mutation: the fingerprint
  // must not block a cycle on mtime alone.
  const touchFixture = makeFixture();
  try {
    const candidates = twoCandidates();
    const composed = compose({
      repo: touchFixture.repo,
      root: touchFixture.root,
      ledgerPath: touchFixture.ledgerPath,
      candidates,
    });
    assert.equal(composed.ok, true, composed.reason);
    const touchIds = composed.composition.sources.map((source) => source.id);
    const touched = Date.now() + 60000;
    const probes = probePlan({
      perCandidate: { [touchIds[0]]: improving(0.05), [touchIds[1]]: improving(0.06) },
      composed: improving(0),
      onCall: (count, { baselineDir }) => {
        if (count !== 1) return;
        utimesSync(join(baselineDir, "package.json"), new Date(touched), new Date(touched));
      },
    });
    const result = await runComposeCycle({
      repoRoot: touchFixture.repo,
      adapter: DOMAIN,
      candidates,
      composed,
      runRoot: join(touchFixture.root, "runroot"),
      ledgerPath: touchFixture.ledgerPath,
      includeSmoke: false,
      deps: { runGuards: guardPlan().runGuards, evaluateProbes: probes.evaluateProbes },
    });
    assert.equal(result.status, "ok");
    assert.ok(!result.reasons.includes("baseline_mutated"), result.reasons.join(","));
    assert.ok(probes.calls.some((call) => call.candidateDir.endsWith("/candidate")));
    assert.equal(readLedger(touchFixture.ledgerPath).length, 1);
  } finally {
    rmSync(touchFixture.root, { recursive: true, force: true });
  }
});

test("two candidates that edit the same file are a composition conflict, before any probe", async () => {
  const { root, repo, ledgerPath } = makeFixture();
  try {
    const first = candidate({ rel: FILES.decision, original: "export const decision = 1;", line: "export const decision = 2;" });
    const second = candidate({ rel: FILES.decision, original: "export const decision = 1;", line: "export const decision = 3;" });
    const composed = compose({ repo, root, ledgerPath, candidates: [first, second] });
    assert.equal(composed.ok, false);
    assert.equal(composed.reason, "composition_conflict");
    assert.deepEqual(composed.conflicts.map((conflict) => conflict.path), [FILES.decision]);
    assert.equal(composed.conflicts[0].sources.length, 2);

    const probes = probePlan();
    const result = await runComposeCycle({
      repoRoot: repo,
      adapter: DOMAIN,
      candidates: [first, second],
      composed: { proposal: { patchFile: null }, composition: null },
      runRoot: join(root, "runroot"),
      ledgerPath,
      includeSmoke: false,
      deps: { runGuards: guardPlan().runGuards, evaluateProbes: probes.evaluateProbes },
    });
    assert.equal(result.status, "rejected");
    assert.equal(result.reasons[0], "composition_proposal_missing");
    assert.equal(probes.calls.length, 0);
    assert.equal(readLedger(ledgerPath).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a candidate that fails a gate makes the composition abstain", async () => {
  const { root, repo, ledgerPath } = makeFixture();
  try {
    const candidates = twoCandidates();
    const composed = compose({ repo, root, ledgerPath, candidates });
    assert.equal(composed.ok, true, composed.reason);
    const ids = composed.composition.sources.map((source) => source.id);
    const probes = probePlan({ perCandidate: { [ids[0]]: improving(0.05), [ids[1]]: improving(0.06) } });
    // The second candidate's own scratch fails its guard.
    const guards = guardPlan({ failSuffix: `/candidates/${ids[1]}` });
    const result = await runComposeCycle({
      repoRoot: repo,
      adapter: DOMAIN,
      candidates,
      composed,
      runRoot: join(root, "runroot"),
      ledgerPath,
      includeSmoke: false,
      deps: { runGuards: guards.runGuards, evaluateProbes: probes.evaluateProbes },
    });
    assert.equal(result.status, "abstained");
    assert.equal(result.abstained, true);
    assert.deepEqual(result.reasons, ["composition_abstained_inadmissible_candidate"]);
    assert.deepEqual(result.excluded.map((entry) => entry.id), [ids[1]]);
    assert.ok(result.excluded[0].reasons.includes("guard_fail"));
    assert.equal(result.recorded, false);
    assert.equal(probes.calls.filter((call) => call.candidateDir.endsWith("/candidate")).length, 0);
    assert.equal(readLedger(ledgerPath).length, 0);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing and forged composition provenance stay distinct and are refused before any probe or ledger row", async () => {
  const { root, repo, ledgerPath } = makeFixture();
  try {
    const candidates = twoCandidates();
    const composed = compose({ repo, root, ledgerPath, candidates });
    assert.equal(composed.ok, true, composed.reason);
    const runRoot = join(root, "runroot");
    const base = {
      repoRoot: repo,
      adapter: DOMAIN,
      candidates,
      runRoot,
      ledgerPath,
      includeSmoke: false,
    };

    const probes = probePlan();
    const guards = guardPlan();
    const deps = { runGuards: guards.runGuards, evaluateProbes: probes.evaluateProbes };

    const missing = await runComposeCycle({ ...base, deps });
    assert.equal(missing.status, "rejected");
    assert.deepEqual(missing.reasons, ["composition_proposal_missing"]);

    const forgedDigest = {
      proposal: composed.proposal,
      composition: { ...composed.composition, composedSha256: sha256Hex("a different composed patch\n") },
    };
    const forged = await runComposeCycle({ ...base, composed: forgedDigest, deps });
    assert.equal(forged.status, "rejected");
    assert.deepEqual(forged.reasons, ["composition_provenance_mismatch"]);
    assert.equal(forged.detail, "composed_patch_mismatch");

    const forgedId = structuredClone(composed.composition);
    forgedId.sources[0].id = "cand-000000000000";
    const relabelled = await runComposeCycle({ ...base, composed: { proposal: composed.proposal, composition: forgedId }, deps });
    assert.equal(relabelled.status, "rejected");
    assert.deepEqual(relabelled.reasons, ["composition_provenance_mismatch"]);
    assert.match(relabelled.detail, /source_id_not_recomputable/);

    const unrecorded = await runComposeCycle({
      ...base,
      candidates: [
        ...candidates,
        candidate({ rel: FILES.alpha, original: "export const alpha = 1;", line: "export const alpha = 2;" }),
      ],
      composed,
      deps,
    });
    assert.equal(unrecorded.status, "rejected");
    assert.deepEqual(unrecorded.reasons, ["composition_source_unrecorded"]);

    assert.equal(probes.calls.length, 0);
    assert.equal(guards.calls.length, 0);
    assert.equal(readLedger(ledgerPath).length, 0);

    // The engine boundary distinguishes the two refusal meanings: a record that
    // is not complete provenance is `missing` (the baseline fingerprint is only
    // knowable after the candidate-probe phase), while a complete record that
    // describes another patch is `mismatch`.
    const direct = await runCycle({
      repoRoot: repo,
      adapter: DOMAIN,
      proposal: { ...composed.proposal, campaignId: "default" },
      composition: composed.composition,
      runRoot,
      ledgerPath,
      includeSmoke: false,
      deps,
    });
    assert.equal(direct.status, "rejected");
    assert.deepEqual(direct.reasons, ["composition_provenance_missing"]);
    assert.equal(direct.detail, "baseline_fingerprint_missing");
    assert.equal(direct.recorded, false);

    const forgedAtBoundary = await runCycle({
      repoRoot: repo,
      adapter: DOMAIN,
      proposal: { ...composed.proposal, campaignId: "default" },
      composition: {
        ...forgedDigest.composition,
        // Stand-in for the measured baseline fingerprint: this case forges the
        // patch digest, not the baseline identity.
        baselineFingerprint: sha256Hex("probe-baseline"),
      },
      runRoot,
      ledgerPath,
      includeSmoke: false,
      deps,
    });
    assert.equal(forgedAtBoundary.status, "rejected");
    assert.deepEqual(forgedAtBoundary.reasons, ["composition_provenance_mismatch"]);
    assert.equal(forgedAtBoundary.detail, "composed_patch_mismatch");
    assert.equal(forgedAtBoundary.recorded, false);
    assert.equal(readLedger(ledgerPath).length, 0);
    assert.equal(git(repo, ["status", "--porcelain"]), "");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the composed result keeps the held-out, cost and edit-budget gates", async () => {
  const heldoutFixture = makeFixture();
  try {
    const candidates = twoCandidates();
    const composed = compose({ repo: heldoutFixture.repo, root: heldoutFixture.root, ledgerPath: heldoutFixture.ledgerPath, candidates });
    assert.equal(composed.ok, true, composed.reason);
    const ids = composed.composition.sources.map((source) => source.id);
    const probes = probePlan({
      perCandidate: { [ids[0]]: improving(0.05), [ids[1]]: improving(0.06) },
      composed: improving(0.05, { baseline: { safety: 0.5 }, candidate: { safety: 0.1 } }),
    });
    const result = await runComposeCycle({
      repoRoot: heldoutFixture.repo,
      adapter: DOMAIN,
      candidates,
      composed,
      runRoot: join(heldoutFixture.root, "runroot"),
      ledgerPath: heldoutFixture.ledgerPath,
      includeSmoke: false,
      deps: { runGuards: guardPlan().runGuards, evaluateProbes: probes.evaluateProbes },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.decision, "reject");
    assert.ok(result.reasons.includes("heldout_regression"), result.reasons.join(","));
    assert.equal(result.composed.scores.heldout.ok, false);
    assert.equal(readLedger(heldoutFixture.ledgerPath).length, 1);
  } finally {
    rmSync(heldoutFixture.root, { recursive: true, force: true });
  }

  const costFixture = makeFixture();
  try {
    const filler = `// filler ${"x".repeat(40000)}`;
    const costCandidates = [
      candidate({ rel: FILES.decision, original: "export const decision = 1;", line: filler }),
      candidate({ rel: FILES.base, original: "export const base = 1;", line: filler }),
    ];
    const composed = compose({ repo: costFixture.repo, root: costFixture.root, ledgerPath: costFixture.ledgerPath, candidates: costCandidates });
    assert.equal(composed.ok, true, composed.reason);
    const ids = composed.composition.sources.map((source) => source.id);
    const probes = probePlan({
      perCandidate: { [ids[0]]: improving(0.05), [ids[1]]: improving(0.06) },
      // Below the paid multiple of the floor, so the byte increase cannot be bought.
      composed: improving(0.015),
    });
    const result = await runComposeCycle({
      repoRoot: costFixture.repo,
      adapter: DOMAIN,
      candidates: costCandidates,
      composed,
      runRoot: join(costFixture.root, "runroot"),
      ledgerPath: costFixture.ledgerPath,
      includeSmoke: false,
      deps: { runGuards: guardPlan().runGuards, evaluateProbes: probes.evaluateProbes },
    });
    assert.equal(result.status, "ok");
    assert.equal(result.decision, "reject");
    assert.ok(result.reasons.includes("cost_rule"), result.reasons.join(","));
    assert.equal(readLedger(costFixture.ledgerPath).length, 1);
  } finally {
    rmSync(costFixture.root, { recursive: true, force: true });
  }

  const budgetFixture = makeFixture();
  try {
    const spread = [
      {
        objective: "probe.decision_accuracy",
        hypothesis: "candidate spanning two editable files",
        commitMessage: "fix(jev-advisor): span two files",
        patchText: [
          appendPatch(FILES.decision, "export const decision = 1;", "export const decision = 2;"),
          appendPatch(FILES.alpha, "export const alpha = 1;", "export const alpha = 2;"),
        ].join(""),
      },
      {
        objective: "probe.decision_accuracy",
        hypothesis: "second candidate spanning two editable files",
        commitMessage: "fix(verification-receipts): span two files",
        patchText: [
          appendPatch(FILES.base, "export const base = 1;", "export const base = 2;"),
          appendPatch(FILES.beta, "export const beta = 1;", "export const beta = 2;"),
        ].join(""),
      },
    ];
    const composed = compose({ repo: budgetFixture.repo, root: budgetFixture.root, ledgerPath: budgetFixture.ledgerPath, candidates: spread });
    assert.equal(composed.ok, false);
    assert.equal(composed.reason, "budget_precheck");
    assert.ok(composed.detail.violations.some((violation) => violation.startsWith("files:4>3")), composed.detail.violations.join(","));
    assert.equal(readLedger(budgetFixture.ledgerPath).length, 0);
  } finally {
    rmSync(budgetFixture.root, { recursive: true, force: true });
  }
});

test("the composed cycle row keeps the ordinary gate evidence and the candidate patches", async () => {
  const { root, repo, ledgerPath } = makeFixture();
  try {
    const candidates = twoCandidates();
    const composed = compose({ repo, root, ledgerPath, candidates });
    assert.equal(composed.ok, true, composed.reason);
    const ids = composed.composition.sources.map((source) => source.id);
    const probes = probePlan({ perCandidate: { [ids[0]]: improving(0.05), [ids[1]]: improving(0.06) }, composed: improving(0) });
    const runRoot = join(root, "runroot");
    const result = await runComposeCycle({
      repoRoot: repo,
      adapter: DOMAIN,
      candidates,
      composed,
      runRoot,
      ledgerPath,
      includeSmoke: false,
      deps: { runGuards: guardPlan().runGuards, evaluateProbes: probes.evaluateProbes },
    });
    assert.equal(result.status, "ok");
    const evidencePath = join(runRoot, "runs", result.composeId, "composition.json");
    assert.ok(existsSync(evidencePath), evidencePath);
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.schema, "gjc.self-improve.compose.v1");
    assert.equal(evidence.sources.length, 2);
    assert.ok(evidence.sources.every((source) => /^[0-9a-f]{64}$/.test(source.patchSha256)));
    assert.deepEqual(evidence.results.map((entry) => entry.verdict), ["adopt", "adopt"]);
    assert.equal(evidence.composed.decision, "reject");
    // The probe phase cost is measured and recorded with the evidence, separate
    // from the composed row's own cost.
    assert.equal(evidence.probeCost.candidates, 2);
    assert.equal(typeof evidence.probeCost.wallMs, "number");
    assert.ok(evidence.probeCost.bytes > 0);
    assert.ok(existsSync(join(runRoot, "runs", result.composeId, "candidate-patches", `${ids[0]}.patch`)));
    const row = readLedger(ledgerPath)[0];
    assert.ok(Array.isArray(row.guards) && row.guards.length > 0);
    assert.equal(row.scores.floor, 0.01);
    assert.equal(row.verdict.decision, "reject");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
