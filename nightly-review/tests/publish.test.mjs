import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, unlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishFindings } from '../lib/publish.mjs';
import { immutableJson, digest, jsonBytes, journalEvent } from '../lib/state.mjs';
import { evidenceHash } from '../lib/filing.mjs';
import { reviewBudget } from '../lib/supervision.mjs';
const now = Date.now();
const old = new Date(now - 3 * 86400000).toISOString();
const finding = { repo: 'r', file: 'a.mjs', kind: 'contract', line: 4, quote: 'return value.toString()', pr: 1, confidence: 0.4 };
const key = 'r::a.mjs::contract';

async function setup({ lost = false, incomplete = false, batch = true, protectedIssue = false } = {}) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nightly-publish-')));
  await immutableJson(path.join(dir, 'owner.json'), { version: 1, host: os.hostname(), generation: 1, enabled: true });
  const issues = batch ? [{ id: 'parent', title: '[nightly 배치] p', description: 'parent evidence', project: 'p', updatedAt: old, createdAt: old, statusType: 'backlog', labels: ['nightly'] }] : [];
  if (protectedIssue) issues.push({ id: 'existing', title: '[nightly] r', description: `<!-- nightly-review:${key} -->`, project: 'p', updatedAt: new Date(now).toISOString(), createdAt: old, statusType: 'backlog', labels: ['nightly'] });
  let writes = 0;
  const client = {
    projectFor: () => 'p',
    listLabels: async () => ({ labels: [{ id: 'nightly-label', name: 'nightly' }], hasNextPage: false }),
    listIssues: async () => ({ issues: structuredClone(issues), hasNextPage: incomplete, ...(incomplete ? { cursor: 'repeat' } : {}) }),
    getIssue: async (id) => structuredClone(issues.find((i) => i.id === id)),
    listComments: async () => ({ comments: [], hasNextPage: false }),
    createIssue: async (args) => {
      writes++;
      const issue = { ...args, id: `new-${issues.length}`, updatedAt: old, createdAt: old, statusType: 'backlog', labels: ['nightly'] };
      issues.push(issue);
      if (lost) throw new Error('timeout after remote success');
      return issue;
    },
    createComment: async () => { writes++; },
  };
  const supervision = { active: true, supervisor: 'test-agent', operationalExclusion: true, expiresAt: new Date(now + 300000).toISOString(), actions: [{ issueId: key, type: 'create', project: 'p' }, { issueId: 'batch:p', type: 'create-batch', project: 'p' }] };
  return { dir, client, supervision, issues, count: () => writes };
}

test('complete inventory filing labels, parents, readbacks and preserves identities; rerun creates zero', async () => {
  const f = await setup();
  const options = { ...f, findings: [finding], runId: 'run-1' };
  const first = await publishFindings(options);
  assert.equal(first.result.created.length, 1); assert.equal(f.count(), 1);
  const entry = JSON.parse(await readFile(path.join(f.dir, 'filed.json'))).clusters[key];
  assert.equal(entry.issue.id, 'new-1'); assert.equal(entry.evidence.length, 1);
  assert.equal(f.issues[1].parentId, 'parent'); assert.deepEqual(f.issues[1].labels, ['nightly']);
  assert.equal((await publishFindings(options)).result.skipped[0].reason, 'up_to_date'); assert.equal(f.count(), 1);
});

test('an ambiguous or unterminated nightly label inventory refuses filing before any write', async () => {
  for (const labels of [{ labels: [{ id: 'a', name: 'nightly' }, { id: 'b', name: 'nightly' }], hasNextPage: false }, { labels: [{ id: 'a', name: 'nightly' }], hasNextPage: true }]) {
    const f = await setup();
    f.client.listLabels = async () => labels;
    await assert.rejects(publishFindings({ ...f, findings: [finding], runId: 'run-1' }), /label inventory/);
    assert.equal(f.count(), 0);
  }
});

test('missing batch is a separately scoped operation and creates one parent only', async () => {
  const f = await setup({ batch: false });
  const first = await publishFindings({ ...f, findings: [finding], runId: 'run-1' });
  assert.equal(first.result.created.length, 1); assert.equal(f.count(), 2);
  assert.equal(f.issues.filter((i) => i.title.startsWith('[nightly 배치]')).length, 1);
  assert.equal(f.issues[1].parentId, f.issues[0].id);
});

test('incomplete inventory and protected ledger-external matches never mutate', async () => {
  for (const mode of [{ incomplete: true }, { protectedIssue: true }]) {
    const f = await setup(mode);
    const result = await publishFindings({ ...f, findings: [finding], runId: 'run-1' });
    assert.equal(result.result.created.length, 0); assert.equal(f.count(), 0);
  }
});

test('create timeout preserves unknown operation; rerun adopts it from the unique marker without a second write', async () => {
  const f = await setup({ lost: true });
  const options = { ...f, findings: [finding], runId: 'run-1' };
  assert.equal((await publishFindings(options)).result.errors.length, 1); assert.equal(f.count(), 1);
  // Short-lived protection on the remote issue does not matter: adoption writes nothing remotely.
  f.issues[1].updatedAt = new Date(now).toISOString();
  const second = await publishFindings(options);
  assert.equal(second.result.created.length, 0); assert.equal(f.count(), 1);
  assert.ok(second.result.skipped.some((s) => s.reason === 'adopted_confirmed_operation'));
  assert.equal(JSON.parse(await readFile(path.join(f.dir, 'filed.json'), 'utf8')).clusters[key].issue.id, f.issues[1].id);
  assert.equal((await publishFindings(options)).result.skipped[0].reason, 'up_to_date'); assert.equal(f.count(), 1);
});

test('an unknown create without its exact remote marker stays quarantined and blocks every new write', async () => {
  for (const tamper of ['missing', 'duplicated', 'other-title', 'other-findings', 'archived', 'parent-not-batch', 'incomplete-inventory', 'generation-changed']) {
    const f = await setup({ lost: true });
    const options = { ...f, findings: [finding], runId: 'run-1' };
    await publishFindings(options); assert.equal(f.count(), 1);
    if (tamper === 'missing') f.issues.pop();
    else if (tamper === 'duplicated') f.issues.push({ ...f.issues[1], id: 'copy' });
    else if (tamper === 'other-title') f.issues[1].title = 'edited by someone';
    else if (tamper === 'archived') f.issues[1].archivedAt = old;
    else if (tamper === 'parent-not-batch') f.issues[0].title = 'ordinary issue';
    else if (tamper === 'incomplete-inventory') f.client.listIssues = async () => ({ issues: structuredClone(f.issues), hasNextPage: true, cursor: 'repeat' });
    else if (tamper === 'generation-changed') await writeFile(path.join(f.dir, 'owner.json'), JSON.stringify({ version: 1, host: os.hostname(), generation: 2, enabled: true }));
    const findings = tamper === 'other-findings' ? [{ ...finding, file: 'b.mjs' }] : [finding];
    if (tamper === 'other-findings') f.supervision.actions.push({ issueId: 'r::b.mjs::contract', type: 'create', project: 'p' });
    const second = await publishFindings({ ...options, findings });
    assert.equal(second.result.errors[0].reason, 'unknown_remote_result_quarantine', tamper);
    assert.equal(f.count(), 1, tamper);
    await assert.rejects(readFile(path.join(f.dir, 'filed.json'), 'utf8'), /ENOENT/, tamper);
  }
});

const autolink = (text) => text.replace(/JJO-(\d+)/g, '[JJO-$1](https://linear.app/x/issue/JJO-$1)');
const linkedFinding = { ...finding, kind: 'contract-JJO-7' };
const linkedKey = 'r::a.mjs::contract-JJO-7';

test('identifier autolinking inside the readable marker neither breaks confirmation, adoption nor dedupe', async () => {
  for (const lost of [false, true]) {
    const f = await setup({ lost });
    f.supervision.actions.push({ issueId: linkedKey, type: 'create', project: 'p' });
    const create = f.client.createIssue;
    f.client.createIssue = async (args) => create({ ...args, description: autolink(args.description) });
    const options = { ...f, findings: [linkedFinding], runId: 'run-1' };
    const first = await publishFindings(options);
    assert.ok(!f.issues[1].description.includes(`<!-- nightly-review:${linkedKey} -->`), 'fixture really mangles the readable marker');
    if (lost) {
      assert.equal(first.result.errors.length, 1);
      const second = await publishFindings(options);
      assert.ok(second.result.skipped.some((s) => s.reason === 'adopted_confirmed_operation'));
    } else assert.equal(first.result.created.length, 1);
    assert.equal(f.count(), 1);
    // With the ledger lost, the hex key marker still identifies the existing issue:
    // no second issue is created (the recent issue is protected instead).
    await unlink(path.join(f.dir, 'filed.json'));
    f.issues[1].updatedAt = new Date(now).toISOString();
    const again = await publishFindings({ ...options, runId: 'run-2' });
    assert.equal(again.result.created.length, 0);
    assert.equal(f.issues.filter((i) => i.title === f.issues[1].title).length, 1);
    assert.equal(f.count(), 1);
  }
});

async function commentSetup({ lost = false } = {}) {
  const f = await setup();
  const comments = [];
  f.issues.push({ id: 'existing', title: '[nightly] r', description: `<!-- nightly-review:${key} -->`, project: 'p', parentId: 'parent', updatedAt: old, createdAt: old, statusType: 'backlog', labels: ['nightly'] });
  await immutableJson(path.join(f.dir, 'filed.json'), { version: 1, clusters: { [key]: { issue: { id: 'existing' }, evidence: ['old-evidence'], filedAt: old } } });
  f.supervision.actions.push({ issueId: key, type: 'comment', project: 'p' });
  let writes = 0;
  f.client.listComments = async ({ issueId }) => ({ comments: structuredClone(comments.filter((c) => c.issueId === issueId)), hasNextPage: false });
  f.client.createComment = async ({ issueId, body }) => { writes++; comments.push({ id: `c-${comments.length}`, issueId, body, createdAt: old }); if (lost) throw new Error('timeout after remote success'); };
  return { ...f, comments, commentWrites: () => writes };
}

test('a lost evidence comment is adopted only on its bound confirmed issue', async () => {
  for (const tamper of ['none', 'confirmed-missing', 'copied-elsewhere']) {
    const f = await commentSetup({ lost: true });
    const options = { ...f, findings: [finding], runId: 'run-1' };
    assert.equal((await publishFindings(options)).result.errors.length, 1);
    assert.equal(f.commentWrites(), 1);
    if (tamper === 'confirmed-missing') {
      const moved = f.issues.findIndex((i) => i.id === 'existing');
      f.issues.push({ ...f.issues[moved], id: 'other' });
      f.comments[0].issueId = 'other';
      f.issues.splice(moved, 1);
    } else if (tamper === 'copied-elsewhere') {
      f.issues.push({ ...f.issues.find((i) => i.id === 'existing'), id: 'other', description: 'unrelated' });
      f.comments.push({ ...f.comments[0], id: 'copy', issueId: 'other' });
    }
    const second = await publishFindings(options);
    assert.equal(f.commentWrites(), 1, tamper);
    const saved = JSON.parse(await readFile(path.join(f.dir, 'filed.json'), 'utf8')).clusters[key];
    if (tamper === 'none') {
      assert.ok(second.result.skipped.some((s) => s.reason === 'adopted_confirmed_operation'));
      assert.equal(saved.issue.id, 'existing'); assert.equal(saved.evidence.length, 2);
    } else {
      assert.equal(second.result.errors[0].reason, 'unknown_remote_result_quarantine', tamper);
      assert.deepEqual(saved.evidence, ['old-evidence'], tamper);
    }
  }
});

test('a crash after the adoption journal but before the ledger commit converges without a remote write', async () => {
  const f = await setup({ lost: true });
  const options = { ...f, findings: [finding], runId: 'run-1' };
  await publishFindings(options);
  const id = digest(jsonBytes({ key, evidence: [evidenceHash(finding)], generation: 1, type: 'create' }));
  await journalEvent(f.dir, { id, phase: 'confirmed', entry: { issue: { id: f.issues[1].id, identifier: null, url: null }, evidence: [evidenceHash(finding)], filedAt: old, lastRun: 'run-1' }, adopted: true });
  const second = await publishFindings(options);
  assert.equal(second.result.errors.length, 0);
  assert.equal(JSON.parse(await readFile(path.join(f.dir, 'filed.json'), 'utf8')).clusters[key].issue.id, f.issues[1].id);
  assert.equal(f.count(), 1);
});

test('a created issue whose markdown Linear normalized is confirmed by markers, not byte equality', async () => {
  const f = await setup();
  const create = f.client.createIssue;
  f.client.createIssue = async (args) => create({ ...args, description: args.description.replaceAll('\n- ', '\n* ').replaceAll('`', '\\`') });
  const result = await publishFindings({ ...f, findings: [finding], runId: 'run-1' });
  assert.equal(result.result.created.length, 1); assert.equal(result.result.errors.length, 0);
  assert.notEqual(f.issues[1].description.includes('\n- '), true);
  assert.equal(JSON.parse(await readFile(path.join(f.dir, 'filed.json'), 'utf8')).clusters[key].issue.id, 'new-1');
});

test('supervised review reserves both possible attempts and refuses expired/over-cap/unknown pricing', () => {
  const model = 'provider/model'; const lens = { id: 'contract', model };
  const supervision = { active: true, supervisor: 'test-agent', expiresAt: new Date(now + 300000).toISOString(), budget: { capUsd: 5, spentUsd: 0, reservedUsd: 0 }, modelBounds: { [model]: { verified: true, source: 'https://example.com/pricing', maxContextTokens: 32000, maxOutputTokens: 1000, inputUsdPerMillion: 1, outputUsdPerMillion: 2, observedAt: new Date(now).toISOString() } } };
  assert.equal(reviewBudget({ supervision, lenses: [lens], calls: 2, now }).upperUsd, 0.136);
  assert.throws(() => reviewBudget({ supervision, lenses: [lens], calls: 100, now }), /budget/);
  assert.throws(() => reviewBudget({ supervision: { ...supervision, expiresAt: old }, lenses: [lens], calls: 1, now }), /supervisor/);
  assert.throws(() => reviewBudget({ supervision: { ...supervision, modelBounds: {} }, lenses: [lens], calls: 1, now }), /cost bound/);
  for (const supervisor of ['', '   ', {}, [], 1]) {
    assert.throws(() => reviewBudget({ supervision: { ...supervision, supervisor }, lenses: [lens], calls: 1, now }), /supervisor/);
  }
});

test('a missing confirmed legacy identity is deferred without replacement even after a project move', async () => {
  for (const moved of [false, true]) {
    const f = await setup();
    const ledger = { version: 1, clusters: { [key]: { issue: { id: 'confirmed-A' }, evidence: [], filedAt: old } } };
    await immutableJson(path.join(f.dir, 'filed.json'), ledger);
    if (moved) {
      f.issues.push({ ...f.issues[0], id: 'confirmed-A', project: 'elsewhere', title: '[nightly] moved', description: `<!-- nightly-review:${key} -->` });
      f.client.listIssues = async () => ({ issues: f.issues.filter((i) => i.project === 'p'), hasNextPage: false });
    } else {
      // Even an apparent replacement marker must not replace confirmed identity A.
      f.issues.push({ ...f.issues[0], id: 'replacement-B', title: '[nightly] replacement', description: `<!-- nightly-review:${key} -->` });
    }
    const result = await publishFindings({ ...f, findings: [finding], runId: 'run-1', clock: () => now });
    assert.equal(result.result.skipped[0].reason, 'confirmed_identity_missing');
    assert.equal(f.count(), 0);
    assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'filed.json'), 'utf8')), ledger);
  }
});

test('literal legacy IDs survive canonical remote updates, interrupted confirmation recovery and ambiguous aliases', async () => {
  for (const mode of ['normal', 'interrupted', 'ambiguous']) {
    const f = await setup();
    const ledger = { version: 1, clusters: { [key]: { issue: { id: 'JJO-1958' }, evidence: ['old-evidence'], filedAt: old } } };
    await immutableJson(path.join(f.dir, 'filed.json'), ledger);
    const canonical = { ...f.issues[0], id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', identifier: 'JJO-1958', title: '[nightly] real wrapper shape', description: `<!-- nightly-review:${key} -->` };
    f.issues.push(canonical);
    if (mode === 'ambiguous') f.issues.push({ ...canonical, id: 'another-uuid', uuid: 'another-uuid', description: 'conflicting alias metadata' });
    f.supervision.actions.push({ issueId: key, type: 'comment', project: 'p' });
    const comments = []; const post = f.client.createComment;
    f.client.createComment = async (args) => { await post(args); comments.push({ id: 'new-comment', body: args.body, createdAt: new Date(now).toISOString() }); };
    f.client.listComments = async ({ issueId }) => ({ comments: issueId === canonical.id ? structuredClone(comments) : [], hasNextPage: false });
    if (mode === 'interrupted') {
      const comment = f.client.createComment;
      f.client.createComment = async (...args) => {
        const result = await comment(...args);
        await writeFile(path.join(f.dir, 'filed.json'), JSON.stringify({ ...ledger, externalMetadata: 'preserved' }));
        return result;
      };
    }
    const first = await publishFindings({ ...f, findings: [finding], runId: 'legacy-update', clock: () => now });
    if (mode === 'ambiguous') {
      assert.equal(first.result.skipped[0].reason, 'confirmed_identity_ambiguous'); assert.equal(f.count(), 0);
      assert.deepEqual(JSON.parse(await readFile(path.join(f.dir, 'filed.json'), 'utf8')), ledger); continue;
    }
    assert.equal(f.count(), 1);
    if (mode === 'interrupted') {
      assert.equal(first.result.errors.length, 1);
      const recovered = await publishFindings({ ...f, findings: [finding], runId: 'recovery', clock: () => now });
      assert.equal(recovered.result.errors.length, 0);
      assert.equal(f.count(), 1);
    } else assert.equal(first.result.commented.length, 1);
    const saved = JSON.parse(await readFile(path.join(f.dir, 'filed.json'), 'utf8'));
    assert.equal(saved.clusters[key].issue.id, 'JJO-1958');
    assert.equal(saved.clusters[key].evidence.includes('old-evidence'), true);
    assert.equal(saved.clusters[key].evidence.length, 2);
    if (mode === 'interrupted') assert.equal(saved.externalMetadata, 'preserved');
  }
});

test('confirmed batch history permits a separately scoped replacement after retirement without deleting prior journals', async () => {
  for (const retirement of ['archived', 'completed']) {
    const f = await setup({ batch: false });
    assert.equal((await publishFindings({ ...f, findings: [finding], runId: 'first', clock: () => now })).result.created.length, 1);
    const initial = digest(jsonBytes({ issueId: 'batch:p', generation: 1 }));
    const before = await readFile(path.join(f.dir, 'operations', `${initial}-confirmed.json`), 'utf8');
    if (retirement === 'archived') f.issues[0].archivedAt = old;
    else f.issues[0].statusType = 'completed';
    f.supervision.actions.push({ issueId: 'r::b.mjs::contract', type: 'create', project: 'p' });
    const result = await publishFindings({ ...f, findings: [{ ...finding, file: 'b.mjs' }], runId: 'replacement', clock: () => now });
    assert.equal(result.result.created.length, 1);
    assert.equal(f.count(), 4);
    assert.notEqual(f.issues.at(-1).parentId, f.issues[0].id);
    assert.equal(await readFile(path.join(f.dir, 'operations', `${initial}-confirmed.json`), 'utf8'), before);
  }
});

test('archived batches never compete with active parents or block one separately scoped new batch', async () => {
  for (const active of [false, true]) {
    const f = await setup();
    f.issues[0].archivedAt = old;
    if (active) f.issues.push({ ...f.issues[0], id: 'active', archivedAt: null });
    const result = await publishFindings({ ...f, findings: [finding], runId: 'run-1', clock: () => now });
    assert.equal(result.result.created.length, 1);
    assert.equal(f.count(), active ? 1 : 2);
    const parents = f.issues.filter((i) => i.title.startsWith('[nightly 배치]') && !i.archivedAt);
    assert.equal(parents.length, 1);
    assert.equal(f.issues.at(-1).parentId, parents[0].id);
  }
});

test('archived operation-marker batch is not adopted as an active parent', async () => {
  const f = await setup();
  const id = digest(jsonBytes({ issueId: 'batch:p', generation: 1 }));
  Object.assign(f.issues[0], { archivedAt: old, description: `<!-- nightly-operation:${id} -->` });
  const result = await publishFindings({ ...f, findings: [finding], runId: 'run-1', clock: () => now });
  assert.equal(result.result.created.length, 1);
  assert.equal(f.count(), 2);
  assert.notEqual(f.issues.at(-1).parentId, 'parent');
});

test('createBatch reread ignores a newly observed archived batch', async () => {
  const f = await setup({ batch: false }); let scans = 0;
  const list = f.client.listIssues;
  f.client.listIssues = async (...args) => {
    if (++scans === 2) f.issues.push({ id: 'archived', title: '[nightly 배치] p', description: 'old batch', project: 'p', updatedAt: old, createdAt: old, archivedAt: old, statusType: 'backlog', labels: ['nightly'] });
    return list(...args);
  };
  const result = await publishFindings({ ...f, findings: [finding], runId: 'run-1', clock: () => now });
  assert.equal(result.result.created.length, 1);
  assert.equal(f.count(), 2);
  assert.notEqual(f.issues.at(-1).parentId, 'archived');
});

test('prewrite parent verification refuses an archived selected parent even with another active batch', async () => {
  const f = await setup(); let scans = 0;
  const list = f.client.listIssues;
  f.client.listIssues = async (...args) => {
    if (++scans === 2) {
      f.issues[0].archivedAt = old;
      f.issues.push({ ...f.issues[0], id: 'other-active', archivedAt: null });
    }
    return list(...args);
  };
  const result = await publishFindings({ ...f, findings: [finding], runId: 'run-1', clock: () => now });
  assert.equal(result.result.skipped[0].reason, 'batch_changed');
  assert.equal(f.count(), 0);
});

test('every filing and batch write rechecks expiry, exact scope and original owner after awaited reads', async () => {
  for (const operation of ['create', 'comment', 'create-batch']) {
    for (const invalidation of ['expiry', 'owner', 'scope']) {
      const f = await setup({ batch: operation !== 'create-batch' });
      let time = now; let scans = 0;
      f.supervision.expiresAt = new Date(now + 60000).toISOString();
      if (operation === 'comment') {
        f.issues.push({ ...f.issues[0], id: 'existing', title: '[nightly] r', description: `<!-- nightly-review:${key} -->` });
        f.supervision.actions.push({ issueId: key, type: 'comment', project: 'p' });
      }
      const list = f.client.listIssues;
      f.client.listIssues = async (...args) => {
        const result = await list(...args);
        if (++scans === 2) {
          if (invalidation === 'expiry') time = now + 60000;
          else if (invalidation === 'owner') await writeFile(path.join(f.dir, 'owner.json'), JSON.stringify({ version: 1, host: os.hostname(), generation: 2, enabled: true }));
          else f.supervision.actions = [];
        }
        return result;
      };
      // Invalid supervision may be rejected before journaling or quarantined in
      // the guarded write block; neither path may reach a remote write.
      try {
        const result = await publishFindings({ ...f, findings: [finding], runId: 'run-1', clock: () => time });
        assert.equal(result.result.errors.length, 1);
      } catch (error) {
        assert.match(error.message, /supervision|generation/);
      }
      assert.equal(f.count(), 0, `${operation}: ${invalidation}`);
    }
  }
});

test('batch readback expiry or owner rotation prevents the follow-on finding write', async () => {
  for (const invalidation of ['expiry', 'owner']) {
    const f = await setup({ batch: false }); let time = now;
    const get = f.client.getIssue;
    f.client.getIssue = async (...args) => {
      const result = await get(...args);
      if (invalidation === 'expiry') time = now + 300000;
      else await writeFile(path.join(f.dir, 'owner.json'), JSON.stringify({ version: 1, host: os.hostname(), generation: 2, enabled: true }));
      return result;
    };
    try {
      const result = await publishFindings({ ...f, findings: [finding], runId: 'run-1', clock: () => time });
      assert.equal(result.result.errors.length, 1);
    } catch (error) { assert.match(error.message, /supervision|generation/); }
    assert.equal(f.count(), 1);
    assert.equal(f.issues.length, 1);
  }
});
