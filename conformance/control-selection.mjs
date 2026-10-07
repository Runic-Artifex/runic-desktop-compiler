// Logical editor positions must survive absent fonts and later layout refreshes.
import { runRenderingCases } from './harness/rendering.mjs';
const cases = {};
for (const tag of ['input', 'textarea']) {
  for (const pinned of [false, true]) {
    for (const unicode of [false, true]) {
      const text = unicode ? 'A🙂 Beta' : 'Edit text';
      const control =
        tag === 'input'
          ? `<input id="control" value="${text}">`
          : `<textarea id="control">${text}</textarea>`;
      cases[`${tag}_${pinned ? 'pinned' : 'ua_font'}_${unicode ? 'unicode' : 'ascii'}`] = {
        suite: 'controls',
        standards: true,
        region: 'table',
        regions: ['table', 'control'],
        html: `<div id="table"${pinned ? ' class="pinned"' : ''}>${control}</div>`,
        actions: [
          { kind: 'selection', selector: '#control', start: 1, end: 3 },
          { kind: 'attribute', selector: '#control', name: 'style', value: 'font:24px/32px Test' },
          {
            kind: 'attribute',
            selector: '#control',
            name: 'style',
            value: 'font:24px/32px MissingEditorFont',
          },
          { kind: 'selection', selector: '#control', start: 0, end: 0 },
          { kind: 'attribute', selector: '#control', name: 'style', value: 'font:16px/20px Test' },
        ],
      };
    }
  }
}
await runRenderingCases(
  cases,
  {},
  'control-selection',
  `
#table{margin:12px;width:300px;height:90px;background:#f4f0e8}
#table.pinned input,#table.pinned textarea{font:16px/20px Test}
input,textarea{width:200px;height:44px;padding:2px;border:1px solid #567;resize:none}
`,
);
