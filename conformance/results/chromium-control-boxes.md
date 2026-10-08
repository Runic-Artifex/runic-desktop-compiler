# Chromium control boxes and editor positions

Text controls now use Chromium's ordinary UA box models, textareas export the
appropriate baseline for their formatting context, and editor selections retain
their logical position while fonts are absent. The retained focus suite improves
from **144 to 240 geometry passes** and **66 to 80 local pixel passes** across
252 identical input states. This continues the
[focus work](chromium-control-focus.md) in the same isolated worktrees.

The signed verification source is compiler `38ee95c`, Blitz `57db2372`,
Stylo `b2cf0bbeb`, and Parley `e5f3dc3`. Vello remains `a8efce54`.
Original checkouts are unchanged; each repository still has one experiment
worktree. Builds reuse the locked project environment and shared Cargo target
and lock. The [machine record](chromium-control-boxes.json) retains source pins,
commands, counts, metadata and evidence hashes.

## Repairs and ownership

Chromium implementation links below follow its `main` branch and explain the
policies; the behavioral reference is the pinned browser in the verification
record, rather than those moving source URLs.

Blitz's UA sheet gives ordinary text inputs and textarea content-box sizing,
retains search and checkable exceptions, and gives buttons their two-pixel
border and border-box sizing. Author declarations still win. This follows the
ordinary appearance rules in Chromium's
[UA sheet](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/resources/html.css);
its dynamic appearance modes are a separate compatibility gate.

Full quirks documents retain border-box input/textarea defaults from Chromium's
[quirks UA sheet](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/resources/quirks.css).
Limited quirks retains standards sizing. The first broad run caught a regression
in older no-doctype reductions; the final fix restores their widths and scroll
dimensions without overriding authored sizing.

HTML parsing now passes document mode to Blitz's node tree, Stylo matching and
the rebuilt device. Fragment insertion preserves it; XML remains standards
mode. Parley's generic root-strut option lets quirks/limited-quirks atomic-only
lines omit the unconditional font contribution. Actual text keeps its metrics;
editor layouts retain the default for empty caret geometry. This follows the
[blocks ignore line-height quirk](https://quirks.spec.whatwg.org/#the-blocks-ignore-line-height-quirk)
and repairs the remaining five-pixel textarea-parent regression. Device rebuilds
and mode changes invalidate layout caches before reuse.

Stylo adjusts visible overflow axes on HTML textarea to auto before applying
the generic cross-axis overflow rules, matching Chromium's
[style adjustment](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/css/resolver/style_adjuster.cc).
Layout, painting and computed-style reads therefore use the same policy.
Pseudo-elements and Gecko mode are unchanged.

Blitz refreshes textarea layout at its resolved content width before exporting
first and last editor baselines. Flex/grid alignment uses the first; inline
`overflow:clip` uses the last. A scrolling inline textarea synthesizes its
baseline from the bottom margin edge. Single-line inputs keep their separate
baseline and centering path. No coordinate correction is added to painting.

Parley's no-cluster cursor fallback now clamps and retains a requested logical
byte position rather than moving it to the end. Initial selections stay at zero,
and valid ranges survive width, scale, alignment and font/style refreshes.
Once clusters return, the existing canonicalization runs again. Editor-owned
callers provide valid UTF-8 boundaries; arbitrary non-boundary byte offsets in
the public cursor API remain a separate edge. The new public document-mode and
root-strut APIs have a [documented contract](../../docs/ARCHITECTURE.md#chromium-parity-document-mode-and-empty-line-struts-2026-10-08-isolated)
and require upstream review before integration. There is no IR/schema,
framework-specific branch or painter-coordinate change.

## Verification

Direct geometry remains **0.125 CSS px**, compiled geometry **2 CSS px**, and
local pixel MAE **3/255**. Chromium is 153.0.8010.12; fonts are pinned and selected
GPU runs use Mesa llvmpipe. No original case, ID or tolerance was removed.

The new layout suite covers standards/quirks, inline/flex/grid/table parents,
authored content/border boxes, width changes and margins. Its original 192
states were captured before native edits with identical input hashes; 72 added
states exercise authored visible/hidden/clip textarea overflow.

| Gate | Layout before | Retained layout after | Added overflow | Focus before | Focus after |
|---|---:|---:|---:|---:|---:|
| States | 192 | 192 | 72 | 252 | 252 |
| Full geometry | 0 | 48 | 36 | 144 | 240 |
| Hits | 168 | 192 | 72 | 252 | 252 |
| Editor value, selection and focus | 192 | 192 | 72 | 252 | 252 |
| Scroll metrics | 192 | 192 | 72 | 252 | 252 |
| Local pixels | 0 | 0 | 0 | 66 | 80 |

The new selection oracle passes geometry, hits, editor state and scroll in all
**48 states**. It covers ASCII/Unicode input and textarea, initial UA/pinned
fonts, unavailable fonts and restored fonts. Pixel passes remain only 8/48:
logical selection correctness does not supply missing fallback glyphs or repair
fixed-height input centering. These internal actions do not certify OS keyboard
or IME delivery, bidi caret geometry or blink timing.

Compiled table semantics, geometry and pixels pass all **96 CPU / 32 GPU
states**, with maximum local MAE **1.270 / 2.396**. Forms, measurement, scroll
events and focus pass **22 runs / 242 states**; compiled button/inline-baseline
regressions pass **7 runs / 19 states**. The original 69 direct table states,
12 table document-mode states, 148 scrolling states and 40 animation states
retain their gates. Two named scrolling crops are offscreen and were not
measured; the full screenshot comparisons pass. Broader table/glyph/border
controls retain their failures.

The older control suite retains geometry 8/9, hits 8/9, scroll 9/9 and pixels
6/9, while editor state improves 8→9/9. Table integration retains geometry
22/30, hits 24/30, scroll 30/30 and pixels 23/30; editor state improves 22→30/30.
These paired inputs have identical hashes. Table-control geometry improves
2→4/4; pixels remain 4/4 and corner hits remain 2/4. Nested text remains at
20/30 pixel passes, font weights at 12/36, glyphs at 3/38 and borders at 0/7.

The additional document-mode oracle retains **132 states**. Its 60 core
standards/quirks/limited-quirks states pass 58 geometry checks, all hits/editor/
scroll checks and 32 local pixel checks. The two geometry failures are the
existing DPR 1 half-pixel input position. Across the full oracle, geometry
passes 90, hits 120, editor/scroll 132 and pixels 64. The edge reductions retain
24 float-feature geometry failures (floats are disabled in this build) and 16
quirks/limited-quirks break/newline failures with a separate 19px line-box
residual. Clip/hidden atomic cases pass geometry and scroll. These results do
not certify legacy CSS parsing or the separate collapsed-whitespace quirk.

The new Parley regression fails on the old cursor code (`4..4` instead of
`0..0`) and passes with the repair. A focused source-only test workspace hashes
147 copied source files against the worktree and prunes unused workspace
packages without changing dependency versions. Offline `std` library tests pass
102 and fail four existing cluster tests that assume system fonts; those four
also fail on the baseline. The default system-font feature test remains
incomplete because the project shell lacks fontconfig. The temporary workspace
is removed after retaining its manifests, hashes and logs.
Both new strut tests fail with the previous line breaker and pass with the new
one; they cover atomic-only lines, actual text and builder reuse.

Compiler tests pass **297** including TypeScript checking; Rust workspace tests
pass **117**, Blitz paint **8**, and Blitz HTML **3**. Blitz DOM passes **50**
and retains the same two failures: `hover_styles_apply_and_clear` and
`scroll_by_clamps_and_bubbles`. The new mode/device/cache regressions pass.
Manual and bounded read-only reviews found no blocker; `/code-review` remains
unavailable and incomplete.

## Remaining useful work

The layout oracle retains ordinary inline span bounds/margins, fixed-height
single-line input half-pixel centering, and DPR 2 metric failures. Default button
theme/border paint, emoji and fallback font coverage, appearance modes and
textarea `display:contents` remain separate gates. Full layout passes are
84/264; control rectangles alone match in 232/264, which is diagnostic evidence
and does not replace the full gate.

One default-button diagnostic matches the label bounds and passes its interior
crop at MAE 1.464, while the full crop remains 22.076. Native lower/right bevel
pixels dominate that difference. Reduce native `appearance:auto` theme painting
separately from authored CSS borders; this diagnostic does not replace the full
pixel gate or classify every button case.

The private probe now records device-space inline/editor metrics. At pinned
16px/20px, textarea first/last baselines and line height are `15/35/20` at DPR 1
and `31/71/40` at DPR 2. A doubled CSS metric grid would give `30/70/40`, consistent
with the shared one-device-pixel text drift. Parley's documented `quantize=true`
contract intentionally rounds in device space; changing its meaning would
silently affect other consumers.

The [targeted plan](../../docs/research/CHROMIUM-PARITY.md) separates document-mode
edge cases and an explicit CSS metric-grid design from span geometry, control
centering and native theme paint. The next text experiment must preserve the
existing quantization default and compare DPR 1/1.25/2, glyphs, selections and
carets before introducing an opt-in API. Reviewed reproducible pins and the
remaining input/platform gates
are still required before integrating experimental table acceptance.
