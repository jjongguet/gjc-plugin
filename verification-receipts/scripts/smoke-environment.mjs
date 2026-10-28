import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

export function asideLaunchCounterPath(owned) {
 return path.join(owned, 'aside-launches.log');
}

// One appended line per launcher invocation: the only launch observer. Fixture
// submissions stay a separate mutation counter and are never a launch oracle.
export async function asideLaunchCount(file) {
 try {
  return (await fs.readFile(file, 'utf8')).split('\n').filter(line => line.length > 0).length;
 } catch (error) {
  if (error.code === 'ENOENT') return 0;
  throw error;
 }
}

// Test-only Aside router: counts every launch in the owned environment, then
// forwards to the real CLI with the caller's HOME/PATH/TMPDIR preserved.
export async function writeAsideProbeWrapper({ binDir, realAside, counterFile, env }) {
 await fs.mkdir(binDir, { recursive: true, mode: 0o700 });
 const wrapper = '#!/usr/bin/env node\n'
  + 'import {spawn} from "node:child_process";\n'
  + 'import {appendFileSync} from "node:fs";\n'
  + 'appendFileSync(' + JSON.stringify(counterFile) + ',process.pid+"\\n");\n'
  + 'const p=spawn(' + JSON.stringify(realAside) + ',process.argv.slice(2),{env:{HOME:' + JSON.stringify(env.HOME)
  + ',PATH:' + JSON.stringify(env.PATH) + ',TMPDIR:' + JSON.stringify(env.TMPDIR) + '},stdio:"inherit",shell:false});\n'
  + 'p.on("error",()=>process.exit(1));p.on("close",code=>process.exit(code??1));\n';
 const file = path.join(binDir, 'aside');
 await fs.writeFile(file, wrapper, { mode: 0o700 });
 return file;
}

// Advertised schemas are transformed on the wire: optional fields become
// anyOf:[<schema>,{type:'null'}] and literal sets become enum/const/union
// branches. Unwrap the nullable branch without asserting the original
// pattern/maxLength form, which the extractor does not promise.
function unwrapNullableSchema(node) {
 if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
 let current = node;
 for (let depth = 0; depth < 6; depth++) {
  const branches = Array.isArray(current.anyOf) ? current.anyOf : Array.isArray(current.oneOf) ? current.oneOf : null;
  if (!branches) return current;
  const remaining = branches.filter(branch => branch && typeof branch === 'object' && branch.type !== 'null');
  if (remaining.length === 0) return current;
  if (remaining.length === branches.length) return { ...current, anyOf: branches };
  if (remaining.length === 1) { current = remaining[0]; continue; }
  return { ...current, anyOf: remaining };
 }
 return current;
}

// The exact finite ID set the installed CLI actually advertises, plus the
// description kept on the wire. `ids:null` means the set is not finite/enumerable.
export function advertisedCaseIds(schema) {
 const node = unwrapNullableSchema(schema);
 if (!node) return { ids: null, description: '' };
 let description = typeof node.description === 'string' ? node.description : '';
 if (Array.isArray(node.enum) && node.enum.every(value => typeof value === 'string')) return { ids: [...new Set(node.enum)], description };
 if (typeof node.const === 'string') return { ids: [node.const], description };
 const branches = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
 if (!branches) return { ids: null, description };
 const ids = [];
 for (const branch of branches) {
  const resolved = unwrapNullableSchema(branch);
  if (!resolved) return { ids: null, description };
  // A description may live on a literal branch instead of the union node.
  if (!description && typeof resolved.description === 'string') description = resolved.description;
  if (typeof resolved.const === 'string') ids.push(resolved.const);
  else if (Array.isArray(resolved.enum) && resolved.enum.every(value => typeof value === 'string')) ids.push(...resolved.enum);
  else return { ids: null, description };
 }
 return { ids: ids.length ? [...new Set(ids)] : null, description };
}

// Navigate the advertised parameter schema to assessment.caseNotes[].id,
// unwrapping the nullable wrappers the host adds for optional fields.
export function advertisedCaseIdSchema(parameters) {
 const assessment = unwrapNullableSchema(parameters?.properties?.assessment);
 const caseNotes = unwrapNullableSchema(assessment?.properties?.caseNotes);
 const items = unwrapNullableSchema(caseNotes?.items);
 return unwrapNullableSchema(items?.properties?.id);
}

// A native rejection must read as a host validation failure, not as an
// arbitrary runtime error that happens to be non-JSON.
export function isNativeValidationDiagnostic(text) {
 return typeof text === 'string' && text.length > 0
  && /(?:invalid|validation|schema|expected|must|argument|parameter|not allowed|unexpected|reject|fail|const|enum|literal)/i.test(text);
}

// Adapter responses are JSON objects carrying execution/receipt/journalStorage
// (or a report). Anything else is native host validation, which must never be
// counted as an adapter receipt or journal record.
export function parseAdapterResult(text, begin = text.indexOf('{')) {
 const end = text.lastIndexOf('}');
 if (begin < 0 || end <= begin) return null;
 let value;
 try { value = JSON.parse(text.slice(begin, end + 1)); } catch { return null; }
 if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
 if (!['execution', 'receipt', 'journalStorage', 'report'].some(key => Object.hasOwn(value, key))) return null;
 return value;
}

export async function receiptFileCount(env) {
 const base = path.join(env.HOME, '.gjc-plugin', 'verification-receipts', 'receipts', 'v1');
 const count = async dir => {
  let total = 0;
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
   if (entry.isDirectory()) total += await count(path.join(dir, entry.name));
   else if (entry.name.endsWith('.json')) total++;
  }
  return total;
 };
 try { return await count(base); } catch (error) { if (error.code === 'ENOENT') return 0; throw error; }
}

export async function journalRecordCount(env, plugin) {
 const dir = path.join(env.HOME, '.gjc-plugin', plugin, 'journal', 'v1');
 try {
  const inventory = JSON.parse(await fs.readFile(path.join(dir, 'inventory.json'), 'utf8'));
  let total = 0;
  for (const segment of inventory.segments ?? []) {
   total += (await fs.readFile(path.join(dir, segment.name), 'utf8')).trimEnd().split('\n').filter(Boolean).length;
  }
  return total;
 } catch (error) {
  if (error.code === 'ENOENT') return 0;
  throw error;
 }
}

export async function createSmokeEnvironment(owned, parent = process.env) {
 const root = await fs.realpath(owned);
 const home = path.join(root, 'home');
 const agent = path.join(home, '.gjc', 'agent');
 await fs.mkdir(agent, { recursive: true, mode: 0o700 });
 const env = {
  PATH: parent.PATH ?? '', HOME: home, TMPDIR: root,
  GJC_CODING_AGENT_DIR: agent, GJC_AGENT_DIR: agent,
  GJC_MODEL_PRESET_REGISTRY_DISABLED: '1', JEV_ADVISOR_PROVIDER: 'off',
  OPENAI_API_KEY: 'local-fixture-not-a-real-credential', NO_COLOR: '1', CI: '1',
 };
 await assertSmokeIsolation(env, root);
 return env;
}

export async function assertSmokeIsolation(env, owned) {
 const root = await fs.realpath(owned);
 const home = path.join(root, 'home');
 const agent = path.join(home, '.gjc', 'agent');
 for (const [key, expected] of Object.entries({ HOME: home, TMPDIR: root, GJC_CODING_AGENT_DIR: agent, GJC_AGENT_DIR: agent })) {
  assert.equal(await fs.realpath(env[key]), expected, 'unsafe_smoke_environment:' + key);
 }
 const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'GJC_CODING_AGENT_DIR', 'GJC_AGENT_DIR', 'GJC_MODEL_PRESET_REGISTRY_DISABLED', 'JEV_ADVISOR_PROVIDER', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'NO_COLOR', 'CI']);
 assert.ok(Object.keys(env).every(key => allowed.has(key)), 'unexpected_smoke_environment');
 assert.equal(env.OPENAI_API_KEY, 'local-fixture-not-a-real-credential', 'real_smoke_credential');
 assert.equal(env.JEV_ADVISOR_PROVIDER, 'off', 'unexpected_smoke_assessment');
 assert.equal(env.GJC_MODEL_PRESET_REGISTRY_DISABLED, '1', 'unexpected_smoke_registry');
 if (env.OPENAI_BASE_URL !== undefined) {
  const url = new URL(env.OPENAI_BASE_URL);
  assert.ok(url.protocol === 'http:' && url.hostname === '127.0.0.1' && !url.username && !url.password, 'nonlocal_smoke_provider');
 }
}
