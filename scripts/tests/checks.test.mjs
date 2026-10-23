// Fixture tests for the repository check scripts: each runs against a
// temporary git repository through --root and must pass on clean input and
// fail with its documented marker on violating input.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const NODE = process.execPath;
// Absolute home paths are assembled at runtime so this fixture file itself stays
// free of literal home paths (checked by scripts/check-paths.mjs).
const HOME_PATHS = {
	alice: "/Users/" + "alice",
	bob: "/home/" + "bob",
	carol: "C:\\\\Users\\\\" + "carol",
	dave: "c:\\\\users\\\\" + "dave",
	erin: "/Users/" + "erin",
};

function fixture(files) {
	const root = mkdtempSync(join(tmpdir(), "gjc-plugin-checks-"));
	for (const [name, content] of Object.entries(files)) {
		mkdirSync(dirname(join(root, name)), { recursive: true });
		writeFileSync(join(root, name), content);
	}
	execFileSync("git", ["init", "-q"], { cwd: root });
	execFileSync("git", ["add", "."], { cwd: root });
	return root;
}

function run(script, root) {
	const result = spawnSync(NODE, [join(REPO, "scripts", script), "--root", root], { encoding: "utf8" });
	return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

test("docs:check passes resolvable links and ignores external links and code", () => {
	const root = fixture({
		"README.md": [
			"[ok](docs/a.md#part) ![img](docs/a.md) [ext](https://example.com) [proto](//cdn.example.com/x.png) [anchor](#top)",
			"",
			"```",
			"[fenced](missing.md)",
			"```",
			"> ```",
			"> [quoted fence](missing.md)",
			"> ```",
			"",
			"    [indented code](missing.md)",
			"",
			"`[inline](missing.md)`",
			"[ref]: docs/a.md",
		].join("\n"),
		"docs/a.md": "# A\n",
	});
	try {
		const result = run("check-doc-links.mjs", root);
		assert.equal(result.status, 0, result.out);
		assert.match(result.out, /docs:check ok: 3 relative links/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("docs:check fails on missing targets, reference links, escapes and bad encoding", () => {
	const root = fixture({
		"README.md": ["[missing](missing.md)", "![img](missing.png)", "[ref]: gone.md", "[escape](../outside.md)", "[bad](%E0%A4%A.md)"].join("\n"),
	});
	try {
		const result = run("check-doc-links.mjs", root);
		assert.equal(result.status, 1, result.out);
		for (const href of ["missing.md", "missing.png", "gone.md", "../outside.md", "%E0%A4%A.md"]) assert.ok(result.out.includes(`: ${href}`), `${href} must be reported\n${result.out}`);
		assert.match(result.out, /docs:check failed: 5 broken/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("evidence:check allows repository-relative paths and the two hash-bound files", () => {
	const root = fixture({
		"self-improve/notes.md": "Stores live under ~/.gjc-plugin/ and repo-relative self-improve/ledger.jsonl.\n",
		"self-improve/ledger.jsonl": `{"path":"${HOME_PATHS.alice}/repo"}\n`,
		"self-improve/evidence/p2b/replay-b0b1.json": `{"ledgerPath":"${HOME_PATHS.alice}/repo/self-improve/ledger.jsonl"}\n`,
	});
	try {
		const result = run("check-evidence-paths.mjs", root);
		assert.equal(result.status, 0, result.out);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("evidence:check fails on absolute home paths in any other tracked file", () => {
	const root = fixture({
		"self-improve/a.json": `{"p":"${HOME_PATHS.alice}/x"}\n`,
		"self-improve/b.log": `cwd=${HOME_PATHS.bob}/work\n`,
		"self-improve/c.txt": `${HOME_PATHS.carol}\\x\n`,
		"self-improve/d.txt": `${HOME_PATHS.dave}\\x\n`,
		"self-improve/e.md": `see file://${HOME_PATHS.erin}/x\n`,
	});
	try {
		const result = run("check-evidence-paths.mjs", root);
		assert.equal(result.status, 1, result.out);
		for (const file of ["a.json", "b.log", "c.txt", "d.txt", "e.md"]) assert.ok(result.out.includes(`absolute_home_path:self-improve/${file}:1`), `${file}\n${result.out}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("paths:check passes repository-relative paths and allowlisted hash-bound files", () => {
	const ledgerLine = readFileSync(join(REPO, "self-improve", "ledger.jsonl"), "utf8").split("\n").find(line => line.includes('"policyId":"pi-1-25"'));
	const replayLine = readFileSync(join(REPO, "self-improve", "evidence", "p2b", "replay-b0b1.json"), "utf8").split("\n").find(line => line.includes('"ledgerPath"'));
	assert.ok(ledgerLine && replayLine, "the two hash-pinned lines must exist");
	const root = fixture({
		"README.md": "Repository-relative self-improve/ledger.jsonl and ~/.gjc-plugin/ paths only.\n",
		"self-improve/ledger.jsonl": `${ledgerLine}\n`,
		"self-improve/evidence/p2b/replay-b0b1.json": `${replayLine}\n`,
	});
	try {
		const result = run("check-paths.mjs", root);
		assert.equal(result.status, 0, result.out);
		assert.match(result.out, /paths:check ok: 3 tracked files/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("paths:check fails on absolute home paths outside the allowlist", () => {
	const root = fixture({
		"docs/a.md": `cwd ${HOME_PATHS.alice}/repo\n`,
		"rrsi/b.ts": `const p = '${HOME_PATHS.bob}/x';\n`,
		"README.md": `${HOME_PATHS.carol}\\x\n`,
	});
	try {
		const result = run("check-paths.mjs", root);
		assert.equal(result.status, 1, result.out);
		for (const file of ["docs/a.md", "rrsi/b.ts", "README.md"]) assert.ok(result.out.includes(`absolute_home_path:${file}:1`), `${file}\n${result.out}`);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("audit-claims checker validates a row and rejects an unlisted sentence", () => {
	const row = spawnSync(NODE, [join(REPO, "scripts", "check-audit-claims.mjs"), "--row", "K0001", "--allow-worktree-fallback"], { encoding: "utf8" });
	assert.equal(row.status, 0, `${row.stdout}${row.stderr}`);
	assert.match(row.stdout, /row=K0001 ok/);
	const unlisted = spawnSync(NODE, [join(REPO, "scripts", "check-audit-claims.mjs"), "--require-candidate", "README.md#1#THIS SENTENCE IS NOT IN THE GRAPH"], { encoding: "utf8" });
	assert.equal(unlisted.status, 1, `${unlisted.stdout}${unlisted.stderr}`);
	assert.match(unlisted.stderr, /candidate sentence has no candidates\.jsonl row/);
});

test("every plugin build --check passes in sync and fails on generated-surface drift", () => {
	const plugins = JSON.parse(readFileSync(join(REPO, "gjc-plugin.json"), "utf8")).plugins.map(manifest => dirname(manifest));
	assert.equal(plugins.length, 8);
	// Builders inline sibling sources (shared/, verification-receipts/lib, self-improve/lib), so copy the tracked tree once.
	const root = mkdtempSync(join(tmpdir(), "gjc-plugin-build-"));
	try {
		// A filesystem copy (not git ls-files) so the test also runs inside the self-improve scratch export, which has no .git.
		const skip = new Set([".git", ".gjc", "node_modules", ".next"]);
		cpSync(REPO, root, { recursive: true, filter: source => !skip.has(basename(source)) });
		for (const plugin of plugins) {
			const build = join(root, plugin, "scripts", "build.mjs");
			const clean = spawnSync("bun", [build, "--check"], { encoding: "utf8" });
			assert.equal(clean.status, 0, `${plugin}: ${clean.stdout}${clean.stderr}`);
			const generated = join(root, plugin, "tools", readdirSync(join(root, plugin, "tools")).sort()[0]);
			writeFileSync(generated, `${readFileSync(generated, "utf8")}// drift\n`);
			const drifted = spawnSync("bun", [build, "--check"], { encoding: "utf8" });
			assert.equal(drifted.status, 1, `${plugin} must fail on drift: ${drifted.stdout}${drifted.stderr}`);
			assert.match(drifted.stderr, /generated_out_of_sync|out of sync|drift/i, plugin);
			assert.ok(readFileSync(generated, "utf8").endsWith("// drift\n"), `${plugin} --check must not rewrite files`);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

function policyFixture(mutate) {
	const root = mkdtempSync(join(tmpdir(), "gjc-plugin-policy-"));
	cpSync(join(REPO, ".github", "workflows"), join(root, ".github", "workflows"), { recursive: true });
	if (mutate) {
		const file = join(root, ".github", "workflows", mutate.file ?? "close-external-prs.yml");
		writeFileSync(file, mutate.edit(readFileSync(file, "utf8")));
	}
	return root;
}

test("policy:check passes the committed workflows", () => {
	const root = policyFixture(null);
	try {
		const result = run("check-pr-policy.mjs", root);
		assert.equal(result.status, 0, result.out);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("policy:check rejects every unsafe change to the closer or CI triggers", () => {
	const mutations = [
		["extra permission", { edit: text => text.replace("  pull-requests: write\n", "  pull-requests: write\n  contents: write\n") }, /permissions must be exactly/],
		["checkout step", { edit: text => text.replace("    steps:\n", "    steps:\n      - uses: actions/checkout@v5\n") }, /must not use any action/],
		["self-hosted runner", { edit: text => text.replace("runs-on: ubuntu-latest", "runs-on: arc-ci") }, /GitHub-hosted runner/],
		["secret token", { edit: text => text.replace("GH_TOKEN: ${{ github.token }}", "GH_TOKEN: ${{ secrets.PAT }}") }, /must not read secrets/],
		["owner exemption dropped", { edit: text => text.replace(" &&\n      github.event.pull_request.author_association != 'OWNER'", "").replace("github.event.pull_request.author_association != 'OWNER' &&\n      ", "") }, /must exempt OWNER/],
		["pull-request content interpolated", { edit: text => text.replace('"$PR_NUMBER" --comment', '"$PR_NUMBER" --comment "${{ github.event.pull_request.title }}"') }, /must not interpolate/],
		["pull_request trigger in CI", { file: "ci.yml", edit: text => text.replace("on:\n  push:", "on:\n  pull_request:\n  push:") }, /ci\.yml: must not trigger on pull_request/],
	];
	const closerExists = existsSync(join(REPO, ".github", "workflows", "close-external-prs.yml"));
	for (const [name, mutate, pattern] of mutations) {
		if (!closerExists && (mutate.file ?? "close-external-prs.yml") === "close-external-prs.yml") continue;
		const root = policyFixture(mutate);
		try {
			const result = run("check-pr-policy.mjs", root);
			assert.equal(result.status, 1, `${name}: ${result.out}`);
			assert.match(result.out, pattern, name);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

test("policy:check rejects unsafe changes to the owner-dispatched pull-request lane", () => {
	const lane = "pr-validate.yml";
	const mutations = [
		["unpinned action", { file: lane, edit: text => text.replace("actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5", "actions/checkout@v5") }, /must be pinned to a full commit SHA/],
		["secret in the candidate job", { file: lane, edit: text => text.replace("    timeout-minutes: 40\n", "    timeout-minutes: 40\n    env:\n      LEAK: ${{ secrets.ANY }}\n") }, /candidate must not read secrets/],
		["self-hosted candidate", { file: lane, edit: text => text.replace("    needs: preflight\n    runs-on: ubuntu-latest", "    needs: preflight\n    runs-on: arc-ci") }, /candidate must not use the self-hosted runner/],
		["owner guard dropped", { file: lane, edit: text => text.replace('test "$ACTOR" = "jjongguet" || { echo "dispatch actor must be the repository owner"; exit 1; }\n', "") }, /preflight must require the owner as dispatch actor/],
		["input interpolated into run", { file: lane, edit: text => text.replace('echo "checked out $actual"', 'echo "checked out ${{ inputs.head_sha }}"') }, /run blocks must read inputs from env/],
		["cache enabled for the candidate", { file: lane, edit: text => text.replace("          no-cache: true", "          no-cache: false") }, /candidate bun setup must set no-cache: true/],
		["verify checks out pull-request code", { file: lane, edit: text => text.replace("    steps:\n      - name: Check out trusted main\n        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5\n        with:\n          persist-credentials: false\n", "    steps:\n      - name: Check out trusted main\n        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5\n        with:\n          persist-credentials: false\n          ref: refs/pull/1/head\n") }, /verify must not check out pull-request code/],
		["receipt status write removed", { file: lane, edit: text => text.replace("      statuses: write\n", "") }, /verify must hold contents: read and statuses: write only/],
		["automatic trigger added", { file: lane, edit: text => text.replace("on:\n  workflow_dispatch:", "on:\n  pull_request:\n  workflow_dispatch:") }, /must not trigger on pull_request/],
		["flow-style pull_request trigger", { file: lane, edit: text => text.replace("on:\n  workflow_dispatch:", "on: {pull_request: {}}\n  workflow_dispatch:") }, /must not trigger on pull_request/],
		["inline array pull_request trigger", { file: lane, edit: text => text.replace("on:\n  workflow_dispatch:", "on: [push, pull_request]\n  workflow_dispatch:") }, /must not trigger on pull_request/],
		["single-line run interpolation", { file: lane, edit: text => text.replace('      - name: Assert the checkout is the reviewed SHA\n', '      - name: Assert the checkout is the reviewed SHA\n        run: echo "${{ inputs.pr_number }}"\n') }, /run blocks must read inputs from env/],
	];
	for (const [name, mutate, pattern] of mutations) {
		const root = policyFixture(mutate);
		try {
			const result = run("check-pr-policy.mjs", root);
			assert.equal(result.status, 1, `${name}: ${result.out}`);
			assert.match(result.out, pattern, name);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}
});

function fakeGjc(output, status = 0) {
	const bin = mkdtempSync(join(tmpdir(), "gjc-plugin-fake-gjc-"));
	writeFileSync(join(bin, "gjc"), `#!/bin/sh\necho '${output}'\nexit ${status}\n`, { mode: 0o755 });
	return bin;
}

test("onboarding smoke names the missing or unsupported prerequisite", async () => {
	const { prerequisiteProblem, MIN_GJC } = await import("../onboarding-smoke.mjs");
	const empty = mkdtempSync(join(tmpdir(), "gjc-plugin-empty-path-"));
	const old = fakeGjc("gjc/0.17.9");
	const current = fakeGjc(`gjc/${MIN_GJC}`);
	const broken = fakeGjc("boom", 3);
	try {
		assert.match(prerequisiteProblem({ PATH: empty }), /`gjc` is not on PATH; install gajae-code/);
		assert.match(prerequisiteProblem({ PATH: old }), /gjc 0\.17\.9 is older than the verified/);
		assert.match(prerequisiteProblem({ PATH: broken }), /`gjc --version` failed \(exit 3\)/);
		assert.match(prerequisiteProblem({ PATH: current }, "20.11.0"), /Node\.js 20\.11\.0 is older than 22/);
		assert.equal(prerequisiteProblem({ PATH: current }, "22.0.0"), null);
		const cli = spawnSync(NODE, [join(REPO, "scripts", "onboarding-smoke.mjs")], { encoding: "utf8", env: { PATH: empty, HOME: empty } });
		assert.equal(cli.status, 2, cli.stderr);
		assert.match(cli.stderr, /onboarding:smoke: prerequisite — `gjc` is not on PATH/);
	} finally {
		for (const dir of [empty, old, current, broken]) rmSync(dir, { recursive: true, force: true });
	}
});

test("onboarding smoke reads the report and ignores the journal line", async () => {
	const { parseToolReport } = await import("../onboarding-smoke.mjs");
	const text = 'backplan_check: invalid\n{"status":"invalid","errors":["plan.end_state: required"]}\n{"journalStorage":{"persisted":true}}';
	assert.deepEqual(parseToolReport(text), { status: "invalid", errors: ["plan.end_state: required"] });
	assert.throws(() => parseToolReport("backplan_check: invalid_input — no JSON"), /without a JSON report/);
});
