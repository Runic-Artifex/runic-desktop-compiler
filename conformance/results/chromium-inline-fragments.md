# Chromium inline fragments continuation (isolated, 2026-10-08)

Parley now exposes each style’s first-font content bounds at its aligned baseline. Blitz expands those bounds for vertical padding/borders and shares them between DOM geometry and pointer targeting. Positioned text runs, rather than caret line selection, supply hit candidates. Font content below a short line contributes to scroll height; the synthetic empty line after a terminal break does not. Caret geometry and public metric defaults retain their existing behavior.

All 108 font-size/line-height/wrapping/mutation states match bounding rectangles and fragment lists. The complete 363-state oracle improves bounding geometry **15→189**, fragment lists **15→174**, and hits **231→270**. It repairs 51 hit failures and introduces **12 leading-gap hit failures**; these remain visible, with unchanged tolerances. Margins and full Chromium inline behavior are not certified.

## Sources and environment

One existing isolated worktree per repository; no merge or push. Original checkouts remain clean at the revisions in the [machine record](chromium-inline-fragments.json). All five verification heads have valid signatures. Stylo and Vello are unchanged in this continuation.

| Worktree                    | Frozen revision                            |
| --------------------------- | ------------------------------------------ |
| RunicDesktopCompiler-tables | `e645e0bb5d310f2a0fe01df1083d3d964986361f` |
| blitz-tables                | `2191d55414d73f5dccb5c534df6c1462cc486088` |
| parley-chromium-parity      | `5a3e022364566223ab122cf26f1d770b6a1a7849` |
| stylo-chromium-parity       | `f0e404e2daa6a5f6ed881e9cdb12e7a4ac375aa4` |
| vello-raster-parity         | `a8efce54ab03eb9d366ff0fe0d799758597b204f` |

The compiler source is `e645e0b`; the subsequent record commit changes documentation only. Locked Chromium is **153.0.8010.12**, with the same embedded font and Cargo lock hashes as the previous record. All 22 direct matrices record clean source snapshots and the same native binary hash. Builds are offline and serialized through the existing shared target and wrapper. GPU verification uses locked lavapipe/llvmpipe, not an unverified hardware adapter.

## New direct reductions

Bounding and client-rect geometry remain **0.125 CSS px**; compiled geometry is **2 CSS px**. Pixel acceptance requires container MAE ≤3/255 and **every measured named crop** ≤3/255. No blur, dropped cases, altered references or widened tolerances.

| Oracle                                   | States | Bounding geometry | Fragment lists | Hits | Measured scroll | Strict pixels |
| ---------------------------------------- | -----: | ----------------: | -------------: | ---: | --------------: | ------------: |
| Main, before                             |    363 |                15 |             15 |  231 |               — |             0 |
| Main, after                              |    363 |               189 |            174 |  270 |               — |             0 |
| Whitespace/visibility/clip/break effects |    102 |               102 |             60 |   87 |           54/54 |             0 |

The main baseline has identical HTML hashes, state ordering, actions and gates. Terminal `<br>` and preserved-newline reductions are paired separately: scroll matches **0→36/36**, hits **12→36/36**. The earlier 66-state supplemental reduction had nine measured short-line scroll failures; all are repaired. The other 48 supplemental states have no scroll probe. Neither new oracle contains editable controls; empty editor/scroll/computed-width maps count as unmeasured in this record.

The main groups retain these independent totals:

| Group                       | States | Bounding geometry | Fragment lists | Hits |
| --------------------------- | -----: | ----------------: | -------------: | ---: |
| Font sizes/line heights     |    108 |               108 |            108 |   96 |
| Vertical alignment          |     30 |                27 |             27 |    6 |
| Nested spans/atomic content |     30 |                24 |             24 |    9 |
| Margins                     |    180 |                24 |             15 |  150 |
| Bidi                        |     12 |                 6 |              0 |    6 |
| Horizontal decorations      |      3 |                 0 |              0 |    3 |

All **465 new local pixel gates fail**. Whole-viewport/container averages cannot certify these glyph regions. Visibility hit checks pass in the targeted cases, but the flattened inline paint path still draws hidden descendant text. The font-content overflow policy is based on metrics, not the ink of fallback fonts or stacked combining marks.

## Retained direct and compiled checks

All **2,579 retained direct states** match their previous input hashes and state ordering. No previously passing geometry, hit, editor, scroll, computed-width or strict pixel gate regresses. Font-weight geometry improves **12→20/36** and hits **28→36/36**; this is a bounds/hit repair, not a new font matching or optical-sizing implementation. Every remaining control-layout geometry failure is solely the omitted 8px `#text` margin: y, height and width now match in all 132 affected states.

Optional editor/scroll columns below count only states with measured reference entries; “—” is unmeasured. The older records sometimes counted empty-map matches in their state totals. Retained suites have no tagged client-rect list probes. Eight width-suite and two scrolling named crops are offscreen/unmeasured; available crops retain the same gates.

| Oracle                | States | Geometry | Hits |  Editor |  Scroll | Strict pixels |
| --------------------- | -----: | -------: | ---: | ------: | ------: | ------------: |
| line-width-effects    |     76 |       76 |   76 |       — |       — |            45 |
| line-width-grid       |    176 |      176 |  176 | 176/176 |       — |            30 |
| text-metric-grid      |    432 |      432 |  408 | 384/384 |       — |            48 |
| input-line-height     |    504 |      504 |  504 | 504/504 |       — |           134 |
| input-pointer         |    264 |      264 |  264 | 231/264 |       — |            13 |
| control-document-mode |    132 |       92 |  120 |   48/48 |   24/24 |            84 |
| control-layout        |    264 |      132 |  264 | 264/264 |       — |             0 |
| control-selection     |     48 |       48 |   48 |   48/48 |       — |            12 |
| control-focus         |    252 |      252 |  252 | 252/252 |       — |           164 |
| tables                |     77 |       77 |   77 |       — |       — |            74 |
| table-document-mode   |     12 |       12 |   12 |       — |       — |            12 |
| table-controls        |      4 |        4 |    2 |     4/4 |     4/4 |             4 |
| table-integration     |     30 |       22 |   24 |     8/8 |   12/12 |            23 |
| controls              |      9 |        8 |    8 |     6/6 |     2/2 |             6 |
| scrolling             |    148 |      148 |  148 |       — | 140/140 |           148 |
| css-animations        |     40 |       40 |   40 |       — |       — |            40 |
| intrinsic-text        |     30 |       30 |   30 |       — |       — |            20 |
| font-weights          |     36 |       20 |   36 |       — |       — |            16 |
| glyphs                |     38 |       38 |   38 |       — |       — |             4 |
| borders               |      7 |        7 |    7 |       — |       — |             0 |

All **389 compiled states** pass semantics, geometry and local pixels:

| Compiled suite      | Runs | States | Maximum viewport/named MAE |
| ------------------- | ---: | -----: | -------------------------: |
| tables-cpu          |    6 |     96 |                      1.270 |
| tables-gpu          |    2 |     32 |                      2.396 |
| forms-focus         |   22 |    242 |                      0.388 |
| control-regressions |    7 |     19 |                      0.594 |

## Unit checks and review

Compiler/frontend tests **297/297**; workspace Rust **121/121**; Blitz paint **8/8**, HTML **3/3**, Stylo policy **1/1**. New Parley focused tests **3/3**; exact-source std tests **110 pass, 4 known fontless failures**; libm check passes. Blitz DOM remains **51 pass, 2 known failures** (`hover_styles_apply_and_clear`, `scroll_by_clamps_and_bubbles`). The four Parley cluster tests assume system fonts and do not register a test font.

The Parley harness matches **148 source files** at `5a3e022`; its pruned lock introduces no package/version/source tuple. The project shell lacks fontconfig pkg-config metadata, so default system-font feature tests remain incomplete. `/code-review` is unavailable; root and independent read-only agent reviews completed, including the terminal-line correction and pointer paint order. That substitute does not mark the named review stage passed. Internal events do not establish OS keyboard, pointer or IME delivery.

## Remaining work, in owner order

1. **Shared pointer geometry in Blitz.** Preserve the 12 new font/bidi leading-gap losses, 15 supplemental wrap hits, tiny marker and rounded-button cases. Derive the physical fragment intersection and pixel-enclosure rules from pinned Chromium; carry the point footprint through scrolling, clips and inverse transforms. Large leading-gap controls must remain misses. A whole-line hit area contradicts those controls. [Chromium hit location](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/third_party/blink/renderer/core/layout/hit_test_location.cc), [culled inline targeting](https://raw.githubusercontent.com/chromium/chromium/153.0.8010.12/third_party/blink/renderer/core/layout/layout_inline.cc).
2. **Generic span edges in Parley.** Define explicit owner/start/end advances with stable ordering alongside atomic items. Include intrinsic measurement, soft-break lookahead/replay, negative widths, empty spans and pending whitespace. Zero/no advances preserve defaults. Expose a separate positioned-edge iterator; adding a public `PositionedLayoutItem` variant would break exhaustive matches. Freeze CSS span direction versus glyph bidi before claiming bidi margins.
3. **CSS binding and fragment ownership in Blitz.** Resolve definite percentages from the inline context’s content width (5% of 320px is 16px), cover indefinite intrinsic queries, and bind only non-atomic flow spans. First/last wrapped fragments own start/end edges. Own margins affect flow but stay outside own border rects/hits; ancestor content can include a descendant advance. Require absolute/negative/percent/calc/auto, empty, nested, mixed-direction, width/font/margin/scale mutation cases before promoting support.
4. **Fragment lists and alignment.** Replace one union per line with the necessary bidi/culled/nested segmentation; retain zero-width newline and preserved trailing-space fragments. Repair `middle`’s 0.296875px error and nested shifts in the metric/alignment owner. Geometry consumers must not independently compensate positions.
5. **Paint and cost.** Fix flattened descendant visibility in Blitz paint, then preserve the glyph/outline raster reductions. Profile run/style scans before adding a cache, with explicit invalidation for font/style/width/scale refresh and intrinsic-query clones. Editor interaction, native theme paint and font-instance ordering remain separate work.

The [architecture checkpoint](../../docs/ARCHITECTURE.md#chromium-parity-inline-font-content-bounds-2026-10-08-isolated) preserves the module boundary; the [targeted plan](../../docs/research/CHROMIUM-PARITY.md) ranks the next patches. Compiler inline `getClientRects()` acceptance is not broadened, and the integrated shipping contract is unchanged.

## Evidence and cleanup

The [machine record](chromium-inline-fragments.json) hashes all command logs, paired/final results and metadata, the exact-source harness proof, and the independent audit. The previous 121 line-width and 118 text-metric evidence hashes were rechecked unchanged. Initial malformed actions, the temporary font-path cache failure and the corrected top/bottom subtree test are retained as failures, not counted as passes.

Temporary test sources and intermediate duplicate screenshots are removed after their consumers finish. Only the test helper `parley_dev`, which embeds the temporary font path, is cleaned from the shared target; no broad cache/store cleanup occurs. Final and paired baseline observations, useful screenshots, logs and proof files remain under ignored `artifacts/`. No native server/window is intentionally left running.
