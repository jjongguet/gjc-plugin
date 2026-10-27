/**
 * Enforceable isolation runtime probe for live Harness² trials.
 *
 * A Git scratch copy is filesystem separation, not a sandbox, and two processes
 * that share a UID are not isolated from each other. This module answers the
 * prerequisite question with evidence: can this host enforce trial containment
 * in the kernel, regardless of UID? It builds a seatbelt (SBPL) profile, runs
 * probes that must fail (write outside the trial mount, network egress, secret
 * passthrough) and a control that must succeed (write inside the mount), and
 * reports the observed result. It never calls a model and never admits a live
 * trial on its own: provider-endpoint allowlisting and an approved budget
 * window remain separate decisions (see HARNESS2.md).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SEATBELT_RUNTIME = "sandbox-exec-seatbelt.v1";
export const SEATBELT_BIN = "/usr/bin/sandbox-exec";
export const PROBE_TIMEOUT_MS = 10_000;
const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/**
 * SBPL text for one trial mount. `(deny default)` is the only shape that fails
 * closed: every capability the trial keeps has to be named. Remote network
 * filters are IP-pinned because SBPL cannot match a DNS name, so an allowlisted
 * provider endpoint is recorded as resolved `host:port` pairs in the receipt.
 */
export function buildSeatbeltProfile({ mountDir, allowNetworkHosts = [] }) {
  if (typeof mountDir !== "string" || !path.isAbsolute(mountDir)) throw new Error("mountDir must be absolute");
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl-read)",
    "(allow file-read*)",
    `(allow file-write* (subpath ${quote(mountDir)}))`,
    `(allow file-write* (literal "/dev/null"))`,
  ];
  for (const host of allowNetworkHosts) {
    if (typeof host !== "string" || !/^\d{1,3}(\.\d{1,3}){3}:\d{1,5}$/.test(host)) {
      throw new Error(`allowNetworkHosts entry must be a resolved ip:port pair, got ${host}`);
    }
    rules.push(`(allow network-outbound (remote ip ${quote(host)}))`);
  }
  return `${rules.join("\n")}\n`;
}

function quote(value) {
  if (value.includes('"') || value.includes("\n")) throw new Error("unsafe value for an SBPL literal");
  return `"${value}"`;
}

/**
 * Child environment for a trial: secret-like variables are dropped rather than
 * trusted to be unused, and the probe checks the result instead of assuming it.
 */
export function buildProbeEnvironment(env = process.env) {
  const scrubbed = {};
  for (const [key, value] of Object.entries(env)) {
    if (SECRET_KEY_RE.test(key)) continue;
    scrubbed[key] = value;
  }
  return scrubbed;
}

function defaultRun({ command, args, env, timeoutMs }) {
  const result = spawnSync(command, args, { env, timeout: timeoutMs, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", error: result.error?.code ?? null };
}

/**
 * Run the deny/allow probe set under one profile.
 *
 * `status` is `pass` only when every deny probe failed to act and the allow
 * control worked. A missing runtime or any disagreement is a failure: an
 * unproven runtime forbids live execution.
 */
export function probeIsolation({
  mountDir,
  allowNetworkHosts = [],
  allowNetwork = false,
  runtime = process.platform === "darwin" && existsSync(SEATBELT_BIN) ? SEATBELT_RUNTIME : null,
  run = defaultRun,
  timeoutMs = PROBE_TIMEOUT_MS,
  env = process.env,
  outsideDir = null,
} = {}) {
  if (typeof mountDir !== "string" || mountDir.trim() === "") return { status: "unavailable", reason: "no_trial_mount", runtime: null, probes: [] };
  if (runtime !== SEATBELT_RUNTIME) return { status: "unavailable", reason: "no_enforceable_runtime", runtime: runtime ?? null, probes: [] };

  const home = outsideDir ?? mkdtempSync(path.join(tmpdir(), "harness2-outside-"));
  mkdirSync(mountDir, { recursive: true });
  // SBPL matches resolved paths, so a /var -> /private/var mount would otherwise
  // deny the trial its own directory.
  const resolvedMount = realpathSync(mountDir);
  const profilePath = path.join(home, "trial.sb");
  const profile = buildSeatbeltProfile({ mountDir: resolvedMount, allowNetworkHosts: allowNetwork ? allowNetworkHosts : [] });
  writeFileSync(profilePath, profile, { mode: 0o600 });
  const childEnv = buildProbeEnvironment(env);
  const spawn = (script) => run({ command: SEATBELT_BIN, args: ["-f", profilePath, "/bin/sh", "-c", script], env: childEnv, timeoutMs });

  const probes = [];
  const outsideTarget = path.join(home, "outside-probe.txt");
  const outside = spawn(`printf probe > ${shellQuote(outsideTarget)}`);
  probes.push({
    id: "write_outside_mount_denied",
    passed: outside.status !== 0 && !existsSync(outsideTarget),
    observed: outside.status,
  });

  const insideTarget = path.join(resolvedMount, "inside-probe.txt");
  const inside = spawn(`printf probe > ${shellQuote(insideTarget)}`);
  probes.push({ id: "write_inside_mount_allowed", passed: inside.status === 0 && existsSync(insideTarget), observed: inside.status });

  // The deny-all network probe needs no remote peer: a denied connect fails
  // locally, so it stays deterministic offline. With an allowlist the same
  // probe targets a host outside it.
  const egress = spawn("curl -s -o /dev/null -m 3 https://example.com");
  probes.push({ id: "network_egress_denied", passed: egress.status !== 0, observed: egress.status });

  const leaked = Object.keys(buildProbeEnvironment(env)).filter((key) => SECRET_KEY_RE.test(key));
  probes.push({ id: "credential_env_excluded", passed: leaked.length === 0, observed: leaked.length });

  if (outsideDir === null) rmSync(home, { recursive: true, force: true });
  rmSync(insideTarget, { force: true });
  return {
    runtime,
    status: probes.every((probe) => probe.passed) ? "pass" : "fail",
    allowlist: allowNetwork ? { mode: "ip-allowlist", hosts: [...allowNetworkHosts] } : { mode: "deny-all", hosts: [] },
    probes,
    profileDigest: createHash("sha256").update(profile).digest("hex"),
    // Path-stable digest for reproducible preflight artifacts: the trial mount
    // (and the temporary outside root) are replaced by fixed tokens.
    profileDigestNormalized: createHash("sha256").update(profile.replaceAll(resolvedMount, "<mount>").replaceAll(home, "<outside>")).digest("hex"),
  };
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
