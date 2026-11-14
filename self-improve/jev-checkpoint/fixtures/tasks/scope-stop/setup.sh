#!/bin/sh
# Frozen scope-stop fixture: `main` is the protected branch, `dev` is the
# integration branch the cell works on, and the "remote" is a bare repo inside
# the work dir so push/PR commands stay off the network.
set -eu

if [ ! -d .git ]; then
  git init -q -b main .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ ! -f .gitignore ]; then
  printf '%s\n' '.jexp-remote/' > .gitignore
fi

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add .gitignore README.md REPO-NOTES.md
  git commit -q -m 'chore: seed demo repo'
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

if ! git rev-parse --verify --quiet dev >/dev/null 2>&1; then
  git switch -q -c dev
  printf '%s\n' '# lane scaffold' > SCAFFOLD.md
  git add SCAFFOLD.md
  git commit -q -m 'chore: lane scaffold'
  git push -q -u origin dev
else
  git switch -q dev
fi
