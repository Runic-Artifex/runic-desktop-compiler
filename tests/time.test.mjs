// Dates and Intl (docs/IR.md, `date.*` and `intl.*` built-ins): lowering of
// the Date API, Intl constants and the locale-sensitive methods, run by the
// reference interpreter in several time zones and locales and compared with
// Node evaluating the same code; and the rejections, with locations. The
// semantics are pinned by crates/runic-js/tests/{date,intl}.rs (Chromium
// vectors); behaviour against Chromium by conformance/run.mjs (cases time,
// time-berlin, time-new-york).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

let base;
const graph = () => (base ??= collect('fixtures/time-svelte'));

/** The collected fixture with replacements in `file`. */
async function edits(file, pairs) {
  const g = await graph();
  const id = path.join(g.root, file);
  let code = g.modules.get(id).code;
  for (const [from, to] of pairs) {
    assert.ok(code.includes(from), `Replacement must match: ${from}`);
    code = code.replace(from, () => to);
  }
  const modules = new Map(g.modules);
  modules.set(id, { ...g.modules.get(id), code });
  return { ...g, modules, hash: hash(code) };
}

const rejects = async (g, code, pattern) =>
  assert.rejects(lower(g), e => {
    assert.ok(e instanceof Diagnostic, `expected a diagnostic, got ${e}`);
    assert.equal(e.code, code, e.message);
    if (pattern) assert.match(e.message, pattern);
    assert.equal(e.source?.file, 'App.svelte', e.message);
    assert.ok(e.source.line > 0 && e.source.column > 0);
    return true;
  });

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const text = (step, id) => textOf(flat(step.state.dom).find(n => n.attrs.id === id));

/** Adds `<p id="extra">{extra()}</p>` computed by `fn` (TypeScript source). */
const withExtra = (fn, extra = '') =>
  edits('App.svelte', [
    ['  function nextDay() {', `  ${fn}\n  function nextDay() {`],
    ['<p id="stamp">', `<p id="extra">{extra()}</p>\n  <p id="stamp">`],
    ...(extra ? [['  const UI_LOCALES', `  ${extra}\n  const UI_LOCALES`]] : []),
  ]);

/** Evaluates the function source in Node with time zone `tz` (annotations stripped). */
const evaluate = (fn, extra, tz) => {
  const js = `${extra}; ${fn}`.replace(/: (string|number|boolean|Date)(\[\])?/g, '');
  const saved = process.env.TZ;
  process.env.TZ = tz;
  try {
    // Date.now() as the probe's virtual clock sees it at mount.
    const now = Date.now;
    Date.now = () => 1_767_225_601_000;
    const RealDate = Date;
    globalThis.Date = class extends RealDate {
      constructor(...a) {
        if (a.length === 0) super(1_767_225_601_000);
        else super(...a);
      }
    };
    try {
      return new Function(`${js}; return extra;`)()();
    } finally {
      globalThis.Date = RealDate;
      Date.now = now;
    }
  } finally {
    process.env.TZ = saved;
  }
};

const ZONES = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Kolkata', 'Australia/Lord_Howe'];

/** Functions whose results Node and the interpreter must agree on in every zone. */
const SAME_AS_NODE = [
  // Construction, getters, setters, arithmetic and string forms.
  `function extra(): string {
    const d = new Date(2026, 2, 29, 2, 30);
    const e = new Date(d.getTime() + 36e5 * 5);
    e.setMonth(e.getMonth() + 7, 31);
    return [String(d.getTime()), String(d.getHours()), String(d.getTimezoneOffset()), e.toString(), e.toISOString(),
      e.toUTCString(), e.toDateString(), e.toTimeString(), String(e), \`\${d}\`, String(e > d), String(e.getTime() - d.getTime()),
      String(+e), String(Number(d)), String(d === d), String(new Date(d) === d)].join('|');
  }`,
  `function extra(): string {
    const out: string[] = [];
    for (const s of ['2026-03-29', '2026-03-29T02:30', '2026-10-25T02:30:00', 'Mar 29 2026 02:30', '2026/10/25 2:30 PM', 'nope', '+275760-09-13T00:00:00Z'])
      out.push(String(Date.parse(s)));
    out.push(String(Date.UTC(2026, 13, -1, 25)), String(new Date(1e15).getUTCFullYear()), String(Date.now()));
    return out.join('|');
  }`,
  `function extra(): string {
    const d = new Date('2026-10-25T00:30:00Z');
    const list: string[] = [];
    for (let i = 0; i < 6; i++) {
      d.setUTCMinutes(d.getUTCMinutes() + 30);
      list.push(d.getHours() + ':' + d.getMinutes() + '/' + d.getTimezoneOffset());
    }
    const invalid = new Date(NaN);
    list.push(String(invalid), String(invalid.getDay()), String(invalid.setFullYear(2026)), invalid.toJSON() ?? 'null');
    return list.join(' ');
  }`,
  // Formatting with explicit locales and options (Node's ICU agrees with
  // Chromium on these; the vectors pin the rest).
  `function extra(): string {
    const d = new Date(Date.UTC(2026, 0, 2, 15, 4, 5));
    return [d.toLocaleDateString('en-US', { timeZone: 'UTC' }), d.toLocaleTimeString('de-DE', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }),
      d.toLocaleString('en-GB', { timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short' }),
      (1234.5).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' }), (0.256).toLocaleString('en-US', { style: 'percent', maximumFractionDigits: 1 }),
      fmt.format(9876543.21), ['b', 'a', 'B', 'ä'].sort(coll.compare).join(''), String('a'.localeCompare('B', 'en-US')), 'Ä'.toLocaleLowerCase('de-DE')].join('|');
  }`,
];
const EXTRA = `const fmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 1 });
  const coll = new Intl.Collator('de-DE', { sensitivity: 'base' });`;

test('Date and Intl lowering agrees with Node in several time zones', async () => {
  for (const [i, fn] of SAME_AS_NODE.entries()) {
    const extra = i === 3 ? EXTRA : '';
    const { ir } = await lower(await withExtra(fn, extra));
    for (const tz of ZONES) {
      const [step] = interpret(ir, [], { timezone: tz, locale: 'en-US' });
      assert.equal(text(step, 'extra'), evaluate(fn, extra, tz), `${tz}: ${fn.slice(0, 60)}`);
    }
  }
});

test('the default locale and time zone come from the environment', async () => {
  const { ir } = await lower(await graph());
  const at = (tz, locale) => {
    const [step] = interpret(ir, [], { timezone: tz, locale });
    return text(step, 'local');
  };
  assert.equal(at('UTC', 'en-US'), '1/1/2026, 12:00:01 AM · 1/1/2026 · 12:00:01 AM');
  assert.equal(at('Europe/Berlin', 'de-DE'), '1.1.2026, 01:00:01 · 1/1/2026 · 1:00:01 AM');
  assert.equal(at('Asia/Kolkata', 'en-GB'), '01/01/2026, 05:30:01 · 1/1/2026 · 5:30:01 AM');
});

test('React, Vue and Svelte share the Date and Intl lowering (module constants)', async () => {
  for (const f of ['react', 'vue', 'svelte']) {
    const g = await collect('fixtures/modules-' + f);
    const id = path.join(g.root, 'logic.ts');
    const code = g.modules.get(id).code.replace(
      'export const starting=0;',
      `const days = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 });
export const starting = Number(days.format(new Date(Date.UTC(2026, 0, 5)).getUTCDate() + 0.4));`,
    );
    const modules = new Map(g.modules);
    modules.set(id, { ...g.modules.get(id), code });
    const { ir } = await lower({ ...g, modules, hash: hash(code) });
    const [step] = interpret(ir, [], { timezone: 'Europe/Berlin', locale: 'en-US' });
    // The counter starts at `starting`: 5.4 formatted without fraction digits.
    assert.equal(step.state.cells[0], 5, f);
  }
});

const rejected = [
  [
    'an unverified locale',
    ["'de-DE', { style: 'currency'", "'de-AT', { style: 'currency'"],
    'E_INTL',
    /de-AT is not verified/,
  ],
  [
    'an unverified option',
    ["{ dateStyle: 'full', timeStyle: 'short' }", "{ dateStyle: 'full', timeZoneName: 'short' }"],
    'E_INTL',
    /timeZoneName/,
  ],
  [
    'a full timeStyle (zone names)',
    ["timeStyle: 'short' }", "timeStyle: 'full' }"],
    'E_INTL',
    /not one of medium, short/,
  ],
  [
    'style and component options together',
    ["{ dateStyle: 'full', timeStyle: 'short' }", "{ dateStyle: 'full', month: 'long' }"],
    'E_INTL',
    /cannot be combined/,
  ],
  [
    'digits out of range',
    ["{ style: 'currency', currency: 'EUR' }", '{ maximumFractionDigits: 200 }'],
    'E_INTL',
    /between 0 and 100/,
  ],
  [
    'an unverified time zone',
    ["{ hour: '2-digit',", "{ timeZone: 'Mars/Olympus', hour: '2-digit',"],
    'E_INTL',
    /Mars\/Olympus/,
  ],
  ['an unverified currency', ["currency: 'EUR'", "currency: 'XAU'"], 'E_INTL', /XAU/],
  [
    'non-literal options',
    ["{ sensitivity: 'base', numeric: true }", '{ sensitivity: uiLocale }'],
    'E_INTL',
    /literal/,
  ],
  [
    'a runtime locale for an Intl object',
    ["new Intl.NumberFormat('de-DE',", 'new Intl.NumberFormat(uiLocale,'],
    'E_INTL',
    /must be a literal/,
  ],
  [
    'Intl.RelativeTimeFormat',
    [
      'const keys = new Intl.Collator(',
      'const relative = new Intl.RelativeTimeFormat();\n  const keys = new Intl.Collator(',
    ],
    'E_INTL',
    /RelativeTimeFormat is unsupported/,
  ],
  [
    'an Intl object as a value',
    ['  function nextDay() {', '  const formatters = [euros];\n  function nextDay() {'],
    'E_INTL',
    /methods/,
  ],
  [
    'a mutated Date read while rendering',
    [
      '    const d = new Date(opened);\n    d.setDate(d.getDate() + 1);\n    opened = d;',
      '    opened.setDate(opened.getDate() + 1);',
    ],
    'E_REACTIVITY',
    /Date that is changed in place/,
  ],
  [
    'toJSON where null is not handled',
    ['<p id="stamp">', '<p id="json">{opened.toJSON().length}</p>\n  <p id="stamp">'],
    'E_DATE',
    /toJSON returns null/,
  ],
  [
    'Date plus a number',
    ['<p id="stamp">', '<p id="sum">{opened + 1}</p>\n  <p id="stamp">'],
    'E_OPERATOR',
  ],
  [
    'getYear',
    ['<p id="stamp">', '<p id="year">{opened.getYear()}</p>\n  <p id="stamp">'],
    'E_DATE',
    /getFullYear/,
  ],
  [
    'several locales',
    ['now.toLocaleDateString(uiLocale)', "now.toLocaleDateString(['de-DE', 'en-US'])"],
    'E_INTL',
    /several locales/,
  ],
  [
    'a Turkish locale for case mapping',
    ['<p id="stamp">', `<p id="tr">{'I'.toLocaleLowerCase('tr')}</p>\n  <p id="stamp">`],
    'E_INTL',
    /verified literal locale/,
  ],
];

for (const [what, pair, code, pattern] of rejected)
  test(`rejects ${what}`, async () => {
    await rejects(await edits('App.svelte', [pair]), code, pattern);
  });
