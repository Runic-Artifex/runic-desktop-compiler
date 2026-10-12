# Fieldsets and legends (2026-10-12)

`<fieldset>` and `<legend>` in all three adapters, with Blitz fork commit
`5a047829` (*Lay out and paint a fieldset's rendered legend as Chromium does*).
Case `fieldset` (fixture `fieldset-svelte`), Chromium 153.0.8010.12, CPU renderer.

## Chromium behaviour measured and matched

| Behaviour (Chromium 153) | Blitz before | Now |
|---|---|---|
| The rendered legend is the first `legend` child that is neither floated nor absolutely positioned, also after other content; a second legend is ordinary content | first block of the content | construction puts it first among the layout children (`HAS_RENDERED_LEGEND`) |
| It leaves the content: no flex/grid gap after it, shrink-to-fit at `border + padding + margin` inline, auto margins align it, its block-start margin is ignored | full-width block in the flow, gap applied | `layout/fieldset.rs` |
| Centred over a block-start border thicker than its border box; the content starts at `max(border, legend end + margin-bottom)` | — | as measured (thick 10px border, 8px legend) |
| A definite height keeps its border box (content-box sizing too); an inline-block fieldset is at least as wide as its legend | — | as measured |
| The top border is painted through the legend's centre and cut out behind its border box, snapped to device pixels (legend 24..81.39 leaves pixels 24..80); background and shadows start at that border, the outline does not | border at the top, through the legend | paint: shortened decoration box and a border clip |
| UA border `2px groove rgb(239, 239, 239)` | `#c0c0c0` | UA sheet |
| `disabled`: descendants outside the first legend match `:disabled`, take no focus and no click (also programmatic), nested fieldsets too | — | rejected (none of the 12 examples uses it) |

## Results

`node conformance/run.mjs fieldset --pixels` and with `--no-opt` (identical):
semantics passed, geometry passed (0 differences over 5 steps at 800x600 and
420x600; 39 per step before), pixels *passed with a known gap*:

| Region MAE (/255, max over steps) | plain | field-set | label-set | thick | fancy | sized | shrink | page |
|---|---|---|---|---|---|---|---|---|
| before, 800x600 | 15.044 | 20.939 | 10.609 | 68.289 | 45.787 | 34.629 | 37.617 | 12.094 |
| now, 800x600 | 2.655 | 0.594 | 0.433 | 0.764 | 4.534 | 5.094 | 5.822 | 1.022 |
| now, 420x600 | 4.221 | 0.594 | 0.589 | 0.749 | 6.529 | — | — | 1.666 |
| now, all text transparent, 800x600 | 0.003 | 0.171 | 0.011 | 0 | 0.003 | 0.008 | 0.011 | 0.127 |

The remaining difference is text at fractional origins (the UA padding of
0.75em/0.35em at 14px), Blitz's open glyph rasterisation gap
([BLITZ-GAPS](../../docs/BLITZ-GAPS.md)): with every text transparent (a local,
uncommitted run), borders, the legend cutout, backgrounds and legend boxes are
within 0.011/255 (0.171/255 for the focused input). The shadcn-shaped regions,
at whole-pixel origins, pass.

Unit tests: blitz-dom 9 (Chromium geometry: UA legend, flex gap, thick
border, auto margins, legend after content and a second legend, floated
legend, definite height, inline-block width, grid), blitz-paint 2 (cutout
snapping). `tests/fieldset.test.mjs`: the rejections in Svelte, React, Vue
(own attribute and through rest props, spreads and forwarded fallthrough
attributes) and the validator.

## Census

`node conformance/triage.mjs <12 examples>` (the committed census had all 12
at `<fieldset> is outside the supported elements`, `ui/field/field-set.svelte:13`):
8 lower (field-choice-card, field-field-set-demo, field-input, field-radio,
field-responsive-layout-demo, field-textarea, radio-group-fieldset,
radio-group-invalid); field-checkbox, field-demo and field-field-group-demo
stop at `E_UNRESOLVED` `children is not a supported binding here`
(`ui/field/field-separator.svelte:16:32`); checkbox-group at
`E_TYPE_UNSUPPORTED` (bits-ui `checkbox.svelte:18:10`).

## Gaps

[PLATFORM](../../docs/gaps/PLATFORM.md#elements-p1): `disabled` on a
fieldset; inline-level legends, inline content on both sides of the legend,
`display: inline` and scrolling fieldsets (measured or not compared there).
