# Blitz tables and shared raster controls (2026-10-07)

Isolated Blitz branch `table-layout`: signed commits `3971a7ba`, `f85b2539`, `166f3a61`, based on `e8dd36c6`. Renderer branch `runic-raster-parity`: signed `a8efce54`, based on the existing Vello pin `2a06f3e9`. Compiler verification branch `blitz-tables`, based on `485fc86`. [Implementation and reproduction](../../docs/research/BLITZ-TABLES.md), [targeted parity plan](../../docs/research/CHROMIUM-PARITY.md).

The three retained table failures are fixed. Widths, advances and reference images were not adjusted to pass the gate. The corrections belong to shared border geometry and glyph rendering, with no table-specific text policy.

| Previously failing case | Previous local MAE / 255 | Current local MAE / 255 |
|---|---|---|
| `baseline` | 3.197 | 0.950 |
| `empty` | 3.569 | 1.439 |
| `collapse_dots5` | 3.739 | 1.072 |

The unchanged threshold is 3/255. Four added table controls cover 4px/7px dots and 5px dots at fractional positions and in RTL. Six glyph states and two ordinary-border controls isolate shared painting from the table formatting context.

| Check | Tables | Glyph controls | Ordinary borders |
|---|---|---|---|
| Cases / observed states | 55 / 69 | 3 / 6 | 2 / 2 |
| Geometry (every id, 1/8 px) | 69/69 | 6/6 | 2/2 |
| Hit targets (3 per id, internal testing) | 69/69 states | 6/6 states | 1/2 states |
| Whole-page pixels (MAE ≤ 3/255) | 69/69 | 6/6 | 2/2 |
| Local-region pixels (MAE ≤ 3/255) | 69/69 | 4/6 | 1/2 |

This is 60 cases / 77 states overall. The complete oracle exits **1**, retaining three newly exposed primitive failures. The table subset passes every gate. The whole-page metric alone would conceal every remaining failure.

| Retained primitive case | Local MAE / 255 | Remaining behavior |
|---|---|---|
| `glyph_positive_origin` | 4.063 | Dense 16px text at a fractional device origin; boxes/line positions agree |
| `glyph_negative_origin` | 4.100 | Same control with a negative outer origin; boxes/line positions agree |
| `border_dots5_rounded` | 27.407 | Ordinary rounded dotted-border geometry/painting and hits at two rounded-away corners |

The square ordinary dotted-border control passes at 1.574/255. Glyph size mutations at 12/14/16/24px pass; the 24px region improves from 10.792 to 1.140/255 with light auto hinting. Those samples do not establish general font or shape equivalence.

A comparison with the preceding Blitz border painter (`f85b2539`), keeping the
renderer fixed, gives 3.636/255 for the square ordinary border and 26.640/255 for
the rounded one. The two rounded-corner hit mismatches are identical. Thus the
square border also crosses the gate with this fix, while the rounded pattern/hit
gap predates it and remains open; its local paint error rises to 27.407/255 with
the more accurate circles. This limits adoption until rounded-border geometry
is addressed. Baseline observations are in `ordinary-border-baseline/` and its
check log; the final full oracle was rerun after restoring the patched source.

The table surface includes automatic/fixed widths, percentage cell widths, min/max constraints, column widths, captions and margins, vertical/baseline alignment, row/group boxes, header/footer ordering, RTL and bounded/zero spans. Dynamic cases mutate contents, widths, spans, caption side and alignment. Height cases cover border-box minimum cell heights, content growth, rowspan heights and non-spanning percentage cells in definite-height tables. Paint cases cover conflict resolution, fractional borders, dots/dashes/double/beveled styles, span junctions, gradients, visibility and cell/table opacity.

| Other verification | Result |
|---|---|
| Compiler | Type-checking and all 297 Node tests passed |
| Rust workspace | 116 tests passed |
| Native table regressions | 6 passed, included in workspace total |
| Glifo unit tests | 26 passed, including device-transform and positive/negative atlas carry regressions |

Selected CPU framework regressions also ran at 420/800px: `bits-toggle-group`,
`blitz-button-baseline` and `text-elements` (Svelte/React/Vue). All 10 runs / 114
states pass semantics and geometry. Three runs pass pixels strictly; seven retain
their existing declared pixel gaps (420px dense toggle text and text decoration
offsets). The runner exits 0 with `passed-with-known-gaps`, which is **not** full
pixel parity. The dense toggle region reaches 3.856/255; decorated text reaches
3.181/255 at 800px and 5.037/255 at 420px. Raw traces are in
`ui-regressions/report.json`; case annotations and thresholds were not changed.

The oracle uses locked Chromium **153.0.8010.12**, Linux CPU, 640×300 at DPR 1 and embedded DejaVu Sans. Font SHA-256: `a75044e4dab293c1ac7f8eba9f20df03f183f41b9319054f43b955959981632a`. Raw environment/binary/lock/input hashes, observations, crops and logs are retained in `artifacts/tables/`. Final checks: `oracle-final-expanded.log`, `npm-final.log`, `cargo-final.log`, `glifo-final.log`, `ui-regressions.log`; corrected development build failures remain in separate logs.

Neither the main checkouts nor compiler element acceptance were changed. This does not certify GPU rasterization, other font formats/platforms/DPRs, OS input, accessibility or the remaining table surface in the implementation document. The standalone upstream Blitz test workspace has not been run; its six table tests are mirrored in the compiler probe. The probe and oracle hold the project PID lock through building and observation. No patch has been offered upstream yet.
