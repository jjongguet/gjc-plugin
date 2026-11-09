import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createScheduler, LABEL, parseSchedulerArgs } from '../lib/scheduler.mjs';

function fixture(t, extra = {}) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nightly-scheduler-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'schedule.json');
  const schedule = { version: 1, ownerHost: 'test-host', timezone: 'Asia/Seoul', repos: ['gjc-plugin'], hour: 5, minute: 0 };
  fs.writeFileSync(config, JSON.stringify(schedule));
  const calls = [];
  const mutations = [];
  const io = new Proxy(fs, {
    get(target, key) {
      if (['mkdirSync', 'writeFileSync', 'renameSync', 'unlinkSync'].includes(key)) return (...args) => { mutations.push(key); return target[key](...args); };
      return target[key];
    },
  });
  let loaded = false;
  const run = createScheduler({
    home, hostname: 'test-host', timezone: 'Asia/Seoul', uid: process.getuid(), platform: 'darwin', fs: io,
    exec(args) {
      calls.push(args);
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'bootout') loaded = false;
      if (args[0] === 'print' && args[1].endsWith(`/${LABEL}`)) return { status: loaded ? 0 : 113, stdout: loaded ? 'state = waiting' : '', stderr: loaded ? '' : 'service not found' };
      return { status: 0, stdout: 'gui domain', stderr: '' };
    },
    ...extra,
  });
  const options = { command: 'install', config, node: fs.realpathSync(process.execPath) };
  const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  return { home, config, schedule, run, calls, mutations, options, plist };
}

test('preview renders only absolute prepare argv and daily 05:00, without paid or automatic GJC flags', (t) => {
  const f = fixture(t);
  const result = f.run({ ...f.options, command: 'preview' });
  assert.deepEqual(result.plan.argv, [f.options.node, fs.realpathSync(fileURLToPath(new URL('../bin/nightly-review.mjs', import.meta.url))), 'prepare', '--mode', 'scheduled', '--config', f.config, '--out', path.join(f.home, '.gjc-plugin', 'nightly-review', 'scheduled'), '--json']);
  assert.match(result.plan.plistBytes, /<integer>5<\/integer>.*<integer>0<\/integer>/);
  assert.doesNotMatch(result.plan.plistBytes, /RunAtLoad|KeepAlive|--publish|once|loop|gjc run|--file-findings|--deadline/);
  assert.match(result.plan.plistBytes, /\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin/);
  assert.ok(result.plan.plistBytes.includes(`<key>HOME</key><string>${f.home}</string>`));
  assert.deepEqual(f.mutations, []);
});

test('install without --publish has zero filesystem or launchctl mutations', (t) => {
  const f = fixture(t);
  assert.equal(f.run(f.options).published, false);
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(f.calls, [['print', `gui/${process.getuid()}`]]);
  assert.equal(fs.existsSync(f.plist), false);
});

test('parser rejects unknown, duplicate, missing and paid flags', () => {
  for (const argv of [['install', '--paid'], ['install', '--config'], ['status', '--publish'], ['uninstall', '--config', '/x'], ['preview', '--publish'], ['install', '--json', '--json'], ['once']]) {
    assert.throws(() => parseSchedulerArgs(argv));
  }
  assert.deepEqual(parseSchedulerArgs(['install', '--config', '/schedule.json', '--publish', '--json']), { command: 'install', config: '/schedule.json', publish: true, json: true });
});

test('host and timezone must match exactly and schedule cannot enable a paid command', (t) => {
  const f = fixture(t);
  for (const update of [{ ownerHost: 'TEST-HOST' }, { timezone: 'UTC' }, { timezone: 'Not/AZone' }, { hour: 6 }, { minute: 1 }, { version: 2 }, { repos: [] }, { command: 'once' }]) {
    fs.writeFileSync(f.config, JSON.stringify({ ...f.schedule, ...update }));
    assert.throws(() => f.run(f.options), /ownerHost|timezone|invalid schedule/);
  }
  assert.deepEqual(f.mutations, []);
});

test('relative, missing, symlink and arbitrary entry paths fail closed', (t) => {
  const f = fixture(t);
  const link = path.join(f.home, 'linked.json');
  fs.symlinkSync(f.config, link);
  const otherEntry = path.join(f.home, 'other.mjs');
  fs.writeFileSync(otherEntry, '');
  for (const update of [{ config: 'relative.json' }, { config: path.join(f.home, 'missing.json') }, { config: link }, { node: 'node' }, { node: fs.realpathSync('/bin/sh') }, { entry: otherEntry }, { out: 'relative' }, { out: f.config }]) {
    assert.throws(() => f.run({ ...f.options, ...update }));
  }
  assert.deepEqual(f.mutations, []);
});

test('absent GUI domain prevents even published installation', (t) => {
  const f = fixture(t, { exec: () => ({ status: 113, stderr: 'domain not found' }) });
  assert.throws(() => f.run({ ...f.options, publish: true }), /existing gui UID domain required/);
  assert.deepEqual(f.mutations, []);
});

test('existing different plist cannot be overwritten', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.plist), { recursive: true });
  fs.writeFileSync(f.plist, 'not ours');
  assert.throws(() => f.run({ ...f.options, publish: true }), /different content/);
  assert.equal(fs.readFileSync(f.plist, 'utf8'), 'not ours');
  assert.deepEqual(f.mutations, []);
  assert.ok(f.calls.every(([command]) => command === 'print'));
});

test('status reports actual launchctl state and source freshness; uninstall preserves disabled receipt', (t) => {
  const f = fixture(t);
  const installed = f.run({ ...f.options, publish: true });
  assert.equal(installed.published, true);
  assert.deepEqual(f.calls.find(([command]) => command === 'bootstrap'), ['bootstrap', `gui/${process.getuid()}`, f.plist]);
  const receiptPath = path.join(f.home, '.gjc-plugin', 'nightly-review', 'scheduler-install.json');
  assert.equal(fs.statSync(receiptPath).mode & 0o077, 0);
  const status = f.run({ command: 'status' });
  assert.equal(status.actual.status, 0);
  assert.equal(status.freshness.fresh, true);
  fs.writeFileSync(f.config, JSON.stringify({ ...f.schedule, repos: ['another/repo'] }));
  assert.equal(f.run({ command: 'status' }).freshness.checks.config, false);
  assert.equal(f.run({ command: 'uninstall' }).state, 'disabled');
  assert.equal(fs.existsSync(f.plist), false);
  assert.equal(JSON.parse(fs.readFileSync(receiptPath, 'utf8')).state, 'disabled');
  assert.equal(f.run({ command: 'status' }).actual.status, 113);
});

test('uninstall refuses modified plist before bootout or deletion', (t) => {
  const f = fixture(t);
  f.run({ ...f.options, publish: true });
  fs.appendFileSync(f.plist, '\n<!-- changed -->');
  f.calls.length = 0;
  f.mutations.length = 0;
  assert.throws(() => f.run({ command: 'uninstall' }), /hash mismatch/);
  assert.ok(fs.existsSync(f.plist));
  assert.deepEqual(f.mutations, []);
  assert.ok(f.calls.every(([command]) => command === 'print'));
});

test('failed bootstrap removes only owned plist and preserves a disabled receipt', (t) => {
  const f = fixture(t, { exec: ([command]) => ({ status: command === 'bootstrap' ? 5 : 0, stderr: command === 'bootstrap' ? 'bootstrap failed' : '' }) });
  assert.throws(() => f.run({ ...f.options, publish: true }), /bootstrap failed/);
  assert.equal(fs.existsSync(f.plist), false);
  const receipt = JSON.parse(fs.readFileSync(path.join(f.home, '.gjc-plugin', 'nightly-review', 'scheduler-install.json'), 'utf8'));
  assert.equal(receipt.state, 'disabled');
});
