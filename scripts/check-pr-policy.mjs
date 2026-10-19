#!/usr/bin/env node
// Static safety check for the external-PR closer and the CI triggers.
//
//   node scripts/check-pr-policy.mjs [--root <dir>]
//
// The closer must stay a no-checkout, hosted, pull_request_target-only workflow
// whose token can only write pull requests; no workflow may run on pull_request.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const rootFlag = process.argv.indexOf("--root");
const root = path.resolve(rootFlag === -1 ? process.cwd() : process.argv[rootFlag + 1]);
const workflows = path.join(root, ".github", "workflows");
const problems = [];

const closerName = "close-external-prs.yml";
let closer = "";
try {
	closer = readFileSync(path.join(workflows, closerName), "utf8");
} catch {
	problems.push(`${closerName}: missing`);
}
const code = closer
	.split("\n")
	.filter(line => !/^\s*#/.test(line))
	.join("\n");

const expect = (condition, message) => {
	if (!condition) problems.push(`${closerName}: ${message}`);
};
if (closer) {
	expect(/^on:\s*\n\s+pull_request_target:\s*\n\s+types:\s*\[opened, reopened\]\s*$/m.test(code), "trigger must be exactly pull_request_target [opened, reopened]");
	expect(!/^\s+pull_request:/m.test(code), "must not trigger on pull_request");
	expect(/^permissions:\s*\n\s+pull-requests: write\s*\n(?!\s+\S)/m.test(code), "permissions must be exactly pull-requests: write");
	expect(!/uses:/.test(code), "must not use any action (no checkout, no third-party code)");
	expect(!/checkout/.test(code), "must not check out code");
	expect(!/\$\{\{\s*secrets\./.test(code), "must not read secrets");
	expect(/runs-on: ubuntu-latest/.test(code) && !/self-hosted|arc-/.test(code), "must run on a GitHub-hosted runner");
	for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
		expect(code.includes(`author_association != '${association}'`), `must exempt ${association}`);
	}
	expect(code.includes("GH_TOKEN: ${{ github.token }}"), "GH_TOKEN must be github.token");
	expect(code.includes("GH_REPO: ${{ github.repository }}"), "GH_REPO must be github.repository");
	expect(code.includes("PR_NUMBER: ${{ github.event.pull_request.number }}"), "PR_NUMBER must come from the event via env");
	expect(code.includes('gh pr close "$PR_NUMBER" --comment'), "must close with gh pr close and a comment");
	expect(!/\$\{\{\s*github\.event\.pull_request\.(title|body|head)/.test(code), "must not interpolate pull-request content");
}

let names = [];
try {
	names = readdirSync(workflows).filter(name => /\.ya?ml$/.test(name));
} catch {
	problems.push(".github/workflows: missing");
}
for (const name of names) {
	const text = readFileSync(path.join(workflows, name), "utf8")
		.split("\n")
		.filter(line => !/^\s*#/.test(line))
		.join("\n");
	if (/^\s+pull_request:|^on:\s*\[?[^\n]*\bpull_request\b(?!_target)/m.test(text)) problems.push(`${name}: must not trigger on pull_request`);
	if (name !== closerName && /pull_request_target/.test(text)) problems.push(`${name}: only ${closerName} may use pull_request_target`);
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`pr_policy:${problem}`);
	process.exit(1);
}
console.log(`policy:check ok: ${names.length} workflows; external-PR closer is no-checkout, hosted and pull-requests: write only`);
