# Chromium empty inline participation — isolated checkpoint

Empty ordinary inline spans now participate in Parley's line metrics and Blitz's
fragment geometry. All 108 new geometry, fragment-list and hit states pass; strict
pixels improve 12/108 → 21/108. The retained nested oracle improves geometry
66/72 → 72/72, fragments 57/72 → 63/72 and hits 63/72 → 69/72;
its strict pixels remain 0/72. Remaining fragment and hit failures stay measured.

Parley owns normalization, zero-advance anchors, line membership, font metrics and
positioning. Delayed collapsed spaces, nested styles, same-byte atomic ordering,
saved/replayed breaks and both breaker APIs retain their anchor cursors. Empty-only
lines remain invisible for block sizing while retaining real zero-width font-area
fragments. The tree-builder option defaults off; style-modification scopes do not
create participants. The additive read-only line iterator leaves the public
positioned-item enum unchanged. Blitz opts in for standards-mode ordinary inline
contexts, binds styles to DOM owners and consumes those positions. CSSOM's empty
fragment-list fallback stays at the origin through transforms; real zero-width
fragments transform normally. display:contents retains an empty client-rect list.
No IR, framework, renderer or font-hinting change is involved.

The [108-state oracle](../empty-inline.mjs) covers leading/trailing/sole,
collapsed/pending whitespace, nesting, own font sizes, top/bottom alignment,
wrapping, forced breaks, RTL/mixed bidi, display:contents and font-size mutation
at DPR 1/1.25/2. This is bounded standards-mode coverage, not complete bidi or
quirks parity. The [ADR](../../docs/ARCHITECTURE.md#chromium-parity-empty-inline-participation-2026-10-08-isolated)
records the API and module boundaries.

Pinned Chromium's [boundary predicates](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/layout/inline/inline_node.cc#493)
and [zero-length tag scan](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/layout/inline/inline_node.cc#1632)
revealed that empty non-baseline spans also interrupt adjacent-text shaping.
For retained empty spans whose represented Parley VerticalAlign differs from BASELINE,
a private normalized byte-boundary stream splits itemization without adding
text, provenance or caret stops. Compatible baseline empty spans retain their
cross-element ligature and place the fragment after the complete shaping atom,
rather than at an internal caret component. Ligatures wholly on either side remain.

The [42-state shaping oracle](../empty-inline-shaping.mjs) repairs all 42 geometry
and fragment-list failures and preserves all 42 hit passes. Strict pixels change
11/42 → 6/42: six baseline-control repairs and eleven new failures in non-baseline
tight inner crops. Correct shaping is retained; these paint regressions are
explicitly recorded, with unchanged crop rules and tolerances. The viewport,
container and named table crops pass in all 42 states. Tight glyph coverage remains
an independent renderer gate.

The first verification run was stopped after 17 commands for this source-review
finding. Its partial logs and observations are archived separately; the final
record uses the complete frozen 42-command rerun. Across 30 direct matrices,
4,040 exact input-hash pairs contain no missing, added, duplicate or mismatched
states. Root and independent audits agree: 150 geometry, 156 fragment-list and
87 hit repairs; 15 strict pixel repairs. All 11 pixel regressions come from the
new shaping oracle. Every previously passing retained gate is preserved. Raw geometry,
fragment and hit observations agree across all 8,080 before/after states.
Strict pixels require finite viewport/container measurements and every measured
named crop at MAE ≤3/255; geometry remains 0.125 CSS px. The runner now enforces the
viewport and finite global measurements too. Null local crops are explicitly
unmeasured only after their clipped union is verified empty; required JSON and
screenshot/crop files are checked before manifest hashing.

| Direct matrix | Geometry | Measured fragments | Hits | Strict pixels |
|---|---|---|---|---|
| middle-metrics | 180/180 | 120/120 | 147/180 | 89/180 |
| nested-alignment | 72/72 | 63/72 | 69/72 | 0/72 |
| paint-origins | 108/108 | 108/108 | 105/108 | 85/108 |
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
| empty-inline | 108/108 | 108/108 | 108/108 | 21/108 |
| empty-inline-shaping | 42/42 | 42/42 | 42/42 | 6/42 |

All 389 compiled CPU/GPU table, forms and control states pass semantics, geometry
and strict pixels. Compiler tests pass 297/297, Rust workspace 122/122, Blitz paint
12/12, HTML 3/3, Parley engine 39/39 and the libm check. Focused style metrics pass
49/49 and empty-inline CSSOM checks 4/4. Blitz DOM retains 61 passes and its two
existing failures (hover_styles_apply_and_clear, scroll_by_clamps_and_bubbles).
Parley std has 140 passes and the four existing fontless cluster-position failures
(start/end/center/justified). System-font default-feature tests, OS keyboard/pointer/
IME delivery and the unavailable named /code-review stage remain incomplete.
Independent source reviews do not certify those stages.

All eight older records, 1,445 evidence references and 152,649 observation references
remain unchanged. Canonical baselines/final captures, JSON, HTML, logs and source
proofs are retained. Only task-owned disposable screenshots and temporary test/
development-profile paths are removed after their consumers finish. One existing
isolated worktree per repository is retained; source commits are signed, original
trees unchanged, and no merge, push or milestone tag was performed.

The next useful slice is explicit caller shaping-boundary intent plus generic
ordered span-edge flow. Parley's current geometric VerticalAlign value cannot
distinguish CSS vertical-align:0px from baseline, and nonempty spans still need
explicit boundary intent. Blitz must bind that intent and CSS logical edges;
Parley must own normalization, intrinsic measurement, whitespace rollback, wrap
replay and positioning. Fixed, negative and percentage margins/padding/borders,
first/last wrapped fragments and slice/clone need direct gates before freezing an
additive API. The [targeted plan](../../docs/research/CHROMIUM-PARITY.md) keeps this
work separate from paint, full fragment segmentation and remaining editor/OS gaps.
