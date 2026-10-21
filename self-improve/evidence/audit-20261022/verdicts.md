# Verdict table (L5)

- Claim graph: **809 rows** over 18 enumerated carriers (`claims.csv`), all 809
  candidates dispositioned (`dispositions.jsonl`), checked by
  `node scripts/check-audit-claims.mjs --base e74140c`.
- Counts: **PASS 732 (175 bound / 557 self) · GAP 14 · UNVERIFIABLE 63**.
- Aggregate: **`GAPS_OPEN (14)` at audit time** — 9 fixed at HEAD, 5 frozen and
  recorded in [`annex.md`](annex.md). Every fix has a post-fix command in
  [`closures.md`](closures.md); the post-fix battery is
  [`battery.md`](battery.md) (exit codes and digests from
  [`battery-results.json`](battery-results.json)).

## GAP rows (confirmed defects)

| Finding | Row | Carrier:line | Class/sev | Fix class | Fix task |
| --- | --- | --- | --- | --- | --- |
| F-01 dual-floor says 6 guards | K0716 | `self-improve/rrsi-protocol.json:45` | BND/S2 frozen | annex | T-B7 |
| F-02 validation slice "3 adoption cycles" | K0800 | `self-improve/replay-protocol-p2b.json:70` | MEAS/S1 frozen | annex | T-B7 |
| F-03 policy provenance not in evidence | K0686 | `self-improve/policies/pi-1-25.json:13` | IMP/S1 | evidence | T-B1 |
| F-04 hash-role ambiguity | K0794 | `self-improve/replay-protocol-p2b.json:64` | REF/S2 frozen | annex + doc | T-B7, T-B6 |
| F-05 40-char identifier vs 64 cap | K0288 | `rrsi/README.md:106` | REF/S3 | doc | T-B6 |
| F-06 `status.adoptions` semantics | K0238 | `rrsi/README.md:29` | BND/S2 | doc | T-B6 |
| F-07 `import` coverage not reported | K0256 | `rrsi/README.md:59` | BND/S3 | doc (+T-B10) | T-B6 |
| F-08 dead reproduction path | K0192 | `docs/trajectory-memory.md:105` | REF/S2 | doc | T-B6 |
| F-09 dated-receipt exception unstated | K0142 | `docs/agent-rules.md:36` | BND/S3 | doc | T-B6 |
| F-10 snapshot without command | K0194 | `docs/trajectory-memory.md:110` | MEAS/S3 | doc | T-B6 |
| F-14 interval override silently clamps | K0246 | `rrsi/README.md:45` | IMP/S2 | doc | T-B6 |
| F-15 two cycle counts unlabelled | K0663 | `self-improve/evidence/p3/README.md:43` (the row quotes an accurate sentence; the defect is in the frozen `p3/summary.json` keys) | MEAS/S2 frozen | annex | T-B7 |
| F-17 sub-gate split overlap | K0801 | `self-improve/replay-protocol-p2b.json:71` | BND/S2 frozen | annex | T-B7 |
| F-18 "advisory" pair is train/full | K0362 | `self-improve/README.md:145` | MEAS/S3 | doc | T-B3 |

Withdrawn during consensus: F-11 (separate checker, no doc defect), F-12 (code
import defect, handled as T-B2), F-13 (release constraint, not a defect),
F-16 (`CHANGELOG.md:56` "is unchanged" is consistent).

## Positive controls (must stay PASS)

- `self-improve/README.md:145` discloses **P1 DEGRADED** with its cause and
  refuses a met-threshold claim for the below-gate corpus.
- `docs/trajectory-memory.md` states **E5b not executed** and the guard-tier dry
  run unproven.
- `rrsi/README.md` carries the plugin scope sentence forbidding a performance
  claim (`RRSI_SCOPE_SENTENCE` in `rrsi/lib/rrsi.ts:23-24`).
- `self-improve/evidence/p3/README.md` states all five cycles are rejects.

## UNVERIFIABLE rows (63)

| Carrier | Rows | Missing receipt |
| --- | --- | --- |
| `CHANGELOG.md` | 28 | release-time receipt (tag/commit); historical release notes not re-derived |
| `docs/trajectory-memory.md` | 25 | private rrsi-store snapshot; non-reproducible by design (F-08/F-10) |
| `README.md` | 8 | root overview figure without a stored receipt at that granularity |
| `CONTRIBUTING.md` | 2 | process statement; no numeric receipt exists |

## Runtime sample (read-only, 2026-10-22)

- `rrsi status`: storage `ok`; episodes 10, attempts 212, adoptions 26; periodic
  last success `2026-10-20T20:47:42.813Z`, interval 86400000, receipts 15,
  `lastProjection` records 2974 / projected 160 / omitted 2814, `limited: true`,
  `due: false` (`skipped_due`).
- Installed rrsi manifest 0.0.2 == repository 0.0.2; `gjc plugin doctor`: 8 ok,
  3 warnings (plugins directory / package manifest / node_modules absent), 0 errors.
- Limitation: the store is private and mutable; these counts are a sample, not a
  reproducible series. Installed code bytes are not compared.

## External cross-checks (read-only)

- Linear `JJO-269` "Harness² × self-improve 연관성 조사·도입 문서 전달",
  `JJO-270` M1, `JJO-271` M2, `JJO-272` M3 all resolve (updated
  2026-10-19T14:40–14:43Z) and match the roadmap in `self-improve/HARNESS2.md`.
- Pinned upstream refs resolve: `google-research/harness2@1cfe254e…` and
  `jjongguet/gjc-plugin@b9d47c2…`.
- Limitation: link/title resolution only. Upstream benchmark numbers were not
  reproduced; Linear issue state/labels beyond existence were not audited.

## What this establishes / does not establish

**Establishes:** the frozen-corpus receipts reproduce byte-for-byte; the
documented mechanisms are bound to code/tests that ran green; 14 concrete
text/provenance defects exist and are classified; frozen files were not edited.

**Does not establish:** efficacy or generalizability of Dream-RSI/Harness²;
live-provider equivalence; installed-code equality beyond manifest version;
Linear workflow correctness beyond issue existence; any claim in the 63
UNVERIFIABLE rows.
