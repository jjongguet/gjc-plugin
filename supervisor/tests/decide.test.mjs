import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveJudgment } from "../lib/decide.mjs";
import { fail, fakeRunner, judgeFixture, NOW, ok } from "./helpers.mjs";

const judgment = (ambiguous) => ({
  id: "lane:alpha",
  state: "stalled",
  reasons: ["dirty_without_commit"],
  ...(ambiguous ? { ambiguous: { labels: ["stalled", "thrashing"], defaultState: "stalled", question: "stalled or thrashing?" } } : {}),
});

test("a deterministic judgment never spends a decision call", async () => {
  const runner = fakeRunner([]);
  const resolved = await resolveJudgment(judgeFixture(), judgment(false), { runner, decisionAsk: "/nonexistent", now: NOW });
  assert.equal(resolved.source, "deterministic");
  assert.equal(resolved.state, "stalled");
  assert.deepEqual(runner.calls, []);
});

test("an ambiguous judgment adopts a confident decision-model choice", async () => {
  const runner = fakeRunner([
    (_command, args) => (args.includes("--json") ? ok(JSON.stringify({ choice: "thrashing", confidence: 0.82, model: "jev-omni" })) : null),
  ]);
  const resolved = await resolveJudgment(judgeFixture(), judgment(true), { runner, decisionAsk: "/bin/decision-ask", now: NOW });
  assert.equal(resolved.source, "decision");
  assert.equal(resolved.state, "thrashing");
  assert.equal(resolved.confidence, 0.82);
  assert.equal(resolved.model, "jev-omni");
});

test("abstain, provider failure, unknown label and low confidence all fall back to the deterministic state", async () => {
  const cases = [
    { route: () => fail(null, 3), error: "decision_exit_3" },
    { route: () => fail("command_not_found"), error: "decision_exit_error:command_not_found" },
    { route: () => ok(JSON.stringify({ choice: "everything-is-fine", confidence: 0.9 })), error: "decision_unknown_label:everything-is-fine" },
    { route: () => ok(JSON.stringify({ choice: "thrashing", confidence: 0.4 })), error: "decision_low_confidence" },
    { route: () => ok("not json"), error: "decision_invalid_json" },
  ];
  for (const entry of cases) {
    const runner = fakeRunner([(command) => (command === "/bin/decision-ask" ? entry.route() : null)]);
    const resolved = await resolveJudgment(judgeFixture(), judgment(true), { runner, decisionAsk: "/bin/decision-ask", now: NOW });
    assert.equal(resolved.source, "deterministic_fallback", entry.error);
    assert.equal(resolved.state, "stalled", entry.error);
    assert.equal(resolved.error, entry.error);
  }
});
