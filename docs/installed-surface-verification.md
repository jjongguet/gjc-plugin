# Installed-surface verification

`scripts/verify-installed-surface.mjs` answers one question: **do the plugin files the installer wrote match a
given release tag, byte for byte?**

The denominator is the installed surface, not the repository tree. The installer copies a plugin's
`gajae-plugin.json` plus every file that manifest declares under `tools/` and `hooks/`. Source files such as
`lib/*.ts`, `scripts/*`, `tests/*` and `README.md` are never installed. Comparing `git ls-tree -r <tag> -- <plugin>`
against the install root therefore reports those source files as MISSING — on `v0.0.15` that method flags 104 of
134 files for the eight shipped plugins, which is a method error, not install drift.

## Running it

```
# today's installed tree (walks every pluginRoot in the installer registry;
# the registry and the install tree are read-only host state)
node scripts/verify-installed-surface.mjs \
  --repo . \
  --tag v0.0.15 \
  --registry ~/.gjc/agent/gjc-plugins/registry.json \
  [--json <out.json>]

# an archived surface record, run from inside a checkout
node scripts/verify-installed-surface.mjs \
  --repo . \
  --tag v0.0.15 \
  --recorded artifacts/jjo1093-installed-surface-20261111/recorded-20261028.input.json \
  [--json <out.json>]
```

A recorded surface's `files` entries may be installer `[rel, sha256]` pairs or this script's
`{path, sha256, ...}` objects (extra keys such as `status` are ignored). Any other shape is a usage error
(`exit 1`) with the offending plugin and index, not a hash mismatch.

Exit codes: `0` = every in-scope file matches the tag (recorded mode: every recorded hash matches);
`2` = the set is not exactly the tag; `1` = usage or environment error. `--json` output is home-relative so it can
be committed under `artifacts/` and pass `paths:check`.

The archived record reproduces from repository files alone: on 2026-11-11 the command above printed
`recorded v0.0.15: 30/30 match (0 mismatch)` and exited `0`. The installed-tree command printed
`2/35 match, 28 later-release, 0 snapshot-not-in-git, 0 drift, 5 not-in-tag, 0 missing; 1 out-of-repo plugin(s)/3 file(s) excluded`
and exited `2`, because this host now runs later plugin versions than `v0.0.15`.

## Classification

| class | meaning |
| --- | --- |
| `match` | installed bytes equal `git show <tag>:<plugin>/<rel>` |
| `later-release` | bytes are absent at the tag but present in a later tag or the repository ref |
| `snapshot-not-in-git` | bytes are recorded by the installer's `copiedFiles` but no git ref contains them |
| `unexplained-drift` | none of the above; needs investigation |
| `not-in-tag` | file or whole plugin does not exist at the tag |
| `missing` | declared by the tag manifest but not installed |

Plugin classes: `pinned` (all files match, nothing missing), `later-release`, `drift`, `post-tag` (shipped by the
repository ref but not the tag), `out-of-repo` (not in this repository's distribution index at either ref; excluded
from the denominator and listed with a reason).

## Results

The JJO-1093 run on 2026-11-11 is archived in
[`artifacts/jjo1093-installed-surface-20261111/run.md`](../artifacts/jjo1093-installed-surface-20261111/run.md):
the archived 2026-10-28 record (`recorded-20261028.input.json`, sha256 `6bef2fc4…e5489c`) reproduces 30/30 from
the checkout alone, while the current installed tree is a later mix
(2/35 match, 28 later-release, 5 post-tag, 1 out-of-repo plugin).

## Limits

Hashes establish byte identity only. The script does not prove that a plugin was loaded, that its hooks ran, or that
a release is correct; it does not read plugin contents into the receipt.
