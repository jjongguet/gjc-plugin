import { expect, test } from "bun:test";
import { RRSI_QUALITY_SCHEMA, projectQualityCohort } from "../lib/rrsi";

const digest = (fill: string) => fill.repeat(64).slice(0, 64);
const trial = (over: Record<string, unknown> = {}) => ({
	schema: RRSI_QUALITY_SCHEMA,
	trialId: "trial-1",
	objective: "probe.docs_links",
	oracle: { independent: true, status: "passed" },
	harness: { sourceDigest: digest("a"), harnessDigest: digest("b") },
	cost: { measured: true, wallMs: 1200 },
	...over,
});

test("a verified outcome with a measured cost is admissible", () => {
	const cohort = projectQualityCohort([trial()]);
	expect(cohort.admissible).toHaveLength(1);
	expect(cohort.admissible[0]).toMatchObject({ provenance: "trial-1", decision: "adopt", wallMs: 1200, costMeasured: true });
	expect(cohort.excluded).toEqual([]);
	expect(cohort.total).toBe(1);
});

test("unknown outcomes and non-independent oracles are excluded and counted", () => {
	const cohort = projectQualityCohort([
		trial({ trialId: "unknown", oracle: { independent: true, status: "skipped" } }),
		trial({ trialId: "self-report", oracle: { independent: false, status: "passed" } }),
	]);
	expect(cohort.admissible).toHaveLength(0);
	expect(cohort.excluded.map(entry => entry.reason).sort()).toEqual(["non_independent_oracle", "unknown_outcome"]);
	expect(cohort.excluded.every(entry => entry.count === 1)).toBe(true);
	expect(cohort.efficacyClaimsAllowed).toBe(false);
});

test("a missing or default-zero cost is ineligible until it is measured with a reason", () => {
	const zero = projectQualityCohort([trial({ cost: { measured: true, wallMs: 0 } })]);
	expect(zero.admissible).toHaveLength(0);
	expect(zero.excluded).toEqual([{ reason: "missing_cost", count: 1 }]);
	const explained = projectQualityCohort([trial({ cost: { measured: true, wallMs: 0, zeroCostRationale: "cached fixture run" } })]);
	expect(explained.admissible).toHaveLength(1);
});

test("identity fields must be present and digest-shaped", () => {
	const cohort = projectQualityCohort([trial({ harness: { sourceDigest: "short", harnessDigest: digest("c") } }), trial({ trialId: "" })]);
	expect(cohort.admissible).toHaveLength(0);
	expect(cohort.excluded).toEqual([{ reason: "missing_identity", count: 2 }]);
});

test("an operational journal row never becomes a quality reward", () => {
	const operational = { id: "record-1", operation: "advise", advice: { status: "decision", tier: "strong" }, durationMs: 900 };
	const cohort = projectQualityCohort([operational]);
	expect(cohort.admissible).toHaveLength(0);
	expect(cohort.excluded).toEqual([{ reason: "invalid", count: 1 }]);
});

test("efficacy claims need at least two admissible trials", () => {
	expect(projectQualityCohort([trial()]).efficacyClaimsAllowed).toBe(false);
	expect(projectQualityCohort([trial(), trial({ trialId: "trial-2" })]).efficacyClaimsAllowed).toBe(true);
});
