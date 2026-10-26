import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSessions, parseMiniRecords, parseTmuxRow } from "../lib/collect.mjs";
import { epochOf, fail, fakeRunner, iso, NOW, ok, tempWorktree } from "./helpers.mjs";

function laneRunner({ listing, worktree, status = " M notes.md\0" }) {
  return fakeRunner([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok(listing) : null),
    (command, args) => (command === "tmux" && args[0] === "capture-pane" ? ok("agent pane output") : null),
    (command, args) => {
      if (command !== "git") return null;
      const sub = args[2];
      if (sub === "rev-parse" && args[3] === "--abbrev-ref") return ok("feat/alpha\n");
      if (sub === "rev-parse") return ok("abc1234\n");
      if (sub === "config") return ok("https://github.com/jjongguet/gjc-plugin.git\n");
      if (sub === "status") return ok(status);
      if (sub === "log") {
        const format = args.find(arg => arg.startsWith("--format=")) ?? "";
        if (format === "--format=%cI%n%s") return ok(`${iso(40)}\nfeat: land the thing\n`);
        const since = Number((args[args.indexOf("--since") + 1] ?? "").replace("@", ""));
        if (since === epochOf(45)) return ok("a\nb\nc\n");
        if (since === epochOf(10)) return ok("a\n");
      }
      return ok("");
    },
  ]);
}

test("lane facts come from the pane working directory, not the session name", async () => {
  const worktree = tempWorktree({ dirty: ["notes.md"] });
  const listing = [`lane-alpha\t${epochOf(45)}\t${worktree}\tgjc`, `gjc-unrelated\t${epochOf(45)}\t/tmp\tbash`].join("\n");
  const runner = laneRunner({ listing, worktree });
  const { sessions, errors } = await collectSessions({ runner, now: NOW, includeMini: false });

  assert.equal(errors.length, 0);
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.id, "lane:alpha");
  assert.equal(session.tmuxSession, "lane-alpha");
  assert.equal(session.worktree, worktree);
  assert.equal(session.worktreePresent, true);
  assert.equal(session.branch, "feat/alpha");
  assert.equal(session.sha, "abc1234");
  assert.equal(session.remote, "https://github.com/jjongguet/gjc-plugin.git");
  assert.equal(session.ageMinutes, 45);
  assert.equal(session.commitsSinceStart, 3);
  assert.equal(session.commitsLastWindow, 1);
  assert.equal(session.dirty, 1);
  assert.equal(session.lastCommit.at, iso(40));
  assert.equal(session.lastCommit.subject, "feat: land the thing");
  assert.equal(session.lastActivityAt !== null, true);
  assert.equal(session.paneDigest.length, 16);
  assert.deepEqual(session.errors, []);
});

test("a lane whose worktree vanished is reported, not dropped", async () => {
  const listing = `lane-gone\t${epochOf(50)}\t/definitely/not/a/worktree\tgjc`;
  const runner = laneRunner({ listing, worktree: "/definitely/not/a/worktree" });
  const { sessions } = await collectSessions({ runner, now: NOW, includeMini: false });
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].worktreePresent, false);
  assert.equal(sessions[0].ageMinutes, 50);
  assert.deepEqual(sessions[0].errors, ["worktree_missing"]);
});

test("a failing tmux listing is a recorded error, not a crash", async () => {
  const runner = fakeRunner([(command) => (command === "tmux" ? fail("command_not_found") : null)]);
  const { sessions, errors } = await collectSessions({ runner, now: NOW, includeMini: false });
  assert.deepEqual(sessions, []);
  assert.deepEqual(errors, [{ target: "lane", error: "command_not_found" }]);
});

test("an unreachable mini host is a recorded error and the run continues", async () => {
  const runner = fakeRunner([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok("") : null),
    (command) => (command === "ssh" ? fail("timeout") : null),
  ]);
  const { sessions, errors } = await collectSessions({ runner, now: NOW, miniHost: "macmini" });
  assert.deepEqual(sessions, []);
  assert.deepEqual(errors, [{ target: "mini", error: "timeout" }]);
});

test("mini records parse into sessions with the tmux age when a session matches the checkout", async () => {
  const origin = "/home/gjc/jjongguet";
  const remoteOutput = [
    `origin\t${origin}`,
    `repo\twhoos\tfeat/whoos-contract\t2\t4\t2026-10-27T00:00:00+09:00\tfeat: contract\tabc123\thttps://github.com/jjongguet/whoos.git`,
    `tmux\tgjc-whoos\t${epochOf(30)}\t${origin}/whoos`,
  ].join("\n");
  const runner = fakeRunner([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok("") : null),
    (command) => (command === "ssh" ? ok(remoteOutput) : null),
  ]);
  const { sessions, errors } = await collectSessions({ runner, now: NOW, miniHost: "macmini" });
  assert.deepEqual(errors, []);
  assert.equal(sessions.length, 1);
  const [session] = sessions;
  assert.equal(session.id, "mini:whoos");
  assert.equal(session.worktree, `${origin}/whoos`);
  assert.equal(session.branch, "feat/whoos-contract");
  assert.equal(session.commitsLastWindow, 2);
  assert.equal(session.dirty, 4);
  assert.equal(session.ageMinutes, 30);
  assert.equal(session.sha, "abc123");
  assert.equal(session.remote, "https://github.com/jjongguet/whoos.git");
});

test("parseMiniRecords keeps usable rows and ignores noise", () => {
  const parsed = parseMiniRecords(["", "noise", "repo\tonly-three\tfields", `origin\t${"/home/gjc/jjongguet"}`].join("\n"));
  assert.equal(parsed.origin, "/home/gjc/jjongguet");
  assert.deepEqual(parsed.repos, []);
  assert.deepEqual(parsed.tmux, []);
});

test("parseTmuxRow rejects rows without a name", () => {
  assert.equal(parseTmuxRow(""), null);
  assert.deepEqual(parseTmuxRow("lane-x\t100\t/tmp\tzsh"), {
    name: "lane-x",
    createdMs: 100_000,
    panePath: "/tmp",
    paneCommand: "zsh",
  });
});
