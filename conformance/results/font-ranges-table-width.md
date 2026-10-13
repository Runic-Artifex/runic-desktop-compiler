# `unicode-range` faces and automatic table width (2026-10-13)

Two Blitz gaps found by the shadcn-svelte render census, fixed in the forks on
branches `font-ranges-table-width`:

- Parley `d5448d58` *Select @font-face faces by unicode-range as Chromium
  does* and `a0f206ed` *Reverse @font-face faces within a segmented face, by
  their rules* (on `runic-chromium-parity` `916091e3`):
  fontique/src/charmap.rs, fontique/src/collection/query.rs,
  fontique/src/font.rs.
- Blitz `a29568ea` *Select unicode-range faces and distribute automatic table
  width as Chromium does* and `fe8a1b28` *Order @font-face faces by their
  rules, not by when they load* (on `runic` `6583c042`): blitz-dom
  document.rs, font_metrics.rs, layout/table.rs, net.rs.

Chromium 153.0.8010.12, CPU renderer. Sources: CSS Fonts 4 (first available
font; `unicode-range` and the order of a family's faces), Blink's
`CSSSegmentedFontFace::GetFontData` and
`FontFallbackList::DeterminePrimarySimpleFontDataCore`; CSS Tables 3 (width
distribution) and Blink's `table_layout_utils.cc`
(`CreateCellInlineConstraint`, `CellInlineConstraint::Encompass`,
`Column::Encompass`, `DistributeInlineSizeToComputedInlineSizeAuto`). The
expected values of the fork tests are Chromium's measurements.

## Cases

`node conformance/run.mjs font-subsets table-width --pixels` (800x600,
420x600, 3 steps each):

| Case | Previous pins | These pins | Page MAE (/255) | Largest region MAE (/255) |
|---|---|---|---|---|
| `font-subsets` (fontsource's Geist Variable: cyrillic, latin-ext and latin faces in the package's order; inputs at the default size, `size=1`, `size=2`; Latin, Latin Extended, Cyrillic and mixed text) | geometry and pixels fail: 15 differences, the inputs 205 / 50 / 59 px wide in Chromium, 161 / 28 / 35 natively | all gates pass, 0 geometry differences | 0.153 / 0.292 | `latin` 1.636 / 2.149 |
| `table-width` (a 100px head in a 100%, automatic and 260px table; two length columns only; a 25% column; a `<col>` width) | geometry and pixels fail: 27 differences, the invoices' first column 116 px in Chromium, 243.3 natively | all gates pass, 0 geometry differences | 0.119 / 0.226 | `invoices` 1.016 / 1.016 |

The fixtures keep two unrelated workarounds, recorded in
[BLITZ-GAPS](../../docs/BLITZ-GAPS.md): the text inputs have an explicit
`line-height` (Blitz's `line-height: normal` for text inputs), and the table
rows have borders and the cells padding instead of a cell `height` (a
collapsed-border cell 26 px tall natively, 26.5 px in Chromium). The
`font-subsets` text has no character outside the three subsets (Chromium
draws one in a system font).
