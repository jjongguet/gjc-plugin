import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, writeFile, readFile, mkdir, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { reviewCandidates } from '../lib/reconcile-cli.mjs';
import { semanticAction, proposalHash } from '../lib/reconciliation.mjs';
import { immutableJson, digest } from '../lib/state.mjs';
import { LENSES } from '../lib/lenses.mjs';
const now = Date.now(); const DAY = 86400000;
const old = new Date(now - 3 * DAY).toISOString();
const issue = { id: 'child', project: 'gjc-plugin', title: '[nightly] test', description: 'original evidence', createdAt: new Date(now - 15 * DAY).toISOString(), updatedAt: old, status: 'Backlog', statusType: 'backlog', labels: ['nightly'], parentId: 'parent', comments: { items: [], complete: true, reason: null } };
const parent = { ...issue, id: 'parent', title: '[nightly 배치] gjc-plugin', parentId: null };
const snapshot = { complete: true, project: 'gjc-plugin', issues: [issue, parent] };
const authority = { remote: 'https://github.com/jjongguet/gjc-plugin', branch: 'main', head: 'a'.repeat(40), verifiedHead: 'a'.repeat(40), observedAt: new Date(now).toISOString(), notReverted: true, behaviorVerified: true, evidenceDigest: 'b'.repeat(64), behaviorCommand: 'node --test observed.mjs' };
const candidate = { issueId: issue.id, type: 'correct', exactDelta: { correction: 'Current verified evidence replaces no original text.' }, authority, evidence: 'current receipt', sourceLinks: ['https://github.com/jjongguet/gjc-plugin/pull/45'] };
test('supervised once creates private run evidence under normal umask without invoking review for an empty collection', async () => {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nightly-once-')));
  const bin = path.join(dir, 'bin'); await mkdir(bin);
  const trace = path.join(dir, 'collection.log');
  await writeFile(path.join(bin, 'gh'), `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(trace)}, 'read\\n'); console.log('[]');\n`, { mode: 0o700 });
  const auth = path.join(dir, 'supervision.json');
  const instant = new Date().toISOString();
  const modelBounds = Object.fromEntries(LENSES.map((lens) => [lens.model, { verified: true, source: 'https://example.com/test-only', observedAt: instant, maxContextTokens: 32000, maxOutputTokens: 1000, inputUsdPerMillion: 1, outputUsdPerMillion: 1 }]));
  await writeFile(auth, JSON.stringify({ active: true, supervisor: 'test-agent', expiresAt: new Date(Date.now() + 300000).toISOString(), budget: { capUsd: 5, spentUsd: 0, reservedUsd: 0 }, modelBounds }));
  const out = path.join(dir, 'state');
  const result = spawnSync(process.execPath, ['nightly-review/bin/nightly-review.mjs', 'once', '--repos', 'gjc-plugin', '--supervision', auth, '--out', out, '--json'], { encoding: 'utf8', timeout: 10000, env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(result.status, 0, result.stderr);
  const [run] = await readdir(out);
  assert.equal((await stat(path.join(out, run))).mode & 0o777, 0o700);
  assert.equal(JSON.parse(await readFile(path.join(out, run, 'budget.json'), 'utf8')).calls, 0);
  const collected = await readFile(trace, 'utf8');
  const valid = JSON.parse(await readFile(auth, 'utf8'));
  for (const supervisor of ['   ', {}]) {
    await writeFile(auth, JSON.stringify({ ...valid, supervisor }));
    const refused = spawnSync(process.execPath, ['nightly-review/bin/nightly-review.mjs', 'once', '--repos', 'gjc-plugin', '--supervision', auth, '--out', out, '--json'], { encoding: 'utf8', timeout: 10000, env: { PATH: `${bin}:${process.env.PATH}` } });
    assert.notEqual(refused.status, 0);
    assert.match(refused.stderr, /supervisor/);
    assert.equal(await readFile(trace, 'utf8'), collected);
    assert.deepEqual(await readdir(out), [run]);
  }
});
function scope(value = candidate) {
  const action = semanticAction({ snapshot, candidate: value, at: now });
  return { active: true, supervisor: 'test-agent', operationalExclusion: true, expiresAt: new Date(now + 600000).toISOString(), budget: { capUsd: 5, spentUsd: 0, reservedUsd: 0, nextUpperUsd: 0.01 }, actions: [{ issueId: action.issueId, type: action.type, project: action.project, proposalHash: proposalHash(action) }] };
}

test('missing exact proposal, missing scope, operational exclusion and overlong supervision incur zero decision calls', async () => {
  for (const update of [{ actions: [] }, { operationalExclusion: false }, { expiresAt: new Date(now + 3600001).toISOString() }, { actions: [{ issueId: issue.id, type: 'correct', project: 'gjc-plugin' }] }]) {
    let calls = 0;
    await assert.rejects(reviewCandidates({ snapshot, candidates: [structuredClone(candidate)], supervision: { ...scope(), ...update }, clock: () => now, verify: async () => true, decide: async () => { calls++; } }), /supervision/);
    assert.equal(calls, 0);
  }
});

test('canonical delta reaches model and triaged/unsupported/unapproved destinations do not', async () => {
  let calls = 0; let received;
  const decide = async ({ candidate: value }) => { calls++; received = value; return { adopted: true, choice: 'consistent', confidence: 0.9, costUpperUsd: 0.001 }; };
  const normal = structuredClone(candidate);
  await reviewCandidates({ snapshot, candidates: [normal], supervision: scope(), clock: () => now, verify: async () => true, decide });
  assert.equal(calls, 1); assert.ok(received.evidence.proposal.delta.description.includes(candidate.exactDelta.correction));
  assert.equal(normal.decision.proposalHash, proposalHash(received.evidence.proposal));
  for (const value of [{ ...candidate, type: 'unknown' }, { ...candidate, type: 'move', targetAllowed: true, exactDelta: { project: 'unapproved' } }]) {
    await reviewCandidates({ snapshot, candidates: [structuredClone(value)], supervision: scope(), clock: () => now, verify: async () => true, decide });
  }
  for (const triage of [{ triaged: true }, { triagedAt: old }]) {
    await reviewCandidates({ snapshot: { ...snapshot, issues: [{ ...issue, ...triage }, parent] }, candidates: [structuredClone(candidate)], supervision: scope(), clock: () => now, verify: async () => true, decide });
  }
  assert.equal(calls, 1);
});

async function cliFixture(mode) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'nightly-cli-')));
  const script = path.join(dir, 'linear.py'); const trace = path.join(dir, 'trace.jsonl');
  const issues = mode === 'two-batches' ? [issue, parent, { ...parent, id: 'parent-two' }] : [];
  await writeFile(script, `import sys,json\nargs=json.loads(sys.argv[sys.argv.index('--arguments')+1]);tool=sys.argv[2]\nwith open(${JSON.stringify(trace)},'a') as f:f.write(json.dumps({'tool':tool})+'\\n')\nissues=json.loads(${JSON.stringify(JSON.stringify(issues))})\nif tool=='list_issue_labels': result={'labels':[{'id':'label','name':'nightly'}],'hasNextPage':False}\nelif tool=='list_issues': result={'issues':issues,'hasNextPage':${mode === 'incomplete' ? 'True' : 'False'},'cursor':'same'}\nelif tool=='get_issue': result=next(i for i in issues if i['id']==args['id']);result.pop('comments',None)\nelif tool=='list_comments':result={'comments':[],'hasNextPage':False}\nelse:raise Exception('unexpected mutation '+tool)\nprint(json.dumps(result))\n`);
  await immutableJson(path.join(dir, 'state', 'owner.json'), { version: 1, host: os.hostname(), generation: 1, enabled: true });
  return { dir, script, trace };
}

test('publish without --scan still performs current complete enumeration rather than trusting imported unique-batch snapshot', async () => {
  const f = await cliFixture('two-batches');
  const input = path.join(f.dir, 'input.json'); const auth = path.join(f.dir, 'supervision.json');
  await writeFile(input, JSON.stringify({ project: 'gjc-plugin', snapshot, candidates: [] }));
  await writeFile(auth, JSON.stringify({ ...scope(), actions: [] }));
  const result = spawnSync(process.execPath, ['nightly-review/bin/nightly-review.mjs', 'reconcile', '--snapshot', input, '--publish', '--supervision', auth, '--out', path.join(f.dir, 'state'), '--linear-cli', f.script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  const trace = await readFile(f.trace, 'utf8'); assert.match(trace, /list_issues/); assert.doesNotMatch(trace, /save_issue|save_comment/);
});

test('incomplete filing exits1 and appends a deferred revision without rewriting source receipt', async () => {
  const f = await cliFixture('incomplete'); const run = path.join(f.dir, 'run'); await mkdir(run);
  const receipt = path.join(run, 'receipt.json');
  await writeFile(receipt, JSON.stringify({ findings: [{ repo: 'gjc-plugin', file: 'a.mjs', line: 4, quote: 'actual retained quote', kind: 'contract', confidence: 0.4, pr: 1 }] }));
  const hash = digest(await readFile(receipt)); const auth = path.join(f.dir, 'supervision.json'); await writeFile(auth, JSON.stringify(scope()));
  const result = spawnSync(process.execPath, ['nightly-review/bin/nightly-review.mjs', 'file', '--run', run, '--publish', '--supervision', auth, '--out', path.join(f.dir, 'state'), '--linear-cli', f.script, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).complete, false); assert.equal(JSON.parse(result.stdout).published, false);
  assert.equal(digest(await readFile(receipt)), hash);
  assert.equal((await readdir(path.join(run, 'revisions'))).length, 1);
  assert.doesNotMatch(await readFile(f.trace, 'utf8'), /save_issue|save_comment/);
});
