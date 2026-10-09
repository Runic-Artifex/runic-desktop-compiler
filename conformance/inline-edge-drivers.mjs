// Additive inline edge reductions. Chromium supplies the observed wrap,
// intrinsic width and fragment placement; candidate outcomes are not asserted.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 260, dpr]);
const base =
  "position:relative;margin:20.375px;width:84.375px;font:24px/32px Test;font-feature-settings:'liga' 1";
const ordinary = 'display:inline;vertical-align:baseline;box-decoration-break:slice';
const box = (id, content = '', style = '') =>
  `<span id="${id}" data-client-rects data-hit-points="[[-4,8],[0,8],[4,8],[12,8]]" style="${ordinary};${style}">${content}</span>`;
const span = (content = '', style = '') => box('owner', content, style);
const ownerStyle = value => ({ kind: 'style', selector: '#owner', value: `${ordinary};${value}` });

function add(name, content, options = {}) {
  const containerStyle = options.base ?? base;
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', ...[...content.matchAll(/id="([^"]+)"/g)].map(([, id]) => id)],
    viewports,
    html: `<div id="table" data-client-rects data-hit-points="[[1,16],[42,16],[83,16],[1,48],[42,48],[83,48]]" style="${containerStyle}">${content}</div>`,
    actions: options.actions ?? [
      { kind: 'style', selector: '#table', value: `${containerStyle};width:156.375px` },
      { kind: 'style', selector: '#table', value: containerStyle },
    ],
    browserStyleRequirements: [
      { selector: '#owner', property: 'display', value: 'inline' },
      { selector: '#owner', property: 'boxDecorationBreak', value: 'slice' },
    ],
  };
}

// Repeat the signed opening-margin mutation at a separate fixed width.
const negative = 'margin-left:-26.375px;background:#def';
add('negative_open_wrap_roundtrip', `AA AAAA${span('B', negative)}`, {
  base: base.replace('width:84.375px', 'width:112.375px'),
  actions: [ownerStyle('margin-left:0px;background:#def'), ownerStyle(negative)],
});

// Change only the opening margin during a min-content measurement round trip.
const intrinsic =
  'margin-left:-7.125px;padding-left:3.375px;margin-right:11.125px;padding-right:2.375px;border-right:1.125px solid #567;background:#def';
add(
  'intrinsic_min_controlling_edge',
  `AA ${span(`BB ${box('child', 'CCC')} D`, intrinsic)} EE`,
  {
    base: base.replace('width:84.375px', 'width:min-content'),
    actions: [ownerStyle(`${intrinsic};margin-left:24.125px`), ownerStyle(intrinsic)],
  },
);

// Close the owner immediately after br, with no intervening empty child.
const opening =
  'margin-left:9.125px;padding-left:2.375px;border-left:1.125px solid #567;background:#def';
const closing =
  'margin-right:15.125px;padding-right:2.375px;border-right:1.125px solid #567;background:#def';
add('forced_br_immediate_close', `AA${span('BB<br>', `${opening};${closing}`)}CC DD`);

await runRenderingCases(cases, {}, 'inline-edge-drivers', '#table{background:#f4f0e8;color:#234}');
