# Chromium nested inline alignment — isolated checkpoint

All 60 previously failing nested-middle geometry states are repaired, including
their measured fragment lists. The retained 180-state middle oracle now passes
180/180 geometry, 120/120 measured fragment states and 147/180 hits.
The new 72-state oracle passes 66/72 geometry,
57/72 fragments and 63/72 hits.
It passes 0/72 strict pixel states; layout agreement does not establish paint parity.
The middle matrix has 10 strict pixel repairs and 7 new pixel regressions,
retained as failures despite corrected bounding geometry. A separate 18-state
diagnostic exposes the anonymous inner span: all geometry and both fragment lists
pass, with identical viewport/container/text pixel errors to the canonical cases.
The child logical baseline agrees; paint/font rounding remains under investigation.

Parley owns a private per-line alignment module. It retains each participating
span's own metrics, unites already positioned descendants bottom-up, then resolves
the ancestor's parent-relative shift. Line output stores sparse span baselines,
consumed by glyph positions, span content bounds and atomic positions. Saved line
states, arena truncation, intrinsic replay and public default-state restoration
are covered. Device/default and disabled quantization keep the eager path.
Blitz's atomic-box adapter scales CSS length shifts once into layout units;
text styles continue through Parley's own scaled resolver. No public API, IR,
framework adapter, font provider or renderer change is part of this checkpoint.

The new [oracle](../nested-alignment.mjs) freezes parents with and without direct
text, baseline/middle/length descendants, positive and negative leading,
top/bottom ancestors, wrapping, atomics and empty spans at DPR 1/1.25/2 with a
fractional origin and mutation. Both ancestor and descendant have fragment gates.
Standards-mode textless ancestors retain their own span boxes, as the pinned
Chromium [open-tag code](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/layout/inline/logical_line_builder.cc#355)
and [bottom-up closing code](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/layout/inline/inline_box_state.cc#461)
establish. Full deferred nested top/bottom and fixed-point semantics remain a separate gap.

| Oracle | Geometry | Measured fragments | Hits | Strict pixels |
|---|---|---|---|---|
| Middle metrics (180 states) | 120/180 → 180/180 | 60/120 → 120/120 | 138/180 → 147/180 | 75/180 → 78/180 |
| Nested alignment (72 states) | 52/72 → 66/72 | 43/72 → 57/72 | 57/72 → 63/72 | 0/72 → 0/72 |

Across 38 serial commands, 26 direct matrices contain 3,746 exact input-hash pairs:
no added/unmatched states or input mismatches. Root and independent audits agree.
geometry: 74 repairs, 0 regressions; hitDifferences: 15 repairs, 0 regressions; clientRectDifferences: 74 repairs, 0 regressions; pixels: 10 repairs, 7 regressions. Strict pixels require the viewport, container and every measured
named crop to meet the unchanged 3/255 MAE bound. Null crops and absent optional
reference maps are unmeasured. Direct geometry remains 0.125 CSS px.

| New case (six states each) | Geometry | Fragments | Hits | Strict pixels |
|---|---|---|---|---|
| direct_baseline_middle | 6/6 | 6/6 | 6/6 | 0/6 |
| direct_middle_length | 6/6 | 6/6 | 6/6 | 0/6 |
| direct_length_baseline | 6/6 | 3/6 | 6/6 | 0/6 |
| textless_baseline_middle | 6/6 | 6/6 | 6/6 | 0/6 |
| textless_middle_length | 6/6 | 6/6 | 6/6 | 0/6 |
| negative_leading | 6/6 | 6/6 | 6/6 | 0/6 |
| positive_leading | 6/6 | 0/6 | 6/6 | 0/6 |
| top_ancestor | 6/6 | 6/6 | 6/6 | 0/6 |
| bottom_ancestor | 6/6 | 6/6 | 6/6 | 0/6 |
| wrapped_lines | 6/6 | 6/6 | 6/6 | 0/6 |
| atomic_nested_child | 6/6 | 6/6 | 3/6 | 0/6 |
| empty_ancestor_following_text | 0/6 | 0/6 | 0/6 | 0/6 |

| Retained direct matrix | Geometry | Measured fragments | Hits | Strict pixels |
|---|---|---|---|---|
| middle-metrics | 180/180 | 120/120 | 147/180 | 78/180 |
| inline-source-order | 186/216 | 24/216 | 192/216 | 0/216 |
| pointer-geometry | 216/234 | 60/114 | 234/234 | 157/234 |
| inline-fragments | 192/363 | 177/363 | 264/363 | 0/363 |
| inline-fragment-effects | 102/102 | 60/102 | 102/102 | 0/102 |
| line-width-grid | 176/176 | unmeasured | 176/176 | 30/176 |
| line-width-effects | 76/76 | unmeasured | 76/76 | 45/76 |
| text-metric-grid | 432/432 | unmeasured | 420/432 | 48/432 |
| input-line-height | 504/504 | unmeasured | 504/504 | 134/504 |
| input-pointer | 264/264 | unmeasured | 264/264 | 13/264 |
| control-document-mode | 92/132 | unmeasured | 120/132 | 84/132 |
| control-layout | 132/264 | unmeasured | 264/264 | 0/264 |
| control-selection | 48/48 | unmeasured | 48/48 | 12/48 |
| control-focus | 252/252 | unmeasured | 252/252 | 164/252 |
| tables | 77/77 | unmeasured | 77/77 | 74/77 |
| table-document-mode | 12/12 | unmeasured | 12/12 | 12/12 |
| table-controls | 4/4 | unmeasured | 4/4 | 4/4 |
| table-integration | 22/30 | unmeasured | 24/30 | 23/30 |
| controls | 8/9 | unmeasured | 8/9 | 6/9 |
| scrolling | 148/148 | unmeasured | 148/148 | 148/148 |
| css-animations | 40/40 | unmeasured | 40/40 | 40/40 |
| intrinsic-text | 30/30 | unmeasured | 30/30 | 20/30 |
| font-weights | 20/36 | unmeasured | 36/36 | 16/36 |
| glyphs | 38/38 | unmeasured | 38/38 | 4/38 |
| borders | 7/7 | unmeasured | 7/7 | 0/7 |

The four compiled CPU/GPU table, forms and control runs retain all 389 semantic,
geometry and strict pixel passes. Compiler tests pass 297/297; Rust workspace
tests pass 122/122. Blitz paint passes 8/8 and HTML 3/3. Parley engine passes
39/39 and its libm check passes. All eight added alignment tests pass; the focused
style-metric suite passes 37/37. Blitz DOM retains 57 passes and its two existing
failures (hover_styles_apply_and_clear, scroll_by_clamps_and_bubbles).
Parley std retains 128 passes and the four existing fontless cluster-position
failures (start, end, center, justified alignment). These suites remain
failed as a whole. System-font default-feature tests and the unavailable named
/code-review stage remain incomplete; root and independent read-only reviews
are supplemental. Headless/internal probes do not establish OS keyboard,
pointer or IME delivery.

All implementation stays in one existing experimental worktree per repository.
The source heads below were clean and signed during capture. The original trees
are unchanged; no merge, push or milestone tag is part of this checkpoint.
Chromium is pinned to 153.0.8010.12 with the existing embedded font and lockfiles.
The Nix environment, offline wrapper, shared target and two Cargo jobs are reused.
All 958 evidence hashes across the six preceding records are preserved. The
140-file test-only Parley source mirror matches before and after testing;
task-owned temporary files are removed after review. Canonical and diagnostic
observations and baseline evidence remain retained and hashed.

| Source | Verified revision | Signature/state |
|---|---|---|
| RunicDesktopCompiler-tables | `f9977939f81e72390627a7c0e85ef089090c61ce` | G, clean |
| blitz-tables | `591b4aa1f210265ceca9aa8a6b2462e280807f07` | G, clean |
| parley-chromium-parity | `1e30efaa48fa782458f59bb044707429b031d8ed` | G, clean |
| stylo-chromium-parity | `f0e404e2daa6a5f6ed881e9cdb12e7a4ac375aa4` | G, clean |
| vello-raster-parity | `a8efce54ab03eb9d366ff0fe0d799758597b204f` | G, clean |

The [machine record](chromium-nested-alignment.json) contains independent gate
counts, command outcomes, source proofs and evidence hashes. Remaining work starts
with the seven new text-crop losses, empty-span participation and generic inline
margin/edge flow, then full fragment lists and the remaining hit/RTL/tab cases. The six empty-span geometry
failures and paint failures remain in the oracle. Expand deferred alignment
boundaries before claiming complete Chromium inline parity.
