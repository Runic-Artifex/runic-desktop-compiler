// Root decorations without direct text must retain their descendant's paint phase
// when replacing a shifted baseline with the root line baseline.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
for (const materialized of [false, true]) {
  for (const [originName, origin] of [['integer', 20], ['fractional', 20.375], ['negative', -0.375]]) {
    const style = `margin-top:${origin}px;margin-left:20px;font:20px/20.375px Test;width:130px;text-decoration:underline;text-decoration-thickness:1px;text-underline-offset:2px`;
    const parentStyle = materialized ? 'background:#e9eef4' : '';
    cases[`${materialized ? 'materialized' : 'culled'}_${originName}`] = {
      suite: 'paint-decorations',
      standards: true,
      region: 'table',
      regions: ['table', 'parent', 'inner'],
      viewports: [1, 1.25, 2].map(dpr => [420, 220, dpr]),
      html: `<div id="table" data-font-metrics style="${style}"><span id="parent" data-client-rects data-font-metrics style="${parentStyle}"><span id="inner" data-client-rects data-font-metrics>Text Agpq Text Agpq Text Agpq</span></span></div>`,
      actions: [{ kind: 'style', selector: '#table', value: `${style};line-height:21.625px` }],
    };
  }
}

await runRenderingCases(cases, {}, 'paint-decorations', '#table{background:#f4f0e8;color:#234}');
