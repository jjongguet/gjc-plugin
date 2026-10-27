import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RRSI_QUALITY_SCHEMA, projectQualityCohort, readTrialRecords } from "../lib/rrsi";
import { executionKeyFor } from "../../self-improve/lib/quality-trial.mjs";

const digest = (fill: string) => fill.repeat(64).slice(0, 64);
const SOURCE = digest("a");
const HARNESS = digest("b");
const MANIFEST = digest("c");
const EVIDENCE = digest("d");
const RECEIPT = digest("e");

// Each fixture call is its own execution cell (`repeat` is in the execution
// key), so two fixtures are two trials even when every other field matches.
let serial = 0;
const trial = (over: Record<string, unknown> = {}) => {
	serial += 1;
	const body: Record<string, any> = {
		schema: RRSI_QUALITY_SCHEMA,
		trialId: `trial-${serial}`,
		taskId: "docs-links",
		taskVersion: 1,
		split: "development",
		arm: "B1",
		repeat: serial,
		goalRevision: 1,
		producer: { id: "producer-a", kind: "agent" },
		executor: { id: "executor-a", receiptId: "receipt-1", receiptDigest: RECEIPT },
		harness: { sourceDigest: SOURCE, harnessDigest: HARNESS, manifestDigest: MANIFEST, version: "harness2.v2" },
		oracle: { kind: "artifact-check", verifierId: "verifier-a", evidenceDigest: EVIDENCE, independentFromProducer: true },
		outcome: "passed",
		denominator: { planned: 3, passed: 3, failed: 0, error: 0, skipped: 0 },
		cost: { wallMs: 1200, inputTokens: 900, outputTokens: 120, usd: 0.01, measured: true },
		createdAt: "2026-10-24T02:00:00.000Z",
		sourceHead: "abcdef1",
		...over,
	};
	body.executionKey = executionKeyFor({
		taskId: body.taskId,
		taskVersion: body.taskVersion,
		arm: body.arm,
		repeat: body.repeat,
		harnessDigest: body.harness.harnessDigest,
		oracleDigest: body.oracle.evidenceDigest,
		goalRevision: body.goalRevision,
	});
	return body;
};

test("a v2 trial with independent evidence and a measured cost is admissible", () => {
	const record = trial();
	const cohort = projectQualityCohort([record]);
	expect(cohort.schema).toBe("rrsi.quality_cohort.v2");
	expect(cohort.admissible).toHaveLength(1);
	expect(cohort.admissible[0]).toMatchObject({
		provenance: record.trialId,
		objective: "docs-links",
		decision: "adopt",
		wallMs: 1200,
		usd: 0.01,
		split: "development",
		arm: "B1",
		repeat: record.repeat,
		executionKey: record.executionKey,
		costMeasured: true,
	});
	expect(cohort.excluded).toEqual([]);
	expect(cohort.total).toBe(1);
	expect(cohort.duplicate).toBe(0);
});

test("the cohort is counts only: there is no efficacy permission field", () => {
	const cohort = projectQualityCohort([trial(), trial()]);
	expect("efficacyClaimsAllowed" in cohort).toBe(false);
	expect(cohort.admissible).toHaveLength(2);
	expect(cohort.total).toBe(2);
});

test("unknown outcomes and non-independent actors are excluded and counted", () => {
	const cohort = projectQualityCohort([
		trial({ outcome: "skipped" }),
		trial({ oracle: { kind: "artifact-check", verifierId: "verifier-a", evidenceDigest: EVIDENCE, independentFromProducer: false } }),
		trial({ oracle: { kind: "artifact-check", verifierId: "executor-a", evidenceDigest: EVIDENCE, independentFromProducer: true } }),
		trial({ producer: { id: "same-actor", kind: "agent" }, executor: { id: "same-actor", receiptId: "receipt-1", receiptDigest: RECEIPT } }),
	]);
	expect(cohort.admissible).toHaveLength(0);
	expect(Object.fromEntries(cohort.excluded.map((entry) => [entry.reason, entry.count]))).toEqual({
		non_independent_oracle: 2,
		non_independent_producer: 1,
		unknown_outcome: 1,
	});
});

test("a bare oracle boolean is not independence evidence", () => {
	const bare = trial({ oracle: { independentFromProducer: true } });
	const cohort = projectQualityCohort([bare]);
	expect(cohort.admissible).toHaveLength(0);
	expect(cohort.excluded).toEqual([{ reason: "non_independent_oracle", count: 1 }]);
});

test("a missing or default-zero cost is ineligible until it is measured with a reason", () => {
	const unmeasured = projectQualityCohort([trial({ cost: { wallMs: 1200, inputTokens: 0, outputTokens: 0, usd: 0, measured: false } })]);
	expect(unmeasured.admissible).toHaveLength(0);
	expect(unmeasured.excluded).toEqual([{ reason: "missing_cost", count: 1 }]);
	const zero = projectQualityCohort([trial({ cost: { wallMs: 0, inputTokens: 0, outputTokens: 0, usd: 0, measured: true } })]);
	expect(zero.admissible).toHaveLength(0);
	expect(zero.excluded).toEqual([{ reason: "missing_cost", count: 1 }]);
	const explained = projectQualityCohort([
		trial({ cost: { wallMs: 0, inputTokens: 0, outputTokens: 0, usd: 0, measured: true, zeroCostRationale: "cached fixture run" } }),
	]);
	expect(explained.admissible).toHaveLength(1);
});

test("a negative cost component is excluded instead of netting out", () => {
	const negativeUsd = projectQualityCohort([trial({ cost: { wallMs: 1200, inputTokens: 900, outputTokens: 120, usd: -0.01, measured: true } })]);
	expect(negativeUsd.admissible).toHaveLength(0);
	expect(negativeUsd.excluded).toEqual([{ reason: "negative_cost", count: 1 }]);
	const negativeTokens = projectQualityCohort([trial({ cost: { wallMs: 1200, inputTokens: -5, outputTokens: 120, usd: 0.01, measured: true } })]);
	expect(negativeTokens.excluded).toEqual([{ reason: "negative_cost", count: 1 }]);
});

test("identity fields must be present and digest-shaped", () => {
	const cohort = projectQualityCohort([
		trial({ harness: { sourceDigest: "short", harnessDigest: HARNESS, manifestDigest: MANIFEST, version: "harness2.v2" } }),
		trial({ trialId: "" }),
		trial({ executor: { id: "executor-a", receiptId: "receipt-1", receiptDigest: "nope" } }),
	]);
	expect(cohort.admissible).toHaveLength(0);
	expect(cohort.excluded).toEqual([{ reason: "legacy_schema", count: 3 }]);
});

test("a forged executionKey is not a v2 trial", () => {
	const forged = trial();
	forged.executionKey = digest("f");
	const cohort = projectQualityCohort([forged]);
	expect(cohort.admissible).toHaveLength(0);
	expect(cohort.excluded).toEqual([{ reason: "legacy_schema", count: 1 }]);
});

test("the denominator must add up and agree with the outcome", () => {
	const shortSum = projectQualityCohort([trial({ denominator: { planned: 4, passed: 3, failed: 0, error: 0, skipped: 0 } })]);
	expect(shortSum.excluded).toEqual([{ reason: "denominator_mismatch", count: 1 }]);
	const disagreesWithOutcome = projectQualityCohort([
		trial({ denominator: { planned: 4, passed: 3, failed: 1, error: 0, skipped: 0 } }),
	]);
	expect(disagreesWithOutcome.excluded).toEqual([{ reason: "denominator_mismatch", count: 1 }]);
	const failed = projectQualityCohort([trial({ outcome: "failed", denominator: { planned: 3, passed: 2, failed: 1, error: 0, skipped: 0 } })]);
	expect(failed.admissible).toHaveLength(1);
	expect(failed.admissible[0].decision).toBe("reject");
});

test("an operational journal row never becomes a quality reward", () => {
	const operational = { id: "record-1", operation: "advise", advice: { status: "decision", tier: "strong" }, durationMs: 900 };
	const legacy = {
		schema: "rrsi.quality_trial.v1",
		trialId: "old-1",
		objective: "probe.docs_links",
		oracle: { independent: true, status: "passed" },
		harness: { sourceDigest: SOURCE, harnessDigest: HARNESS },
		cost: { measured: true, wallMs: 1200 },
	};
	const cohort = projectQualityCohort([operational, legacy]);
	expect(cohort.admissible).toHaveLength(0);
	expect(cohort.excluded).toEqual([{ reason: "legacy_schema", count: 2 }]);
});

test("an identical duplicate counts once; a conflicting duplicate is excluded", () => {
	const original = trial();
	const cohort = projectQualityCohort([original, JSON.parse(JSON.stringify(original))]);
	expect(cohort.admissible).toHaveLength(1);
	expect(cohort.duplicate).toBe(1);
	expect(cohort.excluded).toEqual([]);
	expect(cohort.total).toBe(2);

	const conflict = { ...JSON.parse(JSON.stringify(original)), cost: { ...original.cost, usd: 0.02 } };
	const conflicted = projectQualityCohort([original, conflict]);
	expect(conflicted.admissible).toHaveLength(1);
	expect(conflicted.duplicate).toBe(0);
	expect(conflicted.excluded).toEqual([{ reason: "conflicting_duplicate", count: 1 }]);
});

test("repeats are distinct trials, not duplicates", () => {
	const first = trial();
	const second = trial({ ...{}, repeat: first.repeat + 100 });
	const cohort = projectQualityCohort([first, second]);
	expect(cohort.admissible).toHaveLength(2);
	expect(cohort.duplicate).toBe(0);
	expect(new Set(cohort.admissible.map((entry) => entry.executionKey)).size).toBe(2);
});

test("the limit bounds inspected records and keeps every inspected row accounted for", () => {
	const records = [trial(), trial(), trial()];
	const cohort = projectQualityCohort(records, { limit: 2 });
	expect(cohort.total).toBe(2);
	expect(cohort.admissible).toHaveLength(2);
});

test("the bounded trial reader accepts JSON arrays and JSONL, and refuses unsafe paths", () => {
	const root = mkdtempSync(path.join(os.tmpdir(), "rrsi-trial-reader-"));
	try {
		const records = [trial(), trial()];
		const arrayPath = path.join(root, "trials.json");
		writeFileSync(arrayPath, JSON.stringify(records));
		const fromArray = readTrialRecords({ recordsPath: arrayPath });
		expect(fromArray.status).toBe("ok");
		expect(fromArray.records).toHaveLength(2);

		const jsonlPath = path.join(root, "trials.jsonl");
		writeFileSync(jsonlPath, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\nnot json\n`);
		const fromJsonl = readTrialRecords({ recordsPath: jsonlPath });
		expect(fromJsonl.records).toHaveLength(2);

		expect(readTrialRecords({ recordsPath: path.join(root, "missing.json") })).toMatchObject({ status: "missing", records: [] });
		const linkPath = path.join(root, "link.json");
		symlinkSync(arrayPath, linkPath);
		expect(readTrialRecords({ recordsPath: linkPath })).toMatchObject({ status: "invalid", reason: "unsafe_path" });
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
