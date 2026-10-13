#!/usr/bin/env node
// Measure where Stylo (Blitz's preferences) and Chromium agree on declaration
// values beyond single identifiers, for runic_css's equivalence of drops
// (crates/runic-css/src/inline.rs `chromium_drops_value`, compiler/collect.mjs).
//
//   node conformance/chromium-grammar.mjs <bootstrap.css> [more.css ...]
//
// The corpus: the declarations of the given stylesheets (untrusted input,
// only parsed) and of every stylesheet under fixtures/ and examples/. Values
// of one identifier are left out: the keyword table decides them
// (chromium-keywords.txt). Each value is a sample, and so is each value with one of
// its numbers replaced by what JavaScript string building makes of a number
// (`-` before a negative number, NaN, Infinity, undefined, null; a template
// such as `translateX(-{x}%)` gives `translateX(--25%)`). Each sample is
// checked with `CSS.supports` in the harness's Chromium and with Stylo
// (runic_css::check). A property where both agree on every one of at least
// MIN samples is written to crates/runic-css/src/chromium-grammar.txt with
// the vocabulary its samples use (functions, units, identifiers;
// compiler/css-vocabulary.mjs): `<name>\t<samples>\t<functions>\t<units>\t<idents>`
// (space-separated lists). A value of such a property that Stylo drops,
// whose vocabulary is within the property's (artifact identifiers counted as
// one class), is taken to be dropped by Chromium too. Properties where the
// engines disagree on a sample are listed with that sample as `# ` lines.
import { readFileSync, writeFileSync, globSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import postcss from 'postcss';
import { cssCheck } from '../compiler/codegen.mjs';
import { vocabulary } from '../compiler/css-vocabulary.mjs';

const MIN = 20;
const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const files = [
  ...process.argv.slice(2),
  ...globSync('{fixtures,examples}/**/*.css', { cwd: repo })
    .filter(f => !f.includes('node_modules') && !f.includes('/dist/'))
    .map(f => path.join(repo, f)),
].sort();
if (process.argv.length < 3)
  throw new Error('usage: node conformance/chromium-grammar.mjs <bootstrap.css> [more.css ...]');

const NUMBER = /(?<![\w#.-])(-?)(\d*\.?\d+)(%|[a-z]+)?/gi;
const samples = new Map(); // `${prop}\n${value}` -> [prop, value]
const ONE_IDENT = /^-?-?[a-z_\u0080-\uffff][\w\u0080-\uffff-]*$|^--[\w-]*$/i;
const add = (prop, value) => ONE_IDENT.test(value) || samples.set(`${prop}\n${value}`, [prop, value]);
const sources = [];
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  sources.push(`${file.startsWith(repo + path.sep) ? path.relative(repo, file) : path.basename(file)} ${createHash('sha256').update(text).digest('hex').slice(0, 16)}`);
  let root;
  try {
    root = postcss.parse(text);
  } catch {
    continue;
  }
  root.walkDecls(d => {
    // Declarations of style rules (and keyframes), not at-rule descriptors.
    if (d.parent?.type !== 'rule') return;
    const prop = d.prop.toLowerCase();
    const value = d.value.trim();
    if (prop.startsWith('--') || /var\(|env\(|attr\(/i.test(value) || !value) return;
    add(prop, value);
    for (const m of value.matchAll(NUMBER)) {
      const [whole, sign, n, unit = ''] = m;
      const at = (s, i = m.index) => value.slice(0, i) + s + value.slice(i + whole.length);
      add(prop, at(`-${sign}${n}${unit}`));
      for (const artifact of ['NaN', 'undefined', 'null', `${sign}Infinity`])
        add(prop, at(`${artifact}${unit}`));
    }
  });
}
const list = [...samples.values()];
const { chromium } = createRequire(import.meta.url)('playwright-core');
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const page = await browser.newPage();
const inChromium = await page.evaluate(l => l.map(([p, v]) => CSS.supports(p, v)), list);
console.log(`Chromium ${browser.version()}: ${list.length} samples from ${sources.length} files`);
await browser.close();
const invalid = new Set(cssCheck('', list).invalid);

const byProperty = new Map();
list.forEach(([prop, value], i) => {
  const entry = byProperty.get(prop) ?? {
    samples: 0,
    disagreement: undefined,
    functions: new Set(),
    units: new Set(),
    idents: new Set(),
  };
  byProperty.set(prop, entry);
  entry.samples++;
  if (inChromium[i] === invalid.has(i))
    entry.disagreement ??= `${value} (Chromium ${inChromium[i] ? 'keeps' : 'drops'} it)`;
  const v = vocabulary(value);
  for (const k of ['functions', 'units', 'idents']) for (const x of v[k]) entry[k].add(x);
});
const sorted = [...byProperty].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
const lines = [`# Measured by conformance/chromium-grammar.mjs; corpus:`];
for (const s of sources) lines.push(`# ${s}`);
let agreed = 0;
for (const [prop, e] of sorted) {
  if (e.disagreement) {
    lines.push(`# ${prop}: disagree on ${e.disagreement}`);
    continue;
  }
  if (e.samples < MIN) continue;
  agreed++;
  const join = s => [...s].sort().join(' ');
  lines.push([prop, e.samples, join(e.functions), join(e.units), join(e.idents)].join('\t'));
}
writeFileSync(path.join(repo, 'crates/runic-css/src/chromium-grammar.txt'), lines.join('\n') + '\n');
console.log(
  `${agreed} properties agree on at least ${MIN} samples; ${sorted.filter(([, e]) => e.disagreement).length} disagree`,
);
