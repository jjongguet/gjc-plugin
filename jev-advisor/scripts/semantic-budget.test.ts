import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { askBudgetedSemanticAdvice } from "../lib/semantic-budget";

const input = { branchEntries: [{ type: "user", id: "user1", text: "Implement `src/demo.ts`" }], targetPaths: ["src/demo.ts"] };
const session = "1234567890abcdef";
const answer = (cost?: number) => new Response(JSON.stringify({ answers: { alignment: { choice: "aligned", confidence: 1, probabilities: { aligned: 1, drift: 0, uncertain: 0 } } }, ...(cost === undefined ? {} : { usage: { cost } }) }));

function fixture(t: any, prior = "0") {
	const home = mkdtempSync(path.join(tmpdir(), "semantic-budget-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const env = { HOME: home, JEV_ALIGNMENT_SEND_AUTHORITY_TEXT: "true", JEV_ADVISOR_API_KEY: "synthetic-key", JEV_ALIGNMENT_BUDGET_PRIOR_MICRO_USD: prior };
	const file = path.join(home, ".gjc-plugin", "jev-advisor", "semantic", "budget.json");
	return { home, env, file, ledger: () => JSON.parse(readFileSync(file, "utf8")) };
}

test("disabled, keyless, unknown session and missing prior never call transport", async t => {
	const f = fixture(t);
	let calls = 0;
	const transport = async () => { calls++; return answer(); };
	assert.equal((await askBudgetedSemanticAdvice(input, session, { ...f.env, JEV_ALIGNMENT_SEND_AUTHORITY_TEXT: "false" }, transport)).reason, "outbound_suppressed");
	assert.equal(existsSync(path.dirname(f.file)), false);
	assert.equal((await askBudgetedSemanticAdvice(input, session, { ...f.env, JEV_ADVISOR_API_KEY: "", OPENROUTER_API_KEY: "" }, transport)).reason, "unconfigured");
	assert.equal((await askBudgetedSemanticAdvice(input, "default", f.env, transport)).reason, "budget_unconfigured");
	assert.equal((await askBudgetedSemanticAdvice(input, session, { ...f.env, JEV_ALIGNMENT_BUDGET_PRIOR_MICRO_USD: "" }, transport)).reason, "budget_unavailable");
	assert.equal(calls, 0);
});

test("reservation precedes send, unknown charge persists and same-session restart cannot reset cap", async t => {
	const f = fixture(t);
	let calls = 0;
	const transport = async () => {
		calls++;
		assert.equal(f.ledger().entries[0].costMicroUsd, null);
		assert.equal(f.ledger().entries[0].reservedMicroUsd, 50000);
		return answer();
	};
	assert.equal((await askBudgetedSemanticAdvice(input, session, f.env, transport)).status, "decision");
	const runner = `import {askBudgetedSemanticAdvice} from ${JSON.stringify(path.resolve(import.meta.dir, "../lib/semantic-budget.ts"))}; console.log(JSON.stringify(await askBudgetedSemanticAdvice(${JSON.stringify(input)},${JSON.stringify(session)})));`;
	const child = spawnSync(process.execPath, ["--no-env-file", "-e", runner], { env: f.env, encoding: "utf8", timeout: 10000 });
	assert.equal(child.status, 0, child.stderr);
	assert.equal(JSON.parse(child.stdout).reason, "session_cap");
	assert.equal(calls, 1);
});

test("simultaneous calls admit only one send in a session", async t => {
	const f = fixture(t);
	let calls = 0;
	const results = await Promise.all(Array.from({ length: 8 }, () => askBudgetedSemanticAdvice(input, session, f.env, async () => { calls++; return answer(); })));
	assert.equal(calls, 1);
	assert.equal(results.filter(result => result.reason === "session_cap").length, 7);
});

test("cumulative prior plus unresolved reservation reaches five-dollar ceiling across sessions", async t => {
	const f = fixture(t, "4950000");
	assert.equal((await askBudgetedSemanticAdvice(input, session, f.env, async () => { throw new Error("failed after send"); })).reason, "provider_error");
	let calls = 0;
	assert.equal((await askBudgetedSemanticAdvice(input, "0000000000000001", { ...f.env, JEV_ALIGNMENT_BUDGET_PRIOR_MICRO_USD: "0" }, async () => { calls++; return answer(); })).reason, "budget_exceeded");
	assert.equal(f.ledger().priorMicroUsd, 4950000);
	assert.equal(f.ledger().entries[0].costMicroUsd, null);
	assert.equal(calls, 0);
});

test("independent processes cannot oversubscribe the last reservation", async t => {
	const f = fixture(t, "4950000");
	const module = JSON.stringify(path.resolve(import.meta.dir, "../lib/semantic-budget.ts"));
	const results = await Promise.all(Array.from({ length: 8 }, (_, index) => new Promise<any>((resolve, reject) => {
		const code = `import {askBudgetedSemanticAdvice} from ${module}; console.log(JSON.stringify(await askBudgetedSemanticAdvice(${JSON.stringify(input)},${JSON.stringify(String(index).padStart(16, "0"))},process.env,async()=>new Response(${JSON.stringify(JSON.stringify({ answers: { alignment: { choice: "aligned", confidence: 1, probabilities: { aligned: 1, drift: 0, uncertain: 0 } } } }))}))));`;
		const child = spawn(process.execPath, ["--no-env-file", "-e", code], { env: f.env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		let errors = "";
		child.stdout.on("data", chunk => { output += chunk; });
		child.stderr.on("data", chunk => { errors += chunk; });
		child.on("error", reject);
		child.on("close", status => { try { assert.equal(status, 0, errors); resolve(JSON.parse(output)); } catch (error) { reject(error); } });
	})));
	assert.equal(results.filter(result => result.status === "decision").length, 1);
	assert.equal(results.filter(result => ["budget_exceeded", "budget_unavailable"].includes(result.reason)).length, 7);
	assert.equal(f.ledger().entries.length, 1);
});

test("explicit provider cost is rounded up; missing or invalid usage stays reserved", async t => {
	const f = fixture(t);
	await askBudgetedSemanticAdvice(input, session, f.env, async () => answer(0.0000001));
	assert.equal(f.ledger().entries[0].costMicroUsd, 1);
	await askBudgetedSemanticAdvice(input, "0000000000000001", f.env, async () => answer(-1));
	assert.equal(f.ledger().entries[1].costMicroUsd, null);
});

test("failed settlement retains reservation and never changes advice", async t => {
	const f = fixture(t);
	const result = await askBudgetedSemanticAdvice(input, session, f.env, async () => {
		writeFileSync(`${f.file}.lock`, "held", { mode: 0o600 });
		return answer(0);
	});
	assert.equal(result.status, "decision");
	assert.equal(f.ledger().entries[0].costMicroUsd, null);
});

for (const defect of ["corrupt", "symlink", "hardlink", "mode", "locked", "parent_symlink"] as const) test(`unsafe ${defect} store fails closed with zero send`, async t => {
	const f = fixture(t);
	mkdirSync(path.dirname(f.file), { recursive: true, mode: 0o700 });
	const outside = path.join(f.home, "outside");
	writeFileSync(outside, "private-canary", { mode: 0o600 });
	if (defect === "symlink") symlinkSync(outside, f.file);
	if (defect === "hardlink") linkSync(outside, f.file);
	if (defect === "corrupt") writeFileSync(f.file, "broken", { mode: 0o600 });
	if (defect === "mode") { writeFileSync(f.file, "{}", { mode: 0o600 }); chmodSync(f.file, 0o644); }
	if (defect === "locked") writeFileSync(`${f.file}.lock`, "held", { mode: 0o600 });
	if (defect === "parent_symlink") { rmSync(path.dirname(f.file), { recursive: true }); mkdirSync(path.join(f.home, "other"), { mode: 0o700 }); symlinkSync(path.join(f.home, "other"), path.dirname(f.file)); }
	let calls = 0;
	assert.equal((await askBudgetedSemanticAdvice(input, session, f.env, async () => { calls++; return answer(); })).reason, "budget_unavailable");
	assert.equal(calls, 0);
	assert.equal(readFileSync(outside, "utf8"), "private-canary");
});
