#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { startRecordingProxy } from "./recording-proxy.mjs";
import { prepareCell, proveCellIsolation, runNativeAttempt, taskPrompt } from "./native-pilot.mjs";
import { startLoopbackListener } from "../lib/isolation-runtime.mjs";
import { historicalBoundaryControls } from "./pilot-oracle.mjs";
import { sourceDigest } from "./pilot-protocol.mjs";
import { computeHarnessDigest } from "../lib/isolate.mjs";

export async function probeNative({ gjcBin = path.join(os.homedir(), ".local/bin/gjc") } = {}) {
  const source = sourceDigest();
  const here = path.dirname(fileURLToPath(import.meta.url));
  const task = JSON.parse(readFileSync(path.join(here, "pilot-task.json"), "utf8"));
  const ruleText = readFileSync(path.join(here, "pilot-rule.txt"), "utf8");
  const results = [];
  for (const arm of ["B0", "B1", "B2"]) {
    const root = mkdtempSync(path.join(os.tmpdir(), "harness2-native-probe-"));
    const proxy = await startRecordingProxy({ ruleText });
    const other = startLoopbackListener();
    try {
      if (!other) throw new Error("network_control_unavailable");
      const cell = prepareCell({ root, arm, task, ruleText, proxy, gjcBin, userHome: os.homedir() });
      const proof = proveCellIsolation(cell, { proxy, blockedNetworkHost: other.host });
      const bundle = computeHarnessDigest({ agentDir: cell.agent, targets: ["models.yml", ...(arm === "B2" ? ["RULES.md"] : [])] });
      const result = { arm, bundleDigest: bundle.rootHash, isolation: proof.receipt, native: null, requests: proxy.rows };
      results.push(result);
      if (!proof.ok) break;
      const token = proxy.armSlot(`probe-${arm}`, arm);
      result.native = await runNativeAttempt({ cell, isolation: proof, token, prompt: taskPrompt(task, arm === "B2" ? { output: '{"accept":true,"tier":"fast"}', errors: [] } : null) });
      if (result.native.code !== 0 || proxy.rows.length !== 1 || proxy.rows[0].status !== "ok") break;
    } finally {
      other?.stop();
      await proxy.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
  const historical = historicalBoundaryControls();
  return { schema: "harness2.native_probe.v1", sourceDigest: source, mode: "cost-zero scripted provider; not a live-model result", historical, passed: sourceDigest() === source && historical.passed && results.length === 3 && results.every((r) => r.isolation.status === "pass" && r.native?.code === 0 && r.requests.length === 1 && r.requests[0].status === "ok" && r.requests[0].rulePresent === (r.arm === "B2")), results };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--out")) throw new Error("usage: probe-native.mjs [--out file.json]");
  const result = await probeNative();
  const text = JSON.stringify(result, null, 2) + "\n";
  if (args.length) writeFileSync(args[1], text, { flag: "wx", mode: 0o600 });
  console.log(JSON.stringify({ passed: result.passed, historical: result.historical.passed, results: result.results.map((r) => ({ arm: r.arm, isolation: r.isolation.status, probes: r.isolation.probes, native: r.native, requests: r.requests })) }, null, 2));
  process.exitCode = result.passed ? 0 : 1;
}
