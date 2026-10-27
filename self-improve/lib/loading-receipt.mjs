/**
 * Loader-resolved surface identity for a Harness² trial.
 *
 * The receipt answers one question: which surfaces did the loader resolve and
 * enable for this run, and what do they contain? It composes
 * `gjc plugin list --json` (whitelisted, redacted, defensively parsed) with the
 * existing `computeHarnessDigest` manifest over explicit targets, then embeds a
 * canonical payload whose sha256 is the `sha256` field.
 *
 * Boundary: this proves loader-resolved surfaces and payload integrity. It does
 * NOT prove that a model used them, and a self-consistent forgery still passes
 * the re-derivation check — the payload is the producer's claim. Task outcomes
 * stay with the independent oracle in `behavior-eval.mjs`.
 *
 * Keyless and offline: the only process this module spawns is the read-only
 * `gjc plugin list --json` query (injectable for tests).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { computeHarnessDigest, defaultAgentDir } from "./isolate.mjs";

export const LOADING_RECEIPT_SCHEMA = "harness2.loading_receipt.v1";

export const LOADING_RECEIPT_LIMITS = Object.freeze({
  maxPayloadBytes: 8 * 1024,
  maxPlugins: 32,
  maxSurfaces: 64,
  maxTargets: 16,
  maxIdChars: 80,
});

export const LOADING_FAILURE_CODES = Object.freeze([
  "gjc_unavailable",
  "plugin_state_unavailable",
  "expectations_empty",
  "plugin_missing",
  "plugin_disabled",
  "surface_missing",
  "surface_quarantined",
  "harness_target_missing",
  "guard_unresolved",
  "payload_oversized",
  "loading_payload_missing",
  "loading_payload_mismatch",
  "loading_not_proven",
]);

const SECRET_PATH_RE = /(^|\/)(\.env[^/]*|keys\.local[^/]*|credentials[^/]*|secrets?[^/]*)$|\.(pem|key|p12|pfx)$/i;
const isText = (value, max = LOADING_RECEIPT_LIMITS.maxIdChars) =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max;

const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

/** Recursively key-sorted JSON so byte-identical content yields one digest. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

/** Redact absolute roots so a receipt never carries a user or install path. */
export function redactValue(value, { home = os.homedir(), repoRoot = null, agentDir = null } = {}) {
  if (typeof value === "string") {
    let text = value;
    if (agentDir && text.startsWith(agentDir)) text = `<agent>${text.slice(agentDir.length)}`;
    if (repoRoot && text.startsWith(repoRoot)) text = `.${text.slice(repoRoot.length)}`;
    if (home && text.startsWith(home)) text = `~${text.slice(home.length)}`;
    return text;
  }
  if (Array.isArray(value)) return value.map((entry) => redactValue(entry, { home, repoRoot, agentDir }));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactValue(entry, { home, repoRoot, agentDir })]));
  }
  return value;
}

/** True when a digest target looks like a credential-bearing path. */
export function isSecretTarget(target) {
  return typeof target === "string" && SECRET_PATH_RE.test(target.replaceAll("\\", "/"));
}

function defaultRun(command, args, env) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 20_000, env });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/**
 * Read-only loader state from `gjc plugin list --json`. Unknown or absent
 * shapes are `plugin_state_unavailable`, never a pass.
 */
export function collectPluginState({ gjcBin = "gjc", env = process.env, run = defaultRun } = {}) {
  const result = run(gjcBin, ["plugin", "list", "--json"], env);
  if (!result || result.status !== 0) {
    return { status: result && result.status === null ? "unavailable" : "invalid", reason: "gjc_unavailable", plugins: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { status: "invalid", reason: "plugin_state_unavailable", plugins: [] };
  }
  const list = Array.isArray(parsed?.gjc) ? parsed.gjc : null;
  if (!list) return { status: "invalid", reason: "plugin_state_unavailable", plugins: [] };
  const plugins = [];
  for (const entry of list.slice(0, LOADING_RECEIPT_LIMITS.maxPlugins)) {
    const name = entry?.identity?.name;
    if (!isText(name, 64)) continue;
    const surfaces = Array.isArray(entry.surfaces)
      ? entry.surfaces.slice(0, LOADING_RECEIPT_LIMITS.maxSurfaces).map((surface) => ({
          kind: isText(surface?.kind, 24) ? surface.kind : "unknown",
          name: isText(surface?.name, 64) ? surface.name : "unknown",
          enabled: surface?.enabled === true,
          quarantined: surface?.quarantined === true,
        }))
      : [];
    plugins.push({
      name,
      version: isText(entry.version, 40) ? entry.version : null,
      enabled: entry.enabled === true,
      quarantined: entry.quarantined === true,
      manifestHash: isText(entry.manifestHash, 64) ? entry.manifestHash : null,
      targetFingerprint: isText(entry.targetFingerprint, 64) ? entry.targetFingerprint : null,
      surfaces,
    });
  }
  return { status: "ok", reason: null, plugins };
}

/**
 * Pure receipt builder. The caller supplies the loader state, the harness
 * digest and the consumer expectations; this function only decides failures,
 * bounds and the canonical digest.
 */
export function buildLoadingReceipt({
  sourceHead = null,
  gjcVersion = null,
  pluginState,
  harnessDigest,
  expected = {},
  home = os.homedir(),
  repoRoot = null,
  agentDir = null,
} = {}) {
  const failures = [];
  const state = pluginState && typeof pluginState === "object" ? pluginState : { status: "invalid", reason: "plugin_state_unavailable", plugins: [] };
  if (state.status !== "ok") failures.push(state.reason === "gjc_unavailable" ? "gjc_unavailable" : "plugin_state_unavailable");
  const plugins = Array.isArray(state.plugins) ? state.plugins : [];
  const byName = new Map(plugins.map((plugin) => [plugin.name, plugin]));

  const wantedPlugins = Array.isArray(expected.plugins) ? expected.plugins.filter((name) => isText(name, 64)) : [];
  const wantedSurfaces = Array.isArray(expected.surfaces)
    ? expected.surfaces.filter((surface) => isText(surface?.plugin, 64) && isText(surface?.name, 64)).slice(0, LOADING_RECEIPT_LIMITS.maxSurfaces)
    : [];
  const wantedGuards = Array.isArray(expected.guards)
    ? expected.guards.filter((guard) => isText(guard?.id, 64)).slice(0, 16)
    : [];
  if (wantedPlugins.length === 0 && wantedSurfaces.length === 0 && wantedGuards.length === 0) {
    failures.push("expectations_empty");
  }

  for (const name of wantedPlugins) {
    const plugin = byName.get(name);
    if (!plugin) failures.push("plugin_missing");
    else if (!plugin.enabled) failures.push("plugin_disabled");
  }
  for (const wanted of wantedSurfaces) {
    const plugin = byName.get(wanted.plugin);
    const surface = plugin?.surfaces?.find((entry) => entry.name === wanted.name && (!wanted.kind || entry.kind === wanted.kind));
    if (!surface) failures.push("surface_missing");
    else if (surface.quarantined) failures.push("surface_quarantined");
    else if (!surface.enabled) failures.push("surface_missing");
  }
  for (const guard of wantedGuards) {
    if (guard.resolved !== true) failures.push("guard_unresolved");
  }

  const digest = harnessDigest && typeof harnessDigest === "object" ? harnessDigest : null;
  const rows = Array.isArray(digest?.rows) ? digest.rows : [];
  const missingRows = rows.filter((row) => row?.missing === true);
  if (rows.length === 0 || missingRows.length > 0) failures.push("harness_target_missing");

  const payload = redactValue(
    {
      schema: LOADING_RECEIPT_SCHEMA,
      sourceHead: isText(sourceHead, 64) ? sourceHead : null,
      gjcVersion: isText(gjcVersion, 40) ? gjcVersion : null,
      pluginState: { status: state.status, reason: state.reason ?? null, plugins: plugins.slice(0, LOADING_RECEIPT_LIMITS.maxPlugins) },
      harness: digest
        ? { rootHash: digest.rootHash ?? null, targets: rows.map((row) => row.path).slice(0, LOADING_RECEIPT_LIMITS.maxTargets), rows: rows.slice(0, LOADING_RECEIPT_LIMITS.maxTargets) }
        : null,
      expected: { plugins: wantedPlugins, surfaces: wantedSurfaces, guards: wantedGuards },
      failures: [...new Set(failures)].sort(),
    },
    { home, repoRoot, agentDir },
  );
  const text = canonicalJson(payload);
  const bytes = Buffer.byteLength(text);
  const bounded = bytes <= LOADING_RECEIPT_LIMITS.maxPayloadBytes;
  return {
    schema: LOADING_RECEIPT_SCHEMA,
    loaded: failures.length === 0 && bounded,
    failures: bounded ? [...new Set(failures)].sort() : [...new Set([...failures, "payload_oversized"])].sort(),
    sha256: sha256Hex(text),
    payload,
    canonicalBytes: bytes,
  };
}

/** Re-derive the payload digest. Integrity, not provenance. */
export function verifyLoadingReceipt(receipt) {
  if (!receipt || typeof receipt !== "object") return { ok: false, reason: "loading_payload_missing" };
  if (!receipt.payload || typeof receipt.payload !== "object") return { ok: false, reason: "loading_payload_missing" };
  const text = canonicalJson(receipt.payload);
  if (Buffer.byteLength(text) > LOADING_RECEIPT_LIMITS.maxPayloadBytes) return { ok: false, reason: "loading_payload_mismatch" };
  if (sha256Hex(text) !== receipt.sha256) return { ok: false, reason: "loading_payload_mismatch" };
  if (receipt.loaded !== true) return { ok: false, reason: "loading_not_proven" };
  return { ok: true, reason: null };
}

/**
 * Collect the loader state and the harness digest, then build the receipt.
 * Secret-like targets are dropped from the digest rows (presence is recorded in
 * `excludedTargets` without a digest). A missing `gjc` binary fails closed.
 */
export function collectLoadingReceipt({
  agentDir = defaultAgentDir(),
  repoRoot = null,
  sourceHead = null,
  gjcVersion = null,
  targets = [],
  expected = {},
  env = process.env,
  run = defaultRun,
  gjcBin = "gjc",
} = {}) {
  const wanted = (Array.isArray(targets) ? targets : []).filter((target) => isText(target, 240));
  const allowed = wanted.filter((target) => !isSecretTarget(target)).slice(0, LOADING_RECEIPT_LIMITS.maxTargets);
  const excludedTargets = wanted.filter((target) => isSecretTarget(target)).map((target) => path.basename(target));
  const digest = allowed.length > 0 ? computeHarnessDigest({ agentDir, targets: allowed }) : { agentDir, rows: [], rootHash: null };
  const pluginState = collectPluginState({ gjcBin, env, run });
  const receipt = buildLoadingReceipt({
    sourceHead,
    gjcVersion,
    pluginState,
    harnessDigest: digest,
    expected,
    home: os.homedir(),
    repoRoot,
    agentDir,
  });
  if (excludedTargets.length > 0) {
    receipt.excludedTargets = excludedTargets;
  }
  return receipt;
}
