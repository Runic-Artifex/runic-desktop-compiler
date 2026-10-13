// Measures the `CSS.supports(property, value)` answers the frontend gives at
// build time (frontend/css-supports.ts) in the conformance Chromium, and
// fails where Chromium answers otherwise. It also asks the one-argument
// form, `CSS.supports("(property: value)")`, which must agree.
//
// Run explicitly (never during builds), in the dev shell:
//   node conformance/css-supports.mjs
import { createRequire } from 'node:module';
import { CSS_SUPPORTS } from '../frontend/css-supports.ts';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const browser = await chromium.launch({ headless: true, channel: 'chromium' });
let failed = 0;
try {
  const page = await browser.newPage();
  const keys = Object.keys(CSS_SUPPORTS);
  const answers = await page.evaluate(
    pairs =>
      pairs.map(([p, v]) => ({
        two: CSS.supports(p, v),
        condition: CSS.supports(`(${p}: ${v})`),
      })),
    keys.map(k => {
      const at = k.indexOf(': ');
      return [k.slice(0, at), k.slice(at + 2)];
    }),
  );
  console.log(`Chromium ${browser.version()}`);
  keys.forEach((k, i) => {
    const { two, condition } = answers[i];
    const want = CSS_SUPPORTS[k].chromium;
    const ok = two === want && condition === want;
    if (!ok) failed++;
    console.log(
      `  ${ok ? 'ok  ' : 'FAIL'} CSS.supports(${JSON.stringify(k)}): ${two} (condition ${condition}; table ${want})`,
    );
  });
} finally {
  await browser.close();
}
if (failed) {
  console.error(`${failed} answer(s) differ from frontend/css-supports.ts`);
  process.exit(1);
}
