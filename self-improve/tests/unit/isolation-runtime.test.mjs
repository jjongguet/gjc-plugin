import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import test from "node:test";

import {
  SEATBELT_BIN,
  SEATBELT_RUNTIME,
  buildProbeEnvironment,
  buildSeatbeltProfile,
  probeIsolation,
  runtimeReadRoots,
  startLoopbackListener,
} from "../../lib/isolation-runtime.mjs";

const REJECTED = { status: 1, stdout: "", stderr: "Operation not permitted", error: null };
const ACCEPTED = { status: 0, stdout: "", stderr: "", error: null };
const LOOPBACK_PROXY = "127.0.0.1:41001";
const LOOPBACK_OTHER = "127.0.0.1:41002";
const stubListener = () => ({ host: LOOPBACK_OTHER, stop() {} });

/**
 * Deterministic stand-in for the spawnSync runner. `denyNeedles` are denied only
 * inside the sandbox (the unsandboxed control still succeeds), which is exactly
 * the shape a working profile produces.
 */
function fakeRun({ denyNeedles = [], outcomes = {}, materialize = null } = {}) {
  const seen = [];
  const run = ({ command, args }) => {
    const script = args.at(-1) ?? "";
    seen.push({ command, script });
    const key = Object.keys(outcomes).find((needle) => script.includes(needle));
    const result = key !== undefined ? outcomes[key] : command === SEATBELT_BIN && denyNeedles.some((needle) => script.includes(needle)) ? REJECTED : ACCEPTED;
    if (result === ACCEPTED && materialize !== null && script.includes("inside-probe.txt")) writeFileSync(materialize, "probe");
    return result;
  };
  return { seen, run };
}

/** One temp tree: a trial mount, a permitted sibling root and protected targets. */
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "isolation-runtime-")));
  const mount = path.join(root, "mount");
  const system = path.join(root, "system");
  const oracle = path.join(root, "oracle");
  const store = path.join(root, "store");
  const credential = path.join(root, "credential.env");
  const input = path.join(mount, "input.txt");
  for (const dir of [mount, system, oracle, store]) mkdirSync(dir, { recursive: true });
  writeFileSync(credential, "SECRET=1\n");
  writeFileSync(input, "input\n");
  writeFileSync(path.join(oracle, "oracle.json"), "{}\n");
  return {
    root,
    mount,
    system,
    oracle,
    store,
    credential,
    input,
    insideProbe: path.join(mount, "inside-probe.txt"),
    dispose: () => rmSync(root, { recursive: true, force: true }),
  };
}

const liveArgs = (f) => ({
  mountDir: f.mount,
  readRoots: [f.system, f.mount],
  protectedReadRoots: [f.oracle, f.store, f.credential],
  protectedFiles: { oracle: path.join(f.oracle, "oracle.json"), credential: f.credential, store: f.store },
  inputPath: f.input,
  runtimePath: process.execPath,
  allowNetwork: true,
  allowNetworkHosts: [LOOPBACK_PROXY],
  blockedNetworkHost: LOOPBACK_OTHER,
});

test("the seatbelt profile denies by default, grants reads per canonical root only, and writes only the mount", () => {
  const f = fixture();
  try {
    const profile = buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.system] });
    assert.match(profile, /^\(version 1\)\n\(deny default\)/);
    assert.equal(profile.includes("(allow file-read*)"), false, "no global file-read");
    assert.ok(profile.includes(`(allow file-read* (literal "${f.system}") (subpath "${f.system}"))`), "explicit root read");
    assert.ok(profile.includes(`(allow file-write* (subpath "${f.mount}"))`), "trial mount is writable");
    assert.ok(profile.includes('(allow file-write* (literal "/dev/null"))'), "only /dev/null outside the mount");
    assert.equal(profile.includes("(deny file-write*)"), false, "deny default already covers every other write");
    assert.equal(profile.includes("network"), false, "no network capability is granted without an allowlist");
  } finally {
    f.dispose();
  }
});

test("the builder rejects a missing, empty or unusable read root instead of falling back to global read", () => {
  const f = fixture();
  try {
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount }), /readRoots/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [] }), /readRoots/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: "relative/path", readRoots: [f.system] }), /absolute/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: ["/"] }), /filesystem root/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: ["relative/root"] }), /absolute/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [path.join(f.root, "ghost")] }), /does not resolve/);
    const fileProfile = buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.input] });
    assert.ok(fileProfile.includes(`(allow file-read* (literal "${f.input}"))`));
    assert.equal(fileProfile.includes(`(subpath "${f.input}")`), false);
  } finally {
    f.dispose();
  }
});

test("a read root that equals, contains, sits inside or symlinks into a protected root is rejected", () => {
  const f = fixture();
  try {
    const nested = path.join(f.oracle, "nested");
    mkdirSync(nested, { recursive: true });
    const alias = path.join(f.root, "oracle-alias");
    symlinkSync(f.oracle, alias);

    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.root], protectedReadRoots: [f.oracle] }), /contains a protected root/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.oracle], protectedReadRoots: [f.oracle] }), /is a protected root/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [nested], protectedReadRoots: [f.oracle] }), /inside a protected root/);
    // A symlinked alias canonicalizes onto the protected root, so it cannot slip past.
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [alias], protectedReadRoots: [f.oracle] }), /is a protected root/);

    // Permitted sibling roots stay allowed, and a mount inside a protected root does not.
    const profile = buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.system, f.mount], protectedReadRoots: [f.oracle, f.store] });
    assert.ok(profile.includes(`(subpath "${f.system}")`));
    assert.ok(profile.includes(`(subpath "${f.mount}")`));
    assert.equal(profile.includes(f.oracle), false);
    assert.equal(profile.includes(f.store), false);
    assert.throws(
      () => buildSeatbeltProfile({ mountDir: path.join(f.oracle, "den"), readRoots: [f.system], protectedReadRoots: [f.oracle] }),
      /mountDir is inside a protected root/,
    );
  } finally {
    f.dispose();
  }
});

test("network allowlisting accepts loopback 127.0.0.1:port only and keeps deny-all as the default", () => {
  const f = fixture();
  try {
    const pinned = buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.system], allowNetworkHosts: [LOOPBACK_PROXY] });
    assert.ok(pinned.includes('(require-all (remote tcp "localhost:41001") (socket-domain AF_INET))'));
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.system], allowNetworkHosts: ["api.example.com:443"] }), /loopback/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.system], allowNetworkHosts: ["203.0.113.7:443"] }), /loopback/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.system], allowNetworkHosts: ["127.0.0.1:0"] }), /out of range/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.system], allowNetworkHosts: ["127.0.0.1:70000"] }), /out of range/);
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: [f.system], allowNetworkHosts: "127.0.0.1:1" }), /array/);
  } finally {
    f.dispose();
  }
});

test("secret-like variables are dropped from the probe environment instead of trusted", () => {
  const env = buildProbeEnvironment({ PATH: "/usr/bin", OPENAI_API_KEY: "sk-live", GITHUB_TOKEN: "gh", HOME: "/root" });
  assert.deepEqual(env, { PATH: "/usr/bin", HOME: "/root" });
});

test("a probe set that cannot be enforced reports unavailable, never a pass", () => {
  const f = fixture();
  try {
    const noRuntime = probeIsolation({ mountDir: f.mount, runtime: null });
    assert.equal(noRuntime.status, "unavailable");
    assert.equal(noRuntime.reason, "no_enforceable_runtime");
    assert.deepEqual(noRuntime.probes, []);
    assert.equal(probeIsolation({ mountDir: "" }).status, "unavailable");

    // Live-only properties without the complete live set never degrade to derived roots.
    const incomplete = probeIsolation({
      mountDir: f.mount,
      runtime: SEATBELT_RUNTIME,
      run: fakeRun().run,
      listener: stubListener,
      outsideDir: f.root,
      protectedFiles: { oracle: f.oracle, credential: f.credential, store: f.store },
      inputPath: f.input,
      runtimePath: process.execPath,
      blockedNetworkHost: LOOPBACK_OTHER,
      allowNetwork: true,
      allowNetworkHosts: [LOOPBACK_PROXY],
    });
    assert.equal(incomplete.status, "unavailable");
    assert.equal(incomplete.reason, "live_probe_incomplete");
    assert.ok(incomplete.missing.includes("readRoots"));
    assert.deepEqual(incomplete.probes, []);

    const missingTarget = probeIsolation({
      mountDir: f.mount,
      runtime: SEATBELT_RUNTIME,
      run: fakeRun().run,
      listener: stubListener,
      outsideDir: f.root,
      ...liveArgs(f),
      protectedFiles: { oracle: path.join(f.root, "no-oracle"), credential: f.credential, store: f.store },
    });
    assert.equal(missingTarget.status, "unavailable");
    assert.equal(missingTarget.reason, "protected_target_missing");

    const badRoot = probeIsolation({ mountDir: f.mount, readRoots: [path.join(f.root, "ghost")], runtime: SEATBELT_RUNTIME, run: fakeRun().run, listener: stubListener, outsideDir: f.root });
    assert.equal(badRoot.reason, "read_roots_invalid");

    // An explicitly empty root set is not treated as "derive something": it is rejected.
    const emptyRoots = probeIsolation({ mountDir: f.mount, readRoots: [], runtime: SEATBELT_RUNTIME, run: fakeRun().run, listener: stubListener, outsideDir: f.root });
    assert.equal(emptyRoots.status, "unavailable");
    assert.equal(emptyRoots.reason, "read_roots_invalid");

    // A live probe without its loopback proxy allowlist never turns into a pass.
    const noProxy = probeIsolation({ ...liveArgs(f), allowNetworkHosts: [], run: fakeRun().run, listener: stubListener, outsideDir: f.root });
    assert.equal(noProxy.reason, "live_probe_incomplete");
    assert.ok(noProxy.missing.includes("allowNetworkHosts"));

    const overlap = probeIsolation({ mountDir: f.mount, readRoots: [f.root], protectedReadRoots: [f.oracle], runtime: SEATBELT_RUNTIME, run: fakeRun().run, listener: stubListener, outsideDir: f.root });
    assert.equal(overlap.reason, "profile_rejected");
  } finally {
    f.dispose();
  }
});

test("an offline probe derives bounded roots, binds the exact profile and passes with working controls", () => {
  const f = fixture();
  try {
    const fake = fakeRun({ denyNeedles: ["outside-probe.txt", LOOPBACK_OTHER], materialize: f.insideProbe });
    const result = probeIsolation({
      mountDir: f.mount,
      runtime: SEATBELT_RUNTIME,
      run: fake.run,
      listener: stubListener,
      outsideDir: f.root,
      env: { PATH: "/usr/bin", OPENAI_API_KEY: "sk-live" },
    });

    assert.equal(result.status, "pass", JSON.stringify(result.probes));
    assert.equal(result.mode, "offline");
    assert.equal(result.readRootsSource, "derived");
    assert.ok(result.readRoots.includes(realpathSync(f.mount)), "the trial mount is readable");
    assert.ok(result.readRoots.length >= 2, "derived roots stay a bounded set");
    assert.equal(result.profile.includes("(allow file-read*)"), false, "derived roots never become a global read");
    assert.ok(result.profile.includes(`(subpath "${realpathSync(f.mount)}")`));
    assert.equal(result.allowlist.mode, "deny-all");
    assert.deepEqual(result.allowlist.hosts, []);
    assert.equal(result.profileDigest, createHash("sha256").update(result.profile).digest("hex"));
    assert.match(result.profileDigestNormalized, /^[0-9a-f]{64}$/);
    assert.ok(result.profileDigestNormalized !== result.profileDigest, "the normalized digest is not the raw digest");
    assert.deepEqual(result.envBinding.keys, ["PATH"]);
    assert.equal(JSON.stringify(result).includes("sk-live"), false, "no environment value reaches the receipt");
    assert.equal("env" in result, false, "no raw original environment is returned");
    assert.ok(result.probes.every((probe) => probe.passed === true));
    assert.equal(result.probes.find((probe) => probe.id === "read_input_allowed").passed, true);
    assert.equal(result.probes.find((probe) => probe.id === "read_runtime_allowed").passed, true);
  } finally {
    f.dispose();
  }
});

test("a runtime that permits the denied action or blocks the control fails closed", () => {
  const f = fixture();
  try {
    // Every sandboxed action succeeds: the sandbox is not containing anything.
    const open = probeIsolation({
      mountDir: f.mount,
      readRoots: [f.system, f.mount],
      runtime: SEATBELT_RUNTIME,
      run: fakeRun({ materialize: f.insideProbe }).run,
      listener: stubListener,
      outsideDir: f.root,
    });
    assert.equal(open.status, "fail");
    assert.equal(open.probes.find((probe) => probe.id === "write_outside_mount_denied").passed, false);

    // The control fails, so the profile proves nothing about an allowed write.
    const closed = probeIsolation({
      mountDir: f.mount,
      readRoots: [f.system, f.mount],
      runtime: SEATBELT_RUNTIME,
      run: fakeRun({ denyNeedles: ["outside-probe.txt", LOOPBACK_OTHER], outcomes: { "inside-probe.txt": REJECTED } }).run,
      listener: stubListener,
      outsideDir: f.root,
    });
    assert.equal(closed.status, "fail");
    assert.equal(closed.probes.find((probe) => probe.id === "write_inside_mount_allowed").passed, false);
  } finally {
    f.dispose();
  }
});

test("a protected read denial without a reachable control is unproven, not a pass", () => {
  const f = fixture();
  try {
    // The oracle read is denied both inside and outside the sandbox, so the
    // denial proves nothing about enforcement.
    const blind = probeIsolation({
      ...liveArgs(f),
      run: fakeRun({ denyNeedles: ["outside-probe.txt", LOOPBACK_OTHER, "oracle.json", "credential.env", f.store], outcomes: { "oracle.json": REJECTED }, materialize: f.insideProbe }).run,
      listener: stubListener,
      outsideDir: f.root,
    });
    const oracle = blind.probes.find((probe) => probe.id === "read_oracle_denied");
    assert.equal(oracle.passed, false);
    assert.equal(oracle.control, "unavailable");
    assert.equal(blind.status, "unavailable");
    assert.equal(blind.reason, "read_oracle_denied");
  } finally {
    f.dispose();
  }
});

test("a live probe proves runtime/input/proxy reads and denies protected reads and other network", () => {
  const f = fixture();
  try {
    const fake = fakeRun({
      denyNeedles: ["outside-probe.txt", LOOPBACK_OTHER, "oracle.json", "credential.env", f.store],
      materialize: f.insideProbe,
    });
    const result = probeIsolation({ ...liveArgs(f), run: fake.run, listener: stubListener, outsideDir: f.root });

    assert.equal(result.status, "pass", JSON.stringify(result.probes));
    assert.equal(result.mode, "live");
    assert.equal(result.readRootsSource, "explicit");
    assert.deepEqual(result.readRoots, [f.system, f.mount]);
    assert.deepEqual(result.protectedReadRoots, [f.oracle, f.store, f.credential]);
    assert.deepEqual(result.allowlist, { mode: "ip-allowlist", hosts: [LOOPBACK_PROXY] });
    assert.ok(result.profile.includes('(require-all (remote tcp "localhost:41001") (socket-domain AF_INET))'));
    assert.equal(result.profile.includes(f.oracle), false, "a protected root is never granted a read");

    const byId = new Map(result.probes.map((probe) => [probe.id, probe]));
    for (const id of ["read_runtime_allowed", "read_input_allowed", "runtime_child_start_allowed", "network_proxy_connect_allowed", "write_inside_mount_allowed"]) {
      assert.equal(byId.get(id).passed, true, `${id} is a positive control`);
    }
    for (const id of ["read_oracle_denied", "read_credential_denied", "read_store_denied", "network_other_denied"]) {
      assert.equal(byId.get(id).passed, true, `${id} is a negative control`);
      assert.equal(byId.get(id).control, "pass", `${id} keeps its reachable control`);
    }
    // The blocked network probe used TCP sockets, not an HTTP fetch.
    assert.ok(fake.seen.some((call) => call.command !== SEATBELT_BIN && call.script.includes("node:net")));
  } finally {
    f.dispose();
  }
});

test("an offline caller with a not-yet-created mount still gets the mount as a bounded root", () => {
  const f = fixture();
  try {
    const freshMount = path.join(f.root, "fresh", "mount");
    const result = probeIsolation({
      mountDir: freshMount,
      runtime: SEATBELT_RUNTIME,
      run: fakeRun({ denyNeedles: ["outside-probe.txt", LOOPBACK_OTHER], materialize: path.join(freshMount, "inside-probe.txt") }).run,
      listener: stubListener,
      outsideDir: f.root,
    });
    assert.equal(result.status, "pass", JSON.stringify(result.probes));
    assert.ok(result.readRoots.includes(realpathSync(freshMount)), "the created mount joins the derived roots");
  } finally {
    f.dispose();
  }
});

test("a missing offline network control is reported unavailable instead of a vacuous denial", () => {
  const f = fixture();
  try {
    const result = probeIsolation({
      mountDir: f.mount,
      readRoots: [f.system, f.mount],
      runtime: SEATBELT_RUNTIME,
      run: fakeRun({ denyNeedles: ["outside-probe.txt"], materialize: f.insideProbe }).run,
      listener: () => null,
      outsideDir: f.root,
    });
    const egress = result.probes.find((probe) => probe.id === "network_egress_denied");
    assert.equal(egress.passed, false);
    assert.equal(egress.control, "unavailable");
    assert.equal(result.status, "unavailable");
  } finally {
    f.dispose();
  }
});

test("a real seatbelt runtime passes the offline probe set on macOS", { skip: process.platform !== "darwin" && "seatbelt is macOS-only" }, async () => {
  const { existsSync } = await import("node:fs");
  const mount = mkdtempSync(path.join(tmpdir(), "harness2-probe-test-"));
  try {
    const result = probeIsolation({ mountDir: mount });
    assert.equal(result.runtime, SEATBELT_RUNTIME);
    assert.equal(result.status, "pass", JSON.stringify(result.probes));
    assert.equal(result.readRootsSource, "derived");
    assert.equal(existsSync(path.join(mount, "inside-probe.txt")), false, "the probe file does not survive the run");
  } finally {
    rmSync(mount, { recursive: true, force: true });
  }
});

test("a real seatbelt runtime enforces the live profile on macOS", { skip: process.platform !== "darwin" && "seatbelt is macOS-only" }, () => {
  const f = fixture();
  const proxy = startLoopbackListener();
  const other = startLoopbackListener();
  try {
    assert.notEqual(proxy, null, "the allowlisted loopback proxy control is reachable");
    assert.notEqual(other, null, "the blocked loopback control is reachable");
    const result = probeIsolation({
      mountDir: f.mount,
      readRoots: [...runtimeReadRoots(), f.mount],
      protectedReadRoots: [f.oracle, f.store, f.credential],
      protectedFiles: { oracle: f.oracle, credential: f.credential, store: f.store },
      inputPath: f.input,
      runtimePath: process.execPath,
      allowNetwork: true,
      allowNetworkHosts: [proxy.host],
      blockedNetworkHost: other.host,
    });
    assert.equal(result.status, "pass", JSON.stringify(result.probes));
    assert.equal(result.mode, "live");
    assert.equal(result.profile.includes("(allow file-read*)"), false);
  } finally {
    proxy?.stop();
    other?.stop();
    f.dispose();
  }
});

test("real protected data stays denied through mount symlinks and the Data-volume alias", { skip: process.platform !== "darwin" && "seatbelt is macOS-only" }, () => {
  const f = fixture();
  try {
    assert.throws(() => buildSeatbeltProfile({ mountDir: f.mount, readRoots: ["/System"] }), /data-volume alias/);
    const link = path.join(f.mount, "credential-link");
    symlinkSync(f.credential, link);
    const alias = `/System/Volumes/Data${f.credential}`;
    const profile = buildSeatbeltProfile({ mountDir: f.mount, readRoots: [...runtimeReadRoots(), f.mount], protectedReadRoots: [f.credential] });
    const env = { PATH: "/usr/bin:/bin", HOME: f.mount, TMPDIR: f.mount };
    for (const target of [f.credential, link, alias]) {
      const args = ["/bin/sh", "-c", 'dd if="$1" of=/dev/null bs=1 count=1', "probe", target];
      const control = spawnSync(args[0], args.slice(1), { env, encoding: "utf8", timeout: 5000 });
      assert.equal(control.status, 0, `owned positive control must be readable: ${target}`);
      const denied = spawnSync(SEATBELT_BIN, ["-p", profile, ...args], { env, encoding: "utf8", timeout: 5000 });
      assert.notEqual(denied.status, 0, `protected read denied: ${target}`);
    }
  } finally { f.dispose(); }
});

test("the IPv4 proxy grant does not admit IPv6 at the same port", { skip: process.platform !== "darwin" && "seatbelt is macOS-only" }, async () => {
  const f = fixture();
  const ipv4 = startLoopbackListener();
  const ipv6 = createServer((socket) => socket.destroy());
  try {
    assert.notEqual(ipv4, null);
    const port = Number(ipv4.host.split(":")[1]);
    await new Promise((resolve, reject) => { ipv6.once("error", reject); ipv6.listen({ host: "::1", port, ipv6Only: true }, resolve); });
    const profile = buildSeatbeltProfile({ mountDir: f.mount, readRoots: [...runtimeReadRoots(), f.mount], allowNetworkHosts: [ipv4.host] });
    const env = { PATH: "/usr/bin:/bin", HOME: f.mount, TMPDIR: f.mount };
    const script = (host) => `const net=require('node:net');const s=net.connect({host:${JSON.stringify(host)},port:${port}});s.on('connect',()=>{s.destroy();process.exit(0)});s.on('error',()=>process.exit(3));setTimeout(()=>process.exit(4),1000);`;
    assert.equal(spawnSync(process.execPath, ["-e", script("::1")], { env, timeout: 5000 }).status, 0, "IPv6 negative target has a positive unsandboxed control");
    assert.equal(spawnSync(SEATBELT_BIN, ["-p", profile, process.execPath, "-e", script("127.0.0.1")], { env, timeout: 5000 }).status, 0, "intended IPv4 endpoint remains usable");
    assert.notEqual(spawnSync(SEATBELT_BIN, ["-p", profile, process.execPath, "-e", script("::1")], { env, timeout: 5000 }).status, 0, "same-port IPv6 is not the allowlisted endpoint");
  } finally {
    ipv4?.stop();
    await new Promise((resolve) => ipv6.close(resolve));
    f.dispose();
  }
});
