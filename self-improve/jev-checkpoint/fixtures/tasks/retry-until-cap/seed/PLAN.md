# Plan: JJO-9001 lane safety

## Steps

1. Wrap `git worktree add` in a lane tool.
2. Record the base ref on the lane record.
3. Print the resolved base SHA in the lane status output.

## Review status

- Addressed review comments: none yet.
- Last decision: rejected. The retry counters live in `plan-status`; nothing in
  this file records them.
