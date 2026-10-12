// Generates internationalized-date-3.12.4.json: the Chromium facts the
// @internationalized/date pack's port relies on
// (frontend/packs/internationalized-date-3.12.4/date.ts):
//
// - for the verified locales, `new Intl.Locale(l).getWeekInfo().firstDay`
//   (the package's week start) and `maximize().region` (its weekend lookup);
// - in pages emulating UTC, Europe/Berlin and America/New_York: the default
//   zone (`resolvedOptions().timeZone`, the package's `getLocalTimeZone`),
//   and whether the wall time the package reads with `formatToParts`
//   (en-US, hour12 false, era) equals the Date getters, for UTC and for the
//   default zone, at instants across eras, the Julian/Gregorian switch, the
//   epoch and DST transitions;
// - the error `formatToParts` throws for an invalid date.
//
// tests/internationalized-date.test.mjs checks the port's tables and the
// port against the package (in Node) and reads this file for the Chromium
// side.
//
// Run explicitly (never during builds): node conformance/packs/internationalized-date.mjs
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

export const LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP', 'en', 'de', 'fr', 'ja'];
export const ZONES = ['UTC', 'Europe/Berlin', 'America/New_York'];
const INSTANTS = [
  Date.UTC(-500, 5, 1),
  Date.UTC(1, 0, 1),
  Date.UTC(1000, 0, 1),
  Date.UTC(1582, 9, 14),
  Date.UTC(1582, 9, 16),
  -1,
  0,
  Date.UTC(2025, 2, 30, 0, 59, 59),
  Date.UTC(2025, 2, 30, 1, 30),
  Date.UTC(2025, 2, 9, 7, 30),
  Date.UTC(2025, 9, 26, 0, 30),
  Date.UTC(2025, 10, 2, 5, 30),
  Date.UTC(2025, 10, 2, 6, 30),
  Date.UTC(9999, 11, 31, 23, 59, 59, 999),
];

const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const out = { browser: browser.version(), locales: {}, zones: {} };
try {
  for (const tz of ZONES) {
    const page = await browser.newPage({ timezoneId: tz, locale: 'en-US' });
    const r = await page.evaluate(
      ({ instants, locales }) => {
        const wall = (ms, timeZone) => {
          const f = new Intl.DateTimeFormat('en-US', {
            timeZone,
            hour12: false,
            era: 'short',
            year: 'numeric',
            month: 'numeric',
            day: 'numeric',
            hour: 'numeric',
            minute: 'numeric',
            second: 'numeric',
          });
          const o = {};
          for (const p of f.formatToParts(new Date(ms))) if (p.type !== 'literal') o[p.type] = p.value;
          const year = o.era === 'BC' || o.era === 'B' ? 1 - +o.year : +o.year;
          return [year, +o.month, +o.day, +o.hour, +o.minute, +o.second];
        };
        const getters = (ms, utc) => {
          const d = new Date(ms);
          return utc
            ? [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()]
            : [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()];
        };
        const differences = [];
        for (const ms of instants)
          for (const [zone, utc] of [
            ['UTC', true],
            [undefined, false],
          ]) {
            const a = wall(ms, zone);
            const b = getters(ms, utc);
            if (JSON.stringify(a) !== JSON.stringify(b)) differences.push({ ms, zone: zone ?? 'default', intl: a, getters: b });
          }
        let invalid;
        try {
          new Intl.DateTimeFormat('en-US').formatToParts(new Date(NaN));
        } catch (e) {
          invalid = `${e.name}: ${e.message}`;
        }
        const info = {};
        for (const l of locales) {
          const loc = new Intl.Locale(l);
          info[l] = { firstDay: loc.getWeekInfo().firstDay, region: loc.maximize().region };
        }
        return {
          resolved: new Intl.DateTimeFormat().resolvedOptions().timeZone,
          compared: instants.length * 2,
          differences,
          invalid,
          info,
        };
      },
      { instants: INSTANTS, locales: LOCALES },
    );
    await page.close();
    out.zones[tz] = {
      resolved: r.resolved,
      compared: r.compared,
      differences: r.differences,
      invalid: r.invalid,
    };
    // (Week data does not depend on the zone: recorded once, checked equal.)
    if (tz === ZONES[0]) out.locales = r.info;
    else if (JSON.stringify(out.locales) !== JSON.stringify(r.info))
      throw new Error(`week data differs in ${tz}`);
  }
} finally {
  await browser.close();
}
const file = path.join(here, 'internationalized-date-3.12.4.json');
writeFileSync(file, JSON.stringify(out, null, 2) + '\n');
console.log(`${file}: ${out.browser}`);
for (const [tz, z] of Object.entries(out.zones))
  console.log(`  ${tz}: default ${z.resolved}, ${z.compared} wall times, ${z.differences.length} differ; ${z.invalid}`);
for (const [l, i] of Object.entries(out.locales)) console.log(`  ${l}: firstDay ${i.firstDay}, region ${i.region}`);
