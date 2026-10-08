// CSS paint-anchor rounding remains separate from layout rectangles and from
// device-space glyph hinting. Inline box materialization may change the anchor.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const variants = {
  nested_middle: ['', '', 'vertical-align:middle', 'font-size:10px;vertical-align:middle'],
  parent_background: ['background:#f4f0e8', '', 'vertical-align:middle', 'font-size:10px;vertical-align:middle'],
  child_background: ['', 'background:#f4f0e8', 'vertical-align:middle', 'font-size:10px;vertical-align:middle'],
  nested_baseline: ['', '', '', 'font-size:10px'],
  parent_text: ['', '', 'vertical-align:middle', 'font-size:10px;vertical-align:middle', 'Outer '],
  parent_length: ['', '', 'vertical-align:2.5px', 'font-size:10px;vertical-align:middle'],
};

for (const [variant, [parentBox, childBox, parentAlign, childAlign, directText = '']] of Object.entries(variants)) {
  for (const [originName, origin] of [['integer', 20], ['fractional', 20.375], ['negative', -0.375]]) {
    const style = `margin-top:${origin}px;margin-left:20px;font:20px/20px Test;width:320px`;
    cases[`${variant}_${originName}`] = {
      suite: 'paint-origins',
      standards: true,
      region: 'table',
      regions: ['table', 'parent', 'inner'],
      viewports: [1, 1.25, 2].map(dpr => [420, 180, dpr]),
      html: `<div id="table" data-font-metrics style="${style}">Before <span id="parent" data-client-rects data-font-metrics style="${parentBox};${parentAlign}">${directText}<span id="inner" data-client-rects data-font-metrics style="${childBox};${childAlign}">Text Agpq</span></span> after<span style="font-size:32px"> Tall</span></div>`,
      actions: [{ kind: 'style', selector: '#table', value: `${style};font-size:24px` }],
    };
  }
}

await runRenderingCases(cases, {}, 'paint-origins', '#table{background:#f4f0e8;color:#234}');
