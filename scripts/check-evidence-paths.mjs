#!/usr/bin/env node
// Fails when a tracked file under self-improve/ contains an absolute home path.
// Committed evidence must be repository-relative; the two historical files listed
// in self-improve/evidence/README.md are hash-bound and allowlisted exactly.
//
//   node scripts/check-evidence-paths.mjs [--root <dir>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ALLOWLIST = new Set(["self-improve/ledger.jsonl", "self-improve/evidence/p2b/replay-b0b1.json"]);
const ABSOLUTE_HOME = /(?:^|[\s"'`(=:,[])(\/Users\/[^\s"'`/]+|\/home\/[^\s"'`/]+|[A-Za-z]:\\\\?Users\\\\?[^\s"'`\\]+)/;

const rootFlag = process.argv.indexOf("--root");
const root = path.resolve(rootFlag === -1 ? process.cwd() : process.argv[rootFlag + 1]);

let files;
try {
	files = execFileSync("git", ["ls-files", "-z", "--", "self-improve"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
} catch {
	console.error(`evidence:check: ${root} is not a git checkout`);
	process.exit(2);
}

const findings = [];
for (const file of files) {
	if (ALLOWLIST.has(file)) continue;
	const lines = readFileSync(path.join(root, file), "utf8").split("\n");
	lines.forEach((line, index) => {
		if (ABSOLUTE_HOME.test(line)) findings.push(`${file}:${index + 1}`);
	});
}

if (findings.length > 0) {
	for (const finding of findings) console.error(`absolute_home_path:${finding}`);
	console.error(`evidence:check failed: ${findings.length} line(s); write repository-relative paths (see self-improve/evidence/README.md)`);
	process.exit(1);
}
console.log(`evidence:check ok: ${files.length} tracked self-improve files, ${ALLOWLIST.size} allowlisted hash-bound files`);
