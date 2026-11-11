#!/usr/bin/env node
// Fails when any tracked file contains an absolute home path. Committed files
// must use repository-relative paths. Historical lines are hash-pinned
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
  [
    "artifacts/jjo1093-installed-surface-20261111/recorded-20261028.input.json",
    new Set([
      // Verbatim JJO-945 installer record (sha256 6bef2fc4…). Its source paths are
      // part of the hash-bound evidence, so they cannot be rewritten in place.
      "6005378b5065d4f8fa77f4a89463c366df3174e9ac53c77e7c519a89868c91d8",
      "588dd790c2024da2b125b90ffc3123cb3115c5bfee1d990d8be51dc21d077a56",
      "4769e4385710335c97315f43d7b3c2420653f81923f8d9679e84ec8ac18c8ebf",
      "1cc7d663c7ac6fb186a9bbd2c64b629a4545f4ccf155ae2bb2bf4207d51773cd",
      "ce81b2d1171619cff145e8257d3663ea6b09aa63418d9a853cfa1a018da4028a",
      "54e6c35dffeb7b2969312ee8631ae556a7cf871abe20c479b34b3ab274e8b69a",
      "03687bece82f74c82368ba7dad8f2a9e9b512763f5f568e454dc74c917f4b160",
      "0f70cba406a59293f830680a25544a9c02a4ecacb0fd3a53b68f282f4a3b744f",
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
