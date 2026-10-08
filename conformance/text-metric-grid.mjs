// Keep logical geometry and device rasterization independent across font scales.
import { runRenderingCases } from './harness/rendering.mjs';

const cases = {};
for (const size of [12, 14, 16, 24]) {
  for (const origin of [0.125, 0.375]) {
    for (const script of ['latin', 'arabic']) {
      const text = script === 'latin' ? 'Alpha Agpq' : 'ترجمة Alpha';
      for (const kind of ['inline', 'input', 'textarea']) {
        const content =
          kind === 'inline'
            ? text
            : kind === 'input'
              ? `<input id="control" value="${text}">`
              : `<textarea id="control">${text}\nSecond line</textarea>`;
        cases[`${kind}_${script}_${size}_${origin === 0.125 ? 'eighth' : 'fraction'}`] = {
          suite: 'glyphs',
          standards: true,
          region: 'table',
          regions: kind === 'inline' ? ['table'] : ['table', 'control'],
          viewports: [
            [420, 180, 1],
            [420, 180, 1.25],
            [420, 180, 2],
          ],
          browserStyleRequirements:
            kind === 'inline'
              ? []
              : [{ selector: '#control', property: 'caretAnimation', value: 'manual' }],
          html: `<div id="table" class="${kind}" style="margin-left:${20 + origin}px;margin-top:20.375px;font:${size}px/${size * 1.25}px Test">${content}<i id="baseline"></i></div>`,
          actions:
            kind === 'inline'
              ? []
              : [
                  { kind: 'focus', selector: '#control' },
                  { kind: 'selection', selector: '#control', start: 1, end: 4 },
                  { kind: 'selection', selector: '#control', start: 0, end: 0 },
                ],
        };
      }
    }
  }
}

await runRenderingCases(
  cases,
  {},
  'text-metric-grid',
  `
#table{width:max-content;background:#f4f0e8}
#table.input,#table.textarea{display:flex;align-items:baseline}
#control{font:inherit;color:#234;width:180px;height:1.5em;padding:1px 2px;border:1px solid #567;background:white;caret-animation:manual}
textarea#control{height:2.5em;resize:none}
#baseline{display:inline-block;width:1px;height:1px;background:black;margin-left:4px}
`,
);
