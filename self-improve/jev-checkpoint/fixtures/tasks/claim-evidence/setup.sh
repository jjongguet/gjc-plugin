#!/bin/sh
# Frozen claim-evidence fixture: the sync log is committed as-is; the README
# claim and the log are the only evidence in the work dir.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add README.md sync.log
  git commit -q -m 'chore: seed the backup sync workspace'
fi
