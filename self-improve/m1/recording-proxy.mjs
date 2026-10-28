import http from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { admitCall } from "../lib/behavior-eval.mjs";

export const UPSTREAM = "https://openrouter.ai/api/v1/chat/completions";
export const MODEL = "openai/gpt-4.1-mini";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = (code) => { throw new Error(code); };

/** The observed native completions transport admits only text and no prior assistant turns. */
export function normalizeRequest(body, route) {
  if (route !== "/v1/chat/completions") fail("unexpected_endpoint");
  if (!body || typeof body !== "object" || Array.isArray(body)) fail("invalid_body");
  if (body.model !== "gpt-4.1-mini") fail("model_mismatch");
  if (body.tools?.length || body.functions?.length || body.previous_response_id) fail("unexpected_tools_or_continuation");
  const maxOutput = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens;
  if (maxOutput !== 300) fail("output_bound_mismatch");
  const messages = [];
  const source = body.messages;
  if (!Array.isArray(source) || !source.length || source.length > 12) fail("invalid_messages");
  for (const message of source) {
    if (!message || !["system", "developer", "user"].includes(message.role) || message.tool_calls || message.function_call) fail("unexpected_message");
    let content = message.content;
    if (Array.isArray(content)) {
      if (content.some((part) => !["text", "input_text", "output_text"].includes(part.type) || typeof part.text !== "string")) fail("non_text_content");
      content = content.map((part) => part.text).join("\n");
    }
    if (typeof content !== "string") fail("non_text_content");
    messages.push({ role: message.role, content });
  }
  // UTF-8 bytes plus conservative framing is an upper bound, not a tokens/4 guess.
  const inputUpperBound = Buffer.byteLength(JSON.stringify(messages), "utf8") + 256;
  if (inputUpperBound > 3000) fail("input_bound_exceeded");
  return { messages, inputUpperBound, maxOutput };
}

export function createReservationLedger({ capUsd, taskCapUsd, priorSpentUsd, priorReservedUsd, priorUnresolvedUsd, cleanupUsd, inputPrice, outputPrice, maxCalls = 21, onEvent }) {
  if (![capUsd, taskCapUsd, priorSpentUsd, priorReservedUsd, priorUnresolvedUsd, cleanupUsd, inputPrice, outputPrice].every((v) => Number.isFinite(v) && v >= 0)) fail("unknown_price_or_usage");
  if (!(capUsd > 0 && capUsd <= 1 && taskCapUsd > 0 && taskCapUsd <= 5 && inputPrice > 0 && outputPrice > 0)) fail("invalid_budget");
  if (!Number.isSafeInteger(maxCalls) || maxCalls < 1 || maxCalls > 21 || typeof onEvent !== "function") fail("invalid_budget");
  const reservation = 3000 * inputPrice + 300 * outputPrice;
  let calls = 0;
  let spent = 0;
  let blocked = priorUnresolvedUsd > 0;
  const pending = new Map();
  const seen = new Set();
  const snapshot = () => ({ calls, spentUsd: spent, reservedUsd: [...pending.values()].reduce((a, b) => a + b, 0), priorSpentUsd, priorReservedUsd, priorUnresolvedUsd, blocked });
  return {
    snapshot,
    reserve(id) {
      if (blocked) fail("unknown_usage");
      if (seen.has(id)) fail("duplicate_request");
      if (calls >= maxCalls) fail("call_cap_exceeded");
      const reserved = snapshot().reservedUsd;
      const pilot = admitCall({ capUsd, spentUsd: spent, unresolvedUsd: reserved, reservationUsd: reservation, cleanupUsd, priceUsd: reservation });
      const task = admitCall({ capUsd: taskCapUsd, spentUsd: priorSpentUsd + spent, unresolvedUsd: priorReservedUsd + priorUnresolvedUsd + reserved, reservationUsd: reservation, cleanupUsd, priceUsd: reservation });
      if (!pilot.allowed || !task.allowed) fail("cap_exceeded");
      calls += 1;
      seen.add(id);
      pending.set(id, reservation);
      // This synchronous durable write MUST finish before fetch; failure stops dispatch.
      onEvent({ kind: "reserved", id, reservationUsd: reservation, state: snapshot() });
    },
    settle(id, usage) {
      if (!pending.has(id)) fail("unknown_request");
      const valid = usage && Number.isFinite(usage.cost) && usage.cost >= 0 && Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0 && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0;
      if (!valid) {
        blocked = true;
        onEvent({ kind: "unresolved", id, reason: "usage_missing", state: snapshot() });
        fail("usage_missing");
      }
      spent += usage.cost;
      const boundBroken = usage.cost > pending.get(id) + 1e-12 || usage.prompt_tokens > 3000 || usage.completion_tokens > 300;
      pending.delete(id);
      blocked ||= boundBroken;
      onEvent({ kind: "settled", id, usage: { usd: usage.cost, input: usage.prompt_tokens, output: usage.completion_tokens }, state: snapshot() });
      if (boundBroken) fail("provider_bound_exceeded");
      return { usd: usage.cost, input: usage.prompt_tokens, output: usage.completion_tokens };
    },
    unresolved(id) {
      if (!pending.has(id)) return;
      blocked = true;
      onEvent({ kind: "unresolved", id, reason: "transport_or_response_unknown", state: snapshot() });
    },
  };
}

function reply(res, text, id) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id, object: "chat.completion.chunk", created: 0, model: "gpt-4.1-mini" };
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  res.end("data: [DONE]\n\n");
}

/** One parent-owned endpoint; dry mode has no outbound client or credential. */
export async function startRecordingProxy({ mode = "dry", apiKey, ledger, ruleText, dryResponse = '{"accept":true,"tier":"fast"}', fetchImpl = globalThis.fetch, onReceipt = () => {} } = {}) {
  if (!["dry", "live"].includes(mode)) fail("invalid_proxy_mode");
  if (mode === "dry" && (apiKey || ledger)) fail("dry_proxy_credentials_forbidden");
  if (mode === "live" && (!apiKey || !ledger)) fail("live_budget_or_credential_missing");
  if (typeof ruleText !== "string" || !ruleText.trim()) fail("rule_missing");
  const rows = [];
  let slot = null;
  let poisoned = false;
  let inFlight = false;
  const handlers = new Set();
  const controllers = new Set();
  async function handle(req, res) {
    let row = null;
    let reserved = false;
    let boundSlot = null;
    let controller = null;
    let deadlineTimer = null;
    const disconnected = () => {
      if (!res.writableEnded) controller?.abort(new Error("client_disconnected"));
    };
    res.on("close", disconnected);
    try {
      if (poisoned) fail("proxy_stopped");
      if (!slot) fail("no_active_slot");
      if (req.method === "GET" && req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ object: "list", data: [{ id: "gpt-4.1-mini", object: "model", owned_by: "local", context_window: 1000000, max_output_tokens: 300 }] }));
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") fail("unexpected_endpoint");
      const auth = Buffer.from(req.headers.authorization ?? "");
      const expected = Buffer.from(`Bearer ${slot.token}`);
      if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) fail("unauthorized");
      if (req.headers.cookie) fail("cookie_forbidden");
      if (slot.used) fail("unexpected_continuation");
      slot.used = true;
      boundSlot = slot;
      inFlight = true;
      const chunks = [];
      let bytes = 0;
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > 32768) fail("body_too_large");
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks).toString("utf8");
      const body = JSON.parse(raw);
      row = { slotId: boundSlot.id, mode, route: req.url, fullRequestDigest: hash(raw), requestBytes: bytes, status: "received" };
      row.declaredOutputLimit = body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens ?? null;
      rows.push(row);
      const normalized = normalizeRequest(body, req.url);
      row.ruleOccurrencesByRole = normalized.messages.map((message) => ({ role: message.role, count: message.content.split(ruleText.trim()).length - 1 }));

      const system = normalized.messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => m.content).join("\n");
      const count = system.split(ruleText.trim()).length - 1;
      if (count !== (boundSlot.arm === "B2" ? 1 : 0)) fail("child_harness_not_loaded");
      row.inputUpperBound = normalized.inputUpperBound;
      row.ruleContentDigest = hash(ruleText);
      row.loaderSegmentDigest = count === 1 ? hash(ruleText.trim()) : null;
      row.rulePresent = count === 1;
      let text = dryResponse;
      if (mode === "live") {
        if (Date.now() >= boundSlot.deadlineAt || res.destroyed) fail("execution_deadline_exceeded");
        ledger.reserve(boundSlot.id);
        reserved = true;
        controller = new AbortController();
        controllers.add(controller);
        const now = Date.now();
        const expiresAt = Math.min(now + 25000, boundSlot.deadlineAt);
        deadlineTimer = setTimeout(() => controller.abort(new Error(expiresAt === boundSlot.deadlineAt ? "execution_deadline_exceeded" : "upstream_timeout")), Math.max(0, expiresAt - now));
        const response = await fetchImpl(UPSTREAM, {
          method: "POST", redirect: "error", signal: controller.signal,
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify({ model: MODEL, messages: normalized.messages, max_tokens: 300, temperature: 0, stream: false, provider: { order: ["OpenAI"], allow_fallbacks: false } }),
        });
        if (!response.ok) fail("upstream_http_error");
        const responseChunks = [];
        let responseBytes = 0;
        for await (const chunk of response.body) {
          responseBytes += chunk.length;
          if (responseBytes > 65536) fail("upstream_response_too_large");
          responseChunks.push(chunk);
        }
        const data = JSON.parse(Buffer.concat(responseChunks).toString("utf8"));
        row.usage = ledger.settle(boundSlot.id, data.usage);
        reserved = false;
        if (typeof data.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id) || data.model !== MODEL || data.provider !== "OpenAI") fail("upstream_identity_mismatch");
        row.providerRequestId = data.id;
        row.provider = data.provider;
        row.model = data.model;
        const choice = data.choices?.[0];
        if (choice?.message?.tool_calls || choice?.finish_reason !== "stop" || typeof choice?.message?.content !== "string") fail("invalid_upstream_output");
        text = choice.message.content;
        if (Buffer.byteLength(text) > 8192) fail("output_too_large");
      }
      row.status = "ok";
      row.outputDigest = hash(text);
      // Only the public model result is returned to the caller. No request text is retained.
      row.output = text;
      onReceipt({ ...row });
      reply(res, text, boundSlot.id);
    } catch (error) {
      poisoned = true;
      if (reserved && boundSlot) ledger.unresolved(boundSlot.id);
      if (controller?.signal.aborted) error = controller.signal.reason;
      const code = error instanceof SyntaxError ? "invalid_json" : /^[a-z_]{1,64}$/.test(error.message) ? error.message : "proxy_failure";
      if (row) { row.status = "error"; row.error = code; onReceipt({ ...row }); }
      else { const rejected = { slotId: slot?.id ?? null, mode, method: req.method, route: req.url?.split("?")[0].slice(0,80), status: "error", error: code }; rows.push(rejected); onReceipt(rejected); }
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: code } }));
    } finally {
      clearTimeout(deadlineTimer);
      if (controller) controllers.delete(controller);
      res.off("close", disconnected);
      if (boundSlot) inFlight = false;
    }
  }
  const server = http.createServer((req, res) => {
    const work = handle(req, res).catch(() => {
      // A failed durable receipt write is terminal, never a successful request.
      poisoned = true;
      res.destroy();
    });
    handlers.add(work);
    void work.finally(() => handlers.delete(work));
  });
  server.requestTimeout = 30000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    host: `127.0.0.1:${server.address().port}`,
    rows,
    armSlot(id, arm, deadlineAt = Date.now() + 30000) {
      if (poisoned || !["B0", "B1", "B2"].includes(arm)) fail("proxy_stopped");
      if (inFlight) fail("previous_slot_in_flight");
      if (!Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) fail("execution_deadline_exceeded");
      if (slot && !slot.used) fail("previous_slot_unconsumed");
      slot = { id, arm, deadlineAt, token: randomBytes(24).toString("hex"), used: false };
      return slot.token;
    },
    async close() {
      poisoned = true;
      for (const controller of controllers) controller.abort(new Error("proxy_closed"));
      server.closeAllConnections();
      await Promise.all([new Promise((resolve) => server.close(resolve)), ...handlers]);
    },
  };
}
