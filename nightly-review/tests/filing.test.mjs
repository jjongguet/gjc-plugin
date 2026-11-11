import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MAX_ISSUES, batchTitle, citesLocation, clusterFindings, clusterKey, evidenceHash, isBatchTitle, issueTitle, locationKey, locationMarker, periodLabel, planFiling, priorityFor, renderEvidenceComment, renderIssueBody, summarizeFiling } from '../lib/filing.mjs';

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

test('a location is the repository plus file:line, independent of kind and quote', () => {
  const base = finding();
  assert.equal(locationKey(base), 'yyaz-web::tools/refresh_pack.py:77');
  assert.equal(locationMarker(base), locationMarker({ ...base, kind: 'testgap', quote: 'another lens', lens: 'coverage' }));
  assert.notEqual(locationMarker(base), locationMarker({ ...base, repo: 'other-repo' }));
  assert.notEqual(locationMarker(base), locationMarker({ ...base, line: 78 }));
  assert.match(locationMarker(base), /^<!-- nightly-location:[a-f0-9]{16} -->$/);
});

test('a filed body carries its location so a second lens lands on the same issue', () => {
  const cluster = clusterFindings([finding()])[0];
  const body = renderIssueBody({ cluster, runId: 'run-1' });
  assert.ok(body.includes(locationMarker(finding())));
  assert.ok(citesLocation({ description: body }, cluster));
  assert.ok(citesLocation({ description: `- PR: jjongguet/yyaz-web#11 · lens failure\n\n\`tools/refresh_pack.py:77\`` }, cluster), 'a pre-JJO-1883 body matches by its readable citation');
  assert.ok(!citesLocation({ description: '`tools/refresh_pack.py:77`' }, cluster), 'the same path in another repository is a different location');
  assert.ok(!citesLocation({ description: 'unrelated evidence' }, cluster));
});

test('a batch title names the project, its filing count and the reviewed window', () => {
  assert.equal(batchTitle({ project: 'Infra', period: '2026-11-02~05', count: 27 }), '[nightly 배치] Infra 미트리아지 findings 27건 — 2026-11-02~05 회차');
  assert.ok(isBatchTitle(batchTitle({ project: 'p', period: '2026-11-12', count: 1 })));
  assert.ok(!isBatchTitle('[nightly] p a.mjs — contract'));
  const day = (month, date) => new Date(2026, month - 1, date, 12);
  assert.equal(periodLabel({ since: '2026-11-12', until: day(11, 12) }), '2026-11-12');
  assert.equal(periodLabel({ since: '2026-11-11', until: day(11, 12) }), '2026-11-11~12');
  assert.equal(periodLabel({ since: '2026-10-31', until: day(11, 1) }), '2026-10-31~2026-11-01');
  assert.equal(periodLabel({ until: day(11, 12) }), '2026-11-12');
  assert.equal(periodLabel({ since: '2026-11-02T00:00:00', until: day(11, 5) }), '2026-11-02~05');
  assert.throws(() => periodLabel({ since: '2026-11-12', until: 'not-a-date' }), /valid end date/);
});

test('offline cap is visible and summaries distinguish errors', () => {
  const clusters = clusterFindings(Array.from({ length: DEFAULT_MAX_ISSUES + 2 }, (_, i) => finding({ file: `file-${i}.py` })));
  const actions = planFiling({ clusters, state: { clusters: {} } });
  assert.equal(actions.filter((a) => a.type === 'create').length, DEFAULT_MAX_ISSUES);
  assert.equal(actions.filter((a) => a.reason === 'over_issue_cap').length, 2);
  assert.equal(summarizeFiling({ created: [], commented: [], skipped: [], errors: ['error'] }), 'filed 0, commented 0, skipped 0, failed 1');
});
