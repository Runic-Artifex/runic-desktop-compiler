// Reduction of the compiled table fixture: percentage-width replaced controls,
// inline baselines, vertical alignment and their exact hit targets.
import { readFile } from 'node:fs/promises';
import { runRenderingCases } from './harness/rendering.mjs';
const css = (await readFile(new URL('../fixtures/table-svelte/style.css', import.meta.url), 'utf8'))
  .replace(/@font-face\s*\{[^}]*\}/, '')
  .replaceAll('RunicFixture', 'Test');
const row = (i, name) =>
  `<tr id="row-${i}"><td id="name-cell-${i}"><input id="name-${i}" value="${name}"></td><td id="check-cell-${i}"><input id="selected-${i}" type="checkbox"></td><td id="actions-${i}"><button id="save-${i}">Save</button> <button id="stop-${i}">Stop</button> <button id="remove-${i}">Remove</button></td></tr>`;
const tableControls = {
  suite: 'tables',
  region: 'pane',
  regions: ['pane', 'caption', 'span'],
  viewports: [
    [800, 600],
    [420, 600],
  ],
  html: `<main><div class="controls"><button id="add">Add</button><button id="reverse">Reverse</button><button id="toggle-span">Toggle colspan</button></div><div id="pane" data-scroll class="pane"><table id="table"><caption id="caption">Orders (3)</caption><colgroup><col class="name"><col class="edit"><col class="actions"></colgroup><thead id="head"><tr id="header"><th id="heading-name">Name</th><th id="heading-selected">Selected</th><th id="heading-actions">Actions</th></tr></thead><tbody id="body">${row(1, 'Alpha')}${row(2, 'Beta')}${row(3, 'Gamma')}</tbody><tfoot id="foot"><tr id="span-row"><td id="span">Span narrow</td><td id="detail">Detail</td><td id="count">3 rows</td></tr></tfoot></table></div><p id="state">row=- save=- stop=- selected=1</p></main>`,
};
await runRenderingCases(
  {
    table_controls: tableControls,
    table_controls_standards: { ...tableControls, standards: true },
  },
  {},
  'table-controls',
  css,
);
