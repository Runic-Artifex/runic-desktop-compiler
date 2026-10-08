# Chromium pointer geometry continuation (isolated, 2026-10-08)

Blitz now carries a private one-CSS-pixel pointer footprint through logical positioning, scrolling, clips and inverse affine transforms. Text uses primary-font hit bounds and accumulated-offset snapping; rounded contours intersect the transformed quad with corner ellipses. Public hit signatures, Parley metric defaults, caret geometry and renderer selection are preserved. This experimental checkpoint retains measured regressions and keeps the shipping contract unchanged.

The new oracle passes **234/234 standard hit states** and **216/234 explicit-point states**. Its original 150 states have identical input hashes: standard hits **111→150**, explicit points **93→147**, with no baseline-pass→fail gate. The other 84 states are new coverage, not paired improvements. All 12 narrow leading-gap failures from the previous continuation are repaired.

The retained inline matrices expose **81 passing-to-failing hit states**: main hits **270→258** (51 repairs, 63 losses), effects **87→93** (15 repairs, 9 losses), and text metrics **408→420** (21 repairs, 9 losses). The record retains every loss. No paired geometry, fragment-list, editor, scroll, computed-width or strict pixel gate regresses.

## Frozen sources and environment

One existing isolated worktree per repository; no merge or push. Original checkouts remain clean at the revisions in the [machine record](chromium-pointer-geometry.json). All five frozen heads have valid signatures. Parley, Stylo and Vello are unchanged in this continuation.

| Worktree                    | Frozen revision                            |
| --------------------------- | ------------------------------------------ |
| RunicDesktopCompiler-tables | `9e426bae61c42d26c33e325b790680e4a3279bbb` |
| blitz-tables                | `4b9e43bd53026bb9d1b39605e7821a1a26af48e6` |
| parley-chromium-parity      | `5a3e022364566223ab122cf26f1d770b6a1a7849` |
| stylo-chromium-parity       | `f0e404e2daa6a5f6ed881e9cdb12e7a4ac375aa4` |
| vello-raster-parity         | `a8efce54ab03eb9d366ff0fe0d799758597b204f` |

The compiler verification head is `9e426ba`; the subsequent record commit changes documentation only. Locked Chromium is 153.0.8010.12. All 23 direct matrices capture clean source snapshots, the same five heads, embedded font, Cargo lock and native binary hash. Builds use the locked Git-aware Nix environment, offline cargo wrapper, existing shared target and conservative jobs 2; matrices run serially. GPU checks use locked lavapipe/llvmpipe.

## Pointer and inline gates

Direct bounding/client geometry remains 0.125 CSS px; compiled geometry remains 2 CSS px. Strict pixels require viewport/container MAE and every measured named crop ≤3/255. No blur, altered references, removed cases or widened tolerances. Empty reference maps are unmeasured.

| Oracle         | States | Geometry | Fragment lists | Standard hits | Explicit points | Measured scroll | Strict pixels |
| -------------- | -----: | -------: | -------------: | ------------: | --------------: | --------------: | ------------: |
| Pointer        |    234 |  216/234 |         60/114 |       234/234 |         216/234 |            0/48 |       157/234 |
| Main inline    |    363 |  189/363 |        174/363 |       258/363 |               — |               — |         0/363 |
| Inline effects |    102 |  102/102 |         60/102 |        93/102 |               — |           54/54 |         0/102 |

Pointer explicit-point residuals are nine odd-height text-gap/layer states and nine negative-origin boundary states. Rotated text retains 18 geometry failures; transformed span lists retain 54 failures. All 48 relative-position scroll probes retain the existing 116×96 versus 120×100 extent difference. Positive-origin rounded controls, constrained oversized radii and eligible culled ancestors are included; their passing samples do not certify all rounded/inline behavior. Independent geometry and local pixels remain necessary.

All 108 font states now pass hits as well as geometry/lists, and all 30 vertical-alignment states pass hits while geometry remains 27/30. Nested hits are 18/30; margins 90/180; bidi 9/12. These improvements remain separate from the 81 hit regressions, which split by owner:

- **60 margin-line states:** ten LTR/RTL absolute, negative, percent, calc and auto families, steps 0/1 at three DPRs. The lower-right span sample hits the following block-owned text in Blitz. Inline margin/fragment flow remains a layout-owner gap; changing text priority or cropping whitespace would conceal it.
- **3 nested-small-child states:** step 1 at three DPRs. Blitz includes the text at a lower fragment edge/gap where Chromium targets the block. Child geometry remains within the existing tolerance.
- **9 effects states:** an eligible visible child under pointer-disabled/hidden/combined outer spans loses its lower-right target after mutation. This is child/culled-parent edge priority, not permission to suppress eligible inline ancestors.
- **9 text-metric marker states:** Arabic 14px at eighth origin and Latin 24px at eighth/fractional origins. At the exact trailing block edge, Blitz returns the block while Chromium returns an unlabelled ancestor. The native relative marker sample can lie slightly inside its parent; text advances/atomic placement and root/overflow intervals need their own reduction.

The machine record groups exact families, steps, DPRs and target differences; the ignored full audit retains every state. Relative samples use each engine’s own geometry, so toleranced geometry agreement does not prove exact hit-edge agreement.

## Retained direct and compiled checks

All 2, 579 retained direct states match the preceding input hashes. The text-metric nine hit losses above are the only regressions in these twenty suites. Table-control hits improve 2→4/4; their geometry/editor/scroll/pixels remain passing. Other measured gates preserve their passing states.

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

## Units, review and limits

Compiler/frontend 297/297; workspace Rust 122/122; Blitz paint 8/8 and HTML 3/3. Blitz DOM 57 pass, 2 unchanged failures: `hover_styles_apply_and_clear` and `scroll_by_clamps_and_bubbles`. Six new private geometry tests and the embedded-font small/large-gap probe pass. Unchanged Parley/Stylo focused and exact-source results are retained from the previous record, not rerun here.

Root and independent read-only agents reviewed the implementation and state transitions, including primary-font quantization, transform layer phases, rounded-radius constraints and eligible ancestors. The named `/code-review` tool remains unavailable; its stage is incomplete. Prior system-font Parley default-feature verification remains incomplete. Headless/internal probes do not establish desktop keyboard, pointer or IME delivery.

## Next bounded batches

1. **Text provenance and fragment targeting in Blitz.** Preserve construction-time normalized text-range to DOM text-node/inline ancestry records before deriving first/previous-sibling boundary rules. A brush owner is already a span, not Chromium’s actual text object. Reduce exact trailing block edges, nested lower fragment boundaries and eligible child versus culled-parent priority using shared logical fragment regions. Preserve the 18 eligible-ancestor states; ineligible leaves can still have eligible inline ancestors. Do not substitute a whole-line area for text bounds.
2. **Generic span-edge flow in Parley, CSS binding in Blitz.** Freeze owner/start/end ordering and direction semantics before adding an additive advance API. Preserve public positioned-item exhaustive matches and no-edge defaults. Cover pending whitespace, nested/empty spans, negative advances, intrinsic measurement and break replay; CSS percentages/calc/auto belong in Blitz. First/last wrapped fragments own the edges, and own margins stay outside own border/hit regions. Require the 60 margin losses and 132 omitted-margin control states to improve with geometry and pointer gates together.
3. **Remaining hit/DOM geometry.** Keep odd-height text gaps, negative viewport boundaries, inverse-transform clips, transformed fragment lists and relative-position scroll extents as separate exact-point/DOM gates. Fragment count/order and bidi segmentation cannot be inferred from bounding unions.
4. **Paint/editor/cost.** Preserve local glyph and outline gates; fix flattened hidden-descendant paint in Blitz paint. Selected-text/RTL interaction, native theme paint and font-instance ordering retain their owners. Measure run/style scans before caching, with explicit refresh and intrinsic-clone invalidation.

The [architecture checkpoint](../../docs/ARCHITECTURE.md#chromium-parity-pointer-footprint-2026-10-08-isolated) defines the private geometry boundary; the [targeted plan](../../docs/research/CHROMIUM-PARITY.md) tracks integration gates. Compiler inline `getClientRects()` acceptance and the shipping contract are unchanged.

## Evidence and cleanup

The [machine record](chromium-pointer-geometry.json) hashes canonical command logs, results, metadata, paired baselines and root/independent audit proofs. The previous 459 line-width/text-metric/inline-fragment evidence hashes were rechecked unchanged. The earlier source attempt and initial fontless helper failure remain failures, not passes. Canonical verification paused after 14 completed commands for a root-only hypothesis; it reduced main hits 258→255 and was removed. The exact original source and native binary were restored before the remaining 18 commands resumed; no result was reused across a source version.

Task-owned temporary profile/scripts and disposable duplicate screenshots are removed after their consumers finish. Final and paired baseline observations, useful screenshots, logs and proofs remain under ignored `artifacts/`; original trees, shared caches and store generations are retained. No task-owned native server/window is intentionally left running.
