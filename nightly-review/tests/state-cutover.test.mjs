import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, symlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite, withLock, digest, jsonBytes, immutableJson, assertOwner, stageTransfer, journalEvent, unresolvedOperations } from '../lib/state.mjs';
import { prepare, evaluateLocal } from '../lib/prepare.mjs';

const scratch = async () => realpath(await mkdtemp(path.join(os.tmpdir(), 'nightly-state-')));
const ledger = { version: 1, clusters: { 'r::f::k': { issue: { id: 'JJO-1' }, evidence: ['old'] } } };

test('local lock excludes simultaneous writer, releases on failure, hash conflict preserves bytes', async () => {
  const dir = await scratch();
  await withLock(dir, async () => {
    await assert.rejects(withLock(dir, async () => assert.fail()), /lock held/);
    await atomicWrite(path.join(dir, 'filed.json'), jsonBytes(ledger), { expectedHash: null });
    await assert.rejects(atomicWrite(path.join(dir, 'filed.json'), '{}', { expectedHash: 'wrong' }), /conflict/);
  });
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, 'filed.json'))), ledger);
  await assert.rejects(withLock(dir, async () => { throw new Error('failure'); }), /failure/);
  await withLock(dir, async () => {});
});

test('immutable evidence cannot be replaced and owner generation is enforced', async () => {
  const dir = await scratch();
  await immutableJson(path.join(dir, 'owner.json'), { version: 1, host: os.hostname(), generation: 2, enabled: true });
  assert.equal((await assertOwner(dir, { generation: 2 })).generation, 2);
  await assert.rejects(assertOwner(dir, { generation: 1 }), /generation/);
  await assert.rejects(assertOwner(dir, { host: 'wrong' }), /generation/);
  await assert.rejects(immutableJson(path.join(dir, 'owner.json'), {}), /EEXIST/);
});

test('transfer preserves ledger identities and bytes, refuses destination conflicts and symlinks', async () => {
  const dir = await scratch();
  await writeFile(path.join(dir, 'filed.json'), jsonBytes(ledger));
  const target = path.join(dir, 'stage');
  const manifest = await stageTransfer({ source: dir, destination: target });
  assert.equal(manifest[0].sha256, digest(await readFile(path.join(dir, 'filed.json'))));
  assert.deepEqual(JSON.parse(await readFile(path.join(target, 'filed.json'))), ledger);
  await assert.rejects(stageTransfer({ source: dir, destination: target }), /EEXIST/);
  await assert.rejects(stageTransfer({ source: dir, destination: path.join(dir, 'other'), files: ['../secret'] }), /allowlisted/);
  const linked = path.join(dir, 'linked'); await mkdir(linked);
  await symlink(path.join(dir, 'filed.json'), path.join(linked, 'filed.json'));
  await assert.rejects(stageTransfer({ source: linked, destination: path.join(dir, 'escape') }), /symlink/);
});

test('unknown success journals survive and prevent transfer until confirmed', async () => {
  const dir = await scratch(); const id = digest('operation');
  await writeFile(path.join(dir, 'filed.json'), jsonBytes(ledger));
  await journalEvent(dir, { id, phase: 'attempted' });
  await journalEvent(dir, { id, phase: 'unknown' });
  assert.deepEqual(await unresolvedOperations(dir), [id]);
  await assert.rejects(stageTransfer({ source: dir, destination: path.join(dir, 'stage'), files: [`operations/${id}-attempted.json`] }), /unresolved/);
  await journalEvent(dir, { id, phase: 'confirmed' });
  assert.deepEqual(await unresolvedOperations(dir), []);
});

test('scheduled prepare collects only injected reads, writes immutable queue and duplicate tick no-ops', async () => {
  const dir = await scratch(); const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, jsonBytes({ version: 1, ownerHost: os.hostname(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, repos: ['gjc-plugin'], hour: 5, minute: 0 }));
  await immutableJson(path.join(dir, 'owner.json'), { version: 1, host: os.hostname(), generation: 1, enabled: true });
  let reads = 0;
  const options = { configPath, out: dir, mode: 'scheduled', collect: async () => { reads++; return [{ repo: 'gjc-plugin', number: 1, headRefOid: 'sha', truncated: false }]; }, clock: () => new Date('2026-11-09T01:00:00Z') };
  const receipt = await prepare(options);
  assert.equal(receipt.status, 'prepared');
  assert.equal(receipt.counters.modelCalls, 0);
  assert.equal(receipt.counters.linearMutations, 0);
  assert.equal(receipt.counters.reviewSpawns, 0);
  assert.equal((await evaluateLocal(receipt.runDir)).prs, 1);
  assert.equal((await prepare(options)).status, 'duplicate'); assert.equal(reads, 1);
  const queue = path.join(receipt.runDir, 'queue.json'); await writeFile(queue, '{}');
  await assert.rejects(evaluateLocal(receipt.runDir), /hash mismatch/);
});

test('partial collection is incomplete, missing owner and disallowed flags fail before network', async () => {
  const dir = await scratch(); const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, jsonBytes({ version: 1, ownerHost: os.hostname(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, repos: ['gjc-plugin'], hour: 5, minute: 0 }));
  let reads = 0;
  await assert.rejects(prepare({ configPath, out: dir, mode: 'scheduled', collect: async () => { reads++; return []; } }), /ENOENT/);
  assert.equal(reads, 0);
  const receipt = await prepare({ configPath, out: dir, mode: 'shadow', collect: async () => { throw new Error('network'); } });
  assert.equal(receipt.status, 'incomplete'); assert.equal(receipt.costUsd, 0);
  const result = spawnSync(process.execPath, ['nightly-review/bin/nightly-review.mjs', 'prepare', '--mode', 'scheduled', '--config', configPath, '--out', dir, '--publish'], { encoding: 'utf8', env: { PATH: process.env.PATH, TZ: process.env.TZ ?? 'Asia/Seoul' } });
  assert.equal(result.status, 2); assert.match(result.stderr, /does not accept/);
});
