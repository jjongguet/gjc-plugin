/**
 * The one decision dispatcher. Order per request (final D20):
 *   resolve route (allowlist) → build body → reserve → send → settle → classify.
 * A refused route or an invalid body never reaches the ledger or transport.
 * `scripted` replaces transport entirely (S0/S0b, tests); in scripted mode no
 * key may be supplied.
 */
import { randomUUID } from "node:crypto";
import { resolveDecisionRoute } from "./decision-routes.mjs";
import { buildDecisionBody } from "./questions.mjs";
import { classifyDecision, httpReason } from "./decision-outcome.mjs";

export const DECISION_TIMEOUT_MS = 6000;
export const RESERVE_OVERHEAD_TOKENS = 1024;
export const MAX_RESPONSE_BYTES = 65536;

/** Price used for reservation: the maximum of every known list/observed price. */
export function reservePricePerToken(route, catalog) {
	const entry = catalog?.[route.model];
	const candidates = [route.approvedListInputPerToken, entry?.listInputPricePerToken, entry?.observedInputPricePerToken].filter((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
	return Math.max(...candidates);
}

export function createDecisionDispatcher({ surface, keys = {}, fetchImpl = globalThis.fetch, ledger, catalog = {}, scripted = null, timeoutMs = DECISION_TIMEOUT_MS, onRow = () => {} }) {
	if (!ledger) throw new Error("ledger_required");
	if (scripted && (keys.opengateway || keys.openrouter)) throw new Error("scripted_credentials_forbidden");
	let transportCalls = 0;
	async function decide({ cellId, invocationId = null, model, family, wordingId, criteriaOrder, state, threshold, meta = null }) {
		const requestId = randomUUID();
		const base = { schema: "jexp.decision_outcome.v1", requestId, invocationId, cellId, surface, model, family, wordingId, criteriaOrder: criteriaOrder ?? null, threshold };
		const finish = (row) => { const full = { ...base, ...row }; onRow(full); return full; };
		const resolved = resolveDecisionRoute(model, surface);
		if (!resolved.ok) return finish({ status: "no_decision", reason: resolved.reason, route: null, latencyMs: 0, reserveUsd: 0, costUsd: 0, basis: null, transport: false });
		const { route } = resolved;
		let built;
		try {
			built = buildDecisionBody({ model, family, wordingId, criteriaOrder, state });
		} catch (error) {
			return finish({ status: "no_decision", reason: "invalid_request", detail: error.message, route: route.id, latencyMs: 0, reserveUsd: 0, costUsd: 0, basis: null, transport: false });
		}
		const key = route.keySource === "opengateway_key_file" ? keys.opengateway : keys.openrouter;
		if (!scripted && !key) return finish({ status: "no_decision", reason: "http_auth", detail: "missing_key", route: route.id, latencyMs: 0, reserveUsd: 0, costUsd: 0, basis: null, transport: false });
		const bytes = Buffer.byteLength(built.raw, "utf8");
		const price = reservePricePerToken(route, catalog);
		const reserveUsd = (bytes + RESERVE_OVERHEAD_TOKENS) * price;
		try {
			ledger.reserve({ id: requestId, cellId, kind: "decision", reserveUsd });
		} catch (error) {
			const reason = error.message === "budget_stop" ? "budget_stop" : error.message === "cell_cap" ? "request_cap" : "invalid_request";
			return finish({ status: "no_decision", reason, route: route.id, latencyMs: 0, reserveUsd: 0, costUsd: 0, basis: null, transport: false });
		}
		const started = Date.now();
		let status = 0;
		let payload = null;
		let transportReason = null;
		try {
			transportCalls += 1;
			if (scripted) {
				const reply = await scripted({ model, body: built.body, family, cellId, meta, invocationId });
				status = reply.status ?? 200;
				payload = reply.json ?? null;
			} else {
				const response = await fetchImpl(route.endpoint, {
					method: "POST",
					redirect: "error",
					signal: AbortSignal.timeout(timeoutMs),
					headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
					body: built.raw,
				});
				status = response.status;
				const text = await response.text();
				if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) transportReason = "invalid_answer";
				else if (response.ok) {
					try { payload = JSON.parse(text); } catch { transportReason = "invalid_answer"; }
				}
			}
		} catch (error) {
			transportReason = error?.name === "TimeoutError" || error?.name === "AbortError" ? "timeout" : "transport";
		}
		const latencyMs = Date.now() - started;
		if (!transportReason && (status < 200 || status > 299)) transportReason = httpReason(status);
		const usage = payload && typeof payload.usage === "object" ? payload.usage : null;
		const tokens = Number.isSafeInteger(usage?.prompt_tokens) ? usage.prompt_tokens : Number.isSafeInteger(usage?.input_tokens) ? usage.input_tokens : null;
		const observed = catalog?.[route.model]?.observedInputPricePerToken;
		const settled = transportReason && !payload
			? ledger.unresolved(requestId)
			: ledger.settle(requestId, {
				billedUsd: Number.isFinite(usage?.cost) ? usage.cost : undefined,
				observedUsd: tokens !== null && Number.isFinite(observed) ? tokens * observed : undefined,
				computedUsd: tokens !== null ? tokens * route.approvedListInputPerToken : undefined,
			});
		const accounting = { route: route.id, latencyMs, reserveUsd, costUsd: settled.usd, basis: settled.basis, inputTokens: tokens, httpStatus: status, transport: true, requestBytes: bytes };
		if (transportReason) return finish({ status: "no_decision", reason: transportReason, choice: null, confidence: null, probabilities: null, sumDeviation: null, ...accounting });
		const outcome = classifyDecision({ payload, questionName: built.questionName, labels: built.labels, threshold });
		return finish({ ...outcome, ...accounting });
	}
	return { decide, get transportCalls() { return transportCalls; } };
}
