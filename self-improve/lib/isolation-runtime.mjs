/**
 * Enforceable isolation runtime probe for live Harness² trials.
 *
 * A Git scratch copy is filesystem separation, not a sandbox, and two processes
 * that share a UID are not isolated from each other. This module answers the
 * prerequisite question with evidence: can this host enforce trial containment
 * in the kernel, regardless of UID? It builds a seatbelt (SBPL) profile, runs
 * probes that must fail (write outside the trial mount, read of a protected
 * oracle/credential/store target, network egress to a non-allowlisted loopback
 * port) and controls that must succeed (write inside the mount, read of the
 * runtime and the input, TCP connect to the allowlisted loopback proxy), and
 * reports the observed result. It never calls a model and never admits a live
 * trial on its own: provider-endpoint allowlisting and an approved budget
 * window remain separate decisions (see HARNESS2.md).
 *
 * Reads are never granted globally. `buildSeatbeltProfile` requires an explicit
 * non-empty set of canonical read roots; a missing or empty set throws instead
 * of falling back to `(allow file-read*)`. A root that is, contains or sits
 * inside a protected read root is rejected, so protecting the oracle, the
 * credential and the store cannot be widened to make a child run.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const SEATBELT_RUNTIME = "sandbox-exec-seatbelt.v1";
export const SEATBELT_BIN = "/usr/bin/sandbox-exec";
export const PROBE_TIMEOUT_MS = 10_000;

/** Protected targets the live profile must never make readable. */
export const PROTECTED_KEYS = Object.freeze(["oracle", "credential", "store"]);

/** The live allowlist is a parent-owned loopback proxy, never a remote peer. */
export const LOOPBACK_HOST_RE = /^127\.0\.0\.1:(\d{1,5})$/;

const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;

/**
 * SBPL text for one trial mount. `(deny default)` is the only shape that fails
 * closed: every capability the trial keeps has to be named. Reads are granted
 * per canonical root only, so an oracle/credential/store path stays denied even
 * when it shares an ancestor with a permitted root. Network grants are pinned to
 * an explicit loopback `127.0.0.1:<port>` proxy because SBPL cannot match a DNS
 * name; deny-all remains the default (no network rule at all).
 */
export function buildSeatbeltProfile({ mountDir, allowNetworkHosts = [], readRoots, protectedReadRoots = [] } = {}) {
  const resolvedMount = resolveMountDir(mountDir);
  if (!Array.isArray(readRoots) || readRoots.length === 0) {
    throw new Error("readRoots must be a non-empty array of canonical read roots; there is no global file-read fallback");
  }
  if (!Array.isArray(protectedReadRoots)) throw new Error("protectedReadRoots must be an array");
  if (!Array.isArray(allowNetworkHosts)) throw new Error("allowNetworkHosts must be an array of 127.0.0.1:port pairs");

  const roots = uniqueRoots(readRoots, readRootEntry);
  const protectedRoots = uniqueRoots(protectedReadRoots, protectedRootEntry);

  for (const root of roots) {
    for (const protectedRoot of protectedRoots) {
      if (root === protectedRoot) throw new Error(`read root is a protected root: ${root}`);
      if (isSameOrInside(protectedRoot, root)) throw new Error(`read root contains a protected root: ${root} -> ${protectedRoot}`);
      if (isSameOrInside(root, protectedRoot)) throw new Error(`read root is inside a protected root: ${root} -> ${protectedRoot}`);
    }
  }
  for (const protectedRoot of protectedRoots) {
    if (isSameOrInside(resolvedMount, protectedRoot)) throw new Error(`mountDir is inside a protected root: ${resolvedMount} -> ${protectedRoot}`);
  }

  const hosts = allowNetworkHosts.map(assertLoopbackHost);
  const rules = ["(version 1)", "(deny default)", "(allow process*)", "(allow sysctl-read)"];
  // macOS libignition opens the root inode for openat(2). This is literal-only:
  // it grants no descendant reads (see Apple's dyld-support.sb).
  rules.push('(allow file-read* file-test-existence (literal "/"))');
  const ancestors = new Set();
  for (const root of roots) {
    for (let parent = path.dirname(root); parent !== path.sep; parent = path.dirname(parent)) ancestors.add(parent);
  }
  // Directory traversal for openat(2), without granting their subtrees (in
  // particular, never /System/Volumes/Data and its aliases of private data).
  for (const parent of ancestors) rules.push(`(allow file-read* file-test-existence (literal ${quote(parent)}))`);
  for (const root of roots) {
    rules.push(`(allow file-read* (literal ${quote(root)})${statSync(root).isDirectory() ? ` (subpath ${quote(root)})` : ""})`);
  }
  rules.push(`(allow file-write* (subpath ${quote(resolvedMount)}))`);
  rules.push(`(allow file-write* (literal ${quote("/dev/null")}))`);
  // Seatbelt accepts the localhost token, not a numeric host in this filter.
  // Input remains pinned to IPv4 loopback; the grant is only its exact port.
  for (const host of hosts) rules.push(`(allow network-outbound (require-all (remote tcp ${quote(host.replace("127.0.0.1:", "localhost:"))}) (socket-domain AF_INET)))`);
  return `${rules.join("\n")}\n`;
}

/**
 * Resolve one mount path: absolute and non-root are required, an existing path
 * is canonicalized so a `/var -> /private/var` seatbelt match still works.
 */
function resolveMountDir(value) {
  if (typeof value !== "string" || !path.isAbsolute(value)) throw new Error("mountDir must be absolute");
  const resolved = path.resolve(value);
  if (resolved === path.sep) throw new Error("mountDir must not be the filesystem root");
  try {
    return realpathSync(resolved);
  } catch (error) {
    if (error?.code === "ENOENT") return resolved;
    throw error;
  }
}

/** Canonical, existing read target; files receive a literal grant, never a subtree. */
function canonicalReadRoot(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} entry must be a non-empty string`);
  if (!path.isAbsolute(value)) throw new Error(`${label} entry must be absolute: ${value}`);
  const resolved = path.resolve(value);
  if (resolved === path.sep) throw new Error(`${label} entry must not be the filesystem root: ${value}`);
  let real;
  try {
    real = realpathSync(resolved);
  } catch (error) {
    throw new Error(`${label} entry does not resolve: ${resolved} (${error?.code ?? error?.message ?? "unknown"})`);
  }
  if (real === path.sep) throw new Error(`${label} entry resolves to the filesystem root: ${value}`);
  const stat = statSync(real);
  if (["/System", "/System/Volumes", "/System/Volumes/Data"].includes(real)) throw new Error(`${label} must not include the writable data-volume alias`);
  if (!stat.isDirectory() && !stat.isFile()) throw new Error(`${label} entry must be a file or directory: ${real}`);
  return real;
}

/** Canonical, existing protected target; directories and files are both allowed. */
function canonicalProtectedRoot(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} entry must be a non-empty string`);
  if (!path.isAbsolute(value)) throw new Error(`${label} entry must be absolute: ${value}`);
  const resolved = path.resolve(value);
  if (resolved === path.sep) throw new Error(`${label} entry must not be the filesystem root: ${value}`);
  let real;
  try {
    real = realpathSync(resolved);
  } catch (error) {
    throw new Error(`${label} entry does not resolve: ${resolved} (${error?.code ?? error?.message ?? "unknown"})`);
  }
  if (real === path.sep) throw new Error(`${label} entry resolves to the filesystem root: ${value}`);
  return real;
}

const readRootEntry = (value) => canonicalReadRoot(value, "readRoots");
const protectedRootEntry = (value) => canonicalProtectedRoot(value, "protectedReadRoots");

function uniqueRoots(values, canonicalize) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const canonical = canonicalize(value);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    out.push(canonical);
  }
  return out;
}

function assertLoopbackHost(host) {
  const match = typeof host === "string" ? LOOPBACK_HOST_RE.exec(host) : null;
  if (match === null) throw new Error(`allowNetworkHosts entry must be a loopback 127.0.0.1:port pair, got ${host}`);
  const port = Number.parseInt(match[1], 10);
  if (!(port >= 1 && port <= 65535)) throw new Error(`allowNetworkHosts port out of range, got ${host}`);
  return `127.0.0.1:${port}`;
}

function isSameOrInside(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
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
 * Bounded, owned loopback TCP listener for the offline deny-all network probe.
 *
 * A refused connection is not proof of enforcement, so the negative probe needs
 * a reachable positive control. The listener is a short-lived child process; its
 * port is published through a file and polled with a blocking sleep because this
 * probe API stays synchronous (the sandboxed children run through spawnSync).
 */
export function startLoopbackListener({ timeoutMs = 3_000 } = {}) {
  const home = mkdtempSync(path.join(tmpdir(), "harness2-listener-"));
  const portFile = path.join(home, "port");
  const script =
    'const net=require("node:net");const fs=require("node:fs");' +
    'const server=net.createServer((socket)=>socket.end());' +
    'server.listen(0,"127.0.0.1",()=>{fs.writeFileSync(process.argv[1],String(server.address().port))});';
  let child = null;
  const stop = () => {
    try {
      child?.kill();
    } catch {
      // the child may already be gone
    }
    rmSync(home, { recursive: true, force: true });
  };
  try {
    child = spawn(process.execPath, ["-e", script, portFile], { stdio: "ignore" });
    child.unref();
    const pause = new Int32Array(new SharedArrayBuffer(4));
    const deadline = Date.now() + timeoutMs;
    let port = null;
    while (Date.now() < deadline) {
      if (existsSync(portFile)) {
        port = Number.parseInt(readFileSync(portFile, "utf8").trim(), 10);
        break;
      }
      if (child.exitCode !== null) break;
      Atomics.wait(pause, 0, 0, 20);
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      stop();
      return null;
    }
    return { host: `127.0.0.1:${port}`, stop };
  } catch {
    stop();
    return null;
  }
}

function parseHostPort(value) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.exec(String(value ?? ""));
  if (match === null) return null;
  const port = Number.parseInt(match[2], 10);
  if (!(port >= 1 && port <= 65535)) return null;
  return { host: match[1], port };
}

/**
 * TCP connect (not an HTTP response) through node's net socket: the probe asks
 * whether the kernel let a socket reach this loopback port, nothing else.
 */
function tcpConnectScript(hostPort) {
  const parsed = parseHostPort(hostPort);
  if (parsed === null) throw new Error(`network probe target must be ip:port, got ${hostPort}`);
  return (
    'const net=require("node:net");const socket=net.connect(' +
    `${JSON.stringify(parsed.port)},${JSON.stringify(parsed.host)});` +
    "const done=(code)=>{try{socket.destroy()}catch{};process.exit(code)};" +
    'socket.on("connect",()=>done(0));socket.on("error",()=>done(3));' +
    "socket.setTimeout(1500,()=>done(4));" +
    // The target stays visible in the child script so a runner/receipt can bind it.
    ` // target ${parsed.host}:${parsed.port}`
  );
}

/** Read the target and discard it: only the exit status is observed, never content. */
function readScript(target) {
  return `dd if=${shellQuote(target)} of=/dev/null bs=1 count=1 2>/dev/null`;
}

/** Same, for a target that may be a directory (a store root): list entries, discard them. */
function probeReadScript(target) {
  let isDirectory = false;
  try {
    isDirectory = statSync(target).isDirectory();
  } catch {
    isDirectory = false;
  }
  return isDirectory ? `/bin/ls -A ${shellQuote(target)} >/dev/null 2>&1` : readScript(target);
}

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function unavailable(reason, runtime, detail) {
  const result = { status: "unavailable", reason, runtime: runtime ?? null, probes: [] };
  if (detail !== undefined) result.detail = detail;
  return result;
}

/** Bounded offline read roots: system/runtime libraries plus the trial mount only. */
export function runtimeReadRoots() {
  let runtimeDir = path.dirname(process.execPath);
  try {
    // A symlinked node (homebrew `bin/node`) executes from its Cellar path, so the
    // readable runtime root is the canonical one, not the symlink's directory.
    runtimeDir = path.dirname(realpathSync(process.execPath));
  } catch {
    runtimeDir = path.dirname(process.execPath);
  }
  const opensslMajor = process.versions.openssl.split(".")[0];
  const candidates = ["/bin", "/usr", "/System/Library", "/System/Cryptexes/OS/System/Library", "/dev", "/private/var/select", "/opt/homebrew/opt", "/opt/homebrew/Cellar", `/opt/homebrew/etc/openssl@${opensslMajor}/openssl.cnf`, runtimeDir];
  const out = [];
  for (const candidate of candidates) {
    try {
      out.push(canonicalReadRoot(candidate, "derived read roots"));
    } catch {
      // an absent system root simply contributes nothing to the bounded set
    }
  }
  return [...new Set(out)];
}

/**
 * Run the deny/allow probe set under one profile.
 *
 * `status` is `pass` only when every deny probe failed to act and every control
 * worked. Any supplied live-only property (`protectedFiles`, `inputPath`,
 * `runtimePath`, `blockedNetworkHost`) switches the probe to live mode, which
 * requires the complete live set and never falls back to derived roots. A probe
 * whose positive control could not be established is reported as
 * `control: "unavailable"` and can never turn into a pass.
 */
export function probeIsolation({
  mountDir,
  readRoots = null,
  protectedReadRoots = [],
  protectedFiles = null,
  inputPath = null,
  runtimePath = null,
  allowNetworkHosts = [],
  allowNetwork = false,
  blockedNetworkHost = null,
  runtime = process.platform === "darwin" && existsSync(SEATBELT_BIN) ? SEATBELT_RUNTIME : null,
  run = defaultRun,
  listener = startLoopbackListener,
  timeoutMs = PROBE_TIMEOUT_MS,
  env = process.env,
  outsideDir = null,
} = {}) {
  if (typeof mountDir !== "string" || mountDir.trim() === "") return unavailable("no_trial_mount", null);
  if (runtime !== SEATBELT_RUNTIME) return unavailable("no_enforceable_runtime", runtime);

  const live = protectedFiles !== null || inputPath !== null || runtimePath !== null || blockedNetworkHost !== null;
  const missing = [];
  if (live) {
    if (!Array.isArray(readRoots) || readRoots.length === 0) missing.push("readRoots");
    if (protectedFiles === null || typeof protectedFiles !== "object") missing.push("protectedFiles");
    else {
      for (const key of PROTECTED_KEYS) {
        if (typeof protectedFiles[key] !== "string" || protectedFiles[key].trim() === "") missing.push(`protectedFiles.${key}`);
      }
    }
    if (typeof inputPath !== "string" || inputPath.trim() === "") missing.push("inputPath");
    if (typeof runtimePath !== "string" || runtimePath.trim() === "") missing.push("runtimePath");
    if (typeof blockedNetworkHost !== "string" || blockedNetworkHost.trim() === "") missing.push("blockedNetworkHost");
    if (allowNetwork !== true || !Array.isArray(allowNetworkHosts) || allowNetworkHosts.length === 0) missing.push("allowNetworkHosts");
  }
  if (missing.length > 0) {
    const result = unavailable("live_probe_incomplete", runtime);
    result.missing = missing;
    return result;
  }

  // The trial mount must exist before any root can be canonicalized: the offline
  // derivation includes it, and an absent mount would silently drop the only
  // writable/readable directory the caller has.
  try {
    mkdirSync(mountDir, { recursive: true });
  } catch (error) {
    return unavailable("no_trial_mount", runtime, String(error?.message ?? error));
  }

  const readRootsSupplied = readRoots !== null && readRoots !== undefined;
  if (readRootsSupplied && (!Array.isArray(readRoots) || readRoots.length === 0)) {
    return unavailable("read_roots_invalid", runtime, "readRoots must be a non-empty array when supplied");
  }
  const readRootsSource = readRootsSupplied ? "explicit" : "derived";
  let roots;
  let protectedRoots;
  const protectedTargets = {};
  let resolvedRuntime;
  let resolvedInput = null;
  try {
    roots = readRootsSource === "explicit" ? uniqueRoots(readRoots, readRootEntry) : [...runtimeReadRoots(), realpathSync(mountDir)];
    if (roots.length === 0) return unavailable("no_read_roots", runtime);
    protectedRoots = Array.isArray(protectedReadRoots) ? uniqueRoots(protectedReadRoots, protectedRootEntry) : null;
    if (protectedRoots === null) return unavailable("profile_rejected", runtime, "protectedReadRoots must be an array");
    if (live) {
      for (const key of PROTECTED_KEYS) protectedTargets[key] = canonicalProtectedRoot(protectedFiles[key], `protectedFiles.${key}`);
      resolvedRuntime = canonicalProtectedRoot(runtimePath, "runtimePath");
      resolvedInput = canonicalProtectedRoot(inputPath, "inputPath");
    } else {
      resolvedRuntime = realpathSync(process.execPath);
    }
  } catch (error) {
    const reason = live ? "protected_target_missing" : "read_roots_invalid";
    return unavailable(reason, runtime, String(error?.message ?? error));
  }

  const home = outsideDir ?? mkdtempSync(path.join(tmpdir(), "harness2-outside-"));
  const ownsHome = outsideDir === null;
  const profilePath = path.join(home, "trial.sb");
  let resolvedMount;
  let profile;
  try {
    // SBPL matches resolved paths, so a /var -> /private/var mount would otherwise
    // deny the trial its own directory.
    resolvedMount = realpathSync(mountDir);
    profile = buildSeatbeltProfile({
      mountDir: resolvedMount,
      allowNetworkHosts: allowNetwork ? allowNetworkHosts : [],
      readRoots: roots,
      protectedReadRoots: protectedRoots,
    });
  } catch (error) {
    if (ownsHome) rmSync(home, { recursive: true, force: true });
    return unavailable("profile_rejected", runtime, String(error?.message ?? error));
  }
  writeFileSync(profilePath, profile, { mode: 0o600 });

  const childEnv = buildProbeEnvironment(env);
  const sandboxed = (argv) => run({ command: SEATBELT_BIN, args: ["-f", profilePath, ...argv], env: childEnv, timeoutMs });
  const plain = (argv) => run({ command: argv[0], args: argv.slice(1), env: childEnv, timeoutMs });

  const probes = [];
  const record = (id, passed, observed, control) => {
    const probe = { id, passed, observed };
    if (control !== undefined) probe.control = control;
    probes.push(probe);
  };

  const outsideTarget = path.join(home, "outside-probe.txt");
  rmSync(outsideTarget, { force: true });
  const outside = sandboxed(["/bin/sh", "-c", `printf probe > ${shellQuote(outsideTarget)}`]);
  record("write_outside_mount_denied", outside.status !== 0 && !existsSync(outsideTarget), outside.status);

  const insideTarget = path.join(resolvedMount, "inside-probe.txt");
  const inside = sandboxed(["/bin/sh", "-c", `printf probe > ${shellQuote(insideTarget)}`]);
  record("write_inside_mount_allowed", inside.status === 0 && existsSync(insideTarget), inside.status);

  const runtimeRead = sandboxed(["/bin/sh", "-c", readScript(resolvedRuntime)]);
  record("read_runtime_allowed", runtimeRead.status === 0, runtimeRead.status);

  let ownedInput = null;
  let inputTarget = resolvedInput;
  if (!live) {
    ownedInput = path.join(resolvedMount, "input-probe.txt");
    writeFileSync(ownedInput, "probe\n", { mode: 0o600 });
    inputTarget = ownedInput;
  }
  const inputRead = sandboxed(["/bin/sh", "-c", probeReadScript(inputTarget)]);
  record("read_input_allowed", inputRead.status === 0, inputRead.status);

  // A runtime child that cannot even start under the profile would make the
  // network denial vacuous, so start-up is its own positive control.
  const runtimeStart = sandboxed([resolvedRuntime, "-e", "process.exit(0)"]);
  record("runtime_child_start_allowed", runtimeStart.status === 0, runtimeStart.status);

  if (live) {
    for (const key of PROTECTED_KEYS) {
      const target = protectedTargets[key];
      const script = probeReadScript(target);
      const denied = sandboxed(["/bin/sh", "-c", script]);
      // A denial only counts when the same read is observably readable without
      // the sandbox; a missing or unreadable target proves nothing.
      const control = plain(["/bin/sh", "-c", script]);
      const controlState = control.status === 0 ? "pass" : "unavailable";
      record(`read_${key}_denied`, denied.status !== 0 && controlState === "pass", denied.status, controlState);
    }
  }

  let ownedListener = null;
  try {
    const recordNetworkDenial = (id, target) => {
      const script = parseHostPort(target) === null ? null : tcpConnectScript(target);
      if (script === null) {
        record(id, false, null, "unavailable");
        return;
      }
      const denied = sandboxed([resolvedRuntime, "-e", script]);
      const control = plain([resolvedRuntime, "-e", script]);
      const controlState = control.status === 0 ? "pass" : "unavailable";
      record(id, denied.status !== 0 && controlState === "pass", denied.status, controlState);
    };

    if (allowNetwork) {
      const proxyHost = Array.isArray(allowNetworkHosts) ? (allowNetworkHosts[0] ?? null) : null;
      if (typeof proxyHost === "string" && parseHostPort(proxyHost) !== null) {
        const proxy = sandboxed([resolvedRuntime, "-e", tcpConnectScript(proxyHost)]);
        record("network_proxy_connect_allowed", proxy.status === 0, proxy.status);
      } else {
        record("network_proxy_connect_allowed", false, null, "unavailable");
      }
      recordNetworkDenial("network_other_denied", blockedNetworkHost);
    } else {
      if (blockedNetworkHost === null) {
        try {
          ownedListener = listener();
        } catch {
          ownedListener = null;
        }
      }
      recordNetworkDenial("network_egress_denied", blockedNetworkHost ?? ownedListener?.host ?? null);
    }
  } finally {
    ownedListener?.stop?.();
  }

  const leaked = Object.keys(childEnv).filter((key) => SECRET_KEY_RE.test(key));
  record("credential_env_excluded", leaked.length === 0, leaked.length);

  rmSync(insideTarget, { force: true });
  if (ownedInput !== null) rmSync(ownedInput, { force: true });
  if (ownsHome) rmSync(home, { recursive: true, force: true });

  const status = summarize(probes);
  const envKeys = Object.keys(childEnv).sort();
  return {
    runtime,
    status,
    reason: status === "pass" ? null : (probes.find((probe) => probe.passed !== true)?.id ?? "probe_not_proven"),
    mode: live ? "live" : "offline",
    readRootsSource,
    readRoots: roots,
    protectedReadRoots: protectedRoots,
    allowlist: allowNetwork ? { mode: "ip-allowlist", hosts: [...allowNetworkHosts] } : { mode: "deny-all", hosts: [] },
    // The exact profile text the caller must write to its own scratch path and
    // pass unchanged to the live spawn, plus the digests that bind it.
    profile,
    profilePath: ownsHome ? null : profilePath,
    profileDigest: sha256(profile),
    profileDigestNormalized: sha256(normalizeProfile(profile, { mount: resolvedMount, roots, protectedRoots, home })),
    // Environment binding without values: the caller compares keys and digest,
    // and no secret value (dropped or kept) is copied into the receipt.
    envBinding: { keys: envKeys, digest: sha256(JSON.stringify(envKeys.map((key) => [key, childEnv[key]]))) },
    probes,
  };
}

function summarize(probes) {
  if (probes.some((probe) => probe.control !== "unavailable" && probe.passed !== true)) return "fail";
  if (probes.some((probe) => probe.control === "unavailable")) return "unavailable";
  return "pass";
}

/** Path-stable digest for reproducible preflight artifacts: absolute paths become tokens. */
function normalizeProfile(profile, { mount, roots, protectedRoots, home }) {
  let normalized = profile;
  let depth = 1;
  for (let parent = path.dirname(mount); parent !== path.sep; parent = path.dirname(parent)) {
    normalized = normalized.replaceAll(`(literal ${quote(parent)})`, `(literal "<mount-ancestor:${depth}>")`);
    depth += 1;
  }
  const replacements = [[mount, "<mount>"], [home, "<outside>"]];
  for (const [index, root] of roots.entries()) replacements.push([root, `<readRoot:${index}>`]);
  for (const [index, root] of protectedRoots.entries()) replacements.push([root, `<protectedRoot:${index}>`]);
  replacements.sort((left, right) => right[0].length - left[0].length);
  for (const [needle, token] of replacements) {
    if (needle === "") continue;
    normalized = normalized.replaceAll(needle, token);
  }
  return normalized;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
