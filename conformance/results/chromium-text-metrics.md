# Chromium text metrics and single-line editor geometry

Blitz now uses logical font-metric quantization and matches Chromium's conditional
single-line inner-editor line height and signed centering. Across identical inputs,
the text matrix improves from **128 to 304 geometry passes out of 432**, the
line-height matrix from **64 to 336 out of 504**, and pointer editor state from
**141 to 231 out of 264**. All DPR 1 and DPR 2 geometry states in both new text
matrices pass. Fractional-DPR boxes, raster coverage and other behavior remain open.

This continues [control boxes](chromium-control-boxes.md) in the same single
experiment worktree per repository. The signed source is compiler `ab5314d`,
Blitz `09ebf3ce`, Parley `ac9bed8`, Stylo `b2cf0bbeb` and Vello `a8efce54`.
Original checkouts are unchanged. The [machine record](chromium-text-metrics.json)
retains exact revisions, commands, independent gates, source metadata and evidence
hashes. Builds use the locked environment and shared Cargo target/lock.

## Ownership and behavior

Parley's new public `QuantizationMode::Logical` is opt-in; `Device` preserves
existing rounding and remains the default. Logical mode rounds font ascent,
descent and normal leading before viewport scaling, and floors half-leading in
that same coordinate space. Explicit line heights, baseline shifts, atomic boxes
and accumulated positions remain fractional. Quantization disabled remains
unquantized in either mode. Builders reset to Device; editor mode persists across
refreshes. A finite positive scale is required in Logical mode.
The [ADR](../../docs/ARCHITECTURE.md#chromium-parity-logical-text-metric-quantization-2026-10-08-isolated)
freezes that contract. This follows Chromium's HTML
[font metrics](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/platform/fonts/font_metrics.h)
and [half-leading](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/layout/inline/line_utils.cc)
policy. These moving source links explain the implementation; Chromium
153.0.8010.12 is the behavior oracle.

Blitz selects Logical for ordinary text, list markers, placeholders and editors.
Parley still returns device units once; CSS layout uses logical units. The native
regression verifies ordinary text and two-line textarea baselines of 15/35 CSS px
through DPR 1 → 1.25 → 2 → 1, including rebuilds and retained selection. At DPR 2
this is 30/70 device px, replacing the former 31/71.

The single-line inner editor uses normal line height when the integer computed authored
line height is no larger than font size, when logical height contains a percentage,
or when fixed logical height exceeds the integer computed line height. Automatic
height otherwise keeps the authored value. The policy acts on the private editor
style, preserving outer computed CSS and textarea behavior, following Chromium's
[inner-editor adjustment](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/forms/text_control_inner_elements.cc).
The height matrix includes pure and percentage calculations and fractional
thresholds, rather than always forcing normal line height.

A shared signed centering primitive feeds painting, caret/selection, baseline
export and pointer coordinates. An overflowing editor can extend above its content
box; the old zero clamp disagreed with the pinned browser. The
[legacy Blink centering path](https://chromium.googlesource.com/chromium/src/+/614cdd0c8ca209651632fe0595fefa3844589601/third_party/blink/renderer/core/layout/layout_text_control_single_line.cc#65)
provided an explanatory reduction; the current binary oracle determines acceptance.
Ordinary single-line clicks/drags above/below the editor use logical text start/end,
including RTL. Inside-editor hits retain Parley's coordinate lookup; multiline
handling is unchanged. This is internal event delivery, not OS pointer/IME proof.

## Verification

Direct geometry stays **0.125 CSS px**, compiled geometry **2 CSS px**, local
pixels **MAE 3/255**. No IDs, states, cases or tolerances were removed. The pinned
DejaVu font, Latin/Arabic text, 12/14/16/24px sizes, fractional origins, DPR
1/1.25/2, focus, visible caret, selections and width refreshes are retained.

| New oracle | States | Geometry before → after | Editor before → after | Local pixels before → after |
|---|---:|---:|---:|---:|
| Text metric grid | 432 | 128 → 304 | 432 → 432 | 19 → 48 |
| Input line height | 504 | 64 → 336 | 504 → 504 | 70 → 134 |
| Pointer boundaries | 264 | 176 → 176 | 141 → 231 | 13 → 13 |

The text baseline predates both native repairs. The line-height baseline already
has Logical mode and predates inner-editor policy/centering. The pointer baseline
already has those geometry repairs and predates shared pointer mapping. Each pair
has identical HTML hashes, case/viewport/state order and unchanged action scripts.

| Retained oracle | States | Geometry | Hits | Editor | Scroll | Local pixels |
|---|---:|---:|---:|---:|---:|---:|
| control-document-mode | 132 | 92 | 120 | 132 | 132 | 84 |
| control-layout | 264 | 132 | 264 | 264 | 264 | 0 |
| control-selection | 48 | 48 | 48 | 48 | 48 | 12 |
| control-focus | 252 | 252 | 252 | 252 | 252 | 164 |
| tables | 77 | 77 | 77 | 77 | 77 | 74 |
| table-document-mode | 12 | 12 | 12 | 12 | 12 | 12 |
| table-controls | 4 | 4 | 2 | 4 | 4 | 4 |
| table-integration | 30 | 22 | 24 | 30 | 30 | 23 |
| controls | 9 | 8 | 8 | 9 | 9 | 6 |
| scrolling | 148 | 148 | 148 | 148 | 148 | 148 |
| css-animations | 40 | 40 | 40 | 40 | 40 | 40 |
| intrinsic-text | 30 | 30 | 30 | 30 | 30 | 20 |
| font-weights | 36 | 12 | 28 | 36 | 36 | 16 |
| glyphs | 38 | 38 | 38 | 38 | 38 | 4 |
| borders | 7 | 7 | 7 | 7 | 7 | 0 |

Compiled tables pass all gates across 96 CPU and 32 selected GPU states; forms/focus
pass 242 states and button/inline regressions 19. Scrolling retains two offscreen
named crops as unmeasured; its full-screen and available crops pass. The two newly
failing pixel states are `standards_input_default`, DPR 1, before/after fragment
replacement: corrected input y is 23.5px (formerly 24), while the control crop
increases from MAE 0.877 to 10.266. Retain that glyph-placement reduction rather
than reintroducing incorrect box geometry. No older geometry/hit/editor/scroll
pass regressed.

Compiler tests: 297/297, including TypeScript checking. Rust workspace: 118/118.
Blitz paint: 8/8; HTML: 3/3. Blitz DOM retains its two known failures
(50 pass). Parley std has 107 passes and the same four known fontless cluster
failures; libm/no_std compilation passes. Its temporary focused workspace copies
148 exact source files, reuses the prior pruned lock with zero new package/version/
source tuples, and omits unused benchmark members. Original default system-font
tests remain incomplete because the project environment lacks fontconfig metadata.
The manifest, lock, source hashes and logs are retained.

Processes were terminated during npm and font-weight verification; those attempts
are incomplete. Completed matrices were retained and both interrupted stages
repeated in full in short sequential batches. A read-only review caught and repaired the pointer
coordinate mismatch; root reviewed the diff and repeated acceptance checks.
`/code-review` is unavailable, so that named tool stage remains incomplete.

## Remaining work

All 128 text-matrix and 168 height-matrix geometry failures are fractional-DPR
control boxes. Stylo's `snap_as_border_width` uses app units per device pixel;
Chromium's [border converter](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/css/resolver/style_builder_converter.cc)
clamps computed layout lengths. This is a source-backed diagnosis of the observed
approximately 0.4px two-border size discrepancy, to be isolated with explicit
border-width and CSS-zoom cases before changing a shared style contract.

The text matrix retains 152 hit failures (fractional boxes and tiny baseline-marker
edge hits) and 384 pixel failures. Pointer state retains 15 selected-text click
states and 18 RTL inside-editor alignment states. Outside-editor Arabic/RTL states
match. Double/triple-click granularity, exact boundary equality, OS delivery and
IME remain uncertified. Native theme paint, ordinary span bounds/margins, quirks
break/newline behavior, font instances/order and raster coverage retain separate
owners and gates. [The updated plan](../../docs/research/CHROMIUM-PARITY.md) orders
the next reductions. Experimental local dependencies and these open gates still
prevent promoting the isolated branch to the shipping contract.
