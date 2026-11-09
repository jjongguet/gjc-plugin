import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, chmod, link, mkdir } from 'node:fs/promises';
import { createLinearClient } from '../lib/linear.mjs';
import os from 'node:os';
import path from 'node:path';

const TRANSPORT = path.resolve('nightly-review/bin/linear-transport.py');
const node = { id: 'uuid-1', identifier: 'JJO-1', title: 't', description: 'full body <!-- nightly-review:k -->', priority: 4, priorityLabel: 'Low', url: 'https://linear.app/x', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-02T00:00:00.000Z', archivedAt: null, triagedAt: null, state: { name: 'Backlog', type: 'backlog' }, labels: { nodes: [{ id: 'l', name: 'nightly' }], pageInfo: { hasNextPage: false } }, assignee: null, delegate: null, project: { id: 'p-uuid', name: 'gjc-plugin' }, parent: { id: 'parent-uuid' }, relations: { nodes: [{ type: 'duplicate', relatedIssue: { id: 'dup-uuid', identifier: 'JJO-2' } }], pageInfo: { hasNextPage: false } } };

// Imports the transport as a module and drives read() with a stub query; no network.
function python(code) {
  const result = spawnSync('python3', ['-c', `import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('t',${JSON.stringify(TRANSPORT)})\nm=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\n${code}`], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
  return { status: result.status, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

test('get_issue maps GraphQL to the consumed policy-CLI shape with canonical UUID and identifier', () => {
  const r = python(`print(json.dumps(m.read('get_issue',{'id':'JJO-1'},lambda q,v:{'issue':json.loads(${JSON.stringify(JSON.stringify(node))})})))`);
  assert.equal(r.status, 0, r.stderr);
  const issue = JSON.parse(r.stdout);
  assert.deepEqual({ id: issue.id, uuid: issue.uuid, status: issue.status, statusType: issue.statusType, labels: issue.labels, project: issue.project, projectId: issue.projectId, parentId: issue.parentId, priority: issue.priority, duplicateOf: issue.duplicateOf }, { id: 'JJO-1', uuid: 'uuid-1', status: 'Backlog', statusType: 'backlog', labels: ['nightly'], project: 'gjc-plugin', projectId: 'p-uuid', parentId: 'parent-uuid', priority: { value: 4, name: 'Low' }, duplicateOf: { uuid: 'dup-uuid', id: 'JJO-2' } });
  assert.equal(issue.description, node.description);
});

test('truncated label or relation pages, ambiguous duplicates and missing issues refuse partial evidence', () => {
  for (const [field, value] of [['labels', { nodes: [], pageInfo: { hasNextPage: true } }], ['relations', { nodes: [], pageInfo: { hasNextPage: true } }], ['relations', { nodes: [node.relations.nodes[0], node.relations.nodes[0]], pageInfo: { hasNextPage: false } }]]) {
    const r = python(`n=json.loads(${JSON.stringify(JSON.stringify({ ...node, [field]: value }))})\ntry:\n m.read('get_issue',{'id':'JJO-1'},lambda q,v:{'issue':n});print('accepted')\nexcept RuntimeError as e: print('refused')`);
    assert.equal(r.stdout, 'refused', `${field}`);
  }
  const missing = python(`try:\n m.read('get_issue',{'id':'JJO-9'},lambda q,v:{'issue':None});print('accepted')\nexcept RuntimeError: print('refused')`);
  assert.equal(missing.stdout, 'refused');
});

test('list pages keep explicit termination metadata and labels keep only team or workspace labels', () => {
  const stub = (projects) => `def q(text,v):\n if 'projects(' in text: return {'projects':{'nodes':${projects}}}\n assert v['project']=='p-1', v\n return {'issues':{'nodes':[{'id':'u1','identifier':'JJO-1'}],'pageInfo':{'hasNextPage':True,'endCursor':'c1'}}}\n`;
  const page = python(`${stub("[{'id':'p-1'}]")}print(json.dumps(m.read('list_issues',{'project':'gjc-plugin','limit':2},q)))`);
  assert.deepEqual(JSON.parse(page.stdout), { issues: [{ id: 'u1', identifier: 'JJO-1' }], hasNextPage: true, cursor: 'c1' });
  for (const projects of ['[]', "[{'id':'p-1'},{'id':'p-2'}]"]) {
    const ambiguous = python(`${stub(projects)}try:\n m.read('list_issues',{'project':'same-name'},q);print('accepted')\nexcept RuntimeError: print('refused')`);
    assert.equal(ambiguous.stdout, 'refused', projects);
  }
  const labels = python(`print(json.dumps(m.read('list_issue_labels',{'team':'Jjongguet','name':'nightly'},lambda q,v:{'issueLabels':{'nodes':[{'id':'a','name':'nightly','team':None},{'id':'b','name':'nightly','team':{'name':'Other'}},{'id':'c','name':'nightly','team':{'name':'Jjongguet'}}],'pageInfo':{'hasNextPage':False}}})))`);
  assert.deepEqual(JSON.parse(labels.stdout).labels.map((l) => l.id), ['a', 'c']);
  const bad = python(`try:\n m.read('list_issues',{'project':'p','limit':0},lambda q,v:None);print('accepted')\nexcept ValueError: print('refused')`);
  assert.equal(bad.stdout, 'refused');
});

test('rate limits map to the Aside hint and query errors never echo provider text', () => {
  const rate = python(`class R:\n def __init__(s,b): s.b=b\n def __enter__(s): return s\n def __exit__(s,*a): return False\n def read(s,n): return s.b\nclass O:\n def __init__(s,b): s.b=b\n def open(s,req,timeout): return R(s.b)\nfor body in [{'errors':[{'extensions':{'code':'RATELIMITED'}}]},{'errors':[{'message':'secret lin_api_echo'}]},['not','an','object']]:\n try: m.graphql('q',{},'k',O(json.dumps(body).encode()))\n except RuntimeError as e: print(json.dumps(str(e)))\nimport io,urllib.error\nclass E:\n def __init__(s,code,body): s.code=code; s.body=body\n def open(s,req,timeout): raise urllib.error.HTTPError('u',s.code,'m',{},io.BytesIO(s.body))\nfor code,body in [(400,json.dumps({'errors':[{'extensions':{'code':'RATELIMITED'}}]}).encode()),(400,b'secret lin_api_echo')]:\n try: m.graphql('q',{},'k',E(code,body))\n except RuntimeError as e: print(json.dumps(str(e)))`);
  const [quota, failure, malformed, quota400, failure400] = rate.stdout.split('\n').map((line) => JSON.parse(line));
  assert.match(quota, /429/); assert.match(quota, /linear-aside/);
  assert.doesNotMatch(failure, /secret|lin_api/);
  assert.match(malformed, /malformed/);
  assert.match(quota400, /linear-aside/);
  assert.match(failure400, /HTTP 400/); assert.doesNotMatch(failure400, /secret|lin_api/);
});

test('credential parsing refuses shared, hard-linked or non-API-key configs and the CLI rejects read writes', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'nightly-transport-'));
  const config = path.join(dir, 'mcp.json');
  const write = async (auth, mode = 0o600) => { await writeFile(config, JSON.stringify({ mcpServers: { linear: { type: 'http', url: 'https://mcp.linear.app/mcp', headers: { Authorization: auth } } } })); await chmod(config, mode); };
  const check = () => python(`try:\n m.credential(${JSON.stringify(config)});print('accepted')\nexcept ValueError: print('refused')`).stdout;
  await write('Bearer lin_api_test'); assert.equal(check(), 'accepted');
  await write('Bearer lin_api_test', 0o640); assert.equal(check(), 'refused');
  await write('Bearer other'); assert.equal(check(), 'refused');
  await write('Bearer lin_api_test'); await link(config, path.join(dir, 'second')); assert.equal(check(), 'refused');
  for (const argv of [['call', 'get_issue', '--arguments', '{}', '--publish'], ['call', 'delete_issue', '--arguments', '{}'], ['call', 'get_issue'], ['call', 'get_issue', 'x', '--arguments'], ['call', 'get_issue', '--arguments', '{}', '--extra']]) {
    assert.equal(spawnSync('python3', [TRANSPORT, ...argv], { encoding: 'utf8', timeout: 10000 }).status, 2, argv.join(' '));
  }
});

test('writes exec the policy CLI with identical argv, stdout and exit code', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'nightly-transport-home-'));
  const bin = path.join(home, '.gjc', 'agent', 'policy', 'bin');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'linear-trace.py'), 'import sys,json\nprint(json.dumps(sys.argv[1:]))\nsys.exit(7)\n');
  const argv = ['call', 'save_comment', '--arguments', '{"issueId":"JJO-1","body":"b"}', '--publish'];
  const result = spawnSync('python3', [TRANSPORT, ...argv], { encoding: 'utf8', timeout: 10000, env: { PATH: process.env.PATH, HOME: home, PYTHONDONTWRITEBYTECODE: '1' } });
  assert.equal(result.status, 7);
  assert.deepEqual(JSON.parse(result.stdout), argv);
});

test('a publishing client sends --publish only with write tools', async () => {
  const seen = [];
  const exec = (command, args, options, callback) => { seen.push(args); callback(null, '{"issues":[],"hasNextPage":false,"labels":[],"comments":[],"id":"u","uuid":"u"}', ''); };
  const client = createLinearClient({ cli: 'transport.py', publish: true, exec });
  await client.getIssue('JJO-1'); await client.listIssues({ project: 'p' }); await client.listComments({ issueId: 'JJO-1' }); await client.listLabels();
  await client.createComment({ issueId: 'JJO-1', body: 'b' }); await client.updateIssue({ id: 'JJO-1', state: 'Canceled' });
  assert.deepEqual(seen.map((args) => [args[2], args.includes('--publish')]), [['get_issue', false], ['list_issues', false], ['list_comments', false], ['list_issue_labels', false], ['save_comment', true], ['save_issue', true]]);
});
