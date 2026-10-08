# Chromium inline source ordering (isolated, 2026-10-08)

Parley now optionally records normalized UTF-8 ranges with opaque source identities, without adding shaping or style boundaries. Blitz uses these records in a private reverse inline-fragment hit walk, preserving complete shaping atoms, eligible ancestors and per-line span regions. A conservative line gate includes content overflow and glyph ink without making ink a hit target. Public Blitz hit signatures, renderer selection, Parley's existing builder behavior and its device metric default are preserved.

The new oracle passes **192/216 standard hit states**, **18/18 explicit-point states** and **186/216 bounding geometry states**. Its original 144 states have identical input hashes: standard hits **78→132**, with 54 repairs and no passing-to-failing gate. The other 72 states are new coverage. Across all paired direct matrices this checkpoint repairs **69 standard-hit states and three explicit-point states**, and introduces **three `vertical-align:middle` hit failures**. Every paired non-hit gate preserves its passing states. These failures remain in the record; this is not complete inline or Chromium parity.

## Frozen sources and module boundaries

One existing isolated worktree per repository; no merge or push. Original checkouts remain unchanged. Frozen heads have valid signatures:

| Worktree                    | Frozen revision                            |
| --------------------------- | ------------------------------------------ |
| RunicDesktopCompiler-tables | `a508d21a25b5c2566d66c3ee33ac200bbf22039c` |
| blitz-tables                | `9fc666f9e3362b3776222365822a76de2b48355a` |
| parley-chromium-parity      | `6d72db47a9f3e02cb879f7d9d132863fad23eca0` |
| stylo-chromium-parity       | `f0e404e2daa6a5f6ed881e9cdb12e7a4ac375aa4` |
| vello-raster-parity         | `a8efce54ab03eb9d366ff0fe0d799758597b204f` |

The compiler verification head is `a508d21`; the subsequent record commit changes documentation only. Stylo and Vello are unchanged. Locked Chromium is 153.0.8010.12. All 24 direct matrices capture clean snapshots of the same five heads, embedded font, Cargo lock and native binary. Offline builds use the locked Git-aware Nix environment, the cargo wrapper, the existing shared target and jobs 2; matrices run serially. GPU checks use locked lavapipe/llvmpipe.

Parley's additive `push_text_with_source` / `build_into_with_sources` API reports nonempty, sorted, half-open byte ranges after normalization. Untagged text leaves gaps; removed whitespace produces no record. A pending collapsed space retains the first contributing source. `GlyphRun::text_range` reports the run's actual source range. Source identities are metadata only: tests compare text, styles and positioned glyphs against untagged builds, including UTF-8 splits, whitespace modes, ligatures and bidi. Rebuilding resets the metadata.

Blitz alone interprets source identities as DOM text objects. `inline_hit.rs` groups ligature continuations before ordering fragments, checks snapped primary-font leaf bounds, then considers eligible culled ancestors. Same-object and sibling/defer rules use actual text provenance rather than brush ownership. Parent extent is a contiguous per-line group, not a whole paragraph rectangle. In-flow atomic fragments participate in ordering/parent extent; their own child hits still use the existing traversal. Out-of-flow boxes do not supply flow extent. The format root falls back through its ordinary block hit region.

Line culling conservatively includes the line box, font-content overflow and outward-rounded glyph ink. Unknown bounds, synthesized fonts, decorations, shadows and atomic content bypass culling. This is not a complete Blink paint-ink-overflow model. Source ownership, hit geometry and glyph paint remain separate concerns. The [architecture checkpoint](../../docs/ARCHITECTURE.md#chromium-parity-text-provenance-2026-10-08-isolated) records the interface and limits.

## Direct gates

Direct bounding/client geometry remains 0.125 CSS px; compiled geometry remains 2 CSS px. Strict pixels require viewport/container MAE and every measured named crop ≤3/255. Empty reference maps are unmeasured. No blur, rewritten reference, removed case or widened tolerance.

| Oracle          | States | Geometry | Fragment lists | Standard hits | Explicit points | Measured scroll | Strict pixels |
| --------------- | -----: | -------: | -------------: | ------------: | --------------: | --------------: | ------------: |
| Source ordering |    216 |  186/216 |         24/216 |       192/216 |           18/18 |               — |         0/216 |
| Pointer         |    234 |  216/234 |         60/114 |       234/234 |         219/234 |            0/48 |       157/234 |
| Main inline     |    363 |  189/363 |        174/363 |       261/363 |               — |               — |         0/363 |
| Inline effects  |    102 |  102/102 |         60/102 |       102/102 |               — |           54/54 |         0/102 |

The retained nested-small-child cases repair six hits, including all three new losses from the previous checkpoint. All nine eligible-child/culled-parent losses in the effects matrix are repaired. Three `text_gap_25_none` explicit-point states are repaired; all 18 eligible-ancestor controls and the previous 12 leading-gap repairs stay passing.

The three new middle failures are at DPR 1/1.25/2. Native span position and table height still differ by **0.296875 CSS px**, exactly as before this hit change. Chromium's lower-right span sample falls at y=44.875; the native relative sample is at y=45.171875. The following root-owned text has a snapped bottom of 45. The old forward walk admitted a raw root-font box ending at 45.375, masking the position error. The new walk exposes it. Retain geometry and hit failures together and repair the metric source; do not restore that accidental parent target region.

Of the previous checkpoint's 81 new hit losses, 12 are repaired and 69 remain: 60 margin-flow states and nine tiny trailing marker edges. The new three middle losses are additional. Relative probes use each engine's own geometry, so toleranced geometry agreement is not exact edge equivalence.

The new source-order oracle retains 24 hit failures: twelve preserved-tab states, six RTL atomic states and six narrowed RTL wrap states. Its 30 geometry failures are eighteen preserved-tab and twelve narrowed RTL wrap states. Split ligature/combining, ordinary bidi, whitespace collapse, absolute descendants and DOM replacement cases are included. Passing samples do not certify arbitrary bidi isolates, atomic overlap or all source seams. Every new strict pixel gate still fails; normalized source metadata does not fix paint or fragment segmentation.

## Retained verification

All 3,278 states in the 23 retained direct matrices have identical input hashes. With the 144 original source-order states there are **3,422 exact pairs**, plus **72 after-only states**, for **3,494 final direct states**. No pair is discarded or mismatched. The machine record gives each suite's measured geometry, hit, fragment, editor, scroll, computed-width and pixel counts, including every remaining failure.

| Oracle                | States | Geometry |    Hits |  Editor |  Scroll | Strict pixels |
| --------------------- | -----: | -------: | ------: | ------: | ------: | ------------: |
| line-width-grid       |    176 |  176/176 | 176/176 | 176/176 |       — |        30/176 |
| line-width-effects    |     76 |    76/76 |   76/76 |       — |       — |         45/76 |
| text-metric-grid      |    432 |  432/432 | 420/432 | 384/384 |       — |        48/432 |
| input-line-height     |    504 |  504/504 | 504/504 | 504/504 |       — |       134/504 |
| input-pointer         |    264 |  264/264 | 264/264 | 231/264 |       — |        13/264 |
| control-document-mode |    132 |   92/132 | 120/132 |   48/48 |   24/24 |        84/132 |
| control-layout        |    264 |  132/264 | 264/264 | 264/264 |       — |         0/264 |
| control-selection     |     48 |    48/48 |   48/48 |   48/48 |       — |         12/48 |
| control-focus         |    252 |  252/252 | 252/252 | 252/252 |       — |       164/252 |
| tables                |     77 |    77/77 |   77/77 |       — |       — |         74/77 |
| table-document-mode   |     12 |    12/12 |   12/12 |       — |       — |         12/12 |
| table-controls        |      4 |      4/4 |     4/4 |     4/4 |     4/4 |           4/4 |
| table-integration     |     30 |    22/30 |   24/30 |     8/8 |   12/12 |         23/30 |
| controls              |      9 |      8/9 |     8/9 |     6/6 |     2/2 |           6/9 |
| scrolling             |    148 |  148/148 | 148/148 |       — | 140/140 |       148/148 |
| css-animations        |     40 |    40/40 |   40/40 |       — |       — |         40/40 |
| intrinsic-text        |     30 |    30/30 |   30/30 |       — |       — |         20/30 |
| font-weights          |     36 |    20/36 |   36/36 |       — |       — |         16/36 |
| glyphs                |     38 |    38/38 |   38/38 |       — |       — |          4/38 |
| borders               |      7 |      7/7 |     7/7 |       — |       — |           0/7 |

All 389 compiled states pass semantics, geometry and local pixels:

| Compiled suite      | Runs | States | Maximum viewport/named MAE |
| ------------------- | ---: | -----: | -------------------------: |
| tables-cpu          |    6 |     96 |                      1.270 |
| tables-gpu          |    2 |     32 |                      2.396 |
| forms-focus         |   22 |    242 |                      0.388 |
| control-regressions |    7 |     19 |                      0.594 |

Compiler/frontend **297/297**, workspace Rust **122/122**, Blitz paint **8/8**, HTML **3/3**. Blitz DOM has **57 pass / two unchanged failures** (`hover_styles_apply_and_clear`, `scroll_by_clamps_and_bubbles`). Exact-source Parley std has **117 pass / four unchanged fontless cluster-position failures**; its seven new source/normalizer/shaping tests pass. The libm check passes. Test-only Parley manifest/lock and hashes of 139 mirrored source files are retained; no separate target or worktree was created.

Root and independent agents reviewed source interfaces, normalization, complete shaping atoms, fragment ordering, line culling and paired measurements. The named `/code-review` tool remains unavailable, so that stage is incomplete. System-font Parley default-feature verification remains incomplete. Headless/internal probes do not establish desktop pointer, keyboard or IME delivery.

## Next bounded batches

1. **Primary metrics and middle alignment.** Record the first font's unrounded and used ascent/descent/x-height, the parent-relative shift and the line extents against pinned Chromium/Skia font metrics. Check the provider when `OS/2.sxHeight` is absent and Chromium's rounding of half the x-height. The pinned [Blink middle formula](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/layout/inline/inline_box_state.cc#1319) and [Skia FreeType x-glyph synthesis](https://skia.googlesource.com/skia/+/9d07e5bad9e3e21da2426946e589daa647218271/src/ports/SkFontHost_FreeType.cpp#1623) identify a candidate provider difference; the effective browser backend and actual font metrics still need diagnostic evidence. Correct a proven difference in the font/layout owner, preserving Device defaults and unquantized behavior. Require the three middle geometry/hit failures to improve together, then expand font-size, origin, scale, nested and atomic controls.
2. **Generic span edges in Parley, CSS binding in Blitz.** Freeze owner/start/end ordering and direction semantics before adding opt-in advances. Preserve positioned-item exhaustive matches and no-edge defaults. Cover pending/removed whitespace, empty/nested owners, negative advances, intrinsic queries, wrapping and replay; bind percentage/calc/auto CSS lengths in Blitz. First/last wrapped fragments own edges; margins stay outside their owner's hit/border regions. Require the 60 margin hit losses and 132 omitted-margin control states to improve with geometry.
3. **Remaining fragment and pointer reductions.** Keep tiny trailing marker boundaries, preserved tabs, narrowed RTL wraps, RTL atomic flow, `display:contents`/empty siblings and complex bidi/ligature seams as separate reductions. DOM sibling heuristics still differ from an exact layout-object tree. Transformed/overlapping atomic children and full fragment-list count/order are not certified by this private text traversal. Preserve eligible ancestors, large gaps and negative-origin point cases.
4. **Paint, editor and cost.** Repair flattened hidden-descendant paint and independent local glyph/theme/raster failures in their owners. Retain selection/RTL and document-mode gates. Profile the font-outline lookup and per-line parent scans on a hot miss path before caching; specify refresh and intrinsic-clone invalidation if a cache is justified.

The [targeted plan](../../docs/research/CHROMIUM-PARITY.md) tracks integration gates. Compiler inline `getClientRects()` acceptance and the shipping contract are unchanged.

## Evidence and cleanup

The [machine record](chromium-inline-source-order.json) hashes canonical logs, results, metadata, exact baselines and audit/source proofs. Root and independent checks revalidated all **579** hashes in the four preceding records. Initial direct dependency-test invocation failures remain failed setup attempts; the exact-source test mirror resolved them. The first and second source-order iterations and focused nested/effects/gap checks remain separate from frozen verification. No source was changed during the final 35-command batch.

Task-owned temporary profile, source mirror and helpers are removed after their consumers finish. Canonical and paired observations, useful screenshots, logs and proofs remain under ignored `artifacts/`; original trees, shared caches and store generations are preserved. No merge or push.
