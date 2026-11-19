#!/usr/bin/env node
/**
 * self-improve CLI: report, cycle, loop, replay, dream, policy, recover, prune, runner, history, distill.
 */
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { homedir, tmpdir } from "node:os";
import * as fs from "node:fs";
import DOMAIN from "../domains/gjc-plugin/adapter.mjs";
import RULES_TEXT_DOMAIN from "../domains/rules-text/adapter.mjs";
import {
  campaignAcceptedCount,
  defaultRunRoot,
  historyState,
  pruneRuns,
  recoverPendingCycle,
  runComposeCycle,
  runCycle,
} from "../lib/engine.mjs";
import { rungFor } from "../lib/budget.mjs";
import { LOOP_DEFAULTS, runLoop } from "../lib/loop.mjs";
import { MAX_COMPOSITION_SOURCES, MIN_COMPOSITION_SOURCES, ledgerCounts, readLedger } from "../lib/ledger.mjs";
import { composeCandidateProposals } from "../lib/propose.mjs";
import { distillTrajectories, parseMaxLag, readStoreFile, RRSI_STORE_SCHEMA } from "../lib/distill.mjs";
import { BASELINE_POLICIES, DEFAULT_BETAS, loadCorpus, scorePolicy } from "../lib/replay.mjs";
import { runDream, summarizeScore } from "../lib/dream.mjs";
import {
  DEFAULT_POLICY_DIR,
  applyPolicyDeploy,
  buildPolicyArtifact,
  listPolicyArtifacts,
  planPolicyDeploy,
  policyArtifactPath,
  readCurrentPolicy,
  readPolicyArtifact,
} from "../lib/policy.mjs";
import { buildTextFixturePrompt, runStochasticEvaluation } from "../lib/runner.mjs";

const SELF_IMPROVE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_LEDGER = join(SELF_IMPROVE_DIR, "ledger.jsonl");

// `compose` input manifest contract (Harness² M2). Candidate provenance is
// derived by the proposal pipeline, never accepted from the caller: these keys
// are refused wherever they appear in the manifest or a candidate file.
const COMPOSE_INPUT_SCHEMA = "gjc.self-improve.compose-input.v1";
const COMPOSE_INPUT_FIELDS = Object.freeze(["schema", "objective", "hypothesis", "commitMessage", "candidates"]);
const COMPOSE_PROVENANCE_FIELDS = Object.freeze([
  "id",
  "patchSha256",
  "groupId",
  "composition",
  "composed",
  "composedSha256",
  "sources",
  "baselineFingerprint",
  "provenance",
]);

// Domain registry: `--domain <id>` selects an adapter; absent -> gjc-plugin
// (the historical default, unchanged). Unknown ids fail closed with exit 2.
const ADAPTERS = new Map([
  [DOMAIN.id, DOMAIN],
  [RULES_TEXT_DOMAIN.id, RULES_TEXT_DOMAIN],
]);

function resolveDomain(options) {
  if (options.domain === undefined) return { adapter: DOMAIN, error: null };
  const adapter = ADAPTERS.get(options.domain);
  return adapter
    ? { adapter, error: null }
    : { adapter: null, error: `unknown_domain: ${options.domain} (known: ${[...ADAPTERS.keys()].join(", ")})` };
}

const USAGE = `usage: node self-improve/scripts/run.mjs <command> [options]

commands:
  report  [--json] [--ledger <path>]
  cycle   --proposal <path> [--repo <path>] [--run-root <path>] [--ledger <path>]
          [--domain <id>] [--campaign <id>] [--dry-run] [--install] [--reset-budget] [--json]
  compose [--cost-ratio <n>] --proposals <path> [--repo <path>] [--objective <id>] [--domain <id>] [--campaign <id>]
          [--run-root <path>] [--ledger <path>] [--dry-run] [--install] [--reset-budget] [--json]
  loop    [--repo <path>] [--store <path>] [--domain <id>] [--proposer stub|cmd] [--proposer-cmd '<template>'] [--live-approved]
          [--candidate-file <path>] [--max-lag <n>]
          [--max-cycles N] [--max-wall-ms T] [--max-proposer-calls C] [--batch-size W] [--compose-count N] [--proposer-timeout-ms <n>]
          [--stop-on-adopt] [--install] [--loop-id <id>] [--run-root <path>] [--ledger <path>] [--dry-run] [--json]
  replay  [--corpus ledger] [--domain <id>] [--policy <id>|B0|B1] [--policy-file <path>] [--policy-dir <path>] [--ledger <path>] [--json]
  dream   [--domain <id>] [--seed <n>] [--max-candidates <n>] [--out <path>] [--write-policy <id>] [--policy-dir <path>]
          [--ledger <path>] [--json]
  policy  [--list] [--deploy <id>] [--policy-dir <path>] [--ledger <path>] [--dry-run] [--json]
  recover [--repo <path>] [--run-root <path>] [--json]
  prune   [--run-root <path>] [--keep <n>] [--json]
  runner  --baseline <dir> --candidate <dir> [--mode local_stub|live] [--k <n>]
          [--timeout-ms <n>] [--model <pin>] [--prompt <text> | --text-fixture <path>]
          [--live-approved] [--run-root <path>] [--json]
  history [--json] [--ledger <path>]
  distill [--store <path>] [--ledger <path>] [--objective <id>] [--domain <id>] [--max-lag <n>] [--out <path>] [--json]
`;

const VALUED_FLAGS = new Set([
  "--cost-ratio",
  "--ledger",
  "--store",
  "--objective",
  "--max-lag",
  "--candidate-file",
  "--domain",
  "--proposal",
  "--repo",
  "--run-root",
  "--campaign",
  "--keep",
  "--baseline",
  "--candidate",
  "--mode",
  "--k",
  "--timeout-ms",
  "--model",
  "--prompt",
  "--text-fixture",
  "--proposer",
  "--proposer-cmd",
  "--proposals",
  "--compose-count",
  "--max-cycles",
  "--max-wall-ms",
  "--max-proposer-calls",
  "--proposer-timeout-ms",
  "--batch-size",
  "--loop-id",
  "--corpus",
  "--policy",
  "--policy-file",
  "--policy-dir",
  "--seed",
  "--out",
  "--max-candidates",
  "--write-policy",
  "--deploy",
]);

function parseArgs(argv) {
  const [command = "", ...rest] = argv;
  const options = { json: false, dryRun: false, liveApproved: false };
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (token === "--json") options.json = true;
    else if (token === "--dry-run") options.dryRun = true;
    else if (token === "--live-approved") options.liveApproved = true;
    else if (token === "--install") options.install = true;
    else if (token === "--reset-budget") options.resetBudget = true;
    else if (token === "--stop-on-adopt") options.stopOnAdopt = true;
    else if (token === "--list") options.list = true;
    else if (VALUED_FLAGS.has(token)) {
      const value = rest[i + 1];
      if (value === undefined || value.startsWith("--")) return { error: `${token} requires a value` };
      options[token.slice(2)] = value;
      i += 1;
    } else {
      return { error: `unknown option: ${token}` };
    }
  }
  return { command, options };
}

function runReport(options) {
  const ledgerPath = options.ledger ? resolve(options.ledger) : DEFAULT_LEDGER;
  const counts = ledgerCounts(ledgerPath);
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ ledger: ledgerPath, ...counts }, null, 2)}\n`);
  } else {
    process.stdout.write(
      `ledger=${ledgerPath}\n` +
        `rows=${counts.total} cycles=${counts.byKind.cycle} adoptions=${counts.byKind.adoption}\n` +
        `verdicts: adopt=${counts.byVerdict.adopt} reject=${counts.byVerdict.reject} inconclusive=${counts.byVerdict.inconclusive}\n` +
        `cost: wallMs=${counts.cost.wallMsMeasured}/${counts.cost.cycleRows} bytes=${counts.cost.bytesMeasured}/${counts.cost.cycleRows} tokens=${counts.cost.tokensMeasured} measured/${counts.cost.tokensNull} null\n` +
        `retry: blocked=${counts.retry.blockedObjectives} retriedAfterBlock=${counts.retry.retriedAfterBlock} retryRows=${counts.retry.retryRows} (stallK=${counts.retry.stallK})\n` +
        `chain: ${counts.chain.ok ? "ok" : "broken"} (${counts.chain.count} rows)\n`,
    );
  }
  return 0;
}

async function runCycleCommand(options) {
  if (!options.proposal) {
    process.stderr.write(`cycle requires --proposal <path>\n\n${USAGE}`);
    return 2;
  }
  const { adapter, error: domainError } = resolveDomain(options);
  if (domainError) {
    process.stderr.write(`${domainError}\n`);
    return 2;
  }
  const repoRoot = resolve(options.repo ?? process.cwd());
  const proposalFile = resolve(options.proposal);
  const proposal = JSON.parse(fs.readFileSync(proposalFile, "utf8"));
  if (options.campaign) proposal.campaignId = options.campaign;
  if (proposal.patchFile && !isAbsolute(proposal.patchFile)) {
    proposal.patchFile = resolve(dirname(proposalFile), proposal.patchFile);
  }
  const result = await runCycle({
    repoRoot,
    adapter,
    proposal,
    runRoot: options["run-root"] ? resolve(options["run-root"]) : undefined,
    ledgerPath: options.ledger ? resolve(options.ledger) : join(repoRoot, "self-improve", "ledger.jsonl"),
    dryRun: options.dryRun === true,
    install: options.install === true,
    resetBudget: options.resetBudget === true,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `status=${result.status} cycle=${result.cycleId ?? "-"} decision=${result.decision ?? "-"} adoption=${result.adoption ?? "-"}\n` +
        (result.reasons?.length ? `reasons: ${result.reasons.join(", ")}\n` : ""),
    );
  }
  return result.status === "ok" || result.status === "dry-run" ? 0 : 2;
}

function boundedComposeRefusal(result) {
  const parts = [];
  const detail = result?.detail;
  if (detail && Array.isArray(detail.violations)) parts.push(`violations=${detail.violations.slice(0, 4).join("|")}`);
  if (detail && Array.isArray(detail.offending)) parts.push(`offending=${detail.offending.slice(0, 4).join("|")}`);
  if (Array.isArray(result?.matched)) parts.push(`matched=${result.matched.slice(0, 4).join(",")}`);
  if (Array.isArray(result?.conflicts)) {
    parts.push(`conflicts=${result.conflicts.slice(0, 4).map((entry) => entry.path).join(",")}`);
  }
  if (typeof detail === "string") parts.push(detail);
  else if (typeof detail?.detail === "string") parts.push(detail.detail);
  return parts.join(" ").slice(0, 240) || undefined;
}

/**
 * `compose`: propose–probe–compose over an explicit, bounded candidate set.
 *
 * The manifest names 2..4 proposal files (same shape as `cycle --proposal`);
 * the composed proposal and its provenance are derived here by the ordinary
 * admission pipeline, never read from the caller. Each candidate is probed on
 * its own against one shared baseline, and the composed patch then runs through
 * the ordinary `runCycle` gates; only that composed verdict can adopt.
 */
async function runComposeCommand(options) {
  if (!options.proposals) {
    process.stderr.write(`compose requires --proposals <path>\n\n${USAGE}`);
    return 2;
  }
  const { adapter, error: domainError } = resolveDomain(options);
  if (domainError) {
    process.stderr.write(`${domainError}\n`);
    return 2;
  }
  const fail = (status, reason, detail, code) => {
    const payload = { status, reason, ...(detail ? { detail } : {}) };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.stderr.write(`compose: ${status}: ${reason}${detail ? ` (${detail})` : ""}\n`);
    return code;
  };
  const repoRoot = resolve(options.repo ?? process.cwd());
  const manifestPath = resolve(options.proposals);
  let manifestText;
  try {
    manifestText = fs.readFileSync(manifestPath, "utf8");
  } catch (error) {
    return fail("error", "compose_manifest_unreadable", manifestPath, 3);
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    return fail("error", "compose_manifest_invalid_json", String(error.message).slice(0, 120), 3);
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return fail("refused", "compose_input_shape", null, 2);
  }
  if (manifest.schema !== COMPOSE_INPUT_SCHEMA) {
    return fail("refused", "compose_input_schema_mismatch", COMPOSE_INPUT_SCHEMA, 2);
  }
  const extraFields = Object.keys(manifest).filter((key) => !COMPOSE_INPUT_FIELDS.includes(key));
  const forgedFields = extraFields.filter((key) => COMPOSE_PROVENANCE_FIELDS.includes(key));
  if (forgedFields.length > 0) {
    return fail("refused", "compose_input_carries_provenance", forgedFields.join(","), 2);
  }
  if (extraFields.length > 0) {
    return fail("refused", "compose_input_unknown_field", extraFields.join(","), 2);
  }
  if (manifest.hypothesis !== undefined && typeof manifest.hypothesis !== "string") {
    return fail("refused", "compose_input_shape", "hypothesis", 2);
  }
  if (manifest.commitMessage !== undefined && typeof manifest.commitMessage !== "string") {
    return fail("refused", "compose_input_shape", "commitMessage", 2);
  }
  const objective = options.objective ?? manifest.objective;
  if (typeof objective !== "string" || objective.length === 0) {
    return fail("refused", "compose_objective_required", null, 2);
  }
  const declared = Array.isArray(manifest.candidates) ? manifest.candidates.length : 0;
  if (!Array.isArray(manifest.candidates) || declared < MIN_COMPOSITION_SOURCES || declared > MAX_COMPOSITION_SOURCES) {
    return fail(
      "refused",
      "compose_candidate_count_out_of_range",
      `count=${declared} (${MIN_COMPOSITION_SOURCES}..${MAX_COMPOSITION_SOURCES})`,
      2,
    );
  }
  const candidates = [];
  for (const [index, entry] of manifest.candidates.entries()) {
    const relativePath = typeof entry === "string"
      ? entry
      : entry && typeof entry === "object" && !Array.isArray(entry) && typeof entry.file === "string" && Object.keys(entry).length === 1
        ? entry.file
        : null;
    if (relativePath === null || relativePath.length === 0) {
      return fail("refused", "compose_candidate_input_invalid", `index=${index}`, 2);
    }
    const candidatePath = isAbsolute(relativePath) ? relativePath : resolve(dirname(manifestPath), relativePath);
    let candidateText;
    try {
      candidateText = fs.readFileSync(candidatePath, "utf8");
    } catch (error) {
      return fail("error", "compose_candidate_unreadable", `index=${index} ${candidatePath}`, 3);
    }
    let proposal;
    try {
      proposal = JSON.parse(candidateText);
    } catch (error) {
      return fail("error", "compose_candidate_invalid_json", `index=${index}`, 3);
    }
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
      return fail("refused", "compose_candidate_shape", `index=${index}`, 2);
    }
    const candidateForged = COMPOSE_PROVENANCE_FIELDS.filter((key) => Object.hasOwn(proposal, key));
    if (candidateForged.length > 0) {
      return fail("refused", "compose_candidate_carries_provenance", `index=${index}:${candidateForged.join(",")}`, 2);
    }
    if (typeof proposal.hypothesis !== "string" || proposal.hypothesis.trim().length === 0) {
      return fail("refused", "compose_candidate_proposal_incomplete", `index=${index}:hypothesis`, 2);
    }
    if (typeof proposal.commitMessage !== "string" || proposal.commitMessage.trim().length === 0) {
      return fail("refused", "compose_candidate_proposal_incomplete", `index=${index}:commitMessage`, 2);
    }
    if (proposal.objective !== undefined && proposal.objective !== objective) {
      return fail("refused", "compose_candidate_objective_mismatch", `index=${index}`, 2);
    }
    const hasPatchText = typeof proposal.patchText === "string" && proposal.patchText.length > 0;
    const hasPatchFile = typeof proposal.patchFile === "string" && proposal.patchFile.length > 0;
    if (hasPatchText && hasPatchFile) {
      return fail("refused", "compose_candidate_patch_ambiguous", `index=${index}`, 2);
    }
    if (!hasPatchText && !hasPatchFile) {
      return fail("refused", "compose_candidate_patch_required", `index=${index}`, 2);
    }
    candidates.push({
      objective,
      hypothesis: proposal.hypothesis,
      commitMessage: proposal.commitMessage,
      ...(hasPatchText
        ? { patchText: proposal.patchText }
        : {
            patchFile: isAbsolute(proposal.patchFile)
              ? proposal.patchFile
              : resolve(dirname(candidatePath), proposal.patchFile),
          }),
    });
  }

  const ledgerPath = options.ledger ? resolve(options.ledger) : join(repoRoot, "self-improve", "ledger.jsonl");
  const campaignId = options.campaign ?? "default";
  const accepted = options.resetBudget === true ? 0 : campaignAcceptedCount(ledgerPath, campaignId);
  const rung = rungFor(accepted, adapter.budget);
  const patchDir = fs.mkdtempSync(join(tmpdir(), "self-improve-compose-cli-"));
  try {
    const composed = composeCandidateProposals({
      candidates,
      objective,
      hypothesis: manifest.hypothesis ?? null,
      commitMessage: manifest.commitMessage ?? null,
      rung,
      adapter,
      repoRoot,
      ledgerPath,
      stallK: adapter.stallK ?? 3,
      patchDir,
    });
    if (!composed.ok) {
      return fail("refused", composed.reason ?? "compose_refused", boundedComposeRefusal(composed), 2);
    }
    let costConfig;
    if (options["cost-ratio"] !== undefined) {
      const ratio = Number(options["cost-ratio"]);
      if (!Number.isFinite(ratio) || ratio <= 0) {
        return fail("refused", "compose_cost_ratio_invalid", String(options["cost-ratio"]).slice(0, 40), 2);
      }
      costConfig = { wallMsBytesIncreaseRatio: ratio };
    }
    const result = await runComposeCycle({
      repoRoot,
      adapter,
      candidates,
      ...(costConfig ? { costConfig } : {}),
      composed: { proposal: composed.proposal, composition: composed.composition },
      campaignId,
      runRoot: options["run-root"] ? resolve(options["run-root"]) : undefined,
      ledgerPath,
      dryRun: options.dryRun === true,
      install: options.install === true,
      resetBudget: options.resetBudget === true,
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const composedSha256 = result.composition?.composedSha256 ?? null;
      process.stdout.write(
        `status=${result.status} compose=${result.composeId ?? "-"} cycle=${result.cycleId ?? "-"} ` +
          `decision=${result.decision ?? "-"} adoption=${result.adoption ?? "-"} ` +
          `candidates=${result.candidates?.length ?? 0} composed=${composedSha256 ? composedSha256.slice(0, 12) : "-"}\n` +
          (result.reasons?.length ? `reasons: ${result.reasons.join(", ")}\n` : ""),
      );
      for (const candidateEntry of result.candidates ?? []) {
        process.stdout.write(
          `- ${candidateEntry.id} ${candidateEntry.verdict ?? "-"} improved=${candidateEntry.improved === true} ` +
            `delta=${candidateEntry.scores?.delta ?? "-"}\n`,
        );
      }
    }
    return result.status === "ok" || result.status === "dry-run" ? 0 : 2;
  } finally {
    fs.rmSync(patchDir, { recursive: true, force: true });
  }
}

function selfImproveConfig() {
  try {
    return JSON.parse(fs.readFileSync(join(SELF_IMPROVE_DIR, "rrsi.json"), "utf8"));
  } catch {
    return {};
  }
}

function protocolP2Numbers() {
  try {
    const protocol = JSON.parse(fs.readFileSync(join(SELF_IMPROVE_DIR, "rrsi-protocol.json"), "utf8"));
    return {
      passGateN: protocol?.p2?.passGateN ?? 20,
      trainN: protocol?.p2?.train ?? 14,
      validationN: protocol?.p2?.validation ?? 6,
    };
  } catch {
    return { passGateN: 20, trainN: 14, validationN: 6 };
  }
}

function policyDirFor(options) {
  return options["policy-dir"] ? resolve(options["policy-dir"]) : join(SELF_IMPROVE_DIR, "policies");
}

function ledgerPathFor(options) {
  return options.ledger ? resolve(options.ledger) : DEFAULT_LEDGER;
}

function resolveCorpusPolicy(options, policyDir) {
  const id = options.policy ?? "B0";
  if (BASELINE_POLICIES[id]) return BASELINE_POLICIES[id];
  const file = options["policy-file"] ? resolve(options["policy-file"]) : policyArtifactPath({ policyDir, id });
  return readPolicyArtifact(file).policy;
}

function runReplayCommand(options) {
  if (options.corpus !== undefined && options.corpus !== "ledger") {
    process.stderr.write(`unknown --corpus: ${options.corpus} (only ledger)\n`);
    return 2;
  }
  const { adapter, error: domainError } = resolveDomain(options);
  if (domainError) {
    process.stderr.write(`${domainError}\n`);
    return 2;
  }
  const ledgerPath = ledgerPathFor(options);
  const corpus = loadCorpus({ ledgerPath });
  const betas = selfImproveConfig().policy?.betas ?? DEFAULT_BETAS;
  const policies = options.policy ? [resolveCorpusPolicy(options, policyDirFor(options))] : Object.values(BASELINE_POLICIES);
  const scores = policies.map((policy) => summarizeScore(scorePolicy({ corpus, policy, adapter, betas })));
  const result = {
    schema: "gjc.self-improve.replay.v1",
    corpus: {
      ledgerPath,
      attempts: corpus.attempts.length,
      adoptions: corpus.adoptionCount,
      epochs: corpus.epochs.length,
      ledgerSha256: corpus.ledgerSha256,
    },
    betas,
    scores,
  };
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else {
    process.stdout.write(
      `corpus attempts=${result.corpus.attempts} adoptions=${result.corpus.adoptions} epochs=${result.corpus.epochs}\n` +
        scores
          .map(
            (score) =>
              `${score.policyId}: reached=${score.adoptionReached} attemptsToFirst=${score.attemptsToFirstAdoption ?? "-"} costMs=${score.costMsToFirstAdoption ?? "-"} parallelism=${score.parallelism}\n`,
          )
          .join(""),
    );
  }
  return 0;
}

function runDreamCommand(options) {
  const { adapter, error: domainError } = resolveDomain(options);
  if (domainError) {
    process.stderr.write(`${domainError}\n`);
    return 2;
  }
  const config = selfImproveConfig();
  const seed = options.seed === undefined ? (config.policy?.seed ?? 1) : Number.parseInt(options.seed, 10);
  if (!Number.isInteger(seed)) {
    process.stderr.write(`invalid --seed: ${options.seed}\n`);
    return 2;
  }
  const maxCandidates =
    options["max-candidates"] === undefined
      ? (config.policy?.maxCandidates ?? 48)
      : Number.parseInt(options["max-candidates"], 10);
  if (!Number.isInteger(maxCandidates) || maxCandidates < 1) {
    process.stderr.write(`invalid --max-candidates: ${options["max-candidates"]}\n`);
    return 2;
  }
  const ledgerPath = ledgerPathFor(options);
  const corpus = loadCorpus({ ledgerPath });
  const p2 = protocolP2Numbers();
  const receipt = runDream({
    corpus,
    adapter,
    seed,
    maxCandidates,
    passGateN: p2.passGateN,
    trainN: p2.trainN,
    validationN: p2.validationN,
    betas: config.policy?.betas ?? DEFAULT_BETAS,
  });
  let policyPath = null;
  if (options["write-policy"] !== undefined) {
    const policyDir = policyDirFor(options);
    const artifact = buildPolicyArtifact({
      id: options["write-policy"],
      seed,
      config: receipt.selected.config,
      createdAt: new Date().toISOString(),
      source: { corpus: receipt.corpus.ledgerSha256, verdict: receipt.verdict, receiptHash: receipt.receiptHash },
    });
    fs.mkdirSync(policyDir, { recursive: true, mode: 0o700 });
    policyPath = policyArtifactPath({ policyDir, id: artifact.id });
    fs.writeFileSync(policyPath, `${JSON.stringify(artifact, null, 2)}\n`);
  }
  if (options.out) fs.writeFileSync(resolve(options.out), `${JSON.stringify(receipt, null, 2)}\n`);
  if (options.json) process.stdout.write(`${JSON.stringify({ ...receipt, ...(policyPath ? { policyPath } : {}) }, null, 2)}\n`);
  else {
    process.stdout.write(
      `dream seed=${seed} candidates=${receipt.candidateCount} selected=${receipt.selected.id} verdict=${receipt.verdict}\n` +
        `corpus attempts=${receipt.corpus.attempts} adoptions=${receipt.corpus.adoptions} train=${receipt.corpus.trainN} validation=${receipt.corpus.validationN}\n` +
        (policyPath ? `policy artifact: ${policyPath}\n` : ""),
    );
  }
  return 0;
}

function runPolicyCommand(options) {
  const policyDir = policyDirFor(options);
  if (options.list) {
    const current = readCurrentPolicy({ policyDir });
    const result = { policyDir, policies: listPolicyArtifacts({ policyDir }), current };
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else process.stdout.write(`policies=[${result.policies.join(", ")}] current=${current?.id ?? "none"}\n`);
    return 0;
  }
  if (options.deploy !== undefined) {
    const { policy } = readPolicyArtifact(policyArtifactPath({ policyDir, id: options.deploy }));
    const plan = planPolicyDeploy({ policyDir, policy, decision: "deploy", createdAt: new Date().toISOString() });
    if (options.dryRun) {
      const preview = { artifactPath: plan.artifactPath, currentPath: plan.currentPath, row: plan.row, commitMessage: plan.commitMessage };
      if (options.json) process.stdout.write(`${JSON.stringify(preview, null, 2)}\n`);
      else process.stdout.write(`dry-run: would write ${plan.artifactPath}, ${plan.currentPath} and one policy row\n`);
      return 0;
    }
    const ledgerPath = ledgerPathFor(options);
    const applied = applyPolicyDeploy({ plan, ledgerPath });
    // The deploy's own commit (plan §5: policy deploys are commits). Only when
    // the ledger lives inside a git work tree; otherwise the operator commits.
    let committed = null;
    let commitError = null;
    try {
      const probe = spawnSync("git", ["-C", dirname(ledgerPath), "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      if (probe.status === 0) {
        const repoRoot = probe.stdout.trim();
        const rel = (abs) => relative(repoRoot, resolve(abs));
        const add = spawnSync("git", ["-C", repoRoot, "add", "--", rel(applied.artifactPath), rel(applied.currentPath), rel(ledgerPath)], { encoding: "utf8" });
        if (add.status !== 0) throw new Error(add.stderr.trim() || `git_add_exit_${add.status}`);
        const commit = spawnSync("git", ["-C", repoRoot, "commit", "-m", applied.commitMessage], { encoding: "utf8" });
        if (commit.status !== 0) throw new Error(commit.stderr.trim() || `git_commit_exit_${commit.status}`);
        committed = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short=7", "HEAD"], { encoding: "utf8" }).stdout.trim();
      }
    } catch (error) {
      commitError = error.message;
    }
    const result = { ...applied, committed, commitError };
    if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    else {
      process.stdout.write(
        `deployed policy ${policy.id} (row ${applied.rowSeq})` +
          (committed ? `; commit ${committed}` : "; commit skipped (commit with: " + applied.commitMessage + ")") +
          (commitError ? `; commit failed: ${commitError}` : "") +
          "\n",
      );
    }
    return 0;
  }
  process.stderr.write(`policy requires --list or --deploy <id>\n`);
  return 2;
}

function runRecoverCommand(options) {
  const runRoot = options["run-root"] ? resolve(options["run-root"]) : defaultRunRoot();
  const repoRoot = resolve(options.repo ?? process.cwd());
  const results = recoverPendingCycle({ runRoot, repoRoot });
  if (options.json) process.stdout.write(`${JSON.stringify({ results }, null, 2)}\n`);
  else process.stdout.write(results.length === 0 ? "no pending cycles\n" : `${JSON.stringify(results)}\n`);
  return 0;
}

function runPruneCommand(options) {
  const runRoot = options["run-root"] ? resolve(options["run-root"]) : defaultRunRoot();
  const keep = options.keep === undefined ? 10 : Number.parseInt(options.keep, 10);
  if (!Number.isInteger(keep) || keep < 0) {
    process.stderr.write(`invalid --keep: ${options.keep}\n`);
    return 2;
  }
  const result = pruneRuns({ runRoot, keep });
  if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else
    process.stdout.write(`removed=${result.removed.length}${result.removed.length ? ` (${result.removed.join(", ")})` : ""}\n`);
  return 0;
}

async function runRunnerCommand(options) {
  if (!options.baseline || !options.candidate) {
    process.stderr.write(`runner requires --baseline <dir> and --candidate <dir>\n\n${USAGE}`);
    return 2;
  }
  const runRoot = options["run-root"] ? resolve(options["run-root"]) : defaultRunRoot();
  let prompt = options.prompt ?? "self-improve local stub trial";
  let textFixture = null;
  if (options["text-fixture"]) {
    const built = buildTextFixturePrompt({ fixturePath: options["text-fixture"] });
    prompt = built.prompt;
    textFixture = built.textFixture;
  }
  const k = options.k === undefined ? undefined : Number.parseInt(options.k, 10);
  if (k !== undefined && (!Number.isInteger(k) || k < 3)) {
    process.stderr.write(`invalid --k: ${options.k} (k >= 3)\n`);
    return 2;
  }
  const timeoutMs = options["timeout-ms"] === undefined ? undefined : Number.parseInt(options["timeout-ms"], 10);
  const result = await runStochasticEvaluation({
    mode: options.mode ?? "local_stub",
    k,
    timeoutMs: Number.isInteger(timeoutMs) ? timeoutMs : undefined,
    modelPin: options.model,
    prompt,
    textFixture,
    liveApproved: options.liveApproved === true,
    baselineDir: resolve(options.baseline),
    candidateDir: resolve(options.candidate),
    runRoot,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `mode=${result.mode ?? "-"} skipped=${result.skipped ?? false}${result.reason ? ` reason=${result.reason}` : ""} ` +
        `baseline=${result.baseline?.median ?? "-"} candidate=${result.candidate?.median ?? "-"} delta=${result.delta ?? "-"} floor=${result.floor ?? "-"}\n`,
    );
  }
  return 0;
}

async function runLoopCommand(options) {
  const repoRoot = resolve(options.repo ?? process.cwd());
  const { adapter, error: domainError } = resolveDomain(options);
  if (domainError) {
    process.stderr.write(`${domainError}\n`);
    return 2;
  }
  const maxLag = parseMaxLag(options["max-lag"]);
  if (!maxLag.ok) {
    process.stderr.write(`${maxLag.message}\n`);
    return 2;
  }
  const proposer = options.proposer ?? "stub";
  if (proposer !== "stub" && proposer !== "cmd") {
    process.stderr.write(`unknown --proposer: ${proposer} (stub|cmd)\n`);
    return 2;
  }
  if (proposer === "cmd" && !options["proposer-cmd"]) {
    process.stderr.write(`loop --proposer cmd requires --proposer-cmd '<template>'\n`);
    return 2;
  }
  const numberFlag = (name) => {
    if (options[name] === undefined) return undefined;
    const value = Number.parseInt(options[name], 10);
    if (!Number.isInteger(value) || value < 1) {
      process.stderr.write(`invalid --${name}: ${options[name]}\n`);
      return null;
    }
    return value;
  };
  const maxCycles = numberFlag("max-cycles");
  const maxWallMs = numberFlag("max-wall-ms");
  const maxProposerCalls = numberFlag("max-proposer-calls");
  const batchSize = numberFlag("batch-size");
  const composeCount = numberFlag("compose-count");
  const proposerTimeoutMs = numberFlag("proposer-timeout-ms");
  if ([maxCycles, maxWallMs, maxProposerCalls, batchSize, composeCount, proposerTimeoutMs].includes(null)) return 2;
  if (composeCount !== undefined && composeCount > MAX_COMPOSITION_SOURCES) {
    process.stderr.write(`invalid --compose-count: ${options["compose-count"]} (1..${MAX_COMPOSITION_SOURCES})\n`);
    return 2;
  }
  if (composeCount !== undefined && composeCount >= MIN_COMPOSITION_SOURCES && options["candidate-file"]) {
    process.stderr.write("loop --compose-count requires an unpinned objective (no --candidate-file)\n");
    return 2;
  }
  const result = await runLoop({
    repoRoot,
    adapter,
    proposer,
    proposerCmd: options["proposer-cmd"] ?? null,
    liveApproved: options.liveApproved === true,
    maxCycles: maxCycles ?? LOOP_DEFAULTS.maxCycles,
    maxWallMs: maxWallMs ?? LOOP_DEFAULTS.maxWallMs,
    maxProposerCalls: maxProposerCalls ?? LOOP_DEFAULTS.maxProposerCalls,
    batchSize: batchSize ?? LOOP_DEFAULTS.batchSize,
    composeCount: composeCount ?? 1,
    cmdProposerTimeoutMs: proposerTimeoutMs ?? undefined,
    stopOnAdopt: options.stopOnAdopt === true,
    install: options.install === true,
    candidatePath: options["candidate-file"] ? resolve(options["candidate-file"]) : null,
    storePath: options.store ? resolve(options.store) : join(homedir(), ".gjc-plugin", "rrsi", "store.json"),
    maxLag: maxLag.value,
    loopId: options["loop-id"],
    runRoot: options["run-root"] ? resolve(options["run-root"]) : undefined,
    ledgerPath: options.ledger ? resolve(options.ledger) : join(repoRoot, "self-improve", "ledger.jsonl"),
    dryRun: options.dryRun === true,
  });
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    process.stdout.write(
      `status=${result.status} loop=${result.loopId ?? "-"} cycles=${result.counters?.cycles ?? 0} ` +
        `stopped=${result.stoppedReason ?? result.reason ?? "-"}\n`,
    );
  }
  if (result.status === "skipped" && result.candidateRefused) {
    process.stderr.write(`loop: candidate refused: ${result.reason}\n`);
    return 2;
  }
  return 0;
}

function runDistillCommand(options) {
  const storePath = options.store ? resolve(options.store) : join(homedir(), ".gjc-plugin", "rrsi", "store.json");
  const ledgerPath = options.ledger ? resolve(options.ledger) : DEFAULT_LEDGER;
  const { adapter, error: domainError } = resolveDomain(options);
  if (domainError) {
    process.stderr.write(`${domainError}\n`);
    return 2;
  }
  const maxLag = parseMaxLag(options["max-lag"]);
  if (!maxLag.ok) {
    process.stderr.write(`${maxLag.message}\n`);
    return 2;
  }
  const declared = Array.isArray(adapter.objectives) ? adapter.objectives : [];
  const gated = adapter.probes?.[0]?.objective;
  if (options.objective && !declared.includes(options.objective)) {
    process.stderr.write(`distill: objective_not_declared: ${options.objective}\n`);
    return 2;
  }
  const read = readStoreFile(storePath);
  if (read.status === "invalid" || read.status === "unavailable") {
    process.stderr.write(`distill: store ${read.status}${read.reason ? ` (${read.reason})` : ""}: ${storePath}\n`);
    return 3;
  }
  let rows;
  try {
    rows = readLedger(ledgerPath);
  } catch (error) {
    process.stderr.write(`distill: ledger unreadable: ${error.message}\n`);
    return 3;
  }
  let result;
  try {
    result = distillTrajectories({
      store: read.status === "ok" ? read.store : { schema: RRSI_STORE_SCHEMA, episodes: [] },
      ledgerRows: rows,
      objective: options.objective ?? null,
      declaredObjectives: declared,
      gatedObjective: gated,
      maxLag: maxLag.value,
    });
  } catch (error) {
    process.stderr.write(`distill: ${error.message}\n`);
    return 2;
  }
  const payload = {
    ...result,
    domain: adapter.id,
    store: { ...result.store, status: read.status, path: storePath },
    ledger: { ...result.ledger, path: ledgerPath },
  };
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  if (options.out) {
    const outPath = resolve(options.out);
    try {
      fs.mkdirSync(dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, text, { mode: 0o600 });
    } catch (error) {
      process.stderr.write(`distill: cannot write --out ${outPath}: ${error.message}\n`);
      return 3;
    }
  }
  if (options.json) {
    process.stdout.write(text);
  } else {
    const projection = payload.projection;
    process.stdout.write(
      `domain=${payload.domain} store=${read.status} projection=${projection.maxDrawnFrom ?? "-"} head=${projection.ledgerHead} ` +
        `lag=${projection.storeLag ?? "-"} label=${projection.label} declared=${payload.groups.declared} gated=${payload.groups.gated} ` +
        `candidates=${payload.candidates.length} ` +
        `withheld=${payload.withheld.length} skipped=${payload.skipped.length} ` +
        `undeclared=${payload.undeclared.groups}(${payload.undeclared.attempts})` +
        `${options.out ? ` out=${resolve(options.out)}` : ""}\n`,
    );
    for (const candidate of payload.candidates) {
      process.stdout.write(`- ${candidate.objective} [${candidate.contrast.feature.kind}] ${candidate.rule}\n`);
    }
    for (const skip of payload.skipped) {
      process.stdout.write(`- ${skip.objective} skipped (${skip.reason}${skip.lag === null || skip.lag === undefined ? "" : `, lag ${skip.lag}`})\n`);
    }
  }
  return 0;
}

function runHistoryCommand(options) {
  const ledgerPath = options.ledger ? resolve(options.ledger) : DEFAULT_LEDGER;
  const state = historyState(ledgerPath);
  if (options.json) process.stdout.write(`${JSON.stringify({ ledger: ledgerPath, ...state }, null, 2)}\n`);
  else
    process.stdout.write(
      `ledger=${ledgerPath} stalled=[${state.stalled.join(", ")}] recentRejects=${state.lastRejects.length}\n`,
    );
  return 0;
}

async function run(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  const { command, options } = parsed;
  if (command === "report") return runReport(options);
  if (command === "cycle") return await runCycleCommand(options);
  if (command === "compose") return await runComposeCommand(options);
  if (command === "loop") return await runLoopCommand(options);
  if (command === "replay") return runReplayCommand(options);
  if (command === "dream") return runDreamCommand(options);
  if (command === "policy") return runPolicyCommand(options);
  if (command === "recover") return runRecoverCommand(options);
  if (command === "prune") return runPruneCommand(options);
  if (command === "runner") return await runRunnerCommand(options);
  if (command === "history") return runHistoryCommand(options);
  if (command === "distill") return runDistillCommand(options);
  if (command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(USAGE);
    return 0;
  }
  process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
  return 2;
}

process.exitCode = await run(process.argv.slice(2));
