#!/usr/bin/env node
// Measure the properties Chromium parses in a declaration block, for
// crates/runic-css/src/chromium-properties.txt (the inline style checks of
// runic_css::inline and collect.mjs's `chromiumDrops`): the names of Blink's
// css_properties.json5 (its properties and aliases, without `-internal-`
// ones) for which `CSS.supports(name, "inherit")` holds in the harness's
// Chromium. The json5 is untrusted input: only its `name:` strings are read.
//
//   node conformance/chromium-properties.mjs <css_properties.json5>
//
// (third_party/blink/renderer/core/css/css_properties.json5 at the tag of
// the harness's Chromium, e.g. 153.0.8010.12.)
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const [, , json5] = process.argv;
if (!json5) throw new Error('usage: node conformance/chromium-properties.mjs <css_properties.json5>');
const names = [
  ...new Set(
    [...readFileSync(json5, 'utf8').matchAll(/^ {6}name: "([-a-z0-9]+)"/gm)]
      .map(m => m[1])
      .filter(n => !n.startsWith('-internal-')),
  ),
];
const { chromium } = createRequire(import.meta.url)('playwright-core');
const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const page = await browser.newPage();
const supported = await page.evaluate(
  names => names.filter(n => CSS.supports(n, 'inherit')),
  names,
);
console.log(`Chromium ${browser.version()}: ${supported.length} of ${names.length} names`);
await browser.close();
writeFileSync(
  new URL('../crates/runic-css/src/chromium-properties.txt', import.meta.url),
  [...supported].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join('\n') + '\n',
);
