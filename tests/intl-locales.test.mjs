// Intl.PluralRules and Intl.DisplayNames (docs/IR.md, `intl.plural-*`,
// `intl.display-of`, `intl.locale`): lowering of the uses the Translations
// Editor makes (locales computed at run time, options chosen by a
// condition), run by the reference interpreter; and the rejections, with
// locations. The data and semantics are pinned by
// crates/runic-js/tests/intl_locales.rs (Chromium vectors); behaviour against
// Chromium by conformance/run.mjs (cases plural-names, plural-names-de).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { collect, hash, Diagnostic } from '../compiler/collect.mjs';
import { lower } from '../compiler/frontend.mjs';
import { interpret } from '../compiler/codegen.mjs';

let base;
const graph = () => (base ??= collect('fixtures/plural-names-svelte'));

/** The collected fixture with replacements in `file`. */
async function edits(file, pairs) {
  const g = await graph();
  const id = path.join(g.root, file);
  let code = g.modules.get(id).code;
  for (const [from, to] of pairs) {
    assert.ok(
      typeof from === 'string' ? code.includes(from) : from.test(code),
      `Replacement must match: ${from}`,
    );
    code = code.replace(from, () => to);
  }
  const modules = new Map(g.modules);
  modules.set(id, { ...g.modules.get(id), code });
  return { ...g, modules, hash: hash(code) };
}

const flat = nodes => nodes.flatMap(n => (typeof n === 'string' ? [] : [n, ...flat(n.children)]));
const textOf = n => (typeof n === 'string' ? n : n.children.map(textOf).join(''));
const text = (step, id) => textOf(flat(step.state.dom).find(n => n.attrs.id === id));

test('plural rules and display names with runtime locales and chosen options', async () => {
  const { ir } = await lower(await graph());
  const click = id => ({ kind: 'click', id });
  // pl, ordinal, then the UI in German.
  const steps = interpret(ir, [click('next'), click('next'), click('ordinal'), click('ui')], {
    locale: 'en-US',
  });
  const [first, , pl, ordinal, german] = steps;
  assert.equal(text(first, 'categories'), 'one, other');
  assert.equal(text(first, 'nth'), '0th 1st 2nd 3rd 5th 11th 21st 22nd 23rd 101st');
  assert.equal(text(pl, 'target'), 'pl · Polish · cardinal');
  assert.equal(text(pl, 'categories'), 'one, few, many, other');
  assert.match(
    text(pl, 'select'),
    /^0: many · 1: one · 2: few · 3: few · 5: many .* 1.5: other · 0.0005: other · 1000000: many$/,
  );
  assert.equal(text(ordinal, 'categories'), 'other');
  assert.match(
    text(german, 'names'),
    /de-AT: Österreichisches Deutsch.*zh-Hant-TW: Chinesisch \(Traditionell, Taiwan\).*tlh: tlh.*en_US: en_US/,
  );
  assert.equal(
    text(german, 'currencies'),
    'Euro · US-Dollar · Japanischer Yen · Schweizer Franken · ?',
  );
  assert.equal(text(first, 'currencies'), 'Euro · US Dollar · Japanese Yen · Swiss Franc · ?');
  assert.equal(
    text(first, 'standard'),
    'anglais (États-Unis) · chinois (simplifié) · serbe (latin, Serbie) · xx (Congo-Kinshasa) · allemand (Autriche)',
  );
  // The default locale: tlh has no plural data, the undefined display locale.
  const de = interpret(ir, [], { locale: 'de-DE' })[0];
  assert.equal(
    text(de, 'currencies'),
    'Euro · US-Dollar · Japanischer Yen · Schweizer Franken · ?',
  );
});

const rejects = async (g, file, pattern) =>
  assert.rejects(lower(g), e => {
    assert.ok(e instanceof Diagnostic, `expected a diagnostic, got ${e}`);
    assert.equal(e.code, 'E_INTL', e.message);
    if (pattern) assert.match(e.message, pattern);
    assert.equal(e.source?.file, file, e.message);
    assert.ok(e.source.line > 0 && e.source.column > 0);
    return true;
  });

const rejected = [
  [
    'digit options of plural rules',
    [
      "new Intl.PluralRules('en-US', { type: 'ordinal' })",
      "new Intl.PluralRules('en-US', { minimumFractionDigits: 1 })",
    ],
    /not verified for plural rules/,
  ],
  [
    'a plural locale with an extension',
    ["new Intl.PluralRules('en-US',", "new Intl.PluralRules('en-u-nu-arab',"],
    /no variants or extensions/,
  ],
  [
    'an unverified display locale',
    [
      "new Intl.DisplayNames('de', { type: 'region' })",
      "new Intl.DisplayNames('de-AT', { type: 'region' })",
    ],
    /de-AT are not verified/,
  ],
  [
    'a short style',
    ["{ type: 'region' }", "{ type: 'region', style: 'short' }"],
    /not one of long/,
  ],
  ['display names without a type', ["{ type: 'region' }", '{}'], /requires a type/],
  [
    'calendar names',
    ["{ type: 'region' }", "{ type: 'calendar' }"],
    /not one of region, script, currency, language/,
  ],
  [
    'languageDisplay on regions',
    ["{ type: 'region' }", "{ type: 'region', languageDisplay: 'standard' }"],
    /type language only/,
  ],
  [
    'a constant with a runtime locale',
    [
      "export function localeName(tag: string, uiLocale: string): string {\n  try {\n    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(tag) ?? tag;",
      "export function localeName(tag: string, uiLocale: string): string {\n  const names = new Intl.DisplayNames([uiLocale], { type: 'language' });\n  try {\n    return names.of(tag) ?? tag;",
    ],
    /constructed where it is used/,
  ],
  [
    'resolvedOptions().locale',
    ['.pluralCategories;', ".locale.split('-');"],
    /resolvedOptions\(\)\.locale is unsupported/,
  ],
  ['selectRange', ['.select(n);', '.selectRange(n, n + 1);'], /selectRange is unsupported/],
];

for (const [what, pair, pattern] of rejected)
  test(`rejects ${what}`, async () => {
    await rejects(await edits('intl.ts', [pair]), 'intl.ts', pattern);
  });

test('an unverified locale at run time is reported, not caught as an error', async () => {
  // The program catches errors of DisplayNames and would show the tag:
  // the interpreter stops instead (the native runtime reports it), since
  // Chromium has names for de-AT that are not verified.
  const { ir } = await lower(
    await edits('App.svelte', [
      ["const UI = ['en', 'de',", "const UI = ['en', 'de-AT',"],
      [/<p id="currencies">.*<\/p>/, ''],
    ]),
  );
  const [, step] = interpret(ir, [{ kind: 'click', id: 'ui' }], { locale: 'en-US' });
  assert.equal(step.outcome.rejected?.code, 'E_UNSUPPORTED');
  assert.match(step.outcome.rejected.message, /DisplayNames for the locale de-AT/);
});
