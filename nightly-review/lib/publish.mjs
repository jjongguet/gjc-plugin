// Filing uses complete project inventory rather than treating the local ledger as
// proof of remote absence. Operations with an unknown result are never retried.
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { clusterFindings, planFiling, evidenceHash, issueTitle, renderIssueBody, renderEvidenceComment, priorityFor, hasClusterMarker } from './filing.mjs';
import { scanProject, protectionReason, snapshotHash, validateSupervision, boundedPages } from './reconciliation.mjs';
import { withLock, assertOwner, readOptional, validateLedger, atomicWrite, jsonBytes, digest, journalEvent, operationState, unresolvedOperations } from './state.mjs';

const isTerminal = (i) => ['completed', 'canceled'].includes(i.statusType);
const isActiveBatch = (i) => /^\[nightly 배치\]/.test(i.title ?? '') && !isTerminal(i) && !i.archivedAt;
const occurrences = (text, marker) => (text ?? '').split(marker).length - 1;
const labelNames = (issue) => (issue.labels ?? []).map((l) => typeof l === 'string' ? l : l.name);
const projectOf = (issue) => issue.projectId ?? issue.project;
const operationId = ({ key, evidence, generation, type }) => digest(jsonBytes({ key, evidence: [...evidence].sort(), generation, type }));

// Linear normalizes stored markdown (`-` bullets become `*`, identifiers become
// links), so a created body cannot be compared byte-for-byte. Ownership is the
// exact single operation marker (a hex hash over cluster, evidence, generation and
// type, which Linear does not rewrite) plus title, nightly label, parent and project.
function ownsCreatedIssue(remote, { cluster, opMarker, parent }) {
  return occurrences(remote.description, opMarker) === 1 &&
    remote.title === issueTitle(cluster) && labelNames(remote).includes('nightly') && !remote.archivedAt &&
    (remote.parentId ?? remote.parent?.id) === parent.id && projectOf(remote) === projectOf(parent);
}

function entryFor({ next, cluster, confirmedId, remote, fresh, runId, clock }) {
  const prior = next.clusters[cluster.key];
  return { ...(prior ?? {}), issue: { id: confirmedId ?? remote.uuid ?? remote.id, identifier: remote.identifier ?? null, url: remote.url ?? prior?.issue.url ?? null }, evidence: [...new Set([...(prior?.evidence ?? []), ...fresh.map(evidenceHash)])], filedAt: prior?.filedAt ?? new Date(clock()).toISOString(), lastRun: runId };
}

// No remote write: an attempted operation whose id this run recomputes exactly
// (same cluster, evidence, generation and type) is confirmed only from its unique
// remote marker in a complete inventory. Anything else stays quarantined.
async function adoptUnknownOperations({ unresolved, clusters, next, client, dir, owner, runId, clock, commit }) {
  const adopted = [];
  const pending = new Set(unresolved);
  for (const cluster of clusters) {
    const fresh = cluster.findings.filter((f) => !(next.clusters[cluster.key]?.evidence ?? []).includes(evidenceHash(f)));
    const evidence = fresh.map(evidenceHash);
    for (const type of ['create', 'comment']) {
      const id = operationId({ key: cluster.key, evidence, generation: owner.generation, type });
      if (!pending.has(id)) continue;
      const project = client.projectFor(cluster.repo);
      if (!project) continue;
      const snapshot = await scanProject({ client, project, maxIssues: 1000, now: clock });
      if (!snapshot.complete) continue;
      const opMarker = `<!-- nightly-operation:${id} -->`;
      const confirmedId = next.clusters[cluster.key]?.issue.id;
      let remote = null;
      if (type === 'create') {
        const owned = snapshot.issues.filter((i) => occurrences(i.description, opMarker) > 0);
        const parent = owned.length === 1 ? snapshot.issues.find((i) => i.id === (owned[0].parentId ?? owned[0].parent?.id)) : null;
        if (owned.length === 1 && parent && /^\[nightly 배치\]/.test(parent.title ?? '') && ownsCreatedIssue(owned[0], { cluster, opMarker, parent })) remote = owned[0];
      } else {
        // A confirmed ledger identity binds the target; only without one does the
        // single cluster-marked issue qualify. The marked comment must be unique
        // across the whole inventory and sit on that target.
        const targets = confirmedId
          ? snapshot.issues.filter((i) => [i.id, i.uuid, i.identifier].includes(confirmedId))
          : snapshot.issues.filter((i) => hasClusterMarker(i.description, cluster.key));
        const marked = snapshot.issues.filter((i) => i.comments.items.some((c) => occurrences(c.body, opMarker) > 0));
        if (targets.length === 1 && marked.length === 1 && marked[0].id === targets[0].id && targets[0].comments.items.filter((c) => occurrences(c.body, opMarker) > 0).length === 1) remote = targets[0];
      }
      if (!remote) continue;
      await assertOwner(dir, { generation: owner.generation });
      const entry = entryFor({ next, cluster, confirmedId, remote, fresh, runId, clock });
      await journalEvent(dir, { id, phase: 'confirmed', entry, adopted: true });
      next.clusters[cluster.key] = entry;
      await commit();
      await journalEvent(dir, { id, phase: 'local_committed', adopted: true });
      pending.delete(id);
      adopted.push({ key: cluster.key, reason: 'adopted_confirmed_operation', operationId: id });
    }
  }
  return adopted;
}

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
    if (occurrences(after.description, marker) !== 1 || !isActiveBatch(after) || ![after.projectId, after.project, after.project?.name].includes(project) || !(after.labels ?? []).some((l) => (l.name ?? l) === 'nightly')) throw new Error('batch readback mismatch');
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
    const unresolved = await unresolvedOperations(dir);
    if (unresolved.length) {
      const commit = async () => { await atomicWrite(statePath, jsonBytes(next), { expectedHash }); expectedHash = digest(jsonBytes(next)); };
      result.skipped.push(...await adoptUnknownOperations({ unresolved, clusters, next, client, dir, owner, runId, clock, commit }));
      const remaining = await unresolvedOperations(dir);
      // Any operation that could not be confirmed from its marker blocks every new write.
      if (remaining.length) return { state: next, result: { ...result, errors: remaining.map((id) => ({ operationId: id, reason: 'unknown_remote_result_quarantine' })) } };
    }
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
      const matches = snapshot.issues.filter((i) => hasClusterMarker(i.description, cluster.key));
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
      const id = operationId({ key: cluster.key, evidence: fresh.map(evidenceHash), generation: owner.generation, type });
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
      if (!existing && currentSnapshot.issues.some((i) => hasClusterMarker(i.description, cluster.key))) { result.skipped.push({ key: cluster.key, reason: 'concurrent_create' }); continue; }
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
          if (!ownsCreatedIssue(remote, { cluster, opMarker, parent })) throw new Error('create readback mismatch');
        }
        const entry = entryFor({ next, cluster, confirmedId, remote, fresh, runId, clock });
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
