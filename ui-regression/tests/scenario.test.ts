import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { normalizeUiText, uiScenarioDigest, uiTextMatches, validateScenario } from '../lib/scenario';

function scenarioFixture() {
  return {
    id: 'fixture-1',
    expectedBehavior: 'The local demo shows the chosen synthetic label.',
    steps: [
      { action: 'goto', url: 'http://localhost:4317/demo' },
      { action: 'assert', selector: '#result', kind: 'text', match: 'exact', expected: 'Demo result' },
    ],
  };
}

function scenarioWithSteps(steps: unknown[]) {
  return { ...scenarioFixture(), steps };
}

const scenarioVisible = { action: 'assert', selector: '#result', kind: 'visible' };

describe('UI scenario closed DSL', () => {
  test('accepts local synthetic steps and literal punctuation without interpretation', () => {
    const input = scenarioWithSteps([
      { action: 'goto', url: 'http://localhost:4317/demo' },
      { action: 'fill', selector: '[data-label="demo"]', value: 'Demo ` ${1 + 1} "quote"; (literal)' },
      { action: 'click', selector: 'button[data-action="show"]' },
      { action: 'goto', url: 'http://localhost:4317/result' },
      { action: 'assert', selector: '#result', kind: 'text', match: 'substring', expected: '${1 + 1}' },
      scenarioVisible,
    ]);
    expect(validateScenario(input)).toEqual(input);
  });

  test.each(['http://127.0.0.1:4317/demo', 'https://[::1]:4317/demo'])('accepts explicit local URL %s', url => {
    expect(validateScenario(scenarioWithSteps([{ action: 'goto', url }, scenarioVisible])).steps).toHaveLength(2);
  });

  test.each([
    'javascript:alert(1)', 'data:text/html,hello', 'file:///tmp/demo', 'https://example.com/demo',
    'http://127.1/demo', 'http://2130706433/demo', 'http://localhost.evil/demo',
    'http://user:demo@localhost/demo', 'http://localhost/demo?label=demo', 'http://localhost/demo#part',
    'http://localhost/account', 'http://localhost/payment', 'http://localhost/%6cogin',
    'http://localhost/credentials', 'http://localhost/upload',
  ])('rejects unsafe URL %s', url => {
    expect(() => validateScenario(scenarioWithSteps([{ action: 'goto', url }, scenarioVisible]))).toThrow('UI_SCENARIO_');
  });

  test.each(['http://127.0.0.1:4317/demo', 'http://localhost:4318/demo', 'https://localhost:4317/demo'])('rejects origin drift %s', url => {
    expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], { action: 'goto', url }, scenarioVisible]))).toThrow('UI_SCENARIO_ORIGIN');
  });

  test('requires first navigation and an assertion', () => {
    expect(() => validateScenario(scenarioWithSteps([scenarioVisible]))).toThrow('UI_SCENARIO_FIRST_GOTO');
    expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0]]))).toThrow('UI_SCENARIO_NO_ASSERTION');
    const sparse = new Array(2);
    sparse[1] = scenarioVisible;
    expect(() => validateScenario(scenarioWithSteps(sparse))).toThrow('UI_SCENARIO_STEPS');
  });

  test('rejects observations, code, predicates, prose and all extra fields', () => {
    for (const field of ['result', 'passed', 'observations', 'code', 'task']) {
      expect(() => validateScenario({ ...scenarioFixture(), [field]: true })).toThrow('UI_SCENARIO_FIELDS');
    }
    for (const extra of [{ result: true }, { predicate: '() => true' }, { expected: 'visible' }]) {
      expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], { ...scenarioVisible, ...extra }]))).toThrow('UI_SCENARIO_FIELDS');
    }
    expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], { action: 'script', code: 'return true' }]))).toThrow('UI_SCENARIO_ACTION');
    expect(() => validateScenario('Open the demo and report success')).toThrow('UI_SCENARIO_OBJECT');
  });

  test('rejects getters without executing them', () => {
    let invoked = false;
    const input = { ...scenarioFixture(), get id() { invoked = true; return 'demo'; } };
    expect(() => validateScenario(input)).toThrow('UI_SCENARIO_FIELDS');
    expect(invoked).toBe(false);
  });

  test('enforces bounds at both sides', () => {
    expect(() => validateScenario({ ...scenarioFixture(), id: 'x'.repeat(65) })).toThrow('UI_SCENARIO_ID');
    expect(() => validateScenario({ ...scenarioFixture(), id: 'not a token' })).toThrow('UI_SCENARIO_ID');
    expect(() => validateScenario({ ...scenarioFixture(), expectedBehavior: 'x'.repeat(2001) })).toThrow('UI_SCENARIO_EXPECTED_BEHAVIOR');
    expect(() => validateScenario(scenarioWithSteps([]))).toThrow('UI_SCENARIO_STEPS');
    expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], ...Array(20).fill(scenarioVisible)]))).toThrow('UI_SCENARIO_STEPS');
    for (const selector of ['', ' ', 'x'.repeat(257)]) {
      expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], { ...scenarioVisible, selector }]))).toThrow('UI_SCENARIO_SELECTOR');
    }
    expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], { action: 'fill', selector: '#demo', value: 'x'.repeat(1001) }, scenarioVisible]))).toThrow('UI_SCENARIO_VALUE');
    expect(validateScenario({ ...scenarioFixture(), id: 'x'.repeat(64), expectedBehavior: 'x'.repeat(2000), steps: [scenarioFixture().steps[0], { action: 'fill', selector: 'x'.repeat(256), value: 'x'.repeat(1000) }, ...Array(18).fill(scenarioVisible)] }).steps).toHaveLength(20);
  });

  test.each(['javascript:alert(1)', '${run()}', 'expression(alert(1))', '[data-ref="e1"]', '@e1', 'e12', 'input[type="password"]', 'button[type="submit"]'])('rejects executable, stale or sensitive selector %s', selector => {
    expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], { ...scenarioVisible, selector }]))).toThrow('UI_SCENARIO_');
  });

  test.each(['demo@example.com', 'password: demo', 'account=real-user', 'Bearer demo', 'sk_live_abc123', 'ghp_12345678901234567890', '4111 1111 1111 1111', 'demo\u0000label'])('rejects detected sensitive fill %s', value => {
    expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], { action: 'fill', selector: '#demo', value }, scenarioVisible]))).toThrow('UI_SCENARIO_SENSITIVE');
  });

  test('rejects invalid assertion variants', () => {
    expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], { ...scenarioVisible, kind: 'predicate' }]))).toThrow('UI_SCENARIO_ASSERT_KIND');
    expect(() => validateScenario(scenarioWithSteps([scenarioFixture().steps[0], { action: 'assert', selector: '#result', kind: 'text', match: 'regex', expected: '.*' }]))).toThrow('UI_SCENARIO_MATCH');
  });
});

describe('literal UI text and fingerprint', () => {
  test('normalizes only line endings and surrounding whitespace', () => {
    expect(normalizeUiText(' \r\nDemo  label\rnext\r\n ')).toBe('Demo  label\nnext');
    expect(uiTextMatches(' \r\nDemo  label\rnext ', 'Demo  label\nnext', 'exact')).toBe(true);
    expect(uiTextMatches('Demo  label', 'Demo label', 'exact')).toBe(false);
    expect(uiTextMatches('Demo label', 'demo label', 'exact')).toBe(false);
    expect(uiTextMatches('Prefix Demo  label suffix', ' Demo  label ', 'substring')).toBe(true);
    expect(uiTextMatches('Prefix Demo  label suffix', 'Demo label', 'substring')).toBe(false);
    expect(uiTextMatches('literal .* suffix', '.*', 'substring')).toBe(true);
    expect(uiTextMatches('anything', '.*', 'substring')).toBe(false);
  });

  test('SHA256 hashes the validated JSON and changes with behavior', () => {
    const scenario = validateScenario(scenarioFixture());
    const digest = uiScenarioDigest(scenario);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).toBe(createHash('sha256').update(JSON.stringify(scenario)).digest('hex'));
    expect(uiScenarioDigest(validateScenario(scenarioFixture()))).toBe(digest);
    expect(uiScenarioDigest({ ...scenario, expectedBehavior: 'A different demo label is shown.' })).not.toBe(digest);
  });
});
