#!/usr/bin/env bun
/**
 * Deterministic (non-model) probe / held-out scoring runner for the
 * self-improve loop, domain: gjc-plugin.
 *
 * Usage:
 *   bun self-improve/domains/gjc-plugin/probes/run.ts \
 *     --baseline <repoDir> --candidate <repoDir> [--json]
 *
 * Loads `<dir>/jev-advisor/lib/decision.ts` dynamically for each of the two
 * directories (baseline / candidate), computes identical deterministic
 * metrics on both, and prints exactly ONE JSON object on stdout.
 *
 * No timers, no network, no randomness: the same inputs always produce
 * byte-identical stdout JSON.
 */
import path from "node:path";
import fs from "node:fs";

const SCHEMA = "gjc.self-improve.probe.v1";
const PRIMARY = "decision_accuracy";

const PROBES_FIXTURES = path.resolve(import.meta.dir, "fixtures.json");
const HELDOUT_FIXTURES = path.resolve(import.meta.dir, "../heldout/fixtures.json");

function fail(message: string): never {
	process.stderr.write(`probes-runner: ${message}\n`);
	process.exit(1);
}

function readFlag(flag: string): string {
	const argv = process.argv.slice(2);
	const index = argv.indexOf(flag);
	if (index === -1 || index + 1 >= argv.length) {
		fail(`missing required argument ${flag} <repoDir>`);
	}
	return argv[index + 1];
}

function loadFixtures(file: string, label: string): any {
	if (!fs.existsSync(file)) fail(`${label} fixtures not found at ${file}`);
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (error) {
		fail(`${label} fixtures are not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function loadDecisionModule(dir: string, label: string): Promise<any> {
	const resolved = path.resolve(dir);
	if (!fs.existsSync(resolved)) fail(`${label} directory does not exist: ${resolved}`);
	const decisionPath = path.join(resolved, "jev-advisor", "lib", "decision.ts");
	if (!fs.existsSync(decisionPath)) {
		fail(`${label} directory is not a gjc-plugin repo: ${decisionPath} not found`);
	}
	try {
		// bun imports TypeScript directly; the path is resolved from the given repo dir.
		return await import(decisionPath);
	} catch (error) {
		fail(`failed to load ${decisionPath}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** extract_coverage: fraction of extract cases whose extraction outcome matches expectations. */
function scoreExtract(mod: any, cases: any[]): { score: number; count: number; failures: string[] } {
	let hits = 0;
	const failures: string[] = [];
	for (const [index, item] of cases.entries()) {
		try {
			const extraction = mod.extractTasks(item.input, item.maxPromptChars);
			const extractedIndexes = extraction.tasks.map((t: any) => t.index);
			const rejectedIndexes = extraction.rejected.map((r: any) => r.index);
			const expected = item.expected;
			const ok =
				JSON.stringify(extractedIndexes) === JSON.stringify(expected.extractedIndexes) &&
				JSON.stringify(rejectedIndexes) === JSON.stringify(expected.rejectedIndexes) &&
				extraction.omittedCount === expected.omittedCount;
			if (ok) hits++;
			else failures.push(`extract_coverage#${index}`);
		} catch {
			// unexpected failure counts as a miss, never crashes the runner
			failures.push(`extract_coverage#${index}`);
		}
	}
	return { score: cases.length ? hits / cases.length : 0, count: cases.length, failures };
}

/** decision_accuracy: fraction of decision cases whose accept/reject outcome matches expectations. */
function scoreDecision(mod: any, cases: any[]): { score: number; count: number; failures: string[] } {
	let hits = 0;
	const failures: string[] = [];
	for (const [index, item] of cases.entries()) {
		try {
			const advice = mod.parseDecision(item.raw, item.confidenceKind);
			const accepted = advice.status === "decision";
			let ok = accepted === item.expected.accept;
			if (ok && item.expected.accept) {
				ok = advice.tier === item.expected.tier;
			}
			if (ok) hits++;
			else failures.push(`decision_accuracy#${index}`);
		} catch {
			// unexpected failure counts as a miss, never crashes the runner
			failures.push(`decision_accuracy#${index}`);
		}
	}
	return { score: cases.length ? hits / cases.length : 0, count: cases.length, failures };
}

/** egress_boundary: fraction of endpoint cases whose allow/block outcome matches expectations. */
function scoreEgress(mod: any, cases: any[]): { score: number; count: number; failures: string[] } {
	let hits = 0;
	const failures: string[] = [];
	for (const [index, item] of cases.entries()) {
		try {
			if (mod.isAllowedEndpoint(item.endpoint) === item.expected.allowed) hits++;
			else failures.push(`egress_boundary#${index}`);
		} catch {
			// unexpected failure counts as a miss, never crashes the runner
			failures.push(`egress_boundary#${index}`);
		}
	}
	return { score: cases.length ? hits / cases.length : 0, count: cases.length, failures };
}

async function main(): Promise<void> {
	const baselineDir = readFlag("--baseline");
	const candidateDir = readFlag("--candidate");

	const probeFixtures = loadFixtures(PROBES_FIXTURES, "probe");
	const heldoutFixtures = loadFixtures(HELDOUT_FIXTURES, "held-out");

	const baselineMod = await loadDecisionModule(baselineDir, "--baseline");
	const candidateMod = await loadDecisionModule(candidateDir, "--candidate");

	const metricCases = probeFixtures.cases;

	const evaluate = (mod: any) => {
		const extract = scoreExtract(mod, metricCases.extract_coverage);
		const decision = scoreDecision(mod, metricCases.decision_accuracy);
		const egress = scoreEgress(mod, metricCases.egress_boundary);
		const heldoutExtract = scoreExtract(mod, heldoutFixtures.cases.extract_coverage);
		const heldoutDecision = scoreDecision(mod, heldoutFixtures.cases.decision_accuracy);
		const heldoutEgress = scoreEgress(mod, heldoutFixtures.cases.egress_boundary);
		const heldoutTotal =
			heldoutExtract.count + heldoutDecision.count + heldoutEgress.count;
		const heldoutHits =
			heldoutExtract.score * heldoutExtract.count +
			heldoutDecision.score * heldoutDecision.count +
			heldoutEgress.score * heldoutEgress.count;
		return {
			metrics: {
				extract_coverage: extract.score,
				decision_accuracy: decision.score,
				egress_boundary: egress.score,
			},
			counts: {
				extract_coverage: extract.count,
				decision_accuracy: decision.count,
				egress_boundary: egress.count,
			},
			failures: {
				extract_coverage: extract.failures,
				decision_accuracy: decision.failures,
				egress_boundary: egress.failures,
			},
			heldout: {
				heldout_coverage: heldoutTotal ? heldoutHits / heldoutTotal : 0,
			},
			heldoutCount: heldoutTotal,
		};
	};

	const baseline = evaluate(baselineMod);
	const candidate = evaluate(candidateMod);

	const result = {
		schema: SCHEMA,
		primary: PRIMARY,
		baseline: baseline.metrics,
		candidate: candidate.metrics,
		delta: candidate.metrics[PRIMARY as "decision_accuracy"] - baseline.metrics[PRIMARY as "decision_accuracy"],
		heldout: {
			baseline: { heldout_coverage: baseline.heldout.heldout_coverage },
			candidate: { heldout_coverage: candidate.heldout.heldout_coverage },
		},
		counts: {
			extract_coverage: baseline.counts.extract_coverage,
			decision_accuracy: baseline.counts.decision_accuracy,
			egress_boundary: baseline.counts.egress_boundary,
			heldout_coverage: baseline.heldoutCount,
		},
		failures: {
			baseline: baseline.failures,
			candidate: candidate.failures,
		},
		notes: [
			"Metrics are deterministic, non-model hit rates over fixtures in probes/fixtures.json (probe) and heldout/fixtures.json (held-out).",
			"Signatures verified against jev-advisor/lib/decision.ts: extractTasks (line 327), parseDecision (line 1955), isAllowedEndpoint (line 211).",
			"Call conventions verified against usage in jev-advisor/scripts/verify.ts lines 91, 123, 130-131 and 142-151.",
			"extractTasks(input: unknown, maxPromptChars: 1900 | 4000): Extraction compared on extracted task indexes, rejected indexes and omittedCount.",
			"parseDecision(raw: string, confidenceKind?: ConfidenceKind): Advice compared on accept (status 'decision') vs reject (status 'no_decision') and accepted tier.",
			"isAllowedEndpoint(endpoint: string): boolean compared on exact allow/block expectation per endpoint.",
			"failures.{baseline,candidate} lists per-case misses as short `<metric>#<index>` labels for the three probe metrics only (never held-out cases or fixture values); the loop feeds these labels into proposer requests.",
			"No timers, network or randomness are used; identical inputs yield byte-identical stdout JSON.",
		],
	};

	process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

await main();
