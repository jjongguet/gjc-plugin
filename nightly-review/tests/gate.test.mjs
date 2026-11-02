import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MAX_FINDINGS,
  gateFindings,
  indexDiff,
  normalizePath,
  normalizeWhitespace,
  verifyFinding,
} from '../lib/gate.mjs';

const DIFF = [
  'diff --git a/studio/worker.py b/studio/worker.py',
  'index 1111111..2222222 100644',
  '--- a/studio/worker.py',
  '+++ b/studio/worker.py',
  '@@ -10,6 +10,9 @@ def loop(self):',
  '     while True:',
  '-        job = self.queue.pop()',
  '+        job = self.queue.pop(timeout=5)',
  '+        if job is None:',
  '+            continue',
  '         self.handle(job)',
  'diff --git a/scripts/check.py b/scripts/check.py',
  '--- a/scripts/check.py',
  '+++ b/scripts/check.py',
  '@@ -1,2 +1,4 @@',
  '-print("old")',
  '+print("new")',
  '+ALLOWED = frozenset({"a", "b"})',
  '+def check(value):',
].join('\n');

test('indexDiff records added lines with their new-file numbers', () => {
  const files = indexDiff(DIFF);
  assert.deepEqual([...files.keys()], ['studio/worker.py', 'scripts/check.py']);
  const worker = files.get('studio/worker.py');
  // The hunk starts at new line 10 with a context line, so the first added
  // line is 11 — not the hunk start.
  assert.deepEqual(
    worker.added.map((entry) => entry.line),
    [11, 12, 13],
  );
  assert.match(worker.joinText, /job = self\.queue\.pop\(timeout=5\)/);
});

test('indexDiff ignores removed lines', () => {
  const files = indexDiff(DIFF);
  assert.ok(!files.get('studio/worker.py').joinText.includes('self.queue.pop()\n'));
});

test('verifyFinding accepts an exact added line', () => {
  const files = indexDiff(DIFF);
  const verdict = verifyFinding(
    { file: 'studio/worker.py', line: 11, quote: 'if job is None:' },
    files,
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.file, 'studio/worker.py');
});

test('verifyFinding accepts the file path as the model may write it', () => {
  const files = indexDiff(DIFF);
  assert.equal(normalizePath('./studio/worker.py'), 'studio/worker.py');
  assert.equal(normalizePath('b/studio/worker.py'), 'studio/worker.py');
  assert.equal(
    verifyFinding({ file: './studio/worker.py', line: 11, quote: 'job = self.queue.pop(timeout=5)' }, files)
      .ok,
    true,
  );
});

test('verifyFinding tolerates whitespace-only differences', () => {
  const files = indexDiff(DIFF);
  const verdict = verifyFinding(
    { file: 'studio/worker.py', line: 12, quote: '   if job is None:   ' },
    files,
  );
  assert.equal(verdict.ok, true);
});

test('verifyFinding rejects a quote taken from a removed line', () => {
  const files = indexDiff(DIFF);
  const verdict = verifyFinding(
    { file: 'studio/worker.py', line: 10, quote: 'job = self.queue.pop()' },
    files,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'quote_not_in_diff');
});

test('verifyFinding rejects a file that is not in the diff', () => {
  const files = indexDiff(DIFF);
  const verdict = verifyFinding(
    { file: 'studio/server.py', line: 1, quote: 'app = FastAPI()' },
    files,
  );
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'file_not_in_diff');
});

test('verifyFinding corrects a cited line that is not the quote\'s line', () => {
  const files = indexDiff(DIFF);
  const verdict = verifyFinding(
    { file: 'studio/worker.py', line: 99, quote: 'if job is None:' },
    files,
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.line, 12);
  assert.equal(verdict.corrected, true);
});

test('verifyFinding prefers the longest overlap when a short added line also matches', () => {
  const diff = [
    '--- a/ops.yaml',
    '+++ b/ops.yaml',
    '@@ -1,0 +1,3 @@',
    '+optional: true',
    '+    - name: CLIENT_A',
    '+      optional: true',
  ].join('\n');
  const files = indexDiff(diff);
  // The quote is a fragment of the third line and also a prefix of nothing else
  // of that length, so the citation must land on the long line, not line 1.
  const verdict = verifyFinding({ file: 'ops.yaml', line: 1, quote: '    - name: CLIENT_A' }, files);
  assert.equal(verdict.ok, true);
  assert.equal(verdict.line, 2);
});

test('verifyFinding leaves a correct line untouched', () => {
  const files = indexDiff(DIFF);
  const verdict = verifyFinding(
    { file: 'studio/worker.py', line: 12, quote: 'if job is None:' },
    files,
  );
  assert.equal(verdict.line, 12);
  assert.equal(verdict.corrected, false);
});

test('gateFindings reports the corrected line in the kept finding', () => {
  const files = indexDiff(DIFF);
  const result = gateFindings([
    { file: 'studio/worker.py', line: 11, kind: 'correctness', quote: 'if job is None:', confidence: 0.5 },
  ], files);
  assert.equal(result.kept.length, 1);
  assert.equal(result.kept[0].line, 12);
  assert.equal(result.kept[0].lineCorrected, true);
});

test('verifyFinding rejects a quote too short to prove anything', () => {
  const files = indexDiff(DIFF);
  const verdict = verifyFinding({ file: 'scripts/check.py', line: 1, quote: 'print' }, files);
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, 'quote_not_specific');
});

test('gateFindings drops unquotable findings and keeps the verified one', () => {
  const files = indexDiff(DIFF);
  const findings = [
    { file: 'studio/worker.py', line: 11, kind: 'correctness', quote: 'if job is None:', confidence: 0.7 },
    { file: 'studio/worker.py', line: 11, kind: 'correctness', quote: 'raise TimeoutError("never")', confidence: 0.9 },
  ];
  const result = gateFindings(findings, files);
  assert.equal(result.kept.length, 1);
  assert.equal(result.stats.submitted, 2);
  assert.equal(result.stats.byReason.quote_not_in_diff, 1);
});

test('gateFindings collapses near duplicates across lenses', () => {
  const files = indexDiff(DIFF);
  const findings = [
    { file: 'studio/worker.py', line: 11, kind: 'correctness', quote: 'if job is None:', lens: 'failure', confidence: 0.6 },
    { file: 'studio/worker.py', line: 11, kind: 'correctness', quote: 'if job is None:', lens: 'contract', confidence: 0.5 },
  ];
  const result = gateFindings(findings, files);
  assert.equal(result.kept.length, 1);
  assert.equal(result.stats.byReason.duplicate, 1);
});

test('gateFindings keeps different kinds on the same line', () => {
  const files = indexDiff(DIFF);
  const findings = [
    { file: 'studio/worker.py', line: 11, kind: 'correctness', quote: 'if job is None:', confidence: 0.6 },
    { file: 'studio/worker.py', line: 11, kind: 'testgap', quote: 'if job is None:', confidence: 0.5 },
  ];
  const result = gateFindings(findings, files);
  assert.equal(result.kept.length, 2);
});

test('gateFindings caps the run and sorts by confidence', () => {
  const files = indexDiff(DIFF);
  const findings = [
    { file: 'studio/worker.py', line: 11, kind: 'correctness', quote: 'job = self.queue.pop(timeout=5)', confidence: 0.2 },
    { file: 'studio/worker.py', line: 12, kind: 'correctness', quote: 'if job is None:', confidence: 0.9 },
    { file: 'scripts/check.py', line: 2, kind: 'correctness', quote: 'ALLOWED = frozenset({"a", "b"})', confidence: 0.4 },
  ];
  const result = gateFindings(findings, files, { maxFindings: 2 });
  assert.equal(result.kept.length, 2);
  assert.equal(result.kept[0].line, 12);
  assert.equal(result.stats.byReason.over_cap, 1);
});

test('normalizeWhitespace keeps line structure', () => {
  assert.equal(normalizeWhitespace('  a  b \n\n\tc\t'), 'a b\nc');
});

test('the run cap defaults to the documented constant, not a stray literal', () => {
  const files = indexDiff(
    [
      'diff --git a/a.mjs b/a.mjs',
      '+++ b/a.mjs',
      '@@ -1,0 +1,1 @@',
      '+const alphaBravoChalieDeltaEcho = 1;',
    ].join('\n'),
  );
  const findings = Array.from({ length: DEFAULT_MAX_FINDINGS + 5 }, (_, index) => ({
    file: 'a.mjs',
    kind: `kind-${index}`,
    quote: 'const alphaBravoChalieDeltaEcho = 1;',
    confidence: 0.5,
  }));

  const result = gateFindings(findings, files);
  assert.equal(DEFAULT_MAX_FINDINGS, 40);
  assert.equal(result.kept.length, DEFAULT_MAX_FINDINGS);
  assert.equal(result.stats.byReason.over_cap, 5);
});
