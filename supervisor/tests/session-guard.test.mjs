import { test } from "node:test";
import assert from "node:assert/strict";
import { main, localTimestamp } from "../lib/session-guard.mjs";
import { epochOf, fail, fakeRunner, iso, NOW, ok, tempWorktree } from "./helpers.mjs";

const REMOTE = "https://github.com/jjongguet/gjc-plugin.git";

function harness(routes, { argv, now = NOW } = {}) {
  const runner = fakeRunner(routes);
  const out = [];
  const err = [];
  return {
    runner,
    run: prefix =>
      main(argv ?? prefix, {
        runner,
        now,
        stdout: text => out.push(text),
        stderr: text => err.push(text),
        env: { MINI_HOST: "macmini" },
      }),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

function gitRoutes({ branch = "feat/jjo895-session-dedupe", remote = REMOTE } = {}) {
  return (command, args) => {
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
  };
}

test("a second start on a live ticket exits 2 with the session name and start time", async () => {
  const worktree = tempWorktree();
  const listing = `lane-JJO-895-dedupe\t${epochOf(20)}\t${worktree}\tgjc`;
  const h = harness([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok(listing) : null),
    (command, args) => (command === "tmux" && args[0] === "capture-pane" ? ok("pane") : null),
    gitRoutes(),
    (command) => (command === "ssh" ? ok(`origin\t/srv/jjongguet\n`) : null),
  ]);

  const code = await h.run(["JJO-895", worktree]);

  assert.equal(code, 2);
  const output = h.out();
  assert.match(output, /^session-guard: 차단 — JJO-895 \/ jjongguet\/gjc-plugin 에 살아있는 세션이 1개 있다/m);
  assert.match(output, /lane-JJO-895-dedupe/);
  assert.match(output, /시작 \d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}/);
  assert.match(output, /경과 20분/);
  assert.match(output, /lane-gjc tail JJO-895-dedupe/);
  assert.equal(h.err(), "");
});

test("a free ticket exits 0", async () => {
  const worktree = tempWorktree();
  const listing = `lane-JJO-233-lookbook\t${epochOf(50)}\t${worktree}\tgjc`;
  const h = harness([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok(listing) : null),
    (command, args) => (command === "tmux" && args[0] === "capture-pane" ? ok("pane") : null),
    gitRoutes({ branch: "feat/jjo233-qa-gate-loop" }),
  ]);

  const code = await h.run(["JJO-999", worktree]);

  assert.equal(code, 0);
  assert.match(h.out(), /session-guard: 통과 — JJO-999 \/ jjongguet\/gjc-plugin/);
  assert.match(h.out(), /세션 1개 검사, 미니 macmini 포함/);
});

test("a dead session passes and is named as a cleanup candidate", async () => {
  const worktree = tempWorktree();
  const remoteOutput = [
    `origin\t/srv/jjongguet`,
    `repo\tgjc-plugin\tfeat/jjo895-session-dedupe\t0\t0\t${iso(600)}\tfeat: old\tabc123\t${REMOTE}\t\t`,
  ].join("\n");
  const h = harness([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok("") : null),
    gitRoutes(),
    (command) => (command === "ssh" ? ok(remoteOutput) : null),
  ]);

  const code = await h.run(["JJO-895", worktree]);

  assert.equal(code, 0);
  assert.match(h.out(), /통과/);
  assert.match(h.out(), /정리 후보\(차단 아님\): gjc-plugin — tmux 세션 없음/);
});

test("an unreadable tmux listing exits 3 instead of claiming no duplicate", async () => {
  const worktree = tempWorktree();
  const h = harness([
    (command) => (command === "tmux" ? fail("command_not_found") : null),
    gitRoutes(),
  ]);

  const code = await h.run(["JJO-895", worktree]);

  assert.equal(code, 3);
  assert.match(h.out(), /session-guard: 확인 불가/);
  assert.match(h.out(), /세션이 없다고 보장할 수 없으므로/);
});

test("an unreachable mini host is reported and does not change the verdict", async () => {
  const worktree = tempWorktree();
  const h = harness([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok("") : null),
    gitRoutes(),
    (command) => (command === "ssh" ? fail("ssh_exit_255") : null),
  ]);

  const code = await h.run(["JJO-895", worktree]);

  assert.equal(code, 0);
  assert.match(h.out(), /미니 macmini 수집 오류: ssh_exit_255/);
});

test("usage errors exit 1", async () => {
  const worktree = tempWorktree();
  const noArgs = harness([gitRoutes()], { argv: [] });
  assert.equal(await noArgs.run(), 1);
  assert.match(noArgs.err(), /usage: session-guard/);

  const badTicket = harness([gitRoutes()], { argv: ["not-a-ticket", worktree] });
  assert.equal(await badTicket.run(), 1);
  assert.match(badTicket.err(), /티켓 형식이 아니다/);

  const missingRepo = harness([gitRoutes()], { argv: ["JJO-895", "/definitely/not/here"] });
  assert.equal(await missingRepo.run(), 1);
  assert.match(missingRepo.err(), /레포를 해석할 수 없다/);
});

test("--json emits the machine-readable verdict", async () => {
  const worktree = tempWorktree();
  const listing = `lane-JJO-895-dedupe\t${epochOf(20)}\t${worktree}\tgjc`;
  const h = harness([
    (command, args) => (command === "tmux" && args[0] === "ls" ? ok(listing) : null),
    (command, args) => (command === "tmux" && args[0] === "capture-pane" ? ok("pane") : null),
    gitRoutes(),
    (command) => (command === "ssh" ? fail("timeout") : null),
  ]);

  const code = await h.run(["JJO-895", worktree, "--json"]);

  assert.equal(code, 2);
  const payload = JSON.parse(h.out());
  assert.equal(payload.verdict, "duplicate");
  assert.equal(payload.ticket, "JJO-895");
  assert.equal(payload.repo.key, "jjongguet/gjc-plugin");
  assert.equal(payload.live.length, 1);
  assert.equal(payload.live[0].tmuxSession, "lane-JJO-895-dedupe");
  assert.equal(payload.errors[0].error, "timeout");
});

test("localTimestamp prints local wall clock with an explicit offset", () => {
  const rendered = localTimestamp("2026-10-26T19:35:00Z");
  assert.match(rendered, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} [+-]\d{2}:\d{2}$/);
  assert.equal(localTimestamp(null), "시작 시각 미상");
});
