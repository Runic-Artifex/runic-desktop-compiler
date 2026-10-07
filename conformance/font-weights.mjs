// CSS face ranges are matching capabilities, not invented variable axes.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runRenderingCases } from './harness/rendering.mjs';

const sources = {
  static: new URL('../fixtures/counter-svelte/assets/DejaVuSans.woff2', import.meta.url),
  variable: new URL(
    '../../RunicArtifex/parley-chromium-parity/parley_dev/assets/fonts/roboto_fonts/RobotoFlex-VariableFont.ttf',
    import.meta.url,
  ),
};
const fonts = {},
  hashes = {};
for (const [name, url] of Object.entries(sources)) {
  const bytes = await readFile(url);
  fonts[name] = bytes.toString('base64');
  hashes[name] = createHash('sha256').update(bytes).digest('hex');
}
const face = (family, source, range) =>
  `@font-face{font-family:${family};src:url(data:font/${source === 'static' ? 'woff2' : 'ttf'};base64,${fonts[source]});font-weight:${range}}`;
const styles = [
  face('StaticRange', 'static', '100 900'),
  face('StaticSingle', 'static', '400'),
  face('VariableRange', 'variable', '100 900'),
  face('VariableRestricted', 'variable', '300 600'),
  face('RangeSelection', 'static', '100 900'),
  face('RangeSelection', 'variable', '400 600'),
].join('');
const cases = {};
for (const family of [
  'StaticRange',
  'StaticSingle',
  'VariableRange',
  'VariableRestricted',
  'RangeSelection',
]) {
  const weights =
    family === 'RangeSelection' ? [100, 700, 900] : [100, 300, 400, 450.5, 600, 700, 900];
  cases[family] = {
    suite: 'fonts',
    standards: true,
    region: 'table',
    regions: weights.map((_, i) => `weight-${i}`),
    viewports: [
      [640, 300, 1],
      [640, 300, 2],
    ],
    html: `<div id="table" style="font-family:${family};font-size:16px;line-height:normal">${weights.map((weight, i) => `<div><span id="weight-${i}" style="font-weight:${weight}">Hamburgefontsiv ${weight}</span></div>`).join('')}</div>`,
    actions: [
      {
        kind: 'attribute',
        selector: '#table',
        name: 'style',
        value: `font-family:${family};font-size:24px;line-height:normal`,
      },
    ],
  };
}
// Preserve the auto/normal failures above; isolate weight-axis selection here.
for (const family of ['VariableRange', 'VariableRestricted']) {
  const original = cases[family];
  const style = `font-family:${family};font-size:16px;line-height:24px;font-optical-sizing:none`;
  cases[`${family}OpticalNone`] = {
    ...original,
    html: original.html.replace(`font-family:${family};font-size:16px;line-height:normal`, style),
    actions: [
      {
        kind: 'attribute',
        selector: '#table',
        name: 'style',
        value: `font-family:${family};font-size:24px;line-height:32px;font-optical-sizing:none`,
      },
    ],
  };
}
await runRenderingCases(cases, {}, 'font-weights', styles);
await mkdir(new URL('../artifacts/font-weights/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../artifacts/font-weights/fonts.json', import.meta.url),
  JSON.stringify(
    {
      hashes,
      variableSourceRevision: '718dcb721941fd8e72128833122d31f5a4e80504',
      spec: 'https://drafts.csswg.org/css-fonts-4/#font-prop-desc',
    },
    null,
    2,
  ) + '\n',
);
