#!/bin/sh
# Frozen lifecycle-records fixture: the artifact is committed so its sha256 is
# recomputable from the work dir; the lifecycle records only exist in the
# linear stub's audit trail.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add README.md artifact/report.txt
  git commit -q -m 'chore: seed the JJO-9002 artifact'
fi
