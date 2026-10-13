# Auto-height column flex containers and text input content height (2026-10-13)

Two fork commits, found through the render census's input groups with a block
addon (input-group-textarea-demo, input-group-block-end,
input-group-block-start):

- Taffy `e767d037` *Flexbox: size an auto-height column by its items'
  hypothetical main sizes* (branch `flex-scroll-min` on `runic` `e7be3d5`);
- Blitz `a12c37e3` *Size single-line text inputs by their inner editor's
  line* (branch `flex-input-basis` on `runic` `fa7be703`).

Case `column-flex-intrinsic` (fixture `column-flex-intrinsic-svelte`, no
Tailwind), Chromium 153.0.8010.12, CPU renderer.

## Chromium's rules

- **Column intrinsic size.** Blink's `FlexLayoutAlgorithm::PlaceFlexItems`
  takes a column's intrinsic block size as its lines' largest sum of outer
  hypothetical main sizes (`max_sum_hypothetical_main_size`): flex base sizes
  clamped by the used min and max main sizes, a scroll container's automatic
  minimum being 0. This is not css-flexbox-1 §9.9.1: an item with
  `flex: 1 1 50px; min-height: 0` and 100px of content makes a 400px column
  with a 1px border 102px tall in Chromium (§9.9.1: 152px). Taffy took a
  growing scroll container's flex base size without its min and max sizes and
  other items' unclamped max-content sizes, so a `flex: 1 1 0%` text area with
  `min-height: 64px` overflowed its column. Rows
  (`ComputeMinMaxSizeOfRowContainer`) are unchanged; their scroll-container
  difference stays open in BLITZ-GAPS.
- **Text input content height.** Blink's
  `TextControlInnerEditorElement::CreateInnerEditorStyle` makes the
  single-line editor's line height `normal` when the input's is at most its
  font size, or its `height` is a percentage or a length above its line
  height. The input's intrinsic block size is that line (Chromium rounds the
  font's ascent and descent: 16px for 14px DejaVu Sans, 21px for 18px). Blitz
  applied the rule to the editor but sized the input by its own line height,
  so `height: 36px; line-height: 20px` with a content flex basis stayed 36px
  where Chromium makes it 32px (the census inputs: 36px for 34px).

The forks' tests (18 Taffy cases; 72 inputs and a text area in a column in
Blitz) use values measured in the harness's Chromium.

## Results

At the previous pins (Taffy `e7be3d5`, Blitz `fa7be703`, Stylo `6d580873`),
`node conformance/run.mjs column-flex-intrinsic --pixels` (800x600, 420x600):
semantics passed, geometry failed (190 differences over 13 steps per
viewport), pixels failed. At mount, 800x600:

| Element | Chromium | Native (previous pins) |
|---|---|---|
| comment-group (text area, `field-sizing: content`, `min-height: 64px`) | 102 | 82 |
| query, name (text inputs, `height: 36px`, content flex basis) | 32 | 36 |
| scroll-group (growing scroller below its min-height, two above their max-height) | 154 | 186 (min-scroller 88 for 56) |
| basis-group (`flex: 1 1 24px; min-height: 0`, three lines) | 26 | 62 |
| page height | 688 | 744 |

At the new pins: semantics passed, geometry passed (0 differences over 13
steps), pixels passed, at both viewports:

| Region MAE (/255, max over steps) | comment | end | start | fixed | scroll | basis |
|---|---|---|---|---|---|---|
| 800x600 | 0.214 | 0.154 | 0.156 | 0.088 | 0.076 | 0.161 |
| 420x600 | 0.281 | 0.202 | 0.204 | 0.115 | 0.1 | 0.212 |
| previous pins, 800x600 | 5.807 | 13.856 | 14.869 | 14.761 | 6.646 | 35.214 |

Render census of all 264 lowered examples at the new pins (compiler
`1d51294`; the first 50 examples ran at `88d1478` with the same pins): 249
match Chromium, 15 report unsupported features, none differ. Against each
example's latest previous result, input-group-textarea-demo,
input-group-block-end and input-group-block-start went from differs to
matches. attachment-states (matches to reportsUnsupported:
`-webkit-text-fill-color` of the `shimmer` utility) and message-attachment
(differs to matches) were last censused on 2026-10-12 with their
attachment, bubble and message classes unstyled; at main's pins they give
the same statuses as at the new ones, so the change is the hosts', not this
one. The other 259 are unchanged.

Conformance regression set at the new pins (the 97 cases whose fixtures use
column flex containers or text controls, and `line-clamp`; 280 runs, both
viewports, `--pixels`): semantics and geometry pass; pixels pass with the
cases' declared known gaps only (bits-toggle-group at 420px, fieldset).
