import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_MAX_ISSUES,
  applyFiling,
  clusterFindings,
  clusterKey,
  evidenceHash,
  issueTitle,
  planFiling,
  priorityFor,
  renderEvidenceComment,
  renderIssueBody,
  summarizeFiling,
} from '../lib/filing.mjs';

function finding(overrides = {}) {
  return {
    repo: 'yyaz-web',
    pr: 11,
    prUrl: 'https://github.com/jjongguet/yyaz-web/pull/11',
    file: 'tools/refresh_pack.py',
    line: 77,
    kind: 'correctness',
    lens: 'failure',
    model: 'opensearch/x',
    confidence: 0.9,
    quote: 'if batch.exists() and not args.keep:',
    why_matters: 'dry-run destroys the previous batch',
    ...overrides,
  };
}

test('clusterKey and evidenceHash are stable for the same evidence', () => {
  assert.equal(clusterKey(finding()), 'yyaz-web::tools/refresh_pack.py::correctness');
  assert.equal(evidenceHash(finding()), evidenceHash(finding()));
  assert.notEqual(evidenceHash(finding()), evidenceHash(finding({ line: 78 })));
});

test('clusterFindings merges findings per repo/file/kind and orders by confidence', () => {
  const clusters = clusterFindings([
    finding({ confidence: 0.6, quote: 'a' }),
    finding({ confidence: 0.95, quote: 'b', file: 'app/main.py' }),
    finding({ confidence: 0.8, quote: 'c' }),
  ]);
  assert.equal(clusters.length, 2);
  assert.equal(clusters[0].key, 'yyaz-web::app/main.py::correctness');
  const shared = clusters.find((cluster) => cluster.file === 'tools/refresh_pack.py');
  assert.equal(shared.findings.length, 2);
  assert.equal(shared.confidence, 0.8);
});

test('clusterFindings keeps the same file apart when the kind differs', () => {
  const clusters = clusterFindings([
    finding({ kind: 'correctness' }),
    finding({ kind: 'testgap', quote: 'different quote' }),
  ]);
  assert.equal(clusters.length, 2);
});

test('priorityFor maps confidence to Linear priorities', () => {
  assert.equal(priorityFor(0.95), 2);
  assert.equal(priorityFor(0.85), 2);
  assert.equal(priorityFor(0.7), 3);
  assert.equal(priorityFor(0.4), 4);
});

test('issueTitle is stable across nights so a re-detection does not rename the ticket', () => {
  const first = clusterFindings([finding({ confidence: 0.5 })])[0];
  const second = clusterFindings([finding({ confidence: 0.99, quote: 'other' })])[0];
  assert.equal(issueTitle(first), issueTitle(second));
  assert.equal(issueTitle(first), '[nightly] yyaz-web tools/refresh_pack.py — correctness');
});

test('renderIssueBody carries the quote, the PR and the marker, and claims no approval', () => {
  const cluster = clusterFindings([finding()])[0];
  const body = renderIssueBody({ cluster, runId: 'run-1' });
  assert.match(body, /tools\/refresh_pack\.py:77/);
  assert.match(body, /if batch\.exists\(\) and not args\.keep:/);
  assert.match(body, /https:\/\/github\.com\/jjongguet\/yyaz-web\/pull\/11/);
  assert.match(body, /confidence 0\.9/);
  assert.match(body, /<!-- nightly-review:yyaz-web::tools\/refresh_pack\.py::correctness -->/);
  assert.match(body, /실행 승인이 아니다/);
});

test('planFiling creates when unseen, skips when up to date, comments on new evidence', () => {
  const cluster = clusterFindings([finding()])[0];
  const state = { version: 1, clusters: {} };

  const created = planFiling({ clusters: [cluster], state });
  assert.equal(created[0].type, 'create');

  const filed = {
    version: 1,
    clusters: {
      [cluster.key]: {
        issue: { id: 'JJO-1', url: 'u' },
        evidence: [evidenceHash(finding())],
      },
    },
  };
  assert.equal(planFiling({ clusters: [cluster], state: filed })[0].type, 'skip');

  const grown = clusterFindings([finding(), finding({ quote: 'new quote', line: 99 })])[0];
  const action = planFiling({ clusters: [grown], state: filed })[0];
  assert.equal(action.type, 'comment');
  assert.equal(action.findings.length, 1);
  assert.equal(action.findings[0].quote, 'new quote');
});

test('planFiling reports the cap instead of silently dropping clusters', () => {
  const clusters = clusterFindings(
    Array.from({ length: DEFAULT_MAX_ISSUES + 2 }, (_, index) =>
      finding({ file: `file-${index}.py`, quote: `quote number ${index}` }),
    ),
  );
  const actions = planFiling({ clusters, state: { clusters: {} } });
  assert.equal(actions.filter((action) => action.type === 'create').length, DEFAULT_MAX_ISSUES);
  const capped = actions.filter((action) => action.reason === 'over_issue_cap');
  assert.equal(capped.length, 2);
});

test('applyFiling creates issues, persists state and reuses the same ticket next run', async () => {
  const cluster = clusterFindings([finding()])[0];
  const calls = [];
  const client = {
    projectFor: () => 'yyaz-studio',
    createIssue: async (args) => {
      calls.push({ tool: 'createIssue', args });
      return { id: 'JJO-2001', url: 'https://linear.app/x/JJO-2001' };
    },
    getIssue: async () => ({ statusType: 'backlog' }),
    createComment: async () => ({}),
  };

  const actions = planFiling({ clusters: [cluster], state: { clusters: {} } });
  const { state, result } = await applyFiling({
    actions,
    client,
    state: { version: 1, clusters: {} },
    runId: 'run-1',
    now: () => '2026-11-03T00:00:00.000Z',
  });

  assert.equal(result.created.length, 1);
  assert.equal(calls[0].args.project, 'yyaz-studio');
  assert.equal(calls[0].args.priority, 2);
  assert.match(calls[0].args.description, /if batch\.exists/);
  assert.deepEqual(state.clusters[cluster.key].issue, {
    id: 'JJO-2001',
    identifier: null,
    url: 'https://linear.app/x/JJO-2001',
  });
  assert.deepEqual(state.clusters[cluster.key].evidence, [evidenceHash(finding())]);

  const again = planFiling({ clusters: [cluster], state });
  assert.equal(again[0].type, 'skip');
  assert.equal(again[0].reason, 'up_to_date');
});

test('applyFiling comments new evidence on an open issue and skips a closed one', async () => {
  const cluster = clusterFindings([finding({ quote: 'brand new quote', line: 55 })])[0];
  const filedState = {
    version: 1,
    clusters: {
      [cluster.key]: { issue: { id: 'JJO-9', url: 'u' }, evidence: [] },
    },
  };
  const actions = planFiling({ clusters: [cluster], state: filedState });

  const openCalls = [];
  const open = {
    projectFor: () => 'p',
    getIssue: async () => ({ statusType: 'backlog' }),
    createComment: async (args) => {
      openCalls.push(args);
      return {};
    },
  };
  const openResult = await applyFiling({
    actions,
    client: open,
    state: filedState,
    runId: 'run-2',
    now: () => 'now',
  });
  assert.equal(openResult.result.commented.length, 1);
  assert.match(openCalls[0].body, /추가 증거/);
  assert.equal(openResult.state.clusters[cluster.key].issue.id, 'JJO-9');

  const closed = {
    projectFor: () => 'p',
    getIssue: async () => ({ statusType: 'completed' }),
    createComment: async () => assert.fail('must not comment a completed issue'),
  };
  const closedResult = await applyFiling({
    actions,
    client: closed,
    state: filedState,
    runId: 'run-2',
  });
  assert.equal(closedResult.result.commented.length, 0);
  assert.equal(closedResult.result.skipped[0].reason, 'issue_completed');
});

test('applyFiling records a repository with no project instead of inventing one', async () => {
  const cluster = clusterFindings([finding({ repo: 'unknown-repo' })])[0];
  const actions = planFiling({ clusters: [cluster], state: { clusters: {} } });
  const result = await applyFiling({
    actions,
    client: { projectFor: () => null, createIssue: async () => assert.fail('no create') },
    state: { version: 1, clusters: {} },
    runId: 'run-1',
  });
  assert.equal(result.result.skipped[0].reason, 'no_project');
  assert.equal(result.result.created.length, 0);
});

test('applyFiling records a write failure and leaves the cluster unfiled', async () => {
  const cluster = clusterFindings([finding()])[0];
  const actions = planFiling({ clusters: [cluster], state: { clusters: {} } });
  const { state, result } = await applyFiling({
    actions,
    client: {
      projectFor: () => 'p',
      createIssue: async () => {
        throw new Error('Linear rate limit');
      },
    },
    state: { version: 1, clusters: {} },
    runId: 'run-1',
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /rate limit/);
  assert.equal(state.clusters[cluster.key], undefined);
  assert.match(summarizeFiling(result), /failed 1/);
});

test('renderEvidenceComment embeds a dedupe marker with the evidence hashes', () => {
  const cluster = clusterFindings([finding()])[0];
  const body = renderEvidenceComment({ cluster, findings: [finding()], runId: 'run-3' });
  assert.match(body, new RegExp(`nightly-review-evidence:${cluster.key}:${evidenceHash(finding())}`));
});
