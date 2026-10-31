import { describe, expect, test } from "bun:test";
import {
	CONFIDENCE_KINDS,
	DECISION_PROVIDERS,
	NO_DECISION_REASONS,
	decisionProvider,
	isAllowedDecisionEndpoint,
	validateProbabilityMap,
} from "../lib/decision-contract";

test("invalid_case_id is a deterministic no-decision reason, never a scoring signal", () => {
	expect(NO_DECISION_REASONS).toContain("invalid_case_id");
});

describe("provider table", () => {
	test("records exact ids without appending context windows", () => {
		const ids = DECISION_PROVIDERS.map(entry => entry.id);
		expect(ids).toContain("openrouter/typesafe/jev-1.14");
		const omni = decisionProvider("opengateway/sionic-ai/jev-omni");
		const decider = decisionProvider("opengateway/sionic-ai/decider-4b");
		expect(omni.model).toBe("sionic-ai/jev-omni");
		expect(omni.contextTokens).toBe(32768);
		expect(decider.model).toBe("sionic-ai/decider-4b");
		expect(decider.contextTokens).toBe(65536);
		for (const entry of DECISION_PROVIDERS) {
			if (entry.contextTokens !== undefined) expect(entry.id.endsWith(String(entry.contextTokens))).toBe(false);
			expect(entry.authEnv.length).toBeGreaterThan(0);
		}
	});

	test("candidates stay unverified until a consumer verifies the envelope", () => {
		expect(decisionProvider("openrouter/typesafe/jev-1.14").status).toBe("baseline");
		expect(decisionProvider("opengateway/sionic-ai/jev-omni").status).toBe("candidate_unverified");
		expect(decisionProvider("sionic-ai/jev-omni")).toBeUndefined();
	});
});

describe("endpoint policy", () => {
	test("allows recorded HTTPS origins and loopback only", () => {
		expect(isAllowedDecisionEndpoint("https://openrouter.ai/api/alpha/decisions")).toBe(true);
		expect(isAllowedDecisionEndpoint("https://apis.opengateway.ai/v1/decisions")).toBe(true);
		expect(isAllowedDecisionEndpoint("http://127.0.0.1:8080/v1")).toBe(true);
		expect(isAllowedDecisionEndpoint("https://example.com/v1")).toBe(false);
		expect(isAllowedDecisionEndpoint("http://openrouter.ai/api")).toBe(false);
		expect(isAllowedDecisionEndpoint("https://user:pass@openrouter.ai/api")).toBe(false);
		expect(isAllowedDecisionEndpoint("not a url")).toBe(false);
	});

	test("a consumer may narrow the origin set", () => {
		const advisor = { origins: ["https://openrouter.ai", "https://api.typesafe.ai"] };
		expect(isAllowedDecisionEndpoint("https://api.typesafe.ai/v1", advisor)).toBe(true);
		expect(isAllowedDecisionEndpoint("https://apis.opengateway.ai/v1/decisions", advisor)).toBe(false);
		expect(isAllowedDecisionEndpoint("http://localhost:1234/v1", advisor)).toBe(true);
	});
});

describe("probability validation", () => {
	const labels = ["a", "b", "c"] as const;
	test("accepts a normalised complete distribution", () => {
		expect(validateProbabilityMap(labels, { a: 0.5, b: 0.3, c: 0.2 }, { complete: true })).toEqual({
			ok: true,
			probabilities: { a: 0.5, b: 0.3, c: 0.2 },
		});
	});
	test("rejects missing, unknown, out-of-range and unnormalised maps", () => {
		expect(validateProbabilityMap(labels, { a: 0.5, b: 0.5 }, { complete: true })).toEqual({ ok: false, reason: "missing_label" });
		expect(validateProbabilityMap(labels, { a: 0.5, b: 0.5, d: 0 })).toEqual({ ok: false, reason: "unknown_label" });
		expect(validateProbabilityMap(labels, { a: 1.2 })).toEqual({ ok: false, reason: "out_of_range" });
		expect(validateProbabilityMap(labels, { a: 0.9, b: 0.9 })).toEqual({ ok: false, reason: "sum" });
		expect(validateProbabilityMap(labels, [])).toEqual({ ok: false, reason: "not_object" });
	});
});

describe("vocabulary", () => {
	test("keeps the two confidence kinds apart and lists every no-decision reason", () => {
		expect([...CONFIDENCE_KINDS]).toEqual(["provider_choice", "self_reported"]);
		for (const reason of ["missing_context", "insufficient_evidence", "timeout", "redirect", "missing_key"]) {
			expect([...NO_DECISION_REASONS]).toContain(reason);
		}
	});
});
