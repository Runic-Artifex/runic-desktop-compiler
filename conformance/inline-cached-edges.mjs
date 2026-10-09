// Pure driving inputs. The tail owner observes the cursor after interior edges.
export const baseStyle = '#table{background:#f4f0e8;color:#234}';
export const cases = {};
const base =
  "margin:20.375px;width:178px;font:24px/32px Test;font-feature-settings:'liga' 1;direction:ltr";
const ordinary =
  'display:inline;vertical-align:baseline;box-decoration-break:slice;margin:0;padding:0;border:0 none #567;direction:ltr';
const viewports = [1, 1.25, 2].map(dpr => [420, 220, dpr]);
const margin = (kind, value) =>
  `${ordinary};${kind !== 'end' ? `margin-left:${value}px;` : ''}${kind !== 'start' ? `margin-right:${value}px` : ''}`;
for (const [sequence, left, right] of [
  ['fi', 'f', 'i'],
  ['combining', 'e', '\u0301'],
]) {
  for (const kind of ['start', 'end', 'empty']) {
    const owner = content =>
      `<span id="owner" data-client-rects data-line-widths style="${ordinary}">${content}</span>`;
    const content =
      kind === 'start'
        ? left + owner(right)
        : kind === 'end'
          ? owner(left) + right
          : left + owner('') + right;
    const tail = `<span id="tail" data-client-rects data-line-widths style="${ordinary}">Z</span>`;
    cases[`${sequence}_${kind}_cached_cursor`] = {
      standards: true,
      suite: 'inline',
      region: 'table',
      regions: ['table', 'owner', 'tail'],
      viewports,
      html: `<div id="table" data-client-rects data-line-widths style="${base}">${content}${tail}</div>`,
      actions: [
        { kind: 'style', selector: '#owner', value: margin(kind, 9.125) },
        { kind: 'style', selector: '#owner', value: ordinary },
        { kind: 'style', selector: '#owner', value: margin(kind, -3.375) },
        { kind: 'style', selector: '#owner', value: margin(kind, 9.125) },
        { kind: 'style', selector: '#table', value: `${base};font-size:28px` },
        { kind: 'style', selector: '#table', value: base },
        { kind: 'style', selector: '#owner', value: ordinary },
      ],
      browserStyleRequirements: [
        { selector: '#owner', property: 'display', value: 'inline' },
        { selector: '#tail', property: 'display', value: 'inline' },
        { selector: '#owner', property: 'boxDecorationBreak', value: 'slice' },
      ],
    };
  }
}
export const counts = {
  cases: Object.keys(cases).length,
  states: Object.values(cases).reduce((n, c) => n + c.viewports.length * (c.actions.length + 1), 0),
};

// Importing the cases does not run the browser/native oracle.
if (process.argv[1]) {
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  if (path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const { runRenderingCases } = await import('./harness/rendering.mjs');
    await runRenderingCases(cases, {}, 'inline-cached-edges', baseStyle);
  }
}
