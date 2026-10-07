# Blitz tables: implementation attempt (2026-10-07)

Blitz branch `table-layout`, signed commits `3971a7ba` and `f85b2539`, based on `e8dd36c6`. Compiler verification branch `blitz-tables`, based on `485fc86`. [Implementation and reproduction](../../docs/research/BLITZ-TABLES.md).

| Check | Result |
|---|---|
| Chromium cases / observed states | 51 / 65 |
| Geometry (every id, 1/8 px) | 65/65 |
| Hit targets (3 per id, internal hit testing) | 65/65 states |
| Whole-page pixels (MAE ≤ 3/255) | 65/65 |
| Table-region pixels (MAE ≤ 3/255) | 62/65 |
| Table oracle exit | 1 — pixel parity incomplete |
| Compiler checks | Type-checking and all 297 Node tests passed |
| Rust workspace | 116 tests passed |
| Native table regression tests | 6 passed (included in the 116) |

All geometry and hit-target checks pass for automatic/fixed widths, percentage cell widths, min/max constraints, col widths, captions and margins, top/middle/bottom/baseline alignment, row/group geometry, ordered headers/footers, RTL, rowspan/colspan (including zero and group-clamped rowspans), and the dynamic mutations in the oracle. Added height cases cover border-box minimum cell heights, natural content growth, rowspan heights and a non-spanning percentage cell in a definite-height table, including subsequent content growth and return to automatic table height. No compiler table acceptance, OS event delivery or general browser equivalence is claimed.

Compared with the initial 33-case run, the original table-region checks improve from 34/43 to 41/43. All seven original collapsed-border failures now pass. The expanded cases cover fractional border positions, thin and thick dots, groove/ridge and inset/outset, sparse borders, span junctions, colored/gradient cell backgrounds, hidden cell backgrounds, and cell/table opacity (including cell opacity with foreground content). The two bevel cases match pixels exactly; this does not establish general bevel equivalence.

The cropped metric intentionally exposes differences hidden by a mostly white page. Three retained cases still fail:

| Case | Table-region MAE / 255 |
|---|---|
| `baseline` | 3.197 |
| `empty` | 3.569 |
| `collapse_dots5` | 3.739 |

These contain baseline text, the caption on an empty table and thick round dotted borders. Sampled line positions/advances and dot placement were inspected; remaining raster differences need follow-up. The oracle retains its nonzero exit; no tolerance was widened and no reference was changed.

Raw observations, text-line diagnostics, screenshots and check logs live in the worktree’s `artifacts/tables/`. The final runs are `oracle-verified.log`, `npm-followup.log` and `cargo-followup.log`. The integration tests in the Blitz repository contain the same six font-independent cases exercised by the compiler probe; the standalone upstream Blitz test workspace has not been run. The probe and its oracle hold the project PID lock through building and observation, preventing another worktree's build from deleting the probe mid-run.

The initial Node setup failure and corrected development build failures are retained in the logs. Final compiler and Rust checks passed against the unchanged dependency pins. The broader unverified table surface remains listed in the implementation document.
