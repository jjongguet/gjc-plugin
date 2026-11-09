// Filing uses complete project inventory rather than treating the local ledger as
// proof of remote absence. Operations with an unknown result are never retried.
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { clusterFindings, planFiling, evidenceHash, issueTitle, renderIssueBody, renderEvidenceComment, priorityFor } from './filing.mjs';
import { scanProject, protectionReason, snapshotHash, validateSupervision, boundedPages } from './reconciliation.mjs';
import { withLock, assertOwner, readOptional, validateLedger, atomicWrite, jsonBytes, digest, journalEvent, operationState, unresolvedOperations } from './state.mjs';

const markerFor = (key) => `<!-- nightly-review:${key} -->`;
const isTerminal = (i) => ['completed', 'canceled'].includes(i.statusType);
const isActiveBatch = (i) => /^\[nightly 배치\]/.test(i.title ?? '') && !isTerminal(i) && !i.archivedAt;
export const filingIncomplete = (result) => result.errors.length > 0 || result.skipped.some((s) => !['up_to_date', 'adopted_confirmed_operation'].includes(s.reason));

async function createBatch({ client, project, dir, owner, supervision, clock, nightly }) {
  const issueId = `batch:${project}`;
  validateSupervision(supervision, { at: clock(), issueId, action: 'create-batch', project });
  const latest = await scanProject({ client, project, now: clock });
  if (!latest.complete || latest.issues.some(isActiveBatch)) throw new Error('batch inventory changed');
  const retired = latest.issues.filter((i) => /^\[nightly 배치\]/.test(i.title ?? '') && !isActiveBatch(i)).map((i) => i.id).sort();
  const id = digest(jsonBytes({ issueId, generation: owner.generation, ...(retired.length ? { retired } : {}) }));
  const marker = `<!-- nightly-operation:${id} -->`;
  const state = await operationState(dir, id);
  if (state.attempted) throw new Error('unknown batch creation quarantined');
  await assertOwner(dir, { generation: owner.generation });
  if (!state.planned) await journalEvent(dir, { id, phase: 'planned', issueId });
  await journalEvent(dir, { id, phase: 'attempted', issueId });
  try {
    const description = `Untriaged nightly findings. Findings are evidence, not verified defects.\n${marker}`;
    await assertOwner(dir, { generation: owner.generation });
    validateSupervision(supervision, { at: clock(), issueId, action: 'create-batch', project });
    const created = await client.createIssue({ title: `[nightly 배치] ${project}`, description, project, priority: 4, labels: [nightly.id] });
    const after = await client.getIssue(created.id);
    if (after.description !== description || !isActiveBatch(after) || ![after.projectId, after.project, after.project?.name].includes(project) || !(after.labels ?? []).some((l) => (l.name ?? l) === 'nightly')) throw new Error('batch readback mismatch');
    await journalEvent(dir, { id, phase: 'confirmed', issueId: after.id });
    return after;
  } catch (error) {
    await journalEvent(dir, { id, phase: 'unknown', issueId, reason: 'batch_requires_remote_reconciliation' });
    throw error;
  }
}

export async function publishFindings({ findings, client, dir, runId, supervision, maxIssues = 20, clock = Date.now }) {
  return withLock(dir, async () => {
    const owner = await assertOwner(dir);
    const unresolved = await unresolvedOperations(dir);
    if (unresolved.length) return { result: { created: [], commented: [], skipped: [], errors: unresolved.map((id) => ({ operationId: id, reason: 'unknown_remote_result_quarantine' })) } };
    const statePath = path.join(dir, 'filed.json');
    const original = await readOptional(statePath);
    const state = original === null ? { version: 1, clusters: {} } : validateLedger(JSON.parse(original));
    const next = structuredClone(state);
    let expectedHash = original === null ? null : digest(original);
    const result = { created: [], commented: [], skipped: [], errors: [] };
    let journals;
    try { journals = await readdir(path.join(dir, 'operations')); } catch (error) { if (error.code !== 'ENOENT') throw error; journals = []; }
    const operationIds = new Set();
    for (const name of journals) {
      const match = /^([a-f0-9]{64})-(planned|attempted|confirmed|unknown|local_committed)\.json$/.exec(name);
      if (!match) throw new Error('invalid operation journal filename');
      operationIds.add(match[1]);
    }
    for (const id of operationIds) {
      const operation = await operationState(dir, id);
      const entry = operation.confirmed?.entry;
      const key = operation.planned?.key;
      if (!entry || !key || operation.local_committed) continue;
      const prior = next.clusters[key];
      if (prior && prior.issue.id !== entry.issue.id) throw new Error('confirmed ledger identity conflict');
      next.clusters[key] = { ...entry, evidence: [...new Set([...(prior?.evidence ?? []), ...entry.evidence])] };
      await atomicWrite(statePath, jsonBytes(next), { expectedHash }); expectedHash = digest(jsonBytes(next));
      await journalEvent(dir, { id, phase: 'local_committed', recovered: true });
    }
    const snapshots = new Map(); let total = 0;
    const labels = await client.listLabels();
    const list = Array.isArray(labels) ? labels : labels.labels;
    const nightly = list?.filter((l) => l.name === 'nightly');
    if (nightly?.length !== 1 || (!Array.isArray(labels) && labels.hasNextPage !== false)) throw new Error('nightly label inventory incomplete or ambiguous');
    const clusters = clusterFindings(findings);
    const actions = planFiling({ clusters, state: next, maxIssues: Math.min(maxIssues, 20) });
    for (const action of actions) {
      const { cluster } = action;
      if (action.type === 'skip') { result.skipped.push({ key: cluster.key, reason: action.reason }); continue; }
      const project = client.projectFor(cluster.repo);
      if (!project) { result.skipped.push({ key: cluster.key, reason: 'no_project' }); continue; }
      if (!snapshots.has(project)) {
        if (total >= 5000) { result.skipped.push({ key: cluster.key, reason: 'run_inventory_cap' }); continue; }
        const snapshot = await scanProject({ client, project, maxIssues: Math.min(1000, 5000 - total), now: clock });
        total += snapshot.issues.length; snapshots.set(project, snapshot);
      }
      const snapshot = snapshots.get(project);
      if (!snapshot.complete) { result.skipped.push({ key: cluster.key, reason: 'incomplete_inventory' }); continue; }
      const confirmedId = next.clusters[cluster.key]?.issue.id;
      const confirmedMatches = confirmedId ? snapshot.issues.filter((i) => [i.id, i.uuid, i.identifier].includes(confirmedId)) : [];
      if (confirmedMatches.length > 1) { result.skipped.push({ key: cluster.key, reason: 'confirmed_identity_ambiguous' }); continue; }
      const confirmedIssue = confirmedMatches[0] ?? null;
      if (confirmedId && !confirmedIssue) { result.skipped.push({ key: cluster.key, reason: 'confirmed_identity_missing' }); continue; }
      const matches = snapshot.issues.filter((i) => (i.description ?? '').includes(markerFor(cluster.key)));
      if (matches.length > 1) { result.skipped.push({ key: cluster.key, reason: 'ambiguous_existing_issue' }); continue; }
      if (confirmedIssue && matches.some((i) => i.id !== confirmedIssue.id)) { result.skipped.push({ key: cluster.key, reason: 'confirmed_identity_conflict' }); continue; }
      const existing = confirmedIssue ?? matches[0] ?? null;
      if (existing && (isTerminal(existing) || protectionReason(existing, clock()))) { result.skipped.push({ key: cluster.key, reason: 'terminal_or_protected' }); continue; }
      // A location alone is not root-cause identity. Same file:line with a different
      // quote/kind is never closed as duplicate; an exact existing evidence marker
      // is the only remote adoption used here.
      const fresh = cluster.findings.filter((f) => !(next.clusters[cluster.key]?.evidence ?? []).includes(evidenceHash(f)));
      const type = existing ? 'comment' : 'create';
      validateSupervision(supervision, { at: clock(), issueId: cluster.key, action: type, project });
      await assertOwner(dir, { generation: owner.generation });
      const id = digest(jsonBytes({ key: cluster.key, evidence: fresh.map(evidenceHash).sort(), generation: owner.generation, type }));
      const opMarker = `<!-- nightly-operation:${id} -->`;
      const operation = await operationState(dir, id);
      if (operation.attempted && !operation.confirmed) {
        result.errors.push({ key: cluster.key, reason: 'unknown_remote_result_quarantine', operationId: id }); break;
      }
      if (operation.confirmed) {
        const entry = operation.confirmed.entry;
        if (entry) { next.clusters[cluster.key] = entry; await atomicWrite(statePath, jsonBytes(next), { expectedHash }); expectedHash = digest(jsonBytes(next)); }
        result.skipped.push({ key: cluster.key, reason: 'adopted_confirmed_operation' }); continue;
      }
      let parent;
      if (!existing) {
        const parents = snapshot.issues.filter(isActiveBatch);
        if (parents.length > 1) { result.skipped.push({ key: cluster.key, reason: 'ambiguous_batch' }); continue; }
        // The separate scope entry makes this extra mutation visible to the supervisor.
        parent = parents[0] ?? await createBatch({ client, project, dir, owner, supervision, clock, nightly: nightly[0] });
      }
      if (!operation.planned) await journalEvent(dir, { id, phase: 'planned', key: cluster.key, type, before: existing ?? null });
      // Re-enumerate immediately before create; the scoped supervisor coordinates
      // other writers. This is not a claim of server-side CAS/exactly-once.
      const currentSnapshot = await scanProject({ client, project, maxIssues: 1000, now: clock });
      if (!currentSnapshot.complete) { result.skipped.push({ key: cluster.key, reason: 'prewrite_inventory_incomplete' }); continue; }
      if (!existing && currentSnapshot.issues.some((i) => (i.description ?? '').includes(markerFor(cluster.key)))) { result.skipped.push({ key: cluster.key, reason: 'concurrent_create' }); continue; }
      if (existing) {
        const latest = currentSnapshot.issues.find((i) => i.id === existing.id);
        if (!latest || snapshotHash(latest) !== snapshotHash(existing) || protectionReason(latest, clock())) { result.skipped.push({ key: cluster.key, reason: 'concurrent_or_protected' }); continue; }
      } else if (currentSnapshot.issues.filter(isActiveBatch).length !== 1 || !currentSnapshot.issues.some((i) => i.id === parent.id && isActiveBatch(i) && (i.projectId ?? i.project) === (parent.projectId ?? parent.project))) {
        result.skipped.push({ key: cluster.key, reason: 'batch_changed' }); continue;
      }
      validateSupervision(supervision, { at: clock(), issueId: cluster.key, action: type, project });
      await journalEvent(dir, { id, phase: 'attempted', key: cluster.key, type });
      try {
        let remote;
        if (existing) {
          const body = `${renderEvidenceComment({ cluster, findings: fresh, runId })}\n${opMarker}`;
          await assertOwner(dir, { generation: owner.generation });
          validateSupervision(supervision, { at: clock(), issueId: cluster.key, action: type, project });
          await client.createComment({ issueId: existing.id, body });
          remote = await client.getIssue(existing.id);
          const comments = await boundedPages({ field: 'comments', fetchPage: (args) => client.listComments({ issueId: existing.id, ...args }), pageSize: 50, cap: 100 });
          if (!comments.complete || comments.items.filter((c) => c.body?.includes(opMarker)).length !== 1 || remote.description !== existing.description) throw new Error('comment readback mismatch');
        } else {
          const description = `${renderIssueBody({ cluster, runId })}\n${opMarker}`;
          await assertOwner(dir, { generation: owner.generation });
          validateSupervision(supervision, { at: clock(), issueId: cluster.key, action: type, project });
          const created = await client.createIssue({ title: issueTitle(cluster), description, project, priority: priorityFor(cluster.confidence), labels: [nightly[0].id], parentId: parent.id });
          if (!created.id) throw new Error('missing created id');
          remote = await client.getIssue(created.id);
          const names = (remote.labels ?? []).map((l) => typeof l === 'string' ? l : l.name);
          if (remote.description !== description || !names.includes('nightly') || (remote.parentId ?? remote.parent?.id) !== parent.id || (remote.projectId ?? remote.project) !== (parent.projectId ?? parent.project)) throw new Error('create readback mismatch');
        }
        const entry = { ...(next.clusters[cluster.key] ?? {}), issue: { id: confirmedId ?? remote.uuid ?? remote.id, identifier: remote.identifier ?? null, url: remote.url ?? next.clusters[cluster.key]?.issue.url ?? null }, evidence: [...new Set([...(next.clusters[cluster.key]?.evidence ?? []), ...fresh.map(evidenceHash)])], filedAt: next.clusters[cluster.key]?.filedAt ?? new Date(clock()).toISOString(), lastRun: runId };
        await journalEvent(dir, { id, phase: 'confirmed', entry });
        next.clusters[cluster.key] = entry;
        await atomicWrite(statePath, jsonBytes(next), { expectedHash }); expectedHash = digest(jsonBytes(next));
        await journalEvent(dir, { id, phase: 'local_committed' });
        result[existing ? 'commented' : 'created'].push({ key: cluster.key, issue: entry.issue });
        snapshots.delete(project);
      } catch (error) {
        await journalEvent(dir, { id, phase: 'unknown', key: cluster.key, reason: /429|rate limit/i.test(error.message) ? 'aside_required' : 'unconfirmed_remote_result' });
        result.errors.push({ key: cluster.key, error: 'unknown operation; reconcile remote marker before any retry', operationId: id });
        break;
      }
    }
    return { state: next, result };
  });
}
