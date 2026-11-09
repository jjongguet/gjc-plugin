import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { boundedPages, planReconciliation, protectionReason, currentAuthorityReason, snapshotHash, applyReconciliation } from '../lib/reconciliation.mjs';
import { immutableJson } from '../lib/state.mjs';

const at = Date.parse('2026-11-09T02:00:00Z');
const iso = (age) => new Date(at - age).toISOString();
const DAY = 86400000;
const issue = (overrides = {}) => ({ id: 'JJO-1', title: '[nightly] r f k', project: 'p', status: 'Backlog', statusType: 'backlog', description: 'original evidence', updatedAt: iso(2 * DAY), createdAt: iso(15 * DAY), labels: ['nightly'], parentId: 'JJO-2', comments: { items: [], complete: true, reason: null }, ...overrides });
const batch = { ...issue(), id: 'JJO-2', title: '[nightly 배치] p', parentId: null };
const snapshot = (value) => ({ complete: true, project: 'p', issues: [value, batch] });
const authority = () => ({ remote: 'https://github.com/jjongguet/r', branch: 'main', head: 'a'.repeat(40), verifiedHead: 'a'.repeat(40), observedAt: iso(1000), notReverted: true, behaviorVerified: true, evidenceDigest: 'b'.repeat(64), behaviorCommand: 'node --test focused.mjs' });

test('pagination rejects missing metadata, repeated cursor, duplicate ids and cap exhaustion', async () => {
  const missing = await boundedPages({ field: 'issues', fetchPage: async () => ({ issues: [{ id: 'a' }] }) });
  assert.equal(missing.complete, false);
  let calls = 0;
  const pages = await boundedPages({ field: 'issues', fetchPage: async () => ({ issues: [{ id: `${++calls}` }], hasNextPage: true, cursor: 'same' }) });
  assert.equal(pages.reason, 'invalid_cursor');
  assert.equal((await boundedPages({ field: 'issues', cap: 1, fetchPage: async () => ({ issues: [{ id: 'a' }], hasNextPage: true, cursor: 'next' }) })).complete, false);
  assert.equal((await boundedPages({ field: 'issues', fetchPage: async () => ({ issues: [{ id: 'a' }], hasNextPage: false }) })).complete, true);
});

test('24h and missing/future/comment coverage protection boundaries', () => {
  assert.equal(protectionReason(issue({ updatedAt: iso(DAY) }), at), 'recent_update');
  assert.equal(protectionReason(issue({ updatedAt: iso(DAY + 1) }), at), null);
  assert.equal(protectionReason(issue({ updatedAt: 'invalid' }), at), 'unknown_or_future_timestamp');
  assert.equal(protectionReason(issue({ updatedAt: iso(-1) }), at), 'unknown_or_future_timestamp');
  assert.equal(protectionReason(issue({ comments: { complete: false, items: [] } }), at), 'incomplete_comments');
  assert.equal(protectionReason(issue({ comments: { complete: true, items: [{ createdAt: iso(DAY), body: '실행 연결 | JJO-1' }] } }), at), 'recent_execution');
  assert.equal(protectionReason(issue({ assignee: 'human' }), at), 'active_owner_or_triaged');
});

test('expiry is only >14d nightly untriaged backlog with unique batch, never Done', () => {
  for (const [age, expected] of [[14 * DAY - 1, false], [14 * DAY, false], [14 * DAY + 1, true]]) {
    const actions = planReconciliation({ snapshot: snapshot(issue({ createdAt: iso(age) })), at });
    assert.equal(actions.some((a) => a.type === 'expire'), expected);
    assert.equal(actions.some((a) => a.delta?.state === 'Done'), false);
  }
  for (const overrides of [{ labels: [] }, { triaged: true }, { status: 'Todo', statusType: 'unstarted' }, { parentId: 'wrong' }, { comments: { complete: true, items: [{ id: 'c', createdAt: iso(3 * DAY), body: 'human triage' }] } }]) {
    assert.equal(planReconciliation({ snapshot: snapshot(issue(overrides)), at }).some((a) => a.type === 'expire'), false);
  }
  const multiple = snapshot(issue()); multiple.issues.push({ ...batch, id: 'other' });
  assert.equal(planReconciliation({ snapshot: multiple, at }).some((a) => a.type === 'expire'), false);
  assert.equal(planReconciliation({ snapshot: { complete: false }, at })[0].reason, 'incomplete_inventory');
});

test('historical merge, reverted fix and stale authority never authorize Done', () => {
  const base = issue({ labels: [] });
  const candidate = { issueId: base.id, type: 'done', decision: { adopted: true, choice: 'consistent', confidence: 0.9 }, evidence: 'current verification', sourceLinks: ['https://github.com/jjongguet/r/pull/1'], remainingWork: false, exactDelta: {}, authority: authority() };
  assert.equal(planReconciliation({ snapshot: snapshot(base), candidates: [candidate], at })[0].type, 'done');
  for (const auth of [undefined, { ...authority(), notReverted: false }, { ...authority(), observedAt: iso(300001) }, { ...authority(), verifiedHead: 'c'.repeat(40) }, { ...authority(), behaviorVerified: false }]) {
    assert.equal(planReconciliation({ snapshot: snapshot(base), candidates: [{ ...candidate, authority: auth }], at })[0].type, 'deferred');
  }
  assert.equal(currentAuthorityReason(authority(), at), null);
  assert.equal(planReconciliation({ snapshot: snapshot(base), candidates: [{ ...candidate, decision: { adopted: false } }], at })[0].reason, 'semantic_abstention');
});

async function setup({ lostResponse = false, edit = false } = {}) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nightly-writer-')));
  await immutableJson(path.join(dir, 'owner.json'), { version: 1, host: os.hostname(), generation: 1, enabled: true });
  const current = issue(); const comments = []; let mutations = 0;
  const client = {
    getIssue: async () => { const value = structuredClone(current); delete value.comments; return value; },
    listComments: async () => ({ comments: structuredClone(comments), hasNextPage: false }),
    createComment: async ({ body }) => { mutations++; comments.push({ id: 'comment', body, createdAt: new Date(at).toISOString() }); if (edit) current.description = 'concurrent edit'; if (lostResponse) throw new Error('timeout after server success'); },
    updateIssue: async ({ id, state, ...delta }) => { mutations++; if (state) { current.status = state; current.statusType = 'canceled'; } Object.assign(current, delta); },
  };
  const action = planReconciliation({ snapshot: snapshot(current), at })[0];
  const supervision = { active: true, operationalExclusion: true, supervisor: 'active-test-agent', expiresAt: new Date(at + 600000).toISOString(), actions: [{ issueId: 'JJO-1', type: action.type, project: 'p' }] };
  return { dir, client, current, comments, action, supervision, count: () => mutations };
}

test('scoped supervised no-CAS writer preserves source, reads back and rerun is idempotent', async () => {
  const f = await setup();
  const options = { actions: [f.action], client: f.client, dir: f.dir, supervision: f.supervision, clock: () => at };
  const results = await applyReconciliation(options);
  assert.equal(results[0].phase, 'confirmed'); assert.equal(f.count(), 2);
  assert.equal(f.current.description, 'original evidence'); assert.equal(f.current.status, 'Canceled');
  assert.equal((await applyReconciliation(options))[0].adopted, true); assert.equal(f.count(), 2);
});

test('unknown comment success and concurrent edits quarantine without blind retry or later writes', async () => {
  for (const mode of [{ lostResponse: true }, { edit: true }]) {
    const f = await setup(mode);
    const options = { actions: [f.action, f.action], client: f.client, dir: f.dir, supervision: f.supervision, clock: () => at };
    assert.equal((await applyReconciliation(options))[0].phase, 'unknown'); assert.equal(f.count(), 1);
    assert.equal((await applyReconciliation(options))[0].reason, 'unknown_result_quarantine'); assert.equal(f.count(), 1);
    assert.equal(f.current.status, 'Backlog');
  }
});

test('missing operational exclusion or changed pre-read blocks all mutations', async () => {
  const f = await setup();
  await assert.rejects(applyReconciliation({ actions: [f.action], client: f.client, dir: f.dir, supervision: { ...f.supervision, operationalExclusion: false }, clock: () => at }), /supervision/);
  assert.equal(f.count(), 0);
  f.current.description = 'new human text';
  const results = await applyReconciliation({ actions: [f.action], client: f.client, dir: f.dir, supervision: f.supervision, clock: () => at });
  assert.equal(results[0].reason, 'concurrent_or_protected'); assert.equal(f.count(), 0);
});
