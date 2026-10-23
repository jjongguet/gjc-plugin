// Reproduces the ultragoal quality-gate evidence contract in docs/ultragoal-gate-evidence.md
// against the installed `gjc`. Everything runs in a disposable repository and HOME with a
// synthetic session id; it skips with a recorded reason when no `gjc` binary is on PATH.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";

function which(name) {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		try {
			if (statSync(join(directory, name)).isFile()) return join(directory, name);
		} catch {
			// Try the next PATH entry.
		}
	}
	return null;
}
const GJC = which("gjc");
const BUN = which("bun");
const SCRIPT = which("script");

function fixture() {
	const owned = realpathSync(mkdtempSync(join(tmpdir(), "ultragoal-gate-")));
	const repo = join(owned, "repo");
	const home = join(owned, "home");
	mkdirSync(join(repo, "artifacts"), { recursive: true });
	mkdirSync(home);
	const env = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C", GJC_SESSION_ID: "ultragoal-gate-fixture" };
	const git = (...args) => {
		const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
		assert.equal(result.status, 0, result.stderr);
	};
	git("init", "-q", "-b", "main");
	git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture");
	const gjc = (...args) => spawnSync(GJC, args, { cwd: repo, env, encoding: "utf8", timeout: 60000 });
	let serial = 0;
	// Gate files live outside the repository: anything inside it is part of the hashed source basis.
	const scratch = (name, content) => {
		const file = join(owned, `${serial++}-${name}`);
		writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
		return file;
	};
	const write = (relative, content) => {
		mkdirSync(join(repo, relative, ".."), { recursive: true });
		writeFileSync(join(repo, relative), content);
	};
	const scaffold = (surface) => {
		const out = join(owned, `${serial++}-${surface}-scaffold.json`);
		const init = gjc("ultragoal", "quality-gate", "init", "--surface", surface, "--out", out);
		assert.equal(init.status, 0, `${init.stdout}${init.stderr}`);
		return JSON.parse(readFileSync(out, "utf8"));
	};
	const validate = (gate) => {
		// Untracked artifacts are hashed too, so the hash is taken after every artifact is written.
		const hashed = gjc("ultragoal", "quality-gate", "source-hash", "--json");
		assert.equal(hashed.status, 0, `${hashed.stdout}${hashed.stderr}`);
		const sourceHash = JSON.parse(hashed.stdout).sourceHash;
		const stamp = (value) => {
			if (!value || typeof value !== "object") return;
			for (const key of Object.keys(value)) {
				if (key === "sourceHash") value[key] = sourceHash;
				else stamp(value[key]);
			}
		};
		stamp(gate.iteration);
		const result = gjc("ultragoal", "quality-gate", "validate", "--quality-gate-json", scratch("gate.json", gate), "--json");
		return JSON.parse(result.stdout);
	};
	const messages = (verdict) => (verdict.errors ?? []).map((error) => String(error.message));
	return { owned, repo, gjc, scratch, write, scaffold, validate, messages };
}

const REPORT = '<testsuite name="fixture" tests="1" failures="0"><testcase name="package boundary"/></testsuite>\n';
const REASON = "The compiled GJC runtime cannot execute a Bun CLI replay for this command.";
const replayRecord = (exempt) => ({
	schemaVersion: 1,
	kind: "cli-replay",
	command: ["bun", "--version"],
	replaySafe: true,
	recordedStdout: "1.4.0\n",
	...(exempt ? { replayExempt: exempt } : {}),
});
const exemption = (fallbackArtifactRefs, reason = REASON) => ({ reasonCode: "platform_unavailable", reason, approvedBy: "human:fixture-owner", fallbackArtifactRefs });
const withArtifact = (gate, artifact) => {
	gate.executorQa.artifactRefs.push(artifact);
	return gate;
};

test("ultragoal quality-gate evidence contract of the installed gjc", { skip: GJC ? false : "no gjc binary on PATH" }, async (t) => {
	const f = fixture();
	try {
		f.write("artifacts/adversarial-report.txt", "Invalid input, missing state and repeated submission were rejected as the contract requires.\n");

		await t.test("package: an existing non-empty test report validates and review passes", () => {
			f.write("artifacts/api-report-1.xml", REPORT);
			const gate = f.scaffold("package");
			assert.deepEqual(f.messages(f.validate(gate)), []);
			const spec = f.scratch("spec.md", "# Fixture contract\n\nThe package surface returns the documented result for valid input and rejects invalid input.\n");
			const review = f.gjc("ultragoal", "review", "--spec", spec, "--executor-qa-json", f.scratch("executor-qa.json", gate.executorQa), "--json");
			const verdict = JSON.parse(review.stdout);
			assert.equal(verdict.verdict, "pass", review.stdout);
			assert.equal(verdict.cleanPassEligible, true);
		});

		await t.test("package: a report missing from this worktree is rejected; one under .gjc/ is accepted", () => {
			const missing = f.scaffold("package");
			missing.executorQa.artifactRefs.find((artifact) => artifact.id === "api-report-1").path = "artifacts/absent-report.xml";
			assert.ok(f.messages(f.validate(missing)).some((message) => message.includes("requires an existing non-empty file")));
			f.write(".gjc/qa/api-report-1.xml", REPORT);
			const underGjc = f.scaffold("package");
			underGjc.executorQa.artifactRefs.find((artifact) => artifact.id === "api-report-1").path = ".gjc/qa/api-report-1.xml";
			assert.deepEqual(f.messages(f.validate(underGjc)), []);
		});

		await t.test("cli: the surface requires a replay record, which the compiled runtime cannot execute", () => {
			const gate = f.scaffold("cli");
			assert.ok(f.messages(f.validate(gate)).some((message) => message.includes("CLI replay artifact path must reference a readable file")));
			f.write("artifacts/cli-replay-1.json", JSON.stringify(replayRecord()));
			assert.ok(f.messages(f.validate(gate)).some((message) => message.includes("CLI replay execution is unavailable in the compiled GJC runtime")));
		});

		await t.test("cli: replayExempt rejects placeholders, paths and non-structural fallbacks", () => {
			f.write("artifacts/cli-report.xml", REPORT);
			const gate = withArtifact(f.scaffold("cli"), { id: "cli-report", kind: "test-report", path: "artifacts/cli-report.xml", description: "CLI suite report" });
			const reject = (exempt, expected) => {
				f.write("artifacts/cli-replay-1.json", JSON.stringify(replayRecord(exempt)));
				const found = f.messages(f.validate(gate));
				assert.ok(found.some((message) => message.includes(expected)), `${expected}\n${found.join("\n")}`);
			};
			reject({ ...exemption(["cli-report"]), reasonCode: "other" }, "reasonCode must be one of");
			// Exactly 30 characters but four words: the reason needs at least five.
			reject(exemption(["cli-report"], "compiled runtime cannot replay"), "must be audited and substantive");
			reject(exemption(["artifacts/cli-report.xml"]), "references unknown id");
			reject(exemption(["cli-report"]), "requires at least one structurally-valid fallback artifact");
		});

		await t.test("cli: a real terminal capture of the command is a valid fallback", { skip: SCRIPT && BUN ? false : "script(1) or bun unavailable" }, () => {
			const capture = join(f.repo, "artifacts", "cli-pty-1.txt");
			const args = process.platform === "darwin" ? ["-q", capture, BUN, "--help"] : ["-q", "-c", `${BUN} --help`, capture];
			const env = { PATH: process.env.PATH ?? "", HOME: join(f.owned, "home"), TERM: "xterm-256color", FORCE_COLOR: "1" };
			const recorded = spawnSync(SCRIPT, args, { cwd: f.repo, env, stdio: ["ignore", "ignore", "pipe"], encoding: "utf8", timeout: 30000 });
			assert.equal(recorded.status, 0, recorded.stderr);
			// NO_COLOR or TERM=dumb would strip the control sequences the PTY rule requires.
			assert.match(readFileSync(capture, "latin1"), /\x1b\[[0-?]*[ -/]*[@-~]/);
			const gate = withArtifact(f.scaffold("cli"), { id: "cli-pty-1", kind: "terminal-capture", path: "artifacts/cli-pty-1.txt", description: "PTY capture of the CLI run" });
			f.write("artifacts/cli-replay-1.json", JSON.stringify(replayRecord(exemption(["cli-pty-1"]))));
			assert.deepEqual(f.messages(f.validate(gate)), []);
			const inline = withArtifact(f.scaffold("cli"), { id: "cli-pty-1", kind: "terminal-capture", path: "artifacts/cli-pty-1.txt", description: "PTY capture of the CLI run" });
			const entry = inline.executorQa.artifactRefs.find((artifact) => artifact.id === "cli-replay-1");
			delete entry.path;
			Object.assign(entry, replayRecord(exemption(["cli-pty-1"])));
			assert.deepEqual(f.messages(f.validate(inline)), []);
			entry.path = "artifacts/cli-replay-1.json";
			assert.ok(f.messages(f.validate(inline)).some((message) => message.includes("must not mix inline replay fields with an artifact path")));
		});
	} finally {
		rmSync(f.owned, { recursive: true, force: true });
	}
});
