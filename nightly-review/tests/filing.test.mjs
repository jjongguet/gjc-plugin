import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MAX_ISSUES, clusterFindings, clusterKey, evidenceHash, issueTitle, planFiling, priorityFor, renderEvidenceComment, renderIssueBody, summarizeFiling } from '../lib/filing.mjs';

function finding(overrides = {}) {
  return { repo: 'yyaz-web', pr: 11, prUrl: 'https://github.com/jjongguet/yyaz-web/pull/11', file: 'tools/refresh_pack.py', line: 77, kind: 'correctness', lens: 'failure', model: 'test-only', confidence: 0.9, quote: 'if batch.exists() and not args.keep:', why_matters: 'dry-run destroys the previous batch', ...overrides };
}

test('cluster identities and legacy evidence hashes remain stable across transfer', () => {
  assert.equal(clusterKey(finding()), 'yyaz-web::tools/refresh_pack.py::correctness');
  assert.equal(evidenceHash(finding()), evidenceHash(finding()));
  assert.notEqual(evidenceHash(finding()), evidenceHash(finding({ line: 78 })));
});

test('offline planner groups existing file-kind evidence but never claims same cause', () => {
  const clusters = clusterFindings([finding({ confidence: 0.6, quote: 'a' }), finding({ confidence: 0.95, quote: 'b', file: 'app/main.py' }), finding({ confidence: 0.8, quote: 'c' }), finding({ kind: 'testgap', quote: 'different cause' })]);
  assert.equal(clusters.length, 3);
  assert.equal(clusters[0].key, 'yyaz-web::app/main.py::correctness');
  const shared = clusters.find((c) => c.key === clusterKey(finding()));
  assert.equal(shared.findings.length, 2); assert.equal(shared.confidence, 0.8);
});

test('reviewer confidence only orders priority, not defect authority', () => {
  assert.equal(priorityFor(0.85), 2); assert.equal(priorityFor(0.7), 3); assert.equal(priorityFor(0.4), 4);
});

test('rendered evidence carries original quote, PR, cluster and non-authorization warning', () => {
  const cluster = clusterFindings([finding()])[0];
  assert.equal(issueTitle(cluster), '[nightly] yyaz-web tools/refresh_pack.py — correctness');
  const body = renderIssueBody({ cluster, runId: 'run-1' });
  assert.match(body, /tools\/refresh_pack\.py:77/);
  assert.ok(body.includes(finding().quote)); assert.ok(body.includes(finding().prUrl));
  assert.ok(body.includes(`<!-- nightly-review:${cluster.key} -->`));
  assert.match(body, /실행 승인이 아니다/);
  const comment = renderEvidenceComment({ cluster, findings: [finding()], runId: 'run-3' });
  assert.ok(comment.includes(`nightly-review-evidence:${cluster.key}:${evidenceHash(finding())}`));
});

test('offline planning creates unknown, skips known, comments new evidence without mutating input', () => {
  const cluster = clusterFindings([finding()])[0];
  assert.equal(planFiling({ clusters: [cluster], state: { clusters: {} } })[0].type, 'create');
  const state = { version: 1, clusters: { [cluster.key]: { issue: { id: 'JJO-1', url: 'u' }, evidence: [evidenceHash(finding())] } } };
  const before = structuredClone(state);
  assert.equal(planFiling({ clusters: [cluster], state })[0].reason, 'up_to_date');
  const grown = clusterFindings([finding(), finding({ quote: 'new quote', line: 99 })])[0];
  const action = planFiling({ clusters: [grown], state })[0];
  assert.equal(action.type, 'comment'); assert.equal(action.findings.length, 1); assert.equal(action.findings[0].quote, 'new quote');
  assert.deepEqual(state, before);
});

test('offline cap is visible and summaries distinguish errors', () => {
  const clusters = clusterFindings(Array.from({ length: DEFAULT_MAX_ISSUES + 2 }, (_, i) => finding({ file: `file-${i}.py` })));
  const actions = planFiling({ clusters, state: { clusters: {} } });
  assert.equal(actions.filter((a) => a.type === 'create').length, DEFAULT_MAX_ISSUES);
  assert.equal(actions.filter((a) => a.reason === 'over_issue_cap').length, 2);
  assert.equal(summarizeFiling({ created: [], commented: [], skipped: [], errors: ['error'] }), 'filed 0, commented 0, skipped 0, failed 1');
});
