import assert from 'node:assert/strict';
import test from 'node:test';

import { truncateDiff } from '../lib/collect.mjs';
import {
  createStreamFilter,
  lastAssistantText,
  parseJsonFindings,
  readTelemetry,
} from '../lib/runner.mjs';

test('parseJsonFindings reads a bare JSON object', () => {
  const result = parseJsonFindings('{"findings":[{"file":"a.py","line":3,"quote":"x = 1"}]}');
  assert.equal(result.error, undefined);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].file, 'a.py');
});

test('parseJsonFindings reads a fenced JSON block with prose around it', () => {
  const text = 'Here is my review.\n```json\n{"findings":[{"file":"b.py","line":9,"quote":"y = 2"}]}\n```\nDone.';
  const result = parseJsonFindings(text);
  assert.equal(result.findings.length, 1);
});

test('parseJsonFindings reports an empty findings array as a valid answer', () => {
  const result = parseJsonFindings('{"findings":[]}');
  assert.deepEqual(result.findings, []);
  assert.equal(result.error, undefined);
});

test('parseJsonFindings refuses prose that contains no findings array', () => {
  const result = parseJsonFindings('I found nothing to report.');
  assert.equal(result.findings.length, 0);
  assert.equal(result.error, 'unparseable_response');
});

test('parseJsonFindings refuses an object without findings', () => {
  const result = parseJsonFindings('{"summary":"looks fine"}');
  assert.equal(result.error, 'no_findings_array');
});

test('lastAssistantText takes the final assistant text from the event stream', () => {
  const stream = [
    '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"prompt"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"thinking","thinking":"hmm"}]}}',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"findings\\":[]}"}]}}',
  ].join('\n');
  assert.equal(lastAssistantText(stream), '{"findings":[]}');
});

test('readTelemetry returns usage from agent_end', () => {
  const stream = `${JSON.stringify({
    type: 'agent_end',
    telemetry: { usage: { inputTokens: 11, outputTokens: 2 } },
  })}\n`;
  assert.deepEqual(readTelemetry(stream).usage, { inputTokens: 11, outputTokens: 2 });
});

test('readTelemetry returns null when the call never completed', () => {
  assert.equal(readTelemetry('{"type":"message_end"}'), null);
});

test('createStreamFilter keeps only the answer and the usage receipt', () => {
  const events = [];
  const filter = createStreamFilter({ onEvent: (event) => events.push(event) });
  filter.push(
    [
      '{"type":"message_update","message":{"role":"custom","content":"x"}}',
      '{"type":"message_start"}',
      '{"type":"message_end","message":{"role":"user","content":[{"type":"text","text":"prompt"}]}}',
      '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"{\\"findings\\":[]}"}]}}',
      '{"type":"agent_end","telemetry":{"usage":{"inputTokens":5}}}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ['message_end', 'message_end', 'agent_end'],
  );
});

test('createStreamFilter reassembles a line split across chunks', () => {
  const events = [];
  const filter = createStreamFilter({ onEvent: (event) => events.push(event) });
  const line = '{"type":"agent_end","telemetry":{"usage":{"inputTokens":5}}}';
  filter.push(line.slice(0, 20));
  filter.push(line.slice(20));
  filter.push('\n');
  assert.equal(events.length, 1);
  assert.equal(events[0].telemetry.usage.inputTokens, 5);
});

test('createStreamFilter drops an unbounded partial line instead of buffering it', () => {
  const events = [];
  const filter = createStreamFilter({ onEvent: (event) => events.push(event) });
  filter.push('{"type":"message_update","pad":"');
  filter.push('a'.repeat(1_200_000));
  assert.equal(filter.dropped, 1);
  filter.push('"}\n{"type":"agent_end","telemetry":{}}\n');
  assert.equal(events.length, 1);
});

test('truncateDiff marks truncation so a half hunk is never read as complete', () => {
  const short = truncateDiff('a'.repeat(10), 100);
  assert.equal(short.truncated, false);
  const long = truncateDiff('a'.repeat(200), 100);
  assert.equal(long.truncated, true);
  assert.match(long.diff, /diff truncated at 100 bytes/);
  assert.ok(long.diff.length > 100);
});
