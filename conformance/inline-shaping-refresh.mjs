// Pure alignment restyles retain shaped text while refreshing line metrics.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 220, dpr]);
const base = 'margin:20.375px;width:178px;font:24px/32px Test;font-feature-settings:"liga" 1';
for (const [name, initial, next, content] of [
  ['zero_percent', 'baseline', '0%', 'i'],
  ['zero_calc', 'baseline', 'calc(3px - 3px)', 'i'],
  ['length_add', 'baseline', '3px', 'i'],
  ['length_remove', '3px', 'baseline', 'i'],
  ['middle_add', 'baseline', 'middle', 'i'],
  ['middle_remove', 'middle', 'baseline', 'i'],
  ['top_add', 'baseline', 'top', 'i'],
  ['super_remove', 'super', 'baseline', 'i'],
  ['ordinary_glyph', 'baseline', '3px', 'X'],
  ['empty_length', 'baseline', '3px', ''],
  ['empty_middle', 'middle', 'baseline', ''],
]) {
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', 'inner'],
    viewports,
    html: `<div id="table" style="${base}">f<span id="inner" data-client-rects style="vertical-align:${initial}">${content}</span>i</div>`,
    actions: [
      { kind: 'style', selector: '#inner', value: `vertical-align:${next}` },
      { kind: 'style', selector: '#inner', value: `vertical-align:${initial}` },
      { kind: 'style', selector: '#table', value: `${base};font-size:28px` },
    ],
  };
}

await runRenderingCases(cases, {}, 'inline-shaping-refresh', '#table{background:#f4f0e8;color:#234}');
