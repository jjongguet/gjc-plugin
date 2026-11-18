#!/usr/bin/env node
// test:jev-checkpoint — plugin bundle sync check, then every unit test file.
// A skip, todo or cancellation is not a pass, zero executed tests is not a pass,
// and the suite must execute at least MIN_EXECUTED cases in total (the measured
// run's freeze point executed 88). A test that cannot run a live platform proof
// reports it with an explicit `gjc-capability: unavailable` diagnostic instead of
// skipping; the diagnostic is printed per file and in the total, and it never
// rescues a skip, a missing count or a failure.
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const MIN_EXECUTED = 88;

/** Counts from one file's TAP summary; any missing count reads as a failure. */
export function tapCounts(stdout) {
	const count = (name) => {
		const match = new RegExp(`^# ${name} (\\d+)`, "m").exec(stdout);
		return match ? Number(match[1]) : null;
	};
	return { tests: count("tests"), pass: count("pass"), fail: count("fail"), skipped: count("skipped"), todo: count("todo"), cancelled: count("cancelled") };
}

const CAPABILITY_PREFIX = "gjc-capability: unavailable";

/**
 * Explicit capability diagnostics a test may emit when a live proof is not
 * executable on this platform, e.g.
 *   # gjc-capability: unavailable capability=live_seatbelt_probe platform=linux reason=requires_darwin_sandbox
 * They are reported, not accepted: `verdict` never reads them.
 */
export function unavailableCapabilities(stdout) {
	const pattern = new RegExp(`^[ \\t]*# ${CAPABILITY_PREFIX} capability=(\\S+) platform=(\\S+) reason=(\\S+)[ \\t]*$`, "gm");
	return [...String(stdout ?? "").matchAll(pattern)].map((match) => ({ capability: match[1], platform: match[2], reason: match[3] }));
}

/** Why a file is not a pass. `no_tests_executed` keeps a zero-execution file a failure. */
export function verdict(status, counts) {
	if (status !== 0) return "nonzero_exit";
	if (!counts || !Number.isInteger(counts.tests) || counts.tests <= 0) return "no_tests_executed";
	if (!["pass", "fail", "skipped", "todo", "cancelled"].every((key) => Number.isInteger(counts[key]))) return "missing_counts";
	if (counts.fail !== 0) return "failures";
	if (counts.skipped !== 0) return "skipped";
	if (counts.todo !== 0) return "todo";
	if (counts.cancelled !== 0) return "cancelled";
	if (counts.pass !== counts.tests) return "incomplete_pass";
	return "ok";
}

export function fileOk(status, counts) {
	return verdict(status, counts) === "ok";
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	execFileSync(process.execPath, [path.join(root, "plugin", "scripts", "build.mjs"), "--check"], { stdio: "inherit" });
	const dir = path.join(root, "tests", "unit");
	const files = readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).sort();
	if (files.length === 0) { console.error("FAIL: no test files"); process.exit(1); }
	let failed = false;
	let executed = 0;
	let unavailable = 0;
	for (const file of files) {
		const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(dir, file)], { encoding: "utf8" });
		const counts = tapCounts(run.stdout);
		const reason = verdict(run.status, counts);
		const capabilities = unavailableCapabilities(run.stdout);
		unavailable += capabilities.length;
		const ok = reason === "ok";
		executed += counts.pass ?? 0;
		const reported = capabilities.map((entry) => `${entry.capability}@${entry.platform}(${entry.reason})`).join(",");
		console.log(`${ok ? "ok  " : "FAIL"} ${file} tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped}${ok ? "" : ` reason=${reason}`}${reported ? ` unavailable=${reported}` : ""}`);
		if (!ok) { failed = true; process.stdout.write(run.stdout.slice(-6000)); process.stderr.write(run.stderr.slice(-2000)); }
	}
	if (unavailable > 0) console.log(`unavailable=${unavailable} (live proof not executed on this platform; reported explicitly, never skipped)`);
	if (executed < MIN_EXECUTED) { console.error(`FAIL: ${executed} executed cases < floor ${MIN_EXECUTED}`); failed = true; }
	else console.log(`executed=${executed} (floor ${MIN_EXECUTED})`);
	process.exit(failed ? 1 : 0);
}
