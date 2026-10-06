// Plural rules and display names as the Translations Editor uses them: the
// plural categories of a target locale for its message selectors
// (MessageComposer's localePluralCategories) and project locale names in
// the UI locale (the page's localeName), both with locales computed at run
// time and a fallback for tags Intl rejects; plus constants with literal
// locales and the other display name types.

export function pluralCategories(locale: string, ordinal: boolean): string[] {
  try {
    return new Intl.PluralRules(locale, ordinal ? { type: 'ordinal' } : undefined).resolvedOptions()
      .pluralCategories;
  } catch {
    return ['invalid'];
  }
}

export function plural(locale: string, ordinal: boolean, n: number): string {
  try {
    return new Intl.PluralRules(locale, ordinal ? { type: 'ordinal' } : undefined).select(n);
  } catch {
    return 'invalid';
  }
}

export function localeName(tag: string, uiLocale: string): string {
  try {
    return new Intl.DisplayNames([uiLocale], { type: 'language' }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

const ordinals = new Intl.PluralRules('en-US', { type: 'ordinal' });

export function nth(n: number): string {
  switch (ordinals.select(n)) {
    case 'one':
      return `${n}st`;
    case 'two':
      return `${n}nd`;
    case 'few':
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

const regions = new Intl.DisplayNames('de', { type: 'region' });
const scripts = new Intl.DisplayNames('en-GB', { type: 'script', fallback: 'none' });
const standard = new Intl.DisplayNames('fr', { type: 'language', languageDisplay: 'standard' });

export function regionNames(codes: string[]): string {
  return codes.map(c => regions.of(c) ?? '?').join(' · ');
}

export function scriptNames(codes: string[]): string {
  return codes.map(c => scripts.of(c) ?? '(none)').join(' · ');
}

export function standardNames(tags: string[]): string {
  return tags.map(t => standard.of(t) ?? '?').join(' · ');
}

/** Currency names in the UI locale, or the default locale for English. */
export function currencyNames(codes: string[], uiLocale: string): string {
  const locale = uiLocale === 'en' ? undefined : uiLocale;
  return codes
    .map(c => new Intl.DisplayNames(locale, { type: 'currency', fallback: 'none' }).of(c) ?? '?')
    .join(' · ');
}
