#!/usr/bin/env node
// Explicit supervised evaluation only. No Linear imports or mutation client.
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { decideCandidate } from '../lib/decisions.mjs';
import { immutableJson, digest, privateDirectory } from '../lib/state.mjs';

const [supervisionPath, outputArg] = process.argv.slice(2);
if (!supervisionPath || !outputArg || process.argv.length !== 4) throw new Error('usage: evaluate-decisions.mjs SUPERVISION_JSON OUTPUT_JSON');
const output = path.resolve(outputArg);
const supervision = JSON.parse(await readFile(supervisionPath, 'utf8'));
const fixtureBytes = await readFile(new URL('../tests/fixtures/reconciliation-golden.json', import.meta.url));
const golden = JSON.parse(fixtureBytes);
const modelBytes = await readFile(new URL('../lib/decisions.mjs', import.meta.url));
if (supervision.active !== true || !supervision.supervisor || Date.parse(supervision.expiresAt) <= Date.now() || Date.parse(supervision.expiresAt) - Date.now() > 3600000) throw new Error('active short-lived supervisor required');
const budget = structuredClone(supervision.budget);
if (!budget || budget.capUsd > 5 || !Number.isFinite(budget.spentUsd) || !Number.isFinite(budget.reservedUsd) || !Number.isFinite(budget.nextUpperUsd)) throw new Error('task budget required');
// Reserve worst-case 2*32k tokens at the higher fixed-list price for all cases,
// including errors, before starting. This does not assume discounts or abstention.
const totalUpperUsd = golden.cases.length * 3 * 2 * 32000 * 0.126 / 1000000;
if (budget.spentUsd + budget.reservedUsd + totalUpperUsd > budget.capUsd || budget.nextUpperUsd < 2 * 32000 * 0.126 / 1000000) throw new Error('evaluation exceeds task budget');

function eligible(entry) {
  const e = entry.evidence;
  if (entry.action === 'mark_complete') return e.inventoryComplete === true && !!e.currentRevision && e.currentRevision === e.verifiedRevision && !!e.authority;
  if (entry.action === 'policy_expire_canceled') return e.issueAgeMs > 14 * 86400000 && e.nightly === true && e.status === 'Backlog' && e.uniqueBatchChild === true && !e.triaged && e.commentCount === 0 && e.inventoryComplete === true && e.activeWork === false && e.supervisedExactAction === true;
  return false;
}

const results = [];
const startedAt = new Date().toISOString();
// Reserve the destination and the full possible cost durably before any call.
// A crash cannot make an uncertain paid attempt look like a fresh zero-cost run.
await privateDirectory(path.dirname(output));
const samples = `${output}.samples`;
const reservation = `${output}.reservation.json`;
for (const file of [output, samples, reservation]) {
  try { await lstat(file); throw new Error('evaluation output already exists; reconcile prior cost before retry'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
await privateDirectory(samples);
await immutableJson(reservation, { version: 1, kind: 'evaluation-cost-reservation', startedAt, totalReservedUpperUsd: totalUpperUsd, priorSpentUsd: budget.spentUsd, priorReservedUsd: budget.reservedUsd, fixtureHash: digest(fixtureBytes), implementationHash: digest(modelBytes) });
for (let repetition = 0; repetition < 3; repetition++) {
  for (const entry of golden.cases) {
    // Raw semantic evaluation intentionally measures also unsafe proposals, but
    // has no writer; the separate final-policy gate keeps them ineligible.
    const raw = await decideCandidate({ candidate: { eligible: true, mode: 'supervised', action: entry.action, evidence: entry.evidence }, supervision, budget });
    budget.spentUsd += raw.costUpperUsd;
    const baselineAllows = eligible(entry);
    const finalAllows = baselineAllows && raw.adopted && raw.choice === 'consistent';
    const result = { caseId: entry.id, repetition, expectedChoice: entry.expected.choice, rawChoice: raw.choice, rawCorrect: raw.choice === entry.expected.choice, rawAdopted: raw.adopted, baselineAllows, finalAllows, expectedAllows: ['propose_completion_for_supervised_approval', 'policy_expiry_canceled_only'].includes(entry.expected.allowedAction), audit: raw.audit, costUpperUsd: raw.costUpperUsd };
    await immutableJson(path.join(samples, `${results.length}.json`), result);
    results.push(result);
  }
}
const receipt = { version: 1, kind: 'supervised-decision-evaluation', promptVersion: 1, fixtureHash: digest(fixtureBytes), implementationHash: digest(modelBytes), startedAt, finishedAt: new Date().toISOString(), repetitions: 3, results, summary: { samples: results.length, rawCorrect: results.filter((r) => r.rawCorrect).length, rawAbstentions: results.filter((r) => r.rawChoice === 'abstain').length, baselineCorrect: results.filter((r) => r.baselineAllows === r.expectedAllows).length, finalCorrect: results.filter((r) => r.finalAllows === r.expectedAllows).length, falseFinalAllows: results.filter((r) => r.finalAllows && !r.expectedAllows).length }, costUpperUsd: results.reduce((n, r) => n + r.costUpperUsd, 0), totalReservedUpperUsd: totalUpperUsd, limitations: 'Synthetic golden; baseline deterministic gating versus initial typed pipeline, not a measured improvement over a prior model prompt. Cost is a conservative upper bound, not billing.' };
await immutableJson(output, receipt);
console.log(JSON.stringify({ output, summary: receipt.summary, costUpperUsd: receipt.costUpperUsd }));
