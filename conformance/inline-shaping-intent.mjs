// CSS category and ordinary-span boundaries are distinct from geometric alignment.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 220, dpr]);
const base = 'margin:20.375px;width:178px;font:24px/32px Test;font-feature-settings:"liga" 1';
const span = (style, content = '') =>
  `<span id="inner" data-client-rects style="${style}">${content}</span>`;
function add(name, content, options = {}) {
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', 'inner'],
    viewports,
    html: `<div id="table" style="${options.base ?? base}">${content}</div>`,
    actions: options.actions ?? [{ kind: 'style', selector: '#table', value: `${options.base ?? base};font-size:28px` }],
  };
}
add('empty_baseline', `f${span('vertical-align:baseline')}i`);
add('empty_zero_px', `f${span('vertical-align:0px')}i`);
add('empty_zero_percent', `f${span('vertical-align:0%')}i`);
add('empty_calc_zero', `f${span('vertical-align:calc(3px - 3px)')}i`);
add('start_baseline', `f${span('vertical-align:baseline', 'i')}`);
add('start_zero', `f${span('vertical-align:0px', 'i')}`);
add('end_baseline', `${span('vertical-align:baseline', 'f')}i`);
add('end_zero', `${span('vertical-align:0px', 'f')}i`);
add('internal_ligature', `f${span('vertical-align:0px', 'fi')}i`);
add('nonempty_length', `f${span('vertical-align:3px', 'i')}`);
add('nonempty_middle', `f${span('vertical-align:middle', 'i')}`);
add('nested_outer_zero', `f<span id="outer" data-client-rects style="vertical-align:0px">${span('vertical-align:baseline')}</span>i`);
add('nested_inner_zero', `f<span id="outer" data-client-rects>${span('vertical-align:0px')}</span>i`);
add('contents_empty', `f${span('display:contents;vertical-align:0px')}i`);
add('contents_text', `f${span('display:contents;vertical-align:0px', 'i')}`);
add('pending_before_open', `f ${span('vertical-align:0px')}i`);
add('pending_inside_close', `f${span('vertical-align:0px', 'i ')}fi`);
add('space_after_close', `f${span('vertical-align:0px', 'i')} fi`);
add('intrinsic_max', `f${span('vertical-align:0px', 'fi')}i`, { base: base.replace('width:178px', 'width:max-content') });
add('narrow_wrap', `fi f${span('vertical-align:0px', 'i')} fi`, { base: base.replace('width:178px', 'width:27px') });
add('combining_baseline', `e${span('vertical-align:baseline', '\u0301')}`);
add('combining_zero', `e${span('vertical-align:0px', '\u0301')}`);
for (const [name, initial, next] of [
  ['mutation_add', 'baseline', '0px'],
  ['mutation_remove', '0px', 'baseline'],
]) {
  add(name, `f${span(`vertical-align:${initial}`, 'i')}`, {
    actions: [
      { kind: 'style', selector: '#inner', value: `vertical-align:${next}` },
      { kind: 'style', selector: '#inner', value: `vertical-align:${initial}` },
    ],
  });
}

await runRenderingCases(cases, {}, 'inline-shaping-intent', '#table{background:#f4f0e8;color:#234}');
