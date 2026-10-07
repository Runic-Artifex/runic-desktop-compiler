import { runRenderingCases } from './harness/rendering.mjs';
const columns = `<caption id="caption">Orders</caption><thead id="head"><tr id="header"><th id="a">Übersetzung</th><th id="b">Status</th></tr></thead><tbody id="body"><tr id="row"><td id="c">A long translated sentence for wrapping</td><td id="d">Ready</td></tr><tr id="row2"><td id="e">Short</td><td id="f">Waiting</td></tr></tbody>`;
const viewports = [
  [420, 600],
  [800, 600],
];
const cases = {
  table_flex: {
    html: `<div id="parent" style="display:flex;gap:12px;width:100%"><div style="width:64px;flex:none">Side</div><table id="table" style="flex:1;width:100%">${columns}</table></div>`,
    viewports,
    actions: [
      {
        kind: 'attribute',
        selector: '#parent',
        name: 'style',
        value: 'display:flex;gap:12px;width:280px',
      },
    ],
  },
  table_grid: {
    html: `<div id="parent" style="display:grid;grid-template-columns:64px minmax(0,1fr);gap:12px;width:100%"><div>Side</div><table id="table" style="width:100%">${columns}</table></div>`,
    viewports,
    actions: [
      { kind: 'html', selector: '#c', value: 'Eine sehr lange Übersetzung mit vielen Worten' },
    ],
  },
  table_scroll: {
    html: `<div id="pane" data-scroll style="width:90%;height:120px;overflow:auto;scrollbar-width:none"><table id="table" style="table-layout:fixed;width:700px">${columns}</table></div>`,
    viewports,
    actions: [
      { kind: 'scroll', selector: '#pane', x: 160, y: 0 },
      { kind: 'scroll', selector: '#pane', x: 10000, y: 10000 },
    ],
  },
  table_nested: {
    html: `<div id="outer" data-scroll style="width:90%;height:160px;overflow:auto;scrollbar-width:none"><div style="height:80px">Before</div><div id="pane" data-scroll style="width:600px;height:100px;overflow:auto;scrollbar-width:none"><table id="table" style="width:700px">${columns}</table></div><div style="height:160px">After</div></div>`,
    viewports,
    actions: [
      { kind: 'scroll', selector: '#outer', x: 90, y: 50 },
      { kind: 'scroll', selector: '#pane', x: 80, y: 30 },
    ],
  },
  table_controls: {
    html: `<table id="table" style="width:90%"><caption id="caption">Edit</caption><tbody id="body"><tr id="row"><td id="a"><button id="button">Save</button></td><td id="b"><input id="check" type="checkbox" checked></td><td id="c"><input id="input" value="Edit text" style="width:100px"></td></tr><tr id="row2"><td id="d" colspan="3">Other</td></tr></tbody></table>`,
    viewports,
    actions: [
      { kind: 'focus', selector: '#input' },
      { kind: 'attribute', selector: '#d', name: 'colspan', value: '2' },
      {
        kind: 'html',
        selector: '#body',
        value:
          '<tr id="row2"><td id="d">Moved</td><td>Other</td></tr><tr id="row"><td id="a"><button id="button">Save</button></td><td id="b"><input id="check" type="checkbox" checked></td><td id="c"><input id="input" value="Edit text" style="width:100px"></td></tr>',
      },
    ],
  },
  table_rtl: {
    html: `<table id="table" dir="rtl" style="width:90%;table-layout:fixed"><caption id="caption">Translated</caption><tr id="row"><td id="a" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">Eine sehr lange Übersetzung mit vielen Worten</td><td id="b">Status</td></tr></table>`,
    viewports,
  },
};
await runRenderingCases(
  cases,
  {},
  'table-integration',
  'table{border-spacing:2px}td,th{padding:4px}th{font-weight:normal}caption{padding:6px}',
);
