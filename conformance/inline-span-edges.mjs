// Ordinary inline owners preserve shaped-atom attribution until horizontal edges
// introduce advances. Compare client fragments, unions, hits and local paint.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 260, dpr]);
const base = "margin:20.375px;width:178px;font:24px/32px Test;font-feature-settings:'liga' 1";
const ordinary = 'display:inline;vertical-align:baseline';
const span = (content = '', style = '') =>
  `<span id="owner" data-client-rects style="${ordinary};${style}">${content}</span>`;
const child = (content = '', style = '') =>
  `<span id="child" data-client-rects style="${ordinary};${style}">${content}</span>`;
const atomic =
  '<i id="atomic" data-client-rects style="display:inline-block;width:9.125px;height:12.375px;background:#567"></i>';

function add(name, content, options = {}) {
  const containerStyle = options.base ?? base;
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: [
      'table',
      'owner',
      ...(content.includes('id="child"') ? ['child'] : []),
      ...(content.includes('id="atomic"') ? ['atomic'] : []),
      ...(content.includes('id="before"') ? ['before', 'after'] : []),
    ],
    viewports,
    html: `<div id="table" data-client-rects style="${containerStyle}">${content}</div>`,
    actions: options.actions ?? [
      ...(options.fontRefresh
        ? [{ kind: 'style', selector: '#table', value: `${containerStyle};font-size:28px` }]
        : []),
      {
        kind: 'style',
        selector: '#owner',
        value: `${ordinary};${options.style ?? ''};margin-right:9.125px`,
      },
      {
        kind: 'style',
        selector: '#table',
        value: `${containerStyle};${options.fontRefresh ? 'font-size:28px;' : ''}width:48.375px`,
      },
    ],
  };
}
const ownership = (name, content) => add(`ownership_${name}`, content, { fontRefresh: true });

// Whole ligature/combining atoms may belong to the first text owner, leaving the
// following ordinary owner with a zero-width fragment. No fractional attribution
// is prescribed here: Chromium is the reference for every observed fragment.
ownership('cross_open', `f${span('i')}`);
ownership('cross_close', `${span('f')}i`);
ownership('combining_open', `e${span('\u0301')}`);
ownership('nested_cross_open', `f${span(child('i'))}`);
ownership('internal_ligature', `f${span('fi')}i`);
ownership(
  'empty_siblings',
  `f<span id="before" data-client-rects></span>${span()}<span id="after" data-client-rects></span>i`,
);
ownership('atomic_before_empty', `f${atomic}${span()}i`);
ownership('atomic_after_empty', `f${span()}${atomic}i`);
ownership('pending_before_open', `f ${span('i')}`);
ownership('pending_inside_close', `f${span('i ')}fi`);
ownership('space_after_close', `f${span('i')} fi`);
ownership('space_inside_open', `f${span(' i')}fi`);

for (const [name, margin] of [
  ['positive', '7.125px'],
  ['negative', '-3.375px'],
  ['zero', '0px'],
  ['percentage', '5%'],
  ['calc', 'calc(5% + 2.125px)'],
  ['auto', 'auto'],
]) {
  const style = `margin-left:${margin};margin-right:${margin}`;
  add(`margin_${name}`, `f${span('i', style)}fi`, { style });
}

const padding = 'padding-left:3.375px;padding-right:5.125px;background:#def';
const border = 'border-left:1.125px solid #567;border-right:2.375px solid #567';
const decorated = `${padding};${border}`;
for (const [name, style] of [
  ['padding', padding],
  ['border', border],
  ['padding_border', `${decorated};margin-left:2.125px;margin-right:4.375px`],
]) {
  add(name, `f${span('i', style)}fi`, { style });
}
add('empty_edges', `f${span('', decorated)}i`, { style: decorated });
add('sole_empty_edges', span('', decorated), { style: decorated });
add('sole_text_edges', span('fi', decorated), { style: decorated });
add('nested_edges', `f${span(child('i', 'margin:0 2.125px;padding:0 1.375px'), decorated)}fi`, {
  style: decorated,
});
add('narrow_wrap', `fi ${span(`Alpha ${child('Beta')} Gamma`, decorated)} fi`, {
  base: base.replace('width:178px', 'width:92.375px'),
  style: decorated,
});
for (const width of ['max-content', 'min-content']) {
  const style = 'margin:0 5%;padding:0 2.125px;border:1px solid #567;background:#def';
  add(`intrinsic_${width.replace('-', '_')}`, `fi ${span(`Alpha ${child('Beta')} Gamma`, style)} fi`, {
    base: base.replace('width:178px', `width:${width}`),
    style,
  });
}

// Stylo accepts both values. Keep clone in the oracle even if its native fragment
// decoration is incomplete; lack of parity must remain visible in the result.
for (const mode of ['slice', 'clone']) {
  const style = `${decorated};box-decoration-break:${mode}`;
  add(`decoration_${mode}`, `fi ${span(`Alpha ${child('Beta')} Gamma`, style)} fi`, {
    base: base.replace('width:178px', 'width:92.375px'),
    style,
  });
}

await runRenderingCases(cases, {}, 'inline-span-edges', '#table{background:#f4f0e8;color:#234}');
