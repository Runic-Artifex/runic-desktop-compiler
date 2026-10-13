# -webkit-line-clamp (2026-10-13)

Tailwind's `line-clamp-N` (`overflow: hidden; display: -webkit-box;
-webkit-box-orient: vertical; -webkit-line-clamp: N`) laid out natively, with
the fork commits on branches `line-clamp`:

- Stylo `6d580873` *servo: Parse -webkit-line-clamp, -webkit-box-orient and
  display: -webkit-box* (on `runic` `0d9bd3a3`);
- Blitz `fa7be703` *Lay out -webkit-line-clamp as Chromium does* (on `runic`
  `cf0bff64`).

Before, Stylo's servo mode dropped all three declarations, and the app
reported them once their rule matched an element. Case `line-clamp` (fixture
`line-clamp-svelte`, no Tailwind), Chromium 153.0.8010.12, CPU renderer.

## Chromium's line clamp

From Blink at 153.0.8010.12 (`style_adjuster.cc`,
`block_layout_algorithm.cc`, `line_clamp_data.h`,
`inline_layout_algorithm.cc`, `line_truncator.cc`,
`runtime_enabled_features.json5`): `CSSLineClamp` is experimental, so 153
runs the legacy clamp. A `-webkit-box` (`-webkit-inline-box`) with
`-webkit-box-orient: vertical` and a clamp count computes to `flow-root`
(`inline-block`). Its non-empty line boxes are counted through in-flow
blocks of its formatting context; lines of nested formatting contexts and
block-in-inline lines are not. If the formatting context has more content
after the clamp line, the line is truncated (`…` in the line's primary font,
after the content when it fits, else replacing what passes the content edge
less its width, at least one character kept), and every block in which the
clamp point has been passed ends at the line or child that passed it plus its
block-end border and padding (the root, the blocks around the clamp line and
those after it), unless its block size is fixed. Later content is laid out
after them, clipped by `overflow` and kept in the scrollable overflow. If
nothing follows, the box is laid out again without a clamp.

Geometry measured in this Chromium (DejaVu Sans 16px, 20px lines, 200px
wide) gives the expected values of the 11 blitz-dom tests: two of fifteen
words' four lines in padding and a border (52px, ellipsis after `te` of
`ten`, scroll height 90), two and exactly three lines under a clamp of three
(40, 60), a line ending at `<br>` (ellipsis after `four`), nested blocks with
padding, margins and borders (88px, children at 12, 52 and 92), a block or an
empty block after the clamped one (56) or none (66, unclamped), a flow-root
whose lines do not count (100), a taller inline-block on the first line (55),
blocks past the clamp point shortened to their first line or child (30px
with their padding and border, 20px without; scroll heights 90, 100 and 80), `height`, `min-height` and `max-height` (70,
70, 30, 50), a column flex item (52, next item at 60), `overflow: visible`
(52), and a `-webkit-inline-box` (800×40). Derived from those measurements
rather than measured as such: `display: flex` and a horizontal box are not
clamped (80, the scroll height of the four lines), the heights after text
changes, and the run-time reports.

## Results

`node conformance/run.mjs line-clamp --pixels` (800x600, 420x600): clamps of
one, two and three lines (truncating mid-word at 420px), a card with padding
and a border, a text shorter than its clamp, and a two-line clamp through
nested blocks (a title, the text, a block after the clamp); the text changed
to a short one and back, at the full width and at 70% of it. 7 steps per
viewport.

At the new pins: semantics, geometry (0 differences) and pixels passed.

| Region MAE (/255, max over steps) | one-box | two-box | three-box | short-box | nested-box | page |
|---|---|---|---|---|---|---|
| 800x600 | 1.716 | 1.231 | 1.719 | 0.642 | 0.885 | 0.268 |
| 420x600 | 1.767 | 1.240 | 1.628 | 0.846 | 0.914 | 0.444 |

At the previous pins (Stylo `0d9bd3a3`, Blitz `cf0bff64`) both runs stop at
mount with the run-time report (*display: -webkit-box ... which Blitz's
style engine (Stylo) does not support*): incomplete.

Regression cases with `--pixels`, all gates passed: `blitz-ellipsis`,
`text-wrap-balance`, `text-wrap-pretty`, `tailwind`, `shadcn-basics`,
`kit-docs`, `forms`.

## Reported

Blitz reports, when it constructs or lays out such boxes, the forms it does
not lay out as Chromium does ([BLITZ-GAPS](../../docs/BLITZ-GAPS.md),
*`-webkit-line-clamp` beyond the measured forms*): a `-webkit-box` without
vertical orientation and a clamp count (Chromium's legacy flexible box), a
clamp root that is a button, right-to-left or not start-aligned clamp lines,
atomic inlines after the ellipsis, an ellipsis in a block without text of its
own, shortened blocks with a collapsing end margin or a percentage block
size, and out-of-flow boxes past the clamp point. The compiler reports
`-moz-box-orient`, which Stylo applies and Chromium ignores, where its rule
matches; the standard `line-clamp` stays dropped and reported.

## Render census

`node conformance/render-census.mjs` on the 8 shadcn-svelte examples the
[render census](shadcn-svelte-render-census.md) stopped at
`-webkit-line-clamp` (the site's view, 800x600): all 8 lower, none reports,
and all 8 match Chromium (page MAE 0.060–0.149, `#demo` 0.099–0.247):
item-avatar-demo, item-demo, item-icon-demo, item-link-demo, item-size-demo,
item-variants-demo, spinner-demo and spinner-item-demo. Their clamped texts
are short single sentences (item descriptions, spinner-demo's item title);
the case above covers truncation.
