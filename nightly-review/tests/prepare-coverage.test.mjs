import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, realpath, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { collectRepo } from '../lib/collect.mjs';
import { prepare } from '../lib/prepare.mjs';

const pr = (number) => ({
  number, title: `PR ${number}`, url: `https://example.invalid/pr/${number}`,
  mergedAt: '2026-11-09T00:00:00Z', additions: 1, deletions: 0,
  files: [{ path: 'change.mjs' }], headRefOid: `head-${number}`,
  mergeCommit: { oid: `merge-${number}` },
});

async function fixture(t, listed, adapters = {}) {
  const out = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nightly-coverage-')));
  t.after(() => rm(out, { recursive: true, force: true }));
  const configPath = path.join(out, 'config.json');
  const host = os.hostname();
  await writeFile(configPath, JSON.stringify({
    version: 1, ownerHost: host, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    repos: ['gjc-plugin'], hour: 5, minute: 0,
  }));
  await writeFile(path.join(out, 'owner.json'), JSON.stringify({ version: 1, host, generation: 1, enabled: true }));
  return {
    configPath, out, mode: 'scheduled', host, projectMap: { 'gjc-plugin': 'project' },
    clock: () => new Date('2026-11-09T01:00:00Z'),
    collect: (options) => collectRepo({
      ...options,
      listPrs: async ({ limit }) => {
        assert.equal(limit, 100);
        return Array.from({ length: listed }, (_, index) => pr(index + 1));
      },
      readDiff: async ({ number }) => ({ diff: number === 100 ? ' \n' : '+change\n', truncated: false }),
      readRules: async () => [],
      ...adapters,
    }),
  };
}

async function index(options) {
  return JSON.parse(await readFile(path.join(options.out, 'preparation.json'), 'utf8'));
}

function assertReadOnlyCounters(receipt, prs) {
  assert.deepEqual(receipt.counters, { prs, modelCalls: 0, decisions: 0, linearMutations: 0, reviewSpawns: 0 });
  assert.equal(receipt.costUsd, 0);
}

test('100 raw PRs / 99 reviewable PRs remain incomplete with no success watermark', async (t) => {
  const options = await fixture(t, 100);
  const receipt = await prepare(options);
  assert.equal(receipt.status, 'incomplete');
  assert.deepEqual(receipt.coverage, [{ repo: 'gjc-plugin', count: 99, listed: 100, complete: false, reason: 'collection_cap' }]);
  assertReadOnlyCounters(receipt, 99);
  assert.equal(JSON.parse(await readFile(path.join(receipt.runDir, 'queue.json'), 'utf8')).prs.length, 99);
  const state = await index(options);
  assert.equal(state.complete, false);
  assert.equal(state.watermark, null);
  assert.equal(state.lastSuccess, null);
});

test('terminated normal listing advances success watermark and duplicate tick does not recollect', async (t) => {
  const options = await fixture(t, 2);
  const receipt = await prepare(options);
  assert.equal(receipt.status, 'prepared');
  assert.deepEqual(receipt.coverage, [{ repo: 'gjc-plugin', count: 2, listed: 2, complete: true, reason: null }]);
  assertReadOnlyCounters(receipt, 2);
  const state = await index(options);
  assert.equal(state.complete, true);
  assert.equal(state.watermark, '2026-11-09T01:00:00.000Z');
  assert.equal(state.lastSuccess, state.watermark);
  assert.equal((await prepare({ ...options, collect: async () => assert.fail('duplicate must not collect') })).status, 'duplicate');
});

test('capped next day preserves prior successful watermark without advancing it', async (t) => {
  const options = await fixture(t, 1);
  await prepare(options);
  const previous = await index(options);
  const receipt = await prepare({
    ...options,
    clock: () => new Date('2026-11-10T01:00:00Z'),
    collect: async () => ({ prs: [], listed: 100, complete: false, reason: 'collection_cap' }),
  });
  assert.equal(receipt.status, 'incomplete');
  const state = await index(options);
  assert.equal(state.watermark, null);
  assert.equal(state.lastSuccess, previous.watermark);
});

for (const adapter of ['readDiff', 'readRules']) {
  test(`${adapter} failure cannot advance the preparation watermark`, async (t) => {
    const options = await fixture(t, 1, { [adapter]: async () => { throw new Error('read failed'); } });
    const receipt = await prepare(options);
    assert.equal(receipt.status, 'incomplete');
    assert.deepEqual(receipt.coverage, [{ repo: 'gjc-plugin', complete: false, reason: 'collection_failed' }]);
    assertReadOnlyCounters(receipt, 0);
    assert.equal((await index(options)).lastSuccess, null);
  });
}

test('legacy filtered arrays and contradictory coverage are rejected rather than inferred complete', async (t) => {
  for (const result of [[], { prs: [], complete: true, listed: 100, reason: null }]) {
    const options = await fixture(t, 0);
    const receipt = await prepare({ ...options, collect: async () => result });
    assert.equal(receipt.status, 'incomplete');
    assert.equal(receipt.coverage[0].reason, 'collection_failed');
    assert.equal((await index(options)).lastSuccess, null);
  }
});
