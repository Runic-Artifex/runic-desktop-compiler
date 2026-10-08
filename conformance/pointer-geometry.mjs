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
// Identity transforms create a snapping layer even though they do not move the
// query. Keep fractional ancestor offsets to distinguish the two paths.
for (const transform of ['none', 'translate(0)']) {
  for (const height of [25, 48]) {
    const token = `${height}_${transform}`.replaceAll(/[^a-z0-9]/g, '_');
    cases[`layer_${token}`] = {
      standards: true,
      region: 'table',
      regions: ['table', 'text'],
      viewports,
      html: `<div id="table" style="margin:20.375px;padding:0.25px;width:120px"><div id="line" data-hit-points='${points(
        [
          [20, 23.984375],
          [20, 24],
          [20, height - 1],
          [20, height - 0.5],
        ],
      )}' style="width:92px;font:20px/${height}px Test;transform:${transform}"><span id="text" data-client-rects>Alpha Agpq</span></div></div>`,
      actions: [
        { kind: 'style', selector: '#table', value: 'margin:20.625px;padding:0.25px;width:120px' },
      ],
    };
  }
}
// Negative half ties remain observable at the viewport's left edge. The raw
// rectangular box and the snapped rounded contour are separate target rules.
for (const origin of [-0.5, -0.515625]) {
  for (const radius of [0, 4]) {
    const token = `${origin}_${radius}`.replaceAll(/[^a-z0-9]/g, '_');
    cases[`negative_${token}`] = {
      standards: true,
      region: 'table',
      regions: ['table', 'target'],
      viewports,
      html: `<div id="table" style="position:relative;width:120px;height:90px"><div id="target" data-hit-points='${points(
        [
          [0.5, 10],
          [0.515625, 0],
          [1, 1],
          [39.984375, 10],
          [40, 10],
        ],
      )}' style="position:absolute;left:${origin}px;top:20.5px;width:40px;height:20px;border-radius:${radius}px;background:#567"></div></div>`,
    };
  }
}
for (const origin of [20.375, 20.625]) {
  for (const radius of [0, 4]) {
    const token = `${origin}_${radius}`.replaceAll(/[^a-z0-9]/g, '_');
    cases[`rounded_control_${token}`] = {
      standards: true,
      region: 'table',
      regions: ['table', 'target'],
      viewports,
      html: `<div id="table" style="position:relative;margin:${origin}px;width:160px;height:90px"><button id="target" data-hit-points='${points(
        [
          [1, 1],
          [52.28125, 27],
          [53.28125, 27],
          [52.78125, 27.5],
        ],
      )}' style="position:absolute;left:30.328125px;top:20px;box-sizing:border-box;width:53.28125px;height:28px;border:0;padding:0;border-radius:${radius}px;background:#567">Save</button></div>`,
    };
  }
}
await runRenderingCases(cases, {}, 'pointer-geometry', '#table{background:#f4f0e8}');
