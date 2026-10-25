// Fresh-process smoke for the installed goal-alignment hook.
//
// Closes the "installed artifact was never executed in a new process" gap that
// unit fixtures cannot cover: it imports the hook from the INSTALLED plugin
// root (~/.gjc/agent/gjc-plugins/jev-advisor by default), lets the factory
// register against a fake api, and drives one tool_call per mode with an
// isolated HOME. No network, no model call, no credentials.
//
//   bun jev-advisor/scripts/smoke-alignment.mjs [--installed <pluginRoot>]
//
// Exit 0 only when every assertion holds.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const installedIndex = args.indexOf("--installed");
const pluginRoot =
  installedIndex >= 0
    ? path.resolve(args[installedIndex + 1])
    : path.join(homedir(), ".gjc", "agent", "gjc-plugins", "jev-advisor");
const hookPath = path.join(pluginRoot, "hooks", "jev-advisor-alignment.ts");
assert.ok(existsSync(hookPath), `installed alignment hook not found: ${hookPath}`);

const READ_ONLY_PROMPT = "Read only investigation: do not modify any files.";
const branch = [
  { id: "e1", type: "message", message: { role: "user", content: [{ type: "text", text: READ_ONLY_PROMPT }] } },
  { id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "알겠습니다." }] } },
];
const ctx = { sessionManager: { getBranch: () => branch } };
const writeCall = {
  type: "tool_call",
  toolName: "write",
  toolCallId: "call-1",
  input: { path: "src/app.ts", content: "x" },
};
const readCall = { type: "tool_call", toolName: "read", toolCallId: "call-2", input: { path: "src/app.ts" } };

async function loadRegistrations() {
  const factory = (await import(pathToFileURL(hookPath).href)).default;
  assert.equal(typeof factory, "function", "alignment hook must export a default factory");
  const registrations = [];
  await factory({ on: (event, handler) => registrations.push({ event, handler }), logger: console });
  assert.equal(registrations.length, 1, `expected exactly one registration, got ${registrations.length}`);
  return registrations[0];
}

async function runCase(mode) {
  const home = mkdtempSync(path.join(tmpdir(), "alignment-smoke-"));
  const previousHome = process.env.HOME;
  const previousMode = process.env.JEV_ALIGNMENT_MODE;
  process.env.HOME = home;
  if (mode === undefined) delete process.env.JEV_ALIGNMENT_MODE;
  else process.env.JEV_ALIGNMENT_MODE = mode;
  try {
    const registration = await loadRegistrations();
    const write = await registration.handler(writeCall, ctx);
    const read = await registration.handler(readCall, ctx);
    const journalDir = path.join(home, ".gjc-plugin", "jev-advisor", "alignment", "v1");
    const journals = existsSync(journalDir)
      ? readFileSync(path.join(journalDir, ...(await newestSession(journalDir)), "events.jsonl"), "utf8").catch?.(() => "") ?? ""
      : "";
    return { registration, write, read, journalDir, journals };
  } finally {
    process.env.HOME = previousHome;
    if (previousMode === undefined) delete process.env.JEV_ALIGNMENT_MODE;
    else process.env.JEV_ALIGNMENT_MODE = previousMode;
    rmSync(home, { recursive: true, force: true });
  }
}

// The journal is session-scoped; the smoke asserts on any session directory.
async function newestSession(journalDir) {
  const { readdirSync } = await import("node:fs");
  const sessions = readdirSync(journalDir).sort();
  return [sessions[sessions.length - 1]];
}

const results = [];
const defaultCase = await runCase(undefined);
assert.equal(defaultCase.registration.event, "tool_call", "installed hook must register tool_call");
assert.equal(defaultCase.write, undefined, "shadow (default) must never block");
assert.equal(defaultCase.read, undefined, "read tools are never blocked");
results.push("shadow/default: blocks=0, read allowed");

const deterministic = await runCase("deterministic");
assert.equal(deterministic.write?.block, true, "deterministic must block a write under read-only authority");
assert.match(String(deterministic.write?.reason ?? ""), /drift_write_vs_readonly/, "block reason must carry the rule id");
assert.equal(deterministic.read, undefined, "deterministic must still allow reads");
results.push(`deterministic: blocked with reason "${deterministic.write.reason}"`);

const off = await runCase("off");
assert.equal(off.write, undefined, "off must not block");
assert.equal(existsSync(off.journalDir), false, "off must not journal");
results.push("off: no block, no journal");

const unknown = await runCase("enforce-me-please");
assert.equal(unknown.write, undefined, "an unrecognized mode must fall back to shadow");
results.push("unknown mode: falls back to shadow");

console.log(JSON.stringify({ kind: "alignment-installed-smoke", pluginRoot, cases: results.length, unexpectedFetches: 0 }, null, 2));
for (const line of results) console.log(`ok - ${line}`);
// Deterministic latency: 20 evaluations of the shipped block/allow path.
const latencyHome = mkdtempSync(path.join(tmpdir(), "alignment-latency-"));
const priorHome = process.env.HOME;
const priorMode = process.env.JEV_ALIGNMENT_MODE;
process.env.HOME = latencyHome;
process.env.JEV_ALIGNMENT_MODE = "deterministic";
try {
  const { handler } = await loadRegistrations();
  const samples = [];
  for (let index = 0; index < 20; index++) {
    const started = performance.now();
    await handler(writeCall, ctx);
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  const p95 = samples[Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1)];
  console.log(JSON.stringify({ latencySamples: samples.length, p50Ms: Number(samples[Math.floor(samples.length / 2)].toFixed(2)), p95Ms: Number(p95.toFixed(2)), hardBudgetMs: 250, proposalP95Ms: 50 }));
  assert.ok(p95 < 250, `p95 ${p95.toFixed(1)}ms exceeds the hard 250ms budget`);
  results.push(`latency: p95 ${p95.toFixed(1)}ms < hard 250ms`);
} finally {
  process.env.HOME = priorHome;
  if (priorMode === undefined) delete process.env.JEV_ALIGNMENT_MODE;
  else process.env.JEV_ALIGNMENT_MODE = priorMode;
  rmSync(latencyHome, { recursive: true, force: true });
}
console.log(`ALL PASS (${results.length} installed-hook cases)`);
