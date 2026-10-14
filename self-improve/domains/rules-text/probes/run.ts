#!/usr/bin/env bun
/**
 * Deterministic (non-model) rule-text integrity probe for the rules-text domain.
 *
 * Usage:
 *   bun self-improve/domains/rules-text/probes/run.ts \
 *     --baseline <repoDir> --candidate <repoDir> [--json]
 *
 * Scores structural contracts over `<dir>/docs/portfolio/AGENTS.md` on both
 * sides and prints exactly ONE JSON object on stdout. It measures rule-text
 * integrity — not behavioral effect: no model, no network, no significance
 * claim. No timers, no randomness, no absolute paths in output: identical
 * inputs always produce byte-identical stdout JSON.
 */
import path from "node:path";
import fs from "node:fs";

const SCHEMA = "gjc.self-improve.probe.v1";
const PRIMARY = "rule_text_integrity";
const TARGET = "docs/portfolio/AGENTS.md";

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

function readTarget(dir: string): string | null {
	try {
		return fs.readFileSync(path.join(dir, TARGET), "utf8");
	} catch {
		return null;
	}
}

const SUMMARY_MAX = 240;

/**
 * Short proposer-facing descriptor for one failing case, derived from the
 * case's own `provenance` (note first, then statement). Never includes held-out
 * material: the held-out corpus is excluded from failures entirely.
 */
function caseSummary(item: any, metric: string, index: number): string {
	const provenance = item && typeof item === "object" ? item.provenance : undefined;
	const note = provenance && typeof provenance === "object" ? provenance.note : undefined;
	const statement = provenance && typeof provenance === "object" ? provenance.statement : undefined;
	const detail =
		typeof note === "string" && note.trim() !== ""
			? note.trim()
			: typeof statement === "string" && statement.trim() !== ""
				? statement.trim()
				: "documented expectation not met (no provenance on this case)";
	return `${metric}#${index}: ${detail}`.slice(0, SUMMARY_MAX);
}

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** One structural contract check. Returns true when the requirement holds. */
function checkCase(item: any, text: string | null, dir: string): boolean {
	if (text === null) return false;
	switch (item?.kind) {
		case "section_present": {
			const heading = typeof item.heading === "string" ? item.heading : "";
			if (heading === "") return false;
			return new RegExp(`^${escapeRegExp(heading)}\\s*$`, "m").test(text);
		}
		case "single_h1": {
			const levels = [...text.matchAll(/^(#{1,6})\s+\S/gm)].map((match) => match[1].length);
			if (levels.filter((level) => level === 1).length !== 1) return false;
			let previous = 1;
			for (const level of levels) {
				if (level > previous + 1) return false;
				previous = level;
			}
			return true;
		}
		case "no_duplicate_heading": {
			const headings = [...text.matchAll(/^#{1,6}\s+(.+?)\s*$/gm)].map((match) => match[1].trim());
			return new Set(headings).size === headings.length;
		}
		case "exactly_once": {
			const marker = typeof item.marker === "string" ? item.marker : "";
			if (marker === "") return false;
			let count = 0;
			let from = 0;
			while (true) {
				const at = text.indexOf(marker, from);
				if (at === -1) break;
				count += 1;
				from = at + marker.length;
			}
			return count === 1;
		}
		case "relative_link_resolves": {
			const target = typeof item.target === "string" ? item.target : "";
			if (target === "") return false;
			const expected = path.posix.normalize(target);
			for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
				const href = match[1];
				if (/^(https?:|mailto:|#)/.test(href)) continue;
				const clean = href.split("#")[0];
				if (clean === "") continue;
				const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(TARGET), clean));
				if (resolved === expected && fs.existsSync(path.join(dir, resolved))) return true;
			}
			return false;
		}
		default:
			return false;
	}
}

function scoreCases(
	cases: any[],
	text: string | null,
	dir: string,
	metric: string,
): { score: number; count: number; failures: string[]; failureDetails: { label: string; summary: string }[] } {
	let hits = 0;
	const failures: string[] = [];
	const failureDetails: { label: string; summary: string }[] = [];
	for (const [index, item] of cases.entries()) {
		let ok = false;
		try {
			ok = checkCase(item, text, dir);
		} catch {
			// unexpected failure counts as a miss, never crashes the runner
			ok = false;
		}
		if (ok) hits++;
		else {
			const label = `${metric}#${index}`;
			failures.push(label);
			failureDetails.push({ label, summary: caseSummary(item, metric, index) });
		}
	}
	return { score: cases.length > 0 ? hits / cases.length : 0, count: cases.length, failures, failureDetails };
}

function evaluate(dir: string, probes: any, heldout: any) {
	const resolved = path.resolve(dir);
	const text = readTarget(resolved);
	const integrity = scoreCases(probes.cases.rule_text_integrity ?? [], text, resolved, "rule_text_integrity");
	const links = scoreCases(probes.cases.link_coverage ?? [], text, resolved, "link_coverage");
	const held = scoreCases(heldout.cases.heldout_rule_text ?? [], text, resolved, "heldout_rule_text");
	return {
		metrics: {
			rule_text_integrity: integrity.score,
			link_coverage: links.score,
		},
		counts: {
			rule_text_integrity: integrity.count,
			link_coverage: links.count,
			heldout_rule_text: held.count,
		},
		failures: {
			rule_text_integrity: integrity.failures,
			link_coverage: links.failures,
		},
		failureDetails: {
			rule_text_integrity: integrity.failureDetails,
			link_coverage: links.failureDetails,
		},
		heldout: { heldout_rule_text: held.score },
		heldoutCount: held.count,
	};
}

function main(): void {
	const baselineDir = readFlag("--baseline");
	const candidateDir = readFlag("--candidate");

	const probes = loadFixtures(PROBES_FIXTURES, "probe");
	const heldout = loadFixtures(HELDOUT_FIXTURES, "held-out");

	const baseline = evaluate(baselineDir, probes, heldout);
	const candidate = evaluate(candidateDir, probes, heldout);

	const result = {
		schema: SCHEMA,
		primary: PRIMARY,
		target: TARGET,
		baseline: baseline.metrics,
		candidate: candidate.metrics,
		delta: candidate.metrics[PRIMARY] - baseline.metrics[PRIMARY],
		heldout: {
			baseline: baseline.heldout,
			candidate: candidate.heldout,
		},
		counts: {
			rule_text_integrity: baseline.counts.rule_text_integrity,
			link_coverage: baseline.counts.link_coverage,
			heldout_rule_text: baseline.heldoutCount,
		},
		failures: {
			baseline: baseline.failures,
			candidate: candidate.failures,
		},
		failureDetails: {
			baseline: baseline.failureDetails,
			candidate: candidate.failureDetails,
		},
		notes: [
			`Metrics are deterministic, non-model structural hit rates over ${TARGET} in the baseline/candidate dirs.`,
			"Cases are declared in probes/fixtures.json; held-out parallels live in heldout/fixtures.json and are scored into heldout_rule_text only — they never appear in failures or failureDetails.",
			"failures lists per-case misses as short `<metric>#<index>` labels; failureDetails carries provenance-derived summaries (<= 240 chars) so a proposer blind to self-improve/domains/** can target the documented gap.",
			"Headroom: the shipped probe corpus keeps document-gap cases failing at migration time (one repaired case adds 1/caseCount >= floor 0.01).",
			"This probe makes no behavioral or significance claim; live behavior is separately gated and journal counters are descriptive only.",
			"No timers, network or randomness are used; identical inputs yield byte-identical stdout JSON.",
		],
	};

	process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main();
