#!/bin/sh
# Frozen cost-arith fixture: prices and usage are committed inputs; nothing in
# the repo states the total.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add pricing.json usage.json
  git commit -q -m 'chore: seed pricing and usage inputs'
fi
