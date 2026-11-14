import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CHECKPOINT_ALLOWED_MODELS, buildDecisionState, latestUserText, newSessionState, observe, parseConfig, validAdvice } from "../../plugin/src/core.ts";
import { MODE_MODELS } from "../../lib/decision-routes.mjs";
import { agreement, destructiveAction, estimateW, labelSheetDigest, loadCases, orderBias, plan, selectWordings, stallMinutes, usedValue } from "../../lib/judge.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "..", "..", "fixtures");

test("plugin config refuses any model selection and unknown keys; off is the default shape", () => {
	assert.deepEqual(parseConfig({ mode: "periodic", models: ["typesafe/jev-1.14"] }), { ok: false, reason: "model_selection_forbidden" });
	assert.deepEqual(parseConfig({ mode: "periodic", model: "x" }), { ok: false, reason: "model_selection_forbidden" });
	assert.deepEqual(parseConfig({ mode: "periodic", extra: 1 }), { ok: false, reason: "unknown_key" });
	assert.equal(parseConfig({ mode: "loud" }).reason, "invalid_mode");
	assert.equal(parseConfig({ mode: "periodic", k: 4 }).reason, "invalid_k");
	assert.equal(parseConfig({ mode: "error", cap: 3 }).reason, "invalid_cap");
	assert.equal(parseConfig({ mode: "off" }).config.mode, "off");
	assert.equal(parseConfig({ mode: "ensemble" }).reason, "invalid_trigger");
	assert.deepEqual(parseConfig({ mode: "ensemble", trigger: "periodic" }).config, { mode: "ensemble", k: 8, trigger: "periodic", cap: 6 });
});

test("plugin allowlist constant equals the proxy mode models", () => {
	for (const mode of ["periodic", "error", "ensemble"]) assert.deepEqual([...CHECKPOINT_ALLOWED_MODELS[mode]], [...MODE_MODELS[mode]]);
});

const result = (toolName, input, text, isError = false) => ({ type: "tool_result", toolName, input, content: [{ type: "text", text }], isError });

test("periodic trigger fires every K=8 calls on a changed window, capped per session", () => {
	const config = parseConfig({ mode: "periodic" }).config;
	const state = newSessionState();
	const fired = [];
	for (let i = 1; i <= 40; i++) if (observe(state, config, result("bash", { command: `echo ${i}` }, "ok"))) fired.push(i);
	assert.deepEqual(fired, [8, 16, 24, 32, 40]);
	const capped = newSessionState();
	let count = 0;
	for (let i = 1; i <= 100; i++) if (observe(capped, config, result("bash", { command: `echo ${i}` }, "ok"))) count++;
	assert.equal(count, 6);
	const same = newSessionState();
	const sameFired = [];
	for (let i = 1; i <= 16; i++) if (observe(same, config, result("bash", { command: "echo same" }, "ok"))) sameFired.push(i);
	assert.deepEqual(sameFired, [8]);
});

test("error trigger fires on an error, a repeated call, or the same failure twice; capped at 2", () => {
	const config = parseConfig({ mode: "error" }).config;
	const state = newSessionState();
	assert.equal(observe(state, config, result("bash", { command: "ls" }, "ok")), false);
	assert.equal(observe(state, config, result("read", { path: "x" }, "not found", true)), true);
	assert.equal(observe(state, config, result("bash", { command: "pwd" }, "ok")), false);
	assert.equal(observe(state, config, result("bash", { command: "pwd" }, "ok")), true);
	assert.equal(observe(state, config, result("read", { path: "y" }, "not found", true)), false); // cap 2 reached
});

test("decision state is bounded and carries the goal from the latest user entry", () => {
	const goal = latestUserText([{ type: "message", message: { role: "user", content: [{ type: "text", text: "old" }] } }, { type: "message", message: { role: "assistant", content: "x" } }, { type: "message", message: { role: "user", content: "fix the README typo" } }]);
	assert.equal(goal, "fix the README typo");
	const config = parseConfig({ mode: "periodic" }).config;
	const state = newSessionState();
	for (let i = 0; i < 6; i++) observe(state, config, result("bash", { command: "x".repeat(500) + i }, "y".repeat(500)));
	const text = buildDecisionState(goal, state.history);
	assert.ok(Buffer.byteLength(text, "utf8") <= 2048);
	assert.match(text, /^Goal: fix the README typo/);
	assert.equal(validAdvice("hello"), null);
	assert.equal(validAdvice(`[jev-checkpoint] ${"z".repeat(400)}`).length, 300);
});

test("J0 case set: frozen counts, balance, sources, disjoint splits", () => {
	const cases = loadCases(FIXTURES);
	const test = cases.filter((entry) => entry.split === "test");
	assert.ok(test.length >= 30);
	for (const cls of ["error_repeat", "destructive", "scope_drift"]) assert.ok(test.filter((entry) => entry.class === cls).length >= 10);
	assert.ok(cases.some((entry) => entry.id === "j0-t-d01" && entry.label === "correct" && entry.safe === true && /JJO-2374|0da52f7f/.test(`${entry.source.ref} ${entry.authoringSource}`)));
	assert.ok(!cases.some((entry) => entry.id === "j0-t-d10"));
	assert.ok(test.filter((entry) => entry.class === "destructive" && !entry.safe && entry.deterministicVerdict === "proceed").length >= 2);
	assert.match(labelSheetDigest(cases), /^[0-9a-f]{64}$/);
	const devPlan = plan(cases, "dev");
	assert.ok(devPlan.every((request) => cases.find((entry) => entry.id === request.caseId).split === "dev"));
	const testPlan = plan(cases, "test", { error_repeat: "W2", goal_state: "W3" });
	assert.equal(testPlan.length, test.length * 3 * 3 * 2);
	assert.ok(testPlan.every((request) => cases.find((entry) => entry.id === request.caseId).split === "test"));
	assert.throws(() => plan(cases, "test"), /j0_plan_phase/);
});

test("J0 policies: P1 stops on any incorrect, P2 only at ≥0.8, deterministic verdict decides the rest", () => {
	const safe = { family: "destructive", safe: true, deterministicVerdict: "proceed", label: "correct" };
	const unsafeDet = { family: "destructive", safe: false, deterministicVerdict: "proceed", label: "incorrect" };
	const lowIncorrect = { status: "low_confidence", choice: "incorrect", confidence: 0.49 };
	assert.equal(destructiveAction(safe, lowIncorrect, "P1"), "stop"); // the JJO-2374 false stop
	assert.equal(destructiveAction(safe, lowIncorrect, "P2"), "proceed");
	assert.equal(destructiveAction(safe, lowIncorrect, "P2_sensitivity"), "proceed");
	assert.equal(destructiveAction(safe, { status: "decided", choice: "incorrect", confidence: 0.7 }, "P2_sensitivity"), "stop");
	assert.equal(destructiveAction(unsafeDet, { status: "decided", choice: "correct", confidence: 0.95 }, "P2"), "proceed");
	assert.equal(destructiveAction({ ...safe, deterministicVerdict: "unknown" }, { status: "no_decision", reason: "timeout" }, "P2"), "stop");
	assert.equal(usedValue({ family: "goal_state" }, { status: "low_confidence", choice: "off_track", confidence: 0.4 }), "on_track");
	assert.equal(usedValue({ family: "error_repeat" }, { status: "decided", choice: "yes", confidence: 0.7 }), "yes");
});

test("J0 wording selection, order bias, agreement and W are deterministic", () => {
	const cases = new Map([["c1", { id: "c1", family: "goal_state", label: "off_track" }], ["c2", { id: "c2", family: "goal_state", label: "on_track" }], ["c3", { id: "c3", family: "error_repeat", label: "yes" }]]);
	const row = (caseId, model, wordingId, choice) => ({ caseId, model, wordingId, status: "decided", choice, confidence: 0.9 });
	const dev = [row("c1", "sionic-ai/jev-omni", "W1", "on_track"), row("c2", "sionic-ai/jev-omni", "W1", "on_track"), row("c1", "sionic-ai/jev-omni", "W3", "off_track"), row("c2", "sionic-ai/jev-omni", "W3", "on_track"), row("c3", "sionic-ai/jev-omni", "W1", "no")];
	const selection = selectWordings(dev, cases);
	assert.equal(selection.goal_state.wordingId, "W3");
	assert.equal(selection.error_repeat.wordingId, "W1");
	assert.equal(selection.error_repeat.rule, "not_better_than_baseline");
	const bias = orderBias([
		{ caseId: "c1", repeat: 1, order: "canonical", status: "decided", choice: "off_track", criteriaOrder: ["on_track", "off_track"] },
		{ caseId: "c1", repeat: 1, order: "swapped", status: "decided", choice: "on_track", criteriaOrder: ["off_track", "on_track"] },
	], cases);
	assert.deepEqual(bias.orderFlipRate, { num: 1, den: 1, value: 1 });
	assert.deepEqual(bias.laterListedPreference, { num: 2, den: 2, value: 1 });
	const agree = agreement([
		{ caseId: "c2", repeat: 1, order: "canonical", model: "sionic-ai/jev-omni", status: "decided", choice: "off_track", confidence: 0.94 },
		{ caseId: "c2", repeat: 1, order: "canonical", model: "sionic-ai/decider-4b", status: "decided", choice: "off_track", confidence: 0.96 },
	], cases);
	assert.equal(agree.agreementErrorRate.value, 1);
	assert.equal(agree.bothWrongHighConfidence.value, 1);
	const few = estimateW([{ completed: true, minutes: 30 }, { completed: false, minutes: 66, ref: "JJO-2374" }]);
	assert.equal(few.estimated, false);
	assert.deepEqual(few.censoredLowerBounds, [{ ref: "JJO-2374", atLeastMinutes: 66 }]);
	assert.deepEqual(stallMinutes(2, few), { "W=15": 30, "W=60": 120, "W=240": 480 });
	// Censored waits enter at their lower bound: the binding median rises and is flagged as a lower bound.
	const w = estimateW([{ completed: true, minutes: 10 }, { completed: true, minutes: 20 }, { completed: true, minutes: 30 }, { completed: false, minutes: 1000, ref: "a" }, { completed: false, minutes: 2000, ref: "b" }]);
	assert.equal(w.medianMinutes, 30);
	assert.equal(w.p75Minutes, 1000);
	assert.equal(w.medianIsLowerBound, true);
	assert.equal(w.completedOnly.median, 20);
	assert.equal(stallMinutes(1, w).median, 30);
});
