#!/usr/bin/env node
/**
 * Measure W (owner-wait minutes) from Linear issue logs: interval from an
 * owner decision block event to the first later event that records an owner
 * response. Read-only Linear calls through linear-trace.py; only issue ids and
 * timestamps are written (no comment text).
 *   node self-improve/jev-checkpoint/scripts/measure-w.mjs --out <file> [--since 2026-11-01]
 *
 * Decision block event: text contains 결정 블록 or 오너 결정 대기, together with
 * 선택지 and 기본값 (the 5-item block). Owner response event: an event recorded
 * with "authority": "user-approved", or whose text cites 오너 지시 / 오너 승인 /
 * 오너 응답 / 오너 결정 (…). Blocks without a response on open issues are
 * censored (lower bound to now); on closed issues they are unattributed.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const TRACE = path.join(os.homedir(), ".gjc", "agent", "policy", "bin", "linear-trace.py");
const call = (tool, args) => {
	const out = execFileSync("python3", [TRACE, "call", tool, "--arguments", JSON.stringify(args)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
	return JSON.parse(out.slice(out.indexOf("{")));
};
const OPEN_STATUSES_EXCLUDED = new Set(["Done", "Canceled", "Duplicate"]);
const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : fallback; };
const since = Date.parse(arg("since", "2026-11-01T00:00:00Z"));
const out = arg("out", null);
if (!out) { process.stderr.write("usage: measure-w.mjs --out <file>\n"); process.exit(2); }

const BLOCK = /(결정 블록|오너 결정 대기)/;
const RESPONSE = /("authority":\s*"user-approved"|오너 지시|오너 승인|오너 응답|오너 결정 \()/;
const ids = new Map();
for (const query of ["결정 블록", "오너 결정 대기"]) {
	for (const issue of call("list_issues", { query, limit: 50 }).issues ?? []) ids.set(issue.id, issue.status);
}
// Named issues the search may miss (the JJO-2374 false-stop block is required by the plan).
for (const id of String(arg("extra", "JJO-2374")).split(",").filter(Boolean)) {
	if (!ids.has(id)) ids.set(id, call("get_issue", { id }).status ?? null);
}
const intervals = [];
const unattributed = [];
const now = Date.now();
const failed = [];
for (const [id, status] of ids) {
	let comments;
	try {
		comments = call("list_comments", { issueId: id }).comments ?? [];
	} catch (error) {
		// Recorded, never silently skipped: an unread issue makes the receipt incomplete.
		failed.push({ ref: id, reason: String(error?.stderr ?? error?.message ?? "call_failed").trim().split("\n").pop().slice(0, 160) });
		continue;
	}
	const events = [];
	for (const comment of comments) {
		const body = String(comment.body ?? "");
		const parts = body.split("GJC-LOG-EVENT:v1 ").slice(1);
		// Issue-log comments carry one event per header; a standalone comment is one event at its creation time.
		if (!parts.length) { const at = Date.parse(comment.createdAt); if (Number.isFinite(at)) events.push({ at, text: body }); }
		for (const part of parts) {
			const at = Date.parse(part.slice(0, 32).split(" ")[0]);
			if (Number.isFinite(at)) events.push({ at, text: part });
		}
	}
	events.sort((a, b) => a.at - b.at);
	for (let i = 0; i < events.length; i++) {
		const event = events[i];
		if (event.at < since || !BLOCK.test(event.text) || !/선택지/.test(event.text) || !/기본값/.test(event.text)) continue;
		const response = events.slice(i + 1).find((later) => RESPONSE.test(later.text));
		if (response) intervals.push({ ref: id, blockAt: new Date(event.at).toISOString(), completed: true, minutes: Math.round((response.at - event.at) / 60000) });
		// Only a known open status makes a pending block a censored lower bound.
		else if (typeof status === "string" && !OPEN_STATUSES_EXCLUDED.has(status)) intervals.push({ ref: id, blockAt: new Date(event.at).toISOString(), completed: false, minutes: Math.round((now - event.at) / 60000) });
		else unattributed.push({ ref: id, blockAt: new Date(event.at).toISOString(), status: status ?? "unknown" });
	}
}
const receipt = { schema: "jexp.w_intervals.v1", measuredAt: new Date(now).toISOString(), since: new Date(since).toISOString(), issuesFound: ids.size, issuesScanned: ids.size - failed.length, issuesFailed: failed, complete: failed.length === 0, intervals, unattributed, method: "Linear issue-log events: decision block (결정 블록|오너 결정 대기 + 선택지 + 기본값) → first later owner-response event" };
writeFileSync(out, JSON.stringify(receipt, null, 2));
process.stdout.write(`issues=${ids.size} failed=${failed.length} completed=${intervals.filter((e) => e.completed).length} censored=${intervals.filter((e) => !e.completed).length} unattributed=${unattributed.length}\n`);
// An incomplete scan is not a measurement: exit non-zero so W is never frozen from it.
if (failed.length) process.exit(1);
