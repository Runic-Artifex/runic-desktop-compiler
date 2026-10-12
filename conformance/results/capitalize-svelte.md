# text-transform: capitalize (2026-10-12)

`text-transform: capitalize` laid out natively, with Blitz fork commits
`75a33515` (*Lay out text-transform: capitalize as Chromium does*) and
`1b1525b2` (*Reset text-transform on form controls as Chromium's UA sheet
does*). Before, the compiler rejected `capitalize` (`E_CSS_PROPERTY`). Case
`capitalize` (fixture `capitalize-svelte`, no Tailwind), Chromium
153.0.8010.12, CPU renderer.

## Chromium behaviour measured and matched

Blink's `Capitalize` (`platform/text/capitalize.cc`; Chromium 153 runs
`CapitalizeWithPreviousCodeUnit`, the supplementary-character fix being off):

| Behaviour (Chromium 153) | Examples (source → laid out) |
|---|---|
| Words as ICU segments them, after the previous character; the first UTF-16 code unit of each word to its simple titlecase; other letters unchanged | `HELLO wORLD mIxEd` → `HELLO WORLD MIxEd` |
| Full stops and colons break words (unlike UAX #29); apostrophes, digits and underscores join | `e.g.` → `E.G.`, `a:b` → `A:B`, `don't` → `Don't`, `rock'n'roll` → `Rock'n'roll`, `3rd` and `12abc` unchanged, `x2y` → `X2y`, `1-a` → `1-A`, `baz_qux` → `Baz_qux` |
| No simple titlecase: unchanged; digraphs to their titlecase | `ß`, `ﬁ`, `ŉ`, `ǰ`, `ΐ` unchanged; `ǆ`, `Ǆ` → `ǅ`; `ı` → `I`; Georgian unchanged; Greek with ypogegrammeni to prosgegrammeni |
| A supplementary first letter is unchanged, and as the previous character it breaks the word (one code unit) | Deseret `𐐨` unchanged |
| No-break spaces separate words and stay; soft hyphens, ZWJ and ZWNJ join; ZWSP breaks | `a b` → `A B` |
| Classes ICU gives differently from UAX #29, every code point up to U+1FFFF and the tags block (`a{c}b`, `{c}b`, `1{c}b`): `.`, `:`, U+FE55, U+FF0E, U+FF1A break; Thai, Lao, Myanmar, Khmer, Tai and Ahom letters join as letters; Hangul syllables, U+3005, U+303B, U+16FE3, U+16FF0–1 break | 0 mismatches against the implementation |
| The previous character is the previous text's last code unit, across inline elements (`LayoutText::PreviousCharacter`) | `<b>a</b>bc` → `Abc`; `don'<b>t</b>` → `Don'T`; `don<b>'t</b>` → `Don't` |
| Line breaks: a `<br>` and wrapping | `abc<br>def` → `Abc` / `Def`; wrapped `bbb-ccc` → `Bbb-` / `Ccc` |
| Atomic inlines end with their last text, other boxes are a space, out-of-flow boxes without text are passed through | `abc<ib>x</ib>def` → `AbcXdef`, empty inline-block → `AbcDef`, `<input value=x>` → `Abcd`, placeholder → `AbCd`, empty float → `AbCd`, empty `position: absolute` → `Abcd`, `<svg>` → `AbCd`, `<wbr>` → `Abcd`, `<button>x</button>` → `Abxcd` |
| White space texts Blink lays out nothing for do not reset the word | absolutely positioned `x`, ` `, `<b>cd</b>` → `X` / `cd` |
| `text-transform: none` and `uppercase` text among capitalized text precedes it as laid out | `<none>ab</none>cd` → `abcd` |
| Copying (Ctrl+C) gives the source text, for `capitalize`, `uppercase` and `lowercase`; `innerText` and `Selection.toString()` the transformed text | — |
| Form controls do not inherit it (UA `text-transform: none`; an author rule on the control applies) | `ab<button>x</button>cd` in a `capitalize` paragraph → `Abxcd` |

## Results

`node conformance/run.mjs capitalize --pixels` and with `--no-opt` (identical):
semantics passed, geometry passed (0 differences over 6 steps at 800x760 and
420x900), pixels *passed with a known gap*:

| Region MAE (/255, max over steps and viewports) | boundaries | cases | scripts | split | boxes | boxes-control | dynamic | toggled | page |
|---|---|---|---|---|---|---|---|---|---|
| now | 0.997 | 1.46 | 1.694 | 2.799 | 3.636 | 3.637 | 2.305 | 2.189 | 0.441 |

`boxes-control` writes the `boxes` row out in capitals without
`text-transform`, with the same inline-blocks: its error is the same, so the
3.6/255 is not the transform. The inline-blocks' backgrounds cover the same
device pixels in both; a few glyphs beside them are up to 0.3px left of
Chromium's by ink centroid (Blitz's open glyph rasterisation gap,
[BLITZ-GAPS](../../docs/BLITZ-GAPS.md)).

`bits-toggle-group-single` uses toggle-group-spacing's `capitalize` labels
again (Tailwind generates the utility): passed, pixels included.

Unit tests (blitz-dom, `layout/text_transform.rs`, expected text from
Chromium): word boundaries and case, words across inline elements, the last
text of boxes (inline-block, button, text input, password), copied text,
text changes.

## Census

`node conformance/triage.mjs <6 examples>` (the committed census had all six
at `text-transform: capitalize`): 4 lower (popover-alignments,
toggle-group-sizes, toggle-group-spacing, tooltip-sides); hover-card-sides
stops at `E_PACK` (svelte-toolbelt's DOMContext pack has no `getDocument()`,
bits-ui `link-preview.svelte.js:49`), sheet-side at `E_TEMPLATE` `{#each}
requires an array` (`examples/sheet-side.svelte:22`).

## Gaps

[BLITZ-GAPS](../../docs/BLITZ-GAPS.md), [PLATFORM](../../docs/gaps/PLATFORM.md#css-and-rendering-p4):
`full-width` and `full-size-kana` (rejected); Chromium keeps a text's
capitalization when the text before it changes (`<b>a</b>bc`, the `<b>` set to
`a `: Chromium `A bc`, Blitz `A Bc`); the previous character after a broken
image (Chromium: its alt text), a `<select>`, button and file inputs; text
input and text area values are never transformed.
