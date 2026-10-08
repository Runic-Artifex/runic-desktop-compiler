// Compare each inline fragment as well as its union, targets and local paint.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 240, dpr]);
function add(name, content, style = '', actions = []) {
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', 'text'],
    viewports,
    html: `<div id="table" style="${style}">${content}</div>`,
    actions,
  };
}
const span = (text, style = '') =>
  `<span id="text" data-client-rects style="${style}">${text}</span>`;
for (const size of [12, 16, 24]) {
  for (const height of ['normal', '1', '1.25', '2']) {
    add(
      `font_${size}_${height.replace('.', '_')}`,
      span('Alpha Agpq'),
      `font:${size}px/${height} Test`,
      [
        { selector: '#table', attr: 'style', value: `font:${size}px/${height} Test;width:92px` },
        { selector: '#text', attr: 'style', value: 'font-size:20px' },
      ],
    );
  }
}
for (const align of [
  'baseline',
  'sub',
  'super',
  'middle',
  'text-top',
  'text-bottom',
  'top',
  'bottom',
  '3.375px',
  '-2.125px',
]) {
  add(
    `align_${align.replaceAll('.', '_')}`,
    `Before ${span('Text', `vertical-align:${align}`)} after<span style="font-size:32px"> Tall</span>`,
  );
}
for (const variant of ['large_child', 'small_child', 'atomic', 'nested_shift']) {
  const child = {
    large_child: '<span id="child" data-client-rects style="font-size:32px">Child</span>',
    small_child: '<span id="child" data-client-rects style="font-size:10px">Child</span>',
    atomic:
      '<i id="child" style="display:inline-block;width:28px;height:44px;background:#567"></i>',
    nested_shift:
      '<span id="child" data-client-rects style="vertical-align:super"><span style="vertical-align:3.375px">Child</span></span>',
  }[variant];
  add(`nested_${variant}`, span(`Alpha ${child} Beta Gamma Delta`), 'width:150px', [
    { selector: '#table', attr: 'style', value: 'width:100px' },
  ]);
}
for (const direction of ['ltr', 'rtl']) {
  for (const margin of ['8px', '-3.375px', '5%', 'calc(5% + 2.125px)', 'auto']) {
    for (const wrap of [false, true]) {
      const token = margin.replaceAll(/[^a-z0-9]/g, '_');
      add(
        `margin_${direction}_${token}_${wrap ? 'wrap' : 'line'}`,
        `Before ${span(wrap ? 'Alpha Beta Gamma Delta' : 'Alpha', `margin-left:${margin};margin-right:5.125px`)} after`,
        `direction:${direction};width:${wrap ? 140 : 320}px`,
        [
          {
            selector: '#text',
            attr: 'style',
            value: `margin-left:${margin};margin-right:11.375px`,
          },
          { selector: '#table', attr: 'style', value: `direction:${direction};width:112px` },
        ],
      );
    }
  }
}
for (const direction of ['ltr', 'rtl']) {
  add(
    `bidi_${direction}`,
    `Start ${span('ترجمة Alpha Beta نص Gamma')} End`,
    `direction:${direction};width:150px`,
    [{ selector: '#table', attr: 'style', value: `direction:${direction};width:100px` }],
  );
}
add(
  'nested_margins',
  span(
    'Alpha <span id="child" data-client-rects style="margin:0 7.125px">Beta Gamma</span> Delta',
    'margin:0 8px',
  ),
  'width:160px',
  [{ selector: '#table', attr: 'style', value: 'width:105px' }],
);
add(
  'decorated',
  span('Alpha Beta Gamma Delta', 'padding:2px 5px;border:1px solid #567;background:#def'),
  'width:130px',
);

await runRenderingCases(
  cases,
  {},
  'inline-fragments',
  `
#table{margin:20.375px;width:320px;background:#f4f0e8;font:16px/20px Test;color:#234}
`,
);
