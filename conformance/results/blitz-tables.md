# Blitz tables: implementation attempt (2026-10-07)

Blitz branch `table-layout`, signed commit `3971a7ba`, based on `e8dd36c6`. Compiler verification branch `blitz-tables`, based on `485fc86`. [Implementation and reproduction](../../docs/research/BLITZ-TABLES.md).

| Check | Result |
|---|---|
| Chromium cases / observed states | 33 / 43 |
| Geometry (every id, 1/8 px) | 43/43 |
| Hit targets (3 per id, internal hit testing) | 43/43 states |
| Whole-page pixels (MAE ≤ 3/255) | 43/43 |
| Table-region pixels (MAE ≤ 3/255) | 34/43 |
| Table oracle exit | 1 — pixel parity incomplete |
| Compiler checks | Type-checking and all 297 Node tests passed |
| Rust workspace | 114 tests passed |
| Native table regression tests | 4 passed (included in the 114) |

All geometry and hit-target checks pass for automatic/fixed widths, percentage cell widths, min/max constraints, col widths, captions and margins, top/middle/bottom/baseline alignment, row/group geometry, ordered headers/footers, RTL, rowspan/colspan (including zero and group-clamped rowspans), and the dynamic mutations in the oracle. No compiler table acceptance, OS event delivery or general browser equivalence is claimed.

The cropped metric intentionally exposes differences hidden by a mostly white page. The nine retained failing cases are:

| Case | Table-region MAE / 255 |
|---|---|
| `collapse` | 4.857 |
| `baseline` | 3.197 |
| `empty` | 3.569 |
| `collapse_spans` | 3.163 |
| `collapse_mixed` | 4.908 |
| `collapse_rtl` | 3.244 |
| `collapse_hidden` | 3.173 |
| `collapse_rowborder` | 4.338 |
| `collapse_styles` | 11.513 |

The worst case mixes double/dashed/dotted collapsed borders. Remaining differences include collapsed border patterns/junctions and text rasterisation/positioning. The oracle retains its nonzero exit; no tolerance was widened and no reference was changed.

Raw observations, screenshots and check logs live in the worktree’s `artifacts/tables/`. The integration tests in the Blitz repository contain the same four font-independent cases exercised by the compiler probe; the standalone upstream Blitz test workspace has not been run.

The first Node run used main’s older dependency cache and failed on missing M6 packages. Reusing the existing M6 cache fixed the setup; the full rerun passed. Its failed log is retained. Cargo verification uses the project PID-lock wrapper (`compiler/cargo.mjs`), not an OS `flock` on that PID file.
