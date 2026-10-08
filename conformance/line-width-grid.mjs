// Computed line widths are an independent gate from box geometry and raster coverage.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 1.5, 2].map(dpr => [620, 200, dpr]);
function controls(inherit) {
  const html =
    '<div id="plain" data-line-widths></div><input id="input" data-line-widths value="Alpha"><textarea id="textarea" data-line-widths>Alpha</textarea><button id="button" data-line-widths>Alpha</button>';
  return inherit
    ? html.replaceAll(
        'data-line-widths',
        'data-line-widths style="border-width:inherit;outline-width:inherit"',
      )
    : html;
}
function add(name, style, mutation, inherit = false) {
  cases[name] = {
    standards: true,
    suite: 'borders',
    regions: ['plain', 'input', 'textarea', 'button'],
    viewports,
    html: `<div id="table" style="${style}">${controls(inherit)}</div>`,
    actions: [{ kind: 'attribute', selector: '#table', name: 'style', value: mutation }],
  };
}
for (const width of [
  '0px',
  '.001px',
  '.01px',
  '.5px',
  '.99px',
  '1px',
  '1.01px',
  '1.99px',
  '2px',
  '2.01px',
  '2.99px',
  '3.5px',
  'thin',
  'medium',
  'thick',
  'calc(1px + .99px)',
]) {
  add(`width_${width.replaceAll(/[^a-z\d]/g, '_')}`, `--width:${width}`, '--width:4.01px');
}
for (const zoom of [0.5, 1.25, 2]) {
  add(`zoom_${zoom}`, `--width:1.99px;zoom:${zoom}`, `--width:.5px;zoom:${zoom}`);
}
for (const borderStyle of ['none', 'hidden']) {
  add(
    `style_${borderStyle}`,
    `--width:2.99px;--border-style:${borderStyle}`,
    '--width:2.99px;--border-style:solid',
  );
}
add(
  'inherited_width',
  'border:1.99px solid;outline:1.99px solid;--width:1px',
  'border:4.01px solid;outline:4.01px solid;--width:1px',
  true,
);

await runRenderingCases(
  cases,
  {},
  'line-width-grid',
  `
#table{display:flex;gap:8px;align-items:flex-start;width:max-content;margin:20.375px;background:#f4f0e8}
#table> *{appearance:none;box-sizing:content-box;width:100px;height:30px;padding:2px;margin:0;font:16px/20px Test;border:var(--width) var(--border-style,solid) #567;outline:var(--width) solid #567;outline-offset:3px;background:white;color:#234;resize:none}
`,
);
