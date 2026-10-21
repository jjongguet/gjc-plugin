# Missing-spot sweeps (S1–S5)

Each sweep reports its hit count and its own limit. S6 (upstream benchmark
re-verification) is out of scope for this mission.

## S1 — literal extraction → claim graph

- Mechanical candidates: **809** (18 carriers, sentences with a number, a modal
  claim verb, a path/sha/link, or a boundary phrase).
- Dispositions: **809/809** (`dispositions.jsonl`), each mapped to one claim.
- Claims: **809** = REF 77 · IMP 139 · BND 303 · MEAS 258 · RDM 32.
- Reconciliation: `|S1 literals| − |claims.csv MEAS rows| = 258 − 258 = 0`
  (the mapping is 1:1 by construction; `--reenumerate` re-derives the same set
  from an exported `e74140c` tree and reports 0 unlisted sentences).
- Limit: the generator only emits hint-bearing sentences, so 809 is a filtered
  subset, not a sentence count. A claim with no hint is outside the denominator.

## S2 — reverse sweep: exported constants → documentation

- Constants checked: `RRSI_LIMITS` 9, `RRSI_PERIODIC_DEFAULTS` 8, protocol caps
  6 (`rrsi-protocol.json` m2/m4), pass-gate/split 3 = **26**.
- Documentation mismatches found: **2** — F-05 (identifier vs label cap) and
  F-14 (interval floor/clamp). Both fixed in `rrsi/README.md`.
- Frozen-semantics mismatches recorded (not edited): F-01 (6 vs 7 guards), F-02
  (validation adoption count), F-17 (sub-gate split overlap) → `annex.md`.
- Limit: the sweep covers constants named in the two modules and the two
  protocols, not every literal in every plugin.

## S3 — reference resolution

- Relative links: **61** tracked Markdown links, `bun run docs:check` exit 0
  (links only; 9 of the 77 REF rows carry a Markdown link, the other 68 are
  `self` bindings).
- Pinned commits: `e6675cb`, `7f2f97f`, `02c3177`, `b9d47c2` resolve locally
  (`git cat-file -e`); `harness2@1cfe254e` resolves upstream (read-only fetch).
- Linear refs: JJO-269/270/271/272 resolve with matching titles.
- Limit: resolution only — upstream content and Linear workflow state were not
  audited.

## S4 — claim ↔ test matrix

- Binding split: **175 bound / 557 self**. `bound` = an executed command or
  receipt (docs:check 9, build:check 51, test:self-improve 86, check-number 29);
  `self` = quote presence at the pinned scope.
- Execution: `tools/bound-sweep.mjs` runs each of the 28 distinct bound commands
  once → **175/175 rows, 0 failures** ([`reproductions/bound-sweep.txt`](reproductions/bound-sweep.txt)).
- Suites exercised: self-improve unit **136** cases, integration **45**, rrsi
  acceptance **32**, readme-contract **4**, fixture/check tests **10**,
  real-journal **2**, periodic node tests **2**.
- Changed behavior with a bound case: T-B2 (journal-dream import + determinism
  cases), T-B10 (projection-coverage cases), T-B9 (row + negative control).
- Orphan changed behavior: **0** found. Docs-only changes have no test by design.
- Limit: a test that passes does not prove a doc sentence; that is what the
  `bound`/`self` split makes explicit.

## S5 — time drift

- Dated/numeric figures checked: **4** (`ledgerHead 31`, `store.attempts 212`,
  P2b `22` attempts, P3 `cycles 5/7`).
- Stale or unverifiable figures repaired: **2** (F-08 dead snapshot path, F-10
  snapshot without a command). Store-derived rows are now labelled
  non-reproducible; the P3 counter split is labelled in `annex.md`.
- Limit: the private rrsi store keeps changing, so the sampled counts cannot be
  reproduced; the receipt labels them as a point-in-time sample.
