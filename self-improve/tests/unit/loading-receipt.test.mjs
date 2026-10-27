import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildLoadingReceipt,
  canonicalJson,
  collectLoadingReceipt,
  collectPluginState,
  isSecretTarget,
  verifyLoadingReceipt,
} from "../../lib/loading-receipt.mjs";

const hex = (char) => char.repeat(64);

const pluginState = (overrides = {}) => ({
  status: "ok",
  reason: null,
  plugins: [
    {
      name: "rrsi",
      version: "0.0.4",
      enabled: true,
      quarantined: false,
      manifestHash: hex("1"),
      targetFingerprint: hex("2"),
      surfaces: [{ kind: "tool", name: "rrsi", enabled: true, quarantined: false }],
      ...overrides,
    },
  ],
});

const harnessDigest = (overrides = {}) => ({
  rootHash: hex("3"),
  rows: [{ path: "gjc-plugins/rrsi", sha256: hex("4"), size: 10 }],
  ...overrides,
});

const receiptFor = (expected = { plugins: ["rrsi"] }) =>
  buildLoadingReceipt({ pluginState: pluginState(), harnessDigest: harnessDigest(), expected });

test("identical inputs produce one canonical digest; key order does not matter", () => {
  const first = receiptFor();
  const second = receiptFor();
  assert.equal(first.loaded, true);
  assert.equal(first.sha256, second.sha256);
  assert.equal(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] }), canonicalJson({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.deepEqual(verifyLoadingReceipt(first), { ok: true, reason: null });
});

test("a changed manifest hash at the same version changes the digest", () => {
  const base = receiptFor();
  const changed = buildLoadingReceipt({
    pluginState: pluginState({ manifestHash: hex("9") }),
    harnessDigest: harnessDigest(),
    expected: { plugins: ["rrsi"] },
  });
  assert.notEqual(changed.sha256, base.sha256);
});

test("quarantined, disabled and missing surfaces fail closed with exact codes", () => {
  const quarantined = buildLoadingReceipt({
    pluginState: pluginState({ surfaces: [{ kind: "tool", name: "rrsi", enabled: true, quarantined: true }] }),
    harnessDigest: harnessDigest(),
    expected: { surfaces: [{ plugin: "rrsi", name: "rrsi" }] },
  });
  assert.equal(quarantined.loaded, false);
  assert.ok(quarantined.failures.includes("surface_quarantined"));

  const disabled = buildLoadingReceipt({ pluginState: pluginState({ enabled: false }), harnessDigest: harnessDigest(), expected: { plugins: ["rrsi"] } });
  assert.equal(disabled.loaded, false);
  assert.ok(disabled.failures.includes("plugin_disabled"));

  const missing = buildLoadingReceipt({ pluginState: pluginState(), harnessDigest: harnessDigest(), expected: { plugins: ["nope"] } });
  assert.equal(missing.loaded, false);
  assert.ok(missing.failures.includes("plugin_missing"));
});

test("no gjc binary and an empty expectation both fail closed", () => {
  const unavailable = collectPluginState({ run: () => ({ status: null, stdout: "", stderr: "spawn failed" }) });
  assert.equal(unavailable.status, "unavailable");
  const receipt = buildLoadingReceipt({ pluginState: unavailable, harnessDigest: harnessDigest(), expected: { plugins: ["rrsi"] } });
  assert.equal(receipt.loaded, false);
  assert.ok(receipt.failures.includes("gjc_unavailable"));

  const empty = buildLoadingReceipt({ pluginState: pluginState(), harnessDigest: harnessDigest(), expected: {} });
  assert.equal(empty.loaded, false);
  assert.deepEqual(empty.failures, ["expectations_empty"]);

  const guardOnly = buildLoadingReceipt({ pluginState: pluginState(), harnessDigest: harnessDigest(), expected: { guards: [{ id: "paths", resolved: true }] } });
  assert.equal(guardOnly.loaded, true, "a guard-only run declares guards and is not empty");
  const unresolved = buildLoadingReceipt({ pluginState: pluginState(), harnessDigest: harnessDigest(), expected: { guards: [{ id: "paths" }] } });
  assert.equal(unresolved.loaded, false);
  assert.ok(unresolved.failures.includes("guard_unresolved"));
});

test("a missing harness target is not a pass", () => {
  const receipt = buildLoadingReceipt({
    pluginState: pluginState(),
    harnessDigest: { rootHash: null, rows: [] },
    expected: { plugins: ["rrsi"] },
  });
  assert.equal(receipt.loaded, false);
  assert.ok(receipt.failures.includes("harness_target_missing"));
});

test("secret-like digest targets are excluded, and the receipt redacts absolute roots", () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "harness2-lr-")));
  try {
    const agentDir = path.join(root, ".gjc", "agent");
    mkdirSync(path.join(agentDir, "jev-advisor"), { recursive: true, mode: 0o700 });
    writeFileSync(path.join(agentDir, "jev-advisor", ".env"), "KEY=secret\n");
    writeFileSync(path.join(agentDir, "jev-advisor", "config.json"), "{}\n");
    assert.equal(isSecretTarget("jev-advisor/.env"), true);
    const receipt = collectLoadingReceipt({
      agentDir,
      sourceHead: "e6e38a1",
      targets: ["jev-advisor/.env", "jev-advisor/config.json"],
      expected: { guards: [{ id: "paths", resolved: true }] },
      run: () => ({
        status: 0,
        stdout: JSON.stringify({ gjc: [{ identity: { name: "rrsi" }, version: "0.0.4", enabled: true, surfaces: [{ kind: "tool", name: "rrsi", enabled: true }] }] }),
        stderr: "",
      }),
    });
    assert.equal(receipt.loaded, true);
    assert.deepEqual(receipt.excludedTargets, [".env"]);
    const text = canonicalJson(receipt.payload);
    assert.equal(text.includes(root), false, "no absolute temp path survives redaction");
    assert.equal(text.includes("KEY=secret"), false, "no credential content is embedded");
    assert.equal(text.includes(".env"), false, "the excluded target contributes no row");
    assert.equal(verifyLoadingReceipt(receipt).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an oversized payload fails closed and cannot be verified", () => {
  const surfaces = Array.from({ length: 64 }, (_, index) => ({ kind: "tool", name: `surface-${index}-${"x".repeat(40)}`, enabled: true, quarantined: false }));
  const plugins = Array.from({ length: 32 }, (_, index) => ({
    name: `plugin-${index}`,
    version: "0.0.1",
    enabled: true,
    quarantined: false,
    manifestHash: hex("1"),
    targetFingerprint: hex("2"),
    surfaces,
  }));
  const receipt = buildLoadingReceipt({ pluginState: { status: "ok", reason: null, plugins }, harnessDigest: harnessDigest(), expected: { plugins: ["plugin-0"] } });
  assert.equal(receipt.loaded, false);
  assert.ok(receipt.failures.includes("payload_oversized"));
  assert.ok(receipt.canonicalBytes > 8 * 1024);
  assert.deepEqual(verifyLoadingReceipt(receipt), { ok: false, reason: "loading_payload_mismatch" });
});

test("the digest is re-derived: a tampered or unloaded receipt is rejected", () => {
  const receipt = receiptFor();
  const tampered = { ...receipt, payload: { ...receipt.payload, sourceHead: "deadbeef" } };
  assert.deepEqual(verifyLoadingReceipt(tampered), { ok: false, reason: "loading_payload_mismatch" });
  const unloaded = { ...receipt, loaded: false };
  assert.deepEqual(verifyLoadingReceipt(unloaded), { ok: false, reason: "loading_not_proven" });
  assert.deepEqual(verifyLoadingReceipt({ sha256: hex("a"), loaded: true }), { ok: false, reason: "loading_payload_missing" });
});
