import semanticSpec from "../semantic.openapi.json";
import { collectAuthorityWindow, normalizeTarget, validateSemanticEnvelope, type SemanticEnvelope } from "./alignment";

// The consumer's wire constants and prompt come from the OpenAPI source, not
// the tier advisor config. No alternate provider, endpoint, model or key exists.
const semanticOperation = semanticSpec.paths["/v1/decisions"].post;
const semanticRequest = semanticOperation.requestBody.content["application/json"].schema.properties;
const semanticQuestion = semanticRequest.questions.properties.alignment.properties;
export const SEMANTIC_ENDPOINT = `${semanticSpec.servers[0].url}/v1/decisions`;
export const SEMANTIC_MODEL = semanticRequest.model.const;
export const SEMANTIC_TIMEOUT_MS = semanticOperation["x-timeout-ms"];
export const SEMANTIC_RETRIES = semanticOperation["x-retries"];
export const SEMANTIC_LABELS = Object.keys(semanticQuestion.criteria.const);
export type SemanticLabel = keyof typeof semanticQuestion.criteria.const;
export type SemanticNoDecisionReason =
	| "outbound_suppressed"
	| "unconfigured"
	| "invalid_input"
	| "timeout"
	| "provider_error"
	| "http_error"
	| "response_cap"
	| "invalid_response"
	| "precision_anomaly";

export type SemanticAdvice =
	| { status: "decision"; choice: SemanticLabel; confidence: number; probabilities: Record<string, number>; outbound: true }
	| { status: "no_decision"; reason: SemanticNoDecisionReason; outbound: boolean; envelope?: SemanticEnvelope };

export type SemanticInput = { branchEntries: unknown; targetPaths: readonly string[] | null };
type SemanticEnv = Record<string, string | undefined>;
type SemanticFetch = (url: string, init: RequestInit) => Promise<Response>;

function semanticNoDecision(reason: SemanticNoDecisionReason, outbound = false): SemanticAdvice {
	return { status: "no_decision", reason, outbound };
}

/** Only this literal process opt-in permits reading authority for a request. */
export function semanticOutboundEnabled(env: SemanticEnv = process.env): boolean {
	return env.JEV_ALIGNMENT_SEND_AUTHORITY_TEXT === "true";
}

/** Build the complete bounded wire request, never silently slicing authority. */
export function semanticRequestBody(input: SemanticInput): string | null {
	const window = collectAuthorityWindow(input.branchEntries);
	if (!window.entries.length || window.authorityTruncated || window.textTruncated) return null;
	const actionSchema = semanticRequest.state.properties.action.properties;
	if (!Array.isArray(input.targetPaths) || input.targetPaths.length < actionSchema.targetPaths.minItems || input.targetPaths.length > actionSchema.targetPaths.maxItems) return null;
	if (input.targetPaths.some(target => typeof target !== "string" || !target || normalizeTarget(target) !== target)) return null;
	const body = JSON.stringify({
		model: SEMANTIC_MODEL,
		state: { userEntries: window.entries.map(entry => entry.text), action: { actionClass: actionSchema.actionClass.const, targetPaths: [...input.targetPaths] } },
		questions: { alignment: { type: semanticQuestion.type.const, instructions: semanticQuestion.instructions.const, criteria: semanticQuestion.criteria.const } },
	});
	return Buffer.byteLength(body, "utf8") <= semanticOperation["x-max-request-bytes"] ? body : null;
}

/** Raw confidence and probabilities are never clamped, rounded or normalised. */
export function parseSemanticAdvice(value: unknown): SemanticAdvice {
	const record = (item: unknown): Record<string, unknown> | null => typeof item === "object" && item !== null && !Array.isArray(item) ? item as Record<string, unknown> : null;
	const answer = record(record(record(value)?.answers)?.alignment);
	if (!answer || (answer.type !== undefined && answer.type !== semanticQuestion.type.const) || !SEMANTIC_LABELS.includes(answer.choice as string)) return semanticNoDecision("invalid_response", true);
	const envelope = validateSemanticEnvelope({ sendAuthorityText: true, labels: SEMANTIC_LABELS, confidence: answer.confidence, probabilities: answer.probabilities });
	if (envelope.status !== "ok" || envelope.confidence === null || envelope.probabilities === null) {
		return { status: "no_decision", reason: envelope.status === "precision_anomaly" ? "precision_anomaly" : "invalid_response", outbound: true, envelope };
	}
	return { status: "decision", choice: answer.choice as SemanticLabel, confidence: envelope.confidence, probabilities: envelope.probabilities, outbound: true };
}

/** One request, including response consumption, has an 8s deadline. No retry. */
export async function askSemanticAdvice(input: SemanticInput, env: SemanticEnv = process.env, fetcher: SemanticFetch = (url, init) => fetch(url, init)): Promise<SemanticAdvice> {
	// Check the opt-in BEFORE the credential, branch facade, serialization or fetch.
	let key: string | undefined;
	try {
		if (!semanticOutboundEnabled(env)) return semanticNoDecision("outbound_suppressed");
		key = env[semanticOperation["x-credential-env"]]?.trim();
	} catch { return semanticNoDecision("unconfigured"); }
	if (!key) return semanticNoDecision("unconfigured");
	let body: string | null;
	try { body = semanticRequestBody(input); } catch { return semanticNoDecision("invalid_input"); }
	if (body === null) return semanticNoDecision("invalid_input");
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let outbound = false;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const timeout = new Promise<SemanticAdvice>(resolve => {
		timer = setTimeout(() => {
			controller.abort();
			resolve(semanticNoDecision("timeout", outbound));
		}, SEMANTIC_TIMEOUT_MS);
	});
	const request = async (): Promise<SemanticAdvice> => {
		try {
			outbound = true;
			const response = await fetcher(SEMANTIC_ENDPOINT, {
				method: "POST", redirect: "error", signal: controller.signal,
				headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body,
			});
			if (controller.signal.aborted) {
				try { void response.body?.cancel().catch(() => {}); } catch {}
				return semanticNoDecision("timeout", true);
			}
			if (!response.ok) return semanticNoDecision("http_error", true);
			reader = response.body?.getReader();
			if (!reader) return semanticNoDecision("invalid_response", true);
			const chunks: Uint8Array[] = [];
			let bytes = 0;
			while (true) {
				const chunk = await reader.read();
				if (controller.signal.aborted) return semanticNoDecision("timeout", true);
				if (chunk.done) break;
				bytes += chunk.value.byteLength;
				if (bytes > semanticOperation["x-max-response-bytes"]) return semanticNoDecision("response_cap", true);
				chunks.push(chunk.value);
			}
			let value: unknown;
			try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return semanticNoDecision("invalid_response", true); }
			return parseSemanticAdvice(value);
		} catch {
			return semanticNoDecision(controller.signal.aborted ? "timeout" : "provider_error", outbound);
		} finally {
			// Cancellation must not hold up the advice deadline either.
			try { if (reader) void reader.cancel().catch(() => {}); } catch {}
		}
	};
	try { return await Promise.race([request(), timeout]); }
	finally {
		clearTimeout(timer);
		controller.abort();
		try { if (reader) void reader.cancel().catch(() => {}); } catch {}
	}
}
