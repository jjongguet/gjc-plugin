#!/usr/bin/env node
/** Execute frozen development cases through real CLI processes, with network denied. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256 } from "./audit-eco-evidence.mjs";

export const PRELOAD = `
import { readFileSync, appendFileSync } from 'node:fs';
const example = JSON.parse(readFileSync(process.env.FIXTURE_PATH, 'utf8'));
globalThis.fetch = async (url, options) => {
  if (url !== 'https://apis.opengateway.ai/v1/decisions') throw new Error('fixture_route_mismatch');
  if (options.headers.authorization !== 'Bearer offline-fixture-not-a-real-key') throw new Error('fixture_credential_mismatch');
  const body = JSON.parse(options.body);
  if (body.model !== 'sionic-ai/jev-omni' || JSON.stringify(Object.keys(body.questions.decision.criteria)) !== '["yes","no"]') throw new Error('fixture_contract_mismatch');
  appendFileSync(process.env.CALLS_PATH, 'intercepted\\n');
  return Response.json({ model: body.model, answers: { decision: { type: 'choice', choice: example.choice ?? 'yes', confidence: example.confidence, probabilities: example.probabilities } } });
};
`;

export function validateProtocol(protocol) {
  if (protocol?.schema !== "harness2.transfer-development.v1" || protocol.split !== "development" || protocol.repeats !== 2) throw new Error("development_protocol_required");
  if (!Array.isArray(protocol.cases) || protocol.cases.length < 2 || new Set(protocol.cases.map((c) => c.id)).size !== protocol.cases.length) throw new Error("invalid_case_denominator");
  if (!protocol.cases.every((c) => typeof c.id === "string" && /^[a-z-]+$/.test(c.id) && [0, 3, 5].includes(c.expectedExit))) throw new Error("invalid_case");
}

export function runTransferDevelopment({ protocolPath, baselinePath, candidatePath, outputDir }) {
  const bytes = readFileSync(protocolPath);
  const protocol = JSON.parse(bytes);
  validateProtocol(protocol);
  const freeze = {
    schema: "harness2.transfer-development.freeze.v1",
    protocolSha256: sha256(bytes), baselineSha256: sha256(readFileSync(baselinePath)), candidateSha256: sha256(readFileSync(candidatePath)),
    runnerSha256: sha256(readFileSync(new URL(import.meta.url))),
    planned: protocol.cases.length * protocol.repeats * 2,
    paidCalls: 0, holdoutInputsRead: 0,
    network: "Every CLI process executes under macOS sandbox-exec with (deny network*); fetch is replaced with a fixed local fixture",
  };
  mkdirSync(outputDir, { mode: 0o700 });
  const save = (name, value) => writeFileSync(path.join(outputDir, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
  save("frozen.json", freeze);
  const root = mkdtempSync(path.join(os.tmpdir(), "jjo664-transfer-"));
  const rows = [];
  try {
    const preload = path.join(root, "preload.mjs");
    writeFileSync(preload, PRELOAD);
    const env = { PATH: process.env.PATH, HOME: root, TMPDIR: root, LANG: "en_US.UTF-8", TZ: "UTC", OPENGATEWAY_API_KEY: "offline-fixture-not-a-real-key" };
    const profile = "(version 1) (allow default) (deny network*)";
    // Same observer must work unsandboxed and fail with EPERM inside the sandbox.
    const probe = "import net from 'node:net';const s=net.createServer();s.on('error',e=>{console.log(e.code);process.exit(e.code==='EPERM'?0:1)});s.listen(0,'127.0.0.1',()=>{console.log('ALLOWED');s.close(()=>process.exit(0))});setTimeout(()=>process.exit(2),1500);";
    const control = spawnSync(process.execPath, ["--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 3000 });
    if (control.status !== 0 || control.stdout.trim() !== "ALLOWED") throw new Error("network_observer_unavailable");
    const denied = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--input-type=module", "-e", probe], { env, encoding: "utf8", timeout: 3000 });
    if (denied.status !== 0 || denied.stdout.trim() !== "EPERM") throw new Error("network_denial_not_proven");
    save("network-denial.json", { control: { code: control.status, observed: control.stdout.trim() }, code: denied.status, observed: denied.stdout.trim(), profile, scope: "fixture network isolation, not a new native pilot profile" });
    for (const [variant, cli] of [["baseline", baselinePath], ["candidate", candidatePath]]) {
      for (let repeat = 1; repeat <= protocol.repeats; repeat += 1) {
        for (const example of protocol.cases) {
          const id = `${variant}-${repeat}-${example.id}`;
          const fixture = path.join(root, `${id}.json`);
          const calls = path.join(root, `${id}.calls`);
          writeFileSync(fixture, JSON.stringify(example));
          writeFileSync(calls, "");
          const result = spawnSync("/usr/bin/sandbox-exec", ["-p", profile, process.execPath, "--import", preload, path.resolve(cli), "--question", "Does the synthetic record satisfy the contract?", "--criteria", "yes,no", "--state", "development fixture only", "--json"], {
            cwd: root, env: { ...env, FIXTURE_PATH: fixture, CALLS_PATH: calls }, encoding: "utf8", timeout: 5000,
          });
          const intercepted = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).length;
          let decision = null;
          try { decision = JSON.parse(result.stdout).decision; } catch { /* invalid responses correctly produce no JSON */ }
          const row = { id, variant, repeat, caseId: example.id, expectedExit: example.expectedExit, observedExit: result.status, executionError: result.error?.code ?? null, intercepted, decision, stdoutDigest: sha256(result.stdout ?? ""), stderr: (result.stderr ?? "").trim(), passed: !result.error && result.status === example.expectedExit && intercepted === 1 };
          rows.push(row);
          writeFileSync(path.join(outputDir, "executions.jsonl"), JSON.stringify(row) + "\n", { flag: "a" });
        }
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
  const summary = Object.fromEntries(["baseline", "candidate"].map((variant) => {
    const selected = rows.filter((row) => row.variant === variant);
    return [variant, { planned: protocol.cases.length * protocol.repeats, executed: selected.length, passed: selected.filter((r) => r.passed).length, failed: selected.filter((r) => !r.passed).length, invalidAccepted: selected.filter((r) => r.expectedExit === 5 && r.observedExit === 0).length }];
  }));
  const validRegressions = rows.filter((row) => row.variant === "candidate" && row.expectedExit !== 5 && !row.passed).length;
  const report = { schema: "harness2.transfer-development.result.v1", scope: protocol.scope, protocolSha256: freeze.protocolSha256, summary, validRegressions, allExecuted: rows.length === freeze.planned, candidatePass: summary.candidate.failed === 0 && validRegressions === 0 && rows.length === freeze.planned, paidCalls: 0, incrementalUsd: 0, priorConservativeUsd: protocol.cost.priorConservativeUsd, afterConservativeUsd: protocol.cost.priorConservativeUsd, holdoutInputsRead: 0, limitations: ["Synthetic fixture responses; no new model output, provider billing, statistical efficacy or deployed acceptance measured", "Candidate source is a local patch proposal, not canonical agent-config integration", "Repeated identical deterministic cases test repeatability, not independent samples"] };
  save("report.json", report);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 6) throw new Error("usage: run-transfer-development.mjs PROTOCOL BASELINE_CLI CANDIDATE_CLI NEW_OUTPUT_DIR");
  const report = runTransferDevelopment({ protocolPath: process.argv[2], baselinePath: process.argv[3], candidatePath: process.argv[4], outputDir: process.argv[5] });
  console.log(JSON.stringify(report));
  process.exitCode = report.candidatePass ? 0 : 1;
}
