#!/usr/bin/env node
// test:jev-checkpoint — plugin bundle sync check, then every unit test file.
// Fails when a test file reports zero tests (a skipped or empty suite is not a pass).
import { execFileSync, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
execFileSync(process.execPath, [path.join(root, "plugin", "scripts", "build.mjs"), "--check"], { stdio: "inherit" });
const dir = path.join(root, "tests", "unit");
const files = readdirSync(dir).filter((name) => name.endsWith(".test.mjs")).sort();
if (files.length === 0) { console.error("FAIL: no test files"); process.exit(1); }
let failed = false;
for (const file of files) {
	const run = spawnSync(process.execPath, ["--test", "--test-reporter=tap", path.join(dir, file)], { encoding: "utf8" });
	const tests = Number(/^# tests (\d+)/m.exec(run.stdout)?.[1] ?? 0);
	const fail = Number(/^# fail (\d+)/m.exec(run.stdout)?.[1] ?? 1);
	const ok = run.status === 0 && tests > 0 && fail === 0;
	console.log(`${ok ? "ok  " : "FAIL"} ${file} tests=${tests} fail=${fail}`);
	if (!ok) { failed = true; process.stdout.write(run.stdout.slice(-6000)); process.stderr.write(run.stderr.slice(-2000)); }
}
process.exit(failed ? 1 : 0);
