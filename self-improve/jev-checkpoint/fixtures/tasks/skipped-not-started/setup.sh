#!/bin/sh
# Frozen skipped-not-started fixture: the workspace only records the skipped
# Architect result and the dispatch policy. Nothing here needs a remote.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add README.md architect-result.json dispatch-policy.md
  git commit -q -m 'chore: record architect result'
fi
