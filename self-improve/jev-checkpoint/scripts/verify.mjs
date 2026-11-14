#!/usr/bin/env node
// test:jev-checkpoint — plugin bundle sync check, then every unit test file.
// A skip, todo or cancellation is not a pass, and the suite must execute at least
// MIN_EXECUTED cases in total (the measured run's freeze point executed 88).
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
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

export function fileOk(status, counts) {
	return status === 0 && counts.tests > 0 && counts.pass === counts.tests && counts.fail === 0 && counts.skipped === 0 && counts.todo === 0 && counts.cancelled === 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	execFileSync(process.execPath, [path.join(root, "plugin", "scripts", "build.mjs"), "--check"], { stdio: "inherit" });
	const dir = path.join(root, "tests", "unit");
	const files = readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).sort();
	if (files.length === 0) { console.error("FAIL: no test files"); process.exit(1); }
	let failed = false;
	let executed = 0;
	for (const file of files) {
		const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(dir, file)], { encoding: "utf8" });
		const counts = tapCounts(run.stdout);
		const ok = fileOk(run.status, counts);
		executed += counts.pass ?? 0;
		console.log(`${ok ? "ok  " : "FAIL"} ${file} tests=${counts.tests} pass=${counts.pass} fail=${counts.fail} skipped=${counts.skipped}`);
		if (!ok) { failed = true; process.stdout.write(run.stdout.slice(-6000)); process.stderr.write(run.stderr.slice(-2000)); }
	}
	if (executed < MIN_EXECUTED) { console.error(`FAIL: ${executed} executed cases < floor ${MIN_EXECUTED}`); failed = true; }
	else console.log(`executed=${executed} (floor ${MIN_EXECUTED})`);
	process.exit(failed ? 1 : 0);
}
