import { digest, jsonBytes, withLock, assertOwner, journalEvent, operationState } from './state.mjs';

export const POLICY = 'nightly-reconciliation-v1';
const DAY = 86400000;
const stamp = (x) => typeof x === 'string' && /(?:Z|[+-]\d\d:\d\d)$/.test(x) && Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
export const snapshotHash = (issue) => digest(jsonBytes(issue));
const labelNames = (issue) => (issue.labels ?? []).map((v) => typeof v === 'string' ? v : v.name);
const projectId = (issue) => issue.projectId ?? issue.project?.id ?? issue.project;

// A full bounded page must carry explicit termination/cursor information. Missing
// paging metadata cannot establish absence and therefore cannot authorize writes.
export async function boundedPages({ fetchPage, field, pageSize = 100, cap = 1000, deadlineAt = Date.now() + 600000, now = Date.now }) {
  const items = []; const seen = new Set(); const cursors = new Set(); let cursor;
  while (items.length < cap && now() < deadlineAt) {
    const data = await fetchPage({ cursor, limit: Math.min(pageSize, cap - items.length) });
    const list = Array.isArray(data) ? data : data?.[field];
    if (!Array.isArray(list)) return { items, complete: false, reason: 'malformed_page' };
    for (const item of list) {
      if (!item?.id || seen.has(item.id)) return { items, complete: false, reason: 'duplicate_or_missing_id' };
      seen.add(item.id); items.push(item);
    }
    if (items.length > cap) return { items: items.slice(0, cap), complete: false, reason: 'over_cap' };
    if (data.hasNextPage === false || (Array.isArray(data) && list.length < pageSize)) return { items, complete: true, reason: null };
    if (data.hasNextPage !== true) return { items, complete: false, reason: 'missing_page_metadata' };
    cursor = data.cursor ?? data.endCursor;
    if (!cursor || cursors.has(cursor)) return { items, complete: false, reason: 'invalid_cursor' };
    cursors.add(cursor);
  }
  return { items, complete: false, reason: 'inventory_limit' };
}

export async function scanProject({ client, project, now = Date.now, maxIssues = 1000 }) {
  const observedAt = new Date(now()).toISOString();
  const deadlineAt = now() + 600000;
  const inventory = await boundedPages({ field: 'issues', fetchPage: (args) => client.listIssues({ project, ...args }), cap: Math.min(maxIssues, 1000), deadlineAt, now });
  const issues = [];
  for (const item of inventory.items) {
    if (now() >= deadlineAt) { inventory.complete = false; inventory.reason = 'deadline'; break; }
    const issue = await client.getIssue(item.id);
    const comments = await boundedPages({ field: 'comments', fetchPage: (args) => client.listComments({ issueId: item.id, ...args }), pageSize: 50, cap: 100, deadlineAt, now });
    issues.push({ ...issue, comments });
  }
  const complete = inventory.complete && issues.length === inventory.items.length && issues.every((i) => i.comments.complete);
  return { version: 1, policy: POLICY, project, observedAt, complete, reason: complete ? null : inventory.reason ?? 'incomplete_comments', issues };
}

export function protectionReason(issue, at = Date.now()) {
  const updated = stamp(issue.updatedAt);
  if (!Number.isFinite(updated) || updated > at) return 'unknown_or_future_timestamp';
  if (issue.liveOwner === true || issue.assignee || issue.assigneeId || ['started', 'unstarted'].includes(issue.statusType)) return 'active_owner_or_triaged';
  if (!issue.comments?.complete) return 'incomplete_comments';
  for (const comment of issue.comments.items) {
    const created = stamp(comment.createdAt);
    if (!Number.isFinite(created) || created > at) return 'unknown_comment_timestamp';
    if (at - created <= DAY && /실행 연결|GJC-TRACE:|execution link|session[- :]/i.test(comment.body ?? '')) return 'recent_execution';
  }
  // Any recent human edit is conservatively protected, including exactly 24h.
  if (at - updated <= DAY) return 'recent_update';
  return null;
}

export function currentAuthorityReason(authority, at = Date.now()) {
  if (!authority || !/^https:\/\/github\.com\/jjongguet\/[A-Za-z0-9_-]+(?:\.git)?$/.test(authority.remote ?? '') || !authority.branch || !/^[a-f0-9]{40}$/.test(authority.head ?? '') || !Number.isFinite(stamp(authority.observedAt)) || at - stamp(authority.observedAt) > 300000 || at < stamp(authority.observedAt)) return 'stale_or_unknown_authority';
  if (authority.verifiedHead !== authority.head || authority.notReverted !== true || authority.behaviorVerified !== true || !authority.evidenceDigest || !authority.behaviorCommand) return 'current_behavior_unverified';
  return null;
}

export function planReconciliation({ snapshot, candidates = [], at = Date.now(), maxActions = 20 }) {
  if (!snapshot?.complete || !Array.isArray(snapshot.issues)) return [{ type: 'deferred', reason: 'incomplete_inventory' }];
  const actions = [];
  const batches = snapshot.issues.filter((i) => /^\[nightly 배치\]/.test(i.title ?? '') && !['completed', 'canceled'].includes(i.statusType));
  const base = (issue) => ({ issueId: issue.id, expectedHash: snapshotHash(issue), before: structuredClone(issue), policy: POLICY, project: snapshot.project });
  for (const issue of snapshot.issues) {
    const protectedReason = protectionReason(issue, at);
    if (protectedReason) { actions.push({ ...base(issue), type: 'deferred', reason: protectedReason }); continue; }
    if (['completed', 'canceled'].includes(issue.statusType)) continue;
    const candidate = candidates.find((c) => c.issueId === issue.id);
    const nightly = labelNames(issue).includes('nightly');
    const backlog = issue.statusType === 'backlog' || issue.status === 'Backlog';
    const parent = issue.parentId ?? issue.parent?.id;
    const created = stamp(issue.filedAt ?? issue.createdAt);
    const priority = typeof issue.priority === 'object' ? issue.priority?.value : issue.priority;
    if (nightly && backlog && !issue.triaged && !issue.triagedAt && (!priority || priority === 4) && issue.comments.items.length === 0 && batches.length === 1 && parent === batches[0].id && Number.isFinite(created) && at - created > 14 * DAY) {
      actions.push({ ...base(issue), type: 'expire', reason: 'untriaged_policy_expiry', delta: { state: 'Canceled' }, evidence: '정책 만료: 14일 초과 미트리아지; 결함 수정/오탐 판정 아님' });
      continue;
    }
    if (candidate) {
      const reason = currentAuthorityReason(candidate.authority, at);
      if (reason || candidate.decision?.adopted !== true || candidate.decision.choice !== 'consistent' || candidate.decision.confidence < 0.6 || !['done', 'invalid', 'correct', 'move', 'duplicate'].includes(candidate.type)) {
        actions.push({ ...base(issue), type: 'deferred', reason: reason ?? 'semantic_abstention' }); continue;
      }
      if (!candidate.evidence || !candidate.sourceLinks?.length || !candidate.exactDelta) { actions.push({ ...base(issue), type: 'deferred', reason: 'missing_exact_evidence' }); continue; }
      let delta;
      if (candidate.type === 'done' && candidate.remainingWork === false) delta = { state: 'Done' };
      if (candidate.type === 'invalid') delta = { state: 'Canceled' };
      if (candidate.type === 'correct' && typeof candidate.exactDelta.correction === 'string') delta = { description: `${issue.description ?? ''}\n\n## Current correction (${POLICY})\n${candidate.exactDelta.correction}` };
      if (candidate.type === 'move' && candidate.targetAllowed === true && candidate.exactDelta.project) delta = { project: candidate.exactDelta.project };
      if (candidate.type === 'duplicate' && candidate.sameCauseVerified === true && candidate.duplicateId) delta = { state: 'Duplicate', duplicateOf: candidate.duplicateId };
      if (!delta) { actions.push({ ...base(issue), type: 'deferred', reason: 'unverified_delta' }); continue; }
      actions.push({ ...base(issue), type: candidate.type, delta, authority: candidate.authority, reason: candidate.type, evidence: candidate.evidence, sourceLinks: candidate.sourceLinks });
    } else if (nightly && backlog && issue.comments.items.length === 0 && !parent && batches.length === 1) {
      actions.push({ ...base(issue), type: 'parent', delta: { parentId: batches[0].id }, reason: 'unique_nightly_batch' });
    }
  }
  let count = 0;
  return actions.map((a) => a.type === 'deferred' || ++count <= maxActions ? a : { ...a, type: 'deferred', reason: 'over_action_cap' });
}

export function validateSupervision(scope, { at = Date.now(), issueId, action, project } = {}) {
  if (!scope || scope.active !== true || scope.operationalExclusion !== true || typeof scope.supervisor !== 'string' || !scope.supervisor || !(stamp(scope.expiresAt) > at) || stamp(scope.expiresAt) - at > 3600000 || !Array.isArray(scope.actions) || !scope.actions.some((a) => a.issueId === issueId && a.type === action && a.project === project)) throw new Error('missing scoped supervision or operational exclusion');
}

function actionId(action, generation) {
  return digest(jsonBytes({ issueId: action.issueId, type: action.type, delta: action.delta, expectedHash: action.expectedHash, policy: POLICY, generation }));
}

async function freshIssue(client, id) {
  const issue = await client.getIssue(id);
  const comments = await boundedPages({ field: 'comments', fetchPage: (args) => client.listComments({ issueId: id, ...args }), pageSize: 50, cap: 100 });
  return { ...issue, comments };
}

function matchesDelta(issue, delta) {
  return Object.entries(delta).every(([key, value]) => {
    if (key === 'state') return issue.status === value || issue.state?.name === value;
    if (key === 'project') return projectId(issue) === value || issue.project === value;
    if (key === 'parentId') return (issue.parentId ?? issue.parent?.id) === value;
    if (key === 'duplicateOf') return (issue.duplicateOf?.id ?? issue.duplicateOf) === value;
    return issue[key] === value;
  });
}

// The single supervisor supplies the exact action set and confirms operational
// exclusion. Fresh reads detect, but do not atomically exclude, human edits.
export async function applyReconciliation({ actions, client, dir, supervision, verifyAuthority, clock = Date.now }) {
  return withLock(dir, async () => {
    const owner = await assertOwner(dir);
    const results = [];
    for (const action of actions) {
      if (action.type === 'deferred') { results.push(action); continue; }
      if (results.filter((r) => r.phase === 'confirmed').length >= 20) { results.push({ issueId: action.issueId, phase: 'deferred', reason: 'over_cap' }); break; }
      validateSupervision(supervision, { at: clock(), issueId: action.issueId, action: action.type, project: action.project });
      await assertOwner(dir, { generation: owner.generation });
      const id = actionId(action, owner.generation);
      const marker = `<!-- nightly-operation:${id} -->`;
      const existing = await operationState(dir, id);
      if (existing.confirmed) { results.push({ id, issueId: action.issueId, phase: 'confirmed', adopted: true }); continue; }
      let current = await freshIssue(client, action.issueId);
      if (existing.attempted) {
        // Never reissue an unknown mutation. Adoption requires exact remote state.
        const found = current.comments.complete && current.comments.items.filter((c) => c.body?.includes(marker)).length === 1;
        if (found && matchesDelta(current, action.delta)) {
          await journalEvent(dir, { id, phase: 'confirmed', issueId: action.issueId, adopted: true, after: current });
          results.push({ id, phase: 'confirmed', adopted: true }); continue;
        }
        results.push({ id, phase: 'deferred', reason: 'unknown_result_quarantine' }); continue;
      }
      if (snapshotHash(current) !== action.expectedHash || protectionReason(current, clock())) { results.push({ id, phase: 'deferred', reason: 'concurrent_or_protected' }); continue; }
      if (action.authority && (!verifyAuthority || !await verifyAuthority(action.authority) || currentAuthorityReason(action.authority, clock()))) { results.push({ id, phase: 'deferred', reason: 'authority_changed' }); continue; }
      if (!existing.planned) await journalEvent(dir, { id, phase: 'planned', action });
      await journalEvent(dir, { id, phase: 'attempted', issueId: action.issueId });
      try {
        const body = `${action.evidence ?? action.reason}\n${(action.sourceLinks ?? []).join('\n')}\nPolicy: ${POLICY}\n${marker}`;
        await client.createComment({ issueId: action.issueId, body });
        const afterComment = await freshIssue(client, action.issueId);
        const newComments = afterComment.comments.items.filter((c) => !current.comments.items.some((before) => before.id === c.id));
        // updatedAt may change because of our comment; all other content must stay.
        const normalized = { ...afterComment, updatedAt: current.updatedAt, comments: current.comments };
        if (!afterComment.comments.complete || newComments.length !== 1 || !newComments[0].body?.includes(marker) || snapshotHash(normalized) !== action.expectedHash) throw new Error('concurrent content after evidence comment');
        validateSupervision(supervision, { at: clock(), issueId: action.issueId, action: action.type, project: action.project });
        await assertOwner(dir, { generation: owner.generation });
        if (action.authority && !await verifyAuthority(action.authority)) throw new Error('authority changed before mutation');
        await client.updateIssue({ id: action.issueId, ...action.delta });
        const after = await freshIssue(client, action.issueId);
        if (!after.comments.complete || !matchesDelta(after, action.delta) || after.comments.items.filter((c) => c.body?.includes(marker)).length !== 1 || (action.delta.description === undefined && after.description !== current.description)) throw new Error('readback mismatch');
        await journalEvent(dir, { id, phase: 'confirmed', issueId: action.issueId, after });
        results.push({ id, issueId: action.issueId, phase: 'confirmed', reason: action.reason });
      } catch (error) {
        await journalEvent(dir, { id, phase: 'unknown', issueId: action.issueId, reason: /429|rate limit/i.test(error.message) ? 'aside_required' : 'remote_result_requires_reconciliation' });
        results.push({ id, issueId: action.issueId, phase: 'unknown' });
        break; // No follow-on mutation after an error.
      }
    }
    return results;
  });
}
