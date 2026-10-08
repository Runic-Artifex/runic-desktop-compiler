// Empty non-baseline spans interrupt cross-element shaping, while baseline spans preserve it.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 220, dpr]);
const base = 'margin:20.375px;width:178px;font:24px/32px Test;font-feature-settings:"liga" 1';
const span = (style, content = '') =>
  `<span id="inner" data-client-rects style="${style}">${content}</span>`;
function add(name, content) {
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', 'inner'],
    viewports,
    html: `<div id="table" style="${base}">${content}</div>`,
    actions: [{ kind: 'style', selector: '#table', value: `${base};font-size:28px` }],
  };
}
add('baseline', `f${span('vertical-align:baseline')}i`);
add('length', `f${span('vertical-align:3px')}i`);
add('middle', `f${span('vertical-align:middle')}i`);
add('super', `f${span('vertical-align:super')}i`);
add('top', `f${span('vertical-align:top')}i`);
add('nested', `f<span id="outer" data-client-rects style="vertical-align:3px">${span('vertical-align:middle')}</span>i`);
add('inner_ligature', `f${span('vertical-align:3px')}fi`);

await runRenderingCases(cases, {}, 'empty-inline-shaping', '#table{background:#f4f0e8;color:#234}');
