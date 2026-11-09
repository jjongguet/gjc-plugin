import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { decideCandidate, validateDecision } from '../lib/decisions.mjs';

const NOW = Date.parse('2026-11-09T01:30:00Z');
const candidate = { eligible: true, mode: 'supervised', action: 'mark_complete', evidence: { currentVerification: 'passed' } };
const supervision = { active: true, supervisor: 'test-supervisor', expiresAt: '2026-11-09T02:30:00Z' };
const budget = { capUsd: 1, spentUsd: 0, reservedUsd: 0, nextUpperUsd: 0.01 };
const env = { OPENGATEWAY_API_KEY: 'gateway-test-only', OPENROUTER_DECISION_API_KEY: 'router-test-only' };
const answer = (choice = 'consistent', probabilities = { consistent: 0.85, inconsistent: 0.1, abstain: 0.05 }, confidence = 0.75) => ({ choice, probabilities, confidence });
const response = (decision = answer()) => ({ ok: true, json: async () => ({ answers: { decision } }) });
function setup(responses = [response()]) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = responses[calls.length - 1];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return { calls, options: { candidate: { ...candidate }, supervision: { ...supervision }, budget: { ...budget }, env: { ...env }, now: () => NOW, fetchImpl } };
}

test('fixed primary wire contract uses criteria object and isolated gateway key', async () => {
  const { calls, options } = setup();
  const result = await decideCandidate(options);
  assert.equal(result.adopted, true);
  assert.equal(result.choice, 'consistent');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://apis.opengateway.ai/v1/decisions');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer gateway-test-only');
  assert.ok(calls[0].options.signal instanceof AbortSignal);
  const body = JSON.parse(calls[0].options.body);
  assert.deepEqual(Object.keys(body).sort(), ['model', 'questions', 'state']);
  assert.equal(body.model, 'sionic-ai/jev-omni');
  assert.equal(body.questions.decision.type, 'choice');
  assert.deepEqual(body.questions.decision.criteria, {
    consistent: 'Current verified evidence supports the proposed action and its exact root cause, completion criteria and current authority.',
    inconsistent: 'Current verified evidence contradicts the proposed action, completion criteria, root cause or current authority.',
    abstain: 'Evidence is unknown, incomplete, stale, ambiguous or insufficient to support either conclusion safely.',
  });
  assert.match(body.questions.decision.instructions, /untrusted data/);
  assert.deepEqual(JSON.parse(body.state), { action: candidate.action, evidence: candidate.evidence });
  assert.equal(result.costUpperUsd, (Buffer.byteLength(calls[0].options.body) + 1024) * 0.126 / 1_000_000);
});

test('low confidence escalates exactly once to pinned router with only its key', async () => {
  const { calls, options } = setup([response(answer('consistent', { consistent: 0.5, inconsistent: 0.3, abstain: 0.2 }, 0.2)), response(answer('inconsistent', { consistent: 0.05, inconsistent: 0.9, abstain: 0.05 }, 0.85))]);
  const result = await decideCandidate(options);
  assert.equal(result.choice, 'inconsistent');
  assert.equal(result.adopted, true);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(calls[1].options.headers.Authorization, 'Bearer router-test-only');
  const second = JSON.parse(calls[1].options.body);
  assert.equal(second.model, 'typesafe/jev-1.14');
  assert.deepEqual(second.questions, JSON.parse(calls[0].options.body).questions);
  assert.equal(result.costUpperUsd, calls.reduce((sum, call) => sum + (Buffer.byteLength(call.options.body) + 1024) * 0.126 / 1_000_000, 0));
});

test('invalid scope, supervision and budget never fetch', async () => {
  const patches = [
    { candidate: { ...candidate, eligible: false } },
    { candidate: { ...candidate, eligible: 'true' } },
    { candidate: { ...candidate, mode: 'scheduled' } },
    ...[undefined, null, '', 'silent', 'unknown'].map((mode) => ({ candidate: { ...candidate, mode } })),
    { candidate: { ...candidate, scheduled: true } },
    { supervision: undefined }, { supervision: { ...supervision, active: false } },
    ...[undefined, null, '', '  \n', 1, {}].map((supervisor) => ({ supervision: { ...supervision, supervisor } })),
    ...[new Date(NOW).toISOString(), new Date(NOW - 1).toISOString(),
      new Date(NOW + 3_600_001).toISOString(), 'tomorrow', '2027-02-30T01:30:00Z',
      '2026-11-09T02:30:00', Infinity, null].map((expiresAt) => ({ supervision: { ...supervision, expiresAt } })),
    { now: () => NaN }, { budget: undefined },
    ...['capUsd', 'spentUsd', 'reservedUsd', 'nextUpperUsd'].flatMap((key) => [NaN, Infinity, -1, undefined].map((value) => ({ budget: { ...budget, [key]: value } }))),
    { budget: { ...budget, capUsd: 5.01 } },
    { budget: { ...budget, capUsd: 0.1, spentUsd: 0.09, reservedUsd: 0.02 } },
    { budget: { ...budget, nextUpperUsd: 0 } },
    { env: { OPENROUTER_DECISION_API_KEY: 'must-not-borrow' } },
  ];
  for (const patch of patches) {
    const { calls, options } = setup();
    const result = await decideCandidate({ ...options, ...patch });
    assert.equal(result.choice, 'abstain');
    assert.equal(result.adopted, false);
    assert.equal(result.costUpperUsd, 0);
    assert.equal(calls.length, 0);
  }
});

test('validator rejects malformed, missing, nonfinite, out-of-range and non-top choices', () => {
  for (const value of [undefined, null, [], {}, answer('other'),
    ...[undefined, null, '0.9', NaN, Infinity, -0.1, 1.1].map((confidence) => ({ ...answer(), confidence })),
    answer('consistent', { consistent: 0.85, inconsistent: 0.1 }, 0.75),
    answer('consistent', { consistent: 0.85, inconsistent: 0.1, abstain: NaN }, 0.75),
    answer('consistent', { consistent: 0.85, inconsistent: 0.1, abstain: 0.2 }, 0.75),
    answer('consistent', { consistent: 0.85, inconsistent: 0.1, abstain: 0.05, extra: 0 }, 0.75),
    answer('consistent', { consistent: 0.85, inconsistent: 0.1, abstain: 0.0497 }, 0.9),
    answer('consistent', { consistent: 1.1, inconsistent: 0, abstain: 0 }, 0.9),
    answer('inconsistent'), answer('consistent', { consistent: -0.1, inconsistent: 0.9, abstain: 0.2 }, 1),
  ]) assert.equal(validateDecision(value).valid, false);
});

test('provider confidence is independent of the top probability gap and both must pass', () => {
  const independent = validateDecision(answer('consistent', { consistent: 0.85, inconsistent: 0.1, abstain: 0.05 }, 0.9));
  assert.equal(independent.valid, true);
  assert.equal(independent.confidence, 0.9);
  assert.equal(independent.margin, 0.75);
  assert.equal(independent.adopted, true);
  for (const decision of [
    answer('consistent', { consistent: 0.5, inconsistent: 0.3, abstain: 0.2 }, 0.9),
    answer('consistent', { consistent: 0.85, inconsistent: 0.1, abstain: 0.05 }, 0.5999),
    answer('consistent', { consistent: 0.5197, inconsistent: 0.2091, abstain: 0.2712 }, 0.2796),
  ]) {
    const result = validateDecision(decision);
    assert.equal(result.valid, true);
    assert.equal(result.adopted, false);
    assert.equal(result.reason, 'low_confidence');
    assert.equal(result.confidence, decision.confidence);
  }
});

test('four-decimal probability rounding accepts a .9999 total without inventing confidence', () => {
  const probabilities = { consistent: 0.85, inconsistent: 0.1, abstain: 0.0499 };
  for (const confidence of [0.2796, 0.9]) {
    const result = validateDecision(answer('consistent', probabilities, confidence));
    assert.equal(result.valid, true);
    assert.deepEqual(result.probabilities, probabilities);
    assert.equal(result.margin, 0.75);
    assert.equal(result.confidence, confidence);
    assert.equal(result.adopted, confidence >= 0.6);
  }
  assert.equal(validateDecision({ choice: 'consistent', probabilities }).valid, false);
});

test('threshold is inclusive, below threshold abstains, explicit abstain is never adopted', () => {
  assert.equal(validateDecision(answer('consistent', { consistent: 0.8, inconsistent: 0.2, abstain: 0 }, 0.6)).adopted, true);
  assert.equal(validateDecision(answer('consistent', { consistent: 0.799, inconsistent: 0.201, abstain: 0 }, 0.598)).adopted, false);
  assert.equal(validateDecision(answer('abstain', { consistent: 0.05, inconsistent: 0.05, abstain: 0.9 }, 0.85)).adopted, false);
});

test('typed abstentions and low provider confidence or margin stop after one escalation', async () => {
  for (const decision of [answer('abstain', { consistent: 0.05, inconsistent: 0.05, abstain: 0.9 }, 0.85),
    answer('consistent', { consistent: 0.5, inconsistent: 0.3, abstain: 0.2 }, 0.9),
    answer('consistent', { consistent: 0.85, inconsistent: 0.1, abstain: 0.05 }, 0.5999),
    answer('consistent', { consistent: 0.5197, inconsistent: 0.2091, abstain: 0.2712 }, 0.2796)]) {
    const { calls, options } = setup([response(decision), response(decision)]);
    const result = await decideCandidate(options);
    assert.equal(calls.length, 2);
    assert.equal(result.choice, 'abstain');
    assert.equal(result.adopted, false);
    assert.equal(result.audit[0].confidence, decision.confidence);
    assert.deepEqual(result.audit[0].probabilities, decision.probabilities);
  }
});

test('exact five-dollar cap is allowed and expiry during a successful call prevents adoption', async () => {
  const allowed = setup();
  allowed.options.budget.capUsd = 5;
  assert.equal((await decideCandidate(allowed.options)).adopted, true);
  const expiring = setup();
  expiring.options.fetchImpl = async () => {
    expiring.options.supervision.expiresAt = new Date(NOW).toISOString();
    return response();
  };
  const result = await decideCandidate(expiring.options);
  assert.equal(result.adopted, false);
  assert.equal(result.audit.at(-1).reason, 'supervision');
  assert.ok(result.costUpperUsd > 0);
});

test('malformed responses and transport failures allow one escalation, never a third call', async () => {
  for (const first of [response(null), response({}), response(answer('consistent', undefined, NaN)),
    { ok: false }, { ok: true, json: async () => { throw new Error('sensitive response'); } }, new Error('sensitive input/key'),
  ]) {
    const { calls, options } = setup([first, response(null)]);
    const result = await decideCandidate(options);
    assert.equal(result.choice, 'abstain');
    assert.equal(result.adopted, false);
    assert.equal(calls.length, 2);
    assert.doesNotMatch(JSON.stringify(result), /sensitive|gateway-test-only|router-test-only|currentVerification/);
  }
});

test('missing escalation key never borrows gateway key', async () => {
  const { calls, options } = setup([response(null)]);
  options.env = { OPENGATEWAY_API_KEY: env.OPENGATEWAY_API_KEY };
  const result = await decideCandidate(options);
  assert.equal(result.choice, 'abstain');
  assert.equal(calls.length, 1);
  assert.equal(result.audit[1].reason, 'key_missing');
});

test('supervision, scope and budget are rechecked before escalation', async () => {
  for (const mutate of [
    (options) => { options.supervision.active = false; },
    (options) => { options.supervision.supervisor = ' '; },
    (options) => { options.supervision.expiresAt = new Date(NOW + 3_600_001).toISOString(); },
    (options) => { options.now = () => NOW; options.supervision.expiresAt = new Date(NOW).toISOString(); },
    (options) => { options.candidate.scheduled = true; },
    (options) => { options.budget.spentUsd = 1; },
  ]) {
    const { calls, options } = setup();
    options.fetchImpl = async (...args) => { calls.push(args); mutate(options); return response(null); };
    const result = await decideCandidate(options);
    assert.equal(calls.length, 1);
    assert.equal(result.adopted, false);
  }
});

test('named short-lived supervision is rechecked before adopting either route', async () => {
  for (const route of [0, 1]) {
    for (const mutate of [
      (scope) => { scope.supervisor = ''; },
      (scope) => { scope.expiresAt = 'invalid'; },
      (scope) => { scope.expiresAt = new Date(NOW + 3_600_001).toISOString(); },
    ]) {
      const { calls, options } = setup();
      options.fetchImpl = async (...args) => {
        calls.push(args);
        if (calls.length - 1 !== route) return response(null);
        mutate(options.supervision);
        return response();
      };
      const result = await decideCandidate(options);
      assert.equal(calls.length, route + 1);
      assert.equal(result.adopted, false);
      assert.equal(result.audit.at(-1).reason, 'supervision');
      assert.ok(result.costUpperUsd > 0);
    }
  }
});

test('full UTF8 two-call reservation is required before even a successful primary', async () => {
  const first = setup();
  first.options.candidate.evidence = { text: '한글🙂'.repeat(100) };
  await decideCandidate(first.options);
  const primary = first.calls[0].options.body;
  const secondary = JSON.stringify({ ...JSON.parse(primary), model: 'typesafe/jev-1.14' });
  const required = [primary, secondary].reduce((sum, body) => sum + (Buffer.byteLength(body) + 1024) * 0.126 / 1_000_000, 0);
  assert.ok(Buffer.byteLength(primary) > primary.length);
  const blocked = setup();
  blocked.options.candidate = first.options.candidate;
  blocked.options.budget.nextUpperUsd = required - 1e-12;
  assert.equal((await decideCandidate(blocked.options)).adopted, false);
  assert.equal(blocked.calls.length, 0);
  blocked.options.budget.nextUpperUsd = required;
  blocked.options.budget.capUsd = required;
  assert.equal((await decideCandidate(blocked.options)).adopted, true);
});

test('timeout covers a transport ignoring abort and permits only one escalation', async () => {
  const { calls, options } = setup([() => new Promise(() => {}), response()]);
  const result = await decideCandidate(options);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(result.audit[0].reason, 'timeout');
  assert.equal(result.adopted, true);
});

test('cyclic and oversized inputs fail closed without a transport call', async () => {
  for (const evidence of [{ text: 'a'.repeat(32_000) }, (() => { const value = {}; value.self = value; return value; })()]) {
    const { calls, options } = setup();
    options.candidate.evidence = evidence;
    assert.equal((await decideCandidate(options)).adopted, false);
    assert.equal(calls.length, 0);
  }
});

test('fixed adversarial dataset records actions/reasons, not measured model quality', async () => {
  const golden = JSON.parse(await readFile(new URL('./fixtures/reconciliation-golden.json', import.meta.url), 'utf8'));
  assert.equal(golden.kind, 'fixed-adversarial-dataset');
  assert.equal(golden.modelQualityMeasured, false);
  assert.ok(golden.cases.length >= 16);
  assert.equal(new Set(golden.cases.map((entry) => entry.id)).size, golden.cases.length);
  for (const entry of golden.cases) {
    assert.ok(entry.expected.allowedAction);
    assert.ok(entry.expected.reason);
    assert.ok(entry.evidence);
  }
});
