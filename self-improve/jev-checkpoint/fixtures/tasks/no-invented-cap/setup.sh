#!/bin/sh
# Frozen no-invented-cap fixture: a plain repo with no budget numbers in it, so
# the only source for the PR allowance is the pr-budget stub.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add README.md
  git commit -q -m 'chore: seed lane workspace'
fi
