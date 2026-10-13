#!/usr/bin/env node
// Measure what Chromium parses in a declaration block, for runic_css's
// equivalence checks (crates/runic-css/src/inline.rs, compiler/collect.mjs's
// `chromiumDrops`). The json5 files are untrusted input: only their names and
// quoted keywords are read.
//
//   node conformance/chromium-properties.mjs <css_properties.json5> <css_value_keywords.json5>
//
// (third_party/blink/renderer/core/css/ at the tag of the harness's Chromium,
// e.g. 153.0.8010.12.) It writes
//
// - crates/runic-css/src/chromium-properties.txt: the names of Blink's
//   properties and aliases (without `-internal-` ones) for which
//   `CSS.supports(name, "inherit")` holds;
// - crates/runic-css/src/chromium-keywords.txt: for a declaration whose value
//   is one identifier, what decides whether Chromium keeps it where Stylo
//   (Blitz's preferences) drops it. One line per property,
//   `<name>\t<flags>\t<keywords>`: flag `u` where Stylo parses no value of the
//   property (the keywords are then every Blink keyword Chromium accepts
//   alone), `c` where Chromium accepts an arbitrary identifier (a custom
//   ident); otherwise the keywords Chromium accepts alone and Stylo drops.
//   Properties with neither flag nor keyword are left out.
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { cssCheck } from '../compiler/codegen.mjs';

const [, , propertiesJson5, keywordsJson5] = process.argv;
if (!propertiesJson5 || !keywordsJson5)
  throw new Error(
    'usage: node conformance/chromium-properties.mjs <css_properties.json5> <css_value_keywords.json5>',
  );
const names = [
  ...new Set(
    [...readFileSync(propertiesJson5, 'utf8').matchAll(/^ {6}name: "([-a-z0-9]+)"/gm)]
      .map(m => m[1])
      .filter(n => !n.startsWith('-internal-')),
  ),
];
const keywords = [
  ...new Set(
    [...readFileSync(keywordsJson5, 'utf8').matchAll(/^\s+(?:name: )?"(-?[a-z][-a-z0-9]*)"/gm)]
      .map(m => m[1])
      .filter(k => !k.startsWith('-internal-')),
  ),
];
// An identifier no grammar names: accepted only where custom idents are.
const ARBITRARY = 'runic-arbitrary-ident';
const { chromium } = createRequire(import.meta.url)('playwright-core');
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const page = await browser.newPage();
const measured = await page.evaluate(
  ([names, keywords, arbitrary]) =>
    names
      .filter(n => CSS.supports(n, 'inherit'))
      .map(n => ({
        name: n,
        custom: CSS.supports(n, arbitrary),
        keywords: keywords.filter(k => CSS.supports(n, k)),
      })),
  [names, keywords, ARBITRARY],
);
console.log(
  `Chromium ${browser.version()}: ${measured.length} of ${names.length} properties, ${keywords.length} keywords`,
);
await browser.close();
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
writeFileSync(
  new URL('../crates/runic-css/src/chromium-properties.txt', import.meta.url),
  measured
    .map(p => p.name)
    .sort(byName)
    .join('\n') + '\n',
);
// Stylo's verdicts on the same declarations (runic_css::check).
const decls = measured.flatMap(p => [[p.name, 'inherit'], ...p.keywords.map(k => [p.name, k])]);
const invalid = new Set(cssCheck('', decls).invalid);
const lines = [];
let i = 0;
for (const p of measured) {
  const unknown = invalid.has(i++);
  const dropped = p.keywords.filter(() => invalid.has(i++));
  const flags = (unknown ? 'u' : '') + (p.custom ? 'c' : '');
  const listed = unknown ? p.keywords : dropped;
  if (flags || listed.length) lines.push(`${p.name}\t${flags}\t${listed.join(' ')}`);
}
writeFileSync(
  new URL('../crates/runic-css/src/chromium-keywords.txt', import.meta.url),
  lines.sort(byName).join('\n') + '\n',
);
console.log(`${lines.length} properties in chromium-keywords.txt`);
