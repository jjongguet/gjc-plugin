import {spawnSync} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dir,'..');
const env={PATH:process.env.PATH ?? '',HOME:process.env.HOME ?? '',TMPDIR:process.env.TMPDIR ?? '/tmp',JEV_ADVISOR_PROVIDER:'off'};
// Bun's 5s default per-test bound is a harness limit, not a checked behaviour:
// these suites build git fixtures and persisted envelopes, run four-at-a-time
// under the root test runner, and the self-improve scratch guard runs the whole
// suite again inside one of those steps. Wall-clock contracts stay asserted by
// the tests themselves (loop budgets, cancellation).
for (const args of [['scripts/build.mjs','--check'],['test','--timeout=30000','tests/receipts.test.ts','tests/decision.test.ts','tests/runner.test.ts','tests/adapters.test.ts','tests/smoke-environment.test.ts','tests/loop.test.ts','tests/gate-hook.test.ts']]) {
 const result=spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',maxBuffer:4*1024*1024});
 process.stdout.write(result.stdout ?? ''); process.stderr.write(result.stderr ?? '');
 if (result.status !== 0) process.exit(result.status ?? 1);
 if (args[0] === 'test' && !/[1-9]\d* pass/.test((result.stdout ?? '')+(result.stderr ?? ''))) throw new Error('zero_test_discovery');
}
