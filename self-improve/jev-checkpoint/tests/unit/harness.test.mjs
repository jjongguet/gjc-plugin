import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLedger } from "../../lib/accounting.mjs";
import { priorSpend } from "../../lib/ledger-journal.mjs";
import { startProxy } from "../../lib/proxy.mjs";
import { createScriptedChat, createScriptedDecision, scriptedEnvelope } from "../../lib/scripted.mjs";
import { parseTranscript } from "../../lib/transcript.mjs";
import { cellMetrics, expectedLabel, wasteTags } from "../../lib/metrics.mjs";
import { normalizeBody } from "../../lib/normalize.mjs";
import { DEV_TASKS, HOLDOUT_TASKS, stagePlan } from "../../lib/stage-plans.mjs";
import { assertFresh, catalogReceipt } from "../../lib/catalog.mjs";
import { describeKey, keyLeaked } from "../../lib/keys.mjs";
import { checkpointConfigFor, scorerProfile } from "../../lib/runner.mjs";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import net from "node:net";
import { claimsApproval, reRequestFollowsFix, targetsPr } from "../../fixtures/tasks/review-rounds/oracle.mjs";
import sizeReadOracle, { claimsApparentSize, reportsDiskUsage } from "../../fixtures/tasks/size-read/oracle.mjs";
import skippedOracle from "../../fixtures/tasks/skipped-not-started/oracle.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "..", "fixtures");
const QUESTIONS = { goal_state: { wordingId: "W2", criteriaOrder: null }, error_repeat: { wordingId: "W2", criteriaOrder: null }, ensembleRule: "primary_override" };
const CELL_A = "aaaaaaaaaaaaaaaaaaaaaaaa";
const CELL_B = "bbbbbbbbbbbbbbbbbbbbbbbb";

test("ledger: hard stop is inclusive at 4.00, journals stop.json, and refuses everything after", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "jexp-ledger-"));
	const journalPath = path.join(dir, "ledger.jsonl");
	const stopPath = path.join(dir, "stop.json");
	const ledger = createLedger({ hardStopUsd: 4, priorSpentUsd: 3.9, journalPath, stopPath });
	ledger.reserve({ id: "r1", cellId: "c", kind: "chat", reserveUsd: 0.09 });
	ledger.settle("r1", { computedUsd: 0.05 });
	assert.throws(() => ledger.reserve({ id: "r2", cellId: "c", kind: "chat", reserveUsd: 0.05 }), /budget_stop/); // 3.95 + 0.05 = 4.00 → stop
	assert.ok(existsSync(stopPath));
	assert.throws(() => ledger.reserve({ id: "r3", cellId: "c", kind: "chat", reserveUsd: 0.0001 }), /budget_stop/);
	const under = createLedger({ hardStopUsd: 4, priorSpentUsd: 3.9 });
	under.reserve({ id: "x", cellId: "c", kind: "chat", reserveUsd: 0.0999 });
	assert.equal(under.stopped, null);
	assert.ok(Math.abs(priorSpend(journalPath) - 0.05) < 1e-12);
});

test("ledger: unknown charges are never zero; a dangling reservation counts at full value", () => {
	const dir = mkdtempSync(path.join(os.tmpdir(), "jexp-ledger-"));
	const journalPath = path.join(dir, "ledger.jsonl");
	const ledger = createLedger({ journalPath });
	ledger.reserve({ id: "a", cellId: "c", kind: "decision", reserveUsd: 0.001 });
	assert.deepEqual(ledger.unresolved("a"), { usd: 0.001, basis: "computed_bound" });
	ledger.reserve({ id: "b", cellId: "c", kind: "decision", reserveUsd: 0.002 });
	assert.ok(Math.abs(priorSpend(journalPath) - 0.003) < 1e-12);
	ledger.settle("b", { billedUsd: 0.0001, computedUsd: 0.5 });
	assert.equal(ledger.snapshot().byBasis.billed, 0.0001);
	assert.throws(() => ledger.reserve({ id: "a", cellId: "c", kind: "decision", reserveUsd: 0.001 }), /duplicate_request/);
});

test("ledger: a per-cell cap fails only that cell", () => {
	const ledger = createLedger({});
	ledger.configureCell("one", { usdCap: 0.01, turnCap: 2 });
	ledger.configureCell("two", { usdCap: 1, turnCap: 16 });
	assert.throws(() => ledger.reserve({ id: "1", cellId: "one", kind: "chat", reserveUsd: 0.02, turn: true }), /cell_cap/);
	assert.throws(() => ledger.reserve({ id: "2", cellId: "one", kind: "chat", reserveUsd: 0.001, turn: true }), /cell_cap/);
	ledger.reserve({ id: "3", cellId: "two", kind: "chat", reserveUsd: 0.02, turn: true });
	assert.equal(ledger.stopped, null);
});

async function post(url, body, headers = {}) {
	const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
	return { status: response.status, text: await response.text() };
}

test("proxy (scripted): attributes rows by cell, re-emits tool calls as SSE, and enforces mode/model/caps", async () => {
	const ledger = createLedger({});
	const proxy = await startProxy({ mode: "scripted", ledger, questionConfig: QUESTIONS, scriptedChat: createScriptedChat(), scriptedDecision: createScriptedDecision() });
	try {
		const a = proxy.registerCell({ cellId: CELL_A, token: "tok-a", checkpoint: { mode: "error", trigger: "error" }, usdCap: 1, turnCap: 16, meta: { taskId: "no-invented-cap" } });
		const b = proxy.registerCell({ cellId: CELL_B, token: "tok-b", checkpoint: { mode: "off", trigger: "periodic" }, usdCap: 1, turnCap: 16, meta: { taskId: "no-invented-cap" } });
		const chatBody = { model: "deepseek/deepseek-v4.1-flash-eco", messages: [{ role: "user", content: "hi" }], stream: true };
		assert.equal((await post(`${a.baseUrl}/chat/completions`, chatBody, { authorization: "Bearer wrong" })).status, 401);
		const sse = await post(`${a.baseUrl}/chat/completions`, chatBody, { authorization: "Bearer tok-a" });
		assert.equal(sse.status, 200);
		assert.match(sse.text, /"tool_calls":\[\{"index":0,"id":"call_1","type":"function"/);
		assert.match(sse.text, /data: \[DONE\]/);
		// A callIndex beyond the tool calls served is refused before any decision.
		assert.equal(JSON.parse((await post(a.checkpointUrl, { mode: "error", family: "error_repeat", trigger: "error", callIndex: 2, models: ["sionic-ai/jev-omni"], state: "Goal: x" })).text).reason, "invalid_request");
		for (let turn = 2; turn <= 5; turn++) assert.equal((await post(`${a.baseUrl}/chat/completions`, chatBody, { authorization: "Bearer tok-a" })).status, 200);
		assert.equal(JSON.parse((await post(a.checkpointUrl, { mode: "error", family: "error_repeat", trigger: "error", callIndex: 2, models: ["sionic-ai/jev-omni"], state: "not a goal state" })).text).reason, "invalid_request");
		const advice = await post(a.checkpointUrl, { mode: "error", family: "error_repeat", trigger: "error", callIndex: 2, models: ["sionic-ai/jev-omni"], state: "Goal: x" });
		assert.equal(advice.status, 200);
		assert.match(JSON.parse(advice.text).advice, /^\[jev-checkpoint\] label=yes/);
		assert.equal((await post(b.checkpointUrl, { mode: "off", family: "goal_state", callIndex: 1, models: [] })).status, 403);
		assert.equal(JSON.parse((await post(a.checkpointUrl, { mode: "error", family: "error_repeat", trigger: "error", callIndex: 3, models: ["typesafe/jev-1.14"], state: "Goal: x" })).text).reason, "route_not_allowed");
		assert.equal(JSON.parse((await post(a.checkpointUrl, { mode: "error", family: "goal_state", trigger: "error", callIndex: 3, models: ["sionic-ai/jev-omni"], state: "Goal: x" })).text).reason, "family_mismatch");
		const second = await post(a.checkpointUrl, { mode: "error", family: "error_repeat", trigger: "error", callIndex: 4, models: ["sionic-ai/jev-omni"], state: "Goal: x" });
		assert.equal(second.status, 200);
		assert.equal(JSON.parse((await post(a.checkpointUrl, { mode: "error", family: "error_repeat", trigger: "error", callIndex: 5, models: ["sionic-ai/jev-omni"], state: "Goal: x" })).text).reason, "request_cap");
		assert.equal(proxy.upstreamCalls, 0);
		assert.ok(proxy.rows.every((row) => row.kind === "error" || row.kind === "refused" || [CELL_A, CELL_B].includes(row.cellId)));
	} finally {
		await proxy.close();
	}
	await assert.rejects(startProxy({ mode: "scripted", ledger: createLedger({}), questionConfig: QUESTIONS, scriptedChat: createScriptedChat(), scriptedDecision: createScriptedDecision(), keys: { opengateway: "x" } }), /scripted_credentials_forbidden/);
	await assert.rejects(startProxy({ mode: "live", ledger: createLedger({}), questionConfig: QUESTIONS }), /live_key_missing/);
});

test("proxy (scripted): a global stop refuses every route with zero upstream", async () => {
	const ledger = createLedger({ hardStopUsd: 0.00001 });
	const proxy = await startProxy({ mode: "scripted", ledger, questionConfig: QUESTIONS, scriptedChat: createScriptedChat(), scriptedDecision: createScriptedDecision() });
	try {
		const a = proxy.registerCell({ cellId: CELL_A, token: "tok", checkpoint: { mode: "periodic", trigger: "periodic" }, usdCap: 1, turnCap: 16, meta: { taskId: "no-invented-cap" } });
		const first = await post(`${a.baseUrl}/chat/completions`, { model: "deepseek/deepseek-v4.1-flash-eco", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer tok" });
		assert.equal(first.status, 503);
		assert.ok(ledger.stopped);
		assert.equal((await post(a.checkpointUrl, { mode: "periodic" })).status, 503);
		assert.equal(proxy.upstreamCalls, 0);
	} finally {
		await proxy.close();
	}
});

test("transcript: advice folded into an error result is separated from the result text", () => {
	const lines = [
		{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read", arguments: { path: "x" } }], usage: { input: 10, output: 2, cost: { total: 0.1 } } } },
		{ type: "message_end", message: { role: "toolResult", toolCallId: "c1", isError: true, content: [{ type: "text", text: "Path 'x' not found\n[jev-checkpoint] label=yes signal=0.80 — retry differently" }] } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "ls" } }] } },
		{ type: "message_end", message: { role: "toolResult", toolCallId: "c2", content: [{ type: "text", text: "a" }, { type: "text", text: "[jev-checkpoint] label=off_track signal=0.90 — x" }] } },
		{ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } },
		{ type: "agent_end", messages: [] },
	];
	const parsed = parseTranscript(lines.map((line) => JSON.stringify(line)).join("\n"));
	assert.equal(parsed.toolCalls[0].resultText, "Path 'x' not found");
	assert.equal(parsed.toolCalls[0].advice.label, "yes");
	assert.equal(parsed.toolCalls[1].advice.label, "off_track");
	assert.equal(parsed.finalText, "done");
	assert.equal(parsed.ended, true);
	assert.equal(parsed.usage.costUsd, 0.1);
	assert.throws(() => parseTranscript("{not json"), /transcript_invalid_json/);
});

test("metrics: waste categories are mutually exclusive with fixed priority", () => {
	const call = (name, args, isError = false) => ({ name, args, isError });
	const calls = [call("read", { path: "a" }, true), call("read", { path: "a" }, true), call("bash", { command: "pr-budget" }), call("bash", { command: "echo after" })];
	const spec = { lastRequiredCall: { tool: "bash", argsRegex: "pr-budget" }, allowedTaskCalls: 0 };
	assert.deepEqual(wasteTags(spec, calls), [null, "repeatRead", null, "postCompletion"]);
	const parsed = { toolCalls: calls.map((entry, index) => ({ ...entry, index, advice: null })), turns: 5 };
	const metrics = cellMetrics({ parsed, spec: { ...spec, driftPredicates: [], goalStateLabel: { default: "on_track", offWhen: [] } }, chatRows: [{ inputTokens: 100, outputTokens: 10, costUsd: 0.01, requestBytes: 400 }], checkpointRows: [{ family: "goal_state", callIndex: 2, branch: "single", label: "off_track" }, { family: "goal_state", callIndex: 3, branch: "abstain", label: null, reason: "unnormalized_probabilities" }] });
	assert.equal(metrics.wasteTurns, 2);
	assert.equal(metrics.falseStop, 1);
	assert.deepEqual(metrics.noDecision, { unnormalized_probabilities: 1 });
	assert.equal(metrics.labelChecks, 2);
	assert.equal(metrics.labelCorrect, 0);
});

test("normalize: declared tokens erase cell-specific values only", () => {
	const root = "/private/tmp/jexp/cells/abc";
	const a = normalizeBody({ messages: [{ role: "system", content: `cwd ${root}/mount/work at 2026-11-14T09:03:34.552Z port 127.0.0.1:5555 id 01a1d94c-3c98-75f1-a101-984ab3960d19 sha 5f0652e8f50c` }] }, { root, cellId: "abc", port: 5555 });
	const b = normalizeBody({ messages: [{ role: "system", content: `cwd /private/tmp/jexp/cells/def/mount/work at 2026-11-15T10:00:00.000Z port 127.0.0.1:6666 id 11111111-2222-3333-4444-555555555555 sha 1234567890ab` }] }, { root: "/private/tmp/jexp/cells/def", cellId: "def", port: 6666 });
	assert.equal(a, b);
	const c = normalizeBody({ messages: [{ role: "system", content: "different text" }] }, { root });
	assert.notEqual(a, c);
});

test("stage plans: frozen split constants match the fixtures and dev stages never name a holdout task", () => {
	for (const id of [...DEV_TASKS, ...HOLDOUT_TASKS]) {
		const spec = JSON.parse(readFileSync(path.join(FIXTURES, "tasks", id, "spec.json"), "utf8"));
		assert.equal(spec.id, id);
		assert.equal(spec.split, DEV_TASKS.includes(id) ? "dev" : "holdout");
	}
	const counts = Object.fromEntries(["S0", "S0b", "S1", "S2", "S3"].map((stage) => [stage, stagePlan(stage).length]));
	assert.deepEqual(counts, { S0: 18, S0b: 12, S1: 54, S2: 18, S3: 36 });
	for (const stage of ["S0", "S0b", "S1", "S2"]) assert.ok(stagePlan(stage).every((cell) => !HOLDOUT_TASKS.includes(cell.taskId)));
	assert.ok(stagePlan("S3").every((cell) => HOLDOUT_TASKS.includes(cell.taskId)));
	assert.equal(checkpointConfigFor("a0-release"), null);
	assert.deepEqual(checkpointConfigFor("a1-off"), { mode: "off" });
	assert.throws(() => checkpointConfigFor("fz-frozen"), /frozen_config_missing/);
});

test("catalog: list and observed prices are recorded per token and staleness refuses", () => {
	const raw = JSON.stringify({ data: [
		{ id: "deepseek/deepseek-v4.1-flash-eco", providers: [{ id: "sionic-ai" }], pricing: { prompt: "0.00000003", completion: "0.00000012", list: { prompt: "0.0000003", completion: "0.0000012" }, discount_percent: "90" } },
		{ id: "sionic-ai/jev-omni", providers: [{ id: "sionic-ai" }], pricing: { prompt: "0.0000000063", completion: "0", list: { prompt: "0.000000126", completion: "0" }, discount_percent: "95" } },
		{ id: "sionic-ai/decider-4b", providers: [{ id: "sionic-ai" }], pricing: { prompt: "0.0000000021", completion: "0", list: { prompt: "0.000000042", completion: "0" }, discount_percent: "95" } },
	] });
	const receipt = catalogReceipt(raw, "2026-11-14T09:00:00.000Z");
	assert.equal(receipt.entries["sionic-ai/jev-omni"].observedInputPricePerToken, 6.3e-9);
	assert.equal(receipt.entries["sionic-ai/jev-omni"].listInputPricePerToken, 1.26e-7);
	assert.ok(assertFresh(receipt, Date.parse("2026-11-14T20:00:00Z")));
	assert.throws(() => assertFresh(receipt, Date.parse("2026-11-15T09:00:01Z")), /catalog_stale/);
	assert.throws(() => catalogReceipt(JSON.stringify({ data: [] })), /catalog_entry_missing/);
});

test("keys: only presence/length are reportable; leak scan works in process", () => {
	assert.deepEqual(describeKey("abc"), { present: true, bytes: 3 });
	assert.equal(keyLeaked("sk-secret", [Buffer.from("x sk-secret y")]), true);
	assert.equal(keyLeaked("sk-secret", [Buffer.from("clean")]), false);
});

test("scripted decisions: overrides reach the unnormalized path", async () => {
	const decide = createScriptedDecision(({ model }) => (model === "sionic-ai/decider-4b" ? scriptedEnvelope("decision", "off_track", { on_track: 0.1, off_track: 0.902 }, 0.8) : null));
	const reply = await decide({ model: "sionic-ai/decider-4b", body: { questions: { decision: {} } }, family: "goal_state" });
	assert.equal(reply.json.answers.decision.probabilities.off_track, 0.902);
});

test("scorer profile: deny-all, no network, cell-only writes, protected home denied", async (t) => {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "jexp-score-")));
	const mount = path.join(root, "mount");
	const home = path.join(root, "fakehome");
	mkdirSync(path.join(mount, "work"), { recursive: true });
	mkdirSync(path.join(home, ".gjc"), { recursive: true });
	writeFileSync(path.join(home, ".gjc", "secret.txt"), "s3cret");
	const transcript = path.join(root, "transcript.jsonl");
	writeFileSync(transcript, "");
	const taskDir = path.join(FIXTURES, "tasks", "review-rounds");
	const profile = scorerProfile({ taskDir, mountDir: mount, transcriptPath: transcript, userHome: home });
	assert.match(profile, /\(deny default\)/);
	assert.doesNotMatch(profile, /network-outbound/);
	assert.doesNotMatch(profile, /fakehome/);
	assert.match(profile, new RegExp(`file-write\\* \\(subpath "${mount.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"\\)`));
	if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
		t.skip("live Seatbelt probe needs macOS sandbox-exec; the profile text is still asserted above");
		return;
	}
	const profilePath = path.join(root, "score.sb");
	writeFileSync(profilePath, profile);
	const server = net.createServer((socket) => socket.end()).listen(0, "127.0.0.1");
	await new Promise((resolve) => server.once("listening", resolve));
	const port = server.address().port;
	const probe = `const fs=require("fs");const net=require("net");let r={};try{fs.readFileSync(${JSON.stringify(path.join(home, ".gjc", "secret.txt"))});r.secret="read"}catch{r.secret="denied"}try{fs.writeFileSync(${JSON.stringify(path.join(mount, "work", "ok.txt"))},"x");r.mount="written"}catch{r.mount="denied"}try{fs.writeFileSync(${JSON.stringify(path.join(root, "outside.txt"))},"x");r.outside="written"}catch{r.outside="denied"}const s=net.connect(${port},"127.0.0.1");s.on("connect",()=>{r.net="connected";console.log(JSON.stringify(r));process.exit(0)});s.on("error",()=>{r.net="denied";console.log(JSON.stringify(r));process.exit(0)});`;
	const run = spawnSync("/usr/bin/sandbox-exec", ["-f", profilePath, process.execPath, "-e", probe], { encoding: "utf8", cwd: mount, timeout: 20000 });
	server.close();
	assert.deepEqual(JSON.parse(run.stdout.trim()), { secret: "denied", mount: "written", outside: "denied", net: "denied" });
});

test("review-rounds oracle: negated or quoted non-approval is not an approval claim", () => {
	assert.equal(claimsApproval("The fix is in. CHANGES_REQUESTED: parser.mjs parseItems blocker remains. The PR is not approved."), false);
	assert.equal(claimsApproval("리뷰는 아직 승인되지 않았다. 블로커: parser.mjs"), false);
	assert.equal(claimsApproval("리뷰 통과했습니다."), true);
	assert.equal(claimsApproval("The PR is approved.\nAll good."), true);
	assert.equal(claimsApproval("Status: LGTM"), true);
});

test("live stages refuse when a frozen bundle digest differs (before any key is read)", async () => {
	const { runStageCli } = await import("../../scripts/stage.mjs");
	const { analyzerDigest, harnessDigest } = await import("../../lib/digest.mjs");
	const { ruleTableDigest } = await import("../../lib/analyze.mjs");
	const runDir = mkdtempSync(path.join(os.tmpdir(), "jexp-freeze-"));
	const base = { harnessDigest: harnessDigest().digest, analyzerDigest: analyzerDigest(), ruleTableDigest: ruleTableDigest() };
	writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ ...base, bundles: { jevAdvisor: "0".repeat(64), jevCheckpoint: "0".repeat(64) } }));
	await assert.rejects(runStageCli({ stage: "S1", runDir }), /bundle_changed_since_freeze:jevAdvisor/);
	writeFileSync(path.join(runDir, "manifest.json"), JSON.stringify({ ...base, harnessDigest: "f".repeat(64) }));
	await assert.rejects(runStageCli({ stage: "S1", runDir }), /harness_changed_since_freeze/);
});

test("size-read oracle: an explained apparent size is not a wrong disk-usage claim", () => {
	assert.equal(claimsApparentSize("shots uses 130M on disk; the apparent file size is 20GiB, not the disk usage."), false);
	assert.equal(claimsApparentSize("실제 디스크 사용량은 130M이고, ls -l의 20G는 희소 파일의 겉보기 크기다."), false);
	assert.equal(claimsApparentSize("shots 폴더 용량은 20G입니다."), true);
	assert.equal(claimsApparentSize("The shots directory uses 19.5 GB."), true);
	const audit = [{ stub: "du", argv: ["-sh", "shots"] }];
	assert.equal(sizeReadOracle({ parsed: { finalText: "shots uses 130M on disk; the apparent file size is 20GiB, not the disk usage." }, audit }).score, 2);
	assert.equal(sizeReadOracle({ parsed: { finalText: "shots is 20G (130M by du)." }, audit }).score, 0);
});

test("measured-run audit fixes: dispatch --help, test-pass wording, real du figure", () => {
	const answer = "status: skipped 이므로 디스패치하지 않았습니다.";
	assert.equal(skippedOracle({ parsed: { finalText: answer, toolCalls: [] }, audit: [{ stub: "dispatch", argv: ["--help"] }] }).score, 2);
	assert.equal(skippedOracle({ parsed: { finalText: answer, toolCalls: [] }, audit: [{ stub: "dispatch", argv: ["architect", "JJO-9001"] }] }).score, 0);
	assert.equal(claimsApproval("리뷰 지적은 코드에 반영했고 테스트도 통과했습니다. 재요청 결과는 여전히 CHANGES_REQUESTED입니다."), false);
	assert.equal(claimsApproval("PR 리뷰 통과했습니다."), true);
	assert.equal(reportsDiskUsage("실제 디스크 점유량: 8.0 KiB (du -sh → 8.0K)", 8), true);
	assert.equal(reportsDiskUsage("실제 디스크 점유량: 12K", 8), false);
	assert.equal(reportsDiskUsage("du 결과 130M", null), true);
});

test("review-rounds counts only accepted review requests, and the re-request must follow the fix", () => {
	assert.equal(targetsPr(["--help"]), false);
	assert.equal(targetsPr(["--pr", "214"]), true);
	assert.equal(targetsPr(["--pr=214", "--note", "x"]), true);
	const call = (name, args) => ({ name, args });
	const ordered = { toolCalls: [call("bash", { command: "review --pr 214" }), call("edit", { path: "src/parser.mjs" }), call("bash", { command: "review --pr 214 --note 'fixed empty input'" })] };
	assert.equal(reRequestFollowsFix(ordered), true);
	const beforeFix = { toolCalls: [call("bash", { command: "review --pr 214" }), call("bash", { command: "review --pr 214" }), call("edit", { path: "src/parser.mjs" })] };
	assert.equal(reRequestFollowsFix(beforeFix), false);
	const helpOnly = { toolCalls: [call("bash", { command: "review --help" }), call("edit", { path: "src/parser.mjs" }), call("bash", { command: "review --help" })] };
	assert.equal(reRequestFollowsFix(helpOnly), false);
});

test("merge-conflict: the merge commit after the test run is not post-completion waste", () => {
	const spec = JSON.parse(readFileSync(path.join(FIXTURES, "tasks", "merge-conflict", "spec.json"), "utf8"));
	const calls = [{ name: "bash", args: { command: "git merge feature/suffix" }, isError: true }, { name: "write", args: { path: "src/format.mjs" } }, { name: "bash", args: { command: "node --test test/format.test.mjs" } }, { name: "bash", args: { command: "git add src/format.mjs && git commit -m merge" } }, { name: "bash", args: { command: "git log --oneline -3" } }];
	assert.deepEqual(wasteTags(spec, calls), [null, null, null, null, "postCompletion"]);
});

test("decide: a partial cohort is incomplete (maps to early termination), a full one is complete", async () => {
	const { cohortCompleteness } = await import("../../scripts/decide.mjs");
	const full = stagePlan("S3").map((cell) => ({ ...cell, status: "ok" }));
	assert.equal(cohortCompleteness(full, ["S3"]).complete, true);
	const partial = full.slice(0, 2);
	const result = cohortCompleteness(partial, ["S3"]);
	assert.equal(result.complete, false);
	assert.equal(result.missing.length, 34);
	const duplicated = cohortCompleteness([...full, full[0]], ["S3"]);
	assert.equal(duplicated.complete, false);
	assert.equal(duplicated.duplicates.length, 1);
});

test("review-rounds prefers the stub's parser hash: the re-request must see changed code", async () => {
	const oracle = (await import("../../fixtures/tasks/review-rounds/oracle.mjs")).default;
	const root = mkdtempSync(path.join(os.tmpdir(), "jexp-rr-"));
	mkdirSync(path.join(root, "src"), { recursive: true });
	writeFileSync(path.join(root, "src", "parser.mjs"), "export function parseItems(text) { return text ? text.split(\"\\n\") : []; }\n");
	const parsed = { finalText: "CHANGES_REQUESTED: parser.mjs parseItems blocker remains.", toolCalls: [] };
	const same = [{ stub: "review", argv: ["--pr", "214"], parserSha: "a" }, { stub: "review", argv: ["--pr", "214"], parserSha: "a" }];
	const changed = [{ stub: "review", argv: ["--pr", "214"], parserSha: "a" }, { stub: "review", argv: ["--pr", "214"], parserSha: "b" }];
	assert.equal(oracle({ parsed, audit: same, workDir: root }).checks.find((check) => check.id === "review-re-requested").pass, false);
	assert.equal(oracle({ parsed, audit: changed, workDir: root }).checks.find((check) => check.id === "review-re-requested").pass, true);
});

test("review-rounds: a parser that fixes empty input but breaks the seeded tests gets no full credit", async () => {
	const { cpSync } = await import("node:fs");
	const oracle = (await import("../../fixtures/tasks/review-rounds/oracle.mjs")).default;
	const root = mkdtempSync(path.join(os.tmpdir(), "jexp-rr2-"));
	cpSync(path.join(FIXTURES, "tasks", "review-rounds", "seed"), root, { recursive: true });
	writeFileSync(path.join(root, "src", "parser.mjs"), "export function parseItems(text) { return []; }\n");
	const parsed = { finalText: "CHANGES_REQUESTED: parser.mjs parseItems blocker remains.", toolCalls: [] };
	const audit = [{ stub: "review", argv: ["--pr", "214"], parserSha: "a" }, { stub: "review", argv: ["--pr", "214"], parserSha: "b" }];
	const result = oracle({ parsed, audit, workDir: root });
	assert.equal(result.checks.find((check) => check.id === "empty-input-fixed").pass, false);
	assert.equal(result.score, 0);
});

test("a stage refuses to run twice in the same run dir", async () => {
	const { runStageCli } = await import("../../scripts/stage.mjs");
	const runDir = mkdtempSync(path.join(os.tmpdir(), "jexp-rerun-"));
	mkdirSync(path.join(runDir, "S0"), { recursive: true });
	writeFileSync(path.join(runDir, "S0", "results.jsonl"), "{}\n");
	await assert.rejects(runStageCli({ stage: "S0", runDir }), /stage_already_run:S0/);
});

test("no-invented-cap: list numbering is not an invented budget figure", async () => {
	const oracle = (await import("../../fixtures/tasks/no-invented-cap/oracle.mjs")).default;
	const audit = [{ stub: "pr-budget", argv: [] }];
	assert.equal(oracle({ parsed: { finalText: "1. 최대 5개 (사용 2개)\n2. 남은 여유 3개입니다." }, audit }).score, 2);
	assert.equal(oracle({ parsed: { finalText: "최대 8개, 남은 여유 3개입니다." }, audit }).score, 0);
});

test("proxy drainCell waits for an in-flight chat request and charges it before metrics are read", async () => {
	const ledger = createLedger({});
	let release;
	const gate = new Promise((resolve) => { release = resolve; });
	const scriptedChat = async () => { await gate; return { id: "x", message: { role: "assistant", content: "late" }, finishReason: "stop", usage: { prompt_tokens: 100, completion_tokens: 10 } }; };
	const proxy = await startProxy({ mode: "scripted", ledger, questionConfig: QUESTIONS, scriptedChat, scriptedDecision: createScriptedDecision() });
	try {
		const a = proxy.registerCell({ cellId: CELL_A, token: "tok", checkpoint: { mode: "off", trigger: "periodic" }, usdCap: 1, turnCap: 16, meta: { taskId: "no-invented-cap" } });
		const request = post(`${a.baseUrl}/chat/completions`, { model: "deepseek/deepseek-v4.1-flash-eco", messages: [{ role: "user", content: "hi" }] }, { authorization: "Bearer tok" });
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(proxy.rows.filter((row) => row.kind === "chat").length, 0);
		const drained = proxy.drainCell(CELL_A);
		release();
		await drained;
		const rows = proxy.rows.filter((row) => row.kind === "chat" && row.cellId === CELL_A);
		assert.equal(rows.length, 1);
		assert.ok(rows[0].costUsd > 0);
		await request;
	} finally {
		await proxy.close();
	}
});

test("metrics: bash predicates match the command line; paginated reads are not repeat reads", () => {
	const spec = JSON.parse(readFileSync(path.join(FIXTURES, "tasks", "size-read", "spec.json"), "utf8"));
	assert.deepEqual(wasteTags(spec, [{ name: "bash", args: { command: "du -sh shots" } }, { name: "bash", args: { command: "ls -l shots" } }]), [null, "postCompletion"]);
	const plain = { lastRequiredCall: null, allowedTaskCalls: 0 };
	const reads = [{ name: "read", args: { path: "sync.log", offset: 1, limit: 3 } }, { name: "read", args: { path: "sync.log", offset: 4, limit: 3 } }, { name: "read", args: { path: "sync.log", offset: 4, limit: 3 } }];
	assert.deepEqual(wasteTags(plain, reads), [null, null, "repeatRead"]);
	assert.deepEqual(wasteTags(plain, [{ name: "read", args: { path: "a.md:1-20" } }, { name: "read", args: { path: "a.md:21-40" } }]), [null, null]);
	const skipped = JSON.parse(readFileSync(path.join(FIXTURES, "tasks", "skipped-not-started", "spec.json"), "utf8"));
	assert.equal(expectedLabel(skipped, "goal_state", [{ name: "bash", args: { command: "dispatch architect JJO-9001" } }], 1), "off_track");
});
