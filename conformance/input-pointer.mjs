// Pointer selection must use the same signed editor offset as text painting.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
for (const height of [8, 16, 24, 33.5]) {
  for (const lineHeight of ['normal', '32px']) {
    cases[`height_${height}_line_${lineHeight}`] = {
      suite: 'controls',
      standards: true,
      region: 'table',
      regions: ['table', 'control'],
      viewports: [
        [360, 140, 1],
        [360, 140, 1.25],
        [360, 140, 2],
      ],
      browserStyleRequirements: [
        { selector: '#control', property: 'caretAnimation', value: 'manual' },
      ],
      html: `<div id="table"><input id="control" value="Alpha Beta" style="height:${height}px;line-height:${lineHeight}"></div>`,
      actions: [
        { kind: 'pointerDown', selector: '#control', x: 65, y: 1.5 },
        { kind: 'pointerMove', selector: '#control', x: 25, y: 1.5 },
        { kind: 'pointerUp', selector: '#control', x: 25, y: 1.5 },
        { kind: 'pointerDown', selector: '#control', x: 65, y: height + 2.5 },
        { kind: 'pointerMove', selector: '#control', x: 25, y: height + 2.5 },
        { kind: 'pointerUp', selector: '#control', x: 25, y: height + 2.5 },
      ],
    };
  }
}

await runRenderingCases(
  cases,
  {},
  'input-pointer',
  `
#table{margin:20px;width:max-content;background:#f4f0e8;font:16px/20px Test}
#control{font:16px Test;width:100px;padding:1px 2px;border:1px solid #567;background:white;color:#234;caret-animation:manual}
`,
);
