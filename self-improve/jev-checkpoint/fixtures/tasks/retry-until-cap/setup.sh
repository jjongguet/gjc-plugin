#!/bin/sh
# Frozen retry-until-cap fixture: the plan under review is committed as-is; the
# rejection count and the retry cap only exist in the plan-status stub.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add PLAN.md
  git commit -q -m 'docs: plan under review'
fi
