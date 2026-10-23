/**
 * Shared contract for decision-endpoint calls.
 *
 * Every plugin that asks a decision model for a typed answer records the same
 * facts here: which provider and exact model id it may call, which endpoint is
 * allowed, which environment variable carries the credential, how confidence is
 * produced, and which answers mean "no decision" rather than a low score.
 *
 * The table is a record of verified provider facts, not a routing policy. A
 * candidate entry is not integrated anywhere until a consumer names it and its
 * envelope is verified against the provider; an unknown mapping is unavailable,
 * never an alias of another model.
 */

export type DecisionProviderStatus = "baseline" | "candidate_unverified";

export type DecisionProvider = {
	/** Stable contract id: `<vendor>/<model>` exactly as the provider names it. */
	id: string;
	provider: string;
	/** Exact model id sent in the request body. */
	model: string;
	endpoint: string;
	/** Credential environment variables, highest precedence first. */
	authEnv: readonly string[];
	status: DecisionProviderStatus;
	/** Published context window, kept beside the id and never appended to it. */
	contextTokens?: number;
	/** Consumers and limits recorded for this provider. */
	note: string;
};

export const DECISION_PROVIDERS: readonly DecisionProvider[] = [
	{
		id: "openrouter/typesafe/jev-1.13",
		provider: "openrouter",
		model: "typesafe/jev-1.13",
		endpoint: "https://openrouter.ai/api/alpha/decisions",
		authEnv: ["JEV_ADVISOR_API_KEY", "OPENROUTER_API_KEY"],
		status: "baseline",
		note: "Current advisor tier/check and verification adequacy baseline. OpenRouter's public catalog lists no per-token price for this alpha route, so no cost ceiling can be derived from it.",
	},
	{
		id: "opengateway/sionic-ai/jev-omni",
		provider: "opengateway",
		model: "sionic-ai/jev-omni",
		endpoint: "https://apis.opengateway.ai/v1/decisions",
		authEnv: ["OPEN_GATEWAY_API_KEY", "OPENAI_API_KEY"],
		status: "candidate_unverified",
		contextTokens: 32768,
		note: "Catalog candidate (openai-compatible decisions endpoint, input text/image/audio/video). Envelope and confidence semantics are not yet verified; unusable until a consumer verifies them.",
	},
	{
		id: "opengateway/sionic-ai/decider-4b",
		provider: "opengateway",
		model: "sionic-ai/decider-4b",
		endpoint: "https://apis.opengateway.ai/v1/decisions",
		authEnv: ["OPEN_GATEWAY_API_KEY", "OPENAI_API_KEY"],
		status: "candidate_unverified",
		contextTokens: 65536,
		note: "Catalog candidate (openai-compatible decisions endpoint, text input). Envelope and confidence semantics are not yet verified.",
	},
];

const DECISION_ORIGINS = new Set(["https://openrouter.ai", "https://apis.opengateway.ai", "https://api.typesafe.ai"]);
const DECISION_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/**
 * HTTPS origins allowed for a decision call, plus loopback for local fixtures.
 * A consumer may narrow the set to the providers it actually implements; it
 * never widens beyond the recorded contract.
 */
export function isAllowedDecisionEndpoint(endpoint: string, options: { origins?: readonly string[] } = {}): boolean {
	const origins = options.origins === undefined ? DECISION_ORIGINS : new Set(options.origins);
	try {
		const url = new URL(endpoint);
		if (url.username || url.password) return false;
		if (url.protocol === "https:") return origins.has(url.origin);
		if (url.protocol === "http:") return DECISION_LOOPBACK_HOSTS.has(url.hostname);
		return false;
	} catch {
		return false;
	}
}

export function decisionProvider(id: string): DecisionProvider | undefined {
	return DECISION_PROVIDERS.find(entry => entry.id === id);
}

/**
 * `provider_choice` means the provider itself reported the answer choice;
 * `self_reported` means the model stated a confidence in prose. They are never
 * merged into one comparable probability.
 */
export const CONFIDENCE_KINDS = ["provider_choice", "self_reported"] as const;
export type DecisionConfidenceKind = (typeof CONFIDENCE_KINDS)[number];

/** Deterministic outcomes that are not a decision, and never a scoring signal. */
export const NO_DECISION_REASONS = [
	"off",
	"missing_key",
	"missing_context",
	"insufficient_evidence",
	"invalid_context",
	"invalid_facts",
	"invalid_answer",
	"request_cap",
	"response_cap",
	"redirect",
	"timeout",
	"transport",
	"http_auth",
	"http_credit",
	"http_rate",
	"http_server",
	"http_error",
] as const;
export type DecisionNoDecisionReason = (typeof NO_DECISION_REASONS)[number];

export type ProbabilityCheck =
	| { ok: true; probabilities: Record<string, number> }
	| { ok: false; reason: "not_object" | "unknown_label" | "out_of_range" | "missing_label" | "sum" };

/**
 * Validate a choice distribution. `complete` requires every label exactly once
 * and a normalised sum; without it, a partial map is accepted as long as each
 * value is a finite probability in [0, 1] and a supplied subset sums to <= 1.
 */
export function validateProbabilityMap(labels: readonly string[], value: unknown, options: { complete?: boolean } = {}): ProbabilityCheck {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false, reason: "not_object" };
	const entries = Object.entries(value as Record<string, unknown>);
	if (entries.length === 0) return { ok: false, reason: "missing_label" };
	const probabilities: Record<string, number> = {};
	for (const [label, raw] of entries) {
		if (!labels.includes(label)) return { ok: false, reason: "unknown_label" };
		if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) return { ok: false, reason: "out_of_range" };
		probabilities[label] = raw;
	}
	if (options.complete && labels.some(label => probabilities[label] === undefined)) return { ok: false, reason: "missing_label" };
	const total = Object.values(probabilities).reduce((sum, number) => sum + number, 0);
	if (options.complete ? Math.abs(total - 1) > 1e-6 : total > 1 + 1e-6) return { ok: false, reason: "sum" };
	return { ok: true, probabilities };
}
