import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../scripts/propose-with-gjc.mjs";

const REQUEST = {
  schema: "gjc.self-improve.proposer-request.v1",
  loopId: "test-loop",
  cycleIndex: 1,
  objective: "probe.decision_accuracy",
  baseCommit: "abcdef0",
  budget: { rung: 0, maxFiles: 3, maxHunks: 12 },
  editableSurfaces: [],
  failingCases: [],
  priorAttempts: [],
  constraints: {},
  responseContract: {},
};

const GOOD_REPLY = JSON.stringify({
  hypothesis: "retry fixture",
  commitMessage: "chore(jev-advisor): retry fixture",
  patch: "diff --git a/x b/x\n",
});

function makeEnv() {
  const dir = mkdtempSync(join(tmpdir(), "propose-gjc-retry-"));
  const requestFile = join(dir, "request.json");
  const responseFile = join(dir, "response.json");
  writeFileSync(requestFile, JSON.stringify(REQUEST));
  return { dir, requestFile, responseFile };
}

test("retries once after a failed gjc call and succeeds", () => {
  const { dir, requestFile, responseFile } = makeEnv();
  let calls = 0;
  const status = main(
    [requestFile, responseFile],
    { ...process.env, GJC_PROPOSER_MODEL: "test/model" },
    {
      cwd: dir,
      spawn: () => {
        calls += 1;
        if (calls === 1) return { status: 1, stdout: "", stderr: "transient failure" };
        return { status: 0, stdout: GOOD_REPLY, stderr: "" };
      },
    },
  );
  assert.equal(status, 0);
  assert.equal(calls, 2, "exactly one retry must run");
  assert.equal(existsSync(responseFile), true);
  assert.equal(existsSync(`${responseFile}.attempt-1.stderr.log`), true);
  rmSync(dir, { recursive: true, force: true });
});

test("persistent gjc failure writes a stderr sidecar and exits 1", () => {
  const { dir, requestFile, responseFile } = makeEnv();
  const status = main(
    [requestFile, responseFile],
    { ...process.env, GJC_PROPOSER_MODEL: "test/model" },
    {
      cwd: dir,
      spawn: () => ({ status: 1, stdout: "", stderr: "boom sentinel" }),
    },
  );
  assert.equal(status, 1);
  assert.equal(existsSync(responseFile), false);
  const log = readFileSync(`${responseFile}.stderr.log`, "utf8");
  assert.match(log, /boom sentinel/);
  rmSync(dir, { recursive: true, force: true });
});
