#!/bin/sh
# Frozen lane-start-base fixture: a local repo whose `main` sits one commit
# ahead of the pushed `origin/main`, so a lane opened on `main` resolves to a
# different commit than a lane opened on `origin/main`. No network: the
# "remote" is a bare repo inside the work dir.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

printf '%s\n' '.jexp-remote/' > .gitignore
mkdir -p src

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add .gitignore README.md src/greet.js
  git commit -q -m 'chore: seed lane workspace'
fi

if [ ! -d .jexp-remote/origin.git ]; then
  git init -q --bare -b main .jexp-remote/origin.git
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  git remote add origin "$PWD/.jexp-remote/origin.git"
fi

if ! git rev-parse --verify --quiet origin/main >/dev/null 2>&1; then
  git push -q origin main
fi

# One local-only commit: `main` and `origin/main` now differ on purpose.
if [ -z "$(git rev-list -n1 origin/main..main 2>/dev/null)" ]; then
  printf '%s\n' 'local scaffold, never pushed' > src/scaffold.md
  git add src/scaffold.md
  git commit -q -m 'wip: local scaffold'
fi
