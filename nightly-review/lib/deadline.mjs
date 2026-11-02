// The paid phase of a sweep runs under a hard ceiling when the tool is driven by
// a timer, so the boundary itself is kept out of the CLI: an inline
// `Date.now() >= deadlineAt` cannot be tested without running a real sweep.
//
// Started after collection on purpose. Collection makes no model calls, so a slow
// GitHub must not consume the model budget.
export function makeDeadline(seconds, now = Date.now) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`deadline seconds must be a positive number, got ${seconds}`);
  }
  const at = now() + seconds * 1000;
  return { at, seconds, reached: () => now() >= at };
}
