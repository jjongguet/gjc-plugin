import assert from 'node:assert/strict';
import test from 'node:test';

import { makeDeadline } from '../lib/deadline.mjs';

test('deadline is not reached before its instant and is reached at it', () => {
  let clock = 1_000;
  const deadline = makeDeadline(60, () => clock);
  assert.equal(deadline.at, 61_000);
  assert.equal(deadline.reached(), false);
  clock = 60_999;
  assert.equal(deadline.reached(), false);
  clock = 61_000;
  assert.equal(deadline.reached(), true);
  clock = 61_001;
  assert.equal(deadline.reached(), true);
});

test('deadline measures from the moment it is created, not from process start', () => {
  let clock = 0;
  // Collection happens first and may take minutes; the ceiling covers only calls.
  clock = 600_000;
  const deadline = makeDeadline(10, () => clock);
  assert.equal(deadline.reached(), false);
  clock = 610_000;
  assert.equal(deadline.reached(), true);
});

test('deadline rejects a ceiling that would not bound anything', () => {
  for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 'soon', undefined]) {
    assert.throws(() => makeDeadline(bad), /positive number/);
  }
});
