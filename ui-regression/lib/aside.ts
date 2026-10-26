import { spawn as uiAsideSpawn } from 'node:child_process';
import { constants as uiAsideFsConstants } from 'node:fs';
import { createHash as uiAsideHash, randomBytes as uiAsideRandom } from 'node:crypto';
import { lstat as uiAsideLstat, open as uiAsideOpen, unlink as uiAsideUnlink } from 'node:fs/promises';
import { join as uiAsideJoin } from 'node:path';
import { validateScenario, type UiScenario } from './scenario';
import { pluginResultsRoot, ensurePrivateResultDirectory } from '../../shared/lib/results';

export type UiExecution = {
  status: 'passed' | 'failed' | 'incomplete' | 'not_run' | 'unavailable';
  reason: string; exitCode: number | null; signal: string | null;
  runnerVersion: string | null; counts: null;
  assertions: { step: number; id: string; kind: 'visible' | 'text_exact' | 'text_substring'; status: 'passed' | 'failed' }[];
  steps: {step:number;action:'goto'|'click'|'fill'|'assert';status:'passed'|'failed'}[];
  cleanup: 'confirmed' | 'unconfirmed'; currentUiState: 'not_reobserved';
  browserBuildBinding: 'unverified'; scenarioDigest: string;
};
type UiAsideOutput = { exitCode: number | null; signal: string | null; stdout: string; stderr: string };
const uiAsideLimit = 1024 * 1024;
const uiAsideReasons = new Set(['complete', 'origin_drift', 'missing_target', 'ambiguous_target', 'hidden_target', 'assertion_failed', 'unsupported_control', 'runtime_error']);
function uiAsideResult(scenario: UiScenario, reason: string, status: UiExecution['status'] = 'incomplete'): UiExecution {
  return { status, reason, exitCode: null, signal: null, runnerVersion: null, counts: null, assertions: [], steps:[], cleanup: 'unconfirmed', currentUiState: 'not_reobserved', browserBuildBinding: 'unverified', scenarioDigest: uiAsideHash('sha256').update(JSON.stringify(scenario)).digest('hex') };
}

export function buildAsideCode(scenario: UiScenario, nonce: string): string {
  const clean = validateScenario(scenario);
  return `await (async function () {
const scenario = ${JSON.stringify(clean)};
const nonce = ${JSON.stringify(nonce)};
let owned = null, completed = 0, reason = 'complete';
const emit = frame => console.log('UI_ASIDE_FRAME ' + JSON.stringify({version:1,nonce,...frame}));
const norm = text => String(text).replace(/\\r\\n?/g,'\\n').trim();
const origin = new URL(scenario.steps[0].url).origin;
const check = () => { if (!owned || new URL(owned.url()).origin !== origin) throw 'origin_drift'; };
try {
for (let i = 0; i < scenario.steps.length; i++) {
const step = scenario.steps[i];
if (step.action === 'goto') {
if (!owned) { owned = await openTab(step.url); check(); console.log((await snapshot(owned)).tree); check(); }
else { await owned.goto(step.url,{timeout:5000}); check(); console.log((await snapshot(owned)).diff); check(); }
} else {
check(); console.log((await snapshot(owned,{selector:step.selector})).tree); check();
const locator = owned.locator(step.selector);
const count = await locator.count();
if (count === 0) throw 'missing_target';
if (count !== 1) throw 'ambiguous_target';
if (!await locator.isVisible()) throw 'hidden_target';
check();
if (step.action === 'click' || step.action === 'fill') {
const control = await locator.evaluate(el => ({tag:el.tagName.toLowerCase(),type:el.getAttribute('type'),target:el.getAttribute('target'),name:el.getAttribute('name') || '',id:el.id || '',autocomplete:el.getAttribute('autocomplete') || '',href:el.getAttribute('href'),text:el.textContent || ''}));
const sensitive = /password|credential|token|secret|payment|credit|account|login|sign.?in|checkout|billing|email|address|phone/i;
if (sensitive.test([control.name,control.id,control.autocomplete,control.text].join(' ')) || control.target || ['submit','file','password','hidden','image'].includes(control.type)) throw 'unsupported_control';
if (step.action === 'click') {
if (control.tag !== 'button' || control.type !== 'button') throw 'unsupported_control';
await locator.click({timeout:5000});
} else {
if (!(control.tag === 'textarea' || (control.tag === 'input' && (!control.type || control.type === 'text')))) throw 'unsupported_control';
await locator.fill(step.value,{timeout:5000});
}
check(); console.log((await snapshot(owned,{selector:step.selector})).diff); check();
} else if (step.kind === 'text') {
const actual = norm(await locator.innerText({timeout:5000})), expected = norm(step.expected);
if (!(step.match === 'exact' ? actual === expected : expected.length > 0 && actual.includes(expected))) { emit({type:'step',step:i,status:'failed',assertion:true}); throw 'assertion_failed'; }
}
}
check(); completed++; emit({type:'step',step:i,status:'passed',assertion:step.action === 'assert'});
}
} catch (error) { reason = ${JSON.stringify([...uiAsideReasons])}.includes(error) ? error : 'runtime_error'; }
finally {
let cleanup = 'unconfirmed';
if (owned) { try { await closeTab(owned); cleanup = 'confirmed'; } catch {} }
emit({type:'terminal',completed,reason}); emit({type:'cleanup',status:cleanup});
}
})();`;
}

export function parseAsideObservations(stdout: string, nonce: string, scenario: UiScenario, exitCode: number | null): UiExecution {
  const result = uiAsideResult(scenario, 'missing_observations');
  result.exitCode = exitCode;
  if (Buffer.byteLength(stdout) > uiAsideLimit) { result.reason = 'output_overflow'; return result; }
  let completed = 0, terminal = false, cleanup = false, failed = false;
  try {
    for (const line of stdout.split('\n')) {
      if (!line.startsWith('UI_ASIDE_FRAME ')) continue;
      if (Buffer.byteLength(line) > 65536) throw new Error();
      const frame = JSON.parse(line.slice(15));
      if (frame.version !== 1 || frame.nonce !== nonce) throw new Error();
      const keys = Object.keys(frame).sort().join(',');
      if (frame.type === 'step') {
        if (terminal || failed || keys !== 'assertion,nonce,status,step,type,version' || frame.step !== completed || !['passed','failed'].includes(frame.status) || frame.assertion !== (scenario.steps[completed]?.action === 'assert') || completed >= scenario.steps.length) throw new Error();
        result.steps.push({step:completed,action:scenario.steps[completed].action,status:frame.status});
        if (frame.assertion) {
          const assertion = scenario.steps[completed];
          if (assertion.action !== 'assert') throw new Error();
          result.assertions.push({step:completed,id:'step-'+completed,kind:assertion.kind === 'visible' ? 'visible' : assertion.match === 'exact' ? 'text_exact' : 'text_substring',status:frame.status});
        }
        if (frame.status === 'failed') failed = true; else completed++;
      } else if (frame.type === 'terminal') {
        if (terminal || keys !== 'completed,nonce,reason,type,version' || frame.completed !== completed || !uiAsideReasons.has(frame.reason)) throw new Error();
        terminal = true; result.reason = frame.reason;
      } else if (frame.type === 'cleanup') {
        if (!terminal || cleanup || keys !== 'nonce,status,type,version' || !['confirmed','unconfirmed'].includes(frame.status)) throw new Error();
        cleanup = true; result.cleanup = frame.status;
      } else throw new Error();
    }
  } catch { result.reason = 'malformed_observations'; return result; }
  if (!terminal || !cleanup) { result.reason = 'missing_observations'; return result; }
  if (result.cleanup !== 'confirmed') { result.reason = 'cleanup_unconfirmed'; return result; }
  if (exitCode !== 0) { result.reason = 'runner_exit'; return result; }
  if (result.reason !== 'complete' || failed) { result.status = 'failed'; return result; }
  if (completed !== scenario.steps.length || result.assertions.length < 1) { result.reason = 'partial_observations'; return result; }
  result.status = 'passed'; return result;
}

async function uiAsideInvoke(args: string[], signal: AbortSignal): Promise<UiAsideOutput> {
  return new Promise((resolve, reject) => {
    const env: Record<string,string> = {};
    for (const key of ['HOME','PATH','TMPDIR']) if (process.env[key]) env[key] = process.env[key]!;
    const child = uiAsideSpawn('aside', args, { env, shell:false, detached:true, stdio:['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', bytes = 0, overflow = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    let reapTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const groupGone = () => {
      if (!child.pid) return true;
      try { process.kill(-child.pid,0); return false; }
      catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
    };
    const finish = (error?: Error, output?: UiAsideOutput) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort',terminate);
      if (killTimer) clearTimeout(killTimer);
      if (reapTimer) clearTimeout(reapTimer);
      if (error) reject(error); else resolve(output!);
    };
    const terminate = () => {
      if (child.pid) { try { process.kill(-child.pid,'SIGTERM'); } catch {} }
      killTimer ??= setTimeout(() => { if (child.pid) { try { process.kill(-child.pid,'SIGKILL'); } catch {} } }, 250);
      reapTimer ??= setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(Object.assign(new Error('cleanup_unconfirmed'),{retainLock:!groupGone()}));
      },2500);
    };
    const collect = (chunk: Buffer, error: boolean) => {
      bytes += chunk.length;
      if (bytes > uiAsideLimit) { overflow = true; terminate(); return; }
      if (error) stderr += chunk.toString(); else stdout += chunk.toString();
    };
    child.stdout.on('data', chunk => collect(chunk,false)); child.stderr.on('data', chunk => collect(chunk,true));
    signal.addEventListener('abort',terminate,{once:true});
    if (signal.aborted) terminate();
    child.once('error', error => { if (!child.pid) finish(error); else terminate(); });
    child.once('close',(exitCode, exitSignal) => {
      if (!groupGone()) { terminate(); return; }
      if (overflow) finish(new Error('output_overflow'));
      else finish(undefined,{exitCode,signal:exitSignal,stdout,stderr});
    });
  });
}

async function uiAsidePrepareLockDir(dir: string): Promise<void> {
  await ensurePrivateResultDirectory(dir);
}

export async function runAsideScenario(scenario: UiScenario, account: string, timeoutMs = 60000, signal?: AbortSignal, deps?: { invoke?: (args:string[],signal:AbortSignal)=>Promise<UiAsideOutput>; lockDir?:string }): Promise<UiExecution> {
  const clean = validateScenario(scenario);
  if (!account || account.length > 256 || /[\x00-\x1f\x7f]/.test(account)) return uiAsideResult(clean,'missing_account','not_run');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 90000) return uiAsideResult(clean,'invalid_timeout','not_run');
  if (signal?.aborted) return uiAsideResult(clean,'cancelled','not_run');
  const dir = deps?.lockDir ?? uiAsideJoin(pluginResultsRoot(),'ui-regression','locks');
  const path = uiAsideJoin(dir,'run.lock');
  let lock: Awaited<ReturnType<typeof uiAsideOpen>> | undefined;
  let lockIdentity: {dev:number;ino:number} | undefined;
  let directoryIdentity: {dev:number;ino:number} | undefined;
  try {
    await uiAsidePrepareLockDir(dir);
    const info = await uiAsideLstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o7777) !== 0o700 || info.uid !== process.getuid?.()) return uiAsideResult(clean,'unsafe_lock','not_run');
    directoryIdentity = info;
    lock = await uiAsideOpen(path,uiAsideFsConstants.O_WRONLY | uiAsideFsConstants.O_CREAT | uiAsideFsConstants.O_EXCL | uiAsideFsConstants.O_NOFOLLOW,0o600);
    const opened = await lock.stat();lockIdentity = opened;
    if (!opened.isFile() || opened.nlink !== 1 || opened.uid !== process.getuid?.() || (opened.mode & 0o7777) !== 0o600) throw Error('unsafe_lock');
    const after = await uiAsideLstat(dir);
    if (after.dev !== info.dev || after.ino !== info.ino || after.isSymbolicLink()) {
      await lock.close();
      return uiAsideResult(clean,'unsafe_lock','not_run');
    }
  } catch (error) { await lock?.close().catch(()=>{});return uiAsideResult(clean,(error as NodeJS.ErrnoException).code === 'EEXIST' ? 'busy' : 'lock_unavailable','not_run'); }
  const controller = new AbortController();
  let retainLock = false;
  let observed: UiExecution | undefined;
  let mockTimer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const cancel = () => controller.abort();
  signal?.addEventListener('abort',cancel,{once:true});
  if (signal?.aborted) cancel();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); },timeoutMs);
  try {
    const nonce = uiAsideRandom(24).toString('hex');
    // The scenario origin is strictly loopback, so the browser must run on this
    // machine: pin the local session host. A cloud session host can never reach
    // the loopback fixture and every run would end in origin_drift (JJO-745).
    const invocation = (deps?.invoke ?? uiAsideInvoke)(['repl','--host','local','--account',account,buildAsideCode(clean,nonce)],controller.signal);
    const output = deps?.invoke ? await Promise.race([invocation,new Promise<never>((_resolve,reject) => {
      const abort = () => { mockTimer = setTimeout(() => reject(new Error('cleanup_unconfirmed')),100); };
      if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort',abort,{once:true});
    })]) : await invocation;
    const result = parseAsideObservations(output.stdout,nonce,clean,output.exitCode);
    observed = result;
    result.signal = output.signal;
    if (output.signal) { result.status = 'incomplete'; result.reason = 'runner_signal'; }
    if (Buffer.byteLength(output.stdout) + Buffer.byteLength(output.stderr) > uiAsideLimit) { result.status = 'incomplete'; result.reason = 'output_overflow'; }
    if (controller.signal.aborted) { result.status = 'incomplete'; result.reason = timedOut ? 'timeout' : 'cancelled'; result.cleanup = 'unconfirmed'; }
    return result;
  } catch (error) {
    retainLock = (error as Error & {retainLock?:boolean}).retainLock === true;
    const code = (error as NodeJS.ErrnoException).code;
    observed = uiAsideResult(clean,(error as Error).message === 'cleanup_unconfirmed' ? 'cleanup_unconfirmed' : controller.signal.aborted ? (timedOut ? 'timeout' : 'cancelled') : (error as Error).message === 'output_overflow' ? 'output_overflow' : code === 'ENOENT' ? 'missing_cli' : 'runner_unavailable',code === 'ENOENT' ? 'unavailable' : 'incomplete');
    return observed;
  } finally {
    clearTimeout(timer);if(mockTimer)clearTimeout(mockTimer);signal?.removeEventListener('abort',cancel);
    let released = retainLock;
    try {
      if (!retainLock) {
        await ensurePrivateResultDirectory(dir,false);
        const parent = await uiAsideLstat(dir),current = await uiAsideLstat(path),opened = await lock!.stat();
        if (!directoryIdentity || parent.dev !== directoryIdentity.dev || parent.ino !== directoryIdentity.ino || !lockIdentity || current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino || opened.dev !== lockIdentity.dev || opened.ino !== lockIdentity.ino || !current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.uid !== process.getuid?.() || (current.mode & 0o7777) !== 0o600) throw Error('unsafe_lock');
        await uiAsideUnlink(path);released = true;
      }
    } catch {} finally {try{await lock!.close();}catch{released=false;}}
    if (!released && observed) {observed.status='incomplete';observed.reason='unsafe_lock';}
  }
}
