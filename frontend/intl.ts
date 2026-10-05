// Locale-sensitive operations (docs/IR.md, `intl.*` built-ins): the verified
// subset of Intl options and locales, and the option strings the IR carries.
// The Rust validator re-checks every string with runic-js's parsers (time
// zones, digit ranges and option combinations).
import type { Literal } from './ir.ts';

/** Locales whose formatting and collation are verified against Chromium. */
export const LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP'];
/** Language tags verified to behave exactly as one of LOCALES. */
const ALIASES = ['en', 'de', 'fr'];
/**
 * Display locales of Intl.DisplayNames: the verified locales and the
 * language tags whose names equal theirs (runic_js locale_data).
 */
export const DISPLAY_LOCALES = [...LOCALES, 'en', 'de', 'fr', 'ja'];
/** Currencies with verified symbols in every locale. */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CNY', 'INR', 'CAD', 'AUD'];

/** The verified spelling of a locale tag (BCP 47 tags are case-insensitive). */
export function verifiedLocale(tag: string): string | undefined {
  const lower = tag.toLowerCase();
  return [...LOCALES, ...ALIASES].find(l => l.toLowerCase() === lower);
}

export type IntlKind = 'date' | 'number' | 'collator' | 'plural' | 'names';

/**
 * A literal tag of Intl.PluralRules: plural rules exist for every locale
 * Chromium has them for, so any language with an optional script and region
 * (runic_js::intl::tag; the validator resolves it). Variants and extensions
 * are not modelled.
 */
const SIMPLE_TAG = /^([A-Za-z]{2,3}|[A-Za-z]{5,8})(-[A-Za-z]{4})?(-([A-Za-z]{2}|\d{3}))?$/;

type Rule = readonly string[] | 'boolean' | 'integer' | 'zone' | { reject: string };

const DATE_OPTIONS: Record<string, Rule> = {
  weekday: ['long', 'short', 'narrow'],
  year: ['numeric', '2-digit'],
  month: ['numeric', '2-digit', 'long', 'short', 'narrow'],
  day: ['numeric', '2-digit'],
  hour: ['numeric', '2-digit'],
  minute: ['numeric', '2-digit'],
  second: ['numeric', '2-digit'],
  hour12: 'boolean',
  timeZone: 'zone',
  dateStyle: ['full', 'long', 'medium', 'short'],
  timeStyle: ['medium', 'short'],
  era: { reject: 'era is not verified' },
  timeZoneName: { reject: 'timeZoneName is not verified (zone names)' },
  hourCycle: { reject: 'hourCycle is not verified; use hour12' },
  fractionalSecondDigits: { reject: 'fractionalSecondDigits is not verified' },
  dayPeriod: { reject: 'dayPeriod is not verified' },
  calendar: { reject: 'calendars other than the default are not verified' },
  numberingSystem: { reject: 'numbering systems other than the default are not verified' },
  formatMatcher: { reject: 'formatMatcher is not supported' },
  localeMatcher: { reject: 'localeMatcher is not supported' },
};

const NUMBER_OPTIONS: Record<string, Rule> = {
  style: ['decimal', 'percent', 'currency'],
  currency: CURRENCIES,
  currencyDisplay: ['symbol', 'narrowSymbol', 'code'],
  minimumIntegerDigits: 'integer',
  minimumFractionDigits: 'integer',
  maximumFractionDigits: 'integer',
  minimumSignificantDigits: 'integer',
  maximumSignificantDigits: 'integer',
  useGrouping: ['true', 'false', 'always', 'auto', 'min2'],
  notation: { reject: 'notation is not verified (standard only)' },
  compactDisplay: { reject: 'compactDisplay is not verified' },
  signDisplay: { reject: 'signDisplay is not verified' },
  unit: { reject: 'unit formatting is not verified' },
  unitDisplay: { reject: 'unit formatting is not verified' },
  currencySign: { reject: 'currencySign is not verified' },
  roundingMode: { reject: 'roundingMode is not verified (halfExpand only)' },
  roundingPriority: { reject: 'roundingPriority is not verified' },
  roundingIncrement: { reject: 'roundingIncrement is not verified' },
  trailingZeroDisplay: { reject: 'trailingZeroDisplay is not verified' },
  numberingSystem: { reject: 'numbering systems other than the default are not verified' },
  localeMatcher: { reject: 'localeMatcher is not supported' },
};

const COLLATOR_OPTIONS: Record<string, Rule> = {
  usage: ['sort'],
  sensitivity: ['base', 'accent', 'case', 'variant'],
  numeric: 'boolean',
  caseFirst: ['upper', 'lower', 'false'],
  ignorePunctuation: 'boolean',
  collation: { reject: 'collation types are not verified' },
  localeMatcher: { reject: 'localeMatcher is not supported' },
};

const DIGITS = { reject: 'digit and rounding options are not verified for plural rules' };
const PLURAL_OPTIONS: Record<string, Rule> = {
  type: ['cardinal', 'ordinal'],
  minimumIntegerDigits: DIGITS,
  minimumFractionDigits: DIGITS,
  maximumFractionDigits: DIGITS,
  minimumSignificantDigits: DIGITS,
  maximumSignificantDigits: DIGITS,
  roundingMode: DIGITS,
  roundingPriority: DIGITS,
  roundingIncrement: DIGITS,
  trailingZeroDisplay: DIGITS,
  notation: { reject: 'notation is not verified (standard only)' },
  localeMatcher: { reject: 'localeMatcher is not supported' },
};

const NAMES_OPTIONS: Record<string, Rule> = {
  type: ['region', 'script', 'currency', 'language'],
  fallback: ['code', 'none'],
  languageDisplay: ['dialect', 'standard'],
  style: ['long'],
  localeMatcher: { reject: 'localeMatcher is not supported' },
};

const OPTIONS: Record<IntlKind, Record<string, Rule>> = {
  date: DATE_OPTIONS,
  number: NUMBER_OPTIONS,
  collator: COLLATOR_OPTIONS,
  plural: PLURAL_OPTIONS,
  names: NAMES_OPTIONS,
};

/** A problem with an option (`key` locates it), or the option string. */
export type SpecResult = { spec: string } | { error: string; key?: string };

/**
 * The option string of an operation: `m=<method>`, the literal locale
 * (absent: the default or a runtime locale) and the given options.
 * Methods: date `d`/`t`/`a` (toLocaleDateString/TimeString/String) and `f`
 * (Intl.DateTimeFormat#format); number `n`/`f`; collator `l`/`c`; plural
 * rules `p`; display names `n`.
 */
export function intlSpec(
  kind: IntlKind,
  method: string,
  locale: string | undefined,
  options: [string, Literal | undefined][],
): SpecResult {
  const parts = [`m=${method}`];
  if (locale !== undefined && kind === 'plural') {
    if (!SIMPLE_TAG.test(locale))
      return {
        error: `Locale ${JSON.stringify(locale)}: plural rules support a language with an optional script and region (no variants or extensions)`,
      };
    parts.push(`loc=${locale}`);
  } else if (locale !== undefined && kind === 'names') {
    const lower = locale.toLowerCase();
    const verified = DISPLAY_LOCALES.find(l => l.toLowerCase() === lower);
    if (!verified)
      return {
        error: `Display names in ${locale} are not verified (verified: ${DISPLAY_LOCALES.join(', ')})`,
      };
    parts.push(`loc=${verified}`);
  } else if (locale !== undefined) {
    const verified = verifiedLocale(locale);
    if (!verified)
      return {
        error: `Locale ${locale} is not verified (verified: ${[...LOCALES, ...ALIASES].join(', ')})`,
      };
    parts.push(`loc=${verified}`);
  }
  const rules = OPTIONS[kind];
  for (const [key, value] of options) {
    if (value === undefined) continue;
    const rule = Object.hasOwn(rules, key) ? rules[key] : undefined;
    if (rule === undefined) return { error: `Option ${key} is not supported`, key };
    if (typeof rule === 'object' && 'reject' in rule) return { error: rule.reject, key };
    let text: string;
    if (rule === 'boolean') {
      if (typeof value !== 'boolean') return { error: `${key} must be true or false`, key };
      text = String(value);
    } else if (rule === 'integer') {
      if (typeof value !== 'number') return { error: `${key} must be a number`, key };
      text = String(value);
    } else if (rule === 'zone') {
      if (typeof value !== 'string') return { error: `${key} must be a time zone name`, key };
      text = value;
    } else {
      text = String(value);
      if (!rule.includes(text))
        return { error: `${key}: ${JSON.stringify(value)} is not one of ${rule.join(', ')}`, key };
    }
    if (/[;=]/.test(text)) return { error: `${key}: unsupported value`, key };
    parts.push(`${key}=${text}`);
  }
  if (kind === 'names') {
    const type = options.find(([k, v]) => k === 'type' && v !== undefined)?.[1];
    if (type === undefined) return { error: 'Intl.DisplayNames requires a type (a TypeError)' };
    if (type !== 'language' && options.some(([k, v]) => k === 'languageDisplay' && v !== undefined))
      return { error: 'languageDisplay applies to type language only', key: 'languageDisplay' };
  }
  return { spec: parts.join(';') };
}
