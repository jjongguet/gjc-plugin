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
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if ((await lstat(dir)).isSymbolicLink()) throw new Error('symlink state directory refused');
  if (path.resolve(dir) !== await realpath(dir)) throw new Error('symlink state ancestor refused');
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
    const directory = await open(path.dirname(file), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temporary).catch(() => {}); throw error; }
}

export async function immutableJson(file, value) {
  await privateDirectory(path.dirname(file));
  const fd = await open(file, 'wx', 0o600);
  try { await fd.writeFile(jsonBytes(value)); await fd.sync(); }
  finally { await fd.close(); }
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
  if (!files.length || files.some((f) => f !== 'filed.json' && !/^operations\/[a-f0-9]{64}-(planned|attempted|confirmed|unknown|local_committed)\.json$/.test(f))) throw new Error('transfer path not allowlisted');
  await mkdir(destination, { mode: 0o700 });
  const root = await realpath(source);
  const manifest = [];
  for (const file of files) {
    const origin = path.join(root, file);
    if ((await lstat(origin)).isSymbolicLink() || await realpath(origin) !== origin) throw new Error('transfer symlink refused');
    const raw = await readFile(origin);
    const parsed = JSON.parse(raw);
    if (file === 'filed.json') validateLedger(parsed);
    else if (parsed.phase === 'unknown' || parsed.phase === 'attempted') {
      const states = await operationState(root, parsed.id);
      if (!states.confirmed && !states.local_committed) throw new Error('unresolved remote operation');
    }
    await privateDirectory(path.dirname(path.join(destination, file)));
    const fd = await open(path.join(destination, file), 'wx', 0o600);
    try { await fd.writeFile(raw); await fd.sync(); } finally { await fd.close(); }
    const copied = await readFile(path.join(destination, file));
    if (digest(raw) !== digest(copied)) throw new Error('transfer hash mismatch');
    manifest.push({ path: file, bytes: raw.length, sha256: digest(raw) });
  }
  await immutableJson(path.join(destination, 'transfer.json'), { version: 1, manifest });
  return manifest;
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
