// Outer line-height remains authored; measure the inner editor and its baseline.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
for (const lineHeight of ['normal', '12px', '20px', '32px']) {
  for (const height of [16, 24, 33.5]) {
    for (const context of ['inline', 'flex']) {
      const style = `line-height:${lineHeight};height:${height}px`;
      cases[`${context}_${lineHeight.replace('px', '')}_${height}`] = {
        suite: 'controls',
        standards: true,
        region: 'table',
        regions: ['table', 'control'],
        browserStyleRequirements: [
          { selector: '#control', property: 'caretAnimation', value: 'manual' },
        ],
        viewports: [
          [360, 140, 1],
          [360, 140, 1.25],
          [360, 140, 2],
        ],
        html: `<div id="table" class="${context}"><input id="control" value="Alpha Beta" style="${style}"><i id="baseline"></i></div>`,
        actions: [
          { kind: 'focus', selector: '#control' },
          { kind: 'selection', selector: '#control', start: 1, end: 4 },
          { kind: 'attribute', selector: '#control', name: 'style', value: `${style};width:140px` },
        ],
      };
    }
  }
}

await runRenderingCases(
  cases,
  {},
  'input-line-height',
  `
#table{margin:20px;width:max-content;background:#f4f0e8;font:16px/20px Test}
#table.flex{display:flex;align-items:baseline}
#control{font:16px Test;width:100px;padding:1px 2px;border:1px solid #567;background:white;color:#234;caret-animation:manual}
#baseline{display:inline-block;width:1px;height:1px;margin-left:4px;background:black}
`,
);
