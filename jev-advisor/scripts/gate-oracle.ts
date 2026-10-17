// Golden-contract oracle for the Hermes jev-gate check subset.
// The Python gate mirrors composeCheckPrompt/strict parsing/oversize; this
// script proves the TypeScript core still matches the shared fixtures.
// Mac-only, no real network calls, not a deployed surface.
import { readConfig, providerPromptLimit, prepareCheck, askCheckModel, type CheckAdvice } from "../lib/decision";

type Case = {
	name: string;
	question: string;
	artifact?: string;
	artifact_oversize?: boolean;
	response?: unknown;
	expected: { status: string; verdict?: string; confidence?: number; reason?: string };
};

const casesUrl = new URL("../../integrations/hermes/jev-gate/fixtures/golden/check-cases.json", import.meta.url);
const cases = (await Bun.file(casesUrl).json()) as Case[];
const base = readConfig({}, {});
const cfg = { ...base, apiKey: "oracle-test", provider: "jev" as const, endpoint: "https://openrouter.ai/api/alpha/decisions" };
const limit = providerPromptLimit(cfg);

function equal(got: CheckAdvice | { status: string; reason?: string }, expected: Case["expected"]): boolean {
	if (got.status !== expected.status) return false;
	if (expected.status === "decision") {
		return "verdict" in got && got.verdict === expected.verdict &&
			typeof got.confidence === "number" && Math.abs(got.confidence - (expected.confidence ?? -1)) < 1e-9;
	}
	return "reason" in got && got.reason === expected.reason;
}

const failures: string[] = [];
const results: unknown[] = [];
for (const testCase of cases) {
	if (testCase.artifact_oversize) {
		const prep = prepareCheck(testCase.question, "x".repeat(4001), limit);
		const got = prep.status === "input_too_large" ? { status: "no_decision", reason: "input_too_large" } : { status: prep.status, reason: prep.status };
		results.push({ name: testCase.name, got });
		if (!equal(got, testCase.expected)) failures.push(testCase.name);
		continue;
	}
	const prep = prepareCheck(testCase.question, testCase.artifact ?? "", limit);
	if (prep.status !== "ok") {
		const got = { status: "no_decision", reason: prep.status };
		results.push({ name: testCase.name, got });
		if (!equal(got, testCase.expected)) failures.push(testCase.name);
		continue;
	}
	const fakeFetch = async () => new Response(JSON.stringify(testCase.response ?? {}), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
	const got = await askCheckModel(cfg, prep.check, fakeFetch, undefined, 1000);
	results.push({ name: testCase.name, got });
	if (!equal(got, testCase.expected)) failures.push(testCase.name);
}

console.log(JSON.stringify({ status: failures.length ? "failed" : "ok", cases: cases.length, failures, results }, null, 2));
process.exit(failures.length ? 1 : 0);
