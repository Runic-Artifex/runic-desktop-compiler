// Keep default and authored control boxes in standards and quirks documents.
import { runRenderingCases } from './harness/rendering.mjs';
const cases = {};
for (const standards of [false, true]) {
  for (const parent of ['inline', 'flex', 'grid', 'table']) {
    for (const tag of ['input', 'textarea']) {
      for (const sizing of ['content-box', 'border-box']) {
        const initialStyle = `box-sizing:${sizing};width:100px;height:${tag === 'input' ? 24 : 44}px`;
        const value =
          tag === 'input'
            ? `<input id="control" value="Alpha Beta" style="${initialStyle}">`
            : `<textarea id="control" style="${initialStyle}">Alpha Beta\nSecond line</textarea>`;
        const content = `${value}<button id="other">Other</button><span id="text">Text</span>`;
        const html =
          parent === 'table'
            ? `<table id="table"><tr><td id="cell">${content}</td></tr></table>`
            : `<div id="table" class="${parent}">${content}</div>`;
        cases[
          `${standards ? 'standards' : 'quirks'}_${parent}_${tag}_${sizing.replace('-', '_')}`
        ] = {
          suite: 'controls',
          standards,
          region: 'table',
          regions: ['table', 'control', 'other'],
          viewports: [
            [420, 160, 1],
            [420, 160, 2],
          ],
          html,
          actions: [
            {
              kind: 'attribute',
              selector: '#control',
              name: 'style',
              value: `${initialStyle};width:130px`,
            },
            {
              kind: 'attribute',
              selector: '#control',
              name: 'style',
              value: `${initialStyle};margin-top:3px;margin-bottom:5px`,
            },
          ],
        };
      }
    }
  }
}
// Authored visible is adjusted to auto for textarea; clip keeps a line baseline.
for (const parent of ['inline', 'flex', 'grid', 'table']) {
  const original = cases[`standards_${parent}_textarea_border_box`];
  for (const overflow of ['visible', 'hidden', 'clip']) {
    cases[`standards_${parent}_textarea_${overflow}`] = {
      ...original,
      html: original.html.replace('style="', `style="overflow:${overflow};`),
      actions: original.actions.map(action => ({
        ...action,
        value: `overflow:${overflow};${action.value}`,
      })),
    };
  }
}
await runRenderingCases(
  cases,
  {},
  'control-layout',
  `
#table{margin:12px;width:320px;background:#f4f0e8;font:16px/20px Test}
#table.flex{display:flex;align-items:baseline}
#table.grid{display:grid;grid-template-columns:max-content max-content max-content;align-items:baseline}
table{border-spacing:0}td{padding:0;font:16px/20px Test}
input,textarea,button{font:16px/20px Test;color:#234}
input,textarea{border:1px solid #567;padding:1px 2px;background:white}
textarea{resize:none}
button,#text{margin-left:8px}
`,
);
