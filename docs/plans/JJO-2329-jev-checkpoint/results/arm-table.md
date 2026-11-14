| stage | split | condition | cells ok/failed/not_run | success (mean) | wasteTurns (mean) | toolCalls (mean) | tokens (mean) | sessionUsd (sum) | wall s (mean) | jevUsd (sum) | 오판 falseStop/falseProceed | labelCorrect/labelChecks | noDecision | expectedStall (W) | waste_error_imputed |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| S1 | dev | a1-off | 13/5/0 | 0.333 | 1.11 | 14.61 | 154397 | 0.09091 | 55.1 | 0.000000 | 0/0 | 0/0 | — | 0×3158=0m | 5 |
| S1 | dev | bp-periodic | 15/3/0 | 0.500 | 1.44 | 13.67 | 147202 | 0.08593 | 37.7 | 0.000120 | 5/0 | 7/23 | low_confidence:11 | 5×3158=15790m | 3 |
| S1 | dev | de-error | 13/5/0 | 0.389 | 1.28 | 13.72 | 145439 | 0.08498 | 50.8 | 0.000095 | 2/0 | 6/26 | low_confidence:18 | 2×3158=6316m | 5 |
| S2 | dev | c3-ensemble | 15/3/0 | 0.556 | 1.00 | 11.17 | 123443 | 0.07166 | 30.5 | 0.000197 | 0/0 | 5/36 | low_confidence:31 | 0×3158=0m | 3 |
| S3 | holdout | a1-off | 17/1/0 | 0.861 | 2.78 | 11.06 | 112158 | 0.06414 | 21.3 | 0.000000 | 0/0 | 0/0 | — | 0×3158=0m | 1 |
| S3 | holdout | fz-frozen | 17/1/0 | 0.806 | 2.33 | 11.28 | 109815 | 0.06294 | 21.7 | 0.000072 | 0/0 | 7/21 | low_confidence:14 | 0×3158=0m | 1 |
