import { spawn as vrNodeSpawn } from 'node:child_process';
import { lstatSync as vrNodeLstat, realpathSync as vrNodeRealpath, mkdtempSync as vrNodeMkdtemp, writeFileSync as vrNodeWrite, rmSync as vrNodeRemove, statSync as vrNodeStat, accessSync as vrNodeAccess, constants as vrNodeConstants } from 'node:fs';
import { resolve as vrNodeResolve, relative as vrNodeRelative, isAbsolute as vrNodeAbsolute, join as vrNodeJoin, delimiter as vrNodeDelimiter, sep as vrNodeSep } from 'node:path';
import { tmpdir as vrNodeTmpdir } from 'node:os';
import { randomBytes as vrNodeRandom } from 'node:crypto';

export type NodeExecution = {
  status: 'passed' | 'failed' | 'no_tests' | 'incomplete' | 'not_run' | 'unavailable';
  reason: string;
  exitCode: number | null;
  signal: string | null;
  runnerVersion: string | null;
  counts: null | { tests: number; suites: number; topLevel: number; passed: number; failed: number; skipped: number; todo: number; cancelled: number };
};
// Commands a failing test could not start because they are absent from the runner PATH. Kept out of
// the execution record, which must stay receipt-shaped, and out of every outbound payload.
export type NodeRunDiagnostics = { missingBinaries: string[] };

export function validateTestFiles(root: string, files: string[]): string[] {
  const reject = (code: string): never => { throw new Error(code); };
  if (!Array.isArray(files) || files.length < 1 || files.length > 32) reject('invalid_file_count');
  let base: string;
  try { if (vrNodeLstat(root).isSymbolicLink()) reject('invalid_root'); base = vrNodeRealpath(root); if (!vrNodeLstat(base).isDirectory()) reject('invalid_root'); }
  catch { return reject('invalid_root'); }
  const result: string[] = [];
  for (const file of files) {
    if (typeof file !== 'string' || file.length > 4096 || !file || file.includes('\0') || vrNodeAbsolute(file) || file.includes('\\') || file.split('/').some(p => p === '..' || p.startsWith('-')) || !/\.(?:js|mjs|cjs)$/.test(file)) reject('invalid_test_path');
    const target = vrNodeResolve(base, file);
    const rel = vrNodeRelative(base, target);
    if (!rel || rel.startsWith(`..${vrNodeSep}`) || vrNodeAbsolute(rel)) reject('path_escape');
    try {
      let cursor = base;
      for (const part of rel.split(vrNodeSep)) {
        cursor = vrNodeJoin(cursor, part);
        if (vrNodeLstat(cursor).isSymbolicLink()) reject('symlink_test_path');
      }
      if (!vrNodeLstat(target).isFile()) reject('invalid_test_file');
      if (vrNodeRealpath(target) !== target) reject('path_escape');
    } catch (error) {
      if (error instanceof Error && ['symlink_test_path', 'invalid_test_file', 'path_escape'].includes(error.message)) throw error;
      reject('missing_test_file');
    }
    if (result.includes(target)) reject('duplicate_test_file');
    result.push(target);
  }
  return result;
}

// This reporter forwards only the final native cumulative summary plus the bare command names of
// spawn ENOENT failures, never test names, messages or other diagnostics.
const vrNodeReporterSource = `
export default async function* (source) {
  let summary = null, bytes = 0, overflow = false, actualPassed = false, failures = 0;
  const missing = new Map();
  const commandName = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;
  const missingCommand = error => {
    for (let e = error, depth = 0; e !== null && typeof e === 'object' && depth < 4; e = e.cause, depth++) {
      if (e.code === 'ENOENT' && typeof e.syscall === 'string' && /^spawn(?:Sync)? /.test(e.syscall) && typeof e.path === 'string' && commandName.test(e.path)) return e.path;
    }
    return null;
  };
  for await (const event of source) {
    if (event.type === 'test:stdout' || event.type === 'test:stderr' || event.type === 'test:diagnostic') {
      bytes += Buffer.byteLength(String(event.data?.message ?? ''));
      if (bytes > 1048576) { overflow = true; yield 'VR_OVERFLOW\\n'; }
    }
    if (event.type === 'test:fail') {
      const error = event.data?.details?.error;
      const failureType = error?.failureType;
      if (failureType !== 'subtestsFailed' && failureType !== 'cancelledByParent') {
        failures++;
        const name = missingCommand(error);
        if (name !== null && (missing.has(name) || missing.size < 8)) missing.set(name, (missing.get(name) ?? 0) + 1);
      }
    }
    if (event.type === 'test:summary' && event.data?.file !== undefined && event.data.counts?.tests > 0 && event.data.counts?.passed > 0) actualPassed = true;
    if (event.type === 'test:summary' && event.data?.file === undefined) {
      if (summary !== null) { summary = { malformed: true }; continue; }
      const d = event.data;
      summary = { success: d.success, counts: d.counts };
    }
  }
  yield 'VR_FRAME_' + NONCE + ':' + JSON.stringify({ summary, overflow, actualPassed, failures, missing: [...missing] }) + '\\n';
}
`;

// Only absolute PATH entries reach tests: a relative entry would resolve inside the repository.
function vrNodeSearchPath(): string[] {
  const directories: string[] = [];
  for (const directory of (process.env.PATH ?? '').split(vrNodeDelimiter)) if (directory && vrNodeAbsolute(directory) && !directories.includes(directory)) directories.push(directory);
  return directories;
}
function vrNodeOnPath(directories: string[], name: string): boolean {
  for (const directory of directories) {
    try { const candidate = vrNodeJoin(directory, name); vrNodeAccess(candidate, vrNodeConstants.X_OK); if (vrNodeStat(candidate).isFile()) return true; } catch { /* Try the next directory. */ }
  }
  return false;
}

type VrNodeProcessResult = { code: number | null; signal: string | null; output: string; issue: string | null };
async function vrNodeProcess(executable: string, args: string[], cwd: string, searchPath: string, timeout: number, abort?: AbortSignal): Promise<VrNodeProcessResult> {
  if (abort?.aborted) return { code: null, signal: null, output: '', issue: 'cancelled' };
  return new Promise(resolve => {
    let output = '', bytes = 0, issue: string | null = null, settled = false;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    // PATH lets tests start the same programs a normal shell finds; HOME, credentials and every
    // other inherited variable stay out of the test process.
    const child = vrNodeSpawn(executable, args, { cwd, env: { LANG: 'C', TZ: 'UTC', PATH: searchPath }, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = (sig: NodeJS.Signals) => {
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig); else child.kill(sig); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') issue = 'cleanup_unresolved'; }
    };
    const finish = (code: number | null, sig: string | null) => {
      if (settled) return;
      settled = true; clearTimeout(timer); clearTimeout(forceTimer); clearTimeout(reapTimer);
      abort?.removeEventListener('abort', cancel);
      // Close confirms leader termination, not disappearance of its owned group.
      kill('SIGKILL');
      const cleanupDeadline = Date.now() + 1000;
      const confirmCleanup = () => {
        if (process.platform === 'win32' || !child.pid) {
          resolve({ code, signal: sig, output, issue });
          return;
        }
        try { process.kill(-child.pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') issue = 'cleanup_unconfirmed';
          resolve({ code, signal: sig, output, issue });
          return;
        }
        if (Date.now() >= cleanupDeadline) {
          issue = 'cleanup_unconfirmed';
          resolve({ code, signal: sig, output, issue });
          return;
        }
        setTimeout(confirmCleanup, 25);
      };
      confirmCleanup();
    };
    const stop = (why: string) => {
      if (issue) return;
      issue = why; kill('SIGTERM');
      forceTimer = setTimeout(() => kill('SIGKILL'), 150);
      reapTimer = setTimeout(() => { issue = 'cleanup_unresolved'; child.stdout.destroy(); child.stderr.destroy(); child.unref(); finish(null, null); }, 2500);
    };
    const cancel = () => stop('cancelled');
    const timer = setTimeout(() => stop('timeout'), timeout);
    abort?.addEventListener('abort', cancel, { once: true });
    if (abort?.aborted) cancel();
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1048576) stop('output_limit');
      else { output += chunk.toString('utf8'); if (output.includes('VR_OVERFLOW\n')) stop('output_limit'); }
    });
    child.stderr.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 1048576) stop('output_limit'); });
    child.on('error', () => { issue = 'spawn_unavailable'; finish(null, null); });
    child.on('close', finish);
  });
}

export async function runNodeTests(root: string, files: string[], timeoutMs = 30000, signal?: AbortSignal, diagnostics?: NodeRunDiagnostics): Promise<NodeExecution> {
  const receipt: NodeExecution = { status: 'not_run', reason: 'not_run', exitCode: null, signal: null, runnerVersion: null, counts: null };
  if (diagnostics) diagnostics.missingBinaries = [];
  let paths: string[];
  try { paths = validateTestFiles(root, files); }
  catch (error) { receipt.reason = error instanceof Error ? error.message : 'invalid_test_path'; return receipt; }
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > 120000) return { ...receipt, reason: 'invalid_timeout' };
  if (signal?.aborted) return { ...receipt, reason: 'cancelled' };
  if (process.platform === 'win32') return { ...receipt, status: 'unavailable', reason: 'process_groups_unavailable' };
  const searchPath = vrNodeSearchPath();
  let executable: string | null = null;
  for (const directory of searchPath) {
    try { const candidate = vrNodeRealpath(vrNodeJoin(directory, 'node')); if (vrNodeLstat(candidate).isFile()) { executable = candidate; break; } } catch { /* Try the next explicit PATH directory. */ }
  }
  if (!executable) return { ...receipt, status: 'unavailable', reason: 'node_unavailable' };
  const childPath = searchPath.join(vrNodeDelimiter);
  const base = vrNodeRealpath(root);
  const probe = await vrNodeProcess(executable, ['--version'], base, childPath, Math.min(timeoutMs, 5000), signal);
  const version = probe.output.trim();
  if (probe.issue || probe.code !== 0 || !/^v\d+\.\d+\.\d+$/.test(version)) return { ...receipt, status: 'unavailable', reason: probe.issue ?? 'invalid_node_version' };
  receipt.runnerVersion = version;
  if (Number(version.split('.')[0].slice(1)) < 22) return { ...receipt, status: 'unavailable', reason: 'unsupported_node_version' };
  let directory: string | null = null;
  try {
    directory = vrNodeMkdtemp(vrNodeJoin(vrNodeTmpdir(), 'verification-node-'));
    const reporter = vrNodeJoin(directory, 'reporter.mjs');
    const nonce = vrNodeRandom(24).toString('hex');
    vrNodeWrite(reporter, `const NONCE = ${JSON.stringify(nonce)};\n${vrNodeReporterSource}`, { mode: 0o600, flag: 'wx' });
    const execution = await vrNodeProcess(executable, ['--test', `--test-reporter=${reporter}`, '--', ...paths], base, childPath, timeoutMs, signal);
    receipt.exitCode = execution.code; receipt.signal = execution.signal;
    receipt.status = 'incomplete'; receipt.reason = execution.issue ?? 'missing_summary';
    if (!execution.issue) {
      const prefix = `VR_FRAME_${nonce}:`;
      const frames = execution.output.split('\n').filter(line => line.startsWith(prefix));
      if (frames.length !== 1 || Buffer.byteLength(frames[0]) > 65536) receipt.reason = 'invalid_summary_frame';
      else {
        try {
          const frame = JSON.parse(frames[0].slice(prefix.length));
          const counts = frame.summary?.counts;
          const keys = ['tests', 'suites', 'topLevel', 'passed', 'failed', 'skipped', 'todo', 'cancelled'] as const;
          const bounded = (value: unknown, min: number) => Number.isSafeInteger(value) && Number(value) >= min && Number(value) <= 10000;
          const missing = frame.missing;
          if (frame.overflow || typeof frame.actualPassed !== 'boolean' || typeof frame.summary?.success !== 'boolean' || !counts || !keys.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0 && counts[key] <= 10000)) throw new Error('invalid');
          if (!bounded(frame.failures, 0) || !Array.isArray(missing) || missing.length > 8 || !missing.every(entry => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/.test(entry[0]) && bounded(entry[1], 1)) || new Set(missing.map(entry => entry[0])).size !== missing.length) throw new Error('invalid');
          receipt.counts = Object.fromEntries(keys.map(key => [key, counts[key]])) as NonNullable<NodeExecution['counts']>;
          if (execution.signal || execution.code === null) receipt.reason = 'runner_crash';
          else if (!frame.summary.success || counts.failed > 0 || counts.cancelled > 0 || execution.code !== 0) {
            // ENOENT also covers a missing spawn cwd, so only names the runner PATH cannot resolve count.
            const absent = (missing as [string, number][]).filter(([name]) => !vrNodeOnPath(searchPath, name));
            const attributed = absent.reduce((total, [, count]) => total + count, 0);
            if (diagnostics) diagnostics.missingBinaries = absent.map(([name]) => name);
            receipt.status = 'failed'; receipt.reason = attributed > 0 && attributed === frame.failures ? 'missing_binary' : 'native_failure';
          }
          else if (!frame.actualPassed || counts.tests === 0 || counts.passed === 0) { receipt.status = 'no_tests'; receipt.reason = 'no_actual_passes'; }
          else { receipt.status = 'passed'; receipt.reason = 'native_success'; }
        } catch { receipt.reason = 'invalid_summary_frame'; }
      }
    }
  } catch { receipt.status = 'incomplete'; receipt.reason = 'runner_setup_failed'; }
  finally {
    if (directory) try { vrNodeRemove(directory, { recursive: true, force: true }); }
    catch { receipt.status = 'incomplete'; receipt.reason = 'cleanup_unresolved'; }
  }
  return receipt;
}
