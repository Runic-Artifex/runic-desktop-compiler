// Authored shaping-edge cases. No outcome or interior atom policy is prescribed.
// Importing this specification performs no browser/native/build work.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRenderingCases } from './harness/rendering.mjs';

const outName = 'inline-shaping-edges';
export const baseStyle = '#table{background:#f4f0e8;color:#234}';
export const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 260, dpr]);
const base =
  "position:relative;margin:20.375px;width:178px;font:24px/32px Test;font-feature-settings:'liga' 1";
const ordinary =
  'display:inline;vertical-align:baseline;box-decoration-break:slice;margin-left:0px;margin-right:0px';
const span = (content, style = ordinary) =>
  `<span id="owner" data-client-rects data-hit-points="[[-4,8],[0,8],[4,8],[12,8]]" style="${style}">${content}</span>`;
const ownerStyle = value => ({ kind: 'style', selector: '#owner', value });
const margin = (side, sign = 1) =>
  `${ordinary};${side === 'start' || side === 'both' ? `margin-left:${sign > 0 ? 9.125 : -3.375}px;` : ''}${side === 'end' || side === 'both' ? `margin-right:${sign > 0 ? 15.125 : -3.375}px;` : ''}`;
const decoration = side =>
  `${ordinary};${side === 'start' ? 'padding-left:2.375px;border-left:1.125px solid #567' : 'padding-right:2.375px;border-right:1.125px solid #567'}`;
function add(name, content, actions, seam) {
  const ids = [...content.matchAll(/id="([^"]+)"/g)].map(([, id]) => id);
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', ...ids],
    viewports,
    html: `<div id="table" data-client-rects data-hit-points="[[1,16],[42,16],[83,16]]" style="${base}">${content}</div>`,
    actions,
    browserStyleRequirements: [
      { selector: '#owner', property: 'display', value: 'inline' },
      { selector: '#owner', property: 'boxDecorationBreak', value: 'slice' },
    ],
    // Informational metadata, not interpreted as an expected result by the harness.
    seam,
  };
}
for (const [sequence, left, right] of [
  ['combining', 'e', '\u0301'],
  ['flag', '\u{1f1fa}', '\u{1f1f8}'],
]) {
  for (const side of ['start', 'end', 'both']) {
    const content =
      side === 'start'
        ? `${left}${span(right)}Z`
        : side === 'end'
          ? `${span(left)}${right}Z`
          : `${left}${span('')}${right}Z`;
    add(
      `${sequence}_${side === 'both' ? 'empty' : side}_margin`,
      content,
      [
        ownerStyle(margin(side)),
        ownerStyle(ordinary),
        ownerStyle(margin(side, -1)),
        ownerStyle(ordinary),
      ],
      { sequence, kind: 'unrequested numeric edge', interior: side },
    );
  }
  for (const side of ['start', 'end']) {
    const topology = style =>
      side === 'start' ? `${left}${span(right, style)}Z` : `${span(left, style)}${right}Z`;
    add(
      `${sequence}_${side}_padding_border`,
      topology(ordinary),
      [
        ownerStyle(decoration(side)),
        ownerStyle(ordinary),
        ownerStyle(decoration(side)),
        ownerStyle(ordinary),
      ],
      { sequence, kind: 'per-side decorated edge', interior: side },
    );
    const signed = margin(side);
    add(
      `${sequence}_${side}_alignment_intent`,
      topology(signed),
      [
        ownerStyle(`${signed};vertical-align:0px`),
        ownerStyle(signed),
        ownerStyle(ordinary),
        ownerStyle(signed),
      ],
      { sequence, kind: 'explicit alignment category with fixed signed edge', interior: side },
    );
  }
}
// Both authored orders normalize to e + SPACE + COMBINING ACUTE + Z, but the
// opening edge sees different pending whitespace relative to the OOF ordinal.
// Auto static offsets are left unforced; fixed and absolute remain separate.
for (const position of ['absolute', 'fixed']) {
  const oof = `<i id="oof" data-client-rects style="position:${position};width:9.125px;height:12.375px;background:#765"></i>`;
  for (const pending of ['before_open', 'after_oof']) {
    const content =
      pending === 'before_open' ? `e ${span(`${oof}\u0301`)}Z` : `e${span(`${oof} \u0301`)}Z`;
    add(
      `pending_${position}_${pending}_combining`,
      content,
      [
        ownerStyle(margin('both')),
        ownerStyle(ordinary),
        ownerStyle(margin('both', -1)),
        ownerStyle(ordinary),
      ],
      {
        sequence: 'combining after collapsed space',
        kind: 'authored OOF order',
        position,
        pending,
      },
    );
  }
}

// Importing the cases does not run the browser/native oracle.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runRenderingCases(cases, {}, outName, baseStyle);
}
