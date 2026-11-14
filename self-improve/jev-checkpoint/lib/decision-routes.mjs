/**
 * Decision-route allowlists for the JJO-2329 checkpoint experiment.
 *
 * Two surfaces exist and never share an entry table:
 * - TRIAL_DECISION_ROUTES: the only models a trial arm (checkpoint plugin →
 *   parent proxy) may reach. OpenGateway `/v1/decisions` with jev-omni
 *   (primary) and decider-4b (aux), per the owner scope-change of 2026-11-14.
 * - J0_JUDGE_ROUTES: the judge golden set additionally scores typesafe/jev-1.14
 *   on its OpenRouter route as a judge baseline. It is never a trial arm.
 *
 * `resolveDecisionRoute` is the single gate in front of every outbound decision
 * call: an id outside the surface's table is refused before any transport is
 * touched. Entries mirror `shared/lib/decision-contract.ts` (id, model,
 * endpoint, authEnv); a parity test binds them.
 */

export const OPENGATEWAY_DECISIONS = "https://apis.opengateway.ai/v1/decisions";
export const OPENROUTER_DECISIONS = "https://openrouter.ai/api/alpha/decisions";
export const OPENGATEWAY_CHAT = "https://apis.opengateway.ai/v1/chat/completions";
export const OPENGATEWAY_MODELS = "https://apis.opengateway.ai/v1/models";
export const CHAT_MODEL = "deepseek/deepseek-v4.1-flash-eco";
export const CHAT_PROVIDER = "sionic-ai";

/** Approved per-token chat prices (owner-approved m1 constants). */
export const CHAT_PRICE = Object.freeze({ inputPerToken: 0.00000003, outputPerToken: 0.00000012 });

const route = (entry) => Object.freeze({ ...entry, authEnv: Object.freeze([...entry.authEnv]) });

const JEV_OMNI = route({
	id: "opengateway/sionic-ai/jev-omni",
	model: "sionic-ai/jev-omni",
	endpoint: OPENGATEWAY_DECISIONS,
	authEnv: ["OPENGATEWAY_API_KEY"],
	keySource: "opengateway_key_file",
	role: "primary",
	/** Catalog list price on 2026-11-14 (USD per input token); output is free. */
	approvedListInputPerToken: 0.126e-6,
});

const DECIDER_4B = route({
	id: "opengateway/sionic-ai/decider-4b",
	model: "sionic-ai/decider-4b",
	endpoint: OPENGATEWAY_DECISIONS,
	authEnv: ["OPENGATEWAY_API_KEY"],
	keySource: "opengateway_key_file",
	role: "aux",
	approvedListInputPerToken: 0.042e-6,
});

const JEV_1_14 = route({
	id: "openrouter/typesafe/jev-1.14",
	model: "typesafe/jev-1.14",
	endpoint: OPENROUTER_DECISIONS,
	authEnv: ["JEV_ADVISOR_API_KEY", "OPENROUTER_API_KEY"],
	keySource: "openrouter_env",
	role: "judge_baseline",
	approvedListInputPerToken: 0.042e-6,
});

export const TRIAL_DECISION_ROUTES = Object.freeze({
	[JEV_OMNI.model]: JEV_OMNI,
	[DECIDER_4B.model]: DECIDER_4B,
});

export const J0_JUDGE_ROUTES = Object.freeze({
	[JEV_OMNI.model]: JEV_OMNI,
	[DECIDER_4B.model]: DECIDER_4B,
	[JEV_1_14.model]: JEV_1_14,
});

export const SURFACES = Object.freeze({ trial: TRIAL_DECISION_ROUTES, j0: J0_JUDGE_ROUTES });

/** The per-mode model sets a checkpoint arm may request (plugin and proxy both enforce). */
export const MODE_MODELS = Object.freeze({
	periodic: Object.freeze([JEV_OMNI.model]),
	error: Object.freeze([JEV_OMNI.model]),
	ensemble: Object.freeze([JEV_OMNI.model, DECIDER_4B.model]),
	frozen: null, // resolved from the manifest's frozen winner before S3
});

/**
 * Resolve one model id on one surface. Pure and synchronous: callers MUST call
 * this before constructing any request, so a refusal never reaches transport.
 */
export function resolveDecisionRoute(model, surface) {
	const table = SURFACES[surface];
	if (!table) return { ok: false, reason: "unknown_surface" };
	if (typeof model !== "string" || !Object.hasOwn(table, model)) return { ok: false, reason: "route_not_allowed" };
	return { ok: true, route: table[model] };
}

/** Origins a surface may contact; narrower than the shared contract's set. */
export function surfaceOrigins(surface) {
	const table = SURFACES[surface];
	if (!table) return [];
	return [...new Set(Object.values(table).map((entry) => new URL(entry.endpoint).origin))].sort();
}
