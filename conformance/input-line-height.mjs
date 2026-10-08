// Outer line-height remains authored; measure the inner editor and its baseline.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const scenarios = ['normal', '12px', '20px', '32px'].flatMap(lineHeight =>
  [16, 24, 33.5].map(height => ({ lineHeight, height: `${height}px`, name: height })),
);
scenarios.push(
  { lineHeight: '20px', height: 'auto', name: 'auto' },
  { lineHeight: '32px', height: 'auto', name: 'auto' },
  { lineHeight: '20px', height: '50%', name: 'percent' },
  { lineHeight: '32px', height: '50%', name: 'percent' },
  { lineHeight: '32px', height: 'calc(50% + 4px)', name: 'calc_percent' },
  { lineHeight: '32px', height: 'calc(12px + 12px)', name: 'calc_fixed' },
  { lineHeight: '20.5px', height: '20px', name: 'fraction_below' },
  { lineHeight: '20.5px', height: '20.25px', name: 'fraction_threshold' },
  { lineHeight: '20.5px', height: '21px', name: 'fraction_above' },
);
for (const { lineHeight, height, name } of scenarios) {
  for (const context of ['inline', 'flex']) {
    const style = `line-height:${lineHeight};height:${height}`;
    cases[`${context}_${lineHeight.replace('px', '')}_${name}`] = {
      suite: 'controls',
      standards: true,
      region: 'table',
      regions: ['table', 'control'],
      browserStyleRequirements: [
        { selector: '#control', property: 'caretAnimation', value: 'manual' },
        { selector: '#control', property: 'lineHeight', value: lineHeight },
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

await runRenderingCases(
  cases,
  {},
  'input-line-height',
  `
#table{margin:20px;width:max-content;height:60px;background:#f4f0e8;font:16px/20px Test}
#table.flex{display:flex;align-items:baseline}
#control{font:16px Test;width:100px;padding:1px 2px;border:1px solid #567;background:white;color:#234;caret-animation:manual}
#baseline{display:inline-block;width:1px;height:1px;margin-left:4px;background:black}
`,
);
