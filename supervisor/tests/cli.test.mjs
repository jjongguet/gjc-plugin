import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { main, parseArgs, runLoop, runOnce, UsageError } from "../lib/cli.mjs";
import { fail, fakeRunner, judgeFixture, NOW, ok } from "./helpers.mjs";

const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "supervisor-cli-"));

function stubCi() {
  return { resolve: async () => ({ state: "success", detail: "1/1", total: 1 }), flush: async () => {} };
}

/** collectSessions stand-in: returns the fixture sessions, records the call. */
function stubCollect(sessions) {
  const calls = [];
  const collect = async () => {
    calls.push(Date.now());
    return { sessions: sessions.map(session => ({ ...session })), errors: [] };
  };
  collect.calls = calls;
  return collect;
}

const options = out => ({ command: "once", out, discord: false, includeMini: false, steer: null, dryRun: true, json: false, intervalSeconds: 600, count: null });

test("the loop interval defaults to ten minutes and rejects unsafe values", () => {
  assert.equal(parseArgs(["loop"]).intervalSeconds, 600);
  assert.equal(parseArgs(["loop", "--interval", "600"]).intervalSeconds, 600);
  assert.throws(() => parseArgs(["loop", "--interval", "5"]), /--interval/);
  assert.throws(() => parseArgs(["once", "--steer", "lane-a", "--steer", "lane-b"]), /exactly one session/);
  assert.throws(() => parseArgs(["once", "--bogus"]), /unknown flag/);
  assert.throws(() => parseArgs(["kill", "lane-a"]), /unknown command/);
});

test("once writes a snapshot and never applies an intervention in dry-run", async () => {
  const out = tempDir();
  try {
    const collect = stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha", tmuxSession: "lane-alpha" })]);
    const result = await runOnce(options(out), { now: () => NOW, collectSessions: collect, ciResolver: stubCi(), stdout: () => {} });
    const files = readdirSync(out);
    assert.equal(files.filter(name => name.startsWith("snapshot-")).length, 1);
    assert.ok(files.includes("latest.json"));
    assert.equal(result.snapshot.interventions.length, 0);
    assert.equal(result.snapshot.judgments[0].state, "stalled");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a second run against the same state dir detects a growing dirty tree as thrashing", async () => {
  const out = tempDir();
  try {
    const first = judgeFixture({ id: "lane:alpha", name: "alpha", dirty: 1, commitsSinceStart: 1, lastCommit: { at: new Date(NOW - 20 * 60000).toISOString(), subject: "x" } });
    await runOnce(options(out), { now: () => NOW, collectSessions: stubCollect([first]), ciResolver: stubCi(), stdout: () => {} });
    const second = { ...first, dirty: 4 };
    const result = await runOnce(options(out), { now: () => NOW + 60_000, collectSessions: stubCollect([second]), ciResolver: stubCi(), stdout: () => {} });
    assert.equal(result.snapshot.sessions[0].dirtyDelta, 3);
    assert.equal(result.snapshot.judgments[0].state, "thrashing");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a real steer targets one stalled session and records the verified marker", async () => {
  const out = tempDir();
  try {
    const sent = [];
    const runner = fakeRunner([
      (command, args) => {
        if (command !== "tmux") return null;
        if (args[0] === "send-keys" && args[3] === "-l") {
          sent.push(args[4]);
          return ok();
        }
        if (args[0] === "send-keys") return ok();
        if (args[0] === "capture-pane") return ok(sent.join(" "));
        return null;
      },
    ]);
    const collect = stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha", tmuxSession: "lane-alpha", ageMinutes: 45, commitsSinceStart: 0 })]);
    const result = await runOnce(
      { ...options(out), dryRun: false, steer: "lane-alpha" },
      { now: () => NOW, collectSessions: collect, ciResolver: stubCi(), runner, stdout: () => {}, settleMs: 1 },
    );
    assert.equal(result.snapshot.interventions.length, 1);
    assert.equal(result.snapshot.interventions[0].target, "lane-alpha");
    assert.equal(result.snapshot.interventions[0].verified, true);
    assert.equal(sent.length, 1);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a progressing session is not steered", async () => {
  const out = tempDir();
  try {
    const runner = fakeRunner([]);
    const collect = stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha", tmuxSession: "lane-alpha", commitsLastWindow: 2 })]);
    const result = await runOnce(
      { ...options(out), dryRun: false, steer: "alpha" },
      { now: () => NOW, collectSessions: collect, ciResolver: stubCi(), runner, stdout: () => {}, settleMs: 1 },
    );
    assert.match(result.snapshot.interventions[0].error, /^skipped_not_stalled:progressing$/);
    assert.deepEqual(runner.calls, []);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("an unknown or non-lane steer target is a usage error", async () => {
  const out = tempDir();
  try {
    const collect = stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha", tmuxSession: "lane-alpha" })]);
    await assert.rejects(
      runOnce({ ...options(out), steer: "lane-nope" }, { now: () => NOW, collectSessions: collect, ciResolver: stubCi(), stdout: () => {} }),
      UsageError,
    );
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the Discord summary is sent once per run and its outcome is persisted", async () => {
  const out = tempDir();
  try {
    let posts = 0;
    const fetchImpl = async () => {
      posts += 1;
      return { ok: true, status: 204 };
    };
    const collect = stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha" })]);
    const result = await runOnce(
      { ...options(out), dryRun: false, discord: true },
      { now: () => NOW, collectSessions: collect, ciResolver: stubCi(), stdout: () => {}, fetchImpl, webhookUrl: "https://discord.com/api/webhooks/1/token" },
    );
    assert.equal(posts, 1);
    assert.equal(result.snapshot.discord.ok, true);
    const saved = JSON.parse(readFileSync(path.join(out, "latest.json"), "utf8"));
    assert.equal(saved.discord.ok, true);
    assert.equal(saved.discord.status, 204);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a dead decision provider still produces a report with the deterministic verdict", async () => {
  const out = tempDir();
  try {
    const ambiguous = judgeFixture({ id: "lane:alpha", name: "alpha", ageMinutes: 45, commitsSinceStart: 3, dirty: 2, lastCommit: { at: new Date(NOW - 40 * 60000).toISOString(), subject: "x" } });
    const runner = fakeRunner([(command) => (command === "/missing/decision-ask" ? fail("command_not_found") : null)]);
    const result = await runOnce(options(out), {
      now: () => NOW,
      collectSessions: stubCollect([ambiguous]),
      ciResolver: stubCi(),
      runner,
      decisionAsk: "/missing/decision-ask",
      stdout: () => {},
    });
    assert.equal(result.snapshot.judgments[0].state, "stalled");
    assert.equal(result.snapshot.judgments[0].source, "deterministic_fallback");
    assert.match(result.snapshot.judgments[0].error, /^decision_exit_error/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("loop runs the requested number of iterations and leaves one snapshot per run", async () => {
  const out = tempDir();
  try {
    const collect = stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha" })]);
    const lines = [];
    let clock = NOW;
    const iterations = await runLoop(
      { ...options(out), command: "loop", intervalSeconds: 600, count: 2, dryRun: true },
      {
        now: () => {
          clock += 60_000;
          return clock;
        },
        collectSessions: collect,
        ciResolver: stubCi(),
        stdout: line => lines.push(line),
        sleep: async () => {},
      },
    );
    assert.equal(iterations, 2);
    assert.equal(collect.calls.length, 2);
    assert.equal(readdirSync(out).filter(name => name.startsWith("snapshot-")).length, 2);
    assert.equal(lines.filter(line => line.startsWith("[loop ")).length, 2);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("main returns usage codes without starting work", async () => {
  const errors = [];
  assert.equal(await main(["--bogus"], { stderr: line => errors.push(line), stdout: () => {} }), 2);
  assert.match(errors.join("\n"), /unknown command/);
  const help = [];
  assert.equal(await main(["--help"], { stdout: line => help.push(line), stderr: () => {} }), 0);
  assert.match(help.join("\n"), /supervisor loop/);
});
