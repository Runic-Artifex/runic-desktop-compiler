# Chromium focus and selection parity

Focused and selected inputs now pass the compiled table pixel gate in all
**96 CPU states** across React, Vue and Svelte and **32 Svelte GPU states**.
The previous checkpoint passed 72 and 24 respectively. Semantics and geometry
also pass. This continues the [font and inline work](chromium-font-inline.md)
in the same isolated worktrees; broader control and font parity remains open.

The signed source is compiler `c5574fd`, Blitz `e6b045f9`, Parley/Fontique
`2edeab7`, Stylo `715f4d98b` and Vello `a8efce54`. This continuation adds Blitz
`f916cbeb`, `f74a4f05` and `e6b045f9`; other dependency sources are unchanged.
One experiment worktree remains in use per repository. Original checkouts are
unchanged. Native verification uses the shared Cargo target and PID lock,
offline dependencies and the locked experiment flake.

## Repairs

Blitz paint now draws selected control text in white over the measured Linux
Chromium selection background `#3367d1`. It paints ordinary text first, covers
selected glyphs with opaque selection rectangles, then clips one foreground
text pass to their union. This preserves glyph antialiasing and avoids repeating
the entire text layout for each selected line. Document selection keeps its
existing separate path.

The shared outline painter handles a rounded two-stroke `outline:auto` ring,
including authored radii and positive or negative outline offsets. Outlines
paint after content, outside the element's own overflow clip and inside its
CSS clips, masks and effects. The UA uses `:focus-visible`; checkbox and radio
outlines retain their 2 px offset. The model follows Chromium's
[UA rules](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/resources/html.css)
and [outline painter](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/paint/outline_painter.cc).
Default placeholder text is `#757575`, with authored pseudo-element styles
still taking precedence.

The text-control caret uses one CSS pixel scaled by DPR and appears only for
an editable collapsed selection. Disabled focus requests leave the previous
focus, ancestor state and IME session intact. Native Tab traversal now treats
`disabled`, `disabled="false"` and `disabled="true"` as the same HTML boolean
attribute; removing it restores traversal. The regression covers both directions,
direct focus rejection and focus-within state.

These changes belong to Blitz UA, DOM and paint. The probe uses existing editor
APIs to observe selections. There is no framework-specific layout path, backend
branch, IR/schema change or application workaround.

## Verification scope

The direct primitive gate remains **0.125 CSS px** geometry and **3/255** local
pixel MAE. The compiled harness retains its existing **2 CSS px** geometry gate
and **3/255** whole-viewport and named-region pixel gates. No tolerance changed.
Chromium is 153.0.8010.12, with pinned fonts; GPU verification uses Mesa
llvmpipe. Maximum compiled table region MAE is **1.270 CPU / 2.396 GPU**.
The [machine-readable record](chromium-control-focus.json) contains source,
font/binary metadata references, commands, counts and report/log hashes.

The new direct suite has 21 reductions, two DPRs and six states per reduction:
**252 states**. It retains the original standards UA cases alongside explicit
border-box reductions that isolate paint. It includes readonly/disabled controls,
placeholder and authored outlines, multiline and Unicode text, overflow, opacity
with filter, clip-path, mask and negative outline offsets. Value, UTF-16 selection
endpoints and focus are compared independently of pixels.

The shared direct screenshot previously inherited Playwright's caret hiding.
It now requests a visible caret. These fixtures use `caret-animation:manual`
and assert the browser's computed value, preventing blink timing from deciding
the comparison. Baselines were rerun at Blitz `f0843274` with the same 252 input
hashes. Compiled conformance still intentionally makes carets transparent; its
table pixel pass does not certify caret rendering.

| Direct focus gate | Baseline | Current |
|---|---:|---:|
| Geometry | 144/252 | 144/252 |
| Hits | 252/252 | 252/252 |
| Editor value, selection and focus | 236/252 | 252/252 |
| Scroll metrics | 252/252 | 252/252 |
| Local pixels | 8/252 | 66/252 |

All 66 pixel passes are DPR 1. Every DPR 2 case still fails, including unfocused
input text, so focus palette alone cannot close that gap. The standards UA
cases retain content-box sizing/default-button border discrepancies. The boxed
textarea's control crop passes all six DPR 1 states, but its neighboring button
baseline keeps the full case failing. The Unicode reduction lacks emoji font
fallback. None of those cases was dropped or its reference output changed.

Selection actions cover UTF-16 scalar boundaries. Mid-surrogate offsets fail
explicitly, and native Rust strings cannot model lone surrogates. These internal
checks do not certify OS keyboard/IME delivery, bidi caret geometry or caret
blink timing. Authored `::selection`, dark/platform selection themes, multibox
outlines and complete focus fixup/fieldset behavior remain separate gates.

Compiled forms, measurement, scroll events, focus and focus fixup pass all three
gates in **22 CPU runs / 242 states**. The original 69 table states, 12
document-mode states, 148 scrolling states and 40 animation states retain their geometry/hit/scroll/pixel passes. Table-control,
integration, native-control, nested-inline and font-weight pass counts remain as
in the previous checkpoint. Broader border and glyph crops still fail.

The added editor observation exposes initial selection endpoints at the end of
`Edit text` (9,9) where Chrome has (0,0) in the older UA-font and table-control
reductions. Values and focus match. Editor states therefore pass 8/9 in
`controls.mjs` and 22/30 in `table-integration.mjs`; these newly observed failures
remain separate from the fully passing compiled focus cases.

Compiler tests pass **297**, including TypeScript checking; Rust workspace tests
pass **117** and Blitz paint **8**. Blitz DOM passes **49 and fails 2**:
`hover_styles_apply_and_clear` and `scroll_by_clamps_and_bubbles`, the same
failures reproduced at the earlier baseline. The new disabled-navigation test
passes. Manual and bounded read-only reviews covered selection paint order,
outline/effect clipping, disabled focus, the boolean attribute cache and oracle
scope. `/code-review` remains unavailable and is an incomplete stage.

## Next useful closures

First repair standards and quirks control box models and atomic-inline baselines
in Blitz layout/UA and Parley metrics. Keep default and authored styles side by
side, with inputs, textarea, buttons and checkables in table/flex/grid parents.
Then close DPR 2 text paint together with font optical sizing, synthesis and CSS
face ordering in their font/renderer owners. Nested inline measurement isolation
and scratch-layout reuse retain their existing correctness and performance gates.

The [targeted plan](../../docs/research/CHROMIUM-PARITY.md) records those owners
and acceptance cases. Table CPU/GPU fixture paint is closed in these worktrees;
shipping still requires reviewed reproducible dependency pins, remaining control
hits/layout and input/platform gates. The experiment does not establish general
Chromium equivalence or remove integrated compiler restrictions.
