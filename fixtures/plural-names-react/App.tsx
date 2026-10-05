import React, { useState } from 'react';
import {
  currencyNames,
  localeName,
  nth,
  plural,
  pluralCategories,
  regionNames,
  scriptNames,
  standardNames,
} from './intl.ts';

const TARGETS = ['en', 'de-AT', 'pl', 'ar', 'pt-PT', 'pt-BR', 'fr-CA', 'zh-Hant-TW', 'cy', 'sr-Latn', 'iw', 'tlh', 'en_US'];
const UI = ['en', 'de', 'fr-FR', 'en-GB'];
const COUNTS = [0, 1, 2, 3, 5, 11, 21, 22, 23, 101, 1.5, 0.0005, 1000000];

export function App() {
  const [target, setTarget] = useState(0);
  const [ui, setUi] = useState(0);
  const [ordinal, setOrdinal] = useState(false);
  const locale = TARGETS[target];
  const uiLocale = UI[ui];
  const selected = COUNTS.map(n => `${n}: ${plural(locale, ordinal, n)}`).join(' · ');
  return (
    <main>
      <p id="target">
        {locale} · {localeName(locale, uiLocale)} · {ordinal ? 'ordinal' : 'cardinal'}
      </p>
      <p id="categories">{pluralCategories(locale, ordinal).join(', ')}</p>
      <p id="select">{selected}</p>
      <ul id="names">
        {TARGETS.map(t => (
          <li key={t}>
            {t}: {localeName(t, uiLocale)}
          </li>
        ))}
      </ul>
      <p id="nth">{COUNTS.slice(0, 10).map(nth).join(' ')}</p>
      <p id="regions">{regionNames(['US', 'GB', 'CD', '419', 'DE', 'XK', 'ZZ', '001', 'us'])}</p>
      <p id="scripts">{scriptNames(['Latn', 'Cyrl', 'Hans', 'Hrkt', 'Zzzz', 'Qaaa'])}</p>
      <p id="standard">{standardNames(['en-US', 'zh-Hans', 'sr-Latn-RS', 'xx-CD', 'de-AT'])}</p>
      <p id="currencies">{currencyNames(['EUR', 'usd', 'JPY', 'CHF', 'XAU'], uiLocale)}</p>
      <div className="row">
        <button id="next" onClick={() => setTarget((target + 1) % TARGETS.length)}>
          Next locale
        </button>
        <button id="ordinal" onClick={() => setOrdinal(!ordinal)}>
          Ordinal
        </button>
        <button id="ui" onClick={() => setUi((ui + 1) % UI.length)}>
          {uiLocale}
        </button>
      </div>
    </main>
  );
}
