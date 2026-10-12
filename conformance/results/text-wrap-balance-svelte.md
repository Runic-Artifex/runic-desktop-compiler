# text-wrap: balance (2026-10-13)

`text-wrap: balance` (`text-wrap-style: balance`) laid out natively, with the
fork commits on branches `text-wrap-balance`:

- Stylo `851fe6e3` *servo: Parse text-wrap-style and the text-wrap shorthand*
  (on `568059da`);
- Parley `916091e3` *Balance lines as Chromium lays out text-wrap-style:
  balance* (on `13cfb744`);
- Blitz `e858fae2` *Lay out text-wrap: balance as Chromium does* (on
  `1b1525b2`).

Before, Stylo's servo mode dropped `text-wrap-style` and the `text-wrap`
shorthand, and the app reported the declaration once its rule matched an
element. Case `text-wrap-balance` (fixture `text-wrap-balance-svelte`, no
Tailwind), Chromium 153.0.8010.12, CPU renderer.

## Chromium's algorithm

Blink's `LineBreakStrategy` (`inline_layout_algorithm.cc`) balances the block
container's lines when its own `text-wrap-style` is `balance` (an inline's
value is ignored), from the first line:

1. `ScoreLineBreaker::BalanceBreakPoints` (`score_line_breaker.cc`): the greedy
   lines of the first paragraph (up to a forced break), none if one overflows,
   uses `break-spaces` or does not end within six lines, and none for a single
   line. The break opportunities (at least three besides the start) are scored
   by the square of each line's slack against the available width (less the
   first line's indent), divided by the zoom; a line penalty of 4 x available
   width x font size / zoom (none when justified) and an orphan penalty of
   10000 x zoom before the last opportunity. The best breaks are used only if
   they keep the greedy line count.
2. Otherwise `ParagraphLineBreaker::AttemptParagraphBalancing`
   (`paragraph_line_breaker.cc`), without forced breaks, floats or overflow,
   if the text's length over the spaces that fit a line is at most 12: the
   narrowest width,
   bisected from 80 % of the average line width to the available width in
   steps of a layout unit times the zoom, at which the paragraph breaks into
   the same number of lines (at most six).

Lines are broken at the chosen breaks or width and aligned within the
available width. `stable` breaks greedily, as `auto` (`ShouldWrapLineGreedy`).

## Results

`node conformance/run.mjs text-wrap-balance --pixels` (800x600, 420x600):
semantics passed, geometry passed (0 differences over 5 steps), pixels
passed:

| Region MAE (/255, max over steps) | heading | fox | bisect | one | justify | indent | forced | inline | longhand | span-only | dynamic | page |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 800x600 | 0.621 | 1.367 | 1.244 | 1.258 | 1.518 | 1.363 | 1.743 | 1.846 | 1.225 | 1.513 | 1.321 | 0.594 |
| 420x600 | 0.816 | 1.795 | 1.244 | 1.653 | 2.002 | 1.791 | 1.522 | 1.41 | 1.609 | 2 | 1.735 | 1.117 |

Chromium breaks 8 of the fixture's 10 balancing paragraphs differently from
greedy wrapping at 800px and 7 at 420px (the others are one line, already
balanced, or the control `span-only`), checked with the fixture's markup and
`text-wrap-style: auto` forced. The last word of each paragraph has an id,
so the geometry gate compares where the lines break.

Unit tests with Chromium 153's lines: Parley `tests/test_balance.rs` (12, in
Roboto: one, two, three and six lines balanced, seven greedy, two
opportunities bisected, two paragraphs, `break-spaces`, overflow,
`text-indent`, justify, alignment), blitz-dom `layout/inline.rs` (5, in DejaVu
Sans: two and three lines, a device pixel ratio of 2, the bisection, a span's
style ignored, `pretty` and `stable` greedy).

## Census

`node conformance/render-census.mjs <15 examples>` (the committed render
census had all 15 at `text-wrap: balance`; 800x600, the site's view): all 15
lower; 8 match Chromium (empty-avatar-demo, empty-avatar-group-demo,
empty-demo, empty-input-group-demo, empty-outline-demo, spinner-empty-demo,
typography-demo, typography-h1); 7 report unsupported: the five alert
examples and empty-background-demo at `text-wrap: pretty` (style-vega's
`.cn-alert-description` is `text-balance md:text-pretty`, and 800px is above
`md`; empty-background-demo uses `text-pretty`), and
toggle-group-font-weight-selector at a rounded border on an ordinary inline
box.

Text-heavy cases rerun with `--pixels` at these pins: text-elements (Svelte,
React, Vue), capitalize, blitz-line-breaks, blitz-ellipsis,
blitz-inline-baselines, kit-docs, kit-docs-narrow, tailwind, shadcn-basics,
pricing, style-objects and fieldset: semantics and geometry passed in all 26
runs, pixels passed or passed with the cases' known gaps (capitalize,
fieldset, text-elements).

## Gaps

[BLITZ-GAPS](../../docs/BLITZ-GAPS.md) (`text-wrap`),
[PLATFORM](../../docs/gaps/PLATFORM.md#css-and-rendering-p4): Chromium balances
a text area's text, Blitz does not (reported where a balancing rule reaches a
text area; rejected on `::placeholder`); `pretty` stays reported; not
modelled: hyphenation and Blink's per-item layout-unit snapping; not measured:
a block inside an inline, floats beside the text and preserved trailing spaces
in the bisection.
