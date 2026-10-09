// Draft additive oracle inputs only. Importing does not load the rendering
// harness, launch a browser, build a probe, or write runtime observations.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const outName = 'inline-border-history';
export const baseStyle = '#table{background:#f4f0e8;color:#234}';
export const cases = {};
const viewports = [1, 1.25, 2].map(dpr => [420, 220, dpr]);
const base =
  "margin:20.375px;width:178px;font:24px/32px Test;font-feature-settings:'liga' 1;direction:ltr";
const ordinary =
  'display:inline;vertical-align:baseline;box-decoration-break:slice;margin:0;padding:0;border:0 none #567;direction:ltr';
const side = (name, style, width) => `border-${name}:${width}px ${style} #567`;
const ownerStyle = value => ({
  kind: 'style',
  selector: '#owner',
  value: `${ordinary};${value}`,
});

function add(name, topology, styles, rationale) {
  const owner =
    `<span id="owner" data-client-rects data-line-widths ` +
    `data-hit-points="[[-4,8],[0,8],[4,8],[12,8]]" style="${ordinary};${styles[0]}">` +
    `${topology === 'open' ? 'i' : topology === 'close' ? 'f' : ''}</span>`;
  const content =
    topology === 'open' ? `f${owner}` : topology === 'close' ? `${owner}i` : `f${owner}i`;
  cases[name] = {
    standards: true,
    suite: 'inline',
    region: 'table',
    regions: ['table', 'owner'],
    viewports,
    html: `<div id="table" data-client-rects data-hit-points="[[1,16],[12,16],[24,16]]" style="${base}">${content}</div>`,
    actions: [
      ...styles.slice(1).map(ownerStyle),
      { kind: 'style', selector: '#table', value: `${base};font-size:28px` },
      { kind: 'style', selector: '#table', value: base },
    ],
    browserStyleRequirements: [
      { selector: '#owner', property: 'display', value: 'inline' },
      { selector: '#owner', property: 'boxDecorationBreak', value: 'slice' },
      { selector: '#owner', property: 'direction', value: 'ltr' },
    ],
    // Informational metadata only; no expected geometry, pixels or cache IDs.
    borderCacheCandidate: { topology, authoredBorderStates: styles, rationale },
  };
}

const leftNone = side('left', 'none', 4);
const leftSolid = side('left', 'solid', 4);
const rightNone = side('right', 'none', 4);
const rightSolid = side('right', 'solid', 4);
const bothHidden = `${side('left', 'hidden', 4)};${side('right', 'hidden', 4)}`;
const bothSolid = `${leftSolid};${rightSolid}`;
const topNone = side('top', 'none', 4);
const topSolid = side('top', 'solid', 4);

add(
  'fi_open_none_solid_roundtrip',
  'open',
  [leftNone, leftSolid, leftNone, leftSolid],
  'Opening inline edge: authored width stays 4px while effective presence changes.',
);
add(
  'fi_close_solid_none_roundtrip',
  'close',
  [rightSolid, rightNone, rightSolid, rightNone],
  'Closing inline edge: start from a decorated shape and remove effective presence.',
);
add(
  'fi_empty_hidden_solid_roundtrip',
  'empty',
  [bothHidden, bothSolid, bothHidden, bothSolid],
  'Empty inline: hidden and solid share authored widths but differ in effective presence.',
);
add(
  'fi_open_effective_zero_styles',
  'open',
  [leftNone, side('left', 'hidden', 4), side('left', 'solid', 0), side('left', 'none', 8)],
  'All effective widths stay zero across none, hidden, solid-zero and authored-width changes.',
);
add(
  'fi_open_present_width_roundtrip',
  'open',
  [
    side('left', 'solid', 2),
    side('left', 'solid', 6),
    side('left', 'solid', 2),
    side('left', 'solid', 6),
  ],
  'Effective presence stays true while an existing opening border changes numeric width.',
);
add(
  'fi_open_present_side_transfer',
  'open',
  [rightSolid, leftSolid, rightSolid, leftSolid],
  'Move the sole nonzero border from after i to the interior f|i opening without changing aggregate presence.',
);
add(
  'fi_close_present_side_transfer',
  'close',
  [leftSolid, rightSolid, leftSolid, rightSolid],
  'Move the sole nonzero border from before f to the interior f|i closing without changing aggregate presence.',
);
add(
  'fi_open_top_presence_roundtrip',
  'open',
  [topNone, topSolid, topNone, topSolid],
  'Block-side-only presence transition exercises aggregate HasBorder without adding an inline-side width.',
);
add(
  'fi_open_top_sentinel_roundtrip',
  'open',
  [topSolid, `${topSolid};${leftSolid}`, topSolid, `${topSolid};${leftSolid}`],
  'A persistent top border keeps aggregate presence true while an interior opening border appears.',
);

export const counts = {
  cases: Object.keys(cases).length,
  statesPerViewport: Object.values(cases).reduce((sum, entry) => sum + 1 + entry.actions.length, 0),
  states: Object.values(cases).reduce(
    (sum, entry) => sum + entry.viewports.length * (1 + entry.actions.length),
    0,
  ),
};

// Importing the cases does not run the browser/native oracle.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { runRenderingCases } = await import('./harness/rendering.mjs');
  await runRenderingCases(cases, {}, outName, baseStyle);
}
