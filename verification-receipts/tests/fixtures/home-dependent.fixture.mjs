import test from 'node:test';
import assert from 'node:assert/strict';

// The HOME-dependent shape that recorded a permanent native_failure before the caller-declared
// HOME contract (JJO-1122): a suite that reads a user-scope path. Run it through verification_run
// without forwardHome to see the withheld default, and with forwardHome: true to see it pass.
test('the test process can read a user-scope path', () => {
  const home = process.env.HOME;
  assert.equal(typeof home, 'string');
  assert.ok(home.length > 0);
  assert.ok(home.startsWith('/'));
});
