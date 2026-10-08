# Chromium primary-font middle alignment (isolated, 2026-10-08)

The three retained `vertical-align:middle` failures now pass **geometry, fragment rectangles and hits together** at DPR 1, 1.25 and 2. The native displacement of 0.296875 CSS px is gone. Parley now supplies the missing primary-font x-height from a hinted x contour in its existing logical metric mode. Hit testing consumes the corrected layout; no hit-order or target-region exception was added.

Across **3,674 exact before/after direct states**, this checkpoint repairs **123 bounding geometry, 63 fragment-list, nine standard-hit and 45 strict pixel states**, with no passing-to-failing gate. All **389 compiled states** retain their semantic, geometry and strict pixel gates. Remaining failures are recorded below; this is not full Chromium parity.

## Metric evidence and module boundary

The exact decoded fixture font is OS/2 version 1, so it has no declared `sxHeight`. Its unhinted x bounds are y=0–1120 at 2048 units/em. Chromium's independent CSS `1ex` diagnostic reports:

| CSS font size |  12 |  16 |  20 |  24 |  32 |
| ------------- | --: | --: | --: | --: | --: |
| Used x-height |   7 |   9 |  11 |  14 |  18 |

Pinned Linux Chromium creates this conventional web font through [Fontations](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/platform/fonts/web_font_typeface_factory.cc#47). When the declared metric is absent, [Skia measures a hinted x contour](https://skia.googlesource.com/skia/+/9d07e5bad9e3e21da2426946e589daa647218271/src/ports/SkTypeface_fontations.cpp#461). Its [default normal automatic hinting configuration](https://skia.googlesource.com/skia/+/9d07e5bad9e3e21da2426946e589daa647218271/src/ports/fontations/src/hinting.rs#42) reproduces all five observed values in an exact-font Skrifa probe. Raw bounds with simple rounding do not: 24px would become 13 rather than 14. Blink [preserves the nonzero x-height](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/platform/fonts/simple_font_data.cc#145) and rounds the half-height to its layout grid when applying middle alignment.

The additive `parley_engine::FontMetrics::synthesize_x_height` owns parsing, variation resolution and hinted contour measurement. Parley's enabled logical policy calls it only when the first available font lacks a declared x-height, measures at the unscaled font size, and scales the result once. A cache local to that resolution reuses identical font/size/variation measurements. Invalid fonts, missing/notdef mappings, empty outlines and unusable heights retain the legacy estimate.

Declared OS/2/MVAR metrics take precedence. Default Device mode and disabled quantization preserve their previous layout behavior. Public shaped-run metrics still report the font's declared optional value; synthesis does not mutate shaping, glyphs, the public metric structure or renderer selection. No dependency upgrade, new font asset, framework branch or IR change was needed. The [architecture checkpoint](../../docs/ARCHITECTURE.md#chromium-parity-missing-primary-font-x-height-2026-10-08-isolated) records this boundary. This policy is verified against the locked Linux web-font configuration, not every platform's hinting settings.

## Frozen sources

One existing isolated experimental worktree per repository; originals and legacy worktrees are preserved. All five frozen heads have valid signatures. Compiler verification ran at `e6b482f`; the later record commit changes documentation only. Blitz, Stylo and Vello are unchanged in this checkpoint.

| Repository | Verification revision                      |
| ---------- | ------------------------------------------ |
| Compiler   | `e6b482f8e9d3126fda27019ec822069b8f052565` |
| Blitz      | `9fc666f9e3362b3776222365822a76de2b48355a` |
| Parley     | `1b7146f09693d7dcb12dcc1bd5878b1a62232ab0` |
| Stylo      | `f0e404e2daa6a5f6ed881e9cdb12e7a4ac375aa4` |
| Vello      | `a8efce54ab03eb9d366ff0fe0d799758597b204f` |

All 25 direct matrices captured clean snapshots of these heads and the same font, Cargo lock, native binary and Chromium 153.0.8010.12. Verification reused the locked Git-aware Nix environment, offline cargo wrapper, shared main target and jobs 2, serially. GPU checks use lavapipe/llvmpipe. No merge, push or milestone tag was created.

## Direct gates

The new oracle covers five root font sizes, integral/fractional origins, text/atomic/nested middle alignment, three DPRs and a font-size mutation: **180 exact paired states**. The 3,494 retained direct states also have identical input hashes. Bounding/client geometry remains 0.125 CSS px; compiled geometry remains 2 CSS px. Strict pixels require viewport/container and every measured named crop MAE ≤3/255. Empty reference maps are unmeasured. No case, tolerance or reference was changed to manufacture a pass.

| New group | States | Geometry | Standard hits | Strict pixels |
| --------- | -----: | -------: | ------------: | ------------: |
| Text      |     60 |    60/60 |         60/60 |         29/60 |
| Atomic    |     60 |    60/60 |         33/60 |         31/60 |
| Nested    |     60 |     0/60 |         45/60 |         15/60 |
| Total     |    180 |  120/180 |       138/180 |        75/180 |

Measured fragment lists improve **0→60/120**; atomic cases do not request them. Geometry improves **0→120/180**, hits **132→138/180** and strict pixels **30→75/180**. All six new-oracle hit repairs are text cases. The original three repairs raise main inline geometry **189→192/363**, fragment lists **174→177/363** and hits **261→264/363**. Its strict pixel gate remains 0/363. Every other retained direct gate preserves its result.

| Retained oracle         | States | Geometry | Fragment lists |    Hits |  Points |  Editor |  Scroll |  Widths | Strict pixels |
| ----------------------- | -----: | -------: | -------------: | ------: | ------: | ------: | ------: | ------: | ------------: |
| inline-source-order     |    216 |  186/216 |         24/216 | 192/216 |   18/18 |       — |       — |       — |         0/216 |
| pointer-geometry        |    234 |  216/234 |         60/114 | 234/234 | 219/234 |       — |    0/48 |       — |       157/234 |
| inline-fragments        |    363 |  192/363 |        177/363 | 264/363 |       — |       — |       — |       — |         0/363 |
| inline-fragment-effects |    102 |  102/102 |         60/102 | 102/102 |       — |       — |   54/54 |       — |         0/102 |
| line-width-grid         |    176 |  176/176 |              — | 176/176 |       — | 176/176 |       — | 176/176 |        30/176 |
| line-width-effects      |     76 |    76/76 |              — |   76/76 |       — |       — |       — |   76/76 |         45/76 |
| text-metric-grid        |    432 |  432/432 |              — | 420/432 |       — | 384/384 |       — |       — |        48/432 |
| input-line-height       |    504 |  504/504 |              — | 504/504 |       — | 504/504 |       — |       — |       134/504 |
| input-pointer           |    264 |  264/264 |              — | 264/264 |       — | 231/264 |       — |       — |        13/264 |
| control-document-mode   |    132 |   92/132 |              — | 120/132 |       — |   48/48 |   24/24 |       — |        84/132 |
| control-layout          |    264 |  132/264 |              — | 264/264 |       — | 264/264 |       — |       — |         0/264 |
| control-selection       |     48 |    48/48 |              — |   48/48 |       — |   48/48 |       — |       — |         12/48 |
| control-focus           |    252 |  252/252 |              — | 252/252 |       — | 252/252 |       — |       — |       164/252 |
| tables                  |     77 |    77/77 |              — |   77/77 |       — |       — |       — |       — |         74/77 |
| table-document-mode     |     12 |    12/12 |              — |   12/12 |       — |       — |       — |       — |         12/12 |
| table-controls          |      4 |      4/4 |              — |     4/4 |       — |     4/4 |     4/4 |       — |           4/4 |
| table-integration       |     30 |    22/30 |              — |   24/30 |       — |     8/8 |   12/12 |       — |         23/30 |
| controls                |      9 |      8/9 |              — |     8/9 |       — |     6/6 |     2/2 |       — |           6/9 |
| scrolling               |    148 |  148/148 |              — | 148/148 |       — |       — | 140/140 |       — |       148/148 |
| css-animations          |     40 |    40/40 |              — |   40/40 |       — |       — |       — |       — |         40/40 |
| intrinsic-text          |     30 |    30/30 |              — |   30/30 |       — |       — |       — |       — |         20/30 |
| font-weights            |     36 |    20/36 |              — |   36/36 |       — |       — |       — |       — |         16/36 |
| glyphs                  |     38 |    38/38 |              — |   38/38 |       — |       — |       — |       — |          4/38 |
| borders                 |      7 |      7/7 |              — |     7/7 |       — |       — |       — |       — |           0/7 |

| Compiled oracle     | States | Maximum viewport/named MAE |
| ------------------- | -----: | -------------------------: |
| tables-cpu          |     96 |                      1.270 |
| tables-gpu          |     32 |                      2.396 |
| forms-focus         |    242 |                      0.388 |
| control-regressions |     19 |                      0.594 |

## Verification and remaining work

All 37 commands completed. Compiler tests pass **297/297**, Rust workspace **122/122**, Blitz paint **8/8**, Blitz HTML **3/3** and Parley engine **39/39**, including six new fallback/invalid-font/variation tests. All 29 focused style-metric tests pass, including three new logical scaling, declared-metric and Device/unquantized compatibility tests. Parley's libm build passes. The exact-source test-only mirror has 139 matching source files; its manifest and lock are retained as evidence, not a new checkout or target.

Blitz DOM remains **57 passed, two known failures** (`hover_styles_apply_and_clear`, `scroll_by_clamps_and_bubbles`). Parley std remains **120 passed, four known fontless cluster-position failures**. These stages remain failed. The named `/code-review` tool is unavailable, so that stage is incomplete; root and bounded independent reviews do not close it. System-font default-feature tests and desktop keyboard/pointer/IME delivery remain incomplete. Internal and headless probes do not establish OS delivery.

The root and independent audits agree on all pairs, gate counts and transitions. All **765 evidence hashes** from the five preceding records remain unchanged. Frozen screenshots, observations and reports are retained under ignored artifacts; duplicate iteration screenshots and task-owned temporary harness/profile/font files are removed after their consumers finish. Shared caches and source are preserved. The [machine record](chromium-middle-metrics.json) supplies commands, hashes, diagnostics, source checks and every measured gate.

The next useful slice is **per-line nested alignment in Parley**. Source tracing suggests Blink aligns an outer middle box after uniting shifted descendant metrics, whereas Parley precomputes its shift from the own box before line participation is known. The new nested cases retain 0.25–1 CSS px errors across DPR. This needs a generic bottom-up aligned-subtree calculation, with direct-text, empty ancestor, wrapping, negative leading and top/bottom controls; a root/hit exception would hide the seam.

Then close generic span-edge/CSS margin flow (60 preceding margin hit losses), nine tiny trailing marker edges, preserved tabs and RTL atomic/wrap segmentation. The new matrix still has 27 atomic and 15 nested hit failures and 105 strict pixel failures. Full fragment lists, local glyph paint and editor/OS delivery retain separate gates. The [targeted plan](../../docs/research/CHROMIUM-PARITY.md) preserves those owners and acceptance checks.
