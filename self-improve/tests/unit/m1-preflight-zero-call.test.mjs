import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";

test("preflight dry, refused and admitted plans never dispatch through the process seam", async () => {
  let spawnCount = 0;
  const stub = () => {
    spawnCount += 1;
    throw new Error("preflight attempted a process call");
  };
  // Positive control: prove this observer counts a call before using its zero.
  assert.throws(stub, /process call/);
  assert.equal(spawnCount, 1);
  spawnCount = 0;
  const names = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
  const originals = names.map((name) => childProcess[name]);
  try {
    for (const name of names) childProcess[name] = stub;
    syncBuiltinESMExports();
    const { preflight } = await import("../../m1/preflight.mjs");
    const manifest = JSON.parse(readFileSync(new URL("../fixtures/pilot/manifest.json", import.meta.url), "utf8"));
    const budget = JSON.parse(readFileSync(new URL("../../m1/budget.example.json", import.meta.url), "utf8"));
    const cases = [
      [{}, "skipped", "live_not_approved"],
      [{ live: true }, "refused", "live_approval_invalid"],
      [{ approveLive: 0.5 }, "refused", "live_approval_without_live"],
      [{ live: true, approveLive: 9 }, "refused", "live_cap_exceeds_declared"],
      [{ live: true, approveLive: 0.5 }, "refused", "live_executor_absent"],
      [{ live: true, approveLive: 0.5, executorAvailable: true }, "approved", null],
    ];
    for (const [options, status, code] of cases) {
      const result = preflight({ manifest, budget, ...options });
      assert.equal(result.live.status, status);
      assert.equal(result.live.code, code);
      assert.equal(result.requestCount, 84);
      assert.equal(spawnCount, 0, `${status}/${code} dispatched a process`);
    }
  } finally {
    names.forEach((name, index) => { childProcess[name] = originals[index]; });
    syncBuiltinESMExports();
  }
});
