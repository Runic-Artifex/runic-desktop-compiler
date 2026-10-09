// Primary drivers for ordered inline flow events. Chromium supplies expected
// fragment ownership, signed advances and break affinity; no geometry is guessed.
// Keep inline-span-edges.mjs and its existing 306 states unchanged.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 260, dpr]);
const base =
  "position:relative;margin:20.375px;width:84.375px;font:24px/32px Test;font-feature-settings:'liga' 1";
const ordinary = 'display:inline;vertical-align:baseline;box-decoration-break:slice';
const opening =
  'margin-left:9.125px;padding-left:2.375px;border-left:1.125px solid #567;background:#def';
const closing =
  'margin-right:15.125px;padding-right:2.375px;border-right:1.125px solid #567;background:#def';
const both = `${opening};${closing}`;
const box = (id, content = '', style = '') =>
  `<span id="${id}" data-client-rects data-hit-points="[[-4,8],[0,8],[4,8],[12,8]]" style="${ordinary};${style}">${content}</span>`;
const span = (content = '', style = '') => box('owner', content, style);
const atomic =
  '<i id="atomic" data-client-rects style="display:inline-block;width:9.125px;height:12.375px;background:#567"></i>';
// Deliberately retain auto offsets: its static position observes the source-order
// checkpoint amid pending whitespace, while the box adds no inline advance.
const oof =
  '<i id="oof" data-client-rects style="position:absolute;width:9.125px;height:12.375px;background:#765"></i>';
const ownerStyle = value => ({ kind: 'style', selector: '#owner', value: `${ordinary};${value}` });

function add(name, content, options = {}) {
  const containerStyle = options.base ?? base;
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', ...content.matchAll(/id="([^"]+)"/g)].map(value =>
      typeof value === 'string' ? value : value[1],
    ),
    viewports,
    html: `<div id="table" data-client-rects data-hit-points="[[1,16],[42,16],[83,16],[1,48],[42,48],[83,48]]" style="${containerStyle}">${content}</div>`,
    actions: options.actions ?? [
      { kind: 'style', selector: '#table', value: `${containerStyle};width:156.375px` },
      { kind: 'style', selector: '#table', value: containerStyle },
    ],
    ...(options.requirements ? { browserStyleRequirements: options.requirements } : {}),
  };
}

// A real opening follows the next word when its start advance prevents that word
// fitting; a real closing remains with the preceding word and its end advance.
add('opening_wrap_text', `AA ${span('BB CC', opening)} DD`);
add('closing_wrap_text', `AA ${span('BB', closing)} CC DD`);
// A trailing empty or space-only open/close pair need not follow a next word.
add('opening_trailing_empty', `AA BB ${span('', opening)}`);
add('opening_trailing_space_only', `AA BB ${span(' \t ', opening)}`);

// The preceding AAAA provisionally overflows after AA. A signed start margin can
// restore fit before B is laid out; removing it must replay the earlier break.
const recovery = 'margin-left:-26.375px;background:#def';
add('negative_open_restores_overflow', `AA AAAA${span('B', recovery)}`, {
  base: base.replace('width:84.375px', 'width:100.375px'),
  actions: [ownerStyle('margin-left:0px;background:#def'), ownerStyle(recovery)],
});

// Every empty tag shares a text position. Preserve nested and sibling event
// order, even when its signed advances cancel and its border box remains wide.
const cancellation =
  'margin-left:-3.375px;padding-left:3.375px;margin-right:-5.125px;padding-right:5.125px;background:#def';
const emptyChild = box(
  'child',
  '',
  'margin-left:2.125px;padding-left:1.375px;margin-right:-3.5px;background:#abc',
);
add('empty_equal_position_nested', `AA ${span(emptyChild, cancellation)} BB`, {
  actions: [ownerStyle(`${cancellation};margin-left:4.125px`), ownerStyle(cancellation)],
});
const before = box('before', '', 'margin-left:2.125px;padding-left:1.375px;background:#abc');
const after = box('after', '', 'margin-right:-3.5px;padding-right:2.125px;background:#cba');
const siblings = order => `AA ${order.join('')} BB`;
const emptyOwner = span('', cancellation);
add('empty_equal_position_siblings', siblings([before, emptyOwner, after]), {
  actions: [
    { kind: 'html', selector: '#table', value: siblings([after, emptyOwner, before]) },
    { kind: 'html', selector: '#table', value: siblings([before, emptyOwner, after]) },
  ],
});

// Pending spaces must be consumed or collapsed in event order, rather than
// moving an opening/closing edge by a precomputed aggregate text width.
add('pending_before_open', `AA ${span('BB CC', opening)} DD`, {
  actions: [ownerStyle('background:#def'), ownerStyle(opening)],
});
add('pending_inside_close', `AA${span('BB ', closing)}CC DD`);
add('collapsed_across_empty', `AA \t${span(' \t', both)} \tBB CC`);
add('pending_atomic_before_open', `AA ${atomic}${span(' BB', opening)} CC`);
add('pending_atomic_inside_close', `AA${span(`BB ${atomic} `, closing)}CC DD`);
add('pending_oof_inside_open_close', `AA ${span(` ${oof}BB `, both)}CC DD`);

// A preserved newline and br keep immediately following close tags on the
// forced-break line. The next word observes whether the end edge migrated.
add('forced_newline_close', `AA${span('BB\n', both)}CC DD`, {
  base: `${base};white-space:pre-wrap`,
  requirements: [{ selector: '#table', property: 'whiteSpace', value: 'pre-wrap' }],
});
add('forced_br_close', `AA${span(`BB<br>${box('child')}`, both)}CC DD`);

// CSS direction on an ordinary inline does not establish a bidi embedding.
// ASCII words and asymmetric physical edges distinguish parent flow direction
// from owner direction without certifying mixed-bidi visual-order behavior.
const directionBase = `${base};direction:ltr`;
add('parent_vs_owner_direction', `AA ${span('BB CC', `${both};direction:rtl`)} DD`, {
  base: directionBase,
  requirements: [
    { selector: '#table', property: 'direction', value: 'ltr' },
    { selector: '#owner', property: 'direction', value: 'rtl' },
  ],
  actions: [
    ownerStyle(`${both};direction:ltr`),
    { kind: 'style', selector: '#table', value: `${base};direction:rtl` },
    ownerStyle(`${both};direction:rtl`),
  ],
});

// Intrinsic queries must replay signed start/end events through their own break
// construction. Owner mutations must invalidate both intrinsic and final layout.
const intrinsic =
  'margin-left:-7.125px;padding-left:3.375px;margin-right:11.125px;padding-right:2.375px;border-right:1.125px solid #567;background:#def';
for (const width of ['min-content', 'max-content']) {
  add(
    `intrinsic_${width.replace('-', '_')}`,
    `AA ${span(`BB ${box('child', 'CCC')} D`, intrinsic)} EE`,
    {
      base: base.replace('width:84.375px', `width:${width}`),
      actions: [ownerStyle(`${intrinsic};margin-left:7.125px`), ownerStyle(intrinsic)],
      requirements: [{ selector: '#owner', property: 'boxDecorationBreak', value: 'slice' }],
    },
  );
}

await runRenderingCases(cases, {}, 'inline-flow-affinity', '#table{background:#f4f0e8;color:#234}');
