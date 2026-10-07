// The same ancestor line-height under standards and quirks parsing, including
// innerHTML replacement. Author rules must still override the quirks UA reset.
import { runRenderingCases } from './harness/rendering.mjs';

const table = `<table id="table"><caption id="caption">Caption</caption><thead id="head"><tr id="header"><th id="heading">Heading</th></tr></thead><tbody id="body"><tr id="row"><td id="cell">Content</td></tr></tbody><tfoot id="foot"><tr id="footer"><td id="total">Total</td></tr></tfoot></table>`;
const shared = {
  html: `<div id="container" style="line-height:32px">${table}</div><div id="after">After</div>`,
  viewports: [
    [420, 300],
    [800, 300],
  ],
  actions: [{ kind: 'html', selector: '#container', value: table }],
};

await runRenderingCases(
  {
    standards_inherited: { ...shared, standards: true },
    quirks_reset: { ...shared },
    quirks_authored: { ...shared, html: `<style>table{line-height:32px}</style>${shared.html}` },
  },
  {},
  'table-document-mode',
  'table{border-spacing:2px}td,th{padding:4px}th{font-weight:normal}caption{padding:6px}',
);
