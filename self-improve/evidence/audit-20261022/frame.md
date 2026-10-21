# Audit frame — RRSI + Harness² introduction audit

- base (audit scope, not the current HEAD): `e74140c7b014b60402b6f2c4ef748cfd1b7d3512`
- branch: `feat/mbp-rrsi-harness2-audit-01a15f70`
- window: `40b401c..e74140c` (18 commits); P2b (`e6675cb`/`8a32075`) and P3 (`b9d47c2`) are pre-window reference carriers
- carrier and frozen digests are read from the audit-scope blobs, so they stay valid after the fixes land.

## Carrier scope

| # | carrier | blob sha256 |
| --- | --- | --- |
| C1 | `README.md` | `de10148bcb097501b1a741767025235e39dc655eaa5625521b00e08019bfc299` |
| C2 | `CHANGELOG.md` | `4f353d5f6662e5d984199ddbb913413be9b15e7976728880dedf4948f8828885` |
| C3 | `CONTRIBUTING.md` | `0260d273b00bf97299f84aaf8b809c3dba0d8be1fde20ae4c25bbee49a52ee8b` |
| C4 | `docs/agent-rules.md` | `c5571f8c5a4d79072e9957e8e584a1c8e57d110e155d37da47ae4a1270487bae` |
| C5 | `docs/trajectory-memory.md` | `72cfef389a2186b84815c63cabebaec984e38157899c07bbef8f61557aa2a570` |
| C6 | `rrsi/README.md` | `41061e1985d003b3a855501d2434e68e7455d40e2c2a5bddda9f1130421ee47c` |
| C7 | `self-improve/README.md` | `33aa8b088bfe9706a2793be8f09f6c8d46881a14168ce06cdce9860af3183af5` |
| C8 | `self-improve/DREAM.md` | `7eb4679bbdc82f3a13e586866ae56ff1a9e161060eb6daf13f624789b7fb5b21` |
| C9 | `self-improve/PATTERNS.md` | `4641949b577506fe6da1aec6127e19004b203cdba7681c45817e92c27da5c6a8` |
| C10 | `self-improve/HARNESS2.md` | `20fcc8369414f86517a66c389d6228c04678939d9be27234fbe648e901091d2f` |
| C11 | `self-improve/evidence/README.md` | `62763bbb78e12eafe7dc968c3a40afdc274a7b40ba7bdd1d0f3c5ec63d657dbf` |
| C12 | `self-improve/evidence/p2b/README.md` | `4c20a053c1bfaa82a786b00fe1a05477fba481dc05886520f816a88543fe40ec` |
| C13 | `self-improve/evidence/p3/README.md` | `31d740b1297032a5a25aeaa72f3902223a3d6df1685f0cd5b4b8a7b5ca3d7f7e` |
| C14 | `self-improve/policies/pi-1-25.json` | `944d03a0b146a66acf01ad2d8ded5264d463e71dcf8976e8431d1e9a508f2835` |
| C15 | `self-improve/policies/current.json` | `dd7b61b58b35b0735580c566b269dd5fc32ef71be392041f4c4cb57582108e10` |
| C16 | `self-improve/rrsi-protocol.json` | `8974389570d2a62fb16ebc6583869df864303c987479f757d582915241cf85a6` |
| C17 | `self-improve/replay-protocol.json` | `69e74175bf0964c25b84c2b287dbf487926c9738bb2a66b472cad05be4ccdd0b` |
| C18 | `self-improve/replay-protocol-p2b.json` | `1fe71eb0274f7738b17af79bd10c214f737e01e04f1be68a9ec8d6fa1906ba06` |

## Frozen-path pre-audit digests

| path | sha256 |
| --- | --- |
| `self-improve/ledger.jsonl` | `cc37349db4e9f2cc4bbb6b520e542afa56a142d1512e04015602932bff433c20` |
| `self-improve/rrsi-protocol.json` | `8974389570d2a62fb16ebc6583869df864303c987479f757d582915241cf85a6` |
| `self-improve/replay-protocol.json` | `69e74175bf0964c25b84c2b287dbf487926c9738bb2a66b472cad05be4ccdd0b` |
| `self-improve/replay-protocol-p2b.json` | `1fe71eb0274f7738b17af79bd10c214f737e01e04f1be68a9ec8d6fa1906ba06` |
| `self-improve/policies/pi-1-25.json` | `944d03a0b146a66acf01ad2d8ded5264d463e71dcf8976e8431d1e9a508f2835` |
| `self-improve/policies/current.json` | `dd7b61b58b35b0735580c566b269dd5fc32ef71be392041f4c4cb57582108e10` |
| `self-improve/evidence/p2b/dream-seed1.json` | `dc2383dc6f54567b2561ad3dd7e03baa0235f56a177f2ebe55df84b10619464d` |
| `self-improve/evidence/p2b/replay-b0b1.json` | `f7ab4ef9b334dacb4a6e3aabc3535fef97e4e867ff327547f2cd015443f6bab4` |
| `self-improve/evidence/p3/summary.json` | `0e7d5e588d84f0159ddb87f3bc5e6e7dae4d7c873c22a740ff24ff3e21343170` |
