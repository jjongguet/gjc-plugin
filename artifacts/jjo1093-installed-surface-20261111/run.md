# JJO-1093 — installed-surface verification against `v0.0.15`

Receipt for re-deriving JJO-945's **"설치 파일 30/30 v0.0.15 blob 바이트 일치"** claim.
Measured 2026-11-11 on host `mini`, session `31140357-3d65-479f-bc8a-505898dd89ee`.

- Repository: `jjongguet/gjc-plugin`, base `e4cf7ef54fa5d2ce098d7d57f6d340d8879b1f2a`, integration branch `main`.
- Tag under test: `v0.0.15` = `238aa0b175b463e95986e4a288209c50aeaa6bc9`.
- Installer registry: `~/.gjc/agent/gjc-plugins/registry.json` (`sha256 d88395b4aca65a14…`).
- Script: `scripts/verify-installed-surface.mjs` (`sha256 bc5729b22744e87d5cf8a025799254c271472ed5a962d850b4fd222433447865`).
- Test: `scripts/tests/installed-surface.test.mjs` — 3 fixture tests, 3 pass.

## 1. What "30" counts

The claim comes from the JJO-945 result comment of `2026-10-28T13:20:37Z`:

> 7개 플러그인 순서 재설치(안정 소스 `~/jjongguet/gjc-plugin` @v0.0.15), 설치 파일 30/30 v0.0.15 blob 바이트 일치, installedSurfaceDigest `041e3890…e4f96`

The same run archived its evidence at `~/jjongguet/artifacts/jjo945-pilot-20261028/installed-surface.json`
(`sha256 6bef2fc410a3cbc73859d00535a51abe08565014bcef6bb04b390dbe3de5489c`, written `2026-10-28T13:16Z`).
That file lists **30 installed files across 8 plugins** — so 30 is an **installed-file** denominator, not a repository-file count:

| plugin | files | plugin | files |
| --- | ---: | --- | ---: |
| aside-memory | 2 | rrsi | 3 |
| backplan | 2 | ui-regression | 3 |
| jev-advisor | 9 | verification-receipts | 6 |
| rea | 2 | wiki | 3 |

The 7 plugins reinstalled at `2026-10-28T17:03Z` (per the registry `updatedAt` values) plus `aside-memory`,
installed earlier at `2026-10-26T05:47Z`, add up to 30. The installer copies only the manifest and the files the
manifest declares (`tools/*`, `hooks/*`); the same 8 plugin directories contain **134 tracked files at `v0.0.15`**,
which is why the rejected `git ls-tree -r v0.0.15 -- <plugin>` method reports 104 source files as MISSING.

## 2. Recorded surface, recomputed (exit 0)

```
node scripts/verify-installed-surface.mjs --repo <checkout> --tag v0.0.15 \
  --recorded ~/jjongguet/artifacts/jjo945-pilot-20261028/installed-surface.json \
  --json artifacts/jjo1093-installed-surface-20261111/recorded-20261028.json
```

- Result: **30/30 match, 0 mismatch, 0 missing-in-tag** — every recorded sha256 equals the sha256 of
  `git show v0.0.15:<plugin>/<rel>`. The `installedSurfaceDigest 041e3890…e4f96` is preserved in the output.
- Output: `recorded-20261028.json` (`sha256 52754838d5d0fcc6d5d1908a051f0686337f82d1b8fce2f0bafeb8c242d61c16`).

This reproduces the claim for the archived 2026-10-28 surface. It does **not** prove that today's installed bytes
are the same: that tree was overwritten later (see §3).

## 3. Today's installed tree is not `v0.0.15` (exit 2)

```
node scripts/verify-installed-surface.mjs --repo <checkout> --tag v0.0.15 \
  --registry ~/.gjc/agent/gjc-plugins/registry.json \
  --json artifacts/jjo1093-installed-surface-20261111/installed-20261111.json
```

Result (`installed-20261111.json`, `sha256 4ef866bffbd452f77d8977eceacc8d2f60213de76c78f7505860467b4745f30f`):

| measure | value |
| --- | ---: |
| installed files walked | 38 |
| in scope (excluding out-of-repo) | 35 |
| byte-identical to `v0.0.15` | 2 (`aside-memory` only) |
| different, contained in a later tag/ref | 28 |
| different, not in any tag/ref | 0 |
| not present in `v0.0.15` (post-tag plugins) | 5 |
| declared by the `v0.0.15` manifest but missing | 0 |
| out-of-repo plugin / files excluded | 1 / 3 |
| installer-declared surface at `v0.0.15` | 30 |

Every difference is classified, not collapsed into a mismatch:

| plugin | installed | `v0.0.15` | files | class |
| --- | --- | --- | ---: | --- |
| aside-memory | 0.0.2 | 0.0.2 | 2 | pinned (2 match) |
| backplan | 0.0.10 | 0.0.9 | 2 | later-release (`v0.0.16`+) |
| jev-advisor | 0.0.16 | 0.0.11 | 9 | later-release (`v0.0.18`+) |
| rea | 0.0.7 | 0.0.6 | 2 | later-release (`v0.0.16`+) |
| rrsi | 0.0.6 | 0.0.5 | 3 | later-release (`v0.0.16`+) |
| ui-regression | 0.0.10 | 0.0.8 | 3 | later-release (`v0.0.19`+) |
| verification-receipts | 0.0.11 | 0.0.7 | 6 | later-release (`v0.0.25`+) |
| wiki | 0.0.8 | 0.0.6 | 3 | later-release (`v0.0.20`+) |
| egm | 0.0.1 | — | 2 | post-tag (shipped by `main`, absent at `v0.0.15`) |
| memory-dream | 0.0.1 | — | 3 | post-tag (shipped by `main`, absent at `v0.0.15`) |
| agents-freshness | 0.1.0 | — | 3 | out-of-repo, excluded |

Registry backup evidence (`registry.json.bak`, last written `2026-10-28T17:03Z`) records 33 copied files for
9 plugins; only 5 of them hash to `v0.0.15` blobs. The 17:03Z reinstall therefore replaced most of the archived
bytes with post-tag content. Conclusion: the `30/30` statement describes the **2026-10-28T13:16Z snapshot only**;
it is not a statement about the current install.

## 4. Out-of-repo exclusion

`agents-freshness` is excluded with reason: it is not listed in `gjc-plugin.json` at `v0.0.15` or at `origin/main`,
so there is no in-repository blob to compare against. Its registry source is
`<home>/.gjc/agent/policy/plugins/agents-freshness`, outside this repository. The 3 installed files
(`gajae-plugin.json`, `hooks/start.ts`, `tools/check.ts`) are listed as `not-in-tag` in the JSON but kept out of
the match denominator.

The handoff's alternate path `~/.gjc-user-policy/plugins/agents-freshness` did not exist at measurement time
(`~/.gjc-user-policy` itself is absent on this host). Measured, not inferred.

## 5. Install-root correction

The installed plugin code root is **not** `~/.gjc-plugin/<plugin>/`. The installer registry
(`~/.gjc/agent/gjc-plugins/registry.json`, also documented in `CONTRIBUTING.md`) records each `pluginRoot` as
`~/.gjc/agent/gjc-plugins/<plugin>`; all 11 recorded roots exist. `~/.gjc-plugin/` holds 13 directories but no
`gajae-plugin.json` at all — it stores runtime data (journals, receipts, runs), not plugin code.

## 6. Limits

- Comparison is hash-only; file contents were not quoted.
- The 2026-10-28 installed bytes no longer exist on disk; §2 verifies the archived record, §3 verifies today's tree.
- Registry `copiedFiles` entries are installer-recorded values, not an independent measurement.
- No claim is made about other hosts, the MacBook install, model behaviour, or release correctness.
