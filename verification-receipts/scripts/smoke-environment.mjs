import * as fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';

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
