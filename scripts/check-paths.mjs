#!/usr/bin/env node
// Fails when any tracked file contains an absolute home path. Committed files
// must use repository-relative paths; the two historical hash-bound files
// listed in self-improve/evidence/README.md stay allowlisted exactly.
//
//   node scripts/check-paths.mjs [--root <dir>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ALLOWLIST = new Set(["self-improve/ledger.jsonl", "self-improve/evidence/p2b/replay-b0b1.json"]);
const ABSOLUTE_HOME = /(?:^|[\s"'`(=:,[]|file:\/\/)(\/Users\/[^\s"'`/]+|\/home\/[^\s"'`/]+|[A-Za-z]:\\{1,2}Users\\{1,2}[^\s"'`\\]+)/i;

const rootFlag = process.argv.indexOf("--root");
const root = path.resolve(rootFlag === -1 ? process.cwd() : process.argv[rootFlag + 1]);

let files;
try {
	files = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" }).split("\0").filter(Boolean);
} catch {
	console.error(`paths:check: ${root} is not a git checkout`);
	process.exit(2);
}

const findings = [];
for (const file of files) {
	if (ALLOWLIST.has(file)) continue;
	let text;
	try {
		text = readFileSync(path.join(root, file), "utf8");
	} catch {
		continue;
	}
	text.split("\n").forEach((line, index) => {
		if (ABSOLUTE_HOME.test(line)) findings.push(`${file}:${index + 1}`);
	});
}

if (findings.length > 0) {
	for (const finding of findings) console.error(`absolute_home_path:${finding}`);
	console.error(`paths:check failed: ${findings.length} line(s); write repository-relative paths (see self-improve/evidence/README.md)`);
	process.exit(1);
}
console.log(`paths:check ok: ${files.length} tracked files, ${ALLOWLIST.size} allowlisted hash-bound files`);
