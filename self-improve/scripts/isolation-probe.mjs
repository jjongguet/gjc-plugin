#!/usr/bin/env node
/**
 * Prints the isolation-runtime probe result for one trial mount.
 *
 * This is prerequisite evidence for a live Harness² trial, not an admission:
 * a passing probe shows the host can enforce containment without assuming a
 * shared UID. A live run still needs a resolved provider allowlist and an
 * approved budget window (see self-improve/HARNESS2.md).
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { probeIsolation } from "../lib/isolation-runtime.mjs";

const args = process.argv.slice(2);
const allowIndex = args.indexOf("--allow-network");
const allowNetworkHosts = allowIndex === -1 ? [] : args.slice(allowIndex + 1).filter((value) => !value.startsWith("--"));
const mountArg = args.find((value) => value.startsWith("--mount="));
const ownsMount = mountArg === undefined;
const mountDir = mountArg ? path.resolve(mountArg.slice("--mount=".length)) : mkdtempSync(path.join(tmpdir(), "harness2-trial-"));

const result = probeIsolation({
  mountDir,
  allowNetwork: allowIndex !== -1,
  allowNetworkHosts,
});

if (ownsMount) rmSync(mountDir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
if (result.status !== "pass") process.exitCode = 1;
