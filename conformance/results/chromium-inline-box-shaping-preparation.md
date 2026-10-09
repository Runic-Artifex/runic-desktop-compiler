# Chromium inline box shaping preparation

The private per-side computed-intent helper and four tests are retained as dormant preparation. Production construction, damage and inline layout, and the active alignment-only predicate, are identical to Blitz parent 4a6f257. Box intent is not activated. Eighteen authored cases (270 states) are now canonical, with exact candidate values retained. This checkpoint accepts preparation and runtime compatibility; it accepts no runtime parity repair.

The complete fresh 49-stage run covers seven unit stages, 36 direct matrices and six compiled commands. All 5,090 direct native observation states and whole PNGs are unchanged; every retained native JSON and whole/crop/local PNG pair is byte-identical. All 11 reported gates retain their original eligibility, failures and thresholds, including cropPixels and the aggregate pixel gate. Strict parity remains failed in 3740 overlapping states.

| Gate | Passing / eligible | Failed unchanged | Absent | Repairs | Regressions |
|---|---:|---:|---:|---:|---:|
| geometry | 4146 / 5090 | 944 | 0 | 0 | 0 |
| wholePixels | 5018 / 5090 | 72 | 0 | 0 | 0 |
| cropPixels | 2909 / 5090 | 2181 | 0 | 0 | 0 |
| localPixels | 1247 / 4809 | 3562 | 281 | 0 | 0 |
| pixels | 1477 / 5090 | 3613 | 0 | 0 | 0 |
| hits | 4543 / 5090 | 547 | 0 | 0 | 0 |
| pointHits | 516 / 714 | 198 | 4376 | 0 | 0 |
| clientRects | 1317 / 2331 | 1014 | 2759 | 0 | 0 |
| editors | 1925 / 1958 | 33 | 3132 | 0 | 0 |
| scroll | 236 / 284 | 48 | 4806 | 0 | 0 |
| lineWidths | 252 / 252 | 0 | 4838 | 0 | 0 |

Compiled regression evidence passes 61 runs, 569 states, 508 actions and 1,138 PNGs with independent raw and PNG comparisons. All 14 focused style-conversion tests pass. Blitz DOM retains 80 passes and two historical failures and remains unpassed. Unchanged Parley's 206 passes and four failures are historical, not freshly rerun.

Two rejected trials remain separate. Forced paragraph recollection caused six geometry and three aggregate-pixel regressions; it was stopped after seven unit stages and eight direct matrices (1,155 states), before any compiled command completed. Source proofs and all hash-validated relocation entries remain retained. Partial construction activation later produced 27 rect-relative hit repairs, three hit losses and five crop losses. Changed sample positions and owner attribution did not establish paint or numeric-advance parity. The caller was restored; these trial outcomes are excluded from the preparation's final counts.

Tested compiler a577518, Blitz 7be8035, and unchanged Parley 5f982ec are signed and clean; the other four pins are unchanged. The record successor contains docs/results only. Source review found no unresolved defect within the dormant scope. Future activation must integrate placement, ownership, paint, hits and editing, including cached whole atoms with interior nonzero edges. Browser observations do not certify internal atom/cache identity, OS input delivery or fallback/system-font parity; named /code-review completion remains unclaimed.

The [JSON record](chromium-inline-box-shaping-preparation.json) retains compact counts, trial lineage, pins and evidence hashes.
