// Intrinsic queries must not replace the settled lines used for painting.
import { runRenderingCases } from './harness/rendering.mjs';
const cases = {};
for (const context of ['table', 'flex', 'grid']) {
  for (const nested of [false, true]) {
    const contents = nested
      ? '<span>Before <button id="button"><span>Save</span> <span style="display:inline-block;font-size:12px">nested</span></button> after</span>'
      : '<button id="button">Save</button> <button>Stop</button> <button>Remove</button>';
    const child = `<div id="cell">${contents}</div>`;
    cases[`${context}_${nested ? 'nested' : 'buttons'}`] = {
      standards: true,
      region: 'table',
      regions: ['table', 'button'],
      html: `<div id="table" style="width:320px;display:${context}">${context === 'table' ? `<div style="display:table-row">${child}</div>` : child}</div>`,
      actions: [
        {
          kind: 'attribute',
          selector: '#table',
          name: 'style',
          value: `width:180px;display:${context}`,
        },
        { kind: 'html', selector: '#button', value: 'A longer translated label' },
        {
          kind: 'attribute',
          selector: '#table',
          name: 'style',
          value: `width:420px;display:${context}`,
        },
        { kind: 'attribute', selector: '#button', name: 'style', value: 'text-align:right' },
      ],
    };
  }
}
await runRenderingCases(
  cases,
  {},
  'intrinsic-text',
  `
#cell{padding:5px} [style*="display:table"] #cell{display:table-cell}
[style*="display:grid"]{grid-template-columns:minmax(min-content,1fr)}
button{font:inherit;color:#123;background:#eee;border:1px solid #567;padding:4px 6px;text-align:center}
`,
);
