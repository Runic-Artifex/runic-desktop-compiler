# field-sizing: content (2026-10-13)

`field-sizing: content` laid out natively, with the fork commits on branches
`field-sizing`:

- Stylo `0d9bd3a3` *servo: Parse field-sizing* (on `runic` `6570a3ba`);
- Blitz `f0d37faa` *Size text controls by their content (field-sizing:
  content)* and `cf0bff64` *Clip a text area's text at its padding box* (on
  `runic` `a68234df`).

Before, Stylo's servo mode dropped `field-sizing`, and the app reported the
declaration once its rule matched an element. Case `field-sizing` (fixture
`field-sizing-svelte`, no Tailwind), Chromium 153.0.8010.12, CPU renderer.

## Chromium's sizing

From Blink at 153.0.8010.12 (`layout_box.cc`, `block_node.cc`,
`block_layout_algorithm.cc`, `text_control_inner_elements.cc`,
`computed_style.cc`, `html.css`): a control with `field-sizing: content`
(and not autofilled, `ApplyControlFixedSize`) has an indefinite default
intrinsic inline and block size, so its inner editor sizes it: the text's
min- and max-content widths, or the placeholder's while it is shown, the
inner editor at least `min-width: BarCaretWidth()` (1px). A text area wraps
at the width it gets (fit-content when automatic) and is as tall as its
lines; `rows`, `cols` and `size` are ignored and min and max sizes clamp. A
percentage width zeroes the min-content contribution of fixed-size controls
only (`ContentMinimumInlineSize`). Text areas are `white-space: pre-wrap;
overflow-wrap: break-word`, a single-line inner editor `white-space: pre`.

Sizes measured in this Chromium (DejaVu Sans 16px, no padding or border,
inputs with `line-height: 20px`) are the expected values of the 8 blitz-dom
tests: an empty input 1×20, "Hello world" 89.703125×20, a placeholder
130.15625×20 while shown, `size=40` ignored, min-, max- and fixed widths, a
flex item, an empty text area 1×19, two lines 137.015625×38, `rows`/`cols`
ignored, wrapping at 200px (200×57), a long word broken at 100px (100×38),
max-height 40 (42.328125×40), trailing and inner spaces (35.21875), and
typing that grows and shrinks a text area (30, 38, 57, 38, 30) and an input
(47.203125, 20, 200, 47.203125).

## Results

`node conformance/run.mjs field-sizing --pixels` (800x600, 420x600): an input
with a placeholder and min/max widths, typed into past its max-width and
cleared; an email input in a flex row; an empty text area typed into
(three letters, a new line, two letters) and back; a text area with a
percentage width, a min-height and a wrapping placeholder, typed into and
cleared; `rows` and `cols` under a max-width; a max-height with hidden
overflow; a min-width and min-height; a class switch to `field-sizing:
fixed` and back. 19 steps per viewport.

At the new pins: semantics, geometry (0 differences) and pixels passed.

| Region MAE (/255, max over steps) | name-row | email-row | notes-box | message-box | wide-box | limited-box | toggled-box | page |
|---|---|---|---|---|---|---|---|---|
| 800x600 | 2.034 | 1.049 | 0.281 | 0.372 | 0.394 | 0.332 | 0.383 | 0.182 |
| 420x600 | 2.672 | 1.378 | 0.369 | 0.489 | 0.518 | 0.436 | 0.503 | 0.346 |

At the previous pins (Stylo `6570a3ba`, Blitz `a68234df`) both runs stop at
mount with the run-time report (*field-sizing: content ... which Blitz's
style engine (Stylo) does not support*): incomplete.

The fixture works around three gaps that are not `field-sizing`'s
([BLITZ-GAPS](../../docs/BLITZ-GAPS.md)): explicit line heights (*Text input
line height*), an explicit width for the fixed state (*Textarea default
width*: Blitz 314px, Chromium 174px) and the email input at a whole-pixel x
(*Text input text at a fractional x*: its text about 0.4px left of
Chromium's, the row at 3.118/255). Typed text uses dictionary words:
Chromium marks a misspelt selected word with a spelling squiggle Blitz does
not draw.

Regression cases with `--pixels`, all gates passed: `forms`, `forms-react`,
`forms-vue`, `blitz-placeholders`, `blitz-control-line-height`, `select`,
`shadcn-basics`, `font-subsets`, `text-wrap-balance`, `text-wrap-pretty`.

## Render census

`node conformance/render-census.mjs` on the 12 shadcn-svelte examples the
[render census](shadcn-svelte-render-census.md) stopped at `field-sizing:
content` (the site's view, 800x600): all 12 lower and none reports. 9 match
Chromium: field-textarea, input-group-custom-input-demo,
input-group-text-demo, spinner-input-group-demo, textarea-button,
textarea-demo, textarea-disabled, textarea-field and textarea-invalid.

3 differ, each an input group with a block-end or block-start addon
(`flex-col`, automatic height) that is shorter than Chromium's:

| Example | Geometry differences | Page MAE | `#demo` MAE |
|---|---|---|---|
| input-group-textarea-demo | text area 82px low | 3.312 | 5.495 |
| input-group-block-end | 4 (13–15px low; the input 36px high, Chromium 34) | 2.689 | 4.462 |
| input-group-block-start | 4 (13–15px low; the input 36px high, Chromium 34) | 2.225 | 3.691 |

Neither cause is `field-sizing`'s ([BLITZ-GAPS](../../docs/BLITZ-GAPS.md)):

- *Growing scroll containers in an auto-height column flex container*:
  Taffy leaves a growing text area's min-height out of the container's
  height, so the group is the text area's content height plus the addon and
  the text area overflows it. In Chromium 153 a 400px column with a 1px
  border, a text area (`flex: 1 1 0%; min-height: 64px`, 8px padding, 14px
  DejaVu Sans, 20px lines) and a 50px block is 132px high with either
  sizing; Blitz gives 108px with `field-sizing: fixed` and 88px with
  `content` (a block in the text area's place: 132px in both).
- *Text input as a flex item with a content flex basis*: the inputs of the
  block-end and block-start groups (`flex-1`, `h-9`) keep their 36px height
  where Chromium sizes them by their content (34px).
