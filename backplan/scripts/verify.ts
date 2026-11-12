#!/usr/bin/env bun
/**
 * Offline generated-package acceptance for the backplan plugin.
 *
 * Hermetic: a temporary isolated HOME for journal writes; the user's real
 * ~/.gjc state, credentials and the network are never touched. Cases exercise
 * the core and generated tool with a fake TypeBox provider. An installed
 * completion-gate CLI additionally lints temporary rendered descriptions.
 */
import assert from "node:assert/strict";
import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(import.meta.url);
const plugin = path.resolve(path.dirname(script), "..");

function findCompletionGate() {
	const candidates = [
		process.env.GJC_COMPLETION_GATE,
		process.env.COMPLETION_GATE_BIN,
		...(process.env.PATH ?? "").split(path.delimiter).filter(Boolean).map(dir => path.join(dir, "completion-gate")),
		path.join(os.homedir(), ".gjc", "agent", "policy", "bin", "completion-gate"),
	];
	for (const candidate of candidates) {
		if (!candidate) continue;
		const file = path.resolve(candidate.startsWith("~/") ? path.join(os.homedir(), candidate.slice(2)) : candidate);
		try {
			accessSync(file, constants.X_OK);
			if (statSync(file).isFile()) return file;
		} catch { /* Try the next installed executable; never copy or synthesize one. */ }
	}
	return "";
}

if (process.argv[2] !== "--isolated") {
	const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "backplan-offline-")));
	let status = 1;
	try {
		for (const dir of ["home", "tmp", "cwd", "config"]) mkdirSync(path.join(root, dir), { mode: 0o700 });
		const child = spawnSync(process.execPath, ["--no-env-file", script, "--isolated", root, findCompletionGate()], {
			cwd: path.join(root, "cwd"),
			env: { HOME: path.join(root, "home"), TMPDIR: path.join(root, "tmp"), XDG_CONFIG_HOME: path.join(root, "config"), PATH: process.env.PATH, LC_ALL: "C", BACKPLAN_VERIFY_CHILD: "1" },
			stdio: "inherit",
			timeout: 180000,
		});
		if (child.error) console.error(child.error.message);
		status = child.status ?? 1;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
	process.exitCode = status;
} else {
	await runSuite(process.argv[3], process.argv[4]);
}

async function runSuite(root, completionGate) {
	assert.equal(process.env.BACKPLAN_VERIFY_CHILD, "1");
	assert.equal(os.homedir(), path.join(root, "home"));
	let cases = 0;
	let failures = 0;
	const check = async (name, fn) => {
		cases++;
		try {
			await fn();
			console.log(`ok ${cases} ${name}`);
		} catch (error) {
			failures++;
			console.error(`FAIL ${name}: ${error instanceof Error ? error.stack : String(error)}`);
		}
	};
	const fakePi = { typebox: { Type: { Object: fields => fields, String: options => options ?? {}, Optional: schema => schema } } };

	const core = await import(pathToFileURL(path.join(plugin, "lib/backplan.ts")).href);
	const tool = (await import(pathToFileURL(path.join(plugin, "tools/backplan-check.ts")).href)).default(fakePi);
	const sharedResults = await import(pathToFileURL(path.join(plugin, "../shared/lib/results.ts")).href);

	const validPlan = () => ({
		request: "CANARY add a smoke check to the widget pipeline",
		goal: "Widget pipeline fails loudly on malformed input",
		end_state: "Malformed widget input is rejected with a bounded error and a recorded regression test",
		success_criteria: ["`bun test tests/pipeline.test.ts` shows the malformed-input case green"],
		project: { name: "Widget pipeline", mode: "reuse", reason: "Existing active project covering the widget pipeline track" },
		issues: [
			{
				title: "Reject malformed widget input with a recorded regression test",
				objective: "Malformed input never reaches the renderer",
				context: "repo:widgets, src/pipeline.ts; reproduced by feeding truncated JSON",
				scope_in: ["Add the validation branch and the regression test"],
				scope_out: ["Renderer changes", "UI copy"],
				completion_criteria: ["`bun test tests/pipeline.test.ts` shows the malformed-input case green"],
				delivery: "Local commit on the topic branch",
				dependencies: ["Design review for the error message"],
				labels: ["repo:widgets"],
			},
		],
		policy_decisions: [],
		automation_candidates: [],
	});

	const journalDir = () => path.join(root, "home", ".gjc-plugin", "backplan", "journal", "v1");
	const journalText = () => {
		const inventory = JSON.parse(readFileSync(path.join(journalDir(), "inventory.json"), "utf8"));
		return inventory.segments.map(segment => readFileSync(path.join(journalDir(), segment.name), "utf8")).join("\n");
	};

	await check("lib exposes only the intended surface", () => {
		const exported = Object.keys(core).sort();
		assert.deepEqual(
			exported,
			[
				"BACKPLAN_ARRAY_LIMIT",
				"BACKPLAN_CRITERIA_LIMIT",
				"BACKPLAN_ERROR_LIMIT",
				"BACKPLAN_ISSUE_LIMIT",
				"BACKPLAN_OUTPUT_LIMIT",
				"BACKPLAN_PLAN_BYTES",
				"BACKPLAN_STRING_LIMIT",
				"BACKPLAN_TITLE_LIMIT",
				"checkBackplanPlan",
			].sort(),
		);
	});

	await check("manifest stays tool-only and version-gated", () => {
		const manifest = JSON.parse(readFileSync(path.join(plugin, "gajae-plugin.json"), "utf8"));
		assert.equal(manifest.kind, "gajae-code-plugin");
		assert.equal(manifest.name, "backplan");
		assert.match(manifest.version, /^0\.0\.\d+$/);
		assert.deepEqual(
			manifest.tools.map(entry => entry.name),
			["backplan_check"],
		);
		for (const entry of manifest.tools) assert.ok(existsSync(path.join(plugin, entry.path)), entry.path);
		for (const key of ["mcps", "mcpServers", "hooks", "subskills", "skills", "agents", "commands"]) {
			assert.equal(Object.hasOwn(manifest, key), false, `${key} must stay absent`);
		}
	});

	await check("tool registers with the manifest contract", () => {
		assert.equal(tool.name, "backplan_check");
		assert.equal(tool.label, "Backplan Check");
		assert.equal(typeof tool.execute, "function");
		assert.ok(tool.parameters !== undefined);
	});

	await check("a valid reuse-mode draft renders Linear payloads", () => {
		const report = core.checkBackplanPlan(validPlan(), { session: "session-1", worktree: "/work/tree", branch: "feat/x" });
		assert.equal(report.status, "ok");
		assert.match(report.digest, /^[a-f0-9]{64}$/);
		assert.deepEqual(report.errors, []);
		assert.equal(report.linear.project.mode, "reuse");
		assert.equal(report.linear.project.description, null);
		assert.equal(report.linear.notes, null);
		const issue = report.linear.issues[0];
		assert.equal(issue.title, "Reject malformed widget input with a recorded regression test");
		assert.match(issue.description, /완료 조건/);
		assert.match(issue.description, /`bun test tests\/pipeline\.test\.ts` shows the malformed-input case green/);
		assert.match(issue.description, /세션 session-1/);
		assert.match(issue.description, /브랜치 feat\/x/);
		assert.deepEqual(issue.labels, ["repo:widgets"]);
	});

	const explicitGate = () => [
		{ kind: "lane-receipt" },
		{ kind: "evidence", arg: "Regression check rejects malformed input" },
		{ kind: "vercel", arg: "widget-web.dev_1" },
	];
	const gatePlan = gate => {
		const plan = validPlan();
		plan.issues[0].completion_gate = gate;
		return plan;
	};
	const gateLines = description => description.split("\n").filter(line => /^- \[C\d+\]/.test(line));
	const gateBytes = gate => Buffer.byteLength(gate.map((item, index) => `- [C${index + 1}] ${item.kind}: ${item.arg}\n`).join(""), "utf8");
	const exactByteGate = () => {
		const gate = Array.from({ length: 20 }, () => ({ kind: "evidence", arg: "x".repeat(186) }));
		const remaining = 4096 - gateBytes(gate);
		assert.ok(remaining >= 0 && remaining <= 14);
		gate[19].arg += "x".repeat(remaining);
		assert.equal(gateBytes(gate), 4096);
		return gate;
	};

	await check("omitted completion_gate renders the default C0 contract after human criteria", () => {
		const report = core.checkBackplanPlan(validPlan());
		assert.equal(report.status, "ok");
		const description = report.linear.issues[0].description;
		assert.deepEqual(gateLines(description), ["- [C0] lane-receipt"]);
		assert.ok(description.includes("완료 조건\n\n- [ ] `bun test tests/pipeline.test.ts` shows the malformed-input case green\n\n## 완료 게이트\n\n<!-- completion-gate v1 -->\n\n- [C0] lane-receipt\n\n의존성·실행 경계"));
	});

	await check("explicit completion_gate renders exact ordered C1..Cn criteria per issue", () => {
		const plan = gatePlan(explicitGate());
		plan.issues.push({ ...validPlan().issues[0], title: "A second independently verifiable issue" });
		const report = core.checkBackplanPlan(plan);
		assert.equal(report.status, "ok");
		assert.deepEqual(gateLines(report.linear.issues[0].description), [
			"- [C1] lane-receipt",
			"- [C2] evidence: Regression check rejects malformed input",
			"- [C3] vercel: widget-web.dev_1",
		]);
		assert.deepEqual(gateLines(report.linear.issues[1].description), ["- [C0] lane-receipt"]);
		assert.ok(report.linear.issues[0].description.indexOf("## 완료 게이트") > report.linear.issues[0].description.indexOf("완료 조건"));
		assert.notEqual(report.digest, core.checkBackplanPlan(validPlan()).digest);
		assert.equal(report.digest, core.checkBackplanPlan(JSON.parse(JSON.stringify(plan))).digest);
	});

	await check("completion_gate accepts every kind and exact character/count/byte boundaries", () => {
		for (const gate of [
			[{ kind: "lane-receipt" }, { kind: "propagate" }, { kind: "post-merge-ci" }],
			[{ kind: "evidence", arg: "x" }],
			[{ kind: "evidence", arg: "x".repeat(200) }],
			[{ kind: "evidence", arg: "𐐀".repeat(200) }],
			[{ kind: "vercel", arg: "x".repeat(64) }],
			exactByteGate(),
		]) {
			const report = core.checkBackplanPlan(gatePlan(gate));
			assert.equal(report.status, "ok", JSON.stringify(report.errors));
		}
	});

	const invalidGates = [
		["unknown kind", [{ kind: "deploy" }], /\[0\]\.kind:/],
		["missing kind", [{}], /\[0\]\.kind: required/],
		["undefined kind", [{ kind: undefined }], /\[0\]\.kind: expected/],
		["unknown key", [{ kind: "lane-receipt", id: "X1" }], /\[0\]\.id: unknown key/],
		["empty list", [], /needs at least one/],
		["non-array", null, /expected an array/],
		["non-object", ["lane-receipt"], /expected an object/],
		...["lane-receipt", "propagate", "post-merge-ci"].map(kind => [`${kind} with arg`, [{ kind, arg: "" }], /\.arg: .* takes no argument/]),
		["missing evidence arg", [{ kind: "evidence" }], /\.arg: expected a string/],
		["non-string arg", [{ kind: "evidence", arg: 42 }], /\.arg: expected a string/],
		["empty evidence", [{ kind: "evidence", arg: "" }], /1\.\.200-character/],
		["blank evidence", [{ kind: "evidence", arg: "  " }], /1\.\.200-character/],
		["201-character evidence", [{ kind: "evidence", arg: "x".repeat(201) }], /1\.\.200-character/],
		["vercel path", [{ kind: "vercel", arg: "foo/bar" }], /vercel needs a project name/],
		["vercel spaces", [{ kind: "vercel", arg: "foo bar" }], /vercel needs a project name/],
		["vercel surrounding spaces", [{ kind: "vercel", arg: " foo " }], /vercel needs a project name/],
		["65-character vercel", [{ kind: "vercel", arg: "x".repeat(65) }], /vercel needs a project name/],
		["LF arg", [{ kind: "evidence", arg: "one\ntwo" }], /must not contain line breaks/],
		["CR arg", [{ kind: "evidence", arg: "one\rtwo" }], /must not contain line breaks/],
		["Unicode line separator arg", [{ kind: "evidence", arg: "one\u2028two" }], /must not contain line breaks/],
		["21 criteria", Array.from({ length: 21 }, () => ({ kind: "lane-receipt" })), /20-criterion limit/],
		["UTF-8 byte overflow", Array.from({ length: 14 }, () => ({ kind: "evidence", arg: "한".repeat(100) })), /4096-byte limit/],
	];
	for (const [name, gate, pattern] of invalidGates) {
		await check(`completion_gate rejects ${name} with a path-addressed error`, () => {
			const report = core.checkBackplanPlan(gatePlan(gate));
			assert.equal(report.status, "invalid");
			assert.equal(report.digest, null);
			assert.equal(report.linear, null);
			assert.ok(report.errors.some(error => error.startsWith("issues[0].completion_gate") && pattern.test(error)), JSON.stringify(report.errors));
		});
	}

	await check("completion_gate rejects exactly one byte beyond the canonical block limit", () => {
		const gate = exactByteGate();
		gate[19].arg += "x";
		assert.equal(gateBytes(gate), 4097);
		assert.deepEqual(core.checkBackplanPlan(gatePlan(gate)).errors, ["issues[0].completion_gate: rendered block exceeds the 4096-byte limit"]);
	});

	await check("free text cannot introduce reserved completion-gate markers or title lines", () => {
		const mutations = [
			plan => { plan.request = "<!-- completion-gate v1 -->"; },
			plan => { plan.goal = "Goal\n## 완료 게이트"; },
			plan => { plan.end_state = "<!-- completion-gate v1 -->"; },
			plan => { plan.success_criteria = ["Check result\n완료 게이트"]; },
			plan => { plan.project.name = "Project\n완료 게이트"; },
			plan => { plan.project.reason = "<!-- completion-gate v1 -->"; },
			plan => { plan.project.boundaries = ["완료 게이트"]; },
			...["title", "objective", "context", "delivery"].map(key => plan => { plan.issues[0][key] = "Text\n  ###완료 게이트  \n"; }),
			...["scope_in", "scope_out", "completion_criteria", "dependencies"].map(key => plan => { plan.issues[0][key] = ["Text <!-- completion-gate v1 --> text"]; }),
			plan => { plan.issues[0].context = "Example\r완료 게이트"; },
			plan => { plan.policy_decisions = [{ topic: "완료 게이트", needs_user_decision: false, options: [], record_location: "project" }]; },
			plan => { plan.automation_candidates = [{ candidate: "<!-- completion-gate v1 -->", disposition: "backlog" }]; },
			plan => { plan.issues[0].completion_gate = [{ kind: "evidence", arg: "<!-- completion-gate v1 -->" }]; },
		];
		for (const mutate of mutations) {
			const plan = validPlan();
			mutate(plan);
			const report = core.checkBackplanPlan(plan);
			assert.equal(report.status, "invalid");
			assert.ok(report.errors.some(error => /completion-gate (marker|title) is reserved/.test(error)), JSON.stringify(report.errors));
		}
		for (const key of ["session", "worktree", "branch"]) {
			assert.equal(core.checkBackplanPlan(validPlan(), { [key]: "Text\n완료 게이트" }).status, "invalid");
		}
		const prose = validPlan();
		prose.issues[0].context = "완료 게이트를 확인하는 일반 문장";
		assert.equal(core.checkBackplanPlan(prose).status, "ok");
	});

	await check("free-text code fences cannot hide the rendered authoritative block", () => {
		for (const fence of ["```", "~~~"]) {
			const plan = gatePlan(explicitGate());
			plan.issues[0].context = `Example\n${fence}\ntruncated code`;
			assert.deepEqual(core.checkBackplanPlan(plan).errors, ["issues[0]: unclosed free-text code fence hides the completion-gate block"]);
			plan.issues[0].context += `\n${fence}`;
			assert.equal(core.checkBackplanPlan(plan).status, "ok", "balanced fences remain supported");
		}
	});

	if (!completionGate) {
		console.log("skip: completion-gate not installed");
	} else {
		await check("installed completion-gate lint accepts rendered descriptions with matching criteria", () => {
			const fenced = gatePlan(explicitGate());
			fenced.issues[0].context = "Example\n```\nquoted code\n```";
			for (const plan of [validPlan(), gatePlan(explicitGate()), gatePlan(exactByteGate()), fenced]) {
				const report = core.checkBackplanPlan(plan);
				assert.equal(report.status, "ok", JSON.stringify(report.errors));
				const file = path.join(root, "tmp", "completion-gate.md");
				writeFileSync(file, report.linear.issues[0].description);
				const lint = spawnSync(completionGate, ["lint", file, "--json"], { encoding: "utf8", timeout: 30000 });
				assert.equal(lint.status, 0, lint.stderr || lint.stdout || lint.error?.message);
				const result = JSON.parse(lint.stdout);
				assert.equal(result.ok, true);
				assert.equal(result.block, "block", "the rendered contract must be authoritative, not a parser fallback");
				assert.deepEqual(result.criteria, plan.issues[0].completion_gate
					? plan.issues[0].completion_gate.map((item, index) => ({ id: `C${index + 1}`, kind: item.kind, arg: item.arg ?? "" }))
					: [{ id: "C0", kind: "lane-receipt", arg: "" }]);
			}
		});
	}

	await check("create mode renders a project description from the goal and criteria", () => {
		const plan = validPlan();
		plan.project.mode = "create";
		plan.project.boundaries = ["배포는 별도 승인 범위"];
		const report = core.checkBackplanPlan(plan);
		assert.equal(report.status, "ok");
		assert.match(report.linear.project.description, /## 목표/);
		assert.match(report.linear.project.description, /## 비범위/);
		assert.match(report.linear.project.description, /backplan digest: sha256:[a-f0-9]{64}/);
	});

	await check("plan notes render policy decisions and automation candidates", () => {
		const plan = validPlan();
		plan.policy_decisions = [{ topic: "Public wording", needs_user_decision: true, options: ["A", "B"], record_location: "project description" }];
		plan.automation_candidates = [{ candidate: "Auto-run the smoke check in CI", disposition: "backlog" }];
		const report = core.checkBackplanPlan(plan);
		assert.equal(report.status, "ok");
		assert.match(report.linear.notes, /### 정책·결정/);
		assert.match(report.linear.notes, /Public wording — 사용자 결정 필요 \(옵션: A \/ B\)/);
		assert.match(report.linear.notes, /### 자동화 후보 \(비범위\)/);
	});

	await check("digest is key-order independent and content sensitive", () => {
		const plan = validPlan();
		// Rebuild with reversed key order at every level.
		const reverse = value => {
			if (Array.isArray(value)) return value.map(reverse);
			if (value !== null && typeof value === "object") {
				const out = {};
				for (const key of Object.keys(value).reverse()) out[key] = reverse(value[key]);
				return out;
			}
			return value;
		};
		const first = core.checkBackplanPlan(plan).digest;
		const second = core.checkBackplanPlan(reverse(plan)).digest;
		assert.equal(first, second);
		const changed = validPlan();
		changed.goal = "A different goal";
		assert.notEqual(core.checkBackplanPlan(changed).digest, first);
	});

	await check("invalid drafts are rejected with path-addressed errors", () => {
		const without = mutate => {
			const plan = validPlan();
			mutate(plan);
			return core.checkBackplanPlan(plan);
		};
		const cases = [
			[without(plan => delete plan.end_state), /end_state/],
			[without(plan => delete plan.project), /project.*(required|expected)/],
			[without(plan => { plan.project.mode = "keep"; }), /project\.mode/],
			[without(plan => { plan.issues[0].scope_out = []; }), /scope_out.*at least 1/],
			[without(plan => { plan.issues[0].completion_criteria = ["완료"]; }), /generic/],
			[without(plan => { plan.issues[0].completion_criteria = ["ok fix"]; }), /too short/],
			[without(plan => { plan.automation_candidates = [{ candidate: "x", disposition: "in_scope" }]; }), /promote in-scope/],
			[without(plan => { plan.extra = 1; }), /unknown key/],
			[without(plan => { plan.issues.push({ ...plan.issues[0] }); }), /duplicates/],
			[without(plan => { plan.policy_decisions = [{ topic: "t", needs_user_decision: true, options: [], record_location: "x" }]; }), /needs at least one option/],
			[without(plan => { plan.policy_decisions = [{ topic: "t", needs_user_decision: "yes", options: ["a"], record_location: "x" }]; }), /expected true or false/],
			[without(plan => delete plan.policy_decisions), /policy_decisions.*required/],
		];
		for (const [report, pattern] of cases) {
			assert.equal(report.status, "invalid");
			assert.equal(report.digest, null);
			assert.equal(report.linear, null);
			assert.ok(report.errors.some(error => pattern.test(error)), `expected ${pattern} in ${JSON.stringify(report.errors)}`);
		}
	});

	await check("a missing required key is reported exactly once", () => {
		const sparse = core.checkBackplanPlan({ goal: "Ship a docs fix" });
		assert.equal(sparse.status, "invalid");
		assert.deepEqual(sparse.errors, [
			"plan.end_state: required",
			"plan.success_criteria: required",
			"plan.project: required",
			"plan.issues: required",
			"plan.policy_decisions: required",
			"plan.automation_candidates: required",
		]);
		const plan = validPlan();
		delete plan.issues[0].delivery;
		plan.issues[0].scope_out = [];
		const nested = core.checkBackplanPlan(plan);
		assert.deepEqual(nested.errors, ["issues[0].delivery: required", "issues[0].scope_out: needs at least 1 item(s)"]);
		const modeless = validPlan();
		delete modeless.project.mode;
		assert.deepEqual(core.checkBackplanPlan(modeless).errors, ["project.mode: required"]);
		const candidate = validPlan();
		candidate.automation_candidates = [{ candidate: "Auto-run the smoke check in CI" }];
		assert.deepEqual(core.checkBackplanPlan(candidate).errors, ["automation_candidates[0].disposition: required"]);
		const badMode = validPlan();
		badMode.project.mode = "keep";
		assert.deepEqual(core.checkBackplanPlan(badMode).errors, ["project.mode: expected reuse or create"]);
	});

	await check("repeated criteria warn while the plan still passes", () => {
		const plan = validPlan();
		plan.issues[0].completion_criteria = ["`bun test tests/pipeline.test.ts` green", "`bun test tests/pipeline.test.ts` green"];
		const report = core.checkBackplanPlan(plan);
		assert.equal(report.status, "ok");
		assert.ok(report.warnings.some(warning => /duplicates/.test(warning)), JSON.stringify(report.warnings));
		const goals = validPlan();
		goals.success_criteria = ["`bun test tests/pipeline.test.ts` green", "`bun test tests/pipeline.test.ts` green"];
		const goalReport = core.checkBackplanPlan(goals);
		assert.equal(goalReport.status, "ok");
		assert.ok(goalReport.warnings.some(warning => /success_criteria\[1\]/.test(warning)), JSON.stringify(goalReport.warnings));
	});

	await check("count limits bound criteria and issues", () => {
		const criteria = validPlan();
		criteria.success_criteria = Array.from({ length: core.BACKPLAN_CRITERIA_LIMIT + 1 }, (_, index) => `\`bun test suite-${index}\` shows case ${index} green`);
		const criteriaReport = core.checkBackplanPlan(criteria);
		assert.equal(criteriaReport.status, "invalid");
		assert.ok(criteriaReport.errors.some(error => /12-criterion limit/.test(error)), JSON.stringify(criteriaReport.errors));
		const issues = validPlan();
		issues.issues = Array.from({ length: core.BACKPLAN_ISSUE_LIMIT + 1 }, (_, index) => ({ ...validPlan().issues[0], title: `Issue ${index} rejects malformed widget input with a recorded regression test` }));
		const issuesReport = core.checkBackplanPlan(issues);
		assert.equal(issuesReport.status, "invalid");
		assert.ok(issuesReport.errors.some(error => /24-issue limit/.test(error)), JSON.stringify(issuesReport.errors));
	});

	await check("nested unknown keys and prototype keys are rejected without pollution", () => {
		const nested = validPlan();
		nested.issues[0].extra = "nope";
		const nestedReport = core.checkBackplanPlan(nested);
		assert.equal(nestedReport.status, "invalid");
		assert.ok(nestedReport.errors.some(error => /issues\[0\]\.extra: unknown key/.test(error)), JSON.stringify(nestedReport.errors));
		const polluted = JSON.parse(`{"__proto__":{"polluted":true},${JSON.stringify(validPlan()).slice(1)}`);
		assert.equal(Object.getPrototypeOf(polluted), Object.prototype);
		const pollutedReport = core.checkBackplanPlan(polluted);
		assert.equal(pollutedReport.status, "invalid");
		assert.ok(pollutedReport.errors.some(error => /__proto__: unknown key/.test(error)), JSON.stringify(pollutedReport.errors));
		assert.equal(({} as Record<string, unknown>).polluted, undefined);
	});

	await check("labels must be well-formed, unicode is accepted and request stays optional", () => {
		const badLabel = validPlan();
		badLabel.issues[0].labels = ["Bad Label!"];
		const labelReport = core.checkBackplanPlan(badLabel);
		assert.equal(labelReport.status, "invalid");
		assert.ok(labelReport.errors.some(error => /expected a label like repo:gjc-plugin/.test(error)), JSON.stringify(labelReport.errors));
		const unicode = validPlan();
		unicode.issues[0].completion_criteria = ["`bun test tests/pipeline.test.ts` 통과 ✅ shows malformed input rejected"];
		assert.equal(core.checkBackplanPlan(unicode).status, "ok");
		const noRequest = validPlan();
		delete noRequest.request;
		const requestReport = core.checkBackplanPlan(noRequest);
		assert.equal(requestReport.status, "ok");
		assert.match(requestReport.digest, /^[a-f0-9]{64}$/);
	});

	await check("oversized rendered output is rejected with a bounded error", () => {
		const plan = validPlan();
		plan.issues[0].scope_in = Array.from({ length: core.BACKPLAN_ARRAY_LIMIT }, (_, index) => `In-scope item ${index}: ${"x".repeat(1900)}`);
		plan.issues[0].scope_out = Array.from({ length: core.BACKPLAN_ARRAY_LIMIT }, (_, index) => `Out-of-scope item ${index}: ${"y".repeat(1900)}`);
		const report = core.checkBackplanPlan(plan);
		assert.equal(report.status, "invalid");
		assert.deepEqual(report.errors, ["rendered output exceeds the bounded limit; split the plan into smaller issues"]);
	});

	await check("execute renders ok and journals one sanitized record", async () => {
		const plan = gatePlan(explicitGate());
		const result = await tool.execute("call-ok", { plan: JSON.stringify(plan), session: "s", worktree: "/w", branch: "b" });
		assert.notEqual(result.isError, true);
		const text = result.content[0].text;
		assert.match(text, /^backplan_check: ok\n/);
		const lines = text.trimEnd().split("\n");
		const journalLine = JSON.parse(lines[lines.length - 1]);
		const reportLine = JSON.parse(lines[lines.length - 2]);
		assert.equal(journalLine.journalStorage.persisted, true, JSON.stringify(journalLine));
		assert.equal(reportLine.status, "ok");
		assert.deepEqual(gateLines(reportLine.linear.issues[0].description), [
			"- [C1] lane-receipt",
			"- [C2] evidence: Regression check rejects malformed input",
			"- [C3] vercel: widget-web.dev_1",
		]);
		const segment = journalText();
		assert.match(segment, /"operation":"backplan_check"/);
		assert.doesNotMatch(segment, /CANARY/, "journal must not carry plan content");
	});

	await check("execute rejects malformed input and contract violations", async () => {
		const neither = await tool.execute("call-none", {});
		assert.equal(neither.isError, true);
		assert.match(neither.content[0].text, /invalid_input/);
		const both = await tool.execute("call-both", { plan: "{}", plan_path: "/tmp/x.json" });
		assert.equal(both.isError, true);
		assert.match(both.content[0].text, /exactly one/);
		const badJson = await tool.execute("call-badjson", { plan: "{not json" });
		assert.equal(badJson.isError, true);
		assert.match(badJson.content[0].text, /not valid JSON/);
		const missingPath = await tool.execute("call-missing", { plan_path: path.join(root, "tmp", "nope.json") });
		assert.equal(missingPath.isError, true);
		assert.match(missingPath.content[0].text, /not readable/);
		const violations = validPlan();
		delete violations.end_state;
		const invalid = await tool.execute("call-invalid", { plan: JSON.stringify(violations) });
		assert.equal(invalid.isError, true);
		assert.match(invalid.content[0].text, /^backplan_check: invalid\n/);
		const badGate = await tool.execute("call-invalid-gate", { plan: JSON.stringify(gatePlan([{ kind: "deploy" }])) });
		assert.equal(badGate.isError, true);
		assert.match(badGate.content[0].text, /issues\[0\]\.completion_gate\[0\]\.kind/);
	});

	await check("execute reads a plan file and refuses oversized or symlinked paths", async () => {
		const planPath = path.join(root, "tmp", "plan.json");
		writeFileSync(planPath, JSON.stringify(validPlan()));
		const viaFile = await tool.execute("call-file", { plan_path: planPath });
		assert.notEqual(viaFile.isError, true);
		assert.match(viaFile.content[0].text, /^backplan_check: ok\n/);
		const oversized = path.join(root, "tmp", "oversized.json");
		writeFileSync(oversized, JSON.stringify({ pad: "x".repeat(core.BACKPLAN_PLAN_BYTES + 1) }));
		const tooBig = await tool.execute("call-big", { plan_path: oversized });
		assert.equal(tooBig.isError, true);
		assert.match(tooBig.content[0].text, /exceeds the \d+-byte limit/);
		const link = path.join(root, "tmp", "link.json");
		symlinkSync(planPath, link);
		const viaLink = await tool.execute("call-link", { plan_path: link });
		assert.equal(viaLink.isError, true);
		assert.match(viaLink.content[0].text, /no symlinks/);
		const dirPath = path.join(root, "tmp", "plan-dir");
		mkdirSync(dirPath);
		const viaDir = await tool.execute("call-dir", { plan_path: dirPath });
		assert.equal(viaDir.isError, true);
		assert.match(viaDir.content[0].text, /regular file/);
		const inline = validPlan();
		inline.goal = `goal ${"x".repeat(core.BACKPLAN_PLAN_BYTES)}`;
		const tooBigInline = await tool.execute("call-inline-big", { plan: JSON.stringify(inline) });
		assert.equal(tooBigInline.isError, true);
		assert.match(tooBigInline.content[0].text, /exceeds the \d+-byte limit/);
	});

	await check("shared results module accepts the backplan plugin and operation", async () => {
		const append = sharedResults.appendPluginOutcome;
		assert.equal((await append("backplan", { operation: "backplan_check" })).persisted, true);
		assert.equal((await append("backplan", { operation: "unknown_operation" })).persisted, false);
		assert.equal((await append("nonexistent-plugin", { operation: "backplan_check" })).persisted, false);
	});

	await check("generated surface is in sync with sources (rebuild is a no-op)", () => {
		const target = path.join(plugin, "tools/backplan-check.ts");
		const before = readFileSync(target, "utf8");
		const build = spawnSync(process.execPath, [path.join(plugin, "scripts/build.mjs")], { encoding: "utf8", timeout: 60000 });
		assert.equal(build.status, 0, build.stderr);
		assert.equal(readFileSync(target, "utf8"), before, "tools/backplan-check.ts drifted");
	});

	await check("skill payload matches the frontmatter and tool contract", () => {
		const skill = readFileSync(path.join(plugin, "skills", "backplan", "SKILL.md"), "utf8");
		assert.match(skill, /^---\r?\nname: backplan\r?\ndescription: [^\n]+\r?\n---/);
		assert.ok(skill.includes("backplan_check"), "skill must reference the tool");
		assert.ok(skill.includes("linear-trace.py"), "skill must reference the trace tool");
		assert.ok(skill.includes("end state"), "skill must carry the backward method");
	});

	console.log(JSON.stringify({ kind: "api-package-test-report", cases, failures, realNetworkCalls: 0 }));
	console.log(failures ? `FAILED ${failures}/${cases}` : `ALL PASS (${cases} cases)`);
	process.exitCode = failures || cases === 0 ? 1 : 0;
}
