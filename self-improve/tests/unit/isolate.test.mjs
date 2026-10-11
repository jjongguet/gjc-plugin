import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertIsolatedDestination,
  assertSmokeIsolation,
  computeHarnessDigest,
  createSmokeEnvironment,
  digestEqual,
  sanitizeGuardEnv,
} from "../../lib/isolate.mjs";

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "self-improve-isolate-"));
}

test("sanitizeGuardEnv strips secret-like and test-runner variables, keeps operational ones", () => {
  const env = sanitizeGuardEnv({
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    LANG: "en_US.UTF-8",
    JEV_ADVISOR_API_KEY: "sk-live-should-not-survive",
    OPENROUTER_API_KEY: "or-key",
    OPENAI_API_KEY: "oa-key",
    MY_TOKEN: "t",
    DB_PASSWORD: "p",
    SERVICE_CREDENTIAL: "c",
    NODE_TEST_CONTEXT: "child-v8",
    NODE_TEST_REPORTER: "tap",
    NODE_V8_COVERAGE: "/tmp/coverage",
  });
  assert.deepEqual(Object.keys(env).sort(), ["HOME", "LANG", "PATH"]);
});

test("assertIsolatedDestination refuses live-agent paths and symlinks", () => {
  const root = tempRoot();
  const live = join(root, "live-agent");
  mkdirSync(live, { recursive: true });
  assert.throws(
    () => assertIsolatedDestination({ destDir: join(live, "child"), liveAgentDir: live }),
    /inside_live_agent/,
  );
  const link = join(root, "link");
  symlinkSync(live, link);
  assert.throws(() => assertIsolatedDestination({ destDir: link, liveAgentDir: join(root, "other") }), /is_symlink/);
  rmSync(root, { recursive: true, force: true });
});

test("computeHarnessDigest is deterministic, change-sensitive and honest about gaps", () => {
  const root = tempRoot();
  const agent = join(root, "agent");
  mkdirSync(join(agent, "gjc-plugins", "jev-advisor"), { recursive: true });
  mkdirSync(join(agent, "gjc-plugins", "verification-receipts"), { recursive: true });
  mkdirSync(join(agent, "gjc-plugins", "ui-regression"), { recursive: true });
  mkdirSync(join(agent, "jev-advisor"), { recursive: true });
  writeFileSync(join(agent, "gjc-plugins", "jev-advisor", "gajae-plugin.json"), '{"name":"jev-advisor"}');
  writeFileSync(join(agent, "jev-advisor", ".env"), "JEV_ADVISOR_API_KEY=fixture\n");

  const missing = computeHarnessDigest({ agentDir: agent });
  assert.ok(missing.rows.some((row) => row.path === "gjc-plugins/registry.json" && row.missing === true));

  writeFileSync(join(agent, "gjc-plugins", "registry.json"), "{}");
  const first = computeHarnessDigest({ agentDir: agent });
  assert.equal(first.rootHash, computeHarnessDigest({ agentDir: agent }).rootHash);
  assert.equal(digestEqual(first, missing), false);
  const paths = first.rows.map((row) => row.path);
  assert.deepEqual(paths, [...paths].sort());

  writeFileSync(join(agent, "gjc-plugins", "registry.json"), '{"changed":true}');
  assert.notEqual(computeHarnessDigest({ agentDir: agent }).rootHash, first.rootHash);

  symlinkSync(join(agent, "jev-advisor", ".env"), join(agent, "gjc-plugins", "ui-regression", "linked"));
  assert.ok(computeHarnessDigest({ agentDir: agent }).rows.some((row) => row.symlink !== undefined));
  rmSync(root, { recursive: true, force: true });
});

test("createSmokeEnvironment + assertSmokeIsolation round-trip and refuse tampering", async () => {
  const root = tempRoot();
  const owned = join(root, "owned");
  mkdirSync(owned, { recursive: true, mode: 0o700 });
  const env = await createSmokeEnvironment(owned);
  await assertSmokeIsolation(env, owned);
  const realOwned = await realpath(owned);
  assert.equal(env.GJC_CODING_AGENT_DIR, join(realOwned, "home", ".gjc", "agent"));
  const elsewhere = join(root, "elsewhere");
  mkdirSync(elsewhere);
  await assert.rejects(() => assertSmokeIsolation({ ...env, HOME: elsewhere }, owned), /unsafe_smoke_environment/);
  rmSync(root, { recursive: true, force: true });
});
