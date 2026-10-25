import { createHash as uiScenarioCreateHash } from 'node:crypto';

export type UiStep =
  | { action: 'goto'; url: string }
  | { action: 'click'; selector: string }
  | { action: 'fill'; selector: string; value: string }
  | { action: 'assert'; selector: string; kind: 'visible' }
  | { action: 'assert'; selector: string; kind: 'text'; match: 'exact' | 'substring'; expected: string };

export type UiScenario = { id: string; expectedBehavior: string; steps: UiStep[] };

function uiScenarioFail(code: string): never {
  throw new Error(`UI_SCENARIO_${code}`);
}

function uiScenarioObject(input: unknown, keys: string[]): Record<string, unknown> {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) uiScenarioFail('OBJECT');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) uiScenarioFail('OBJECT');
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(input).length !== keys.length || keys.some(key => !Object.hasOwn(descriptors, key))) uiScenarioFail('FIELDS');
  if (Object.values(descriptors).some(descriptor => !Object.hasOwn(descriptor, 'value'))) uiScenarioFail('FIELDS');
  return input as Record<string, unknown>;
}

function uiScenarioSensitive(value: string): boolean {
  return /[\x00-\x1f\x7f-\x9f]/.test(value)
    || /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(value)
    || /\b(?:password|passwd|credential|authorization|bearer|cookie|session[_-]?token|api[_-]?key|access[_-]?token|refresh[_-]?token|private[_-]?key)\b/i.test(value)
    || /\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+\b/.test(value)
    || /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/.test(value)
    || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)
    || /\b(?:\d[ -]?){13,19}\b/.test(value)
    || /\b(?:account|email|username)\s*[:=]\s*\S+/i.test(value);
}

function uiScenarioString(input: unknown, maximum: number, code: string, nonempty = true): string {
  if (typeof input !== 'string' || input.length > maximum || (nonempty && input.trim().length === 0)) uiScenarioFail(code);
  if (uiScenarioSensitive(input)) uiScenarioFail('SENSITIVE');
  return input;
}

function uiScenarioSelector(input: unknown): string {
  const selector = uiScenarioString(input, 256, 'SELECTOR');
  if (/javascript\s*:|expression\s*\(|(?:eval|Function|require|import)\s*\(|\$\{|=>|<\/?script\b/i.test(selector)
    || /(?:^|[\s\["'])(?:ref|snapshot[_-]?ref|backendNodeId)\s*[:=]|\b(?:aria-ref|data-(?:snapshot-)?ref)\b|^@|^\[?e\d+\]?$/i.test(selector)
    || /\b(?:password|file|hidden|submit|upload|payment|checkout|billing|account|login|logout|sign-in|sign-up|credential)\b/i.test(selector)) uiScenarioFail('SELECTOR_UNSAFE');
  return selector;
}

function uiScenarioUrl(input: unknown): URL {
  const raw = uiScenarioString(input, 2048, 'URL');
  let url: URL;
  try { url = new URL(raw); } catch { return uiScenarioFail('URL'); }
  if (!/^https?:\/\//i.test(raw) || !['http:', 'https:'].includes(url.protocol)) uiScenarioFail('URL_SCHEME');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) uiScenarioFail('URL_HOST');
  if (url.username || url.password || raw.includes('?') || raw.includes('#') || raw.includes('\\')) uiScenarioFail('URL_UNSAFE');
  let path: string;
  try { path = decodeURIComponent(url.pathname); } catch { return uiScenarioFail('URL'); }
  if (uiScenarioSensitive(path) || /(?:^|[^a-z0-9])(?:accounts?|payments?|checkout|billing|credentials?|login|logout|signin|signup|sign-in|sign-up|auth|oauth|admin|upload|submit)(?:$|[^a-z0-9])/i.test(path)) uiScenarioFail('URL_SENSITIVE');
  // URL parsing canonicalizes alternate numeric hosts; require an explicit loopback spelling.
  const authority = raw.match(/^https?:\/\/([^/]+)/i)?.[1];
  if (!authority || !/^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(authority)) uiScenarioFail('URL_HOST');
  return url;
}

export function validateScenario(input: unknown): UiScenario {
  const object = uiScenarioObject(input, ['id', 'expectedBehavior', 'steps']);
  const id = uiScenarioString(object.id, 64, 'ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) uiScenarioFail('ID');
  const expectedBehavior = uiScenarioString(object.expectedBehavior, 2000, 'EXPECTED_BEHAVIOR');
  if (!Array.isArray(object.steps) || object.steps.length < 1 || object.steps.length > 20) uiScenarioFail('STEPS');
  for (let index = 0; index < object.steps.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(object.steps, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) uiScenarioFail('STEPS');
  }
  let origin: string | undefined;
  let assertions = 0;
  const steps: UiStep[] = object.steps.map((inputStep: unknown, index: number): UiStep => {
    if (inputStep === null || typeof inputStep !== 'object' || Array.isArray(inputStep)) uiScenarioFail('STEP');
    const actionDescriptor = Object.getOwnPropertyDescriptor(inputStep, 'action');
    if (!actionDescriptor || !Object.hasOwn(actionDescriptor, 'value')) uiScenarioFail('FIELDS');
    const action = actionDescriptor.value;
    if (index === 0 && action !== 'goto') uiScenarioFail('FIRST_GOTO');
    if (action === 'goto') {
      const step = uiScenarioObject(inputStep, ['action', 'url']);
      const url = uiScenarioUrl(step.url);
      if (origin !== undefined && url.origin !== origin) uiScenarioFail('ORIGIN');
      origin = url.origin;
      return { action, url: step.url as string };
    }
    if (action === 'click' || action === 'fill') {
      const step = uiScenarioObject(inputStep, action === 'click' ? ['action', 'selector'] : ['action', 'selector', 'value']);
      const selector = uiScenarioSelector(step.selector);
      return action === 'click' ? { action, selector } : { action, selector, value: uiScenarioString(step.value, 1000, 'VALUE', false) };
    }
    if (action === 'assert') {
      const kindDescriptor = Object.getOwnPropertyDescriptor(inputStep, 'kind');
      if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value')) uiScenarioFail('FIELDS');
      const kind = kindDescriptor.value;
      if (kind !== 'visible' && kind !== 'text') uiScenarioFail('ASSERT_KIND');
      const step = uiScenarioObject(inputStep, kind === 'visible' ? ['action', 'selector', 'kind'] : ['action', 'selector', 'kind', 'match', 'expected']);
      const selector = uiScenarioSelector(step.selector);
      assertions++;
      if (kind === 'visible') return { action, selector, kind };
      if (step.match !== 'exact' && step.match !== 'substring') uiScenarioFail('MATCH');
      return { action, selector, kind, match: step.match, expected: uiScenarioString(step.expected, 2000, 'EXPECTED', false) };
    }
    return uiScenarioFail('ACTION');
  });
  if (assertions === 0) uiScenarioFail('NO_ASSERTION');
  return { id, expectedBehavior, steps };
}

export function normalizeUiText(value: string): string {
  return value.replace(/\r\n?/g, '\n').trim();
}

export function uiTextMatches(actual: string, expected: string, match: 'exact' | 'substring'): boolean {
  const normalizedActual = normalizeUiText(actual);
  const normalizedExpected = normalizeUiText(expected);
  return match === 'exact' ? normalizedActual === normalizedExpected : normalizedActual.includes(normalizedExpected);
}

export function uiScenarioDigest(scenario: UiScenario): string {
  return uiScenarioCreateHash('sha256').update(JSON.stringify(scenario)).digest('hex');
}
