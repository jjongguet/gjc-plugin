#!/usr/bin/env bun
/**
 * Golden-set scorer for memory-dream.
 *
 *   bun scripts/golden.ts --offline          deterministic baseline only (keyless)
 *   bun scripts/golden.ts --fake perfect     hermetic jev transport (tests)
 *   bun scripts/golden.ts --runs 3           real jev, 3 runs (needs a key)
 *
 * The baseline is deliberately naive: when canonical evidence exists it says
 * "supported". It measures the gap the semantic decision model is meant to
 * close; it is not the shipped verdict path.
 *
 * The golden set is synthetic and lives under tests/fixtures/golden/. No real
 * memory, session text or credential is written to the result.
 */
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	PROMPT_VERSION,
	JEV_MODEL,
	defaultResultsRoot,
	ensurePrivateDirectory,
	analyzeClaimForReport,
	loadCanonicalDocs,
	resolveJevConfig,
	writePrivateFile,
	type ClaimAnalysisDeps,
	type ClaimReport,
	type EvidenceItem,
	type FetchLike,
	type JevConfig,
	type RawClaim,
} from "../lib/dream";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fixturesRoot = path.join(pluginRoot, "tests", "fixtures", "golden");
const casesPath = path.join(fixturesRoot, "cases.json");
const corpusRoot = path.join(fixturesRoot, "corpus");
const THRESHOLDS = [0.5, 0.6, 0.7, 0.8, 0.9] as const;
const DRIFT_TYPES = ["retry-vs-exhaustion", "ssh-alias-inversion", "renamed-rule", "expired-snapshot", "masked-rule-ref", "path-forwarding", "home-withheld"];

type Expected = "supported" | "contradicted" | "unverifiable";
type Predicted = Expected | "no-decision";

interface GoldenCase {
	id: string;
	claim: string;
	expected: Expected;
	drift?: string;
}

interface GoldenFile {
	version: number;
	corpus: string;
	cases: GoldenCase[];
}

interface Prediction {
	id: string;
	expected: Expected;
	predicted: Predicted;
	evidence: EvidenceItem[];
	jev: ClaimReport["jev"];
	confidence: number | null;
}

interface Score {
	accuracy: number;
	total: number;
	correct: number;
	contradicted: { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null };
	supported: { tp: number; fp: number; fn: number; precision: number | null; recall: number | null };
	confusion: Record<string, number>;
}

interface ThresholdScore {
	threshold: number;
	runs: Score[];
	meanAccuracy: number;
	meanPrecision: number | null;
	meanRecall: number | null;
	meanF1: number | null;
	adopted: boolean;
}

function parseArgs(argv: string[]) {
	const offline = argv.includes("--offline");
	const fakeIndex = argv.indexOf("--fake");
	const fake = fakeIndex === -1 ? null : (argv[fakeIndex + 1] ?? "perfect");
	const runsIndex = argv.indexOf("--runs");
	const runs = runsIndex === -1 ? 3 : Math.max(1, Math.min(5, Number(argv[runsIndex + 1]) || 3));
	return { offline, fake, runs };
}

function normalize(value: string): string {
	return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function predictedAt(prediction: Prediction, threshold: number): Predicted {
	if (prediction.evidence.length === 0) return "unverifiable";
	if (!prediction.jev || prediction.jev.status !== "decision") return "no-decision";
	if (prediction.jev.verdict === "correct") return "supported";
	if (prediction.jev.verdict === "unsure") return "unverifiable";
	const canonical = prediction.evidence.some(item => item.kind === "canonical");
	if (!canonical) return "unverifiable";
	return prediction.jev.confidence >= threshold ? "contradicted" : "unverifiable";
}

function scoreRun(cases: GoldenCase[], predictions: Prediction[], threshold: number | null): Score {
	const confusion: Record<string, number> = {};
	let correct = 0;
	let tp = 0;
	let fp = 0;
	let fn = 0;
	let supportedTp = 0;
	let supportedFp = 0;
	let supportedFn = 0;
	for (const entry of predictions) {
		const predicted = threshold === null ? entry.predicted : predictedAt(entry, threshold);
		confusion[`${entry.expected}->${predicted}`] = (confusion[`${entry.expected}->${predicted}`] ?? 0) + 1;
		if (predicted === entry.expected) correct++;
		if (entry.expected === "contradicted" && predicted === "contradicted") tp++;
		if (entry.expected !== "contradicted" && predicted === "contradicted") fp++;
		if (entry.expected === "contradicted" && predicted !== "contradicted") fn++;
		if (entry.expected === "supported" && predicted === "supported") supportedTp++;
		if (entry.expected !== "supported" && predicted === "supported") supportedFp++;
		if (entry.expected === "supported" && predicted !== "supported") supportedFn++;
	}
	const precision = tp + fp === 0 ? null : tp / (tp + fp);
	const recall = tp + fn === 0 ? null : tp / (tp + fn);
	const f1 = precision === null || recall === null || precision + recall === 0 ? null : (2 * precision * recall) / (precision + recall);
	const supportedPrecision = supportedTp + supportedFp === 0 ? null : supportedTp / (supportedTp + supportedFp);
	const supportedRecall = supportedTp + supportedFn === 0 ? null : supportedTp / (supportedTp + supportedFn);
	return {
		accuracy: cases.length === 0 ? 0 : correct / cases.length,
		total: cases.length,
		correct,
		contradicted: { tp, fp, fn, precision, recall, f1 },
		supported: { tp: supportedTp, fp: supportedFp, fn: supportedFn, precision: supportedPrecision, recall: supportedRecall },
		confusion,
	};
}

function mean(values: (number | null)[]): number | null {
	const present = values.filter((value): value is number => typeof value === "number");
	return present.length === 0 ? null : present.reduce((sum, value) => sum + value, 0) / present.length;
}

function thresholdScore(cases: GoldenCase[], runs: Prediction[][], threshold: number): ThresholdScore {
	const scores = runs.map(predictions => scoreRun(cases, predictions, threshold));
	const meanPrecision = mean(scores.map(score => score.contradicted.precision));
	const meanRecall = mean(scores.map(score => score.contradicted.recall));
	const meanF1 = mean(scores.map(score => score.contradicted.f1));
	return {
		threshold,
		runs: scores,
		meanAccuracy: mean(scores.map(score => score.accuracy)) ?? 0,
		meanPrecision,
		meanRecall,
		meanF1,
		adopted: meanPrecision !== null && meanRecall !== null && meanPrecision >= 0.9 && meanRecall >= 0.7,
	};
}

function fakeFetch(cases: GoldenCase[], mode: string): { fetch: FetchLike; calls: () => number } {
	let called = 0;
	const fetchImpl: FetchLike = async (_input, init) => {
		called++;
		let claim = "";
		try {
			const body = JSON.parse(String(init?.body ?? "{}"));
			claim = String(body.state ?? "").split("CLAIM:\n")[1]?.split("\n")[0] ?? "";
		} catch {
			claim = "";
		}
		const matched = cases.find(entry => normalize(entry.claim) === normalize(claim)) ?? cases.find(entry => normalize(claim).includes(normalize(entry.claim).slice(0, 40)));
		let choice: "correct" | "incorrect" | "unsure" = "unsure";
		let confidence = 0.6;
		if (mode === "all-incorrect") {
			choice = "incorrect";
			confidence = 0.95;
		} else if (mode === "all-unsure") {
			choice = "unsure";
			confidence = 0.5;
		} else if (matched) {
			if (matched.expected === "supported") {
				choice = "correct";
				confidence = 0.88;
			} else if (matched.expected === "contradicted") {
				choice = "incorrect";
				confidence = 0.93;
			} else {
				choice = "unsure";
				confidence = 0.55;
			}
		}
		return new Response(
			JSON.stringify({
				answers: {
					consistency: {
						choice,
						confidence,
						rationale: "synthetic fixture response",
					},
				},
			}),
			{ status: 200, headers: { "content-type": "application/json" } },
		);
	};
	return { fetch: fetchImpl, calls: () => called };
}

async function usageSnapshot(config: JevConfig): Promise<number | null> {
	if (!config.key) return null;
	try {
		const response = await fetch("https://openrouter.ai/api/v1/key", {
			headers: { authorization: `Bearer ${config.key}` },
			redirect: "manual",
			signal: AbortSignal.timeout(5000),
		});
		if (!response.ok) return null;
		const data = (await response.json()) as { data?: { usage?: unknown } };
		return typeof data.data?.usage === "number" ? data.data.usage : null;
	} catch {
		return null;
	}
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	const golden = JSON.parse(await readFile(casesPath, "utf8")) as GoldenFile;
	const cases = golden.cases;
	const ids = new Set<string>();
	if (golden.version !== 1) throw new Error("unsupported golden version");
	if (cases.length < 30) throw new Error(`golden set too small: ${cases.length}`);
	for (const entry of cases) {
		if (ids.has(entry.id)) throw new Error(`duplicate case id: ${entry.id}`);
		ids.add(entry.id);
		if (!["supported", "contradicted", "unverifiable"].includes(entry.expected)) throw new Error(`bad expected: ${entry.id}`);
	}
	const counts: Record<string, number> = {};
	for (const entry of cases) counts[entry.expected] = (counts[entry.expected] ?? 0) + 1;
	const driftCounts: Record<string, number> = {};
	for (const entry of cases) if (entry.drift) driftCounts[entry.drift] = (driftCounts[entry.drift] ?? 0) + 1;
	const missingDrift = DRIFT_TYPES.filter(type => !driftCounts[type]);
	if (missingDrift.length > 0) throw new Error(`missing drift types: ${missingDrift.join(", ")}`);

	const docs = await loadCanonicalDocs(corpusRoot);
	const now = new Date("2026-11-11T00:00:00Z");
	const home = homedir();
	const env = process.env;
	const config = resolveJevConfig(env, path.join(home, ".gjc", "agent", "jev-advisor", ".env"));
	const resultsRoot = defaultResultsRoot(home, env);
	const generatedAt = new Date().toISOString();
	const runId = `${generatedAt.replace(/[:.]/g, "-")}-golden`;
	const report: Record<string, unknown> = {
		schema: "memory-dream.golden.v1",
		generatedAt,
		model: JEV_MODEL,
		promptVersion: PROMPT_VERSION,
		cases: cases.length,
		labelCounts: counts,
		driftCounts,
		corpusDocs: docs.length,
		transport: args.offline ? "offline" : args.fake ? `fake:${args.fake}` : "real",
		runs: args.runs,
		baseline: null,
		thresholds: null,
		selectedThreshold: null,
		adoption: null,
		runs: null,
		baselinePredictions: null,
		cost: { measured: false, calls: 0, usd: null, note: "not measured" },
	};

	const baseDeps = (jevConfig: JevConfig, fetchImpl?: FetchLike): ClaimAnalysisDeps => ({
		projectRoot: corpusRoot,
		agentDir: path.join(home, ".gjc", "agent"),
		now,
		jevConfig,
		documents: docs,
		fetchImpl,
		transcriptSearch: false,
		confidenceThreshold: 0,
		callJev: true,
	});
	const rawClaim = (entry: GoldenCase): RawClaim => ({ id: entry.id, text: entry.claim, sources: [{ file: "golden/cases.json", line: 1 }] });

	// Deterministic baseline: lexical evidence presence only. This is not the
	// shipped verdict path; it measures how far deterministic retrieval alone goes.
	const baselinePredictions: Prediction[] = [];
	for (const entry of cases) {
		const claim = rawClaim(entry);
		const report = await analyzeClaimForReport(claim, baseDeps({ key: null, providerOff: false, source: null }), {
			callJev: false,
		});
		const predicted: Predicted = report.evidence.length > 0 ? "supported" : "unverifiable";
		baselinePredictions.push({
			id: entry.id,
			expected: entry.expected,
			predicted,
			evidence: report.evidence,
			jev: null,
			confidence: null,
		});
	}
	const baseline = scoreRun(cases, baselinePredictions, null);
	report.baseline = baseline;
	report.baselinePredictions = baselinePredictions.map(prediction => ({
		id: prediction.id,
		expected: prediction.expected,
		predicted: prediction.predicted,
		evidence: prediction.evidence.map(item => item.citation),
	}));

	if (args.offline) {
		const outDir = path.join(resultsRoot, "golden");
		await ensurePrivateDirectory(outDir);
		const outPath = path.join(outDir, `${runId}.json`);
		await writePrivateFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
		console.log(`memory-dream golden: baseline accuracy=${baseline.accuracy.toFixed(2)} (${baseline.correct}/${baseline.total})`);
		console.log(
			`contradicted precision=${baseline.contradicted.precision === null ? "null" : baseline.contradicted.precision.toFixed(2)} recall=${baseline.contradicted.recall === null ? "null" : baseline.contradicted.recall.toFixed(2)}`,
		);
		console.log(`thresholds=not_run transport=offline report=${outPath}`);
		return 0;
	}

	let fetchImpl: FetchLike | undefined;
	if (args.fake) {
		fetchImpl = fakeFetch(cases, args.fake).fetch;
	} else if (!config.key) {
		const outDir = path.join(resultsRoot, "golden");
		await ensurePrivateDirectory(outDir);
		const outPath = path.join(outDir, `${runId}.json`);
		report.adoption = { adopted: false, reason: "no_key", meanPrecision: null, meanRecall: null };
		await writePrivateFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
		console.log("memory-dream golden: no_key (OPENROUTER/JEV key not configured; deterministic baseline only)");
		console.log(`baseline accuracy=${baseline.accuracy.toFixed(2)} report=${outPath}`);
		return 3;
	}

	const runConfig: JevConfig = args.fake ? { key: "fixture-key", providerOff: false, source: "env" } : config;
	const usageBefore = args.fake ? null : await usageSnapshot(config);
	const allRuns: Prediction[][] = [];
	let totalCalls = 0;
	for (let run = 0; run < args.runs; run++) {
		const predictions: Prediction[] = [];
		for (const entry of cases) {
			const claim = rawClaim(entry);
			const report = await analyzeClaimForReport(claim, baseDeps(runConfig, fetchImpl), { callJev: true });
			predictions.push({
				id: entry.id,
				expected: entry.expected,
				predicted: predictedAt({ id: entry.id, expected: entry.expected, predicted: "unverifiable", evidence: report.evidence, jev: report.jev, confidence: report.confidence }, 0),
				evidence: report.evidence,
				jev: report.jev,
				confidence: report.confidence,
			});
		}
		allRuns.push(predictions);
		totalCalls += predictions.filter(prediction => prediction.jev !== null).length;
	}

	const thresholds = THRESHOLDS.map(threshold => thresholdScore(cases, allRuns, threshold));
	const meeting = thresholds.filter(score => score.adopted);
	const selected = meeting[0] ?? thresholds.reduce((best, current) => ((current.meanF1 ?? -1) > (best.meanF1 ?? -1) ? current : best), thresholds[0]);
	const usageAfter = args.fake ? null : await usageSnapshot(config);
	const usd = usageBefore !== null && usageAfter !== null ? Math.max(0, usageAfter - usageBefore) : null;
	report.thresholds = thresholds;
	report.selectedThreshold = selected.threshold;
	report.runs = allRuns.map((predictions, index) => ({
		run: index + 1,
		predictions: predictions.map(prediction => ({
			id: prediction.id,
			expected: prediction.expected,
			predicted: predictedAt(prediction, selected.threshold),
			jev: prediction.jev?.status === "decision" ? { verdict: prediction.jev.verdict, confidence: prediction.jev.confidence } : prediction.jev,
			evidence: prediction.evidence.map(item => item.citation),
		})),
	}));
	report.adoption = {
		adopted: selected.adopted,
		meanPrecision: selected.meanPrecision,
		meanRecall: selected.meanRecall,
		meanF1: selected.meanF1,
		reason: selected.adopted ? "threshold_met" : "threshold_not_met",
	};
	report.cost = {
		measured: usd !== null,
		calls: totalCalls,
		usd,
		note: usd === null ? "OpenRouter key usage unavailable; no dollar figure claimed" : "OpenRouter key usage delta",
	};
	const outDir = path.join(resultsRoot, "golden");
	await ensurePrivateDirectory(outDir);
	const outPath = path.join(outDir, `${runId}.json`);
	await writePrivateFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
	const format = (value: number | null) => (value === null ? "null" : value.toFixed(2));
	console.log(`memory-dream golden: baseline accuracy=${baseline.accuracy.toFixed(2)} (${baseline.correct}/${baseline.total})`);
	console.log(
		`contradicted precision=${format(baseline.contradicted.precision)} recall=${format(baseline.contradicted.recall)}`,
	);
	for (const score of thresholds) {
		console.log(
			`threshold=${score.threshold.toFixed(1)} precision=${format(score.meanPrecision)} recall=${format(score.meanRecall)} f1=${format(score.meanF1)} adopted=${score.adopted}`,
		);
	}
	console.log(
		`selected=${selected.threshold.toFixed(1)} adopted=${selected.adopted} runs=${args.runs} calls=${totalCalls} usd=${usd === null ? "unmeasured" : usd.toFixed(6)}`,
	);
	console.log(`report=${outPath}`);
	return selected.adopted ? 0 : 1;
}

const status = await main();
process.exitCode = status;
