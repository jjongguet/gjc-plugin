import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, unlink, lstat, realpath, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const jsonBytes = (value) => `${JSON.stringify(value, null, 2)}\n`;

export async function readOptional(file) {
  try { return await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function privateDirectory(dir) {
  const target = path.resolve(dir);
  const missing = [];
  let ancestor = target;
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    missing.push(ancestor);
    ancestor = path.dirname(ancestor);
  }
  if (ancestor !== await realpath(ancestor)) throw new Error('symlink state ancestor refused');
  // Also finish entry durability if an earlier mkdir succeeded but its sync failed.
  if (missing.length) {
    await syncDirectory(ancestor);
    await syncDirectory(path.dirname(ancestor));
  }
  for (const directory of missing.reverse()) {
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    await checkPrivateDirectory(directory);
    await syncDirectory(directory);
    await syncDirectory(path.dirname(directory));
  }
  await checkPrivateDirectory(target);
  await syncDirectory(target);
  await syncDirectory(path.dirname(target));
}

async function checkPrivateDirectory(dir) {
  const stat = await lstat(dir);
  if (stat.isSymbolicLink()) throw new Error('symlink state directory refused');
  if (dir !== await realpath(dir)) throw new Error('symlink state ancestor refused');
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) throw new Error('state directory must be private and owned by current UID');
}

async function syncDirectory(dir) {
  const directory = await open(dir, 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}

export async function atomicWrite(file, bytes, { expectedHash } = {}) {
  await privateDirectory(path.dirname(file));
  const current = await readOptional(file);
  if (expectedHash !== undefined && (current === null ? null : digest(current)) !== expectedHash) {
    throw new Error('state conflict: expected hash changed');
  }
  if (current !== null && (await lstat(file)).isSymbolicLink()) throw new Error('symlink state file refused');
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = await open(temporary, 'wx', 0o600);
  try { await fd.writeFile(bytes); await fd.sync(); }
  finally { await fd.close(); }
  try {
    // Callers must hold the local directory lock. This is not a remote CAS.
    const latest = await readOptional(file);
    if (expectedHash !== undefined && (latest === null ? null : digest(latest)) !== expectedHash) {
      throw new Error('state conflict before rename');
    }
    await rename(temporary, file);
    await syncDirectory(path.dirname(file));
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function immutableJson(file, value) {
  await privateDirectory(path.dirname(file));
  const fd = await open(file, 'wx', 0o600);
  try { await fd.writeFile(jsonBytes(value)); await fd.sync(); }
  finally { await fd.close(); }
  await syncDirectory(path.dirname(file));
  return digest(jsonBytes(value));
}

export async function withLock(dir, execute) {
  await privateDirectory(dir);
  const file = path.join(dir, '.writer.lock');
  let fd;
  try { fd = await open(file, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('writer lock held; inspect owner before recovery'); throw error; }
  const identity = { host: os.hostname(), pid: process.pid, nonce: randomUUID(), at: new Date().toISOString() };
  try {
    await fd.writeFile(jsonBytes(identity)); await fd.sync();
    return await execute();
  } finally {
    await fd.close();
    const current = JSON.parse(await readFile(file, 'utf8'));
    if (current.nonce !== identity.nonce) throw new Error('writer lock ownership changed');
    await unlink(file);
  }
}

export function validateLedger(value) {
  if (value?.version !== 1 || !value.clusters || typeof value.clusters !== 'object' || Array.isArray(value.clusters)) throw new Error('invalid ledger');
  for (const [key, entry] of Object.entries(value.clusters)) {
    if (!key.includes('::') || typeof entry?.issue?.id !== 'string' || !entry.issue.id || !Array.isArray(entry.evidence) || entry.evidence.some((x) => typeof x !== 'string')) throw new Error('invalid ledger cluster');
  }
  return value;
}

export async function assertOwner(dir, { host = os.hostname(), generation } = {}) {
  const owner = JSON.parse(await readFile(path.join(dir, 'owner.json'), 'utf8'));
  if (owner.version !== 1 || owner.host !== host || owner.enabled !== true || !Number.isSafeInteger(owner.generation) || owner.generation < 1 || (generation !== undefined && owner.generation !== generation)) throw new Error('inactive or stale writer generation');
  return owner;
}

export async function journalEvent(dir, event) {
  if (!/^[a-f0-9]{64}$/.test(event.id) || !['planned', 'attempted', 'confirmed', 'unknown', 'local_committed'].includes(event.phase)) throw new Error('invalid operation journal event');
  const journal = path.join(dir, 'operations');
  await privateDirectory(journal);
  return immutableJson(path.join(journal, `${event.id}-${event.phase}.json`), { ...event, at: new Date().toISOString() });
}

export async function operationState(dir, id) {
  const result = {};
  for (const phase of ['planned', 'attempted', 'confirmed', 'unknown', 'local_committed']) {
    const raw = await readOptional(path.join(dir, 'operations', `${id}-${phase}.json`));
    if (raw !== null) result[phase] = JSON.parse(raw);
  }
  return result;
}

// Copy allowlisted data, never HOME, credentials, session DBs or arbitrary paths.
// Stage is newly created and cannot overwrite a destination. Promotion is a separate
// quiescent operation by the supervisor after both schedules have been disabled.
export async function stageTransfer({ source, destination, files = ['filed.json'] }) {
  if (!Array.isArray(files) || !files.length || files.some((f) => f !== 'filed.json' && (typeof f !== 'string' || !/^operations\/[a-f0-9]{64}-(planned|attempted|confirmed|unknown|local_committed)\.json$/.test(f)))) throw new Error('transfer path not allowlisted');
  return withLock(source, async () => {
    const root = path.resolve(source);
    const inventory = await transferInventory(root);
    if (files.some((file) => !inventory.some((entry) => entry.path === file))) throw new Error('transfer source file missing');
    const manifest = inventory.map(({ raw, ...entry }) => entry);
    const sourceInventoryHash = digest(jsonBytes(manifest));
    const revalidate = async () => {
      const current = (await transferInventory(root)).map(({ raw, ...entry }) => entry);
      if (digest(jsonBytes(current)) !== sourceInventoryHash) throw new Error('transfer source inventory changed');
    };
    await revalidate();
    await privateDirectory(path.dirname(path.resolve(destination)));
    await mkdir(destination, { mode: 0o700 });
    await syncDirectory(path.dirname(path.resolve(destination)));
    for (const { path: file, raw, sha256 } of inventory) {
      const target = path.join(destination, file);
      await privateDirectory(path.dirname(target));
      const fd = await open(target, 'wx', 0o600);
      try { await fd.writeFile(raw); await fd.sync(); } finally { await fd.close(); }
      await syncDirectory(path.dirname(target));
      if (sha256 !== digest(await readFile(target))) throw new Error('transfer hash mismatch');
    }
    await revalidate();
    await immutableJson(path.join(destination, 'transfer.json'), { version: 1, complete: true, enabled: false, manifest, sourceInventoryHash });
    return manifest;
  });
}

async function transferInventory(root) {
  let names = [];
  const journal = path.join(root, 'operations');
  try {
    await checkPrivateDirectory(journal);
    names = await readdir(journal);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const files = ['filed.json', ...names.sort().map((name) => `operations/${name}`)];
  const inventory = [];
  const operations = new Map();
  for (const file of files) {
    const match = /^operations\/([a-f0-9]{64})-(planned|attempted|confirmed|unknown|local_committed)\.json$/.exec(file);
    if (file !== 'filed.json' && !match) throw new Error('invalid operation journal inventory');
    const origin = path.join(root, file);
    const stat = await lstat(origin);
    if (stat.isSymbolicLink() || await realpath(origin) !== origin) throw new Error('transfer symlink refused');
    if (!stat.isFile()) throw new Error('transfer source must be a regular file');
    const raw = await readFile(origin);
    const parsed = JSON.parse(raw);
    if (file === 'filed.json') validateLedger(parsed);
    else {
      if (parsed?.id !== match[1] || parsed.phase !== match[2]) throw new Error('invalid operation journal identity');
      const phases = operations.get(parsed.id) ?? new Set();
      phases.add(parsed.phase); operations.set(parsed.id, phases);
    }
    inventory.push({ path: file, bytes: raw.length, sha256: digest(raw), raw });
  }
  for (const phases of operations.values()) {
    if ((phases.has('attempted') || phases.has('unknown')) && !phases.has('confirmed') && !phases.has('local_committed')) throw new Error('unresolved remote operation');
  }
  return inventory;
}

export async function unresolvedOperations(dir) {
  let names;
  try { names = await readdir(path.join(dir, 'operations')); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const ids = new Set(names.filter((n) => n.endsWith('-attempted.json')).map((n) => n.slice(0, 64)));
  const unresolved = [];
  for (const id of ids) {
    const state = await operationState(dir, id);
    if (!state.confirmed && !state.local_committed) unresolved.push(id);
  }
  return unresolved;
}
