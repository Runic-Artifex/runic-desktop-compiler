// Tight text regions across sizes, fractional origins and device scales. These
// retain raster and inline-layout failures independently of table formatting.
import { runRenderingCases } from './harness/rendering.mjs';
const cases = {};
for (const size of [12, 14, 16, 24])
  for (const x of [-0.125, 0.375, 0.875]) {
    const name = `glyph_${size}_${x < 0 ? 'negative' : x === 0.375 ? 'middle' : 'carry'}`;
    cases[name] = {
      suite: 'glyphs',
      regions: ['table'],
      viewports: [
        [420, 180, 1],
        [420, 180, 1.25],
        [420, 180, 2],
      ],
      html: `<div id="table" style="display:inline-block;margin-left:${x}px;padding:4px;font-size:${size}px;line-height:${size * 1.25}px">Empty table AgpqQ MW</div>`,
    };
  }
cases.glyph_arabic = {
  suite: 'glyphs',
  regions: ['table'],
  viewports: [
    [420, 180, 1],
    [420, 180, 2],
  ],
  html: '<div id="table" dir="rtl" style="display:inline-block;padding:4px;font:16px/20px Test">ترجمة Alpha 123</div>',
};
await runRenderingCases(cases, {}, 'glyphs');
