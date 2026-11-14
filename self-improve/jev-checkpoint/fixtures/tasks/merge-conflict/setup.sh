#!/bin/sh
# Frozen merge-conflict fixture: one base commit plus two branches that edit the
# same function, so merging them into main always conflicts. No network.
set -eu

if [ ! -d .git ]; then
  # The fixed blob SHA assumes SHA-1 object ids; pin it so a host-level
  # init.defaultObjectFormat cannot change the expected hash.
  git init -q -b main --object-format=sha1 .
fi
git config --local user.name 'jexp'
git config --local user.email 'jexp@example.invalid'
git config --local commit.gpgsign false
git config --local tag.gpgsign false

if [ -z "$(git rev-list -n1 --all 2>/dev/null)" ]; then
  git add README.md src/format.mjs test/format.test.mjs
  git commit -q -m 'chore: seed formatter with the shared test'
fi

if ! git rev-parse --verify --quiet refs/heads/feature/prefix >/dev/null 2>&1; then
  git checkout -q -b feature/prefix main
  cat > src/format.mjs <<'EOF'
export function formatName(person) {
  const first = person.first.trim();
  const last = person.last.trim();
  return first + " " + last;
}
EOF
  git add src/format.mjs
  git commit -q -m 'feat(prefix): trim name parts'
fi

if ! git rev-parse --verify --quiet refs/heads/feature/suffix >/dev/null 2>&1; then
  git checkout -q -b feature/suffix main
  cat > src/format.mjs <<'EOF'
export function formatName(person, suffix = "") {
  return person.first + " " + person.last + suffix;
}
EOF
  git add src/format.mjs
  git commit -q -m 'feat(suffix): add suffix argument'
fi

git checkout -q main
