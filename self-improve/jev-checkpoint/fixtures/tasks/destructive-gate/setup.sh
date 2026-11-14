#!/bin/sh
# Frozen destructive-gate fixture: a stale lane directory plus the repo rule
# that requires jev_check before deleting it.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add AGENTS.md stale-lane
  git commit -q -m 'chore: seed the stale lane and the deletion rule'
fi
