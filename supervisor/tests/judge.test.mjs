import { test } from "node:test";
import assert from "node:assert/strict";
import { judgeSession } from "../lib/judge.mjs";
import { judgeFixture, iso, NOW } from "./helpers.mjs";

const judge = (overrides, context = {}) => judgeSession(judgeFixture(overrides), { now: NOW, ...context });

test("30 minutes without a commit and none since start is stalled", () => {
  const verdict = judge({ ageMinutes: 31, commitsSinceStart: 0, dirty: 0 });
  assert.equal(verdict.state, "stalled");
  assert.deepEqual(verdict.reasons, ["no_commit_since_start_31m"]);
});

test("a commit inside the progress window is progressing", () => {
  const verdict = judge({ ageMinutes: 12, commitsSinceStart: 2, commitsLastWindow: 1, lastCommit: { at: iso(4), subject: "x" } });
  assert.equal(verdict.state, "progressing");
  assert.deepEqual(verdict.reasons, ["commit_within_10m"]);
});

test("a commit inside the stall window but outside the progress window is progressing", () => {
  const verdict = judge({ ageMinutes: 20, commitsSinceStart: 4, commitsLastWindow: 0, lastCommit: { at: iso(12), subject: "x" } });
  assert.equal(verdict.state, "progressing");
  assert.deepEqual(verdict.reasons, ["last_commit_12m"]);
});

test("dirty files growing without a commit is thrashing", () => {
  const verdict = judge({ ageMinutes: 20, commitsSinceStart: 1, dirty: 5, dirtyDelta: 3, lastCommit: { at: iso(2), subject: "x" } });
  assert.equal(verdict.state, "thrashing");
  assert.deepEqual(verdict.reasons, ["dirty_growth_without_commit"]);
});

test("a dirty tree that stops growing past the stall window is an ambiguity, not a guess", () => {
  const verdict = judge({ ageMinutes: 41, commitsSinceStart: 3, dirty: 4, dirtyDelta: 0, lastCommit: { at: iso(40), subject: "x" } });
  assert.equal(verdict.state, "stalled");
  assert.deepEqual(verdict.ambiguous.labels, ["stalled", "thrashing"]);
  assert.equal(verdict.ambiguous.defaultState, "stalled");
});

test("no commit for the whole stall window with a clean tree is stalled", () => {
  const verdict = judge({ ageMinutes: 41, commitsSinceStart: 3, dirty: 0, dirtyDelta: 0, lastCommit: { at: iso(40), subject: "x" } });
  assert.equal(verdict.state, "stalled");
  assert.equal(verdict.ambiguous, undefined);
  assert.deepEqual(verdict.reasons, ["no_commit_within_40m"]);
});

test("a young session without commits is starting, not stalled", () => {
  const verdict = judge({ ageMinutes: 12, commitsSinceStart: 0 });
  assert.equal(verdict.state, "starting");
});

test("a missing lane worktree is stalled even when tmux is alive", () => {
  const verdict = judge({ worktreePresent: false });
  assert.equal(verdict.state, "stalled");
  assert.deepEqual(verdict.reasons, ["worktree_missing"]);
});

test("a dead tmux session is stalled", () => {
  const verdict = judge({ tmuxAlive: false });
  assert.equal(verdict.state, "stalled");
  assert.deepEqual(verdict.reasons, ["session_gone"]);
});

test("mini sessions without an age fall back to unknown instead of an invented stall", () => {
  const verdict = judgeSession(judgeFixture({ target: "mini", ageMinutes: null, tmuxAlive: null, commitsSinceStart: null }), {
    now: NOW,
    previous: { sessions: [{ id: "lane:alpha" }] },
  });
  assert.equal(verdict.state, "unknown");
  assert.deepEqual(verdict.reasons, ["age_unknown"]);
});

test("no signal at all is unknown", () => {
  const verdict = judge({ ageMinutes: null, commitsSinceStart: null, tmuxAlive: null });
  assert.equal(verdict.state, "unknown");
  assert.deepEqual(verdict.reasons, ["insufficient_signal"]);
});
