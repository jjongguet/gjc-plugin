import { expect, test } from "bun:test";
import { assessAdequacy } from "../lib/decision";

const context = { changeSummary: "Bound the retry loop", expectedBehavior: "The loop stops after three attempts" };
const counts = { tests: 2, suites: 0, topLevel: 2, passed: 2, failed: 0, skipped: 0, todo: 0, cancelled: 0 };
const facts = (over = {}) => ({ status: "passed", freshness: "fresh", counts, ...over });

function harness(body) {
	const calls = [];
	const deps = {
		env: { JEV_ADVISOR_API_KEY: "fixture-key" },
		envFile: "/nonexistent/fixture.env",
		fetch: async input => {
			calls.push(String(input));
			return new Response(JSON.stringify(body), { status: 200 });
		},
	};
	return { calls, deps };
}

const completeAnswer = {
	answers: {
		coverage_alignment: { type: "choice", choice: "aligned", confidence: 0.9, probabilities: { aligned: 0.9, gap: 0.05, none: 0.03, unknown: 0.02 } },
		boundary_evidence: { type: "choice", choice: "present", confidence: 0.8, probabilities: { present: 0.8, missing: 0.1, none: 0.05, unknown: 0.05 } },
	},
};

test("incomplete evidence returns before any network call", async () => {
	for (const over of [{ status: "failed" }, { freshness: "stale" }, { counts: { ...counts, passed: 0 } }]) {
		const { calls, deps } = harness(completeAnswer);
		const result = await assessAdequacy(context, facts(over), deps);
		expect(result.status).toBe("unknown");
		expect(result.reason).toBe("insufficient_evidence");
		expect(calls.length).toBe(0);
	}
});

test("missing caller context returns before any network call", async () => {
	const { calls, deps } = harness(completeAnswer);
	const result = await assessAdequacy(undefined, facts(), deps);
	expect(result.status).toBe("unknown");
	expect(result.reason).toBe("missing_context");
	expect(calls.length).toBe(0);
});

test("eligible evidence makes exactly one call and scores a complete answer", async () => {
	const { calls, deps } = harness(completeAnswer);
	const result = await assessAdequacy(context, facts(), deps);
	expect(calls.length).toBe(1);
	expect(result.status).toBe("scored");
	expect(result.answers.coverage_alignment.choice).toBe("aligned");
});

test("a distribution that does not sum to one is rejected as an invalid answer", async () => {
	const bad = {
		answers: {
			coverage_alignment: { type: "choice", choice: "aligned", confidence: 0.9, probabilities: { aligned: 0.9, gap: 0.9, none: 0.9, unknown: 0.9 } },
			boundary_evidence: { type: "choice", choice: "present" },
		},
	};
	const { calls, deps } = harness(bad);
	const result = await assessAdequacy(context, facts(), deps);
	expect(calls.length).toBe(1);
	expect(result.status).toBe("invalid_response");
	expect(result.reason).toBe("invalid_answer");
});
