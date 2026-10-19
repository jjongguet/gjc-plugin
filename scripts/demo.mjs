#!/usr/bin/env bun
/**
 * Keyless demo of three offline plugins, run against the committed generated
 * tool surfaces exactly as GJC loads them.
 *
 *   bun run demo
 *
 * The demo runs in a child process with a temporary HOME, TMPDIR and working
 * directory. It reads no credentials, makes no network or model calls, and
 * verifies that the invoking user's real backplan, rrsi and rea stores under
 * ~/.gjc-plugin are unchanged.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const script = fileURLToPath(import.meta.url);
const repo = path.resolve(path.dirname(script), "..");

function fingerprint(dir) {
	const hash = createHash("sha256");
	const walk = current => {
		let names;
		try {
			names = readdirSync(current).sort();
		} catch {
			return;
		}
		for (const name of names) {
			const target = path.join(current, name);
			const stat = lstatSync(target);
			hash.update(`${path.relative(dir, target)}\0${stat.size}\0${stat.mtimeMs}\n`);
			if (stat.isDirectory()) walk(target);
		}
	};
	if (existsSync(dir)) walk(dir);
	return hash.digest("hex");
}

if (process.argv[2] !== "--isolated") {
	// Only the three stores this demo writes are fingerprinted: a running GJC
	// session legitimately appends to other plugin journals meanwhile.
	const realStores = ["backplan", "rrsi", "rea"].map(name => path.join(os.homedir(), ".gjc-plugin", name));
	const snapshot = () => realStores.map(fingerprint).join(":");
	const before = snapshot();
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "gjc-plugin-demo-")));
	let status = 1;
	try {
		for (const dir of ["home", "tmp", "cwd"]) mkdirSync(path.join(root, dir), { mode: 0o700 });
		const child = spawnSync(process.execPath, ["--no-env-file", script, "--isolated", root], {
			cwd: path.join(root, "cwd"),
			env: { HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), PATH: process.env.PATH ?? "", LC_ALL: "C" },
			stdio: "inherit",
			timeout: 120000,
		});
		status = child.status ?? 1;
		const tempStore = path.join(root, "home", ".gjc-plugin");
		if (status === 0 && !existsSync(path.join(tempStore, "rrsi", "store.json"))) {
			console.error("demo: expected the rrsi store under the temporary HOME");
			status = 1;
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	if (snapshot() !== before) {
		console.error("demo: a real ~/.gjc-plugin store (backplan, rrsi or rea) changed; isolation failed");
		status = 1;
	}
	if (status === 0) console.log("\ndemo: ok (temporary HOME removed; real backplan/rrsi/rea stores unchanged)");
	process.exitCode = status;
} else {
	await runDemo(process.argv[3]);
}

async function runDemo(root) {
	if (os.homedir() !== path.join(root, "home")) throw new Error("demo must run under the temporary HOME");
	const pi = { cwd: path.join(root, "cwd"), typebox: { Type: { Object: fields => fields, String: options => options ?? {}, Optional: schema => schema } } };
	const load = async relative => (await import(pathToFileURL(path.join(repo, relative)).href)).default(pi);
	const text = result => result.content[0].text;
	const firstJson = value => JSON.parse(value.slice(value.indexOf("{"), value.lastIndexOf("\n{") > 0 ? value.lastIndexOf("\n{") : undefined));

	console.log("$ backplan_check  (validate a work plan and render Linear-ready payloads)");
	const backplan = await load("backplan/tools/backplan-check.ts");
	const plan = {
		goal: "Fix the broken README link",
		end_state: "Every relative link in README.md resolves on main",
		success_criteria: ["bun run docs:check exits 0 on main"],
		project: { name: "docs", mode: "reuse", reason: "the existing docs project covers README changes" },
		issues: [
			{
				title: "Fix the README link to CONTRIBUTING.md",
				objective: "Point the link at the moved file",
				context: "README.md links to a renamed section",
				scope_in: ["README.md"],
				scope_out: ["code changes"],
				completion_criteria: ["bun run docs:check exits 0"],
				delivery: "one commit on main",
			},
		],
		policy_decisions: [],
		automation_candidates: [],
	};
	const ok = text(await backplan.execute("demo-1", { plan: JSON.stringify(plan) }));
	const report = firstJson(ok);
	console.log(`  status=${report.status} digest=${report.digest.slice(0, 12)}… issues=${report.linear.issues.length} project=${report.linear.project.mode}:${report.linear.project.name}`);
	const bad = firstJson(text(await backplan.execute("demo-2", { plan: JSON.stringify({ goal: "Fix the link" }) })));
	console.log(`  incomplete plan → status=${bad.status}; first errors: ${bad.errors.slice(0, 3).join("; ")}`);

	console.log("\n$ rrsi  (capture an exploration episode, then replay policies over the store)");
	const rrsi = await load("rrsi/tools/rrsi.ts");
	const call = async params => JSON.parse(text(await rrsi.execute("demo", params)));
	const empty = await call({ action: "status" });
	console.log(`  status: storage=${empty.storageStatus} episodes=${empty.counts.episodes}`);
	const attempts = [
		{ objective: "probe.docs_links", hypothesisNovelty: 0.6, decision: "reject", wallMs: 41000, guardFailures: 1, budgetRung: 0, files: 1, hunks: 2 },
		{ objective: "probe.docs_links", hypothesisNovelty: 0.4, decision: "adopt", wallMs: 38000, guardFailures: 0, budgetRung: 0, files: 1, hunks: 1 },
	];
	const captured = await call({ action: "capture", goal: "Repair README links", attempts: JSON.stringify(attempts) });
	console.log(`  capture: attempts=${captured.episode.attempts} episodes=${captured.counts.episodes}`);
	const dreamed = await call({ action: "dream", seed: "1" });
	const summary = dreamed.summary;
	console.log(`  dream: candidate policies=${dreamed.policies} corpus attempts=${dreamed.corpusAttempts} thresholds evaluated=${summary.thresholds.evaluated} (${summary.thresholds.reason ?? "evaluated"})`);
	console.log(`  verdict: ${summary.verdict}`);

	console.log("\n$ rea_readiness  (offline readiness of the pinned REA CLI)");
	const rea = await load("rea/tools/rea-readiness.ts");
	const readiness = text(await rea.execute("demo-rea", {})).split("\n");
	for (const line of readiness.slice(0, 3)) console.log(`  ${line}`);
	console.log(`  extra input → ${text(await rea.execute("demo-rea-bad", { path: "/" })).split("\n")[0]}`);
}
