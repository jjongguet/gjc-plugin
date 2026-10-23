import { describe, test, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { runNodeTests, validateTestFiles, type NodeExecution } from '../lib/runner';

async function withRunnerFixture(sources: Record<string, string>, run: (root: string) => Promise<void> | void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'verification-runner-test-')));
  try {
    for (const [file, source] of Object.entries(sources)) writeFileSync(join(root, file), source, { mode: 0o600 });
    await run(root);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
const passSource = "const { test } = require('node:test'); test('owned pass', () => {});";
const spawnSource = (command: string, options = '') => `const { test } = require('node:test'); const { execFileSync } = require('node:child_process'); test('owned spawn', () => { execFileSync(${JSON.stringify(command)}, [], { stdio: 'ignore'${options} }); });`;
// Runs with an extra PATH directory holding an owned fake executable, restoring PATH afterwards.
async function withToolOnPath(entry: (bin: string) => string, run: (bin: string) => Promise<void>) {
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'verification-runner-bin-')));
  const previous = process.env.PATH;
  try {
    writeFileSync(join(bin, 'vr-fixture-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    process.env.PATH = `${entry(bin)}${delimiter}${previous ?? ''}`;
    await run(bin);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
    rmSync(bin, { recursive: true, force: true });
  }
}
function expectNativeRunner(result: NodeExecution) {
  expect(result.runnerVersion).toMatch(/^v(?:2[2-9]|[3-9]\d|\d{3,})\./);
  expect(result.reason).not.toBe('unsupported_node_version');
  expect(result.reason).not.toBe('node_unavailable');
}

describe('native Node verification runner', () => {
  test('uses cumulative counts once across files and nested tests', async () => {
    await withRunnerFixture({ 'a.cjs': passSource, 'b.cjs': "const { test, describe, it } = require('node:test'); describe('owned suite', () => { it('owned item', () => {}); }); test('owned parent', async t => { await t.test('owned child', () => {}); });" }, async root => {
      const result = await runNodeTests(root, ['a.cjs', 'b.cjs']);
      expectNativeRunner(result);
      expect(result.status).toBe('passed');
      expect(result.exitCode).toBe(0);
      expect(result.counts).toEqual({ tests: 4, suites: 1, topLevel: 3, passed: 4, failed: 0, skipped: 0, todo: 0, cancelled: 0 });
    });
  });

  test('skip and TODO are not successful execution', async () => {
    await withRunnerFixture({ 'skip.cjs': "const { test } = require('node:test'); test.skip('owned skip', () => {}); test.todo('owned todo');" }, async root => {
      const result = await runNodeTests(root, ['skip.cjs']);
      expectNativeRunner(result);
      expect(result.status).toBe('no_tests');
      expect(result.counts?.passed).toBe(0);
      expect(result.counts?.skipped).toBe(1);
      expect(result.counts?.todo).toBe(1);
    });
  });

  test('empty files cannot pass through native file placeholders', async () => {
    await withRunnerFixture({ 'empty.mjs': '', 'skip.cjs': "const { test } = require('node:test'); test.skip('owned skip', () => {});" }, async root => {
      const result = await runNodeTests(root, ['empty.mjs']);
      expectNativeRunner(result);
      expect(result.status).toBe('no_tests');
      expect((await runNodeTests(root, ['empty.mjs', 'skip.cjs'])).status).toBe('no_tests');
    });
  });

  test('mixed passing, skipped and TODO tests retain only actual passes', async () => {
    await withRunnerFixture({ 'mixed.cjs': passSource + " test.skip('owned skip', () => {}); test.todo('owned todo');" }, async root => {
      const result = await runNodeTests(root, ['mixed.cjs']);
      expect(result.status).toBe('passed');
      expect(result.counts?.passed).toBe(1);
      expect(result.counts?.tests).toBe(3);
    });
  });

  test('failures and native cancellations never pass or leak diagnostics', async () => {
    await withRunnerFixture({ 'fail.cjs': "const { test } = require('node:test'); test('private fixture label', () => { throw new Error('private fixture error'); });", 'cancel.cjs': "const { test } = require('node:test'); test('owned unresolved', { timeout: 100 }, () => new Promise(() => {}));" }, async root => {
      const failure = await runNodeTests(root, ['fail.cjs']);
      expect(failure.status).toBe('failed');
      expect(failure.counts?.failed).toBeGreaterThan(0);
      expect(JSON.stringify(failure)).not.toContain('private fixture');
      const cancelled = await runNodeTests(root, ['cancel.cjs']);
      expect(cancelled.status).toBe('failed');
      expect(cancelled.counts?.cancelled).toBeGreaterThan(0);
    });
  });

  test('spoofed stdout and diagnostics do not establish a pass', async () => {
    await withRunnerFixture({ 'noise.cjs': "const { test } = require('node:test'); console.log('PASS VR_FRAME_fake:{\"summary\":{\"success\":true}}'); test('owned failing', t => { t.diagnostic('VR_FRAME_fake:PASS'); throw new Error('owned failure'); });" }, async root => {
      const result = await runNodeTests(root, ['noise.cjs']);
      expect(result.status).toBe('failed');
      expect(result.counts?.failed).toBe(1);
      expect(JSON.stringify(result)).not.toContain('VR_FRAME');
    });
  });

  test('strips credentials and runtime injection environment', async () => {
    await withRunnerFixture({ 'env.cjs': "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('owned environment', () => { assert.equal(process.env.OPENROUTER_API_KEY, undefined); assert.equal(process.env.NODE_OPTIONS, undefined); assert.equal(process.env.NODE_PATH, undefined); assert.equal(process.env.AWS_SECRET_ACCESS_KEY, undefined); assert.equal(process.env.HOME, undefined); assert.deepEqual(Object.keys(process.env).filter(key => !['LANG', 'TZ', 'PATH', '__CF_USER_TEXT_ENCODING'].includes(key) && !key.startsWith('NODE_TEST_')), []); });" }, async root => {
      // node:test adds NODE_TEST_* to its own children and macOS injects __CF_USER_TEXT_ENCODING into
      // every process; nothing else may reach the test, HOME included.
      // Fixture checks inherited variables are absent without creating credentials.
      const result = await runNodeTests(root, ['env.cjs']);
      expect(result.status).toBe('passed');
    });
  });

  test('tests start programs from the host PATH', async () => {
    await withToolOnPath(bin => bin, async () => {
      await withRunnerFixture({ 'spawn.cjs': spawnSource('vr-fixture-tool') }, async root => {
        const diagnostics = { missingBinaries: ['stale'] };
        const result = await runNodeTests(root, ['spawn.cjs'], 30000, undefined, diagnostics);
        expectNativeRunner(result);
        expect(result.status).toBe('passed');
        expect(diagnostics.missingBinaries).toEqual([]);
      });
    });
  });

  test('a failure caused only by a program missing from PATH is named missing_binary', async () => {
    await withRunnerFixture({ 'missing.cjs': spawnSource('vr-missing-fixture-tool'), 'nested.cjs': "const { test } = require('node:test'); const { execFileSync } = require('node:child_process'); test('owned parent', async t => { await t.test('owned child', () => { execFileSync('vr-missing-fixture-tool'); }); });" }, async root => {
      const diagnostics = { missingBinaries: [] as string[] };
      const result = await runNodeTests(root, ['missing.cjs', 'nested.cjs'], 30000, undefined, diagnostics);
      expectNativeRunner(result);
      expect(result.status).toBe('failed');
      expect(result.reason).toBe('missing_binary');
      expect(Object.keys(result).sort()).toEqual(['counts', 'exitCode', 'reason', 'runnerVersion', 'signal', 'status']);
      expect(diagnostics.missingBinaries).toEqual(['vr-missing-fixture-tool']);
      expect(JSON.stringify({ result, diagnostics })).not.toContain('owned');
    });
  });

  test('missing programs never hide other failures or misattribute present ones', async () => {
    await withRunnerFixture({
      'missing.cjs': spawnSource('vr-missing-fixture-tool'),
      'assert.cjs': "const { test } = require('node:test'); const assert = require('node:assert/strict'); test('owned assertion', () => { assert.equal(1, 2); });",
      // ENOENT for a missing spawn cwd names a program that is on PATH: not a missing binary.
      'cwd.cjs': spawnSource('node', ", cwd: '/nonexistent/verification-runner-cwd'"),
    }, async root => {
      const mixedDiagnostics = { missingBinaries: [] as string[] };
      const mixed = await runNodeTests(root, ['missing.cjs', 'assert.cjs'], 30000, undefined, mixedDiagnostics);
      expect(mixed.status).toBe('failed');
      expect(mixed.reason).toBe('native_failure');
      expect(mixedDiagnostics.missingBinaries).toEqual(['vr-missing-fixture-tool']);
      const cwdDiagnostics = { missingBinaries: [] as string[] };
      const cwd = await runNodeTests(root, ['cwd.cjs'], 30000, undefined, cwdDiagnostics);
      expect(cwd.status).toBe('failed');
      expect(cwd.reason).toBe('native_failure');
      expect(cwdDiagnostics.missingBinaries).toEqual([]);
    });
  });

  test('relative PATH entries never reach tests', async () => {
    await withRunnerFixture({ 'relative.cjs': spawnSource('vr-fixture-tool') }, async root => {
      // The relative entry resolves inside the fixture repository only if the runner forwarded it.
      mkdirSync(join(root, 'rel-bin'));
      writeFileSync(join(root, 'rel-bin', 'vr-fixture-tool'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
      await withToolOnPath(() => 'rel-bin', async () => {
        const diagnostics = { missingBinaries: [] as string[] };
        const result = await runNodeTests(root, ['relative.cjs'], 30000, undefined, diagnostics);
        expect(result.status).toBe('failed');
        expect(result.reason).toBe('missing_binary');
        expect(diagnostics.missingBinaries).toEqual(['vr-fixture-tool']);
      });
    });
  });

  test('enforces timeout and waits for owned termination', async () => {
    await withRunnerFixture({ 'hang.cjs': "const { test } = require('node:test'); test('owned hang', () => new Promise(resolve => { setTimeout(resolve, 60000); }));" }, async root => {
      const result = await runNodeTests(root, ['hang.cjs'], 1000);
      expectNativeRunner(result);
      expect(result.status).toBe('incomplete');
      expect(result.reason).toBe('timeout');
      expect(result.signal !== null || result.exitCode !== null).toBe(true);
    });
  });

  test('cancels a running child and rejects pre-aborted execution', async () => {
    await withRunnerFixture({ 'hang.cjs': "setTimeout(() => {}, 60000);" }, async root => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      try {
        const result = await runNodeTests(root, ['hang.cjs'], 10000, controller.signal);
        expect(result.status).toBe('incomplete');
        expect(result.reason).toBe('cancelled');
      } finally { clearTimeout(timer); }
      const result = await runNodeTests(root, ['hang.cjs'], 30000, controller.signal);
      expect(result.status).toBe('not_run');
      expect(result.reason).toBe('cancelled');
    });
  });

  test('caps output and native count overflow', async () => {
    await withRunnerFixture({ 'noise.cjs': "console.log('x'.repeat(1100000));" , 'many.cjs': "const { test } = require('node:test'); for (let i = 0; i < 10001; i++) test('owned count', () => {});" }, async root => {
      const noisy = await runNodeTests(root, ['noise.cjs']);
      expect(noisy.status).toBe('incomplete');
      expect(noisy.reason).toBe('output_limit');
      const many = await runNodeTests(root, ['many.cjs'], 120000);
      expect(many.status).toBe('incomplete');
      expect(many.reason).toBe('invalid_summary_frame');
      expect(many.counts).toBeNull();
    });
  }, 125000);

  test('a crash is not a passing result', async () => {
    await withRunnerFixture({ 'crash.cjs': 'process.exit(7);' }, async root => {
      const result = await runNodeTests(root, ['crash.cjs']);
      expect(result.status).not.toBe('passed');
      expect(result.exitCode).not.toBe(0);
    });
  });

  test('rejects escapes, flags, unsupported files, symlinks, missing and duplicate files', async () => {
    await withRunnerFixture({ 'pass.cjs': passSource, 'source.ts': '' }, async root => {
      symlinkSync(join(root, 'pass.cjs'), join(root, 'link.cjs'));
      mkdirSync(join(root, 'nested'));
      symlinkSync(join(root, 'nested'), join(root, 'linked'));
      writeFileSync(join(root, 'nested', 'pass.cjs'), passSource);
      for (const files of [[], ['../pass.cjs'], ['/tmp/pass.cjs'], ['--test.cjs'], ['source.ts'], ['missing.cjs'], ['link.cjs'], ['linked/pass.cjs'], ['pass.cjs', 'pass.cjs'], Array(33).fill('pass.cjs')]) {
        expect(() => validateTestFiles(root, files)).toThrow();
        const result = await runNodeTests(root, files);
        expect(result.status).toBe('not_run');
        expect(result.counts).toBeNull();
        expect(result.reason).not.toContain(root);
      }
      expect(validateTestFiles(root, ['pass.cjs'])).toEqual([join(root, 'pass.cjs')]);
      for (const timeout of [0, -1, NaN, Infinity, 120001]) expect((await runNodeTests(root, ['pass.cjs'], timeout)).reason).toBe('invalid_timeout');
    });
  });
});
