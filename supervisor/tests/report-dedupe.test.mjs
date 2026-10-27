import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { parseArgs, runOnce } from "../lib/cli.mjs";
import { buildSnapshot, reportFingerprint } from "../lib/report.mjs";
import { judgeFixture, NOW } from "./helpers.mjs";

const WEBHOOK = "https://discord.com/api/webhooks/1/token";
const TEN_MINUTES = 10 * 60_000;
const tempDir = () => mkdtempSync(path.join(os.tmpdir(), "supervisor-dedupe-"));

function stubCi() {
  return { resolve: async () => ({ state: "success", detail: "1/1", total: 1 }), flush: async () => {} };
}

function stubCollect(sessions) {
  return async () => ({ sessions: sessions.map(session => ({ ...session })), errors: [] });
}

const options = out => ({
  command: "once",
  out,
  discord: true,
  includeMini: false,
  steer: null,
  dryRun: false,
  forceReport: false,
  json: false,
  intervalSeconds: 600,
  count: null,
});

/** Counts Discord POSTs and answers with `status`. */
function countingFetch(status = 204) {
  const fetchImpl = async () => {
    fetchImpl.posts += 1;
    return { ok: status < 400, status };
  };
  fetchImpl.posts = 0;
  return fetchImpl;
}

const statePath = out => path.join(out, "last-report.json");

test("an unchanged snapshot is reported once, then suppressed with a logged reason", async () => {
  const out = tempDir();
  try {
    const fetchImpl = countingFetch();
    const lines = [];
    const deps = {
      collectSessions: stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha" })]),
      ciResolver: stubCi(),
      stdout: line => lines.push(line),
      fetchImpl,
      webhookUrl: WEBHOOK,
    };
    const first = await runOnce(options(out), { ...deps, now: () => NOW });
    const second = await runOnce(options(out), { ...deps, now: () => NOW + TEN_MINUTES });

    assert.equal(fetchImpl.posts, 1);
    assert.equal(first.snapshot.discord.ok, true);
    assert.equal(second.snapshot.discord.ok, false);
    assert.equal(second.snapshot.discord.skipped, true);
    assert.equal(second.snapshot.discord.error, "unchanged");
    assert.ok(lines.includes("discord: skipped: unchanged"), "the suppression reason is printed");

    const stored = JSON.parse(readFileSync(statePath(out), "utf8"));
    assert.match(stored.fingerprint, /^[0-9a-f]{64}$/);
    assert.equal(stored.fingerprint, reportFingerprint(second.snapshot));
    assert.equal(statSync(statePath(out)).mode & 0o777, 0o600);

    const discordEvents = readFileSync(path.join(out, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(line => JSON.parse(line))
      .filter(event => event.event === "discord");
    assert.deepEqual(discordEvents.map(event => event.error), [null, "unchanged"]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a changed monitored set or a changed state is reported again", async () => {
  const out = tempDir();
  try {
    const fetchImpl = countingFetch();
    const deps = { ciResolver: stubCi(), stdout: () => {}, fetchImpl, webhookUrl: WEBHOOK };
    const alpha = judgeFixture({ id: "lane:alpha", name: "alpha" });
    const beta = judgeFixture({ id: "lane:beta", name: "beta", tmuxSession: "lane-beta" });

    await runOnce(options(out), { ...deps, now: () => NOW, collectSessions: stubCollect([alpha]) });
    const joined = await runOnce(options(out), { ...deps, now: () => NOW + TEN_MINUTES, collectSessions: stubCollect([alpha, beta]) });
    assert.equal(fetchImpl.posts, 2);
    assert.equal(joined.snapshot.discord.ok, true);

    const moved = await runOnce(options(out), {
      ...deps,
      now: () => NOW + 20 * 60_000,
      collectSessions: stubCollect([{ ...alpha, commitsLastWindow: 2 }]),
    });
    assert.equal(fetchImpl.posts, 3);
    assert.equal(moved.snapshot.judgments[0].state, "progressing");
    assert.equal(moved.snapshot.discord.ok, true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a damaged state file sends instead of silently dropping the report", async () => {
  const out = tempDir();
  try {
    const fetchImpl = countingFetch();
    const deps = {
      collectSessions: stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha" })]),
      ciResolver: stubCi(),
      stdout: () => {},
      fetchImpl,
      webhookUrl: WEBHOOK,
    };
    await runOnce(options(out), { ...deps, now: () => NOW });

    writeFileSync(statePath(out), "{ not json");
    const unparsable = await runOnce(options(out), { ...deps, now: () => NOW + TEN_MINUTES });
    assert.equal(fetchImpl.posts, 2);
    assert.equal(unparsable.snapshot.discord.ok, true);
    assert.match(JSON.parse(readFileSync(statePath(out), "utf8")).fingerprint, /^[0-9a-f]{64}$/);

    writeFileSync(statePath(out), JSON.stringify({ fingerprint: 42 }));
    const wrongShape = await runOnce(options(out), { ...deps, now: () => NOW + 20 * 60_000 });
    assert.equal(fetchImpl.posts, 3);
    assert.equal(wrongShape.snapshot.discord.ok, true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("--force-report sends an unchanged summary and then goes quiet again", async () => {
  const out = tempDir();
  try {
    const fetchImpl = countingFetch();
    const deps = {
      collectSessions: stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha" })]),
      ciResolver: stubCi(),
      stdout: () => {},
      fetchImpl,
      webhookUrl: WEBHOOK,
    };
    await runOnce(options(out), { ...deps, now: () => NOW });
    const suppressed = await runOnce(options(out), { ...deps, now: () => NOW + TEN_MINUTES });
    assert.equal(suppressed.snapshot.discord.error, "unchanged");
    assert.equal(fetchImpl.posts, 1);

    const forced = await runOnce({ ...options(out), forceReport: true }, { ...deps, now: () => NOW + 20 * 60_000 });
    assert.equal(fetchImpl.posts, 2);
    assert.equal(forced.snapshot.discord.ok, true);

    const quiet = await runOnce(options(out), { ...deps, now: () => NOW + 30 * 60_000 });
    assert.equal(fetchImpl.posts, 2);
    assert.equal(quiet.snapshot.discord.error, "unchanged");

    assert.equal(parseArgs(["once", "--force-report"]).forceReport, true);
    assert.equal(parseArgs(["loop", "--force-report"]).forceReport, true);
    assert.equal(parseArgs(["loop"]).forceReport, false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a missing webhook stays webhook_missing and records no fingerprint", async () => {
  const out = tempDir();
  try {
    const fetchImpl = countingFetch();
    const deps = {
      collectSessions: stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha" })]),
      ciResolver: stubCi(),
      stdout: () => {},
      fetchImpl,
    };
    const missing = await runOnce(options(out), { ...deps, now: () => NOW, webhookUrl: "" });
    assert.equal(fetchImpl.posts, 0);
    assert.equal(missing.snapshot.discord.skipped, true);
    assert.equal(missing.snapshot.discord.error, "webhook_missing");
    assert.equal(existsSync(statePath(out)), false);

    // The first run that has a webhook still reports the unchanged workspace.
    const sent = await runOnce(options(out), { ...deps, now: () => NOW + TEN_MINUTES, webhookUrl: WEBHOOK });
    assert.equal(fetchImpl.posts, 1);
    assert.equal(sent.snapshot.discord.ok, true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a failed send does not advance the fingerprint", async () => {
  const out = tempDir();
  try {
    const fetchImpl = async () => {
      fetchImpl.posts += 1;
      return fetchImpl.posts === 1 ? { ok: false, status: 500 } : { ok: true, status: 204 };
    };
    fetchImpl.posts = 0;
    const deps = {
      collectSessions: stubCollect([judgeFixture({ id: "lane:alpha", name: "alpha" })]),
      ciResolver: stubCi(),
      stdout: () => {},
      fetchImpl,
      webhookUrl: WEBHOOK,
    };
    const failed = await runOnce(options(out), { ...deps, now: () => NOW });
    assert.equal(failed.snapshot.discord.ok, false);
    assert.equal(failed.snapshot.discord.error, "http_500");
    assert.equal(existsSync(statePath(out)), false);

    const retried = await runOnce(options(out), { ...deps, now: () => NOW + TEN_MINUTES });
    assert.equal(fetchImpl.posts, 2);
    assert.equal(retried.snapshot.discord.ok, true);
    assert.equal(existsSync(statePath(out)), true);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the fingerprint tracks reportable facts and ignores volatile ones", () => {
  const host = { hostname: "test-host", miniHost: null };
  const sessions = [judgeFixture({ id: "lane:alpha", name: "alpha" }), judgeFixture({ id: "lane:beta", name: "beta", tmuxSession: "lane-beta" })];
  const judgments = [
    { id: "lane:alpha", state: "stalled", reasons: ["no_commit_since_start_45m"], source: "deterministic" },
    { id: "lane:beta", state: "progressing", reasons: ["commit_within_10m"], source: "deterministic" },
  ];
  const withFacts = overrides =>
    reportFingerprint(
      buildSnapshot({ now: NOW, runId: "run-1", host, sessions, judgments, interventions: [], errors: [], ...overrides }),
    );
  const base = withFacts({});

  // Timestamps, run id, ages and dirty counts are noise between two quiet runs.
  assert.equal(
    withFacts({ runId: "run-2", now: NOW + TEN_MINUTES, sessions: sessions.map(session => ({ ...session, ageMinutes: 90, dirty: 7 })) }),
    base,
  );
  // Ordering of the same facts is not a change.
  assert.equal(withFacts({ judgments: [judgments[1], judgments[0]] }), base);
  // A session leaving, a stall appearing, a collection error and a steer all move it.
  assert.notEqual(withFacts({ sessions: sessions.slice(0, 1), judgments: judgments.slice(0, 1) }), base);
  assert.notEqual(withFacts({ judgments: [{ ...judgments[0], state: "thrashing" }, judgments[1]] }), base);
  assert.notEqual(withFacts({ errors: [{ target: "mini", error: "ssh_exit_255" }] }), base);
  assert.notEqual(
    withFacts({ interventions: [{ target: "lane-alpha", mode: "real", delivered: true, verified: true, error: null }] }),
    base,
  );
});
