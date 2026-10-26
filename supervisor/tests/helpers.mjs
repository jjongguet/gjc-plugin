import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const NOW = Date.parse("2026-10-27T02:00:00Z");
export const iso = minutesAgo => new Date(NOW - minutesAgo * 60_000).toISOString();
export const epochOf = minutesAgo => Math.floor((NOW - minutesAgo * 60_000) / 1000);

export function ok(stdout = "") {
  return { ok: true, code: 0, signal: null, stdout, stderr: "", error: null };
}

export function fail(error = "command_not_found", code = null) {
  return { ok: false, code, signal: null, stdout: "", stderr: "", error };
}

/** Route table runner: first route returning a result wins. */
export function fakeRunner(routes) {
  const calls = [];
  const runner = async (command, args = []) => {
    calls.push([command, ...args].join(" "));
    for (const route of routes) {
      const result = route(command, args);
      if (result) return result;
    }
    return ok("");
  };
  runner.calls = calls;
  return runner;
}

export function tempWorktree({ dirty = [] } = {}) {
  const root = path.join(os.tmpdir(), `supervisor-test-${Math.random().toString(16).slice(2)}`);
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, ".git"), "gitdir: /tmp/fake\n");
  for (const file of dirty) writeFileSync(path.join(root, file), "x\n");
  return root;
}

export function judgeFixture(overrides = {}) {
  return {
    id: "lane:alpha",
    target: "lane",
    name: "alpha",
    tmuxSession: "lane-alpha",
    tmuxAlive: true,
    worktreePresent: true,
    ageMinutes: 45,
    commitsSinceStart: 0,
    commitsLastWindow: 0,
    dirty: 0,
    dirtyDelta: 0,
    lastCommit: null,
    ...overrides,
  };
}
