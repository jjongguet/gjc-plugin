import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createLinearClient, loadProjectMap } from './linear.mjs';
import { scanProject, planReconciliation, applyReconciliation, currentAuthorityReason, semanticAction, proposalHash, validateSupervision } from './reconciliation.mjs';
import { decideCandidate } from './decisions.mjs';
import { immutableJson, digest } from './state.mjs';
const exec = promisify(execFile);

async function verifyAuthority(authority) {
  if (currentAuthorityReason(authority)) return false;
  if (!authority.file || !authority.quote || !authority.behaviorReceipt) return false;
  const match = /^https:\/\/github\.com\/jjongguet\/([A-Za-z0-9_-]+?)(?:\.git)?$/.exec(authority.remote);
  if (!match || !/^[A-Za-z0-9_/-]+$/.test(authority.branch) || authority.file.includes('..') || !/^[A-Za-z0-9_./-]+$/.test(authority.file)) return false;
  const { stdout } = await exec('git', ['ls-remote', authority.remote, `refs/heads/${authority.branch}`], { timeout: 30000 });
  if (stdout.split(/\s/)[0] !== authority.head) return false;
  const { stdout: code } = await exec('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `/repos/jjongguet/${match[1]}/contents/${authority.file}?ref=${authority.head}`], { timeout: 30000, maxBuffer: 4000000 });
  if (!code.includes(authority.quote)) return false;
  const raw = await readFile(authority.behaviorReceipt);
  if (digest(raw) !== authority.evidenceDigest) return false;
  const receipt = JSON.parse(raw);
  return receipt.head === authority.head && receipt.exitCode === 0 && receipt.command === authority.behaviorCommand && receipt.observedAt === authority.observedAt;
}

export async function reviewCandidates({ snapshot, candidates, supervision, allowedProjects, verify = verifyAuthority, decide = decideCandidate, clock = Date.now }) {
  for (const candidate of candidates) {
    delete candidate.decision;
    const action = semanticAction({ snapshot, candidate, allowedProjects, at: clock() });
    if (action.type === 'deferred') { candidate.decision = { adopted: false, choice: 'abstain', confidence: 0, reason: action.reason }; continue; }
    const hash = proposalHash(action);
    validateSupervision(supervision, { at: clock(), issueId: action.issueId, action: action.type, project: action.project, proposalHash: hash });
    if (!await verify(action.authority)) { candidate.decision = { adopted: false, choice: 'abstain', confidence: 0, reason: 'current_authority_unverified' }; continue; }
    const decision = await decide({ candidate: { eligible: true, mode: 'supervised', action: action.type, evidence: { proposal: action, remainingWork: candidate.remainingWork, sameCauseVerified: candidate.sameCauseVerified } }, supervision, budget: supervision.budget });
    if (supervision.budget) supervision.budget.spentUsd += decision.costUpperUsd;
    validateSupervision(supervision, { at: clock(), issueId: action.issueId, action: action.type, project: action.project, proposalHash: hash });
    candidate.decision = { ...decision, proposalHash: hash };
  }
  return candidates;
}

export async function executeReconcile(options) {
  if (!options.snapshot) throw new Error('reconcile requires --snapshot PATH');
  const input = JSON.parse(await readFile(options.snapshot, 'utf8'));
  const projectMap = await loadProjectMap();
  if (!Object.values(projectMap).includes(input.project)) throw new Error('project not allowlisted');
  const out = options.out;
  if ((options.scan || options.publish) && !out) throw new Error('--out required for immutable reconciliation evidence');
  const candidates = structuredClone(input.candidates ?? []);
  let supervision;
  if (options.publish) {
    if (!options.supervision) throw new Error('reconcile publish requires --supervision PATH');
    supervision = JSON.parse(await readFile(options.supervision, 'utf8'));
  }
  const client = createLinearClient({ projectMap, publish: options.publish === true, ...(options.linearCli ? { cli: options.linearCli } : {}) });
  const snapshot = options.scan || options.publish ? await scanProject({ client, project: input.project }) : input.snapshot;
  if (!snapshot || snapshot.project !== input.project) throw new Error('snapshot project mismatch');
  if (options.publish) {
    await reviewCandidates({ snapshot, candidates, supervision, allowedProjects: Object.values(projectMap) });
  } else {
    // An offline proposal never trusts an imported model label as permission.
    for (const candidate of candidates) candidate.decision = { adopted: false, choice: 'abstain', confidence: 0 };
  }
  const proposals = candidates.map((candidate) => semanticAction({ snapshot, candidate, allowedProjects: Object.values(projectMap) }));
  const actions = planReconciliation({ snapshot, candidates, maxActions: options.maxIssues ?? 20, allowedProjects: Object.values(projectMap) });
  const requestedScopes = [...proposals, ...actions].filter((a) => a.type !== 'deferred').map((a) => ({ issueId: a.issueId, type: a.type, project: a.project, proposalHash: proposalHash(a) }));
  const run = { version: 1, command: 'reconcile', status: 'planned', snapshot, candidates, proposals, requestedScopes, actions, sourceHash: digest(await readFile(options.snapshot)), at: new Date().toISOString() };
  const runDir = out ? path.join(out, 'reconciliations', `${Date.now()}`) : null;
  if (runDir) await immutableJson(path.join(runDir, 'plan.json'), run);
  if (options.publish) {
    const result = await applyReconciliation({ actions, client, dir: out, supervision, verifyAuthority });
    await immutableJson(path.join(runDir, 'result.json'), { version: 1, result, costUpperUsd: candidates.reduce((n, c) => n + (c.decision?.costUpperUsd ?? 0), 0) });
    process.stdout.write(`${JSON.stringify({ runDir, result }, null, 2)}\n`);
    return result.some((r) => r.phase === 'unknown' || r.type === 'deferred' || r.phase === 'deferred') ? 1 : 0;
  }
  process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
  return snapshot.complete ? 0 : 1;
}
