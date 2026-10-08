// Text provenance and culled-inline ordering, including layout rebuilds.
import { runRenderingCases } from './harness/rendering.mjs';
const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 220, dpr]);
for (const direction of ['ltr', 'rtl']) {
  for (const [name, content] of Object.entries({
    child: 'Alpha <span id="child" data-client-rects>Beta</span> Gamma',
    adjacent:
      'Al<!-- distinct DOM text nodes -->pha <span id="child" data-client-rects>Be<!-- split -->ta</span> Gamma',
    ligature:
      'of<!-- split ligature -->fice <span id="child" data-client-rects>of<!-- split -->fice</span> office',
    ligature_points:
      'of<!-- split ligature -->fice <span id="child" data-client-rects data-hit-points="[[0,8],[16,8],[20,8],[24,8],[28,8],[32,8],[36,8],[44,8]]">of<!-- split -->fice</span> office',
    combining:
      'Al<!-- combining seam -->\u0308pha <span id="child" data-client-rects>Be<!-- combining seam -->\u0301ta</span> Gamma',
    tabs: 'Alpha\t<span id="child" data-client-rects>Beta\t</span>\tGamma  ',
    bidi: 'Alpha שלום <span id="child" data-client-rects>مرحبا Beta</span> Gamma שלום',
    whitespace: 'Alpha \t<span id="child" data-client-rects>  Beta  </span>\t Gamma',
    atomic:
      'Alpha <span id="child" data-client-rects>Beta <b id="box" style="display:inline-block;width:12px;height:12px;background:#abc"></b></span> Gamma',
    absolute:
      'Alpha <span id="child" data-client-rects>Beta <b id="box" style="position:absolute;left:180px;top:0;width:12px;height:12px;background:#abc"></b></span> Gamma',
  })) {
    cases[`${name}_${direction}`] = {
      standards: true,
      region: 'table',
      regions: ['table', 'text', 'child'],
      viewports,
      html: `<div id="table" style="direction:${direction};line-height:32px${name === 'tabs' ? ';white-space:pre' : ''}"><span id="text" data-client-rects style="pointer-events:none;visibility:hidden">${content}</span></div>`,
      actions: [
        { kind: 'style', selector: '#text', value: 'pointer-events:auto;visibility:visible' },
        {
          kind: 'html',
          selector: '#text',
          value: content.replaceAll('Beta', 'Delta').replaceAll('Gamma', 'Zeta'),
        },
      ],
    };
  }
  for (const mode of ['normal', 'pre-wrap', 'break-spaces']) {
    cases[`wrapped_${mode}_${direction}`] = {
      standards: true,
      region: 'table',
      regions: ['table', 'text', 'child'],
      viewports,
      html: `<div id="table" style="direction:${direction};width:150px;white-space:${mode}"><span id="text" data-client-rects>Alpha <span id="child" data-client-rects style="font-size:10px">Child</span> Beta Gamma Delta</span></div>`,
      actions: [
        {
          kind: 'style',
          selector: '#table',
          value: `direction:${direction};width:100px;white-space:${mode}`,
        },
      ],
    };
  }
}
await runRenderingCases(
  cases,
  {},
  'inline-source-order',
  '#table{margin:20.375px;width:320px;background:#f4f0e8;font:16px/20px Test;color:#234}#child{pointer-events:auto;visibility:visible}',
);
