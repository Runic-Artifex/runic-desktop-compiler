// Explicit client-space samples: a point footprint must survive traversal,
// not be recreated at each transformed box or expanded to a whole text line.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 240, dpr]);
const points = xs => JSON.stringify(xs);
const edge = [
  [-1.015625, 10],
  [-1, 10],
  [-0.984375, 10],
  [-0.5, 10],
  [0, 10],
  [39.984375, 10],
  [40, 10],
  [40.015625, 10],
];
for (const origin of [20.375, 20.625]) {
  for (const transform of ['none', 'scale(.5)', 'scale(2)', 'rotate(15deg)', 'skewX(20deg)']) {
    const token = `${origin}_${transform}`.replaceAll(/[^a-z0-9]/g, '_');
    cases[`box_${token}`] = {
      standards: true,
      region: 'table',
      regions: ['table', 'target'],
      viewports,
      html: `<div id="table" style="position:relative;width:160px;height:130px;margin:${origin}px"><div id="target" data-hit-points='${points(edge)}' style="position:absolute;left:30.375px;top:20.375px;width:40px;height:20px;background:#567;transform:${transform};transform-origin:0 0"></div></div>`,
    };
  }
}
for (const height of [25, 30, 48]) {
  for (const transform of ['none', 'scale(.5)', 'scale(2)', 'rotate(15deg)']) {
    const token = `${height}_${transform}`.replaceAll(/[^a-z0-9]/g, '_');
    const samples = [
      [20, 0],
      [20, 23.984375],
      [20, 24],
      [20, 24.5],
      [20, 25],
      [20, height - 1.015625],
      [20, height - 1],
      [20, height - 0.5],
      [20, height],
      [20, height + 0.5],
    ];
    cases[`text_gap_${token}`] = {
      standards: true,
      region: 'table',
      regions: ['table', 'text'],
      viewports,
      html: `<div id="table" data-hit-points='${points(samples)}' style="margin:20.375px;width:92px;font:20px/${height}px Test;transform:${transform};transform-origin:0 0"><span id="text" data-client-rects>Alpha Agpq</span></div>`,
      actions: [
        {
          kind: 'style',
          selector: '#table',
          value: `margin:20.625px;width:92px;font:20px/${height}px Test;transform:${transform};transform-origin:0 0`,
        },
      ],
    };
  }
}
for (const transform of ['none', 'scale(.5)', 'scale(2)', 'rotate(15deg)']) {
  for (const rounded of [false, true]) {
    const token = `${transform}_${rounded}`.replaceAll(/[^a-z0-9]/g, '_');
    cases[`clip_${token}`] = {
      standards: true,
      region: 'table',
      regions: ['table', 'target'],
      viewports,
      html: `<div id="table" data-scroll data-hit-points='${points([
        [-0.5, 12],
        [0.25, 0.25],
        [2, 2],
        [12, -0.5],
        [39.5, 12],
        [40, 12],
        [12, 29.5],
        [12, 30],
      ])}' style="position:relative;margin:30.375px;width:40px;height:30px;overflow:hidden;border-radius:${rounded ? 12 : 0}px;transform:${transform};transform-origin:0 0"><div id="target" style="position:relative;left:-4px;top:-4px;width:120px;height:100px;background:#567"></div></div>`,
      actions: [{ kind: 'scroll', selector: '#table', x: 15, y: 10 }],
    };
  }
}
await runRenderingCases(cases, {}, 'pointer-geometry', '#table{background:#f4f0e8}');
