# text-wrap: pretty (2026-10-13)

`text-wrap: pretty` (`text-wrap-style: pretty`) laid out natively, with the
fork commits on branches `text-wrap-pretty`:

- Stylo `6570a3ba` *servo: Parse text-wrap-style: pretty* (on `851fe6e3`);
- Parley `7e728565` *Lay out text-wrap-style: pretty as Chromium does* (on
  `a0f206ed`);
- Blitz `a68234df` *Lay out text-wrap-style: pretty with Parley's score line
  breaker* (on `fe8a1b28`).

Before, Stylo's servo mode dropped `pretty`, and the app reported the
declaration once its rule matched an element. Case `text-wrap-pretty`
(fixture `text-wrap-pretty-svelte`, no Tailwind), Chromium 153.0.8010.12, CPU
renderer.

## Chromium's algorithm

Blink's `LineBreakStrategy` (`inline_layout_algorithm.cc`) uses the score line
breaker for every paragraph of a block container whose own
`text-wrap-style` is `pretty` (an inline's value is ignored), unless the block
has a preserved tab, ruby, `initial-letter`, a `line-clamp` ellipsis or
`::first-line` (`IsScoreLineBreakDisabled`; the last four are reported or
rejected by the compiler already):

1. `ScoreLineBreaker::OptimalBreakPoints` (`score_line_breaker.cc`) keeps the
   greedy lines in a window of at most four (`kMaxLinesForOptimal`) that
   slides to the paragraph's end (a forced break or the end of the text), so
   only the last four lines of a paragraph are rebroken. A single-line
   paragraph, or one with a line that overflows, uses `break-spaces` or clones
   box decorations, keeps its greedy lines.
2. `ShouldOptimize`: only if the greedy last line is shorter than a third of
   the available width (in layout units) and has no break opportunity inside
   (or after two hyphenated lines; Parley does not hyphenate).
3. `Optimize` scores the window's break opportunities (at least three) as for
   `balance`, but the last line has no slack score, only four times the
   penalty of the opportunity it starts at, which includes the orphan penalty
   of 10000 x zoom; a line penalty of 4 x available width x font size / zoom
   (none when justified); the first line's indent narrows its width when the
   window starts the paragraph. The best breaks are used only if they keep the
   number of lines.

## Results

At the previous pins (Stylo `851fe6e3`, Parley `a0f206ed`, Blitz `fe8a1b28`)
both runs stop at mount: *the CSS declaration text-wrap: pretty (style.css,
line 9), which Blitz's style engine (Stylo) does not support, applies to an
element matching .pretty* (semantics, geometry and pixels incomplete).

At the new pins, `node conformance/run.mjs text-wrap-pretty --pixels`
(800x600, 420x600): semantics passed, geometry passed (0 differences over 7
steps), pixels passed:

| Region MAE (/255, max over steps) | heading | fox | long | one | justify | indent | forced | preserved | inline | longhand | narrow | span-only | dynamic | page |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 800x600 | 0.626 | 1.441 | 1.675 | 1.063 | 1.503 | 1.285 | 1.989 | 1.124 | 1.923 | 1.512 | 1.419 | 1.475 | 1.455 | 0.799 |
| 420x600 | 0.782 | 1.509 | 1.652 | 1.396 | 1.959 | 1.688 | 1.549 | 1.535 | 1.647 | 1.494 | 1.419 | 1.93 | 1.43 | 1.285 |

Chromium breaks 7 of the fixture's 12 pretty paragraphs differently from
greedy wrapping at 800px (heading, fox, justify, indent, forced, preserved,
dynamic) and 7 at 420px (heading, fox, long, justify, forced, inline,
longhand; dynamic after the sample changes), checked with the fixture's markup
and `text-wrap-style: auto` forced; at 420px the long paragraph's first four
lines stay greedy and `forced` changes its second paragraph, at 800px its
first. The last word of each paragraph has an id, so the geometry gate
compares where the lines break; the last two steps scroll so that every
region is captured.

Unit tests with Chromium 153's lines: Parley `tests/test_pretty.rs` (10, in
Roboto: one, two, three and ten lines, a two-word or long last line (greedy),
two paragraphs, `text-indent`, justify, `pre-wrap`, `break-spaces`, a
preserved tab, overflow, a device pixel ratio of 2), checked beforehand
against a sweep of 2709 widths (120-420px) over nine texts in Chromium without
a difference in the pretty lines (7 widths where Parley's greedy lines already
differ at an exact boundary were skipped); blitz-dom `layout/inline.rs` (6, in
DejaVu Sans: three to seven lines, the last four of a long paragraph, forced
breaks, a long last line greedy, a device pixel ratio of 2, a span's style
ignored, `stable` greedy).

## Census

`node conformance/render-census.mjs alert-action alert-basic alert-colors
alert-demo alert-destructive empty-background-demo` (the six examples that
stopped at `text-wrap: pretty` after `balance` was laid out; 800x600, the
site's view): all six lower and match Chromium (semantics, geometry and
pixels; whole-page MAE 0.05-0.11/255 for the alerts, 0.60/255 for
empty-background-demo). style-vega's `.cn-alert-description` is
`text-balance md:text-pretty`, so the alerts are now laid out with `balance`
below `md` and `pretty` above it without a report.

Cases rerun with `--pixels` at these pins: text-wrap-pretty, text-wrap-balance,
capitalize, text-elements (Svelte, React, Vue), forms, shadcn-basics, kit-docs
and tailwind: semantics and geometry passed in all 19 runs, pixels passed or
passed with the cases' known gaps (capitalize, text-elements).

## Gaps

[BLITZ-GAPS](../../docs/BLITZ-GAPS.md) (`text-wrap`),
[PLATFORM](../../docs/gaps/PLATFORM.md#css-and-rendering-p4): Chromium breaks
a text area's text prettily, Blitz does not (reported where a pretty rule
reaches a text area; rejected on `::placeholder`); not modelled: hyphenation
(and with it `pretty`'s rule for two hyphenated last lines) and Blink's
per-item layout-unit snapping; not measured: a block inside an inline, floats
beside the text and preserved trailing spaces in the short-last-line test.
