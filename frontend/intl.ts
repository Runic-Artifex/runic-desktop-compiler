// Locale-sensitive operations (docs/IR.md, `intl.*` built-ins): the verified
// subset of Intl options and locales, and the option strings the IR carries.
// The Rust validator re-checks every string with runic-js's parsers (time
// zones, digit ranges and option combinations).
import type { Literal } from './ir.ts';

/** Locales whose formatting and collation are verified against Chromium. */
export const LOCALES = ['en-US', 'en-GB', 'de-DE', 'fr-FR', 'ja-JP'];
/** Language tags verified to behave exactly as one of LOCALES. */
const ALIASES = ['en', 'de', 'fr'];
/** Currencies with verified symbols in every locale. */
export const CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CNY', 'INR', 'CAD', 'AUD'];

/** The verified spelling of a locale tag (BCP 47 tags are case-insensitive). */
export function verifiedLocale(tag: string): string | undefined {
  const lower = tag.toLowerCase();
  return [...LOCALES, ...ALIASES].find(l => l.toLowerCase() === lower);
}

export type IntlKind = 'date' | 'number' | 'collator';

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

const OPTIONS: Record<IntlKind, Record<string, Rule>> = {
  date: DATE_OPTIONS,
  number: NUMBER_OPTIONS,
  collator: COLLATOR_OPTIONS,
};

/** A problem with an option (`key` locates it), or the option string. */
export type SpecResult = { spec: string } | { error: string; key?: string };

/**
 * The option string of an operation: `m=<method>`, the literal locale
 * (absent: the default or a runtime locale) and the given options.
 * Methods: date `d`/`t`/`a` (toLocaleDateString/TimeString/String) and `f`
 * (Intl.DateTimeFormat#format); number `n`/`f`; collator `l`/`c`.
 */
export function intlSpec(
  kind: IntlKind,
  method: string,
  locale: string | undefined,
  options: [string, Literal | undefined][],
): SpecResult {
  const parts = [`m=${method}`];
  if (locale !== undefined) {
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
  return { spec: parts.join(';') };
}
