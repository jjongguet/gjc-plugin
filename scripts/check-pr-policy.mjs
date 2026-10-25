#!/usr/bin/env node
// Static safety check for the repository's workflows.
//
//   node scripts/check-pr-policy.mjs [--root <dir>]
//
// Trusted main CI may run on the self-hosted runner because it only runs on
// pushes to main. Pull-request code may only run through the owner-dispatched
// pr-validate.yml lane, on a GitHub-hosted runner, without secrets or write
// tokens, pinned to the reviewed commit. While the external-PR closer still
// exists, it must stay a no-checkout, hosted, pull_request_target-only workflow
// whose token can only write pull requests.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const rootFlag = process.argv.indexOf("--root");
const root = path.resolve(rootFlag === -1 ? process.cwd() : process.argv[rootFlag + 1]);
const workflows = path.join(root, ".github", "workflows");
const problems = [];
const report = message => problems.push(message);

function code(file) {
	return readFileSync(path.join(workflows, file), "utf8")
		.split("\n")
		.filter(line => !/^\s*#/.test(line))
		.join("\n");
}

function section(text, key) {
	const lines = text.split("\n");
	const start = lines.findIndex(line => new RegExp(`^${key}:\\s*(#.*)?$`).test(line));
	if (start === -1) return null;
	const body = [];
	for (const line of lines.slice(start + 1)) {
		if (line.trim() !== "" && !/^\s/.test(line)) break;
		body.push(line);
	}
	return body.join("\n");
}

function jobs(text) {
	const body = section(text, "jobs");
	if (body === null) return new Map();
	const found = new Map();
	let current = null;
	for (const line of body.split("\n")) {
		const match = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
		if (match) {
			current = match[1];
			found.set(current, []);
			continue;
		}
		if (current) found.get(current).push(line);
	}
	return new Map([...found].map(([name, lines]) => [name, lines.join("\n")]));
}

function runBlocksInterpolate(text) {
	const lines = text.split("\n");
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const match = /^(\s*)(?:- )?run:\s*([|>])?/.exec(line);
		if (!match) continue;
		const indent = match[1].length;
		// Single-line `run:` carries the same shell-injection risk as a block.
		if (!match[2]) {
			if (/\$\{\{/.test(line.slice(match[0].length))) return line.trim();
			continue;
		}
		for (let next = index + 1; next < lines.length; next += 1) {
			const body = lines[next];
			if (body.trim() !== "" && body.search(/\S/) <= indent) break;
			if (/\$\{\{/.test(body)) return body.trim();
		}
	}
	return null;
}

// `on:` may be block style, flow style (`on: {pull_request: ...}`) or an
// inline array (`on: [push, pull_request]`). All three carry the same risk.
function automaticTrigger(text) {
	const flow = /^on:\s*[\[{](.*)$/m.exec(text);
	if (flow) {
		const rest = flow[1];
		const match = /\b(pull_request|pull_request_target)\b/.exec(rest);
		if (match) return match[1];
	}
	return null;
}

// Generated surfaces under each plugin's tools/ and hooks/ are committed, and
// `bun run build` rewrites them in place. A lane that builds before comparing,
// or that never proves the build left the committed files untouched, reports
// green while main carries stale artifacts: the later `--check` fixtures read
// the repaired tree (JJO-784). Order and gate are enforced per lane.
function checkGeneratedSurfaceGate(label, text) {
	const lines = text.split("\n");
	const check = lines.findIndex(line => /run: bun run build:check\s*$/.test(line));
	const build = lines.findIndex(line => /run: bun run build\s*$/.test(line));
	const gate = lines.findIndex(line => line.includes("git status --porcelain"));
	const gateFails = gate !== -1 && lines.slice(gate).some(line => /^\s+exit 1\s*$/.test(line));
	if (check === -1) report(`${label}: must run bun run build:check`);
	if (build === -1) report(`${label}: must run bun run build`);
	if (check !== -1 && build !== -1 && check > build) report(`${label}: must check generated surfaces before bun run build rewrites them`);
	if (gate === -1) report(`${label}: must assert bun run build left the committed tree unchanged (git status --porcelain)`);
	else if (build !== -1 && gate < build) report(`${label}: the unchanged-tree gate must run after bun run build`);
	if (gate !== -1 && !gateFails) report(`${label}: the unchanged-tree gate must exit non-zero on drift`);
}

let names = [];
try {
	names = readdirSync(workflows).filter(name => /\.ya?ml$/.test(name));
} catch {
	report(".github/workflows: missing");
}

for (const name of names) {
	const text = code(name);
	const flowTrigger = automaticTrigger(text);
	if (flowTrigger === "pull_request") report(`${name}: must not trigger on pull_request`);
	if (flowTrigger === "pull_request_target" && name !== "close-external-prs.yml") report(`${name}: only close-external-prs.yml may use pull_request_target`);
	if (/^\s{0,2}pull_request:/m.test(text)) report(`${name}: must not trigger on pull_request`);
	if (/^\s{0,2}pull_request_target:/m.test(text) && name !== "close-external-prs.yml") report(`${name}: only close-external-prs.yml may use pull_request_target`);
	for (const line of text.split("\n")) {
		const use = /^\s*(?:- )?uses:\s*(\S+)/.exec(line);
		if (use && !/@[0-9a-f]{40}$/.test(use[1])) report(`${name}: action ${use[1]} must be pinned to a full commit SHA`);
	}
	const interpolated = runBlocksInterpolate(text);
	if (interpolated) report(`${name}: run blocks must read inputs from env, found ${interpolated}`);
}

// --- Owner-dispatched pull-request lane -------------------------------------
const laneName = "pr-validate.yml";
if (!existsSync(path.join(workflows, laneName))) {
	report(`${laneName}: missing`);
} else {
	const text = code(laneName);
	const on = section(text, "on");
	if (!on || !/^ {2}workflow_dispatch:\s*$/m.test(on)) report(`${laneName}: trigger must be workflow_dispatch only`);
	if (on && /^ {2}(push|pull_request|pull_request_target|schedule):/m.test(on)) report(`${laneName}: no automatic trigger is allowed`);
	if (!/^permissions:\s*\n {2}contents: read\s*$/m.test(text)) report(`${laneName}: top-level permissions must be exactly contents: read`);
	for (const required of ["pr_number", "head_sha"]) {
		if (!new RegExp(`^ {6}${required}:\\s*$`, "m").test(text)) report(`${laneName}: missing workflow_dispatch input ${required}`);
	}
	const laneJobs = jobs(text);
	for (const name of ["preflight", "candidate", "verify"]) {
		if (!laneJobs.has(name)) report(`${laneName}: missing job ${name}`);
	}

	const preflight = laneJobs.get("preflight") ?? "";
	// Build the expression markers without writing a template placeholder.
	const marker = expression => ["$", "{", "{ ", expression, " }", "}"].join("");
	const guardExpressions = { ACTOR: "github.actor", TRIGGERING_ACTOR: "github.triggering_actor", REPO: "github.repository", REF: "github.ref" };
	for (const [guard, expression] of Object.entries(guardExpressions)) {
		if (!preflight.includes(marker(expression))) report(`${laneName}: preflight must read ${expression} into the environment (${guard})`);
	}
	if (!/test "\$ACTOR" = "jjongguet"/.test(preflight)) report(`${laneName}: preflight must require the owner as dispatch actor`);
	if (!/test "\$TRIGGERING_ACTOR" = "jjongguet"/.test(preflight)) report(`${laneName}: preflight must require the owner as rerun actor`);
	if (!/test "\$REF" = "refs\/heads\/main"/.test(preflight)) report(`${laneName}: preflight must require dispatch from main`);
	if (!/test "\$head" = "\$REVIEWED_SHA"/.test(preflight)) report(`${laneName}: preflight must compare the reviewed SHA with the pull request head`);

	const candidate = laneJobs.get("candidate") ?? "";
	if (!/runs-on: ubuntu-latest/.test(candidate)) report(`${laneName}: candidate must run on a GitHub-hosted runner`);
	if (/self-hosted|arc-/.test(candidate)) report(`${laneName}: candidate must not use the self-hosted runner`);
	if (/secrets\./.test(candidate)) report(`${laneName}: candidate must not read secrets`);
	if (/:\s*write\b/.test(candidate)) report(`${laneName}: candidate must not hold write permissions`);
	if (!/persist-credentials: false/.test(candidate)) report(`${laneName}: candidate checkout must set persist-credentials: false`);
	if (!/no-cache: true/.test(candidate)) report(`${laneName}: candidate bun setup must set no-cache: true`);
	if (!/ref: refs\/pull\/\$\{\{ inputs\.pr_number \}\}\/head/.test(candidate)) report(`${laneName}: candidate must check out the pull request head ref`);
	if (!/test "\$actual" = "\$REVIEWED_SHA"/.test(candidate)) report(`${laneName}: candidate must assert the checked-out SHA equals the reviewed SHA`);
	checkGeneratedSurfaceGate(`${laneName}: candidate`, candidate);

	const verify = laneJobs.get("verify") ?? "";
	if (!/contents: read/.test(verify) || !/statuses: write/.test(verify)) report(`${laneName}: verify must hold contents: read and statuses: write only`);
	if (/ref: refs\/pull\//.test(verify)) report(`${laneName}: verify must not check out pull-request code`);
	if (!/node scripts\/check-pr-policy\.mjs --root \.pr-head/.test(verify)) report(`${laneName}: verify must run the trusted policy checker over the pull request workflows`);
	if (!/CANDIDATE_RESULT/.test(verify) || !/test "\$CANDIDATE_RESULT" = "success"/.test(verify)) report(`${laneName}: verify must require a successful candidate run`);
	if (!/test "\$head" = "\$REVIEWED_SHA"/.test(verify)) report(`${laneName}: verify must re-check the head SHA after the candidate run`);
	if (!/statuses\/\$REVIEWED_SHA/.test(verify)) report(`${laneName}: verify must post the SHA-bound status receipt`);
}

// --- Trusted push CI --------------------------------------------------------
const ciName = "ci.yml";
if (!existsSync(path.join(workflows, ciName))) {
	report(`${ciName}: missing`);
} else {
	const text = code(ciName);
	const on = section(text, "on");
	if (!on || !/^ {2}push:\s*$/m.test(on) || !/branches: \[main\]/.test(on)) report(`${ciName}: trigger must be push to main only`);
	if (/self-hosted/.test(text)) report(`${ciName}: use the arc-ci label, not a self-hosted literal`);
	if (!/no-cache: true/.test(text)) report(`${ciName}: bun setup must set no-cache: true so a pull request cannot seed a restore path`);
	checkGeneratedSurfaceGate(ciName, text);
}

// --- Legacy external-PR closer (only while it exists) -----------------------
const closerName = "close-external-prs.yml";
if (existsSync(path.join(workflows, closerName))) {
	const text = code(closerName);
	const expect = (condition, message) => {
		if (!condition) report(`${closerName}: ${message}`);
	};
	expect(/^on:\s*\n\s+pull_request_target:\s*\n\s+types:\s*\[opened, reopened\]\s*$/m.test(text), "trigger must be exactly pull_request_target [opened, reopened]");
	expect(/^permissions:\s*\n\s+pull-requests: write\s*\n(?!\s+\S)/m.test(text), "permissions must be exactly pull-requests: write");
	expect(!/uses:/.test(text), "must not use any action (no checkout, no third-party code)");
	expect(!/checkout/.test(text), "must not check out code");
	expect(!/\$\{\{\s*secrets\./.test(text), "must not read secrets");
	expect(/runs-on: ubuntu-latest/.test(text) && !/self-hosted|arc-/.test(text), "must run on a GitHub-hosted runner");
	for (const association of ["OWNER", "MEMBER", "COLLABORATOR"]) {
		expect(text.includes(`author_association != '${association}'`), `must exempt ${association}`);
	}
	expect(text.includes("GH_TOKEN: ${{ github.token }}"), "GH_TOKEN must be github.token");
	expect(text.includes("GH_REPO: ${{ github.repository }}"), "GH_REPO must be github.repository");
	expect(text.includes("PR_NUMBER: ${{ github.event.pull_request.number }}"), "PR_NUMBER must come from the event via env");
	expect(text.includes('gh pr close "$PR_NUMBER" --comment'), "must close with gh pr close and a comment");
	expect(!/\$\{\{\s*github\.event\.pull_request\.(title|body|head)/.test(text), "must not interpolate pull-request content");
}

if (problems.length > 0) {
	for (const problem of problems) console.error(`pr_policy:${problem}`);
	process.exit(1);
}
console.log(`policy:check ok: ${names.length} workflows; owner-dispatched pull-request lane is hosted, secret-free, pinned and verified`);
