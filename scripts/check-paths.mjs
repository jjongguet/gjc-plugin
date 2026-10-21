#!/usr/bin/env node
// Fails when any tracked file contains an absolute home path. Committed files
// must use repository-relative paths. Two historical lines are hash-pinned
// exceptions (they are hash-bound and kept byte-identical on purpose); any
// other absolute path, including a new line in the same file, fails.
//
//   node scripts/check-paths.mjs [--root <dir>]
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

const ALLOWED_LINES = new Map([
  [
    "self-improve/ledger.jsonl",
    new Set([
      // seq 15 policy row: append-only, hash-chained, cited in evidence/README.md.
      "d77c8104e8122383c8850b549f97d71524073fc0f645217ad35b3be1c4af44f7",
    ]),
  ],
  [
    "self-improve/evidence/p2b/replay-b0b1.json",
    new Set([
      // Literal output of the frozen replay command; rewriting it would break the receipt.
      "79392b9dfc5b948e0079b027f452bf7f4d7a3db4d5ce7b1c407699f03991e97c",
    ]),
  ],
]);
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
let allowlisted = 0;
for (const file of files) {
	let text;
	try {
		text = readFileSync(path.join(root, file), "utf8");
	} catch (error) {
		console.error(`paths:check: cannot read tracked file ${file}: ${error.message}`);
		process.exit(2);
	}
	const allowed = ALLOWED_LINES.get(file) ?? new Set();
	text.split("\n").forEach((line, index) => {
		if (!ABSOLUTE_HOME.test(line)) return;
		const digest = createHash("sha256").update(line).digest("hex");
		if (allowed.has(digest)) {
			allowlisted += 1;
			return;
		}
		findings.push(`${file}:${index + 1}`);
	});
}

if (findings.length > 0) {
	for (const finding of findings) console.error(`absolute_home_path:${finding}`);
	console.error(`paths:check failed: ${findings.length} line(s); write repository-relative paths (see self-improve/evidence/README.md)`);
	process.exit(1);
}
console.log(`paths:check ok: ${files.length} tracked files, ${allowlisted} allowlisted hash-pinned line(s)`);
