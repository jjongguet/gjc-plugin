/**
 * Scratch-copy creation, isolated GJC-root construction, environment
 * sanitization and live-harness digest for the self-improve loop.
 *
 * Environment isolation is delegated to the single canonical implementation in
 * verification-receipts/scripts/smoke-environment.mjs (re-exported below).
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSmokeEnvironment, assertSmokeIsolation } from "../../verification-receipts/scripts/smoke-environment.mjs";

export { createSmokeEnvironment, assertSmokeIsolation };

export const DEFAULT_DIGEST_TARGETS = Object.freeze([
  "gjc-plugins/registry.json",
  "gjc-plugins/jev-advisor",
  "gjc-plugins/verification-receipts",
  "gjc-plugins/ui-regression",
  "jev-advisor/.env",
]);

export function defaultAgentDir(env = process.env) {
  return path.resolve(
    env.GJC_CODING_AGENT_DIR || env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".gjc", "agent"),
  );
}

const SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i;
const TEST_RUNNER_ENV_RE = /^NODE_TEST_/;
const TEST_RUNNER_ENV_EXACT = new Set(["NODE_V8_COVERAGE"]);

/** Local (gitignored) workspace files the toolchain expects at the root. */
export const LOCAL_CONFIG_FILES = Object.freeze(["AGENTS.md"]);

/** Copy of the environment with secret-like and test-runner variables removed. */
export function sanitizeGuardEnv(env = process.env) {
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (SECRET_KEY_RE.test(key)) continue;
    if (TEST_RUNNER_ENV_RE.test(key) || TEST_RUNNER_ENV_EXACT.has(key)) continue;
    out[key] = value;
  }
  return out;
}

/** Refuse scratch destinations inside the live agent root or behind a symlink. */
export function assertIsolatedDestination({ destDir, liveAgentDir = defaultAgentDir() }) {
  const resolved = path.resolve(destDir);
  const live = path.resolve(liveAgentDir);
  if (resolved === live || resolved.startsWith(live + path.sep)) {
    throw new Error(`isolated_destination_inside_live_agent: ${resolved}`);
  }
  let stat;
  try {
    stat = fs.lstatSync(resolved);
  } catch (error) {
    if (error.code === "ENOENT") return resolved;
    throw error;
  }
  if (stat.isSymbolicLink()) throw new Error(`isolated_destination_is_symlink: ${resolved}`);
  if (!stat.isDirectory()) throw new Error(`isolated_destination_not_directory: ${resolved}`);
  return resolved;
}

/**
 * Extract an exact-HEAD scratch copy (user dirty state is deliberately ignored).
 * Returns {scratchDir, baseRef, baseCommit}.
 */
export function createScratchCopy({ repoRoot, destDir, baseRef = "HEAD" }) {
  const resolvedDest = assertIsolatedDestination({ destDir });
  if (fs.existsSync(resolvedDest)) throw new Error(`scratch_destination_exists: ${resolvedDest}`);
  fs.mkdirSync(resolvedDest, { recursive: true, mode: 0o700 });
  const tarPath = path.join(resolvedDest, ".self-improve-scratch.tar");
  const archive = spawnSync("git", ["-C", repoRoot, "archive", "--format=tar", `--output=${tarPath}`, baseRef], {
    encoding: "utf8",
  });
  if (archive.status !== 0) {
    throw new Error(`git_archive_failed: ${archive.stderr || archive.status}`);
  }
  const extract = spawnSync("tar", ["-xf", tarPath, "-C", resolvedDest], { encoding: "utf8" });
  fs.rmSync(tarPath, { force: true });
  if (extract.status !== 0) {
    throw new Error(`tar_extract_failed: ${extract.stderr || extract.status}`);
  }
  // Carry over local (gitignored) workspace files the toolchain expects at the
  // root, so the scratch reproduces the local environment, not just the commit.
  // Credential files (.env*) are never carried over.
  for (const name of LOCAL_CONFIG_FILES) {
    const source = path.join(path.resolve(repoRoot), name);
    const target = path.join(resolvedDest, name);
    if (fs.existsSync(source) && !fs.existsSync(target)) {
      fs.copyFileSync(source, target);
    }
  }
  const rev = spawnSync("git", ["-C", repoRoot, "rev-parse", "--short=7", baseRef], { encoding: "utf8" });
  if (rev.status !== 0) {
    throw new Error(`git_rev_parse_failed: ${rev.stderr || rev.status}`);
  }
  return { scratchDir: resolvedDest, baseRef, baseCommit: rev.stdout.trim() };
}

function digestRowFor(root, rel) {
  const abs = path.join(root, rel);
  let stat;
  try {
    stat = fs.lstatSync(abs);
  } catch (error) {
    if (error.code === "ENOENT") return { path: rel, missing: true };
    throw error;
  }
  if (stat.isSymbolicLink()) return { path: rel, symlink: fs.readlinkSync(abs) };
  if (!stat.isDirectory()) {
    if (!stat.isFile()) return { path: rel, unknownType: true };
    return {
      path: rel,
      sha256: createHash("sha256").update(fs.readFileSync(abs)).digest("hex"),
      size: stat.size,
    };
  }
  const rows = [];
  for (const name of fs.readdirSync(abs).sort()) {
    rows.push(...[digestRowFor(root, path.posix.join(rel, name))].flat());
  }
  return rows;
}

/**
 * Deterministic digest manifest over the live harness (installed plugin trees,
 * registry and the credential file presence), sorted by path. Missing entries
 * stay visible as `missing: true`; symlinks are recorded, never followed.
 */
export function computeHarnessDigest({ agentDir = defaultAgentDir(), targets = DEFAULT_DIGEST_TARGETS } = {}) {
  const root = path.resolve(agentDir);
  const rows = [];
  for (const target of targets) {
    rows.push(...[digestRowFor(root, target)].flat());
  }
  rows.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const rootHash = createHash("sha256").update(JSON.stringify(rows)).digest("hex");
  return { agentDir: root, rows, rootHash };
}

export function digestEqual(left, right) {
  return left.rootHash === right.rootHash;
}
