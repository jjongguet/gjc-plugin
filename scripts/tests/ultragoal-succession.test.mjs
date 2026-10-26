// Reproduces the ultragoal succession lifecycle contract (JJO-513): after
// `succession offer` -> `adopt` and the successor completes every handed-off
// goal, the source run must be able to finish cleanly. Everything runs in
// disposable repositories and HOME with synthetic session ids. The suite
// skips with a recorded reason when no `gjc` binary is on PATH, and skips the
// close assertion with a recorded reason while the installed gjc still shows
// the upstream gap documented in JJO-513 (fenced goals stay pending and
// `complete-goals` is refused by the outgoing fence), so the boundary stays
// visible in skip counts instead of silently passing or turning main red on a
// defect this repository cannot fix.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, realpathSync, statSync } from "node:fs";
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

function fixture() {
	const owned = realpathSync(mkdtempSync(join(tmpdir(), "ultragoal-succession-")));
	const home = join(owned, "home");
	mkdirSync(home);
	// The quality gate resolves an authoritative integration base
	// (`origin/<integration>`), so every fixture repository models a real
	// remote. Source and target get separate bare origins so both pushes land.
	const repositories = {};
	for (const name of ["source", "target"]) {
		const repo = join(owned, name);
		mkdirSync(join(repo, "artifacts"), { recursive: true });
		const env = { PATH: process.env.PATH ?? "", HOME: home, TMPDIR: process.env.TMPDIR ?? "/tmp", LANG: "C", GJC_SESSION_ID: `succ-${name}` };
		const git = (...args) => {
			const result = spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
			assert.equal(result.status, 0, result.stderr);
		};
		git("init", "-q", "-b", "main");
		git("-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "commit", "-q", "--allow-empty", "-m", "fixture");
		const bare = spawnSync("git", ["init", "--bare", "-q", join(owned, `${name}.git`)], { encoding: "utf8" });
		assert.equal(bare.status, 0, bare.stderr);
		git("remote", "add", "origin", join(owned, `${name}.git`));
		git("push", "-q", "origin", "main");
		const gjc = (...args) => spawnSync(GJC, ["ultragoal", ...args], { cwd: repo, env, encoding: "utf8", timeout: 120000 });
		const json = (...args) => {
			const result = gjc(...args, "--json");
			assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
			return JSON.parse(result.stdout);
		};
		repositories[name] = {
			repo,
			env,
			json,
			raw: gjc,
			write: (relative, content) => {
				mkdirSync(join(repo, relative, ".."), { recursive: true });
				writeFileSync(join(repo, relative), content);
			},
		};
	}
	// Gate files live outside the repository: anything inside it is part of the hashed source basis.
	const scratch = (name, content) => {
		writeFileSync(join(owned, name), typeof content === "string" ? content : JSON.stringify(content, null, 2));
		return join(owned, name);
	};
	const version = spawnSync(GJC, ["--version"], { encoding: "utf8" }).stdout.trim();
	const summaries = (run) => {
		const status = run.json("status");
		const succession = run.json("succession", "status");
		return { status, succession };
	};
	return { owned, repositories, scratch, version, summaries };
}

const REPORT = '<testsuite name="fixture" tests="1" failures="0"><testcase name="package boundary"/></testsuite>\n';
const ADVERSARIAL = "Invalid input, missing state and repeated submission were rejected as the succession contract requires.\n";

test("ultragoal succession lifecycle of the installed gjc (JJO-513)", { skip: GJC ? false : "no gjc binary on PATH" }, (t) => {
	const f = fixture();
	try {
		const source = f.repositories.source;
		const target = f.repositories.target;

		// Source creates two goals and hands both to the successor repository.
		source.json("create-goals", "--brief", "First story goal");
		source.json("steer", "--kind", "add_subgoal", "--title", "Second story goal", "--objective", "Deliver the second story",
			"--evidence", "split for succession reproduction", "--rationale", "the second story is handed to a successor repository");
		const offer = source.json("succession", "offer", "--target-repo", target.repo, "--goal-id", "G001", "--goal-id", "G002",
			"--authorize", "fixture owner approved moving both stories to the target", "--authorized-by", "human:fixture-owner");
		assert.ok(offer.offer_path, JSON.stringify(offer));
		assert.ok(existsSync(join(source.repo, ".gjc", "_session-succ-source", "ultragoal", "succession", "outgoing-fence.json")),
			"the outgoing ownership fence must exist after the offer");
		const adoption = target.json("succession", "adopt", "--offer", offer.offer_path);
		assert.ok(adoption.adoption_path, JSON.stringify(adoption));

		// The successor completes both goals with a package-surface quality gate.
		target.write("artifacts/api-report-1.xml", REPORT);
		target.write("artifacts/adversarial-report.txt", ADVERSARIAL);
		const gate = join(f.owned, "gate.json");
		assert.equal(target.raw("quality-gate", "init", "--surface", "package", "--out", gate).status, 0);
		for (const goal of ["G001", "G002"]) {
			target.json("checkpoint", "--goal-id", goal, "--status", "active", "--evidence", `start ${goal}`);
			const sourceHash = target.json("quality-gate", "source-hash").sourceHash;
			const stamped = join(f.owned, `gate-${goal}.json`);
			const document = JSON.parse(readFileSync(gate, "utf8"));
			const stamp = (value) => {
				if (!value || typeof value !== "object") return;
				for (const key of Object.keys(value)) {
					if (key === "sourceHash") value[key] = sourceHash;
					else stamp(value[key]);
				}
			};
			stamp(document.iteration);
			writeFileSync(stamped, JSON.stringify(document));
			target.json("checkpoint", "--goal-id", goal, "--status", "complete", "--evidence", `package suite passed for ${goal}`,
				"--quality-gate-json", stamped);
		}

		// Stable parts of the contract: the successor finished and published adoption.
		const finished = f.summaries(target);
		assert.equal(finished.status.status, "complete", JSON.stringify(finished.status));
		assert.ok(finished.status.goals.every((goal) => goal.status === "complete"), JSON.stringify(finished.status.goals));
		assert.equal(finished.succession.adopted, true, JSON.stringify(finished.succession));
		assert.equal(finished.succession.adoption_status, "published", JSON.stringify(finished.succession));

		// The close step is capability-gated: with the gap still present the
		// source keeps the handed-off goals pending and every closing verb is
		// refused, which only an upstream gjc release can change.
		const close = source.raw("complete-goals");
		if (close.status === 0) {
			const settled = f.summaries(source);
			assert.equal(settled.status.status, "complete", JSON.stringify(settled.status));
			assert.ok(settled.status.goals.every((goal) => goal.status !== "pending"),
				`handed-off goals must not stay pending: ${JSON.stringify(settled.status.goals)}`);
		} else {
			const refused = `${close.stdout}${close.stderr}`;
			assert.ok(refused.includes("no longer owns"),
				`complete-goals failed with a changed contract — update this fixture and JJO-513: ${refused}`);
			t.skip(`upstream succession close gap (JJO-513) still present in ${f.version}: complete-goals refused by the outgoing fence`);
		}
	} finally {
		rmSync(f.owned, { recursive: true, force: true });
	}
});
