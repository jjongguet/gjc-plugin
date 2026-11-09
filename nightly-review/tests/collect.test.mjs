import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectRepo, PR_FIELDS_QUERY } from '../lib/collect.mjs';

const pr = (number) => ({
  number, title: `PR ${number}`, url: `https://example.invalid/pr/${number}`,
  mergedAt: '2026-11-09T00:00:00Z', additions: 1, deletions: 0,
  files: [{ path: 'lib/change.mjs' }], headRefOid: `head-${number}`,
  mergeCommit: { oid: `merge-${number}` },
});

async function fixture(t, overrides = {}) {
  const runDir = await mkdtemp(path.join(os.tmpdir(), 'nightly-collect-'));
  t.after(() => rm(runDir, { recursive: true, force: true }));
  return {
    repo: 'gjc-plugin', since: '2026-11-08', runDir, maxDiffBytes: 40000,
    listPrs: async () => [pr(1)],
    readDiff: async () => ({ diff: '+change\n', truncated: false }),
    readRules: async () => [{ path: 'AGENTS.md', text: 'rules', truncated: false }],
    ...overrides,
  };
}

test('raw 100 PR cap remains incomplete after an empty diff is skipped', async (t) => {
  const options = await fixture(t, {
    listPrs: async (args) => {
      assert.deepEqual(args, { repo: 'gjc-plugin', since: '2026-11-08', limit: 100 });
      return Array.from({ length: 100 }, (_, index) => pr(index + 1));
    },
    readDiff: async ({ number }) => ({ diff: number === 100 ? ' \n' : '+change\n', truncated: false }),
  });
  const result = await collectRepo(options);
  assert.equal(result.prs.length, 99);
  assert.equal(result.listed, 100);
  assert.equal(result.complete, false);
  assert.equal(result.reason, 'collection_cap');
});

test('terminated listing is complete and retains merged SHA, rules ref and persisted evidence', async (t) => {
  const options = await fixture(t, {
    readRules: async (args) => {
      assert.deepEqual(args, { repo: 'gjc-plugin', ref: 'merge-1', files: ['lib/change.mjs'] });
      return [{ path: 'AGENTS.md', text: 'rules', truncated: false }];
    },
  });
  const result = await collectRepo(options);
  assert.equal(result.complete, true);
  assert.equal(result.listed, 1);
  assert.equal(result.reason, null);
  assert.equal(result.prs[0].mergedSha, 'merge-1');
  assert.equal(result.prs[0].headRefOid, 'head-1');
  assert.deepEqual(result.prs[0].rules, [{ path: 'AGENTS.md', text: 'rules', truncated: false }]);
  assert.deepEqual(JSON.parse(await readFile(path.join(options.runDir, 'input/gjc-plugin/pr-1.json'), 'utf8')), result.prs[0]);
  assert.ok(PR_FIELDS_QUERY.split(',').includes('mergeCommit'));
});

test('empty terminated listing is explicitly complete', async (t) => {
  const options = await fixture(t, { listPrs: async () => [] });
  assert.deepEqual(await collectRepo(options), { prs: [], complete: true, listed: 0, reason: null });
});

test('rules retain head ref when a merge commit is unavailable', async (t) => {
  const options = await fixture(t, {
    listPrs: async () => [{ ...pr(1), mergeCommit: null }],
    readRules: async ({ ref }) => { assert.equal(ref, 'head-1'); return []; },
  });
  assert.equal((await collectRepo(options)).prs[0].mergedSha, null);
});

for (const adapter of ['listPrs', 'readDiff', 'readRules']) {
  test(`${adapter} failure never returns successful coverage`, async (t) => {
    const options = await fixture(t, { [adapter]: async () => { throw new Error(`${adapter} failed`); } });
    await assert.rejects(collectRepo(options), new RegExp(`${adapter} failed`));
  });
}
