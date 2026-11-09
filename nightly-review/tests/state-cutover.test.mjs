import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, symlink, mkdir, open, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { atomicWrite, withLock, digest, jsonBytes, immutableJson, assertOwner, stageTransfer, journalEvent, unresolvedOperations, privateDirectory } from '../lib/state.mjs';
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

test('immutable journal syncs file then directory and new private ancestry entries', async (t) => {
  const dir = await scratch();
  const probe = await open(path.join(dir, 'probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe);
  const sync = prototype.sync;
  await probe.close();
  const synced = [];
  t.mock.method(prototype, 'sync', async function () {
    const info = await this.stat();
    synced.push({ ino: info.ino, directory: info.isDirectory() });
    return sync.call(this);
  });
  const state = path.join(dir, 'new', 'state'); const id = digest('durable');
  await journalEvent(state, { id, phase: 'attempted' });
  const journal = path.join(state, 'operations');
  const event = path.join(journal, `${id}-attempted.json`);
  const fileInode = (await stat(event)).ino;
  const fileSync = synced.findIndex((entry) => entry.ino === fileInode && !entry.directory);
  assert.ok(fileSync >= 0);
  assert.equal(synced[fileSync + 1].ino, (await stat(journal)).ino);
  assert.equal(synced[fileSync + 1].directory, true);
  for (const directory of [dir, path.join(dir, 'new'), state, journal]) {
    const info = await stat(directory);
    assert.ok(synced.some((entry) => entry.directory && entry.ino === info.ino));
    assert.equal(info.mode & 0o077, 0);
    assert.equal(info.uid, process.getuid());
  }
});

test('directory sync failures reject immutable journal writes and private ancestors cannot be symlinks', async (t) => {
  const dir = await scratch();
  const journal = path.join(dir, 'operations'); await mkdir(journal, { mode: 0o700 });
  const probe = await open(path.join(dir, 'probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe); const sync = prototype.sync;
  await probe.close();
  let fileSynced = false;
  t.mock.method(prototype, 'sync', async function () {
    if ((await this.stat()).isDirectory()) {
      if (fileSynced) throw new Error('directory sync failure');
    } else fileSynced = true;
    return sync.call(this);
  });
  await assert.rejects(journalEvent(dir, { id: digest('failure'), phase: 'attempted' }), /directory sync failure/);
  assert.equal(fileSynced, true);
  const linked = path.join(dir, 'linked'); await symlink(journal, linked);
  await assert.rejects(privateDirectory(path.join(linked, 'child')), /symlink/);
  const publicDir = path.join(dir, 'public'); await mkdir(publicDir, { mode: 0o755 });
  await assert.rejects(privateDirectory(publicDir), /private/);
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
  const linked = path.join(dir, 'linked'); await mkdir(linked, { mode: 0o700 });
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

test('default and subset transfers cannot omit unresolved journals or create a stage', async () => {
  const dir = await scratch(); const id = digest('quarantined');
  await writeFile(path.join(dir, 'filed.json'), jsonBytes(ledger));
  await journalEvent(dir, { id, phase: 'planned' });
  await journalEvent(dir, { id, phase: 'unknown' });
  for (const [name, files] of [['default', undefined], ['ledger', ['filed.json']], ['subset', [`operations/${id}-planned.json`]]]) {
    const destination = path.join(dir, name);
    await assert.rejects(stageTransfer({ source: dir, destination, files }), /unresolved/);
    await assert.rejects(stat(destination), { code: 'ENOENT' });
  }
  assert.equal((await readdir(dir)).includes('.writer.lock'), false);
});

test('confirmed transfer includes complete byte-exact recovery inventory regardless of selected subset', async () => {
  const dir = await scratch(); const id = digest('confirmed'); const other = digest('planned-only');
  const ledgerBytes = `${JSON.stringify(ledger)}\n\n`;
  await writeFile(path.join(dir, 'filed.json'), ledgerBytes);
  for (const phase of ['planned', 'attempted', 'unknown', 'confirmed', 'local_committed']) await journalEvent(dir, { id, phase, issueId: 'preserved-id' });
  await journalEvent(dir, { id: other, phase: 'planned' });
  for (const file of ['owner.json', 'auth.json', 'session.db', 'HOME']) await writeFile(path.join(dir, file), 'must not transfer');
  const journalNames = (await readdir(path.join(dir, 'operations'))).sort();
  const expectedPaths = ['filed.json', ...journalNames.map((name) => `operations/${name}`)];
  for (const [name, files] of [['default-stage', undefined], ['subset-stage', [`operations/${id}-confirmed.json`]]]) {
    const destination = path.join(dir, name);
    const manifest = await stageTransfer({ source: dir, destination, files });
    assert.deepEqual(manifest.map((entry) => entry.path), expectedPaths);
    for (const entry of manifest) {
      const original = await readFile(path.join(dir, entry.path));
      assert.deepEqual(await readFile(path.join(destination, entry.path)), original);
      assert.equal(entry.sha256, digest(original)); assert.equal(entry.bytes, original.length);
    }
    const receipt = JSON.parse(await readFile(path.join(destination, 'transfer.json')));
    assert.deepEqual(receipt.manifest, manifest);
    assert.equal(receipt.sourceInventoryHash, digest(jsonBytes(manifest)));
    assert.equal(receipt.complete, true); assert.equal(receipt.enabled, false);
    assert.deepEqual((await readdir(destination)).sort(), ['filed.json', 'operations', 'transfer.json']);
    await assert.rejects(assertOwner(destination), { code: 'ENOENT' });
  }
});

test('transfer refuses locked sources, journal identity mismatches and journal symlinks before staging', async () => {
  const dir = await scratch(); const id = digest('invalid');
  await writeFile(path.join(dir, 'filed.json'), jsonBytes(ledger));
  const destination = path.join(dir, 'stage');
  await withLock(dir, async () => {
    await assert.rejects(stageTransfer({ source: dir, destination }), /lock held/);
  });
  await journalEvent(dir, { id, phase: 'confirmed' });
  const event = path.join(dir, 'operations', `${id}-confirmed.json`);
  await writeFile(event, jsonBytes({ id: digest('wrong'), phase: 'confirmed' }));
  await assert.rejects(stageTransfer({ source: dir, destination }), /identity/);
  await writeFile(event, jsonBytes({ id, phase: 'confirmed' }));
  const second = digest('linked');
  await symlink(event, path.join(dir, 'operations', `${second}-confirmed.json`));
  await assert.rejects(stageTransfer({ source: dir, destination }), /symlink/);
  await assert.rejects(stat(destination), { code: 'ENOENT' });
});

test('transfer revalidates source hashes and does not mark a changed snapshot complete', async (t) => {
  const dir = await scratch(); const sourceFile = path.join(dir, 'filed.json');
  await writeFile(sourceFile, jsonBytes(ledger));
  const probe = await open(path.join(dir, 'probe'), 'wx', 0o600);
  const prototype = Object.getPrototypeOf(probe); const write = prototype.writeFile;
  await probe.close();
  let changed = false;
  t.mock.method(prototype, 'writeFile', async function (bytes, ...options) {
    const result = await write.call(this, bytes, ...options);
    // Transfer writes raw buffers; the lock writes a string. Simulate an
    // uncooperative writer changing valid source bytes during the copy.
    if (Buffer.isBuffer(bytes) && !changed) {
      changed = true;
      await writeFile(sourceFile, `${jsonBytes(ledger)}\n`);
    }
    return result;
  });
  const destination = path.join(dir, 'stage');
  await assert.rejects(stageTransfer({ source: dir, destination }), /inventory changed/);
  assert.equal(changed, true);
  await assert.rejects(stat(path.join(destination, 'transfer.json')), { code: 'ENOENT' });
  assert.equal((await readdir(dir)).includes('.writer.lock'), false);
});

test('scheduled prepare collects only injected reads, writes immutable queue and duplicate tick no-ops', async () => {
  const dir = await scratch(); const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, jsonBytes({ version: 1, ownerHost: os.hostname(), timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, repos: ['gjc-plugin'], hour: 5, minute: 0 }));
  await immutableJson(path.join(dir, 'owner.json'), { version: 1, host: os.hostname(), generation: 1, enabled: true });
  let reads = 0;
  const options = { configPath, out: dir, mode: 'scheduled', collect: async () => { reads++; return { prs: [{ repo: 'gjc-plugin', number: 1, headRefOid: 'sha', truncated: false }], complete: true, listed: 1, reason: null }; }, clock: () => new Date('2026-11-09T01:00:00Z') };
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
