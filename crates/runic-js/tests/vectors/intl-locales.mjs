// Generates the data of Intl.PluralRules and Intl.DisplayNames in runic-js
// (src/intl/locale_data.rs) and their test vectors
// (tests/vectors/intl-locales.json) from Chromium, the conformance
// reference (run inside the dev shell; it calls the ICU tools of the locked
// nixpkgs through `nix shell`):
//
//   node crates/runic-js/tests/vectors/intl-locales.mjs
//
// Deterministic for a given Chromium build.
//
// Data (src/intl/locale_data.rs):
// - Plural rules: Chromium's own ICU data (icudtl.dat next to its binary),
//   decompiled with ICU's icupkg and derb: the rule sets (CLDR syntax,
//   parsed into relations), the locales and ordinal locales naming them, in
//   the order ICU evaluates the keywords ("other" last). The language tag
//   aliases (ICU's metadata.res) canonicalize tags as Intl does.
// - Display names: for each verified display locale, every region (two
//   letters, three digits), script (four letters), currency (three letters)
//   and language code (two or three letters) Chromium names, read through
//   Intl.DisplayNames with fallback "none"; the dialect names of the
//   compound keys ICU's language data has (`en_US`, `zh_Hans`); the locale
//   display pattern and separator.
//
// Vectors (tests/vectors/intl-locales.json): Chromium's output of
// Intl.PluralRules#select, resolvedOptions().pluralCategories and
// Intl.DisplayNames#of for random and systematic inputs, tags and options,
// in the IR's option-string form (docs/IR.md, `intl.*` built-ins).
import { writeFileSync, readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const crate = join(here, '../..');
const root = join(crate, '../..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

/** Locales with verified data (runic_js::intl::LOCALES, in data order). */
const LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP'];
/** Display-name locales that may equal a data locale. */
const DISPLAY_ALIAS_CANDIDATES = { en: 'en-US', de: 'de-DE', fr: 'fr-FR', ja: 'ja-JP' };
const CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

// Deterministic PRNG (mulberry32).
let seed = 0x5eed1234;
function rand() {
  seed = (seed + 0x6d2b79f5) >>> 0;
  let t = seed;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = a => a[Math.floor(rand() * a.length)];

// --- Chromium's ICU data ---

const browser = await chromium.launch({ headless: true, channel: 'chromium' });
const browserVersion = browser.version();
const icuFile = join(dirname(chromium.executablePath()), 'icudtl.dat');
const dat = readFileSync(icuFile);
// The common data's table of contents names its items `icudtNNl/…`.
const headerSize = dat.readUInt16LE(0);
const nameOffset = dat.readUInt32LE(headerSize + 4);
const firstName = dat.toString('latin1', headerSize + nameOffset, headerSize + nameOffset + 40);
const icuPrefix = firstName.slice(0, firstName.indexOf('/'));
console.error('Chromium', browserVersion, icuPrefix);

const work = mkdtempSync(join(tmpdir(), 'runic-icu-'));
copyFileSync(icuFile, join(work, `${icuPrefix}.dat`));
/** Runs ICU's tools from the locked nixpkgs in the work directory. */
function icu(script) {
  return execFileSync(
    'nix',
    ['shell', '--inputs-from', root, 'nixpkgs#icu.dev', '-c', 'sh', '-c', script],
    { cwd: work, encoding: 'utf8', maxBuffer: 1 << 26, stdio: ['ignore', 'pipe', 'pipe'] },
  );
}
// icupkg reports items whose dependencies Chromium dropped (exit status 2).
const items = icu(`icupkg -l ${icuPrefix}.dat 2>/dev/null; true`).split('\n').filter(Boolean);
const langItems = items.filter(
  i => /^lang\/[a-z]+(_\w+)?\.res$/.test(i) && !['lang/pool.res', 'lang/res_index.res'].includes(i),
);
writeFileSync(
  join(work, 'items.txt'),
  ['plurals.res', 'metadata.res', 'lang/pool.res', ...langItems].join('\n'),
);
icu(
  `icupkg -x items.txt -d . ${icuPrefix}.dat >/dev/null 2>&1; mkdir -p out out/lang; ` +
    `derb -i . -d out plurals.res metadata.res && derb -i . -s lang -d out/lang ${langItems.map(i => i.slice(5)).join(' ')}`,
);

/** Parses derb's text form of a bundle into nested objects (strings for leaves). */
function derb(path) {
  const text = readFileSync(join(work, path), 'utf8');
  const tokens = [];
  const re = /\/\/[^\n]*|"((?:[^"\\]|\\.)*)"|([{},])|([^\s{},"]+)/g;
  for (let m; (m = re.exec(text));) {
    if (m[1] !== undefined) tokens.push({ s: JSON.parse(`"${m[1]}"`) });
    else if (m[2]) tokens.push(m[2]);
    else if (m[3]) tokens.push({ w: m[3] });
  }
  let i = 0;
  const value = () => {
    if (tokens[i] !== '{') throw new Error(`${path}: { expected at token ${i}`);
    i++;
    if (tokens[i]?.s !== undefined) {
      const list = [];
      while (tokens[i] !== '}') {
        if (tokens[i] === ',') i++;
        else list.push(tokens[i++].s);
      }
      i++;
      return list.length === 1 ? list[0] : list;
    }
    const table = {};
    while (tokens[i] !== '}') {
      const key = tokens[i++].w.replace(/:\w+$/, '');
      table[key] = value();
    }
    i++;
    return table;
  };
  i++; // the bundle name
  return value();
}

// --- Plural rules ---

const plurals = derb('out/plurals.txt');
/** A rule's condition: an OR of ANDs of relations. */
function parseRule(text) {
  const body = text.split('@')[0].trim();
  if (!body) return [];
  return body.split(/\s+or\s+/).map(and =>
    and.split(/\s+and\s+/).map(rel => {
      const m = /^([nivwftce])\s*(?:%\s*(\d+))?\s*(!=|=)\s*([\d.,]+)$/.exec(rel.trim());
      if (!m) throw new Error(`unsupported plural relation ${JSON.stringify(rel)} in ${text}`);
      const ranges = m[4].split(',').map(r => {
        const [lo, hi = lo] = r.split('..').map(Number);
        if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi) || hi > 0xffffffff)
          throw new Error(`range ${r}`);
        return [lo, hi];
      });
      return { op: m[1], mod: m[2] ? Number(m[2]) : 0, neg: m[3] === '!=', ranges };
    }),
  );
}
/** ICU's evaluation order: the resource's keywords in order, "other" last. */
function chainOrder(keys) {
  const chain = [];
  for (const k of keys) {
    if (!chain.length) chain.push(k);
    else {
      let at = 0;
      while (at + 1 < chain.length && chain[at + 1] !== 'other') at++;
      chain.splice(at + 1, 0, k);
    }
  }
  return chain;
}
const setNames = Object.keys(plurals.rules).sort((a, b) => a.slice(3) - b.slice(3));
const pluralSets = setNames.map(name => {
  const table = plurals.rules[name];
  return chainOrder(Object.keys(table)).map(k => {
    if (!CATEGORIES.includes(k)) throw new Error(`keyword ${k}`);
    return [CATEGORIES.indexOf(k), parseRule(table[k])];
  });
});
const setIndex = name => {
  const i = setNames.indexOf(name);
  if (i < 0) throw new Error(`rule set ${name}`);
  return i;
};
// The set without rules: "other" only (ordinals of a locale without any).
let otherOnly = pluralSets.findIndex(s => s.length === 1 && s[0][0] === 5 && !s[0][1].length);
if (otherOnly < 0) {
  otherOnly = pluralSets.length;
  pluralSets.push([[5, []]]);
}
const bcp47 = id => id.replace(/_/g, '-');
const pluralLocaleIds = [
  ...new Set([...Object.keys(plurals.locales), ...Object.keys(plurals.locales_ordinals)]),
];

// --- Aliases (as Intl canonicalizes) ---
//
// V8 canonicalizes the tags of locale arguments (CanonicalizeLocaleList)
// and the codes of DisplayNames#of (ICU's Locale::canonicalize) a little
// differently (`bh` stays in the first): language aliases are read from
// Chromium for each kind (`list` and `name` below), language and region
// keys (sgn_BR), script and region aliases from ICU's metadata.res.

const alias = derb('out/metadata.txt').alias;
/** Per kind, replacements by language or language_REGION (`sr_Latn`). */
const languageAliases = { list: {}, name: {} };
for (const [key, v] of Object.entries(alias.language)) {
  // Keys of a language and a region (sgn_BR); others involve variants or
  // legacy forms, which supported tags do not have.
  if (/^[a-z]{2,3}_([A-Z]{2}|\d{3})$/.test(key))
    languageAliases.list[key] = languageAliases.name[key] = v.replacement;
}
const scriptAliases = Object.fromEntries(
  Object.entries(alias.script).map(([k, v]) => [k, v.replacement]),
);
// (Region keys only: the table also maps ISO 3166 alpha-3 codes.)
const regionAliases = Object.fromEntries(
  Object.entries(alias.territory)
    .filter(([k]) => /^([A-Z]{2}|\d{3})$/.test(k))
    .map(([k, v]) => [k, v.replacement]),
);

/** Intl's canonical form of a simple tag, as the Rust side computes it. */
function canonical(tag, kind = 'list') {
  const aliases = languageAliases[kind];
  const p = parseTag(tag);
  if (p.error || p.unsupported) return p;
  let { lang, script, region } = p;
  for (let pass = 0; pass < 8; pass++) {
    let changed = false;
    const sub = (rep, dropRegion) => {
      const [l, ...rest] = rep.split('_');
      lang = l;
      if (dropRegion) region = undefined;
      for (const r of rest) {
        if (/^[A-Z][a-z]{3}$/.test(r)) script ??= r;
        else region ??= r;
      }
      changed = true;
    };
    if (region && aliases[`${lang}_${region}`]) sub(aliases[`${lang}_${region}`], true);
    else if (aliases[lang]) sub(aliases[lang], false);
    if (script && scriptAliases[script]) {
      script = scriptAliases[script];
      changed = true;
    }
    if (region && regionAliases[region]) {
      const r = regionAliases[region].split(' ');
      if (r.length > 1) return { unsupported: `region ${region} aliases several regions` };
      region = r[0];
      changed = true;
    }
    if (!changed) break;
  }
  return { lang, script, region };
}
/**
 * A tag of a language with an optional script and region; other well-formed
 * shapes are unsupported (variants, extensions), malformed ones errors.
 */
function parseTag(tag) {
  if (!/^[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(tag)) return { error: 'RangeError' };
  const parts = tag.split('-');
  // Intl's tags start with a language subtag (not a script, private use or
  // a legacy form).
  if (!/^[A-Za-z]{2,3}$|^[A-Za-z]{5,8}$/.test(parts[0])) return { error: 'RangeError' };
  const lang = parts[0].toLowerCase();
  let i = 1;
  let script, region;
  if (parts[i] && /^[A-Za-z]{4}$/.test(parts[i])) {
    script = parts[i][0].toUpperCase() + parts[i].slice(1).toLowerCase();
    i++;
  }
  if (parts[i] && /^([A-Za-z]{2}|\d{3})$/.test(parts[i])) {
    region = parts[i].toUpperCase();
    i++;
  }
  if (i < parts.length) return { unsupported: tag };
  return { lang, script, region };
}
const tagString = c => [c.lang, c.script, c.region].filter(Boolean).join('-');

// --- Chromium: plural rules ---

/** Page side: plural results for tags and numbers. */
function pluralPage({ tags, numbers, categoriesOnly }) {
  return tags.map(tag => {
    try {
      const card = new Intl.PluralRules(tag);
      const ord = new Intl.PluralRules(tag, { type: 'ordinal' });
      const out = {
        locale: card.resolvedOptions().locale,
        card: card.resolvedOptions().pluralCategories,
        ord: ord.resolvedOptions().pluralCategories,
      };
      if (!categoriesOnly) {
        out.cs = numbers.map(x => card.select(x));
        out.os = numbers.map(x => ord.select(x));
      }
      return out;
    } catch (e) {
      return { throw: e.name };
    }
  });
}

// Every two- and three-letter language, in two default locales: a tag
// that resolves to the default locale in both has no rules of its own.
const letters = 'abcdefghijklmnopqrstuvwxyz';
const codes2 = [...letters].flatMap(a => [...letters].map(b => a + b));
const codes3 = codes2.flatMap(ab => [...letters].map(c => ab + c));
const allLanguages = [...codes2, ...codes3];
const contexts = {};
const pages = {};
for (const loc of LOCALES) {
  contexts[loc] = await browser.newContext({ locale: loc, timezoneId: 'UTC' });
  pages[loc] = await contexts[loc].newPage();
}
console.error('aliases ...');
// The language_REGION keys of the metadata are probed too: Chromium does
// not always follow it (sgn-NO is nsl, the metadata says nsi).
const compoundAliasKeys = Object.keys(languageAliases.list);
const probed = [...allLanguages, ...compoundAliasKeys.map(bcp47)];
const canonicals = await pages['en-US'].evaluate(
  codes => codes.map(c => [Intl.getCanonicalLocales(c)[0], new Intl.Locale(c).toString()]),
  probed,
);
for (const k of compoundAliasKeys) (delete languageAliases.list[k], delete languageAliases.name[k]);
for (const [i, code] of probed.entries())
  for (const [k, kind] of ['list', 'name'].entries()) {
    const c = canonicals[i][k];
    if (c !== code) languageAliases[kind][code.replace(/-/g, '_')] = c.replace(/-/g, '_');
  }
// Region and script aliases as both canonicalizations apply them.
const regionCheck = await pages['en-US'].evaluate(
  ([regions, scripts]) => [
    regions.map(r => [
      Intl.getCanonicalLocales('en-' + r)[0],
      new Intl.Locale('en-' + r).toString(),
    ]),
    scripts.map(s => [
      Intl.getCanonicalLocales('en-' + s)[0],
      new Intl.Locale('en-' + s).toString(),
    ]),
  ],
  [Object.keys(regionAliases), Object.keys(scriptAliases)],
);
for (const [i, r] of Object.keys(regionAliases).entries()) {
  const reps = regionAliases[r].split(' ');
  for (const c of regionCheck[0][i])
    if (!reps.includes(c.slice(3))) throw new Error(`region alias ${r}: ${c}, data ${reps}`);
  if (reps.length === 1 && regionCheck[0][i].some(c => c !== `en-${reps[0]}`))
    throw new Error(`region alias ${r}: ${regionCheck[0][i]}`);
}
for (const [i, sc] of Object.keys(scriptAliases).entries())
  for (const c of regionCheck[1][i])
    if (c !== `en-${scriptAliases[sc]}`) throw new Error(`script alias ${sc}: ${c}`);
console.error('plural locales ...');
const resolvedA = await pages['en-US'].evaluate(pluralPage, {
  tags: allLanguages,
  numbers: [],
  categoriesOnly: true,
});
const resolvedB = await pages['ja-JP'].evaluate(pluralPage, {
  tags: allLanguages,
  numbers: [],
  categoriesOnly: true,
});
// The model: the canonical tag, then ECMA-402's lookup over the locales the
// plural data names, else the default locale.
const available = new Set(pluralLocaleIds.map(bcp47));
function lookup(tag) {
  const c = canonical(tag);
  if (c.error || c.unsupported) return c;
  let t = tagString(c);
  while (t) {
    if (available.has(t)) return { locale: t };
    const cut = t.lastIndexOf('-');
    if (cut < 0) break;
    t = t.slice(0, cut);
    if (t.length >= 2 && t[t.length - 2] === '-') t = t.slice(0, -2);
  }
  return { locale: undefined };
}
let mismatches = 0;
for (const [i, code] of allLanguages.entries()) {
  const a = resolvedA[i];
  const b = resolvedB[i];
  const chromeDefault = a.locale === 'en-US' && b.locale === 'ja-JP';
  const model = lookup(code);
  const ok = chromeDefault ? model.locale === undefined : model.locale === a.locale;
  if (!ok && mismatches++ < 20)
    console.error(`  plural locale of ${code}: Chromium ${a.locale}/${b.locale}, model`, model);
}
if (mismatches) throw new Error(`${mismatches} plural locale mismatches`);

/** The rule sets of an available plural locale (ICU's fallback by truncation). */
function setsOf(locale) {
  const find = table => {
    let id = locale.replace(/-/g, '_');
    while (id) {
      if (table[id]) return setIndex(table[id]);
      const cut = id.lastIndexOf('_');
      if (cut < 0) break;
      id = id.slice(0, cut);
    }
    return undefined;
  };
  return [find(plurals.locales) ?? otherOnly, find(plurals.locales_ordinals) ?? otherOnly];
}
const pluralLocales = [...available].sort().map(l => [l, ...setsOf(l)]);

// --- Chromium: display names ---

const TYPES = ['region', 'script', 'currency', 'language'];
const upper = letters.toUpperCase();
const regionCodes = [
  ...codes2.map(c => c.toUpperCase()),
  ...Array.from({ length: 1000 }, (_, i) => String(i).padStart(3, '0')),
];
const scriptCodes = [...upper].flatMap(a =>
  [...letters].flatMap(b => [...letters].flatMap(c => [...letters].map(d => a + b + c + d))),
);
const currencyCodes = codes3.map(c => c.toUpperCase());
// Compound dialect keys anywhere in ICU's language data (lang_Script,
// lang_REGION; there are no three-part keys).
const compoundKeys = new Set();
for (const item of langItems) {
  const loc = item.slice(5, -4);
  const table = derb(`out/lang/${loc}.txt`);
  for (const [name, t] of Object.entries(table))
    if (/^Languages(%.*)?$/.test(name))
      for (const k of Object.keys(t)) {
        if (k.split('_').length > 2) throw new Error(`three-part language key ${k} in ${loc}`);
        if (k.includes('_') && name === 'Languages') compoundKeys.add(k.replace('_', '-'));
      }
}

function namesPage({ locale, regions, scripts, currencies, languages, compounds }) {
  const none = type => new Intl.DisplayNames(locale, { type, fallback: 'none' });
  const scan = (type, codes) => {
    const dn = none(type);
    const out = {};
    for (const c of codes) {
      const v = dn.of(c);
      if (v !== undefined) out[c] = v;
    }
    return out;
  };
  // A compound key names a dialect where the dialect name differs from the
  // standard composition.
  const dialect = none('language');
  const standard = new Intl.DisplayNames(locale, {
    type: 'language',
    fallback: 'none',
    languageDisplay: 'standard',
  });
  const compound = {};
  for (const k of compounds) {
    const d = dialect.of(k);
    compound[k] = d !== undefined && d !== standard.of(k) ? d : null;
  }
  const code = new Intl.DisplayNames(locale, { type: 'language' });
  return {
    resolved: dialect.resolvedOptions().locale,
    region: scan('region', regions),
    script: scan('script', scripts),
    currency: scan('currency', currencies),
    language: scan('language', languages),
    compound,
    // Pattern and separator around names Chromium has no data for.
    probe1: code.of('qqq-QM'),
    probe2: code.of('qqq-Qaaa-QM'),
  };
}
const displayData = {};
for (const loc of [...LOCALES, ...Object.keys(DISPLAY_ALIAS_CANDIDATES)]) {
  console.error(`display names ${loc} ...`);
  displayData[loc] = await pages['en-US'].evaluate(namesPage, {
    locale: loc,
    regions: regionCodes,
    scripts: scriptCodes,
    currencies: currencyCodes,
    languages: allLanguages.filter(c => {
      const k = canonical(c, 'name');
      return !k.error && !k.unsupported && !k.script && !k.region && k.lang === c;
    }),
    compounds: [...compoundKeys],
  });
}
const displayAliases = [];
for (const [a, full] of Object.entries(DISPLAY_ALIAS_CANDIDATES)) {
  const strip = d => JSON.stringify({ ...d, resolved: undefined });
  if (strip(displayData[a]) === strip(displayData[full]))
    displayAliases.push([a, LOCALES.indexOf(full)]);
  else console.error(`display locale ${a} differs from ${full}; not supported`);
}
// Compose: `{name}{open}{parts joined by sep}{close}`.
const compose = LOCALES.map(loc => {
  const d = displayData[loc];
  const m1 = /^qqq(.*)QM(.*)$/.exec(d.probe1);
  const m2 = /^qqq(.*)Qaaa(.*)QM(.*)$/.exec(d.probe2);
  if (!m1 || !m2 || m1[1] !== m2[1] || m1[2] !== m2[3])
    throw new Error(`pattern of ${loc}: ${d.probe1} / ${d.probe2}`);
  return [m1[1], m1[2], m2[2]];
});

// --- Vectors ---

console.error('vectors ...');
const NUMBERS = [
  0,
  -0,
  1,
  -1,
  2,
  3,
  4,
  5,
  6,
  7,
  10,
  11,
  12,
  13,
  14,
  15,
  19,
  20,
  21,
  22,
  23,
  25,
  40,
  70,
  80,
  99,
  100,
  101,
  102,
  103,
  111,
  200,
  1000,
  1001,
  10000,
  100000,
  1000000,
  2000000,
  1e7,
  1e9,
  1e15,
  1e18,
  1e21,
  1.5e300,
  0.1,
  0.2,
  0.5,
  1.1,
  1.2,
  1.25,
  1.5,
  2.1,
  2.5,
  3.4,
  10.1,
  0.01,
  0.001,
  0.0005,
  0.0004,
  0.999,
  0.9995,
  1.0004,
  1.0005,
  1.0001,
  21.0001,
  1000000.5,
  1234567.0001,
  12345678901234567890,
  5e-324,
  NaN,
  Infinity,
  -Infinity,
  2.25,
  3.125,
  7.07,
  11.5,
  101.01,
];
const randomNumber = () => {
  const r = rand();
  if (r < 0.4) return Math.floor(rand() * 10 ** Math.floor(rand() * 7)) * (rand() < 0.2 ? -1 : 1);
  if (r < 0.7)
    return Number((rand() * 10 ** Math.floor(rand() * 5)).toFixed(Math.floor(rand() * 5)));
  if (r < 0.9) return (rand() - 0.3) * 10 ** Math.floor(rand() * 30 - 10);
  return pick(NUMBERS);
};
const numberString = x => (Object.is(x, -0) ? '-0' : String(x));
const pluralLangs = pluralLocales.map(l => l[0]);
const tagPool = [
  ...pluralLangs,
  ...Object.keys(languageAliases.name).map(bcp47),
  'pt-PT',
  'pt-Latn-PT',
  'pt-BR',
  'por-PT',
  'sh',
  'sh-Cyrl',
  'iw-IL',
  'sgn-BR',
  'tlh',
  'xx',
  'en-XX',
  'abcde',
  'und',
  'zh-Hant-TW',
  'EN-us',
  'sr-Latn',
  'hy-SU',
  'en-US-posix',
  'en-u-nu-arab',
  'x-foo',
  'i-klingon',
  'root',
  '',
  'en--US',
  'en_US',
  'a',
  'en-US-US',
  'de-1996',
  'Latn-US',
  '123',
  'toolongtag',
  'en-AN',
  'nl-AN',
];
const randomTag = () => {
  const r = rand();
  const lang = r < 0.7 ? pick(pluralLangs).split('-')[0] : pick(allLanguages);
  let t = lang;
  if (rand() < 0.25) t += '-' + pick(['Latn', 'Cyrl', 'Hans', 'Hant', 'Arab', 'Zzzz', 'Qaai']);
  if (rand() < 0.4)
    t +=
      '-' + pick(['US', 'PT', 'BR', 'GB', 'DE', '419', '001', 'CN', 'TW', 'DD', 'BU', 'ZZ', 'XK']);
  if (rand() < 0.15) t = t.toUpperCase();
  return t;
};
const pluralVectors = [];
const categoryVectors = [];
// One locale per rule set selects every number; the others a sample.
const representatives = new Set();
for (const k of [1, 2]) {
  const seen = new Set();
  for (const l of pluralLocales)
    if (!seen.has(l[k])) {
      seen.add(l[k]);
      representatives.add(l[0]);
    }
}
for (const env of LOCALES) {
  // The available locales (the env locale varying), random tags and the
  // tag pool.
  const tags = [];
  for (const [i, l] of pluralLangs.entries())
    if (i % LOCALES.length === LOCALES.indexOf(env)) tags.push(l);
  const own = tags.length;
  for (let i = 0; i < 150; i++) tags.push(randomTag());
  for (const t of tagPool) if (rand() < 0.4) tags.push(t);
  const numbers = [...NUMBERS, ...Array.from({ length: 30 }, randomNumber)];
  const res = await pages[env].evaluate(pluralPage, { tags, numbers, categoriesOnly: false });
  for (const [ti, tag] of tags.entries()) {
    const r = res[ti];
    const c = canonical(tag);
    const literal = rand() < 0.3 && !r.throw && !c.error && !c.unsupported;
    const at = literal ? [`loc=${tag}`, null] : [null, tag];
    for (const type of ['cardinal', 'ordinal']) {
      const spec = ['m=p', at[0], type === 'ordinal' ? 'type=ordinal' : null]
        .filter(Boolean)
        .join(';');
      if (r.throw) {
        pluralVectors.push([env, spec, at[1], '1', { throw: r.throw }]);
        categoryVectors.push([env, spec, at[1], { throw: r.throw }]);
        continue;
      }
      categoryVectors.push([env, spec, at[1], type === 'ordinal' ? r.ord : r.card]);
      const sel = type === 'ordinal' ? r.os : r.cs;
      // A sample of the numbers keeps the file small.
      const all = ti < own && representatives.has(tag);
      const share = ti < own ? 0.1 : 0.04;
      for (const [ni, x] of numbers.entries())
        if (all || rand() < share) pluralVectors.push([env, spec, at[1], numberString(x), sel[ni]]);
    }
  }
}
// Default locales: tags without rules of their own.
for (const env of LOCALES) {
  const res = await pages[env].evaluate(pluralPage, {
    tags: ['tlh', 'xx', 'und', 'abcde'],
    numbers: NUMBERS,
    categoriesOnly: false,
  });
  for (const [i, tag] of ['tlh', 'xx', 'und', 'abcde'].entries())
    for (const [ni, x] of NUMBERS.entries())
      pluralVectors.push([env, 'm=p', tag, numberString(x), res[i].cs[ni]]);
}

function displayPage(cases) {
  return cases.map(({ loc, o, code }) => {
    try {
      const v = new Intl.DisplayNames(loc, o).of(code);
      return v === undefined ? null : v;
    } catch (e) {
      return { throw: e.name };
    }
  });
}
const displayLocales = [...LOCALES, ...displayAliases.map(a => a[0])];
const displayCases = [];
const randomCase = s => {
  let out = '';
  for (const ch of s) out += rand() < 0.5 ? ch.toUpperCase() : ch.toLowerCase();
  return out;
};
for (const loc of LOCALES) {
  const d = displayData[loc];
  const add = (type, code, extra = {}) => {
    const fallback = rand() < 0.5 ? 'none' : undefined;
    const o = { type, fallback, ...extra };
    const literal = rand() < 0.3;
    const same = [loc, ...displayAliases.filter(a => LOCALES[a[1]] === loc).map(a => a[0])];
    const at = rand() < 0.2 ? undefined : pick(same);
    displayCases.push({ env: pick(LOCALES), loc: at, literal, o, code });
  };
  // Every named code once, and malformed, unnamed and differently cased ones.
  for (const c of Object.keys(d.region)) add('region', c);
  for (const c of Object.keys(d.script)) add('script', c);
  for (const c of Object.keys(d.currency)) add('currency', rand() < 0.2 ? randomCase(c) : c);
  for (const c of Object.keys(d.language))
    add('language', c, rand() < 0.3 ? { languageDisplay: 'standard' } : {});
  for (const c of compoundKeys)
    for (const ld of ['dialect', 'standard']) add('language', c, { languageDisplay: ld });
  for (let i = 0; i < 300; i++) {
    add(
      'region',
      pick([
        pick(regionCodes),
        randomCase(pick(regionCodes)),
        pick(['USA', 'U', '1', '12', '1234', 'U1', '']),
      ]),
    );
    add(
      'script',
      pick([pick(scriptCodes), randomCase(pick(scriptCodes)), pick(['Lat', 'Latin', 'L4tn', ''])]),
    );
    add(
      'currency',
      pick([pick(currencyCodes), randomCase(pick(currencyCodes)), pick(['US', 'USDX', 'U5D', ''])]),
    );
  }
  const langs = Object.keys(d.language);
  const scripts = Object.keys(d.script);
  const regions = Object.keys(d.region);
  for (let i = 0; i < 1500; i++) {
    const r = rand();
    let t;
    if (r < 0.2) t = pick(tagPool);
    else {
      t = rand() < 0.85 ? pick(langs) : pick(allLanguages);
      if (rand() < 0.3) t += '-' + (rand() < 0.9 ? pick(scripts) : pick(['Qaai', 'Zzzz', 'Xyzw']));
      if (rand() < 0.6)
        t +=
          '-' + (rand() < 0.9 ? pick(regions) : pick(['QM', 'XX', '999', 'DD', 'BU', 'AN', 'SU']));
      if (rand() < 0.1) t = randomCase(t);
    }
    add('language', t, rand() < 0.4 ? { languageDisplay: 'standard' } : {});
  }
}
const displayVectors = [];
for (const env of LOCALES) {
  const batch = displayCases.filter(c => c.env === env);
  const res = await pages[env].evaluate(displayPage, batch);
  for (const [i, c] of batch.entries()) {
    const literal = c.literal && c.loc !== undefined;
    const spec = [
      'm=n',
      literal ? `loc=${c.loc}` : null,
      `type=${c.o.type}`,
      c.o.fallback ? `fallback=${c.o.fallback}` : null,
      c.o.languageDisplay ? `languageDisplay=${c.o.languageDisplay}` : null,
    ]
      .filter(Boolean)
      .join(';');
    displayVectors.push([env, spec, literal ? null : (c.loc ?? null), c.code, res[i]]);
  }
}
await browser.close();
rmSync(work, { recursive: true, force: true });

// --- Writing ---

const rs = s => JSON.stringify(s);
const strings = [];
const stringIds = new Map();
const sid = s => {
  if (s === undefined || s === null) return 65535;
  if (!stringIds.has(s)) {
    stringIds.set(s, strings.length);
    strings.push(s);
  }
  return stringIds.get(s);
};
const nameTable = key => {
  const codes = new Set();
  for (const loc of LOCALES) for (const c of Object.keys(displayData[loc][key])) codes.add(c);
  return [...codes]
    .sort()
    .map(c => `    (${rs(c)}, [${LOCALES.map(l => sid(displayData[l][key][c])).join(', ')}])`)
    .join(',\n');
};
const compounds = [...compoundKeys]
  .sort()
  .map(k => [k, LOCALES.map(l => displayData[l].compound[k])])
  .filter(([, names]) => names.some(n => n !== null));
const rel = r =>
  `R { op: b'${r.op}', m: ${r.mod}, neg: ${r.neg}, r: &[${r.ranges.map(([a, b]) => `(${a}, ${b})`).join(', ')}] }`;
const out = `// @generated by tests/vectors/intl-locales.mjs from Chromium ${browserVersion} (${icuPrefix}). Do not edit.
//
// Plural rules and language tag aliases from Chromium's ICU data;
// display names read from Chromium (see the generator).
#![allow(clippy::all)]
use super::plural::R;

pub static BROWSER: &str = ${rs(browserVersion)};

/// Plural rule sets: per keyword (0 zero, 1 one, 2 two, 3 few, 4 many,
/// 5 other) in ICU's evaluation order, an OR of ANDs of relations.
pub static PLURAL_SETS: &[&[(u8, &[&[R]])]] = &[
${pluralSets.map(s => `    &[${s.map(([k, or]) => `(${k}, &[${or.map(and => `&[${and.map(rel).join(', ')}]`).join(', ')}])`).join(', ')}]`).join(',\n')}
];

/// The locales with plural data (Intl's available locales), sorted, with
/// their cardinal and ordinal rule sets.
pub static PLURAL_LOCALES: &[(&str, u16, u16)] = &[
${pluralLocales.map(([l, c, o]) => `    (${rs(l)}, ${c}, ${o})`).join(',\n')}
];

/// Language aliases by language or language_REGION: the replacement
/// (language, then a script or region filling absent ones) where locale
/// arguments are canonicalized, and where DisplayNames#of canonicalizes
/// its code ("" where a kind keeps the key).
pub static LANGUAGE_ALIASES: &[(&str, &str, &str)] = &[
${[...new Set([...Object.keys(languageAliases.list), ...Object.keys(languageAliases.name)])]
  .sort()
  .map(
    k =>
      `    (${rs(k)}, ${rs(languageAliases.list[k] ?? '')}, ${rs(languageAliases.name[k] ?? '')})`,
  )
  .join(',\n')}
];
pub static SCRIPT_ALIASES: &[(&str, &str)] = &[${Object.entries(scriptAliases)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([k, v]) => `(${rs(k)}, ${rs(v)})`)
  .join(', ')}];
/// Region aliases; several replacements (space-separated) depend on the
/// language's likely region, which is not modelled.
pub static REGION_ALIASES: &[(&str, &str)] = &[
${Object.entries(regionAliases)
  .sort(([a], [b]) => (a < b ? -1 : 1))
  .map(([k, v]) => `    (${rs(k)}, ${rs(v)})`)
  .join(',\n')}
];

/// Display-name locales: tag and data column (LOCALES order).
pub static DISPLAY_LOCALES: &[(&str, usize)] = &[${[
  ...LOCALES.map((l, i) => [l, i]),
  ...displayAliases,
]
  .map(([l, i]) => `(${rs(l)}, ${i})`)
  .join(', ')}];

/// Per display locale: the text before the qualifiers, the separator
/// between them and the text after (ICU's localeDisplayPattern).
pub static COMPOSE: &[(&str, &str, &str)] = &[${compose.map(([o, c, s]) => `(${rs(o)}, ${rs(s)}, ${rs(c)})`).join(', ')}];

/// Name tables: code and, per display locale, a string index (65535: none).
pub static REGIONS: &[(&str, [u16; ${LOCALES.length}])] = &[
${nameTable('region')}
];
pub static SCRIPTS: &[(&str, [u16; ${LOCALES.length}])] = &[
${nameTable('script')}
];
pub static CURRENCIES: &[(&str, [u16; ${LOCALES.length}])] = &[
${nameTable('currency')}
];
pub static LANGUAGES: &[(&str, [u16; ${LOCALES.length}])] = &[
${nameTable('language')}
];
/// Dialect names of a language with a script or region (\`en-US\`).
pub static DIALECTS: &[(&str, [u16; ${LOCALES.length}])] = &[
${compounds.map(([k, names]) => `    (${rs(k)}, [${names.map(sid).join(', ')}])`).join(',\n')}
];

pub static STRINGS: &[&str] = &[
${strings.map(s => `    ${rs(s)}`).join(',\n')}
];
`;
writeFileSync(join(crate, 'src/intl/locale_data.rs'), out);
writeFileSync(
  join(here, 'intl-locales.json'),
  JSON.stringify({
    browser: browserVersion,
    icu: icuPrefix,
    // [env, spec, runtime tag, [x, result, x, result, …]]
    plural: pluralVectors.reduce((groups, [env, spec, tag, x, r]) => {
      const last = groups[groups.length - 1];
      if (last && last[0] === env && last[1] === spec && last[2] === tag) last[3].push(x, r);
      else groups.push([env, spec, tag, [x, r]]);
      return groups;
    }, []),
    categories: categoryVectors,
    display: displayVectors,
  }) + '\n',
);
console.error(
  `locale_data.rs: ${pluralSets.length} rule sets, ${pluralLocales.length} plural locales, ${strings.length} strings; ` +
    `intl-locales.json: ${pluralVectors.length} plural, ${categoryVectors.length} category, ${displayVectors.length} display vectors`,
);
