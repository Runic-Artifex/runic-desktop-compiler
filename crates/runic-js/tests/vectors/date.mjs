// Generates tests/vectors/date.json: Date semantics as Chromium (V8 with
// ICU time zones) computes them, per time zone, through Playwright (run
// inside the dev shell):
//
//   node crates/runic-js/tests/vectors/date.mjs
//
// Deterministic for a given Chromium build. For each zone:
//   time   [t, local getters…, UTC getters…, getTimezoneOffset, toString,
//           toDateString, toTimeString, toUTCString, toISOString | null,
//           toJSON]
//   local  [args (7), new Date(...args).getTime(), Date.UTC(...args)]
//   set    [t, setter, args, new time value]
//   parse  Date.parse of each string of `strings`
// Numbers are strings (String(x), "-0"), which Rust parses exactly.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

let seed = 0x5eed1234;
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = a => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const ZONES = [
  'UTC',
  'Europe/Berlin',
  'America/New_York',
  'Asia/Kolkata',
  'Australia/Lord_Howe',
  'America/Sao_Paulo',
  'Pacific/Chatham',
  'Europe/Dublin',
  'America/St_Johns',
  'Pacific/Apia',
  'Asia/Kathmandu',
  'Antarctica/Troll',
  'Europe/London',
  'America/Los_Angeles',
];

// Instants: random over several ranges, around 2026 transitions (filled in
// per zone in the page), extremes.
const times = [];
for (let i = 0; i < 120; i++) times.push(int(1.7e12, 1.85e12));
for (let i = 0; i < 80; i++) times.push(int(-2.3e12, 4.2e12));
for (let i = 0; i < 40; i++) times.push(int(-8.64e15, 8.64e15));
for (let i = 0; i < 20; i++) times.push(int(-6.3e13, -6.1e13)); // around year 0
times.push(
  0,
  -1,
  1,
  8.64e15,
  -8.64e15,
  2147483647000,
  2147483648000,
  -62198755200000,
  -62167219200000,
  253402300799999,
  253402300800000,
  NaN,
);

// Constructor arguments.
const locals = [];
const NUMS = [
  0,
  1,
  -1,
  0.5,
  -0.5,
  99,
  100,
  12,
  13,
  -13,
  31,
  32,
  59,
  60,
  61,
  1e7,
  -1e7,
  1e9,
  NaN,
  Infinity,
  -Infinity,
  1.7976931348623157e308,
];
for (let i = 0; i < 150; i++)
  locals.push([
    int(1900, 2100),
    int(0, 11),
    int(1, 28),
    int(0, 23),
    int(0, 59),
    int(0, 59),
    int(0, 999),
  ]);
for (let i = 0; i < 80; i++)
  locals.push(
    Array.from({ length: 7 }, (_, k) =>
      rand() < 0.4
        ? pick(NUMS)
        : [
            int(-300000, 300000),
            int(-30, 30),
            int(-40, 70),
            int(-30, 50),
            int(-90, 90),
            int(-90, 90),
            int(-2000, 2000),
          ][k],
    ),
  );
for (const y of [0, 49, 50, 99, 100, -1, 275760, -271821, 1000000, 1000001])
  locals.push([y, 0, 1, 0, 0, 0, 0]);
// Skipped and repeated local times of 2026 (zone-specific: all hours of
// the transition days in the northern and southern hemisphere).
for (const [m, d] of [
  [2, 29],
  [9, 25],
  [3, 5],
  [8, 27],
  [2, 8],
  [10, 1],
  [3, 1],
  [3, 29],
])
  for (let h = 0; h < 4; h++)
    for (const mi of [0, 15, 30, 45]) locals.push([2026, m, d, h, mi, 0, 0]);

// Setters.
const SETTERS = [
  ['setFullYear', 1, 3],
  ['setMonth', 1, 2],
  ['setDate', 1, 1],
  ['setHours', 1, 4],
  ['setMinutes', 1, 3],
  ['setSeconds', 1, 2],
  ['setMilliseconds', 1, 1],
  ['setUTCFullYear', 1, 3],
  ['setUTCMonth', 1, 2],
  ['setUTCDate', 1, 1],
  ['setUTCHours', 1, 4],
  ['setUTCMinutes', 1, 3],
  ['setUTCSeconds', 1, 2],
  ['setUTCMilliseconds', 1, 1],
  ['setTime', 1, 1],
];
const sets = [];
for (let i = 0; i < 400; i++) {
  const [name, min, max] = pick(SETTERS);
  const n = int(min, max);
  const t = rand() < 0.1 ? NaN : rand() < 0.8 ? int(1.7e12, 1.85e12) : int(-8e15, 8e15);
  const args = Array.from({ length: n }, () => (rand() < 0.25 ? pick(NUMS) : int(-40, 70)));
  if (name.endsWith('FullYear') && rand() < 0.7) args[0] = int(1900, 2100);
  if (name === 'setTime') args[0] = rand() < 0.5 ? int(-8.7e15, 8.7e15) : pick(NUMS);
  sets.push([t, name, args]);
}

// Date.parse strings.
const strings = new Set([
  '2026',
  '2026-01',
  '2026-01-02',
  '2026-01-02T03:04',
  '2026-01-02T03:04:05',
  '2026-01-02T03:04:05.6',
  '2026-01-02T03:04:05.678',
  '2026-01-02T03:04:05.6789',
  '2026-01-02T03:04:05Z',
  '2026-01-02T03:04:05.678Z',
  '2026-01-02T03:04:05+01:00',
  '2026-01-02T03:04:05-0530',
  '2026-01-02T24:00',
  '2026-01-02T24:00:01',
  '2026-01-02T25:00',
  '2026-02-30',
  '2026-13-01',
  '2026-00-10',
  '+002026-01-02',
  '-000001-01-01T00:00:00Z',
  '-000000-01-01',
  '+275760-09-13T00:00:00Z',
  '+275760-09-13T00:00:00.001Z',
  '-271821-04-20T00:00:00Z',
  '-271821-04-19T23:59:59.999Z',
  '2026-1-2',
  '2026/01/02',
  '2026/1/2 10:00',
  '01/02/2026',
  '1/2/26',
  '1/2/50',
  '1/2/49',
  'Jan 2 2026',
  'Jan 2, 2026 10:00:00',
  'January 2, 2026',
  '2 January 2026',
  'Fri Jan 02 2026 03:04:05 GMT+0100 (Central European Standard Time)',
  'Fri, 02 Jan 2026 03:04:05 GMT',
  'Fri, 02 Jan 2026 03:04:05 +0100',
  'Jan 2 2026 10:00 PM',
  'Jan 2 2026 12:00 AM',
  'Jan 2 2026 13:00 PM',
  '2026-01-02 10:00',
  '2026-01-02 10:00:00Z',
  '2026-01-02T10:00:00 Z',
  'Thu, 01 Jan 1970 00:00:00 GMT-0500',
  '12:00',
  'Jan 2026',
  '2026 Jan 2',
  'Jan-02-2026',
  '02-Jan-2026',
  'noon',
  '',
  ' ',
  'Invalid Date',
  '2026-01-02T03:04:05.678+0100',
  '2026-01-02T03:04:05,678Z',
  '2026-01-02t03:04:05z',
  '20260102',
  '2026-01-02T03:04:05.000000001Z',
  'Jan 2 2026 EST',
  'Jan 2 2026 10:00 PST',
  'Jan 2 2026 10:00 UTC+2',
  'Jan 2 2026 10:00 GMT-08:00',
  'Jan 2 2026 10:00 (comment) GMT',
  '(Jan 2 2026)',
  'Mon, 1 Jan 0001 00:00:00 GMT',
  'Tue Sep 13 275760 00:00:00',
  '1970-01-01T00:00:00.000Z',
  'May 5 2026 5:5:5',
  '5 5 2026',
  '13/1/2026',
  '2026.01.02',
  '2.1.2026',
  'Jan 2 2026 10:00:00.5',
  'Jan 2 2026 10:00:00.123456',
  'Jan 2 2026 10::',
  'Jan 2 2026 10:',
  'Jan 2 2026 10:00 am pm',
  'T10:00',
  '2026-01-02T',
  '2026-01-02T10',
  'Z',
  '1',
  '12',
  '123',
  '1234',
  '12345',
  '123456',
  '+123456',
  '-123456',
  '2026-01-02T03:04:05.678-00:00',
]);
const TOKENS = [
  '2026',
  '1',
  '02',
  '13',
  '31',
  '00',
  '1999',
  '-',
  '+',
  ':',
  '.',
  ',',
  '/',
  ' ',
  'T',
  'Z',
  'GMT',
  'UTC',
  'PM',
  'am',
  'Jan',
  'February',
  'Sept',
  'Fri',
  'Monday',
  '(',
  ')',
  '+01:00',
  '-0800',
  'x',
  'é',
  ' ',
  ' ',
  '\t',
  '0000',
  '123456789012',
];
for (let i = 0; i < 1500; i++)
  strings.add(Array.from({ length: int(1, 9) }, () => pick(TOKENS)).join(''));

const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const out = { browser: browser.version(), strings: [...strings], zones: {} };
for (const zone of ZONES) {
  const ctx = await browser.newContext({ locale: 'en-US', timezoneId: zone });
  const page = await ctx.newPage();
  const r = await page.evaluate(
    ({ times, locals, sets, strings }) => {
      // Numbers as strings: Rust parses them exactly.
      const E = v => (typeof v === 'number' ? (Object.is(v, -0) ? '-0' : String(v)) : v);
      // Transition instants of 2026 in this zone (offset changes), ±1 ms.
      const extra = [];
      let prev = null;
      for (let t = Date.UTC(2026, 0, 1); t < Date.UTC(2027, 0, 1); t += 3600000) {
        const o = new Date(t).getTimezoneOffset();
        if (prev !== null && o !== prev) {
          let lo = t - 3600000,
            hi = t;
          while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (new Date(mid).getTimezoneOffset() === prev) lo = mid;
            else hi = mid;
          }
          extra.push(lo, hi, hi + 1800000);
        }
        prev = o;
      }
      const row = t => {
        const d = new Date(t);
        let iso;
        try {
          iso = d.toISOString();
        } catch {
          iso = null;
        }
        return [
          E(t),
          ...[
            'FullYear',
            'Month',
            'Date',
            'Day',
            'Hours',
            'Minutes',
            'Seconds',
            'Milliseconds',
          ].map(f => E(d['get' + f]())),
          ...[
            'FullYear',
            'Month',
            'Date',
            'Day',
            'Hours',
            'Minutes',
            'Seconds',
            'Milliseconds',
          ].map(f => E(d['getUTC' + f]())),
          E(d.getTimezoneOffset()),
          d.toString(),
          d.toDateString(),
          d.toTimeString(),
          d.toUTCString(),
          iso,
          d.toJSON(),
        ];
      };
      return {
        time: [...times, ...extra].map(row),
        local: locals.map(a => [a.map(E), E(new Date(...a).getTime()), E(Date.UTC(...a))]),
        set: sets.map(([t, name, args]) => {
          const d = new Date(t);
          const v = d[name](...args);
          return [E(t), name, args.map(E), E(v)];
        }),
        parse: strings.map(s => E(Date.parse(s))),
      };
    },
    { times, locals, sets, strings: out.strings },
  );
  out.zones[zone] = r;
  await ctx.close();
}
await browser.close();
writeFileSync(join(here, 'date.json'), JSON.stringify(out) + '\n');
console.error(`date.json: ${ZONES.length} zones, ${out.strings.length} parse strings`);
