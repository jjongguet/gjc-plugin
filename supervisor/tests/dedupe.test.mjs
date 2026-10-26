import { test } from "node:test";
import assert from "node:assert/strict";
import { collectSessions } from "../lib/collect.mjs";
import {
  canonicalTicket,
  findDuplicateSessions,
  mentionsTicket,
  normalizeRemote,
  repoMatches,
  resolveRepoIdentity,
} from "../lib/dedupe.mjs";
import { epochOf, fail, fakeRunner, iso, NOW, ok, tempWorktree } from "./helpers.mjs";

const REMOTE = "https://github.com/jjongguet/gjc-plugin.git";

function laneRunner({ listing, remote = REMOTE, branch = "feat/jjo895-session-dedupe" }) {
  return fakeRunner([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok(listing) : null),
    (command, args) => (command === "tmux" && args[0] === "capture-pane" ? ok("agent pane") : null),
    (command, args) => {
      if (command !== "git") return null;
      const sub = args[2];
      if (sub === "rev-parse" && args[3] === "--abbrev-ref") return ok(`${branch}\n`);
      if (sub === "rev-parse") return ok("abc1234\n");
      if (sub === "config") return ok(`${remote}\n`);
      if (sub === "status") return ok("");
      if (sub === "log") {
        const format = args.find(arg => arg.startsWith("--format=")) ?? "";
        if (format === "--format=%cI%n%s") return ok(`${iso(40)}\nfeat: land the thing\n`);
        return ok("");
      }
      return ok("");
    },
  ]);
}

async function laneSessions(runner) {
  const { sessions, errors } = await collectSessions({ runner, now: NOW, includeMini: false });
  assert.deepEqual(errors, []);
  return sessions;
}

test("ticket input normalizes to LETTERS-DIGITS and rejects non-tickets", () => {
  assert.equal(canonicalTicket("JJO-895"), "JJO-895");
  assert.equal(canonicalTicket(" jjo895 "), "JJO-895");
  assert.equal(canonicalTicket("JJO_870b"), "JJO-870B");
  assert.equal(canonicalTicket("session-dedupe"), null);
  assert.equal(canonicalTicket("20261027"), null);
  assert.equal(canonicalTicket("feat/jjo895"), null);
});

test("a ticket matches its dashed, bare and branch spellings but not longer numbers", () => {
  assert.equal(mentionsTicket("lane-JJO-895-dedupe", "JJO-895"), true);
  assert.equal(mentionsTicket("feat/jjo895-session-dedupe", "JJO-895"), true);
  assert.equal(mentionsTicket("S42-JJO-895.md", "JJO-895"), true);
  assert.equal(mentionsTicket("lane-JJO-8950-other", "JJO-895"), false);
  assert.equal(mentionsTicket("lane-JJO-89", "JJO-895"), false);
  assert.equal(mentionsTicket(null, "JJO-895"), false);
});

test("origin remotes normalize to owner/name across https, ssh and scp forms", () => {
  assert.equal(normalizeRemote("https://github.com/jjongguet/gjc-plugin.git"), "jjongguet/gjc-plugin");
  assert.equal(normalizeRemote("git@github.com:jjongguet/gjc-plugin.git"), "jjongguet/gjc-plugin");
  assert.equal(normalizeRemote("ssh://git@github.com/jjongguet/gjc-plugin"), "jjongguet/gjc-plugin");
  assert.equal(normalizeRemote("  "), null);
  assert.equal(repoMatches("jjongguet/gjc-plugin", "gjc-plugin"), true);
  assert.equal(repoMatches("jjongguet/gjc-plugin", "jjongguet/gjc-plugin"), true);
  assert.equal(repoMatches("jjongguet/gjc-plugin", "other/gjc-plugin"), false);
  assert.equal(repoMatches(null, "jjongguet/gjc-plugin"), false);
});

test("a live lane session on the same ticket and repository blocks a start", async () => {
  const worktree = tempWorktree();
  const listing = `lane-JJO-895-dedupe\t${epochOf(20)}\t${worktree}\tgjc`;
  const runner = laneRunner({ listing });
  const sessions = await laneSessions(runner);
  const repo = await resolveRepoIdentity(worktree, { runner });

  assert.equal(repo.key, "jjongguet/gjc-plugin");
  const { live, dead, unresolved } = findDuplicateSessions(sessions, { ticket: "JJO-895", repoKey: repo.key });
  assert.equal(live.length, 1);
  assert.equal(live[0].tmuxSession, "lane-JJO-895-dedupe");
  assert.equal(live[0].state, "live");
  assert.equal(live[0].ageMinutes, 20);
  assert.equal(live[0].startedAt, new Date(epochOf(20) * 1000).toISOString());
  assert.deepEqual(live[0].evidence, ["name", "tmuxSession", "branch"]);
  assert.deepEqual(dead, []);
  assert.deepEqual(unresolved, []);
});

test("a live session on another ticket in the same repository does not block", async () => {
  const worktree = tempWorktree();
  const listing = `lane-JJO-233-lookbook\t${epochOf(50)}\t${worktree}\tgjc`;
  const runner = laneRunner({ listing, branch: "feat/jjo233-qa-gate-loop" });
  const sessions = await laneSessions(runner);
  const result = findDuplicateSessions(sessions, { ticket: "JJO-895", repoKey: "jjongguet/gjc-plugin" });
  assert.deepEqual(result.live, []);
  assert.deepEqual(result.dead, []);
  assert.deepEqual(result.unresolved, []);
});

test("the same ticket in a different repository does not block", async () => {
  const worktree = tempWorktree();
  const listing = `lane-JJO-895-dedupe\t${epochOf(20)}\t${worktree}\tgjc`;
  const runner = laneRunner({ listing });
  const sessions = await laneSessions(runner);
  const result = findDuplicateSessions(sessions, { ticket: "JJO-895", repoKey: "jjongguet/lookbook-product" });
  assert.deepEqual(result.live, []);
});

// A mini lane checkout that outlived its tmux session is the leftover case: the
// checkout names the ticket but no session is alive, so it must not block.
test("a dead session is reported as cleanup, not as a duplicate", async () => {
  const origin = "/srv/jjongguet";
  const remoteOutput = [
    `origin\t${origin}`,
    `repo\tgjc-plugin\tfeat/jjo895-session-dedupe\t0\t0\t${iso(600)}\tfeat: old\tabc123\t${REMOTE}\t\t`,
  ].join("\n");
  const runner = fakeRunner([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok("") : null),
    (command) => (command === "ssh" ? ok(remoteOutput) : null),
  ]);
  const { sessions } = await collectSessions({ runner, now: NOW, miniHost: "macmini" });
  const result = findDuplicateSessions(sessions, { ticket: "JJO-895", repoKey: "jjongguet/gjc-plugin" });
  assert.deepEqual(result.live, []);
  assert.equal(result.dead.length, 1);
  assert.equal(result.dead[0].state, "dead");
  assert.equal(result.dead[0].target, "mini");
  assert.equal(result.dead[0].reason, "tmux_session_gone");
});

test("a live mini session on the same ticket and repository blocks", async () => {
  const origin = "/srv/jjongguet";
  const created = epochOf(30);
  const remoteOutput = [
    `origin\t${origin}`,
    `repo\tgjc-plugin\tfeat/jjo895-session-dedupe\t1\t0\t${iso(5)}\tfeat: mini work\tabc123\t${REMOTE}\t1\t${created}`,
    `tmux\tgjc-gjc-plugin\t${created}\t${origin}/gjc-plugin`,
  ].join("\n");
  const runner = fakeRunner([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok("") : null),
    (command) => (command === "ssh" ? ok(remoteOutput) : null),
  ]);
  const { sessions } = await collectSessions({ runner, now: NOW, miniHost: "macmini" });
  const result = findDuplicateSessions(sessions, { ticket: "JJO-895", repoKey: "jjongguet/gjc-plugin" });
  assert.equal(result.live.length, 1);
  assert.equal(result.live[0].target, "mini");
  assert.equal(result.live[0].tmuxSession, "gjc-gjc-plugin");
  assert.equal(result.live[0].ageMinutes, 30);
});

test("a session whose repository cannot be resolved is reported, never silently passed", async () => {
  const worktree = tempWorktree();
  const listing = `lane-JJO-895-dedupe\t${epochOf(20)}\t${worktree}\tgjc`;
  const runner = fakeRunner([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok(listing) : null),
    (command, args) => (command === "tmux" && args[0] === "capture-pane" ? ok("pane") : null),
    (command, args) => (command === "git" && args[2] === "config" ? fail("command_not_found") : null),
    (command, args) => (command === "git" && args[2] === "rev-parse" ? ok("abc1234\n") : null),
    (command, args) => (command === "git" ? ok("") : null),
  ]);
  const sessions = await laneSessions(runner);
  const result = findDuplicateSessions(sessions, { ticket: "JJO-895", repoKey: "jjongguet/gjc-plugin" });
  assert.deepEqual(result.live, []);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].repo, null);
});

test("an unreachable mini host stays an error and does not abort the lane result", async () => {
  const worktree = tempWorktree();
  const listing = `lane-JJO-233-lookbook\t${epochOf(50)}\t${worktree}\tgjc`;
  const runner = fakeRunner([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok(listing) : null),
    (command, args) => (command === "tmux" && args[0] === "capture-pane" ? ok("pane") : null),
    (command, args) => (command === "git" && args[2] === "rev-parse" ? ok("abc1234\n") : null),
    (command, args) => (command === "git" && args[2] === "config" ? ok(`${REMOTE}\n`) : null),
    (command, args) => (command === "git" ? ok("") : null),
    (command) => (command === "ssh" ? fail("timeout") : null),
  ]);
  const { sessions, errors } = await collectSessions({ runner, now: NOW, miniHost: "macmini" });
  assert.deepEqual(errors, [{ target: "mini", error: "timeout" }]);
  const result = findDuplicateSessions(sessions, { ticket: "JJO-895", repoKey: "jjongguet/gjc-plugin" });
  assert.deepEqual(result.live, []);
});
