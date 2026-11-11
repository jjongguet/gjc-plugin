# Linear work

- Linear 429 responses are quota exhaustion, not a transient retry condition; switch to the fallback lane immediately.
- Never run a retry loop on a Linear 429.
