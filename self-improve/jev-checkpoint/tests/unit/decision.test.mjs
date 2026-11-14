import test from "node:test";
import assert from "node:assert/strict";
import { J0_JUDGE_ROUTES, MODE_MODELS, TRIAL_DECISION_ROUTES, resolveDecisionRoute, surfaceOrigins } from "../../lib/decision-routes.mjs";
import { DECISION_PROVIDERS } from "../../../../shared/lib/decision-contract.ts";
import { FAMILIES, buildDecisionBody, questionDigest, swappedOrder } from "../../lib/questions.mjs";
import { PRIMARY_SUM_TOLERANCE, classifyDecision } from "../../lib/decision-outcome.mjs";
import { combineVoters, combineVotersVoterLevel } from "../../lib/ensemble.mjs";
import { createDecisionDispatcher } from "../../lib/decision-client.mjs";
import { createLedger } from "../../lib/accounting.mjs";

const STATE = "Goal: report today's PR budget.\nRecent actions:\n- bash pr-budget → ok {\"maxPrs\":5,\"used\":2}";
const answer = (choice, probabilities, confidence, name = "decision") => ({ answers: { [name]: { type: "choice", choice, probabilities, ...(confidence === undefined ? {} : { confidence }) } }, usage: { prompt_tokens: 300 } });

test("trial allowlist is exactly jev-omni + decider-4b; J0 adds only jev-1.14", () => {
	assert.deepEqual(Object.keys(TRIAL_DECISION_ROUTES).sort(), ["sionic-ai/decider-4b", "sionic-ai/jev-omni"]);
	assert.deepEqual(Object.keys(J0_JUDGE_ROUTES).sort(), ["sionic-ai/decider-4b", "sionic-ai/jev-omni", "typesafe/jev-1.14"]);
	assert.equal(resolveDecisionRoute("typesafe/jev-1.14", "trial").ok, false);
	assert.equal(resolveDecisionRoute("typesafe/jev-1.14", "trial").reason, "route_not_allowed");
	assert.equal(resolveDecisionRoute("typesafe/jev-1.14", "j0").ok, true);
	assert.equal(resolveDecisionRoute("sionic-ai/jev-omni@openrouter", "trial").ok, false);
	assert.equal(resolveDecisionRoute("constructor", "trial").ok, false);
	assert.equal(resolveDecisionRoute("sionic-ai/jev-omni", "elsewhere").reason, "unknown_surface");
	assert.deepEqual(surfaceOrigins("trial"), ["https://apis.opengateway.ai"]);
	assert.deepEqual(surfaceOrigins("j0"), ["https://apis.opengateway.ai", "https://openrouter.ai"]);
	for (const models of Object.values(MODE_MODELS)) if (models) for (const model of models) assert.equal(resolveDecisionRoute(model, "trial").ok, true);
});

test("allowlist entries are bound to the shared decision contract (id, model, endpoint, authEnv)", () => {
	for (const entry of Object.values(J0_JUDGE_ROUTES)) {
		const contract = DECISION_PROVIDERS.find((provider) => provider.id === entry.id);
		assert.ok(contract, entry.id);
		assert.equal(contract.model, entry.model);
		assert.equal(contract.endpoint, entry.endpoint);
		assert.deepEqual([...contract.authEnv].sort(), [...entry.authEnv].sort());
	}
});

test("criteria is serialized as an object in the declared order; arrays and oversize bodies are refused", () => {
	const built = buildDecisionBody({ model: "sionic-ai/jev-omni", family: "goal_state", wordingId: "W2", state: STATE });
	const wire = JSON.parse(built.raw);
	assert.equal(wire.questions.decision.type, "choice");
	assert.ok(wire.questions.decision.criteria && !Array.isArray(wire.questions.decision.criteria));
	assert.deepEqual(Object.keys(wire.questions.decision.criteria), ["on_track", "off_track"]);
	const swapped = buildDecisionBody({ model: "sionic-ai/jev-omni", family: "goal_state", wordingId: "W2", state: STATE, criteriaOrder: swappedOrder(FAMILIES.goal_state.canonicalOrder) });
	assert.deepEqual(Object.keys(JSON.parse(swapped.raw).questions.decision.criteria), ["off_track", "on_track"]);
	assert.throws(() => buildDecisionBody({ model: "m", family: "goal_state", wordingId: "W2", state: STATE, criteriaOrder: ["on_track"] }), /invalid_criteria/);
	assert.throws(() => buildDecisionBody({ model: "m", family: "goal_state", wordingId: "W2", state: STATE, criteriaOrder: ["on_track", "maybe"] }), /invalid_criteria/);
	assert.throws(() => buildDecisionBody({ model: "m", family: "goal_state", wordingId: "W9", state: STATE }), /unknown_wording/);
	assert.throws(() => buildDecisionBody({ model: "m", family: "goal_state", wordingId: "W2", state: "x".repeat(2049) }), /state_too_large/);
	const destructive = buildDecisionBody({ model: "typesafe/jev-1.14", family: "destructive", wordingId: "RULES", state: STATE });
	assert.equal(destructive.questionName, "check");
	assert.deepEqual(Object.keys(JSON.parse(destructive.raw).questions.check.criteria), ["correct", "incorrect", "unsure"]);
	assert.notEqual(questionDigest({ family: "goal_state", wordingId: "W2" }), questionDigest({ family: "goal_state", wordingId: "W2", criteriaOrder: ["off_track", "on_track"] }));
});

test("unnormalized probabilities are their own no-decision reason at the 1e-6 boundary", () => {
	const labels = ["yes", "no"];
	const exact = classifyDecision({ payload: answer("yes", { yes: 0.7, no: 0.3 }, 0.4), questionName: "decision", labels, threshold: 0.6 });
	assert.equal(exact.status, "low_confidence");
	const atBound = classifyDecision({ payload: answer("yes", { yes: 0.9, no: 0.100001 }, 0.8), questionName: "decision", labels, threshold: 0.6 });
	assert.ok(Math.abs(atBound.sumDeviation - 1e-6) < 1e-9);
	assert.ok(atBound.sumDeviation <= PRIMARY_SUM_TOLERANCE);
	assert.equal(atBound.status, "decided");
	const over = classifyDecision({ payload: answer("yes", { yes: 0.9, no: 0.100002 }, 0.8), questionName: "decision", labels, threshold: 0.6 });
	assert.equal(over.status, "no_decision");
	assert.equal(over.reason, "unnormalized_probabilities");
	assert.equal(over.unnormalizedAtSensitivity, false);
	const far = classifyDecision({ payload: answer("yes", { yes: 0.9, no: 0.102 }, 0.8), questionName: "decision", labels, threshold: 0.6 });
	assert.equal(far.reason, "unnormalized_probabilities");
	assert.equal(far.unnormalizedAtSensitivity, true);
	assert.equal(classifyDecision({ payload: answer("maybe", { yes: 0.5, no: 0.5 }, 0.8), questionName: "decision", labels, threshold: 0.6 }).reason, "invalid_answer");
	assert.equal(classifyDecision({ payload: answer("yes", { yes: 0.5 }, 0.8), questionName: "decision", labels, threshold: 0.6 }).reason, "invalid_answer");
	assert.equal(classifyDecision({ payload: answer("yes", { yes: 1.2, no: -0.2 }, 0.8), questionName: "decision", labels, threshold: 0.6 }).reason, "invalid_answer");
	const margin = classifyDecision({ payload: answer("yes", { yes: 0.9, no: 0.1 }), questionName: "decision", labels, threshold: 0.6 });
	assert.equal(margin.confidenceKind, "margin");
	assert.ok(Math.abs(margin.confidence - 0.8) < 1e-12);
});

const voter = (status, choice = null, confidence = null, reason = null) => ({ status, choice, confidence, reason });

test("ensemble evaluation order: any unnormalized voter forces the whole ensemble to abstain", () => {
	const unnormalized = voter("no_decision", "off_track", null, "unnormalized_probabilities");
	const decided = voter("decided", "off_track", 0.95);
	assert.deepEqual(combineVoters({ primary: unnormalized, aux: decided }), { branch: "abstain", label: null, signal: null, reason: "unnormalized_probabilities" });
	assert.equal(combineVoters({ primary: decided, aux: unnormalized }).reason, "unnormalized_probabilities");
	assert.equal(combineVoters({ primary: decided, aux: voter("no_decision", null, null, "timeout") }).reason, "timeout");
	assert.deepEqual(combineVoters({ primary: decided, aux: voter("decided", "off_track", 0.7) }), { branch: "agree", label: "off_track", signal: 0.7, reason: null });
	assert.equal(combineVoters({ primary: voter("decided", "on_track", 0.8), aux: voter("decided", "off_track", 0.9) }).branch, "disagree");
	assert.equal(combineVoters({ primary: voter("decided", "on_track", 0.7), aux: voter("decided", "off_track", 0.9) }).reason, "disagreement");
	assert.equal(combineVoters({ primary: voter("decided", "on_track", 0.8), aux: voter("low_confidence", "off_track", 0.2) }).branch, "single");
	assert.equal(combineVoters({ primary: voter("low_confidence", "on_track", 0.3), aux: voter("decided", "off_track", 0.7) }).branch, "abstain");
	assert.equal(combineVoters({ primary: voter("low_confidence", "on_track", 0.3), aux: voter("low_confidence", "on_track", 0.2) }).branch, "abstain");
	assert.equal(combineVoters({ primary: voter("decided", "on_track", 0.8), aux: voter("decided", "off_track", 0.9), rule: "agreement_only" }).branch, "abstain");
	assert.equal(combineVoters({ primary: voter("decided", "on_track", 0.8), aux: unnormalized, rule: "single_primary" }).branch, "single");
	assert.equal(combineVotersVoterLevel({ primary: voter("decided", "on_track", 0.8), aux: unnormalized }).branch, "single");
	assert.throws(() => combineVoters({ primary: decided, aux: decided, rule: "vote" }), /unknown_ensemble_rule/);
});

test("dispatcher refuses a route outside the surface with zero transport and zero ledger rows", async () => {
	let fetchCalls = 0;
	const fetchImpl = async () => { fetchCalls += 1; throw new Error("must_not_fetch"); };
	const ledger = createLedger({});
	const rows = [];
	const trial = createDecisionDispatcher({ surface: "trial", keys: { opengateway: "fixture-key" }, fetchImpl, ledger, onRow: (row) => rows.push(row) });
	for (const model of ["typesafe/jev-1.14", "openai/gpt-5-mini", "sionic-ai/jev-omni ", ""]) {
		const row = await trial.decide({ cellId: "c1", model, family: "goal_state", wordingId: "W2", state: STATE, threshold: 0.6 });
		assert.equal(row.reason, "route_not_allowed");
		assert.equal(row.transport, false);
	}
	assert.equal(fetchCalls, 0);
	assert.equal(trial.transportCalls, 0);
	assert.equal(ledger.snapshot().reservedUsd, 0);
	assert.equal(ledger.snapshot().spentUsd, 0);
});

test("J0 surface reaches jev-1.14 on the OpenRouter route (positive control) and trial never does", async () => {
	const seen = [];
	const fetchImpl = async (url, options) => {
		seen.push({ url, auth: options.headers.authorization, body: JSON.parse(options.body) });
		return new Response(JSON.stringify(answer("correct", { correct: 0.8, incorrect: 0.15, unsure: 0.05 }, 0.65, "check")), { status: 200 });
	};
	const ledger = createLedger({});
	const j0 = createDecisionDispatcher({ surface: "j0", keys: { opengateway: "og-fixture", openrouter: "or-fixture" }, fetchImpl, ledger });
	const row = await j0.decide({ cellId: "j0", model: "typesafe/jev-1.14", family: "destructive", wordingId: "RULES", state: STATE, threshold: 0.6 });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].url, "https://openrouter.ai/api/alpha/decisions");
	assert.equal(seen[0].auth, "Bearer or-fixture");
	assert.equal(seen[0].body.model, "typesafe/jev-1.14");
	assert.equal(row.status, "decided");
	assert.equal(row.choice, "correct");
	assert.equal(row.basis, "computed_tokens");
	const omni = await j0.decide({ cellId: "j0", model: "sionic-ai/jev-omni", family: "destructive", wordingId: "RULES", state: STATE, threshold: 0.6 });
	assert.equal(seen[1].url, "https://apis.opengateway.ai/v1/decisions");
	assert.equal(seen[1].auth, "Bearer og-fixture");
	assert.equal(omni.status, "decided");
});

test("dispatcher accounts unnormalized and failed responses (never zero) and refuses at the hard stop", async () => {
	const ledger = createLedger({ hardStopUsd: 4.0 });
	const scripted = async ({ model }) => (model === "sionic-ai/jev-omni"
		? { status: 200, json: answer("off_track", { on_track: 0.3, off_track: 0.702 }, 0.4) }
		: { status: 500, json: null });
	const dispatcher = createDecisionDispatcher({ surface: "trial", ledger, scripted });
	const unnormalized = await dispatcher.decide({ cellId: "c1", model: "sionic-ai/jev-omni", family: "goal_state", wordingId: "W2", state: STATE, threshold: 0.6 });
	assert.equal(unnormalized.reason, "unnormalized_probabilities");
	assert.ok(unnormalized.costUsd > 0);
	const failed = await dispatcher.decide({ cellId: "c1", model: "sionic-ai/decider-4b", family: "goal_state", wordingId: "W2", state: STATE, threshold: 0.6 });
	assert.equal(failed.reason, "http_server");
	assert.equal(failed.basis, "computed_bound");
	assert.ok(failed.costUsd > 0);
	const tight = createLedger({ hardStopUsd: 0.0001 });
	const stopped = createDecisionDispatcher({ surface: "trial", ledger: tight, scripted });
	const refused = await stopped.decide({ cellId: "c1", model: "sionic-ai/jev-omni", family: "goal_state", wordingId: "W2", state: STATE, threshold: 0.6 });
	assert.equal(refused.reason, "budget_stop");
	assert.equal(stopped.transportCalls, 0);
	assert.ok(tight.stopped);
	assert.throws(() => createDecisionDispatcher({ surface: "trial", ledger, scripted, keys: { opengateway: "x" } }), /scripted_credentials_forbidden/);
});
