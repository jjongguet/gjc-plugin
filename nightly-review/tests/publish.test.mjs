import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishFindings } from '../lib/publish.mjs';
import { immutableJson } from '../lib/state.mjs';
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

test('create timeout preserves unknown operation and a second run never blindly retries', async () => {
  const f = await setup({ lost: true });
  const options = { ...f, findings: [finding], runId: 'run-1' };
  assert.equal((await publishFindings(options)).result.errors.length, 1); assert.equal(f.count(), 1);
  // Existing server-side evidence is discovered; changing type to comment still
  // must not create a second issue. Short-lived protection also blocks the write.
  f.issues[1].updatedAt = new Date(now).toISOString();
  assert.equal((await publishFindings(options)).result.created.length, 0); assert.equal(f.count(), 1);
});

test('supervised review reserves both possible attempts and refuses expired/over-cap/unknown pricing', () => {
  const model = 'provider/model'; const lens = { id: 'contract', model };
  const supervision = { active: true, supervisor: 'test-agent', expiresAt: new Date(now + 300000).toISOString(), budget: { capUsd: 5, spentUsd: 0, reservedUsd: 0 }, modelBounds: { [model]: { verified: true, source: 'https://example.com/pricing', maxContextTokens: 32000, maxOutputTokens: 1000, inputUsdPerMillion: 1, outputUsdPerMillion: 2, observedAt: new Date(now).toISOString() } } };
  assert.equal(reviewBudget({ supervision, lenses: [lens], calls: 2, now }).upperUsd, 0.136);
  assert.throws(() => reviewBudget({ supervision, lenses: [lens], calls: 100, now }), /budget/);
  assert.throws(() => reviewBudget({ supervision: { ...supervision, expiresAt: old }, lenses: [lens], calls: 1, now }), /supervisor/);
  assert.throws(() => reviewBudget({ supervision: { ...supervision, modelBounds: {} }, lenses: [lens], calls: 1, now }), /cost bound/);
});
