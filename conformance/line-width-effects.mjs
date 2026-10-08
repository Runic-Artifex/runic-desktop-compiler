// Scope probes for zoomed keywords, logical sides and animated line widths.
import { runRenderingCases } from './harness/rendering.mjs';

const viewports = [1, 1.25, 1.5, 2].map(dpr => [380, 160, dpr]);
const cases = {};
for (const keyword of ['thin', 'medium', 'thick']) {
  for (const zoom of [.5, 1.25, 2]) {
    cases[`keyword_${keyword}_${zoom}`] = {
      standards: true, suite: 'borders', viewports, regions: ['box'],
      html: `<div id="table" style="zoom:${zoom}"><div id="box" data-line-widths style="border-width:${keyword};outline-width:${keyword}"></div></div>`,
    };
  }
}
for (const direction of ['ltr', 'rtl']) {
  cases[`logical_${direction}`] = {
    standards: true, suite: 'borders', viewports, regions: ['box'],
    html: `<div id="table" dir="${direction}"><div id="box" data-line-widths style="border-block-width:.001px 2.999px;border-inline-width:1.999px .5px;outline-width:1.999px"></div></div>`,
    actions: [{kind:'attribute',selector:'#table',name:'dir',value:direction==='ltr'?'rtl':'ltr'}],
  };
}
cases.animated_line_width = {
  standards: true, suite: 'borders', viewports, regions: ['box'],
  html: '<style>@keyframes edge{from{border-width:1px;outline-width:1px}to{border-width:4px;outline-width:4px}}</style><div id="table"><div id="box" data-line-widths style="animation:edge 100ms linear both"></div></div>',
  timeline: [25,50,75,100,125].map(at => ({at,kind:'observe'})),
};
await runRenderingCases(cases, {}, 'line-width-effects', `
#table{width:max-content;margin:20.375px;background:#f4f0e8}
#box{width:100px;height:30px;padding:2px;border:solid #567;outline:solid #567;outline-offset:.375px;background:white}
`);
