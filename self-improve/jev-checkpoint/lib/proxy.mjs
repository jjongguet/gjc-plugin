/**
 * Parent-owned loopback proxy: the ONLY network path a cell has, and the only
 * holder of provider keys. Children authenticate with a per-cell placeholder
 * token; the cell id in the path attributes every row.
 *
 *   GET  /c/<cell>/v1/models
 *   POST /c/<cell>/v1/chat/completions   chat turn (scripted | live, mode B)
 *   POST /c/<cell>/checkpoint            checkpoint invocation from the plugin
 *
 * Live chat uses "mode B": the child's streaming request is forwarded with
 * `stream:false` and `usage:{include:true}` (the only body changes), and the
 * JSON answer is re-emitted to the child as SSE. Every request reserves before
 * transport (lib/accounting.mjs); a global stop refuses everything with zero
 * upstream calls.
 */
import http from "node:http";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { CHAT_MODEL, CHAT_PRICE, CHAT_PROVIDER, MODE_MODELS, OPENGATEWAY_CHAT } from "./decision-routes.mjs";
import { createDecisionDispatcher } from "./decision-client.mjs";
import { combineVoters } from "./ensemble.mjs";
import { normalizeBody } from "./normalize.mjs";

export const CHAT_BODY_LIMIT = 4 * 1024 * 1024;
export const CHECKPOINT_BODY_LIMIT = 16 * 1024;
export const CHAT_TIMEOUT_MS = 120000;
export const INVOCATION_CAPS = Object.freeze({ periodic: 6, error: 2, ensemble: 6 });
export const ACTING_THRESHOLD = 0.6;
const INTERVENE = new Set(["off_track", "yes"]);
const GUIDANCE = Object.freeze({
	off_track: "최근 행동이 목표·범위에서 벗어났을 수 있다. 목표를 다시 읽고, 이미 얻은 답을 반복 확인하거나 목표에 없는 대상을 건드리지 말라.",
	yes: "다음 단계가 방금 실패한 가정을 반복할 수 있다. 실패 출력에서 원인을 먼저 확인하고 다른 원인을 시험하라.",
});

const sha = (text) => createHash("sha256").update(text).digest("hex");
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

export function adviceFor({ label, signal }) {
	if (!INTERVENE.has(label)) return null;
	return `[jev-checkpoint] label=${label} signal=${Number(signal ?? 0).toFixed(2)} — ${GUIDANCE[label]}`.slice(0, 300);
}

async function readBody(req, limit) {
	const chunks = [];
	let bytes = 0;
	for await (const chunk of req) {
		bytes += chunk.length;
		if (bytes > limit) fail("body_too_large");
		chunks.push(chunk);
	}
	return Buffer.concat(chunks).toString("utf8");
}

function sendJson(res, status, value) {
	if (res.headersSent) return res.end();
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(value));
}

/** Re-emit one non-streaming chat answer as OpenAI-style SSE chunks. */
function sendSse(res, { id, message, finishReason, usage }) {
	res.writeHead(200, { "content-type": "text/event-stream" });
	const base = { id, object: "chat.completion.chunk", created: 0, model: CHAT_MODEL };
	const delta = { role: "assistant" };
	if (typeof message.content === "string" && message.content) delta.content = message.content;
	if (Array.isArray(message.tool_calls) && message.tool_calls.length) {
		delta.tool_calls = message.tool_calls.map((call, index) => ({ index, id: call.id, type: "function", function: { name: call.function?.name, arguments: call.function?.arguments ?? "{}" } }));
	}
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
	res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finishReason }], usage })}\n\n`);
	res.end("data: [DONE]\n\n");
}

export async function startProxy({ mode, ledger, keys = {}, fetchImpl = globalThis.fetch, catalog = {}, questionConfig, scriptedChat = null, scriptedDecision = null, chatMaxTokens = 4096, onRow = () => {} }) {
	if (!["scripted", "live"].includes(mode)) fail("invalid_proxy_mode");
	if (!ledger) fail("ledger_required");
	if (mode === "scripted" && (keys.opengateway || keys.openrouter)) fail("scripted_credentials_forbidden");
	if (mode === "scripted" && (typeof scriptedChat !== "function" || typeof scriptedDecision !== "function")) fail("scripted_responders_required");
	if (mode === "live" && !keys.opengateway) fail("live_key_missing");
	if (!questionConfig?.goal_state || !questionConfig?.error_repeat) fail("question_config_required");
	const rows = [];
	const record = (row) => { rows.push(row); onRow(row); };
	const chatEntry = catalog?.[CHAT_MODEL];
	const positive = (...values) => values.filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
	// Reserve at the highest known chat price (approved, catalog list, observed); compute at the observed price.
	const chatReserve = { input: Math.max(...positive(CHAT_PRICE.inputPerToken, chatEntry?.listInputPricePerToken, chatEntry?.observedInputPricePerToken)), output: Math.max(...positive(CHAT_PRICE.outputPerToken, chatEntry?.listOutputPricePerToken, chatEntry?.observedOutputPricePerToken)) };
	const chatCompute = { input: positive(chatEntry?.observedInputPricePerToken)[0] ?? CHAT_PRICE.inputPerToken, output: positive(chatEntry?.observedOutputPricePerToken)[0] ?? CHAT_PRICE.outputPerToken };
	const cells = new Map();
	const controllers = new Set();
	let upstreamCalls = 0;
	const dispatcher = createDecisionDispatcher({
		surface: "trial", ledger, catalog, fetchImpl,
		keys: mode === "live" ? { opengateway: keys.opengateway } : {},
		scripted: mode === "scripted" ? scriptedDecision : null,
	});

	async function chat(cell, req, res) {
		const raw = await readBody(req, CHAT_BODY_LIMIT);
		const body = JSON.parse(raw);
		if (body.model !== CHAT_MODEL) fail("model_mismatch");
		cell.turn += 1;
		const requestBytes = Buffer.byteLength(raw, "utf8");
		const maxTokens = Number.isSafeInteger(body.max_tokens) ? body.max_tokens : Number.isSafeInteger(body.max_completion_tokens) ? body.max_completion_tokens : chatMaxTokens;
		const reserveUsd = requestBytes * chatReserve.input + maxTokens * chatReserve.output;
		const requestId = randomUUID();
		const row = { kind: "chat", cellId: cell.id, requestId, turn: cell.turn, requestBytes, requestDigest: sha(raw), normalizedDigest: sha(normalizeBody(body, cell.normalization)), toolNames: (body.tools ?? []).map((tool) => tool.function?.name ?? tool.name).filter(Boolean).sort(), status: "received" };
		try {
			ledger.reserve({ id: requestId, cellId: cell.id, kind: "chat", reserveUsd, turn: true });
		} catch (error) {
			record({ ...row, status: "refused", error: error.message, costUsd: 0 });
			return sendJson(res, error.message === "budget_stop" ? 503 : 429, { error: { message: error.message } });
		}
		const started = Date.now();
		let answer;
		try {
			if (mode === "scripted") {
				answer = await scriptedChat({ cellId: cell.id, body, turn: cell.turn, meta: cell.meta });
			} else {
				const upstream = { ...body, stream: false, usage: { include: true } };
				delete upstream.stream_options;
				const controller = new AbortController();
				controllers.add(controller);
				cell.controllers.add(controller);
				const timer = setTimeout(() => controller.abort(new Error("upstream_timeout")), CHAT_TIMEOUT_MS);
				try {
					upstreamCalls += 1;
					const response = await fetchImpl(OPENGATEWAY_CHAT, { method: "POST", redirect: "error", signal: controller.signal, headers: { authorization: `Bearer ${keys.opengateway}`, "content-type": "application/json" }, body: JSON.stringify(upstream) });
					const text = await response.text();
					if (!response.ok) fail(`upstream_http_${response.status}`);
					const data = JSON.parse(text);
					if (data.model !== CHAT_MODEL || (data.provider !== undefined && data.provider !== CHAT_PROVIDER)) fail("upstream_identity_mismatch");
					const choice = data.choices?.[0];
					if (!choice?.message) fail("invalid_upstream_output");
					answer = { id: typeof data.id === "string" ? data.id : requestId, message: choice.message, finishReason: choice.finish_reason ?? "stop", usage: data.usage ?? null };
				} finally {
					clearTimeout(timer);
					controllers.delete(controller);
					cell.controllers.delete(controller);
				}
			}
		} catch (error) {
			const settled = ledger.unresolved(requestId);
			record({ ...row, status: "error", error: error.code ?? error.message?.slice(0, 64) ?? "proxy_failure", costUsd: settled.usd, basis: settled.basis, latencyMs: Date.now() - started });
			return sendJson(res, 502, { error: { message: "upstream_failure" } });
		}
		const usage = answer.usage ?? {};
		const inputTokens = Number.isSafeInteger(usage.prompt_tokens) ? usage.prompt_tokens : null;
		const outputTokens = Number.isSafeInteger(usage.completion_tokens) ? usage.completion_tokens : null;
		const settled = ledger.settle(requestId, {
			billedUsd: Number.isFinite(usage.cost) ? usage.cost : undefined,
			computedUsd: inputTokens !== null && outputTokens !== null ? inputTokens * chatCompute.input + outputTokens * chatCompute.output : undefined,
		});
		record({ ...row, status: "ok", inputTokens, outputTokens, costUsd: settled.usd, basis: settled.basis, latencyMs: Date.now() - started, finishReason: answer.finishReason, toolCalls: (answer.message.tool_calls ?? []).length });
		sendSse(res, { id: answer.id ?? requestId, message: answer.message, finishReason: answer.finishReason, usage: { prompt_tokens: inputTokens ?? 0, completion_tokens: outputTokens ?? 0, total_tokens: (inputTokens ?? 0) + (outputTokens ?? 0) } });
	}

	async function checkpoint(cell, req, res) {
		const raw = await readBody(req, CHECKPOINT_BODY_LIMIT);
		const body = JSON.parse(raw);
		const invocationId = randomUUID();
		const row = { kind: "checkpoint", cellId: cell.id, invocationId, mode: body.mode, family: body.family, trigger: body.trigger, callIndex: body.callIndex, goalSource: body.goalSource ?? null, stateBytes: Buffer.byteLength(String(body.state ?? ""), "utf8") };
		const refuse = (reason, status = 400) => { record({ ...row, branch: "abstain", label: null, signal: null, reason, voters: [], costUsd: 0, latencyMs: 0, transport: false }); sendJson(res, status, { branch: "abstain", label: null, signal: null, reason, advice: null }); };
		if (cell.checkpoint.mode === "off") return refuse("checkpoint_off", 403);
		if (body.mode !== cell.checkpoint.mode) return refuse("mode_mismatch", 403);
		const expectedModels = MODE_MODELS[cell.checkpoint.mode];
		if (!Array.isArray(body.models) || body.models.length !== expectedModels.length || body.models.some((model, index) => model !== expectedModels[index])) return refuse("route_not_allowed", 403);
		const family = cell.checkpoint.trigger === "error" ? "error_repeat" : "goal_state";
		if (body.family !== family) return refuse("family_mismatch", 403);
		if (!Number.isSafeInteger(body.callIndex) || body.callIndex < 1) return refuse("invalid_request");
		if (cell.invocations >= INVOCATION_CAPS[cell.checkpoint.mode]) return refuse("request_cap", 429);
		cell.invocations += 1;
		const question = questionConfig[family];
		const ask = (model) => dispatcher.decide({ cellId: cell.id, invocationId, model, family, wordingId: question.wordingId, criteriaOrder: question.criteriaOrder, state: String(body.state ?? ""), threshold: ACTING_THRESHOLD, meta: { ...cell.meta, invocation: cell.invocations } });
		const started = Date.now();
		const voters = await Promise.all(expectedModels.map(ask));
		let decision;
		if (voters.length === 2) decision = combineVoters({ primary: voters[0], aux: voters[1], rule: questionConfig.ensembleRule ?? "primary_override" });
		else decision = voters[0].status === "decided" ? { branch: "single", label: voters[0].choice, signal: voters[0].confidence, reason: null } : { branch: "abstain", label: null, signal: null, reason: voters[0].status === "low_confidence" ? "low_confidence" : voters[0].reason };
		const advice = decision.label ? adviceFor(decision) : null;
		const slim = voters.map((voter) => ({ model: voter.model, status: voter.status, reason: voter.reason, choice: voter.choice ?? null, confidence: voter.confidence ?? null, confidenceKind: voter.confidenceKind ?? null, sumDeviation: voter.sumDeviation ?? null, unnormalizedAtSensitivity: voter.unnormalizedAtSensitivity ?? null, latencyMs: voter.latencyMs, costUsd: voter.costUsd, basis: voter.basis, transport: voter.transport }));
		record({ ...row, ...decision, voters: slim, costUsd: slim.reduce((sum, voter) => sum + (voter.costUsd ?? 0), 0), latencyMs: Date.now() - started, advice: advice ? sha(advice) : null, transport: slim.some((voter) => voter.transport) });
		sendJson(res, 200, { ...decision, advice });
	}

	/** Every request of a cell is tracked until its ledger settlement is written. */
	function track(cell, work) {
		cell.pending.add(work);
		return work.finally(() => cell.pending.delete(work));
	}

	async function handle(req, res) {
		const match = /^\/c\/([a-f0-9]{16,64})(\/v1\/models|\/v1\/chat\/completions|\/checkpoint)$/.exec((req.url ?? "").split("?")[0]);
		if (!match) return sendJson(res, 404, { error: { message: "unknown_route" } });
		const cell = cells.get(match[1]);
		if (!cell || cell.closed) return sendJson(res, 404, { error: { message: "unknown_cell" } });
		if (ledger.stopped) {
			record({ kind: "refused", cellId: cell.id, route: match[2], reason: "budget_stop" });
			return sendJson(res, 503, { error: { message: "budget_stop" } });
		}
		if (match[2] === "/v1/models") return sendJson(res, 200, { object: "list", data: [{ id: CHAT_MODEL, object: "model", owned_by: "jexp-proxy" }] });
		if (req.method !== "POST") return sendJson(res, 405, { error: { message: "method_not_allowed" } });
		if (match[2] === "/v1/chat/completions") {
			const auth = Buffer.from(req.headers.authorization ?? "");
			const expected = Buffer.from(`Bearer ${cell.token}`);
			if (auth.length !== expected.length || !timingSafeEqual(auth, expected)) return sendJson(res, 401, { error: { message: "unauthorized" } });
			return track(cell, chat(cell, req, res));
		}
		return track(cell, checkpoint(cell, req, res));
	}

	const server = http.createServer((req, res) => {
		handle(req, res).catch((error) => {
			record({ kind: "error", route: (req.url ?? "").slice(0, 80), error: error.code ?? (error instanceof SyntaxError ? "invalid_json" : "proxy_failure") });
			sendJson(res, 400, { error: { message: "proxy_failure" } });
		});
	});
	server.requestTimeout = CHAT_TIMEOUT_MS + 10000;
	await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
	const port = server.address().port;
	return {
		port,
		host: `127.0.0.1:${port}`,
		rows,
		get upstreamCalls() { return upstreamCalls + (mode === "live" ? dispatcher.transportCalls : 0); },
		get decisionTransportCalls() { return dispatcher.transportCalls; },
		registerCell({ cellId, token, checkpoint, usdCap, turnCap, normalization = {}, meta = {} }) {
			if (!/^[a-f0-9]{16,64}$/.test(cellId)) fail("invalid_cell_id");
			if (cells.has(cellId)) fail("duplicate_cell");
			if (!["off", "periodic", "error", "ensemble"].includes(checkpoint?.mode)) fail("invalid_checkpoint_mode");
			cells.set(cellId, { id: cellId, token, checkpoint, turn: 0, invocations: 0, closed: false, normalization, meta: Object.freeze({ ...meta }), pending: new Set(), controllers: new Set() });
			ledger.configureCell(cellId, { usdCap, turnCap });
			return { baseUrl: `http://127.0.0.1:${port}/c/${cellId}/v1`, checkpointUrl: `http://127.0.0.1:${port}/c/${cellId}/checkpoint` };
		},
		closeCell(cellId) { const cell = cells.get(cellId); if (cell) cell.closed = true; },
		/**
		 * Close a cell and wait until its in-flight requests are settled: running
		 * upstream chat calls are aborted (charged at their reservation, never zero)
		 * and decision calls finish within their own timeout, so the cell's rows are
		 * final before metrics are read.
		 */
		async drainCell(cellId) {
			const cell = cells.get(cellId);
			if (!cell) return;
			cell.closed = true;
			for (const controller of cell.controllers) controller.abort(new Error("cell_closed"));
			await Promise.allSettled([...cell.pending]);
		},
		async close() {
			for (const controller of controllers) controller.abort(new Error("proxy_closed"));
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
