import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectHeldoutValues } from '../../lib/propose.mjs';

const script = fileURLToPath(import.meta.url);
const worktreeRoot = path.resolve(path.dirname(script), '..', '..', '..');
const runner = path.join(worktreeRoot, 'self-improve', 'domains', 'gjc-plugin', 'probes', 'run.ts');

function runRunner(baseline, candidate) {
  return spawnSync('bun', [runner, '--baseline', baseline, '--candidate', candidate, '--json'], {
    encoding: 'utf8',
    timeout: 60000,
  });
}

test('runner is deterministic and delta is zero when baseline equals candidate', () => {
  const r1 = runRunner(worktreeRoot, worktreeRoot);
  const r2 = runRunner(worktreeRoot, worktreeRoot);
  assert.equal(r1.status, 0, `first run failed: ${r1.stderr}`);
  assert.equal(r2.status, 0, `second run failed: ${r2.stderr}`);

  const out1 = r1.stdout.trim();
  const out2 = r2.stdout.trim();

  const json1 = JSON.parse(out1);
  const json2 = JSON.parse(out2);

  assert.deepStrictEqual(json1, json2, 'outputs of the two runs should be byte-identical (deep-equal)');
  assert.equal(json1.delta, 0, 'delta must be 0 when baseline == candidate');
});

test('schema keys, metric ranges and non-zero counts', () => {
  const r = runRunner(worktreeRoot, worktreeRoot);
  assert.equal(r.status, 0, `runner failed: ${r.stderr}`);

  const json = JSON.parse(r.stdout.trim());

  assert.equal(json.schema, 'gjc.self-improve.probe.v1');
  assert.equal(json.primary, 'decision_accuracy');

  for (const key of ['baseline', 'candidate']) {
    assert.ok(json[key], `missing key: ${key}`);
    for (const metric of ['extract_coverage', 'decision_accuracy', 'egress_boundary']) {
      const v = json[key][metric];
      assert.ok(typeof v === 'number' && v >= 0 && v <= 1, `${key}.${metric} must be in [0,1], got ${v}`);
    }
  }

  assert.ok(json.heldout && json.heldout.baseline && json.heldout.candidate, 'heldout section missing');
  for (const side of ['baseline', 'candidate']) {
    const v = json.heldout[side].heldout_coverage;
    assert.ok(typeof v === 'number' && v >= 0 && v <= 1, `heldout_coverage (${side}) must be in [0,1]`);
  }

  for (const [metric, count] of Object.entries(json.counts)) {
    assert.ok(count > 0, `counts.${metric} must be > 0 (not a stub), got ${count}`);
  }

  assert.ok(Array.isArray(json.notes), 'notes must be an array');
});

test('invalid directory causes non-zero exit with stderr message', () => {
  const fakeDir = path.join(worktreeRoot, 'self-improve', 'nonexistent-dir-for-test');
  const r = runRunner(fakeDir, worktreeRoot);
  assert.notEqual(r.status, 0, 'runner must exit non-zero when decision.ts is missing');
  assert.ok(r.stderr && r.stderr.trim().length > 0, 'stderr must contain an error message');
});

test('failures output lists per-case labels for the three probe metrics only', () => {
  const brokenDir = mkdtempSync(path.join(tmpdir(), 'probes-broken-'));
  try {
    mkdirSync(path.join(brokenDir, 'jev-advisor', 'lib'), { recursive: true });
    writeFileSync(
      path.join(brokenDir, 'jev-advisor', 'lib', 'decision.ts'),
      [
        'export function extractTasks() { return { tasks: [], rejected: [], omittedCount: 0 }; }',
        'export function parseDecision() { return { status: "no_decision" }; }',
        'export function isAllowedEndpoint() { return false; }',
        '',
      ].join('\n'),
    );
    const r = runRunner(brokenDir, worktreeRoot);
    assert.equal(r.status, 0, `runner failed: ${r.stderr}`);
    const json = JSON.parse(r.stdout.trim());
    assert.ok(json.failures && json.failures.baseline && json.failures.candidate, 'failures section missing');
    const fixtures = JSON.parse(
      readFileSync(path.join(worktreeRoot, 'self-improve', 'domains', 'gjc-plugin', 'probes', 'fixtures.json'), 'utf8'),
    );
    for (const side of ['baseline', 'candidate']) {
      for (const metric of ['extract_coverage', 'decision_accuracy', 'egress_boundary']) {
        assert.ok(Array.isArray(json.failures[side][metric]), `failures.${side}.${metric} must be an array`);
      }
    }
    const expectedDecisionMisses = fixtures.cases.decision_accuracy.filter((item) => item.expected.accept).length;
    const expectedEgressMisses = fixtures.cases.egress_boundary.filter((item) => item.expected.allowed).length;
    assert.equal(json.failures.baseline.decision_accuracy.length, expectedDecisionMisses);
    assert.equal(json.failures.baseline.egress_boundary.length, expectedEgressMisses);
    for (const label of json.failures.baseline.decision_accuracy) {
      assert.match(label, /^decision_accuracy#\d+$/);
    }
    // The corpus is not saturated any more (spec-sourced headroom cases), so the
    // invariant is that each side's failure list matches its reported score —
    // never that a side has no failures.
    for (const side of ['baseline', 'candidate']) {
      const decisionMisses = Math.round((1 - json[side].decision_accuracy) * json.counts.decision_accuracy);
      const egressMisses = Math.round((1 - json[side].egress_boundary) * json.counts.egress_boundary);
      const extractMisses = Math.round((1 - json[side].extract_coverage) * json.counts.extract_coverage);
      assert.equal(json.failures[side].decision_accuracy.length, decisionMisses, `${side}: decision failures vs score`);
      assert.equal(json.failures[side].egress_boundary.length, egressMisses, `${side}: egress failures vs score`);
      assert.equal(json.failures[side].extract_coverage.length, extractMisses, `${side}: extract failures vs score`);
    }
    assert.equal(JSON.stringify(json.failures).includes('heldout'), false, 'failures must cover probe metrics only');

    // failureDetails: same labels plus a short proposer-facing summary per case
    const details = json.failureDetails;
    assert.ok(details && details.baseline && details.candidate, 'failureDetails section missing');
    for (const side of ['baseline', 'candidate']) {
      for (const metric of ['extract_coverage', 'decision_accuracy', 'egress_boundary']) {
        assert.deepEqual(
          details[side][metric].map((entry) => entry.label),
          json.failures[side][metric],
          `${side}.${metric}: detail labels must match the failures list`,
        );
        for (const entry of details[side][metric]) {
          assert.equal(typeof entry.summary, 'string', `${side}.${metric} summary type`);
          assert.ok(entry.summary.length > 0 && entry.summary.length <= 240, `${side}.${metric} summary bound`);
          assert.ok(entry.summary.startsWith(`${metric}#`), `${side}.${metric} summary must start with its label`);
        }
      }
    }
    const headroomSummaries = details.baseline.decision_accuracy.map((entry) => entry.summary).join(' ');
    assert.match(headroomSummaries, /tolerance/i, 'headroom summaries must describe the documented gap');
    assert.match(headroomSummaries, /cap|overflow/i, 'cap-cluster summary must describe the documented overflow rule');
    const probeCases = JSON.parse(
      readFileSync(path.join(worktreeRoot, 'self-improve', 'domains', 'gjc-plugin', 'probes', 'fixtures.json'), 'utf8'),
    );
    const heldoutCases = JSON.parse(
      readFileSync(path.join(worktreeRoot, 'self-improve', 'domains', 'gjc-plugin', 'heldout', 'fixtures.json'), 'utf8'),
    );
    const probeValues = new Set(collectHeldoutValues(probeCases));
    const heldoutOnly = collectHeldoutValues(heldoutCases).filter((value) => !probeValues.has(value));
    const detailsText = JSON.stringify(details);
    for (const value of heldoutOnly) {
      assert.equal(detailsText.includes(value), false, 'failureDetails must not leak held-out material');
    }
  } finally {
    rmSync(brokenDir, { recursive: true, force: true });
  }
});
