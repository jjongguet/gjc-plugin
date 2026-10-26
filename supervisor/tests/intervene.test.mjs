import { test } from "node:test";
import assert from "node:assert/strict";
import { formatSteerMessage, isSteerTarget, sendDiscord, steerSession, validateWebhookUrl } from "../lib/intervene.mjs";
import { fail, fakeRunner, judgeFixture, ok } from "./helpers.mjs";

const judgment = { id: "lane:alpha", state: "stalled", reasons: ["no_commit_since_start_45m"], source: "deterministic" };

test("only one concrete lane session name is a steer target", () => {
  assert.equal(isSteerTarget("lane-alpha"), true);
  assert.equal(isSteerTarget("lane-JJO-913-supervisor"), true);
  for (const bad of ["", "alpha", "lane-", "lane-a b", "lane-*", "all", "lane-a:1", "%0", "-t"]) {
    assert.equal(isSteerTarget(bad), false, bad);
  }
});

test("dry-run previews the command and touches no session", async () => {
  const runner = fakeRunner([]);
  const result = await steerSession({ target: "lane-alpha", message: "nudge", marker: "sv-1", dryRun: true, runner });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.delivered, false);
  assert.equal(result.error, null);
  assert.deepEqual(result.command, ["tmux", "send-keys", "-t", "lane-alpha", "-l", "nudge"]);
  assert.deepEqual(runner.calls, []);
});

test("a real steer types the message, submits it and verifies the marker on screen", async () => {
  const sent = [];
  const runner = fakeRunner([
    (command, args) => {
      if (command !== "tmux") return null;
      if (args[0] === "send-keys" && args[3] === "-l") {
        sent.push(args[4]);
        return ok();
      }
      if (args[0] === "send-keys") return ok();
      if (args[0] === "capture-pane") return ok(`> ${sent.join(" ")}`);
      return null;
    },
  ]);
  const result = await steerSession({ target: "lane-alpha", message: "nudge sv-9", marker: "sv-9", dryRun: false, runner, settleMs: 1 });
  assert.equal(result.mode, "real");
  assert.equal(result.delivered, true);
  assert.equal(result.verified, true);
  assert.deepEqual(sent, ["nudge sv-9"]);
});

test("a real steer that cannot find its marker reports unverified instead of claiming success", async () => {
  const runner = fakeRunner([
    (command, args) => (command === "tmux" && args[0] === "capture-pane" ? ok("some other screen") : command === "tmux" ? ok() : null),
  ]);
  const result = await steerSession({ target: "lane-alpha", message: "nudge sv-9", marker: "sv-9", dryRun: false, runner, settleMs: 1 });
  assert.equal(result.delivered, true);
  assert.equal(result.verified, false);
  assert.equal(result.error, "marker_not_observed");
});

test("an invalid target never reaches tmux", async () => {
  const runner = fakeRunner([]);
  const result = await steerSession({ target: "lane-*", message: "nudge", marker: "sv-9", dryRun: false, runner, settleMs: 1 });
  assert.equal(result.error, "invalid_target");
  assert.equal(result.delivered, false);
  assert.deepEqual(runner.calls, []);
});

test("the webhook must be an https Discord webhook URL", () => {
  assert.equal(validateWebhookUrl(undefined), "missing");
  assert.equal(validateWebhookUrl("not a url"), "malformed");
  assert.equal(validateWebhookUrl("http://discord.com/api/webhooks/1/x"), "not_https");
  assert.equal(validateWebhookUrl("https://example.com/api/webhooks/1/x"), "host_not_discord");
  assert.equal(validateWebhookUrl("https://discord.com/channels/1"), "path_not_webhook");
  assert.equal(validateWebhookUrl("https://discord.com/api/webhooks/1/x"), null);
});

test("a missing webhook is a skipped summary, not a failed run", async () => {
  let called = false;
  const result = await sendDiscord({ webhookUrl: "", content: "hello", fetchImpl: async () => ((called = true), { ok: true, status: 200 }) });
  assert.equal(result.skipped, true);
  assert.equal(result.error, "webhook_missing");
  assert.equal(called, false);
});

test("the summary posts once with mentions disabled and stays under the Discord limit", async () => {
  let body = null;
  const result = await sendDiscord({
    webhookUrl: "https://discord.com/api/webhooks/1/token",
    content: "x".repeat(4000),
    fetchImpl: async (_url, init) => ((body = JSON.parse(init.body)), { ok: true, status: 204 }),
  });
  assert.equal(result.ok, true);
  assert.equal(result.status, 204);
  assert.equal(body.allowed_mentions.parse.length, 0);
  assert.ok(body.content.length <= 1900, `content length ${body.content.length}`);
});

test("a Discord HTTP failure is reported with its status", async () => {
  const result = await sendDiscord({
    webhookUrl: "https://discord.com/api/webhooks/1/token",
    content: "hello",
    fetchImpl: async () => ({ ok: false, status: 429 }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, "http_429");
});

test("the steer message carries the observed facts and forbids a kill", () => {
  const message = formatSteerMessage({ session: judgeFixture({ name: "alpha", ageMinutes: 45, dirty: 3 }), judgment, marker: "sv-1" });
  assert.match(message, /lane-alpha|alpha/);
  assert.match(message, /stalled/);
  assert.match(message, /45분/);
  assert.match(message, /세션은 종료하지 않는다/);
});

void fail;
