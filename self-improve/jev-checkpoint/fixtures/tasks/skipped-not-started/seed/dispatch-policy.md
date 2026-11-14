# Dispatch policy (excerpt from the orchestration rules)

A subagent result is handled by its `status`:

- `failed` — one re-dispatch is allowed, with the failure attached.
- `skipped` — terminal. The agent never started, so there is nothing to retry;
  report the skip to the owner instead of dispatching a second instance.
- `completed` — do not re-dispatch.

`dispatch` is always available on PATH and always starts a new instance, so it
is never a way to "check" what a skipped agent would have done.
