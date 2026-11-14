/**
 * Classify one decision-endpoint response into a typed outcome.
 *
 * Status is one of:
 * - `decided`         valid envelope and signal ≥ threshold
 * - `low_confidence`  valid envelope and signal < threshold
 * - `no_decision`     no usable answer; `reason` says why
 *
 * `unnormalized_probabilities` is its own no-decision reason (owner instruction
 * 2026-11-14): a complete, in-range probability map whose sum misses 1 by more
 * than the primary tolerance. It never stops a stage and never invalidates a
 * table; its cost and latency are always accounted by the caller. The primary
 * tolerance equals `decision-ask:280` and `shared/lib/decision-contract.ts`
 * (|Σp−1| > 1e-6, inclusive bound plus a few ulps); 1e-3 (the jev-advisor
 * bound) is reported as a sensitivity flag only.
 */

export const PRIMARY_SUM_TOLERANCE = 1e-6 + Number.EPSILON * 4;
export const SENSITIVITY_SUM_TOLERANCE = 1e-3 + Number.EPSILON * 4;

export const NO_DECISION_REASONS = Object.freeze([
	"unnormalized_probabilities",
	"invalid_answer",
	"route_not_allowed",
	"request_cap",
	"invalid_request",
	"timeout",
	"transport",
	"http_auth",
	"http_credit",
	"http_rate",
	"http_server",
	"http_error",
	"budget_stop",
]);

export function httpReason(status) {
	if (status === 401 || status === 403) return "http_auth";
	if (status === 402) return "http_credit";
	if (status === 429) return "http_rate";
	if (status >= 500 && status <= 599) return "http_server";
	return "http_error";
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isProbability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

function noDecision(reason, extra = {}) {
	return { status: "no_decision", reason, choice: null, confidence: null, confidenceKind: null, margin: null, probabilities: null, sumDeviation: null, unnormalizedAtSensitivity: null, ...extra };
}

/**
 * @param {object} args
 * @param {unknown} args.payload       parsed JSON response body
 * @param {string}  args.questionName  `decision` (trial) or `check` (jev_check shape)
 * @param {string[]} args.labels       criteria labels in the order sent
 * @param {number}  args.threshold     acting threshold for the signal
 */
export function classifyDecision({ payload, questionName, labels, threshold }) {
	if (!Array.isArray(labels) || labels.length < 2 || labels.length > 3) throw new Error("invalid_labels");
	if (!(typeof threshold === "number" && threshold >= 0 && threshold <= 1)) throw new Error("invalid_threshold");
	if (!isRecord(payload) || !isRecord(payload.answers)) return noDecision("invalid_answer");
	const answer = payload.answers[questionName];
	if (!isRecord(answer) || answer.type !== "choice") return noDecision("invalid_answer");
	const { choice, probabilities } = answer;
	if (typeof choice !== "string" || !labels.includes(choice)) return noDecision("invalid_answer");
	if (!isRecord(probabilities)) return noDecision("invalid_answer");
	const keys = Object.keys(probabilities);
	if (keys.length !== labels.length || keys.some((key) => !labels.includes(key))) return noDecision("invalid_answer");
	if (labels.some((label) => !isProbability(probabilities[label]))) return noDecision("invalid_answer");
	const sum = labels.reduce((total, label) => total + probabilities[label], 0);
	const sumDeviation = Math.abs(sum - 1);
	const unnormalizedAtSensitivity = sumDeviation > SENSITIVITY_SUM_TOLERANCE;
	const copy = Object.fromEntries(labels.map((label) => [label, probabilities[label]]));
	if (sumDeviation > PRIMARY_SUM_TOLERANCE) {
		return noDecision("unnormalized_probabilities", { choice, probabilities: copy, sumDeviation, unnormalizedAtSensitivity });
	}
	const ranked = [...labels].sort((a, b) => probabilities[b] - probabilities[a]);
	const margin = probabilities[ranked[0]] - probabilities[ranked[1]];
	let confidence;
	let confidenceKind;
	if (answer.confidence !== undefined && answer.confidence !== null) {
		if (!isProbability(answer.confidence)) return noDecision("invalid_answer", { sumDeviation });
		confidence = answer.confidence;
		confidenceKind = "provider_confidence";
	} else {
		confidence = margin;
		confidenceKind = "margin";
	}
	const status = confidence >= threshold ? "decided" : "low_confidence";
	return { status, reason: null, choice, confidence, confidenceKind, margin, probabilities: copy, sumDeviation, unnormalizedAtSensitivity };
}
