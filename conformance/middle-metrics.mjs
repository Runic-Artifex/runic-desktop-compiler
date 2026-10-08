// Primary-font middle alignment: independent box, fragment, hit and paint gates.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
for (const size of [12, 16, 20, 24, 32]) {
  for (const origin of ['20px', '20.375px']) {
    for (const kind of ['text', 'atomic', 'nested']) {
      const child =
        kind === 'atomic'
          ? '<i id="text" style="display:inline-block;width:12px;height:20px;vertical-align:middle;background:#abc"></i>'
          : `<span id="text" data-client-rects style="vertical-align:middle">${kind === 'nested' ? '<span style="font-size:10px;vertical-align:middle">Text</span>' : 'Text'}</span>`;
      const style = `margin:${origin};font:${size}px/20px Test;width:320px`;
      cases[`${kind}_${size}_${origin.replace('.', '_')}`] = {
        standards: true,
        region: 'table',
        regions: ['table', 'text'],
        viewports: [1, 1.25, 2].map(dpr => [420, 220, dpr]),
        html: `<div id="table" data-font-metrics style="${style}">Before ${child} after<span style="font-size:32px"> Tall</span></div>`,
        actions: [{ kind: 'style', selector: '#table', value: `${style};font-size:${size + 4}px` }],
      };
    }
  }
}
await runRenderingCases(cases, {}, 'middle-metrics', '#table{background:#f4f0e8;color:#234}');
