# Chromium parity continuation: font ranges and retained text

This continues the [initial checkpoint](chromium-parity.md) in the same isolated
worktrees. The compiler uses Blitz `f0843274`, Fontique/Parley `2edeab7`, Stylo
`715f4d98b` and Vello `a8efce54`; compiler/probe source is `45d0e19` plus the
overlap/provenance expansion `789e1ef`. All commits are
signed. Parley has one new worktree, `RunicArtifex/parley-chromium-parity`, based
on the existing `718dcb7` pin. There is no dependency version upgrade or change
to the original checkouts. All native checks share the main compiler target,
PID lock, offline dependency cache and locked experiment flake.

## Repairs and module boundaries

Blitz now passes both CSS face-weight endpoints to Fontique. Fontique stores
that advertised capability separately from intrinsic font metadata, matches
weights using the inclusive interval, preserves equally matching subset
candidates, avoids static synthesis inside the advertised range, and clamps
variable `wght` instances to its endpoints. Existing callers without a range
retain the previous behavior. Four added real-font tests cover static
synthesis, variable clamping, CSS weight search order and overlapping subsets.
This follows the [CSS Fonts matching model](https://drafts.csswg.org/css-fonts-4/#font-matching-algorithm).
It does not certify width/style ranges or CSS last-face tie ordering.

The registration fix did **not** explain the compiled table's displaced button
labels. An intrinsic query was breaking and aligning the retained Parley text
at its measurement width after the final layout had been cached. The box
geometry remained correct, while Save's line offset became roughly 77 px
inside a 39 px content box. Blitz now preserves the retained text layout during
ComputeSize and uses the measurement copy for its size/baseline output. All
three exits restore the original; PerformLayout still stores its new lines.
There is no painter offset adjustment or framework-specific path.

The optional fields added to the public `FontInfoOverride` and
`FontFaceOverrides` structs break exhaustive external Rust struct literals.
Owned callers compile with `..Default::default()`. An upstream API/semver
decision and reviewed reproducible dependency pins remain integration gates.
No IR or schema change was needed.

## Verification

Geometry remains **0.125 CSS px**, local pixel MAE **3/255**. Inputs, browser
references and tolerances were not adjusted to manufacture passing results.
The new font cases add optical-sizing-none/explicit-line-height reductions
alongside the original auto/normal cases; the original failures remain.
The matrices use Chromium 153.0.8010.12, pinned DejaVu WOFF2 and Roboto Flex
from Parley's pinned test assets, with source/font/binary hashes in the raw
reports. The [machine-readable record](chromium-font-inline.json) records
counts and report hashes. Logs and screenshots remain under `artifacts/`.

The new table/flex/grid text matrix improves from **5 to 20 pixel states out
of 30**, comparing immediate parent `4301f75a` and `f0843274` in the same Blitz
worktree. Geometry, hits and scroll metrics pass all 30 states on both sides.
Ten nested-inline pixel failures remain. The nested atomic-inline baseline
path can promote child ComputeSize to PerformLayout, so preservation across
the whole sizing subtree needs further investigation.

The expanded font matrix retains 36 states: geometry passes 12, hits 28 and local
pixels 12. Both overlapping-face source orders retain all eight failing
geometry/pixel states; CSS face priority remains uncertified and separate from
range matching. The eight optical-sizing-none states match every requested word
width to within **0.015625 px**, including restricted-range clamping, but retain inline
span height/hit discrepancies. The original auto/normal variable-font cases
still fail geometry and paint; widths differ by up to 10.859375 px. This is
consistent with the missing automatic `opsz` coordinate in the Blitz bridge,
but is not a claim that fixing it alone closes font parity. The next change
must apply [optical sizing and variation precedence](https://drafts.csswg.org/css-fonts-4/#font-optical-sizing-def)
consistently to shaping and metrics. Synthetic bold paint for a single static
face and DPR 2 raster failures also remain; the current painter does not use
Fontique's per-run embolden suggestion.

Compiled tables pass semantics and geometry in all **6 CPU runs / 96 states**;
local pixels pass **72 states**. Initial pane MAE is **0.822–0.920**, down from
the previous **4.318–4.488**; the maximum is **4.678**. The 24 failing states are
focused/selected input paint. Svelte GPU tables on the same pinned Mesa
lavapipe adapter pass semantics/geometry in **2 runs / 32 states**, with
**24 pixel states** passing. Initial pane MAE is **1.335–1.363**, maximum
**5.102**. Neither complete compiled table pixel gate passes yet.

Compiled forms, layout reads and scroll-event regressions pass all three gates
in **10 CPU runs / 120 states**. The original 69 table states and 148 scrolling
states still pass geometry, hits, scroll and local pixels. The legacy eight
glyph/border controls retain three local pixel failures. The pinned table
control reduction now passes all four pixel states, while geometry and hits
remain 2/4: the quirks 0.5 px checkable baseline and fractional rounded-button
edge discrepancy remain.

Compiler `npm test` passes **297 tests**, including TypeScript checking. Rust
workspace verification passes **117 tests**; Fontique passes **13**. Blitz DOM
passes **48 and fails 2**, with the same failures reproduced at the earlier
baseline (`hover_styles_apply_and_clear`, `scroll_by_clamps_and_bubbles`).
Document-mode inheritance/replacement passes all gates in **12 states**, and
CSS animation rendering in **40 states**. Table integration retains its
22/30 geometry, 24/30 hits and 23/30 local pixel passes; native controls retain
8/9 geometry/hit and 6/9 local pixel passes. Missing UA font packaging, checked
radio paint and scrolled textarea wrapping remain visible. An initial
document-mode invocation used the wrong script filename; its separate failed
log is retained, and the correct script completed the 12-state check. The available
tools still do not expose `/code-review`: manual diff review and bounded
read-only reviews covered cache restoration, baseline preservation, matching,
the public API caveat, case scope and provenance. The unavailable stage is not
reported as passed.

## Layout costs and next gates

The existing release benchmark compares immediate parent `4301f75a` with
`f0843274` in the same worktree, with unchanged Fontique and other dependencies.
Each run uses 3 warmups and 15 samples at 100/1,000 rows. Parsing, embedded-font
ingestion and four resolves are included in initial cost; mutations resolve
once. No raster or framework work is timed. The retained-layout copy is a
correctness repair with a measurable cost; scratch-layout reuse is a separate
optimization gate and must preserve these regressions.

| Rows | Operation | Parent median ms | Current repeat median ms |
|---|---|---:|---:|
| 100 | Initial | 17.333 | 18.026 |
| 100 | Cell text update | 2.729 | 3.036 |
| 100 | Row insertion | 3.149 | 3.594 |
| 100 | Parent resize | 3.199 | 3.557 |
| 1,000 | Initial | 69.910 | 73.060 |
| 1,000 | Cell text update | 37.216 | 40.230 |
| 1,000 | Row insertion | 41.326 | 43.477 |
| 1,000 | Parent resize | 38.298 | 41.477 |

The 1,000-row mutation medians increase by **2.15–3.18 ms (5–8%)**. Initial
p95 is **17.607 / 72.967 ms** for the parent and **19.033 / 77.735 ms** for the
repeat. Parent high-water/RSS is 34,396 KiB; the repeat is 31,196/28,232 KiB.
The first current observation, p95 values and memory readings remain in the
machine-readable record. These are serial observations on an active desktop,
not controlled tail-latency or memory equivalence claims.

The next useful app-facing closure is focused/selected text-input paint,
followed by nested inline measurement isolation, fractional rounded hits and
the quirks checkable baseline. Font instance resolution/synthesis and dense
raster differences remain in their font/paint owners. Tables stay experimental
until the compiled CPU/GPU pixel gate and reproducible integration pins pass.
The [targeted plan](../../docs/research/CHROMIUM-PARITY.md) retains each gap and
its acceptance gate.
