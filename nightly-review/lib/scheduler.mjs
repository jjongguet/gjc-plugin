import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export const LABEL = 'org.jjongguet.nightly-review';
const ENTRY = fileURLToPath(new URL('../bin/nightly-review.mjs', import.meta.url));
const TEMPLATE = fileURLToPath(new URL('../scheduler/org.jjongguet.nightly-review.plist.in', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const xml = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function parseSchedulerArgs(argv) {
  const [command, ...tokens] = argv;
  if (!['preview', 'install', 'status', 'uninstall'].includes(command)) throw new Error('expected preview, install, status or uninstall');
  const options = { command };
  const seen = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (seen.has(token)) throw new Error(`duplicate option: ${token}`);
    seen.add(token);
    if (token === '--json') options.json = true;
    else if (token === '--publish' && command === 'install') options.publish = true;
    else if (['--node', '--entry', '--config', '--out'].includes(token) && ['preview', 'install'].includes(command)) {
      const value = tokens[++i];
      if (!value || value.startsWith('--')) throw new Error(`${token} needs a value`);
      options[token.slice(2)] = value;
    } else throw new Error(`unknown option: ${token}`);
  }
  return options;
}

export function createScheduler(overrides = {}) {
  const io = overrides.fs ?? fs;
  const exec = overrides.exec ?? ((args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 10000, maxBuffer: 256 * 1024 }));
  const home = overrides.home ?? os.homedir();
  const hostname = overrides.hostname ?? os.hostname();
  const timezone = overrides.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const uid = overrides.uid ?? process.getuid?.();
  const platform = overrides.platform ?? process.platform;

  // Check every existing component, including parents of destinations not yet created.
  function safePath(value, kind, mustExist = true) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0') || path.normalize(value) !== value) throw new Error(`invalid absolute path: ${kind}`);
    let current = path.parse(value).root;
    for (const part of value.slice(current.length).split('/').filter(Boolean)) {
      current = path.join(current, part);
      try {
        if (io.lstatSync(current).isSymbolicLink()) throw new Error(`symlink path forbidden: ${kind}`);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    if (mustExist) {
      const stat = io.statSync(value);
      if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) throw new Error(`invalid ${kind} type`);
      if (io.realpathSync(value) !== value) throw new Error(`noncanonical path: ${kind}`);
    }
    return value;
  }

  function locations() {
    if (platform !== 'darwin' || !Number.isInteger(uid) || uid <= 0) throw new Error('user macOS launchd UID required; no sudo');
    safePath(home, 'directory');
    const root = path.join(home, '.gjc-plugin', 'nightly-review');
    const plist = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const receipt = path.join(root, 'scheduler-install.json');
    for (const value of [root, plist, receipt]) safePath(value, 'destination', false);
    return { root, plist, receipt, domain: `gui/${uid}` };
  }

  function launch(args, required = true) {
    const result = exec(args);
    const state = { status: result.status ?? null, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.message ?? null };
    if (required && (state.status !== 0 || state.error)) throw new Error(`launchctl ${args[0]} failed: ${state.status ?? state.error}`);
    return state;
  }

  function readReceipt(loc) {
    if (!io.existsSync(loc.receipt)) return null;
    safePath(loc.receipt, 'receipt');
    const stat = io.statSync(loc.receipt);
    if (stat.uid !== uid || (stat.mode & 0o077) !== 0) throw new Error('receipt must be private and owned by current UID');
    const receipt = JSON.parse(io.readFileSync(loc.receipt, 'utf8'));
    if (receipt.version !== 1 || receipt.label !== LABEL || receipt.uid !== uid || receipt.host !== hostname || receipt.domain !== loc.domain || receipt.plist !== loc.plist) throw new Error('receipt ownership mismatch');
    return receipt;
  }

  function saveReceipt(loc, receipt) {
    // Exclusive temporary file and rename avoid truncating an existing receipt.
    const temp = `${loc.receipt}.${process.pid}.tmp`;
    io.writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    try { io.renameSync(temp, loc.receipt); } finally { if (io.existsSync(temp)) io.unlinkSync(temp); }
  }

  function freshness(receipt) {
    const checks = {};
    for (const key of ['plist', 'config', 'entry', 'node']) {
      try {
        safePath(receipt[key], key);
        checks[key] = hash(io.readFileSync(receipt[key])) === receipt[`${key}Hash`];
      } catch { checks[key] = false; }
    }
    checks.host = receipt.host === hostname;
    checks.timezone = receipt.timezone === timezone;
    return { checks, fresh: Object.values(checks).every(Boolean) };
  }

  function plan(options, loc) {
    const node = safePath(options.node ?? process.execPath, 'node');
    if (node !== io.realpathSync(process.execPath)) throw new Error('node must be the current Node executable realpath');
    io.accessSync(node, fs.constants.X_OK);
    const entry = safePath(options.entry ?? ENTRY, 'entry');
    if (entry !== io.realpathSync(ENTRY)) throw new Error('entry must be this checkout nightly-review/bin/nightly-review.mjs');
    const config = safePath(options.config, 'config');
    const bytes = io.readFileSync(config);
    const schedule = JSON.parse(bytes.toString('utf8'));
    const keys = ['version', 'ownerHost', 'timezone', 'repos', 'hour', 'minute'];
    const projectMap = JSON.parse(io.readFileSync(new URL('../config/projects.json', import.meta.url), 'utf8')).repos;
    if (!schedule || Array.isArray(schedule) || Object.keys(schedule).some((key) => !keys.includes(key)) || schedule.version !== 1 || schedule.hour !== 5 || schedule.minute !== 0 || !Array.isArray(schedule.repos) || schedule.repos.length === 0 || new Set(schedule.repos).size !== schedule.repos.length || schedule.repos.some((repo) => typeof repo !== 'string' || !/^[A-Za-z0-9_-]+$/.test(repo) || !projectMap[repo])) throw new Error('invalid schedule config');
    if (typeof schedule.ownerHost !== 'string' || schedule.ownerHost !== hostname) throw new Error('ownerHost must match os.hostname() exactly');
    if (typeof schedule.timezone !== 'string' || schedule.timezone !== timezone) throw new Error('timezone must match current Intl timezone exactly');
    // Validate timezone even when an injected host reports an invalid zone.
    new Intl.DateTimeFormat('en', { timeZone: schedule.timezone });
    const out = safePath(options.out ?? path.join(loc.root, 'scheduled'), 'output', false);
    if (io.existsSync(out) && !io.statSync(out).isDirectory()) throw new Error('output must be a directory');
    const argv = [node, entry, 'prepare', '--mode', 'scheduled', '--config', config, '--out', out, '--json'];
    const logs = path.join(loc.root, 'logs');
    safePath(logs, 'logs', false);
    const values = {
      ARGV: argv.map((arg) => `    <string>${xml(arg)}</string>`).join('\n'),
      HOME: xml(home), PATH: xml([...new Set([path.dirname(node), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'])].join(':')),
      STDOUT: xml(path.join(logs, 'prepare.stdout.log')), STDERR: xml(path.join(logs, 'prepare.stderr.log')),
    };
    const plistBytes = io.readFileSync(TEMPLATE, 'utf8').replace(/\{\{([A-Z]+)\}\}/g, (_, key) => values[key]);
    return { version: 1, label: LABEL, uid, host: hostname, timezone, domain: loc.domain, plist: loc.plist, plistHash: hash(plistBytes), config, configHash: hash(bytes), entry, entryHash: hash(io.readFileSync(entry)), node, nodeHash: hash(io.readFileSync(node)), argv, out, logs, plistBytes };
  }

  return function run(options) {
    const loc = locations();
    const domainState = launch(['print', loc.domain], false);
    if (options.command === 'status') {
      const receipt = readReceipt(loc);
      const actual = launch(['print', `${loc.domain}/${LABEL}`], false);
      return { command: 'status', domain: { status: domainState.status, error: domainState.error }, actual, receipt, freshness: receipt ? freshness(receipt) : null };
    }
    if (domainState.status !== 0 || domainState.error) throw new Error('existing gui UID domain required');
    if (options.command === 'uninstall') {
      const receipt = readReceipt(loc);
      if (!receipt || receipt.state !== 'installed') throw new Error('owned installed receipt required');
      safePath(loc.plist, 'plist');
      if (hash(io.readFileSync(loc.plist)) !== receipt.plistHash) throw new Error('installed plist hash mismatch; refusing uninstall');
      launch(['bootout', loc.domain, loc.plist]);
      // Recheck after launchctl before removing owned bytes.
      safePath(loc.plist, 'plist');
      if (hash(io.readFileSync(loc.plist)) !== receipt.plistHash) throw new Error('plist changed during bootout; refusing removal');
      io.unlinkSync(loc.plist);
      saveReceipt(loc, { ...receipt, state: 'disabled' });
      return { command: 'uninstall', state: 'disabled', domain: loc.domain };
    }
    if (!['preview', 'install'].includes(options.command)) throw new Error('unknown scheduler command');
    const planned = plan(options, loc);
    const exists = io.existsSync(loc.plist);
    if (exists && hash(io.readFileSync(loc.plist)) !== planned.plistHash) throw new Error('existing plist has different content; uninstall owned verified installation first');
    if (options.command === 'preview' || !options.publish) return { command: options.command, published: false, plan: planned };
    if (exists) {
      const receipt = readReceipt(loc);
      if (!receipt || receipt.state !== 'installed' || receipt.plistHash !== planned.plistHash) throw new Error('existing plist requires owned installed receipt');
      return { command: 'install', published: false, alreadyInstalled: true, actual: launch(['print', `${loc.domain}/${LABEL}`], false), freshness: freshness(receipt) };
    }
    for (const dir of [path.dirname(loc.plist), loc.root, planned.logs, planned.out]) io.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Log destinations must not resolve through pre-existing symlinks.
    for (const filename of ['prepare.stdout.log', 'prepare.stderr.log']) safePath(path.join(planned.logs, filename), 'log', false);
    io.writeFileSync(loc.plist, planned.plistBytes, { flag: 'wx', mode: 0o600 });
    const { plistBytes, ...receipt } = planned;
    saveReceipt(loc, { ...receipt, state: 'pending' });
    try {
      launch(['bootstrap', loc.domain, loc.plist]);
    } catch (error) {
      // Preserve ownership evidence if launchd failed; never delete unexpected bytes.
      safePath(loc.plist, 'plist');
      if (hash(io.readFileSync(loc.plist)) === planned.plistHash) {
        io.unlinkSync(loc.plist);
        saveReceipt(loc, { ...receipt, state: 'disabled' });
      }
      throw error;
    }
    saveReceipt(loc, { ...receipt, state: 'installed' });
    return { command: 'install', published: true, receipt: { ...receipt, state: 'installed' }, actual: launch(['print', `${loc.domain}/${LABEL}`], false) };
  };
}
