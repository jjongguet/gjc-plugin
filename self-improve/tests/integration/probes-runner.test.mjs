import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
