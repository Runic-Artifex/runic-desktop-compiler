// The @internationalized/date 3.12.4 pack (frontend/packs/internationalized-
// date-3.12.4.ts): its typed Gregorian port against the installed package
// on generated vectors, run in Node with pinned time zones; the port's
// unsupported paths; a compiled program through the reference interpreter;
// and the pack's located rejections. The Chromium facts the port relies on
// (Intl parts equal the Date getters, week starts, regions) are measured by
// conformance/packs/internationalized-date.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as real from '@internationalized/date';
import { collect, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

/** Thrown by the stubbed `__runic.unsupported`. */
class Unsupported extends Error {}

/** `m=f;key=value;…` (the port's DateFormatter spec) as Intl options. */
const specOptions = spec =>
  Object.fromEntries(
    spec
      .split(';')
      .slice(1)
      .filter(Boolean)
      .map(p => {
        const [k, v] = p.split('=');
        return [k, v === 'true' ? true : v === 'false' ? false : v];
      }),
  );

globalThis.__runic = {
  timeZone: () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
  formatDate: (ms, spec, locale) => new Intl.DateTimeFormat(locale, specOptions(spec)).format(ms),
  unsupported: m => {
    throw new Unsupported(m);
  },
};
const port = await import('../frontend/packs/internationalized-date-3.12.4/date.ts');

/**
 * Runs `f` with the process's local time zone set to `tz` (the package
 * caches the zone it reads first, so it is told the zone too).
 */
const inZone = (tz, f) => {
  const before = process.env.TZ;
  process.env.TZ = tz;
  real.setLocalTimeZone(tz);
  try {
    return f();
  } finally {
    real.resetLocalTimeZone();
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
};

/** Which date value `v` is (the package's class names are minified). */
const kind = v =>
  v.timeZone !== undefined
    ? 'ZonedDateTime'
    : v.day === undefined
      ? 'Time'
      : v.hour === undefined
        ? 'CalendarDate'
        : 'CalendarDateTime';

/** The outcome of `f` comparably: a string, number, boolean or the error thrown. */
const outcome = f => {
  try {
    const v = f();
    if (v instanceof Date) return `Date ${v.getTime()}`;
    return typeof v === 'object' && v !== null ? `${kind(v)} ${v.toString()}` : v;
  } catch (e) {
    return `${e.name}: ${e.message}`;
  }
};

const DATES = [
  [2024, 2, 29],
  [2025, 1, 31],
  [2025, 3, 30],
  [2025, 6, 1],
  [2025, 10, 26],
  [2025, 11, 2],
  [2025, 12, 31],
  [1900, 2, 28],
  [2000, 2, 29],
  [1, 1, 1],
  [9999, 12, 31],
  [2025, 13, 40],
  [2025, 0, 0],
];
const DURATIONS = [
  {},
  { days: 1 },
  { days: -1 },
  { days: 400 },
  { weeks: 2 },
  { months: 1 },
  { months: -13 },
  { years: 1, months: 1, days: 1 },
  { years: -1 },
  { hours: 25, minutes: 61 },
  { seconds: -86401, milliseconds: 1500 },
];
const FIELDS = [
  { day: 31 },
  { month: 2 },
  { year: 2023, month: 2, day: 29 },
  { hour: 23, minute: 59 },
  { month: 14 },
];
const LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP'];
const ZONES = ['UTC', 'Europe/Berlin', 'America/New_York'];

/** Every vector: a label and a function of the module (the port or the package). */
function vectors(tz) {
  const out = [];
  const add = (label, f) => out.push([label, f]);
  for (const [y, m, d] of DATES) {
    const date = M => new M.CalendarDate(y, m, d);
    const time = M => new M.CalendarDateTime(y, m, d, 2, 30, 15, 250);
    const zoned = M => M.toZoned(time(M), tz);
    const tag = `${y}-${m}-${d}`;
    for (const [k, make] of [
      ['date', date],
      ['datetime', time],
      ['zoned', zoned],
    ]) {
      add(`${k} ${tag}`, M => make(M));
      for (const dur of DURATIONS) {
        add(`${k} ${tag} add ${JSON.stringify(dur)}`, M => make(M).add(dur));
        add(`${k} ${tag} subtract ${JSON.stringify(dur)}`, M => make(M).subtract(dur));
      }
      for (const f of FIELDS) add(`${k} ${tag} set ${JSON.stringify(f)}`, M => make(M).set(f));
      add(`${k} ${tag} toDate`, M => make(M).toDate(tz));
      add(`${k} ${tag} startOfMonth`, M => M.startOfMonth(make(M)));
      add(`${k} ${tag} endOfMonth`, M => M.endOfMonth(make(M)));
      add(`${k} ${tag} startOfYear`, M => M.startOfYear(make(M)));
      add(`${k} ${tag} endOfYear`, M => M.endOfYear(make(M)));
      add(`${k} ${tag} toCalendarDate`, M => M.toCalendarDate(make(M)));
      add(`${k} ${tag} toCalendarDateTime`, M => M.toCalendarDateTime(make(M)));
      for (const l of LOCALES) {
        add(`${k} ${tag} getDayOfWeek ${l}`, M => M.getDayOfWeek(make(M), l));
        add(`${k} ${tag} getDayOfWeek ${l} mon`, M => M.getDayOfWeek(make(M), l, 'mon'));
        add(`${k} ${tag} startOfWeek ${l}`, M => M.startOfWeek(make(M), l));
        add(`${k} ${tag} endOfWeek ${l}`, M => M.endOfWeek(make(M), l));
        add(`${k} ${tag} getWeeksInMonth ${l}`, M => M.getWeeksInMonth(make(M), l));
        add(`${k} ${tag} isWeekend ${l}`, M => M.isWeekend(make(M), l));
        add(`${k} ${tag} isWeekday ${l}`, M => M.isWeekday(make(M), l));
      }
    }
    add(`date ${tag} toZoned`, M => M.toZoned(date(M), tz));
    add(`date ${tag} getHoursInDay`, M => M.getHoursInDay(date(M), tz));
    add(`datetime ${tag} toTime`, M => M.toTime(time(M)));
    add(`zoned ${tag} toAbsoluteString`, M => zoned(M).toAbsoluteString());
    add(`zoned ${tag} toTimeZone UTC`, M => M.toTimeZone(zoned(M), 'UTC'));
    add(`zoned ${tag} toLocalTimeZone`, M => M.toLocalTimeZone(zoned(M)));
    for (const [b, c, e] of [DATES[0], DATES[3], [y, m, d + 1], [y, m + 1, d]]) {
      const other = M => new M.CalendarDate(b, c, e);
      add(`${tag} compare ${b}-${c}-${e}`, M => date(M).compare(other(M)));
      add(`${tag} isSameDay ${b}-${c}-${e}`, M => M.isSameDay(date(M), other(M)));
      add(`${tag} isSameMonth ${b}-${c}-${e}`, M => M.isSameMonth(date(M), other(M)));
      add(`${tag} isSameYear ${b}-${c}-${e}`, M => M.isSameYear(date(M), other(M)));
      add(`${tag} datetime compare ${b}-${c}-${e}`, M => time(M).compare(other(M)));
    }
  }
  // Wall times in the gaps and overlaps of the zones (2025).
  for (const [y, m, d, h, mi] of [
    [2025, 3, 30, 2, 30],
    [2025, 10, 26, 2, 30],
    [2025, 3, 9, 2, 30],
    [2025, 11, 2, 1, 30],
  ])
    for (const dis of [undefined, 'compatible', 'earlier', 'later', 'reject']) {
      const dt = M => new M.CalendarDateTime(y, m, d, h, mi);
      add(`toZoned ${y}-${m}-${d}T${h}:${mi} ${dis}`, M => M.toZoned(dt(M), tz, dis));
      add(`toDate ${y}-${m}-${d}T${h}:${mi} ${dis}`, M => dt(M).toDate(tz, dis));
    }
  for (const ms of [0, -1, 1748736000123, 1743294600000, 1761442200000, 253402300799999])
    for (const z of ['UTC', tz]) {
      add(`fromAbsolute ${ms} ${z}`, M => M.fromAbsolute(ms, z));
      add(`fromDate ${ms} ${z}`, M => M.fromDate(new Date(ms), z));
    }
  add('fromDate invalid', M => M.fromDate(new Date(NaN), tz));
  for (const t of [
    [0, 0],
    [23, 59, 59, 999],
    [25, 61, 61, 1001],
  ])
    for (const dur of DURATIONS) {
      add(`time ${t} add ${JSON.stringify(dur)}`, M => new M.Time(...t).add(dur));
      add(`time ${t} subtract ${JSON.stringify(dur)}`, M => new M.Time(...t).subtract(dur));
      add(`time ${t} set`, M => new M.Time(...t).set({ minute: 75, second: -1 }));
      add(`time ${t} compare`, M => new M.Time(...t).compare(new M.Time(12)));
    }
  for (const s of ['2025-06-01', '2024-02-29', '2025-02-29', '2025-13-01', '+002025-06-01', 'x'])
    add(`parseDate ${s}`, M => M.parseDate(s));
  for (const s of ['2025-06-01T02:30', '2025-06-01T24:00', '2025-06-01T23:59:59.5', '2025-06-01T'])
    add(`parseDateTime ${s}`, M => M.parseDateTime(s));
  for (const s of ['02:30', '23:59:59.123', '24:00', '2:30'])
    add(`parseTime ${s}`, M => M.parseTime(s));
  for (const s of [
    '2025-06-01T02:30:00+02:00[Europe/Berlin]',
    '2025-03-30T02:30[Europe/Berlin]',
    '2025-06-01T02:30:00+00:00[UTC]',
    '2025-06-01T02:30:00-04:00[America/New_York]',
    '2025-06-01T02:30:00+05:00[UTC]',
  ])
    add(`parseZonedDateTime ${s}`, M => M.parseZonedDateTime(s));
  for (const s of ['2025-06-01T02:30:00Z', '2025-06-01T02:30:00.5+02:00', '2025-06-01'])
    for (const z of ['UTC', tz]) {
      add(`parseAbsolute ${s} ${z}`, M => M.parseAbsolute(s, z));
      add(`parseAbsoluteToLocal ${s}`, M => M.parseAbsoluteToLocal(s));
    }
  for (const l of LOCALES)
    for (const o of [
      { dateStyle: 'long', timeZone: 'UTC' },
      { month: 'long', year: 'numeric', timeZone: 'UTC' },
      { weekday: 'short', timeZone: 'UTC' },
      { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: tz },
      { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: tz },
    ])
      add(`DateFormatter ${l} ${JSON.stringify(o)}`, M =>
        new M.DateFormatter(l, o).format(new Date(1748736000000)),
      );
  // In the local zone: Intl's (the package caches its formatters by
  // options, so one made in an earlier zone of this process keeps it; a
  // page has one zone).
  for (const l of LOCALES)
    add(`DateFormatter ${l} local zone`, M =>
      M === real
        ? new Intl.DateTimeFormat(l, { dateStyle: 'medium' }).format(new Date(1748736000000))
        : new M.DateFormatter(l, { dateStyle: 'medium' }).format(new Date(1748736000000)),
    );
  return out;
}

for (const tz of ZONES)
  test(`the port agrees with the installed package on every vector (TZ=${tz})`, () =>
    inZone(tz, () => {
      assert.equal(port.getLocalTimeZone(), tz);
      assert.equal(port.getLocalTimeZone(), real.getLocalTimeZone());
      let compared = 0;
      const reported = [];
      for (const [label, f] of vectors(tz)) {
        const p = outcome(() => f(port));
        const r = outcome(() => f(real));
        // A path the port reports unsupported is never an approximation;
        // every other outcome is the package's.
        if (typeof p === 'string' && p.startsWith('Error: @internationalized')) {
          reported.push([label, p, f]);
          continue;
        }
        assert.equal(p, r, label);
        compared++;
      }
      assert.ok(compared > 2000, `${compared} vectors compared`);
      // Reported only where the package's value, or a value it computes on
      // the way (the start of the week of 0001-01-01), is a date before the
      // common era, or where a string names a zone neither UTC nor local.
      for (const [label, p, f] of reported) {
        const zone = /the time zone (\S+) .* is not supported/.exec(p)?.[1];
        if (zone) assert.ok(zone !== 'UTC' && zone !== tz, label);
        else {
          assert.match(p, /a date of the BC era is not supported/, label);
          assert.ok(f(real).era === 'BC' || / 1-1-1 \w+Week/.test(label), label);
        }
      }
      assert.ok(reported.length < compared / 20, `${reported.length} reported`);
    }));

test("the port's week data and zone reading are Chromium's", () => {
  const measured = JSON.parse(
    readFileSync('conformance/packs/internationalized-date-3.12.4.json', 'utf8'),
  );
  const sunday = new port.CalendarDate(2025, 6, 1);
  const saturday = new port.CalendarDate(2025, 5, 31);
  for (const [l, { firstDay }] of Object.entries(measured.locales)) {
    // Sunday's index in a week starting on `firstDay` (1 Monday … 7 Sunday).
    assert.equal(port.getDayOfWeek(sunday, l), (7 - (firstDay % 7)) % 7, l);
    // (No verified region has weekend data of its own: Saturday and Sunday.)
    assert.equal(port.isWeekend(saturday, l), true, l);
    assert.equal(port.isWeekend(sunday, l), true, l);
  }
  for (const [tz, z] of Object.entries(measured.zones)) {
    assert.equal(z.resolved, tz);
    assert.deepEqual(z.differences, [], `${tz}: formatToParts wall times are the Date getters`);
    // (An invalid date read in a zone other than UTC throws formatToParts'
    // error; UTC is read without Intl, in the package too.)
    if (tz !== 'UTC')
      inZone(tz, () =>
        assert.equal(
          outcome(() => port.fromDate(new Date(NaN), tz)),
          z.invalid,
          tz,
        ),
      );
  }
});

test('dates and values the port does not cover are reported unsupported, not approximated', () =>
  inZone('Europe/Berlin', () => {
    const cases = [
      // Before the common era: the package's BC era.
      () => new port.CalendarDate(1, 1, 1).subtract({ days: 1 }),
      () => new port.CalendarDate(2025, 6, 1).set({ year: 1 }).subtract({ years: 1 }),
      () => port.fromAbsolute(Date.UTC(-1, 0, 1), 'UTC'),
      () => port.parseDateTime('-000001-01-01T00:00'),
      () => new port.CalendarDate(2025, 6, 1).set({ era: 'BC' }),
      // A zone neither UTC nor the local one.
      () => port.toZoned(new port.CalendarDate(2025, 6, 1), 'Asia/Tokyo'),
      () => port.fromAbsolute(0, 'America/New_York'),
      () => port.now('Asia/Tokyo'),
      // Locales without verified week data.
      () => port.getDayOfWeek(new port.CalendarDate(2025, 6, 1), 'pt-BR'),
      () => port.isWeekend(new port.CalendarDate(2025, 6, 1), 'ar-EG'),
      // Formatter operations outside the runtime formatter.
      () => new port.DateFormatter('en-US').formatToParts(new Date(0)),
      () => new port.DateFormatter('en-US').formatRange(new Date(0), new Date(1)),
      () => new port.DateFormatter('en-US', { month: 'long;day=numeric' }),
    ];
    for (const f of cases)
      assert.throws(
        f,
        e => e instanceof Unsupported && /pack: .* is not supported/.test(e.message),
      );
    // The package itself gives a BC date or a formatted string where the
    // port stops: the port's report is the only difference.
    assert.equal(new real.CalendarDate(1, 1, 1).subtract({ days: 1 }).era, 'BC');
  }));

test('a local day ending in a gap across midnight is reported, its neighbours are not', () =>
  // Samoa skipped 2011-12-30: the package's local conversion of that day
  // starts from the time it runs, the port's from the epoch.
  inZone('Pacific/Apia', () => {
    const at = day => new port.CalendarDateTime(2011, 12, day, 12);
    assert.throws(
      () => at(30).toDate('Pacific/Apia'),
      e => e instanceof Unsupported && /daylight-saving gap that crosses midnight/.test(e.message),
    );
    for (const day of [29, 31])
      assert.equal(
        at(day).toDate('Pacific/Apia').getTime(),
        new real.CalendarDateTime(2011, 12, day, 12).toDate('Pacific/Apia').getTime(),
      );
  }));

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (n.children ?? []).map(c => (typeof c === 'string' ? c : textOf(c))).join('');

/** A Svelte app (and fake packages) in .cache/tests; `run` gets its root. */
async function withApp(source, run, files = {}) {
  await mkdir('.cache/tests', { recursive: true });
  const root = await mkdtemp(path.resolve('.cache/tests/intl-date-'));
  try {
    await cp('examples/7guis-counter-svelte/assets', path.join(root, 'assets'), {
      recursive: true,
    });
    await writeFile(
      path.join(root, 'style.css'),
      "@font-face { font-family: F; src: url('./assets/DejaVuSans.woff2') format('woff2'); }\n",
    );
    await writeFile(
      path.join(root, 'index.html'),
      '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/main.js"></script></body></html>',
    );
    await writeFile(
      path.join(root, 'main.js'),
      "import { mount } from 'svelte';\nimport App from './App.svelte';\nimport './style.css';\nmount(App, { target: document.getElementById('root') });\n",
    );
    await writeFile(path.join(root, 'App.svelte'), source);
    await writeFile(
      path.join(root, 'runic.json'),
      JSON.stringify({ framework: 'svelte', entry: 'main.js', title: 'T' }),
    );
    for (const [file, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('a program using the pack lowers and runs as the package does', async () => {
  // (The interpreter's time zone is UTC, as a conformance run's default.)
  const program = M => {
    let d = new M.CalendarDate(2025, 1, 31);
    const out = [];
    const step = () => {
      d = d.add({ months: 1 });
    };
    const view = () => [
      d.toString(),
      M.startOfWeek(d, 'de-DE').toString(),
      M.endOfMonth(d).toString(),
      String(M.getWeeksInMonth(d, 'en-US')),
      String(M.isWeekend(d, 'en-GB')),
      String(M.isSameMonth(d, M.parseDate('2025-02-01'))),
      String(d.toDate('UTC').getTime()),
      M.toZoned(new M.CalendarDateTime(2025, 6, 1, 9, 5), 'UTC').toString(),
      new M.DateFormatter('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        d.toDate('UTC'),
      ),
    ];
    out.push(view());
    step();
    out.push(view());
    return out;
  };
  const expected = inZone('UTC', () => program(real));
  const source = `<script lang="ts">
import { CalendarDate, CalendarDateTime, DateFormatter, startOfWeek, endOfMonth, getWeeksInMonth, isWeekend, isSameMonth, parseDate, toZoned } from '@internationalized/date';
let d = $state(new CalendarDate(2025, 1, 31));
const fmt = new DateFormatter('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const view = $derived([
  d.toString(),
  startOfWeek(d, 'de-DE').toString(),
  endOfMonth(d).toString(),
  String(getWeeksInMonth(d, 'en-US')),
  String(isWeekend(d, 'en-GB')),
  String(isSameMonth(d, parseDate('2025-02-01'))),
  String(d.toDate('UTC').getTime()),
  toZoned(new CalendarDateTime(2025, 6, 1, 9, 5), 'UTC').toString(),
  fmt.format(d.toDate('UTC')),
]);
</script>
<button id="go" onclick={() => (d = d.add({ months: 1 }))}>go</button>
{#each view as v, i}<i id={'v' + i}>{v}</i>{/each}
`;
  await withApp(source, async root => {
    const { ir } = await lower(await collect(root));
    assert.ok(ir.meta.mappings.some(m => m.id === '@internationalized/date@3.12.4'));
    const steps = interpret(ir, [{ kind: 'click', id: 'go' }]);
    steps.forEach((s, k) =>
      expected[k].forEach((v, i) =>
        assert.equal(
          textOf(flat(s.state.dom).find(n => n.attrs.id === `v${i}`)),
          v,
          `step ${k} value ${i}`,
        ),
      ),
    );
  });
});

/** Expects a diagnostic `code` located in App.svelte. */
const failWith = (code, pattern) => e =>
  (e instanceof Diagnostic &&
    e.code === code &&
    e.source?.file?.endsWith('App.svelte') &&
    e.source.line > 0 &&
    (!pattern || pattern.test(e.message))) ||
  assert.fail(`expected ${code} ${pattern ?? ''} in App.svelte, got ${e.code}: ${e.message}`);

test('exports, subpaths and versions the pack does not cover are rejected with a location', async () => {
  const svelte = script => `<script lang="ts">\n${script}\n</script>\n<p>x</p>\n`;
  const cases = [
    [
      "import { JapaneseCalendar } from '@internationalized/date';\nconst c = new JapaneseCalendar();",
      /JapaneseCalendar: calendars other than the Gregorian/,
    ],
    [
      "import { createCalendar } from '@internationalized/date';\nconst c = createCalendar('gregory');",
      /createCalendar/,
    ],
    [
      "import { setLocalTimeZone } from '@internationalized/date';\nsetLocalTimeZone('UTC');",
      /setLocalTimeZone: overriding the local time zone/,
    ],
    [
      "import { parseDuration } from '@internationalized/date';\nconst d = parseDuration('P1D');",
      /does not cover parseDuration/,
    ],
  ];
  for (const [script, pattern] of cases)
    await withApp(svelte(script), root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        failWith('E_PACK', pattern),
      ),
    );
  // Another version of the package: no pack covers it.
  await withApp(
    svelte("import { today } from '@internationalized/date';\nconst t = today('UTC');"),
    root =>
      assert.rejects(
        collect(root).then(g => lower(g)),
        failWith('E_PACK_VERSION'),
      ),
    {
      'node_modules/@internationalized/date/package.json': JSON.stringify({
        name: '@internationalized/date',
        version: '3.12.3',
        type: 'module',
        exports: './index.js',
      }),
      'node_modules/@internationalized/date/index.js': 'export function today() {}\n',
    },
  );
});
