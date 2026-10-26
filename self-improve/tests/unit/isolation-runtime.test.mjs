import assert from "node:assert/strict";
import test from "node:test";

import {
  SEATBELT_RUNTIME,
  buildProbeEnvironment,
  buildSeatbeltProfile,
  probeIsolation,
} from "../../lib/isolation-runtime.mjs";

const REJECTED = { status: 1, stdout: "", stderr: "Operation not permitted", error: null };
const ACCEPTED = { status: 0, stdout: "", stderr: "", error: null };

function fakeRun(outcomes) {
  const seen = [];
  return {
    seen,
    run: ({ args }) => {
      const script = args.at(-1);
      seen.push(script);
      const key = Object.keys(outcomes).find((needle) => script.includes(needle));
      return key === undefined ? ACCEPTED : outcomes[key];
    },
  };
}

test("the seatbelt profile denies by default and names every allowed write", () => {
  const profile = buildSeatbeltProfile({ mountDir: "/tmp/trial" });
  assert.match(profile, /^\(version 1\)\n\(deny default\)/);
  assert.ok(profile.includes('(allow file-write* (subpath "/tmp/trial"))'), "trial mount is writable");
  assert.equal(profile.includes("(deny file-write*)"), false, "deny default already covers every other write");
  assert.equal(profile.includes("network"), false, "no network capability is granted without an allowlist");
  assert.throws(() => buildSeatbeltProfile({ mountDir: "relative/path" }), /absolute/);
});

test("network allowlisting accepts only resolved ip:port pairs", () => {
  const pinned = buildSeatbeltProfile({ mountDir: "/tmp/trial", allowNetworkHosts: ["203.0.113.7:443"] });
  assert.ok(pinned.includes('(allow network-outbound (remote ip "203.0.113.7:443"))'));
  assert.throws(() => buildSeatbeltProfile({ mountDir: "/tmp/trial", allowNetworkHosts: ["api.example.com:443"] }), /ip:port/);
});

test("secret-like variables are dropped from the probe environment instead of trusted", () => {
  const env = buildProbeEnvironment({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-live", GITHUB_TOKEN: "gh", HOME: "/root" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/root" });
});

test("a probe set that cannot be enforced reports unavailable, never a pass", () => {
  const noRuntime = probeIsolation({ mountDir: "/tmp/trial", runtime: null });
  assert.equal(noRuntime.status, "unavailable");
  assert.equal(noRuntime.reason, "no_enforceable_runtime");
  assert.deepEqual(noRuntime.probes, []);
  assert.equal(probeIsolation({ mountDir: "" }).status, "unavailable");
});

test("a runtime that permits the denied action or blocks the control fails closed", () => {
  // Every write succeeds: the sandbox is not containing anything.
  const open = fakeRun({ "/bin/sh": ACCEPTED });
  const leaked = probeIsolation({ mountDir: "/tmp/trial", runtime: SEATBELT_RUNTIME, run: open.run, outsideDir: "/tmp" });
  assert.equal(leaked.status, "fail");
  assert.equal(leaked.probes.find((probe) => probe.id === "write_outside_mount_denied").passed, false);

  // The control fails so the profile proves nothing about an allowed write.
  const closed = fakeRun({ "inside-probe.txt": REJECTED, "curl": REJECTED });
  const unusable = probeIsolation({ mountDir: "/tmp/trial", runtime: SEATBELT_RUNTIME, run: closed.run, outsideDir: "/tmp" });
  assert.equal(unusable.status, "fail");
  assert.equal(unusable.probes.find((probe) => probe.id === "write_inside_mount_allowed").passed, false);
});

test("a real seatbelt runtime passes every probe on macOS", { skip: process.platform !== "darwin" && "seatbelt is macOS-only" }, async () => {
  const { mkdtempSync, rmSync, existsSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const mount = mkdtempSync(path.join(tmpdir(), "harness2-probe-test-"));
  try {
    const result = probeIsolation({ mountDir: mount });
    assert.equal(result.runtime, SEATBELT_RUNTIME);
    assert.equal(result.status, "pass", JSON.stringify(result.probes));
    assert.equal(existsSync(path.join(mount, "inside-probe.txt")), false, "the probe file does not survive the run");
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});
