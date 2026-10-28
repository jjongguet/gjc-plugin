import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { publicDecision, compareDecision, historicalBoundaryControls } from "../../m1/pilot-oracle.mjs";
import { createReservationLedger, normalizeRequest, startRecordingProxy, UPSTREAM, MODEL } from "../../m1/recording-proxy.mjs";

const ruleText = "NATIVE_RULE_BEGIN\nValidate the public contract.\nNATIVE_RULE_END\n";
const body = (rule = false) => ({ model: "gpt-4.1-mini", max_tokens: 300, messages: [{ role: "system", content: rule ? ruleText.trim() : "JSON only" }, { role: "user", content: "Classify the public artifact" }], stream: true });
const oracle = JSON.parse(readFileSync(new URL("../fixtures/pilot/oracle/decision-probability-boundary-dev10.json", import.meta.url)));
const budget = (onEvent = () => {}, extra = {}) => createReservationLedger({ capUsd: 1, taskCapUsd: 5, priorSpentUsd: 0, priorReservedUsd: 0, priorUnresolvedUsd: 0, cleanupUsd: 0, inputPrice: 0.0000004, outputPrice: 0.0000016, onEvent, ...extra });
const send = (proxy, token, payload, extra = {}) => fetch(`${proxy.url}/chat/completions`, { method: "POST", signal: extra.signal, headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...extra.headers }, body: JSON.stringify(payload) });

// No real provider, credential, browser or host configuration is used by these tests.
test("historical boundary mismatch and two controls are actually evaluated", () => {
  const result = historicalBoundaryControls();
  assert.equal(result.passed, true);
  assert.equal(result.cases.length, 3);
  assert.equal(result.cases[0].observed, false);
  assert.equal(result.cases[0].documentedAccept, true);
  assert.ok(result.error > 0.001);
});

test("public schema cannot select using the hidden answer", () => {
  assert.equal(publicDecision('{"accept":false}').valid, true);
  assert.equal(compareDecision('{"accept":false}', oracle).passed, false);
  assert.equal(compareDecision('{"accept":true,"tier":"fast"}', oracle).passed, true);
  for (const bad of ['```json\n{}\n```', '{"accept":true}', '{"accept":false,"tier":"fast"}', '{"accept":true,"tier":"unknown"}', '[]', '{"accept":true,"tier":"fast","note":"extra"}']) assert.equal(publicDecision(bad).valid, false, bad);
});

test("normalization bounds all composed content and refuses tools, overflow and model drift", () => {
  assert.ok(normalizeRequest(body(), "/v1/chat/completions").inputUpperBound > 0);
  for (const [patch, reason] of [[{ max_tokens: 301 }, "output_bound_mismatch"], [{ model: "other" }, "model_mismatch"], [{ tools: [{}] }, "unexpected_tools_or_continuation"], [{ messages: [{ role: "system", content: "x".repeat(3000) }] }, "input_bound_exceeded"]]) assert.throws(() => normalizeRequest({ ...body(), ...patch }, "/v1/chat/completions"), new RegExp(reason));
});

test("reservation is written before dispatch and unknown charges stay reserved", () => {
  const events = [];
  const ledger = budget((e) => events.push(e));
  ledger.reserve("one");
  assert.equal(events[0].kind, "reserved");
  assert.equal(ledger.snapshot().calls, 1);
  assert.ok(ledger.snapshot().reservedUsd > 0);
  assert.throws(() => ledger.settle("one", {}), /usage_missing/);
  assert.ok(ledger.snapshot().reservedUsd > 0);
  assert.throws(() => ledger.reserve("two"), /unknown_usage/);
});

test("task prior spend and call ceilings cannot be reset per attempt", () => {
  assert.throws(() => budget(() => {}, { priorSpentUsd: null }), /unknown_price_or_usage/);
  assert.throws(() => budget(() => {}, { priorSpentUsd: 5 }).reserve("one"), /cap_exceeded/);
  assert.throws(() => budget(() => {}, { priorUnresolvedUsd: 0.01 }).reserve("one"), /unknown_usage/);
  const ledger = budget(() => {}, { maxCalls: 1 });
  ledger.reserve("one");
  ledger.settle("one", { cost: 0.0001, prompt_tokens: 100, completion_tokens: 10 });
  assert.throws(() => ledger.reserve("two"), /call_cap_exceeded/);
  assert.equal(ledger.snapshot().spentUsd, 0.0001);
});

test("dry proxy never calls upstream; native rule inclusion and exact output limit are recorded", async () => {
  let outbound = 0;
  const proxy = await startRecordingProxy({ ruleText, fetchImpl: () => { outbound += 1; throw new Error("unexpected_outbound"); } });
  try {
    const token = proxy.armSlot("B2-1", "B2");
    const response = await send(proxy, token, body(true));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /accept/);
    assert.equal(outbound, 0);
    assert.equal(proxy.rows[0].rulePresent, true);
    assert.equal(proxy.rows[0].declaredOutputLimit, 300);
    assert.equal(proxy.rows[0].usage, undefined, "scripted usage is not a real measured provider cost");
    assert.equal(JSON.stringify(proxy.rows).includes(token), false);
    assert.equal(JSON.stringify(proxy.rows).includes("Classify the public artifact"), false);
  } finally { await proxy.close(); }
});

test("missing B2 rules and unexpected baseline rules fail before any upstream request", async () => {
  for (const [arm, containsRule] of [["B2", false], ["B0", true]]) {
    let outbound = 0;
    const proxy = await startRecordingProxy({ ruleText, fetchImpl: () => { outbound += 1; } });
    try {
      const response = await send(proxy, proxy.armSlot("rule-check", arm), body(containsRule));
      assert.equal(response.status, 400);
      assert.match(await response.text(), /child_harness_not_loaded/);
      assert.equal(outbound, 0);
      assert.throws(() => proxy.armSlot("next", arm), /proxy_stopped/);
    } finally { await proxy.close(); }
  }
});

test("credential and continuation boundaries fail closed", async () => {
  const proxy = await startRecordingProxy({ ruleText });
  try {
    const token = proxy.armSlot("one", "B0");
    assert.equal((await send(proxy, token, body())).status, 200);
    const second = await send(proxy, token, body());
    assert.equal(second.status, 400);
    assert.match(await second.text(), /unexpected_continuation/);
  } finally { await proxy.close(); }
  const other = await startRecordingProxy({ ruleText });
  try {
    other.armSlot("one", "B0");
    const denied = await send(other, "wrong", body());
    assert.equal(denied.status, 400);
    assert.match(await denied.text(), /unauthorized/);
  } finally { await other.close(); }
});

test("mock live transport pins route/model/cap, strips child credentials and records upstream usage", async () => {
  let calls = 0;
  const ledger = budget();
  const proxy = await startRecordingProxy({ mode: "live", ruleText, apiKey: "fake-parent-key", ledger, fetchImpl: async (url, options) => {
    calls += 1;
    assert.equal(url, UPSTREAM);
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.authorization, "Bearer fake-parent-key");
    const request = JSON.parse(options.body);
    assert.equal(request.model, MODEL);
    assert.equal(request.max_tokens, 300);
    assert.equal(request.provider.allow_fallbacks, false);
    assert.equal(ledger.snapshot().calls, 1, "reservation exists before fetch");
    return Response.json({ id: "gen-test-only", model: MODEL, provider: "OpenAI", usage: { cost: 0.0001, prompt_tokens: 100, completion_tokens: 10 }, choices: [{ finish_reason: "stop", message: { content: '{"accept":false}' } }] });
  } });
  try {
    const response = await send(proxy, proxy.armSlot("live-one", "B0"), body());
    assert.equal(response.status, 200);
    await response.text();
    assert.equal(calls, 1);
    assert.deepEqual(proxy.rows[0].usage, { usd: 0.0001, input: 100, output: 10 });
    assert.equal(ledger.snapshot().reservedUsd, 0);
    assert.equal(ledger.snapshot().spentUsd, 0.0001);
  } finally { await proxy.close(); }
});

test("transport errors retain reservations and forbid a new slot", async () => {
  const ledger = budget();
  const proxy = await startRecordingProxy({ mode: "live", ruleText, apiKey: "fake-parent-key", ledger, fetchImpl: async () => { throw new Error("synthetic_failure"); } });
  try {
    const response = await send(proxy, proxy.armSlot("unknown", "B0"), body());
    assert.equal(response.status, 400);
    assert.equal(ledger.snapshot().blocked, true);
    assert.ok(ledger.snapshot().reservedUsd > 0);
    assert.throws(() => proxy.armSlot("retry", "B0"), /proxy_stopped/);
  } finally { await proxy.close(); }
});

function pendingProvider() {
  let announceStarted;
  let announceAborted;
  const started = new Promise((resolve) => { announceStarted = resolve; });
  const aborted = new Promise((resolve) => { announceAborted = resolve; });
  return {
    started, aborted,
    fetchImpl: async (_url, { signal }) => {
      announceStarted();
      return await new Promise((_resolve, reject) => {
        const abort = () => { announceAborted(signal.reason?.message); reject(signal.reason); };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  };
}

test("remaining cell deadline aborts paid transport and retains its reservation", { timeout: 4000 }, async () => {
  const provider = pendingProvider();
  const ledger = budget();
  const proxy = await startRecordingProxy({ mode: "live", ruleText, apiKey: "fake-parent-key", ledger, fetchImpl: provider.fetchImpl });
  try {
    const response = send(proxy, proxy.armSlot("deadline", "B0", Date.now() + 1000), body());
    await provider.started;
    assert.equal(await provider.aborted, "execution_deadline_exceeded");
    assert.equal((await response).status, 400);
    assert.ok(ledger.snapshot().reservedUsd > 0);
    assert.equal(ledger.snapshot().blocked, true);
    assert.equal(proxy.rows[0].error, "execution_deadline_exceeded");
  } finally { await proxy.close(); }
});

test("downstream disconnect aborts the pending provider, not just the local socket", { timeout: 4000 }, async () => {
  const provider = pendingProvider();
  const ledger = budget();
  const proxy = await startRecordingProxy({ mode: "live", ruleText, apiKey: "fake-parent-key", ledger, fetchImpl: provider.fetchImpl });
  const controller = new AbortController();
  try {
    const request = send(proxy, proxy.armSlot("disconnect", "B0"), body(), { signal: controller.signal }).catch((error) => error);
    await provider.started;
    controller.abort();
    assert.equal(await provider.aborted, "client_disconnected");
    await request;
  } finally { await proxy.close(); }
  assert.equal(ledger.snapshot().blocked, true);
  assert.ok(ledger.snapshot().reservedUsd > 0);
  assert.equal(proxy.rows[0].error, "client_disconnected");
});

test("close joins active provider handlers before the final accounting snapshot", { timeout: 4000 }, async () => {
  const provider = pendingProvider();
  const events = [];
  const ledger = budget((event) => events.push(event));
  const proxy = await startRecordingProxy({ mode: "live", ruleText, apiKey: "fake-parent-key", ledger, fetchImpl: provider.fetchImpl });
  const request = send(proxy, proxy.armSlot("close", "B0"), body()).catch((error) => error);
  await provider.started;
  await proxy.close();
  await request;
  assert.equal(await provider.aborted, "proxy_closed");
  assert.equal(events.at(-1).kind, "unresolved");
  assert.equal(ledger.snapshot().blocked, true);
  assert.ok(ledger.snapshot().reservedUsd > 0);
  assert.equal(proxy.rows[0].error, "proxy_closed");
});
