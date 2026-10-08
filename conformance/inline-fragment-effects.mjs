// Supplemental preserved whitespace, clips and pointer/visibility reductions.
import { runRenderingCases } from './harness/rendering.mjs';
const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 200, dpr]);
for (const whitespace of ['normal', 'pre', 'pre-wrap', 'break-spaces']) {
  cases[`whitespace_${whitespace}`] = {
    standards: true,
    region: 'table',
    regions: ['table', 'text'],
    viewports,
    html: `<div id="table" style="white-space:${whitespace};width:92px"><span id="text" data-client-rects>Alpha Beta Gamma  </span></div>`,
    actions: [
      { kind: 'style', selector: '#table', value: `white-space:${whitespace};width:130px` },
    ],
  };
}
for (const effect of [
  'pointer-events:none',
  'visibility:hidden',
  'pointer-events:none;visibility:hidden',
]) {
  cases[`target_${effect.replaceAll(/[^a-z]/g, '_')}`] = {
    standards: true,
    region: 'table',
    regions: ['table', 'text'],
    viewports,
    html: `<div id="table" style="line-height:32px"><span id="text" data-client-rects style="${effect}">Alpha <span id="child" data-client-rects style="pointer-events:auto;visibility:visible">Beta</span> Gamma</span></div>`,
    actions: [
      { kind: 'style', selector: '#text', value: 'pointer-events:auto;visibility:visible' },
    ],
  };
}
for (const overflow of ['visible', 'hidden', 'clip']) {
  cases[`short_line_${overflow}`] = {
    standards: true,
    region: 'table',
    regions: ['table', 'text'],
    viewports,
    html: `<div id="table" data-scroll style="line-height:12px;overflow:${overflow}"><span id="text" data-client-rects>Alpha</span></div>`,
    actions: [
      { kind: 'style', selector: '#table', value: `line-height:32px;overflow:${overflow}` },
    ],
  };
}
for (const standards of [true, false]) {
  for (const terminal of ['br', 'newline']) {
    cases[`terminal_${terminal}_${standards ? 'standards' : 'quirks'}`] = {
      standards,
      region: 'table',
      regions: ['table', 'text'],
      viewports,
      html: `<div id="table" data-scroll style="line-height:12px;white-space:pre">${
        terminal === 'br'
          ? '<span id="text" data-client-rects>Alpha</span><br>'
          : '<span id="text" data-client-rects>Alpha\n</span>'
      }</div>`,
      actions: [16, 32].map(height => ({
        kind: 'style',
        selector: '#table',
        value: `line-height:${height}px;white-space:pre`,
      })),
    };
  }
}
cases.vertical_padding = {
  standards: true,
  region: 'table',
  regions: ['table', 'text'],
  viewports,
  html: '<div id="table"><span id="text" data-client-rects style="padding:3px 0;border-top:1px solid #567;border-bottom:1px solid #567">Alpha</span></div>',
  actions: [
    {
      kind: 'style',
      selector: '#text',
      value: 'padding:5% 0;border-top:1px solid #567;border-bottom:1px solid #567',
    },
  ],
};
await runRenderingCases(
  cases,
  {},
  'inline-fragment-effects',
  '#table{margin:20.375px;width:320px;background:#f4f0e8;font:16px/20px Test;color:#234}',
);
