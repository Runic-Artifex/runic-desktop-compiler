# Chromium text paint origins — isolated checkpoint

All seven strict pixel regressions from the preceding nested-alignment checkpoint
are repaired. The retained middle matrix improves 78/180 →
89/180; geometry remains 180/180,
measured fragments 120/120 and hits
147/180. The new 108-state paint-origin oracle
improves 38/108 → 85/108
while preserving its geometry, fragment and hit gates.

Blitz now has a private text-origin module. Ordinary line fragments establish a
CSS paint anchor; materialized inline boxes replace it for descendants, while
culled children inherit it. It snaps the unrounded CSS anchor and compensates for
the rounded Blitz paint translation before device-space glyph quantization.
Glyphs, decorations and ellipsis share the correction. Selection, backgrounds,
logical baselines, DOM geometry and pointer targets retain layout coordinates.
Separate editor, placeholder and marker layouts preserve their existing paint path.
The reusable paint context retains the span/index scratch storage.

This follows the pinned Chromium
[text painter](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/paint/text_fragment_painter.cc#67)
and its [materialized/culled inline traversal](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/paint/box_fragment_painter.cc#2249).
Parley's additive read-only `Line::style_font_metrics` returns the primary font's
existing ascent/descent, avoiding another font query or an inference from aligned
bounds. The [ADR](../../docs/ARCHITECTURE.md#chromium-parity-inline-text-paint-anchors-2026-10-08-isolated)
records this boundary. No IR, frontend, renderer hinting or font-provider changes
are part of this continuation.

The [oracle](../paint-origins.mjs) covers nested middle/baseline/length alignment,
parent and child backgrounds, parent text, origins 20/20.375/−0.375 CSS px,
DPR 1/1.25/2 and font-size mutations. Geometry, both span fragment lists, hits
and every measured pixel region remain separate gates.

The [36-state decoration oracle](../paint-decorations.mjs) adds wrapped root
underlines with no direct root text, culled/materialized children, fractional
line heights, origins, DPRs and mutation. Its strict pixels improve
2/36 → 7/36;
geometry and fragments remain 36/36 and
36/36. The root fallback now
keeps the captured paint phase when replacing a descendant's logical baseline
with the line baseline. Mixed-font and repeated-fragment decoration ownership
remain broader gaps. The first validation attempt was stopped after this source
review finding, archived, and replaced by the complete frozen 40-command run.

| New paint-origin case (six states each) | Geometry | Fragments | Hits | Strict pixels |
|---|---|---|---|---|
| nested_middle_integer | 6/6 | 6/6 | 6/6 | 5/6 |
| nested_middle_fractional | 6/6 | 6/6 | 6/6 | 5/6 |
| nested_middle_negative | 6/6 | 6/6 | 6/6 | 5/6 |
| parent_background_integer | 6/6 | 6/6 | 6/6 | 5/6 |
| parent_background_fractional | 6/6 | 6/6 | 6/6 | 5/6 |
| parent_background_negative | 6/6 | 6/6 | 6/6 | 5/6 |
| child_background_integer | 6/6 | 6/6 | 6/6 | 5/6 |
| child_background_fractional | 6/6 | 6/6 | 6/6 | 5/6 |
| child_background_negative | 6/6 | 6/6 | 6/6 | 5/6 |
| nested_baseline_integer | 6/6 | 6/6 | 6/6 | 3/6 |
| nested_baseline_fractional | 6/6 | 6/6 | 6/6 | 5/6 |
| nested_baseline_negative | 6/6 | 6/6 | 3/6 | 5/6 |
| parent_text_integer | 6/6 | 6/6 | 6/6 | 4/6 |
| parent_text_fractional | 6/6 | 6/6 | 6/6 | 4/6 |
| parent_text_negative | 6/6 | 6/6 | 6/6 | 4/6 |
| parent_length_integer | 6/6 | 6/6 | 6/6 | 5/6 |
| parent_length_fractional | 6/6 | 6/6 | 6/6 | 5/6 |
| parent_length_negative | 6/6 | 6/6 | 6/6 | 5/6 |

Across 40 serial commands, 28 direct matrices contain 3,890 exact input-hash pairs,
with no missing, added, duplicate or mismatched states. Root and independent
audits agree: pixels: 63 repairs, 0 regressions. Raw geometry, fragment and hit observations agree
with the result summaries across 7,780 before/after states. Strict pixels require
the viewport, container and every measured named crop to meet the unchanged
3/255 MAE bound. Direct geometry remains 0.125 CSS px; empty optional reference
maps and null crops are unmeasured.

| Direct matrix | Geometry | Measured fragments | Hits | Strict pixels |
|---|---|---|---|---|
| middle-metrics | 180/180 | 120/120 | 147/180 | 89/180 |
| nested-alignment | 66/72 | 57/72 | 63/72 | 0/72 |
| paint-decorations | 36/36 | 36/36 | 36/36 | 7/36 |
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

The separately frozen 18-state inner-span diagnostic retains all 18/18
geometry and 18/18 fragment passes. Strict pixels improve
9/18 → 16/18,
with 7 repairs and 0 regressions.
The canonical seven crops pass; tighter inner crops still expose residual glyph
coverage error and are retained as failures.

All 389 compiled CPU/GPU table, forms and control states pass semantics, geometry
and strict pixels. Compiler tests pass 297/297;
Rust workspace tests 122/122; Blitz paint
12/12; HTML 3/3;
Parley engine 39/39 and libm check pass.
Focused style-metric checks pass 37/37. Blitz DOM retains its 57 passes and two
existing failures (hover_styles_apply_and_clear, scroll_by_clamps_and_bubbles).
Parley std retains 128 passes and the four existing fontless cluster-position
failures (start/end/center/justified alignment). System-font default-feature tests,
OS input/IME delivery and the unavailable named /code-review stage remain incomplete;
source reviews and headless probes do not establish those stages.

The original diagnostic directory was accidentally reused during a rejected
fractional-origin experiment. It was recovered to its recorded bytes, and an
independent audit confirms all 1,167 older evidence entries and 38,289 immutable
observation hashes match. Old committed records remain unchanged. Canonical and
baseline observations, PNGs, logs and source proofs are retained; only disposable
candidate screenshots and task-owned temporary test/profile paths are removed.

One existing isolated worktree per repository is retained. Sources are signed;
original trees are unchanged. No merge, push or milestone tag was performed.
Local dependency overrides remain experimental integration inputs.

The next useful work is normalized empty-inline participation and generic span
margin flow, followed by fragment segmentation and remaining hit/editor edges.
Paint materialization provenance across mutations, layer-local/transformed anchors,
containment/SVG/special branches and bidi fragment ownership need their own source
traces and oracles. The [targeted plan](../../docs/research/CHROMIUM-PARITY.md)
keeps these seams separate; this checkpoint does not claim whole-browser parity.
