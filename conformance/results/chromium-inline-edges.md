# Chromium inline edges: fixed horizontal edges of ordinary spans

2026-10-12. Tested compiler `1fff240` (on main `f1d2f74`), Parley `13cfb74` (two commits on `2ada2ec`) and Blitz `c8ecc95` (two commits on `7be8035`), all signed and unpushed; the other pins are unchanged. Pins, counts and checkpoints are in the [JSON record](chromium-inline-edges.json). **Accepted:** zero regressions on every gate in all 36 direct matrices and both cache drivers, against unchanged references, tolerances and cases. All six compiled commands pass.

Fixed, non-negative horizontal margin, border and padding of ordinary `display:inline` spans now take space in left-to-right standards-mode text:

- **Blitz and Stylo** resolve the values per box after vertical alignment and refresh them in Parley without reshaping. A change in effective border presence on any side reshapes, as in pinned Blink. Construction requests per-side shaping intent.
- **Parley** attaches each authored edge to a shaped atom when the layout is built. Closing edges go to the preceding atom and opening edges to the following one, so a wrapped span puts its opening edge on the first fragment and its closing edge on the last. A closing edge right after a forced break stays on the line the break ends, and the break's zero-width newline does not extend the box. The advances flow through the existing spacing gaps into both line breakers, intrinsic widths, glyph and cluster positions, empty anchors and fragment bounds.
- **Blitz** uses the border box (own margins excluded) for client rects and hit testing, trims text fragments and decorations by the edges, and paints the background and solid borders over the border box.

Other inputs are reported once through the runtime's unsupported mechanism: percentages, `calc()` and anchor functions, negative margins, a nonzero edge at a side where an out-of-flow box follows collapsible whitespace, quirks mode, right-to-left edges, non-solid or rounded borders, and edges with no adjacent text. In the first four cases the box keeps its edge-less layout and shaping as a whole. The out-of-flow case is a Parley limitation: a box pushed while whitespace is pending is placed before that whitespace, so an edge at its normalized position would not be placed consistently with it. The [gap row](../../docs/gaps/PLATFORM.md) lists all of them.

## Direct matrices

All 36 matrices ran, covering 5,090 states. No states are missing or added, and exit codes match the baseline (`artifacts/inline-box-shaping-preparation`, which the main-tree rebaseline found unchanged). Thirty matrices have unchanged gate results. A gate passes for a state when its difference list is empty. The pixel gates require an MAE of at most 3 for the whole image, the crop and every local region; the `pixels` gate requires all three.

| Gate | Baseline pass | Now | Repairs | Regressions |
|---|---:|---:|---:|---:|
| geometry | 4146 | 4476 | 330 | 0 |
| hits | 4543 | 4768 | 225 | 0 |
| pointHits | 4892 | 4952 | 60 | 0 |
| clientRects | 4076 | 4328 | 252 | 0 |
| editor | 5057 | 5057 | 0 | 0 |
| scroll | 5042 | 5042 | 0 | 0 |
| lineWidth | 5090 | 5090 | 0 | 0 |
| wholePixels | 5018 | 5054 | 36 | 0 |
| cropPixels | 2909 | 3150 | 241 | 0 |
| localPixels | 1528 | 1571 | 43 | 0 |
| pixels | 1477 | 1520 | 43 | 0 |

The number of states passing every gate rises from 1,350 to 1,396. Six matrices change, all without regressions:

| Matrix | States | Repairs |
|---|---:|---|
| inline-span-edges | 306 | geometry 96, hits 72, clientRects 99, crop 92, whole 21, local/pixels 19 |
| inline-flow-affinity | 165 | geometry 72, hits 66, pointHits 51, clientRects 75, crop 37, whole 9 |
| inline-edge-drivers | 27 | geometry 12, hits 3, pointHits 3, clientRects 12, crop 5 |
| inline-fragments | 363 | geometry 30, hits 30, clientRects 30, crop 12, whole 6 |
| control-layout | 264 | geometry 84, crop 66 (the omitted 8px `#text` margin) |
| inline-shaping-edges | 270 | geometry 36, hits 54, pointHits 6, clientRects 36, crop 29, local/pixels 24 |

The cache drivers gain too, without regressions. inline-cached-edges (144 states) gains geometry and clientRects 81, hits 57 and crop 56. inline-border-history (162 states) gains geometry and clientRects 96, hits 63, pointHits 72 and crop 23.

## Regressions fixed in the final round

The previous full run left 24 hit regressions. Both causes are fixed:

- **Closing edge right after a forced break**: `forced_newline_close` and `forced_br_immediate_close`, 9 states each. A zero-width newline after a span's own nonzero closing edge no longer extends the span's bounds. Their hits are back to the baseline. Geometry and client rects are now repaired in all 18 states, and the crop in 6.
- **Out-of-flow box after pending whitespace at an edged side**: `pending_absolute_before_open_combining` and `pending_fixed_before_open_combining`, step 1, 6 states. This is now an unsupported input, reported, and the box keeps its edge-less layout. Every recorded value of these 6 states is identical to the baseline: geometry, differences, hits, point hits, client rects, the whole, crop and local pixel MAEs, editor, scroll and line width.
  - The same rule applies to `pending_oof_inside_open_close` (`AA <span> <oof>BB </span>`). Its 3 hit repairs from the previous run are given back, and it matches the baseline.

The two earlier rounds fixed:

- unsupported values mixed with supported ones;
- a shaping seam inside a flag;
- a closing edge that wrapped a line after a forced break.

## Compiled commands and unit tests

- **Compiled commands:** all six pass, with 61 runs and 569 states. The runtime report fires in none of them.
- **Parley:** 224 pass at `13cfb74`. The four known `cluster_from_position_*` failures remain, and there are no new failures. Ten new edge tests are included. Parley is not a workspace member, so Cargo cannot test it from the pinned checkout; the tests ran in a clean worktree at that commit.
- **Blitz:** at the git pins, blitz-dom passes 86. The two known failures (`scroll_by_clamps_and_bubbles`, `hover_styles_apply_and_clear`) remain, and six new tests are included. blitz-paint passes 13 and blitz-html passes 3.
- **Workspace:** on the rebased branch, `node compiler/cargo.mjs test --locked --offline --workspace` passes 143.
- **Compiler:** on the rebased branch, `npm test` passes 358.

## Not covered

These are incomplete, not passed:

- Caret and selection geometry next to edges. Cluster advances include the edge, so the upstream and downstream caret positions at a box boundary coincide.
- `box-decoration-break: clone`.
- Painting of non-solid and rounded borders.
- Right-to-left and bidi edges.
- Edges with no adjacent text.
- Percentage, `calc()`, anchor and negative values.
- Edges at a side where an out-of-flow box follows collapsible whitespace.
- Quirks mode.

Chromium references, tolerances and cases are unchanged. Browser observations do not prove OS keyboard or IME delivery.
