#!/usr/bin/env bun
/**
 * Offline acceptance suite for memory-dream.
 *
 * Hermetic: every memory scope, project, result store and transcript lives in
 * a disposable temporary root. No real ~/.gjc memory, session file, credential
 * or network endpoint is touched.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as core from "../lib/dream.ts";
import { buildSessionStartNotice } from "../lib/notice.ts";

const script = fileURLToPath(import.meta.url);
const pluginRoot = path.resolve(path.dirname(script), "..");
const goldenScript = path.join(pluginRoot, "scripts", "golden.ts");
const buildScript = path.join(pluginRoot, "scripts", "build.mjs");
const root = mkdtempSync(path.join(os.tmpdir(), "memory-dream-verify-"));
const home = path.join(root, "home");
const agentDir = path.join(home, ".gjc", "agent");
const project = path.join(root, "project");
const memoryDir = path.join(agentDir, "memories", "--tmp--");
const resultsRoot = path.join(root, "results");
for (const dir of [home, agentDir, project, memoryDir, resultsRoot]) mkdirSync(dir, { recursive: true, mode: 0o700 });

let cases = 0;
let failures = 0;
let networkCalls = 0;
const check = async (name: string, fn: () => unknown | Promise<unknown>) => {
	cases++;
	try {
		await fn();
		console.log(`ok ${cases} ${name}`);
	} catch (error) {
		failures++;
		console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
	}
};

const write = (file: string, text: string, mode = 0o600) => {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file, text, { mode });
};
const claim = (text: string): core.RawClaim => ({ id: "claim-1", text, sources: [{ file: "memory_summary.md", line: 1 }] });
const fakeFetch = (() => {
	let calls = 0;
	const fetchImpl: core.FetchLike = async () => {
		calls++;
		return new Response("{}", { status: 200 });
	};
	return { fetch: fetchImpl, calls: () => calls };
})();

try {
	await check("manifest declares one tool and one session_start hook", () => {
		const manifest = JSON.parse(readFileSync(path.join(pluginRoot, "gajae-plugin.json"), "utf8"));
		assert.equal(manifest.kind, "gajae-code-plugin");
		assert.equal(manifest.name, "memory-dream");
		assert.match(manifest.version, /^0\.0\.\d+$/);
		assert.equal(manifest.tools.length, 1);
		assert.equal(manifest.tools[0].name, "memory_dream");
		assert.equal(manifest.tools[0].path, "tools/memory-dream.ts");
		assert.equal(manifest.hooks.length, 1);
		assert.equal(manifest.hooks[0].event, "session_start");
		assert.equal(manifest.hooks[0].path, "hooks/memory-dream-session-start.ts");
		assert.equal(manifest.hooks[0].target, undefined);
		assert.equal(manifest.hooks[0].phase, undefined);
	});

	await check("project memory encoding matches GJC's own directory names", () => {
		assert.equal(core.encodeProjectPath("/srv/example/repo"), "--srv-example-repo--");
		assert.equal(core.encodeProjectPath("/tmp"), "--tmp--");
		assert.equal(core.encodeProjectPath("C:\\work\\repo"), "--C--work-repo--");
		assert.equal(core.encodeProjectPath("/a:b/c"), "--a-b-c--");
	});

	await check("claim splitter skips headings and fences and splits sentences", () => {
		const text = ["# Heading", "- First sentence. Second sentence.", "```", "- ignored", "```", "* Third durable statement."].join("\n");
		const claims = core.splitClaims(text, "memory_summary.md", 1);
		assert.equal(claims.length, 3);
		assert.equal(claims[0].text, "First sentence.");
		assert.equal(claims[0].sources[0].line, 2);
		assert.equal(claims[1].text, "Second sentence.");
		assert.equal(claims[2].text, "Third durable statement.");
	});

	await check("duplicate summary/MEMORY claims fold into one claim with both sources", () => {
		const collected = core.collectClaims([
			{ file: "memory_summary.md", text: "- A durable claim about Linear 429." },
			{ file: "MEMORY.md", text: "- A durable claim about Linear 429." },
		]);
		assert.equal(collected.claims.length, 1);
		assert.equal(collected.claims[0].sources.length, 2);
		assert.deepEqual(
			collected.claims[0].sources.map(source => source.file),
			["memory_summary.md", "MEMORY.md"],
		);
	});

	await check("injection budgets warn over bytes and over lines", () => {
		const overBytes = core.budgetFor("memory_summary.md", "x".repeat(core.MAX_SUMMARY_BYTES + 1));
		assert.equal(overBytes.status, "over");
		assert.equal(overBytes.overByBytes, 1);
		const overLines = core.budgetFor("MEMORY.md", Array.from({ length: core.MAX_MEMORY_LINES + 1 }, () => "x").join("\n"));
		assert.equal(overLines.status, "over");
		assert.equal(overLines.overByLines, 1);
		const ok = core.budgetFor("MEMORY.md", "short");
		assert.equal(ok.status, "ok");
	});

	await check("dead and masked rule:// references are separated", async () => {
		write(path.join(project, "rules", "linear-work.md"), "# Linear work\n- Linear 429 is quota exhaustion.\n");
		write(path.join(agentDir, "rules", "decision-models.md"), "# Decision models\n- Use the baseline decision model.\n");
		const clean = await core.analyzeClaim(claim("Use rule://linear-work and rule://decision-models."), project, agentDir, new Date());
		assert.deepEqual(clean.deadReferences, []);
		assert.deepEqual(clean.maskedReferences, []);
		const dead = await core.analyzeClaim(claim("Use rule://missing-rule."), project, agentDir, new Date());
		assert.deepEqual(dead.deadReferences, ["missing-rule"]);
		const masked = await core.analyzeClaim(claim("Use rule://wo[REDACTED] as the rule."), project, agentDir, new Date());
		assert.deepEqual(masked.maskedReferences, ["wo[REDACTED]"]);
	});

	await check("missing and existing home paths are distinguished", async () => {
		write(path.join(home, "present", "file.txt"), "present\n");
		const ok = await core.analyzeClaim(claim("Read `~/present/file.txt` before working."), project, agentDir, new Date());
		assert.deepEqual(ok.missingPaths, []);
		const missing = await core.analyzeClaim(claim("Read `~/absent/file.txt` before working."), project, agentDir, new Date());
		assert.deepEqual(missing.missingPaths, ["~/absent/file.txt"]);
	});

	await check("dated facts expose elapsed days only past the stale bound", () => {
		const now = new Date("2026-11-11T00:00:00Z");
		const stale = core.staleDates("Snapshot 2025-01-15 is current.", now);
		assert.equal(stale.length, 1);
		assert.ok(stale[0].days > core.STALE_AFTER_DAYS);
		assert.deepEqual(core.staleDates("Snapshot 2026-11-10 is current.", now), []);
	});

	await check("secret-shaped claims are redacted and never sent", async () => {
		const secret = "Deploy with sk-abcdefghijklmnopqrstuvwx now.";
		assert.equal(core.detectSecret(secret), "openai_key");
		assert.match(core.redactSecrets(secret), /\[REDACTED:openai_key\]/);
		const calls = { count: 0 };
		const report = await core.analyzeClaimForReport(
			claim(secret),
			{
				projectRoot: project,
				agentDir,
				now: new Date("2026-11-11T00:00:00Z"),
				jevConfig: { key: "fixture", providerOff: false, source: "env" },
				documents: [],
				fetchImpl: async () => {
					calls.count++;
					return new Response("{}", { status: 200 });
				},
				transcriptSearch: false,
				confidenceThreshold: 0.7,
				callJev: true,
			},
			{ callJev: true },
		);
		assert.equal(report.verdict, "unverified");
		assert.equal(report.reason, "secret_blocked");
		assert.equal(report.externalSend, false);
		assert.equal(report.jev, null);
		assert.ok(!report.text.includes("sk-abcdefghijklmnopqrstuvwx"));
		assert.equal(calls.count, 0);
	});

	await check("canonical evidence prefers rules/ over README", async () => {
		const priorityProject = path.join(root, "priority");
		write(path.join(priorityProject, "README.md"), "# Readme\n- Linear 429 responses are quota exhaustion.\n");
		write(path.join(priorityProject, "rules", "linear-work.md"), "# Linear work\n- Linear 429 responses are quota exhaustion; switch immediately.\n");
		const docs = await core.loadCanonicalDocs(priorityProject);
		const found = core.searchCanonical("Linear 429 responses are quota exhaustion.", docs);
		assert.ok(found.evidence.length >= 1);
		assert.match(found.evidence[0].citation, /^rules\/linear-work\.md:/);
	});

	await check("recent transcript is a bounded fallback when canonical docs are absent", async () => {
		const emptyProject = path.join(root, "empty-project");
		mkdirSync(emptyProject, { recursive: true });
		const sessionDir = path.join(agentDir, "sessions", "v2-fixture");
		const transcript = path.join(sessionDir, "2026-11-11T00-00-00-000Z_fixture.jsonl");
		write(
			transcript,
			`${JSON.stringify({
				type: "message",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "The default SSH alias resolves through Tailscale and works from anywhere." }],
				},
			})}\n`,
		);
		const evidence = await core.searchTranscripts("The default SSH alias resolves through Tailscale.", agentDir);
		assert.equal(evidence.length, 1);
		assert.equal(evidence[0].kind, "transcript");
		assert.match(evidence[0].citation, /^transcript:[a-f0-9]{16}:\d+$/);
		const report = await core.analyzeClaimForReport(
			claim("The default SSH alias resolves through Tailscale."),
			{
				projectRoot: emptyProject,
				agentDir,
				now: new Date("2026-11-11T00:00:00Z"),
				jevConfig: { key: null, providerOff: false, source: null },
				documents: [],
				transcriptSearch: true,
				confidenceThreshold: 0.7,
				callJev: false,
			},
			{ callJev: false },
		);
		assert.equal(report.evidence[0].kind, "transcript");
	});

	await check("Jev response parser is strict about verdict, confidence and probabilities", () => {
		const ok = core.parseJevResponse(
			200,
			JSON.stringify({ answers: { consistency: { choice: "incorrect", confidence: 0.9, probabilities: { correct: 0.05, incorrect: 0.9, unsure: 0.05 }, rationale: "conflict" } } }),
		);
		assert.equal(ok.status, "decision");
		if (ok.status === "decision") {
			assert.equal(ok.verdict, "incorrect");
			assert.equal(ok.confidence, 0.9);
			assert.equal(ok.rationale, "conflict");
		}
		assert.equal(core.parseJevResponse(200, JSON.stringify({ answers: { consistency: { choice: "maybe", confidence: 0.5 } } })).status, "no_decision");
		assert.equal(core.parseJevResponse(200, JSON.stringify({ answers: { consistency: { choice: "correct", confidence: 1.1 } } })).status, "no_decision");
		assert.equal(core.parseJevResponse(200, "not json").status, "no_decision");
		assert.equal(core.parseJevResponse(401, "").status, "no_decision");
		assert.equal(core.parseJevResponse(429, "").status, "no_decision");
		assert.equal(
			core.parseJevResponse(
				200,
				JSON.stringify({ answers: { consistency: { choice: "incorrect", confidence: 0.9, probabilities: { correct: 0.5, incorrect: 0.4, unsure: 0.2 } } } }),
			).status,
			"no_decision",
		);
	});

	await check("verdict mapping uses canonical evidence and the confidence threshold", () => {
		const canonical: core.EvidenceItem[] = [{ kind: "canonical", citation: "rules/x.md:2", excerpt: "x", score: 1 }];
		const transcript: core.EvidenceItem[] = [{ kind: "transcript", citation: "transcript:abcdef:2", excerpt: "x", score: 1 }];
		const incorrect: core.JevOutcome = { status: "decision", verdict: "incorrect", confidence: 0.9, confidenceKind: "provider_choice" };
		assert.equal(core.verdictFor(incorrect, canonical, 0.7).verdict, "contradicted");
		assert.equal(core.verdictFor({ ...incorrect, confidence: 0.5 }, canonical, 0.7).verdict, "unverified");
		assert.equal(core.verdictFor(incorrect, transcript, 0.7).verdict, "unverified");
		assert.equal(core.verdictFor({ ...incorrect, verdict: "correct" }, canonical, 0.7).verdict, "supported");
		assert.equal(core.verdictFor({ ...incorrect, verdict: "unsure" }, canonical, 0.7).verdict, "unverified");
		assert.equal(core.verdictFor({ status: "no_decision", reason: "unconfigured" }, canonical, 0.7).verdict, "no-decision");
	});

	await check("keyless run reports no-decision and makes no provider call", async () => {
		const keylessMemory = path.join(agentDir, "memories", "--keyless--");
		write(path.join(keylessMemory, "memory_summary.md"), "- Linear 429 responses are quota exhaustion; switch to the fallback lane immediately.\n");
		const keylessProject = path.join(root, "keyless-project");
		write(path.join(keylessProject, "rules", "linear-work.md"), "# Linear work\n- Linear 429 responses are quota exhaustion; switch to the fallback lane immediately.\n");
		let calls = 0;
		const result = await core.runDream({
			cwd: keylessProject,
			home,
			agentDir,
			memoryDir: keylessMemory,
			projectRoot: keylessProject,
			env: {},
			envFile: path.join(root, "missing.env"),
			resultsRoot,
			writeReports: false,
			jev: true,
			fetchImpl: async () => {
				calls++;
				networkCalls++;
				return new Response("{}", { status: 200 });
			},
			now: new Date("2026-11-11T00:00:00Z"),
		});
		assert.ok(result.report.counts.noDecision >= 1);
		assert.equal(result.report.counts.sentToJev, 0);
		assert.equal(result.report.counts.jevCallsSkippedByCap, 0);
		assert.equal(result.report.claims[0].jev?.status, "no_decision");
		if (result.report.claims[0].jev?.status === "no_decision") assert.equal(result.report.claims[0].jev.reason, "unconfigured");
		assert.equal(calls, 0);
	});

	await check("provider off, env-file key precedence and no network call", async () => {
		const envFile = path.join(root, "credentials.env");
		write(envFile, "OPENROUTER_DECISION_API_KEY=fixture-file-key\n");
		const fromFile = core.resolveJevConfig({}, envFile);
		assert.equal(fromFile.key, "fixture-file-key");
		assert.equal(fromFile.source, "file");
		const fromProcess = core.resolveJevConfig({ OPENROUTER_DECISION_API_KEY: "fixture-env-key" }, envFile);
		assert.equal(fromProcess.key, "fixture-env-key");
		assert.equal(fromProcess.source, "env");
		const off = core.resolveJevConfig({ JEV_ADVISOR_PROVIDER: "off", JEV_ADVISOR_API_KEY: "x" }, envFile);
		assert.equal(off.providerOff, true);
		let calls = 0;
		const result = await core.askJev("claim", [], off, async () => {
			calls++;
			networkCalls++;
			return new Response("{}", { status: 200 });
		}, undefined);
		assert.equal(result.status, "no_decision");
		if (result.status === "no_decision") assert.equal(result.reason, "disabled");
		assert.equal(calls, 0);
	});

	await check("report store is 0700/0600 and memory hashes are unchanged", async () => {
		const reportMemory = path.join(agentDir, "memories", "--report--");
		const summary = "- Linear 429 responses are quota exhaustion; switch to the fallback lane immediately.\n";
		write(path.join(reportMemory, "memory_summary.md"), summary);
		write(path.join(reportMemory, "MEMORY.md"), "# Memory\n- Linear 429 responses are quota exhaustion.\n");
		const before = core.budgetFor("memory_summary.md", summary);
		const result = await core.runDream({
			cwd: project,
			home,
			agentDir,
			memoryDir: reportMemory,
			projectRoot: project,
			env: {},
			envFile: path.join(root, "missing.env"),
			resultsRoot,
			writeReports: true,
			now: new Date("2026-11-11T00:00:00Z"),
		});
		assert.ok(result.reportPath && existsSync(result.reportPath));
		assert.ok(result.markdownPath && existsSync(result.markdownPath));
		assert.ok(result.latestPath && existsSync(result.latestPath));
		assert.equal(result.report.memory.unchanged, true);
		for (const file of result.report.memory.files) assert.equal(file.sha256Before, file.sha256After);
		assert.equal(statSync(path.join(resultsRoot, "reports")).mode & 0o777, 0o700);
		assert.equal(statSync(path.dirname(result.reportPath!)).mode & 0o777, 0o700);
		assert.equal(statSync(result.reportPath!).mode & 0o777, 0o600);
		assert.equal(statSync(result.latestPath!).mode & 0o777, 0o600);
		assert.equal(result.report.budgets[0].status, before.status);
		assert.match(readFileSync(result.markdownPath!, "utf8"), /## Counts/);
	});

	await check("latest notice is bounded to five lines and 600 UTF-8 bytes", () => {
		const contradicted = Array.from({ length: 10 }, (_, index) => ({
			claim: `${"긴 주장 ".repeat(40)}${index}`,
			citation: `docs/example.md:${index + 1}`,
			confidence: 0.9,
		}));
		const latest = { schema: "memory-dream.latest.v1", generatedAt: "2026-11-11T00:00:00.000Z", counts: { contradicted: 10 }, contradicted };
		const text = buildSessionStartNotice(latest);
		assert.ok(text);
		assert.ok(text!.split("\n").length <= 5);
		assert.ok(Buffer.byteLength(text!, "utf8") <= 600);
		assert.match(text!, /^memory-dream: 10 contradicted/);
		assert.equal(buildSessionStartNotice({ ...latest, counts: { contradicted: 0 }, contradicted: [] }), null);
		assert.equal(buildSessionStartNotice({ schema: "wrong" }), null);
	});

	await check("generated session_start hook notifies once and stays silent without a report", async () => {
		const hook = (await import(pathToFileURL(path.join(pluginRoot, "hooks", "memory-dream-session-start.ts")).href)).default;
		let handler: ((event: unknown, ctx: unknown) => unknown) | null = null;
		const api = { on: (event: string, fn: (event: unknown, ctx: unknown) => unknown) => {
			assert.equal(event, "session_start");
			handler = fn;
		} };
		hook(api);
		assert.ok(handler);
		const notices: { text: string; type?: string }[] = [];
		const previous = process.env.MEMORY_DREAM_RESULTS_DIR;
		process.env.MEMORY_DREAM_RESULTS_DIR = path.join(root, "hook-results");
		try {
			await handler!({}, { ui: { notify: (text: string, type?: string) => notices.push({ text, type }) } });
			assert.equal(notices.length, 0);
			const hookLatest = {
				schema: "memory-dream.latest.v1",
				generatedAt: "2026-11-11T00:00:00.000Z",
				counts: { contradicted: 2 },
				contradicted: [
					{ claim: "Linear 429 is a retry condition.", citation: "rules/linear-work.md:2", confidence: 0.9 },
					{ claim: "The default SSH alias is home LAN.", citation: "rules/ssh.md:2", confidence: 0.9 },
				],
			};
			write(path.join(root, "hook-results", "latest.json"), `${JSON.stringify(hookLatest)}\n`);
			await handler!({}, { ui: { notify: (text: string, type?: string) => notices.push({ text, type }) } });
			assert.equal(notices.length, 1);
			assert.ok(Buffer.byteLength(notices[0].text, "utf8") <= 600);
			await handler!({}, undefined);
			assert.equal(notices.length, 1, "a missing ctx.ui must not throw or notify");
			write(path.join(root, "hook-results", "latest.json"), "{broken");
			await handler!({}, { ui: { notify: (text: string, type?: string) => notices.push({ text, type }) } });
			assert.equal(notices.length, 1, "a broken report is silent");
		} finally {
			if (previous === undefined) delete process.env.MEMORY_DREAM_RESULTS_DIR;
			else process.env.MEMORY_DREAM_RESULTS_DIR = previous;
		}
	});

	await check("generated hook carries no provider call", () => {
		const text = readFileSync(path.join(pluginRoot, "hooks", "memory-dream-session-start.ts"), "utf8");
		assert.ok(!text.includes("askJev"));
		assert.ok(!text.includes("fetch("));
		assert.ok(!text.includes("openrouter.ai"));
		assert.ok(!text.includes("setInterval"));
	});

	await check("tool rejects unknown and invalid fields before reading memory", async () => {
		const tool = (await import(pathToFileURL(path.join(pluginRoot, "tools", "memory-dream.ts")).href)).default({
			cwd: project,
			typebox: {
				Type: {
					Object: (fields: unknown) => fields,
					String: () => String,
					Number: () => Number,
					Boolean: () => Boolean,
					Array: () => Array,
					Optional: (value: unknown) => value,
				},
			},
		});
		for (const params of [{ unexpected: true }, { max_claims: 0 }, { max_jev_calls: 121 }, { confidence_threshold: 2 }]) {
			const result = await tool.execute("call-bad", params);
			assert.equal(result.isError, true, JSON.stringify(params));
			assert.match(result.content[0].text, /^memory_dream: invalid_input/);
		}
		const outside = await tool.execute("call-outside", { memory_dir: "/etc" });
		assert.equal(outside.isError, true);
		assert.match(outside.content[0].text, /memory_dir_outside_memories_root/);
	});

	await check("tool runs keyless against a real scope and reports no-decision", async () => {
		const toolMemory = path.join(agentDir, "memories", "--tool--");
		write(path.join(toolMemory, "memory_summary.md"), "- Linear 429 responses are quota exhaustion; switch to the fallback lane immediately.\n");
		const previousAgent = process.env.MEMORY_DREAM_AGENT_DIR;
		const previousResults = process.env.MEMORY_DREAM_RESULTS_DIR;
		process.env.MEMORY_DREAM_AGENT_DIR = agentDir;
		process.env.MEMORY_DREAM_RESULTS_DIR = path.join(root, "tool-results");
		try {
			const tool = (await import(pathToFileURL(path.join(pluginRoot, "tools", "memory-dream.ts")).href)).default({
				cwd: project,
				typebox: {
					Type: {
						Object: (fields: unknown) => fields,
						String: () => String,
						Number: () => Number,
						Boolean: () => Boolean,
						Array: () => Array,
						Optional: (value: unknown) => value,
					},
				},
			});
			const result = await tool.execute("call-ok", { memory_dir: toolMemory, project_root: project });
			assert.notEqual(result.isError, true);
			const text = result.content[0].text;
			assert.match(text, /^memory_dream: ok/);
			assert.match(text, /no-decision=\d+/);
			assert.match(text, /jev_reason=disabled/);
			assert.match(text, /memory_unchanged=yes/);
			assert.match(text, /report=/);
			assert.match(text, /limited: advisory report/);
			const optedIn = await tool.execute("call-opt-in", { memory_dir: toolMemory, project_root: project, jev: true });
			assert.notEqual(optedIn.isError, true);
			assert.match(optedIn.content[0].text, /jev_reason=unconfigured/);
			assert.match(optedIn.content[0].text, /sent_to_jev=0/);
		} finally {
			if (previousAgent === undefined) delete process.env.MEMORY_DREAM_AGENT_DIR;
			else process.env.MEMORY_DREAM_AGENT_DIR = previousAgent;
			if (previousResults === undefined) delete process.env.MEMORY_DREAM_RESULTS_DIR;
			else process.env.MEMORY_DREAM_RESULTS_DIR = previousResults;
		}
	});

	await check("a symlinked memory scope is refused instead of followed", async () => {
		const linked = path.join(agentDir, "memories", "--linked--");
		symlinkSync(memoryDir, linked);
		await assert.rejects(
			core.runDream({
				cwd: project,
				home,
				agentDir,
				memoryDir: linked,
				projectRoot: project,
				env: {},
				envFile: path.join(root, "missing.env"),
				resultsRoot,
				writeReports: false,
			}),
			/memory_dir_not_a_directory/,
		);
	});

	await check("golden set has 36 balanced cases and every drift type", () => {
		const golden = JSON.parse(readFileSync(path.join(pluginRoot, "tests", "fixtures", "golden", "cases.json"), "utf8"));
		assert.equal(golden.version, 1);
		assert.equal(golden.cases.length, 36);
		const counts: Record<string, number> = {};
		const ids = new Set<string>();
		const drifts = new Set<string>();
		for (const entry of golden.cases) {
			assert.ok(!ids.has(entry.id), `duplicate ${entry.id}`);
			ids.add(entry.id);
			counts[entry.expected] = (counts[entry.expected] ?? 0) + 1;
			if (entry.drift) drifts.add(entry.drift);
			assert.ok(entry.claim.length > 10);
		}
		assert.deepEqual(counts, { supported: 12, contradicted: 12, unverifiable: 12 });
		for (const drift of ["retry-vs-exhaustion", "ssh-alias-inversion", "renamed-rule", "expired-snapshot", "masked-rule-ref", "path-forwarding", "home-withheld"]) {
			assert.ok(drifts.has(drift), `missing drift ${drift}`);
		}
		for (const file of ["SYSTEM.md", "RULES.md", "AGENTS.md", "rules/linear-work.md", "rules/ssh.md", "rules/release.md", "rules/tests.md", "rules/wiki.md", "docs/private-results.md", "docs/agent-rules.md", "README.md"]) {
			assert.ok(existsSync(path.join(pluginRoot, "tests", "fixtures", "golden", "corpus", file)), `missing corpus ${file}`);
		}
	});

	await check("keyless golden baseline is 0.67 with zero contradicted recall", () => {
		const goldenEnv = { ...process.env, MEMORY_DREAM_RESULTS_DIR: path.join(root, "golden-offline") };
		const child = spawnSync(process.execPath, [goldenScript, "--offline"], { encoding: "utf8", env: goldenEnv, timeout: 120000 });
		assert.equal(child.status, 0, child.stderr);
		assert.match(child.stdout, /accuracy=0\.67/);
		assert.match(child.stdout, /precision=null recall=0\.00/);
	});

	await check("hermetic fake jev reaches precision/recall 1.00", () => {
		const goldenEnv = { ...process.env, MEMORY_DREAM_RESULTS_DIR: path.join(root, "golden-fake-perfect") };
		const child = spawnSync(process.execPath, [goldenScript, "--fake", "perfect", "--runs", "1"], { encoding: "utf8", env: goldenEnv, timeout: 120000 });
		assert.equal(child.status, 0, child.stderr);
		assert.match(child.stdout, /precision=1\.00 recall=1\.00/);
		assert.match(child.stdout, /adopted=true/);
	});

	await check("hermetic all-incorrect fake is rejected by the adoption threshold", () => {
		const goldenEnv = { ...process.env, MEMORY_DREAM_RESULTS_DIR: path.join(root, "golden-fake-bad") };
		const child = spawnSync(process.execPath, [goldenScript, "--fake", "all-incorrect", "--runs", "1"], { encoding: "utf8", env: goldenEnv, timeout: 120000 });
		assert.equal(child.status, 1, child.stderr);
		assert.match(child.stdout, /precision=0\.50/);
		assert.match(child.stdout, /adopted=false/);
	});

	await check("real jev golden run stops before any call when no key is configured", () => {
		const goldenEnv = { ...process.env, MEMORY_DREAM_RESULTS_DIR: path.join(root, "golden-no-key") };
		delete goldenEnv.JEV_ADVISOR_API_KEY;
		delete goldenEnv.OPENROUTER_API_KEY;
		delete goldenEnv.OPENROUTER_DECISION_API_KEY;
		delete goldenEnv.JEV_ADVISOR_PROVIDER;
		const child = spawnSync(process.execPath, [goldenScript, "--runs", "3"], { encoding: "utf8", env: goldenEnv, timeout: 120000 });
		assert.equal(child.status, 3, child.stderr);
		assert.match(child.stdout, /no_key/);
	});

	await check("generated surfaces are in sync with sources", () => {
		const child = spawnSync(process.execPath, [buildScript, "--check"], { encoding: "utf8", timeout: 60000 });
		assert.equal(child.status, 0, child.stderr);
	});

	await check("read-only memory files are never opened for write", async () => {
		const readOnlyMemory = path.join(agentDir, "memories", "--readonly--");
		const summaryPath = path.join(readOnlyMemory, "memory_summary.md");
		write(summaryPath, "- Linear 429 responses are quota exhaustion; switch to the fallback lane immediately.\n");
		const before = readFileSync(summaryPath, "utf8");
		chmodSync(readOnlyMemory, 0o500);
		chmodSync(summaryPath, 0o400);
		try {
			const result = await core.runDream({
				cwd: project,
				home,
				agentDir,
				memoryDir: readOnlyMemory,
				projectRoot: project,
				env: {},
				envFile: path.join(root, "missing.env"),
				resultsRoot: path.join(root, "readonly-results"),
				writeReports: true,
				now: new Date("2026-11-11T00:00:00Z"),
			});
			assert.ok(result.reportPath && existsSync(result.reportPath));
			assert.equal(readFileSync(summaryPath, "utf8"), before);
			assert.equal(result.report.memory.unchanged, true);
		} finally {
			chmodSync(summaryPath, 0o600);
			chmodSync(readOnlyMemory, 0o700);
		}
	});

	await check("secret claims are redacted in the persisted report", async () => {
		const secretMemory = path.join(agentDir, "memories", "--secret--");
		const token = "sk-abcdefghijklmnopqrstuvwx";
		write(path.join(secretMemory, "memory_summary.md"), `- Deploy with ${token} now.\n`);
		const result = await core.runDream({
			cwd: project,
			home,
			agentDir,
			memoryDir: secretMemory,
			projectRoot: project,
			env: {},
			envFile: path.join(root, "missing.env"),
			resultsRoot: path.join(root, "secret-results"),
			writeReports: true,
			now: new Date("2026-11-11T00:00:00Z"),
		});
		const persisted = readFileSync(result.reportPath!, "utf8");
		assert.ok(!persisted.includes(token));
		assert.match(persisted, /\[REDACTED:openai_key\]/);
		assert.equal(result.report.counts.secretsBlocked, 1);
		assert.equal(result.report.claims[0].externalSend, false);
	});

	await check("budget over-run and dead references appear in the report", async () => {
		const warningMemory = path.join(agentDir, "memories", "--warning--");
		write(path.join(warningMemory, "memory_summary.md"), `${"x".repeat(core.MAX_SUMMARY_BYTES + 10)}\n- Use rule://missing-rule now.\n`);
		const result = await core.runDream({
			cwd: project,
			home,
			agentDir,
			memoryDir: warningMemory,
			projectRoot: project,
			env: {},
			envFile: path.join(root, "missing.env"),
			resultsRoot: path.join(root, "warning-results"),
			writeReports: true,
			now: new Date("2026-11-11T00:00:00Z"),
		});
		assert.equal(result.report.budgets[0].status, "over");
		assert.ok(result.report.deterministic.deadReferences.some(item => item.reference === "missing-rule"));
		const markdown = readFileSync(result.markdownPath!, "utf8");
		assert.match(markdown, /over/);
		assert.match(markdown, /missing-rule/);
	});

	if (networkCalls !== 0) throw new Error(`offline suite made ${networkCalls} network call(s)`);
	console.log(JSON.stringify({ kind: "api-package-test-report", cases, failures, realNetworkCalls: 0 }));
	console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
	process.exitCode = failures || cases === 0 ? 1 : 0;
} finally {
	rmSync(root, { recursive: true, force: true });
}
