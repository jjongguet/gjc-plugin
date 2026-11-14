#!/bin/sh
# Frozen review-rounds fixture: a plain repo holding the module under review.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add README.md src/parser.mjs test/parser.test.mjs
  git commit -q -m 'chore: seed the module under review'
fi
