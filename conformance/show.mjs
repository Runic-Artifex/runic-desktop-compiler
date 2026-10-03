#!/usr/bin/env node
// Print the differing steps of a conformance report: node conformance/show.mjs [report.json] [filter]
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
let [file, filter = ''] = process.argv.slice(2);
if (!file) {
  const { existsSync, statSync } = await import('node:fs');
  const dirs = (await readdir('artifacts/conformance'))
    .map(d => path.join('artifacts/conformance', d, 'report.json'))
    .filter(f => existsSync(f))
    .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  file = dirs.at(-1);
}
const { runs } = JSON.parse(await readFile(file, 'utf8'));
for (const r of runs) {
  const label = `${r.case}/${r.fixture}/${r.viewport.width}x${r.viewport.height}`;
  if (!label.includes(filter)) continue;
  if (r.error) console.log('==', label, 'ERROR', r.error.split('\n').slice(0, 3).join(' | '));
  for (const s of r.steps ?? []) {
    if (!s.dom.length && !s.focus && !s.geometry.length && !s.missing && !(s.pixelMAE > 3)) continue;
    console.log('==', label, '#' + s.index, JSON.stringify(s.action));
    if (s.missing) console.log('   missing', s.missing);
    if (s.focus) console.log('   focus', JSON.stringify(s.focus));
    for (const d of s.dom) console.log('   dom', d.at, '\n     browser', JSON.stringify(d.browser), '\n     native ', JSON.stringify(d.native));
    for (const g of s.geometry) console.log('   geometry', JSON.stringify(g));
    if (s.pixelMAE > 3) console.log('   pixelMAE', s.pixelMAE);
  }
}
