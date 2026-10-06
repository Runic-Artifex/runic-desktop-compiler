# M6 step 9: the items carried from M5

Measurements behind `Intl.PluralRules`/`Intl.DisplayNames`, React's continuous lane for scroll events and the console reports of unhandled promise rejections (2026-10-05, Chromium 153.0.8010.12 through Playwright 1.63, React 19.3.0, Vue 3.5.43, Svelte 5.57.1). What is implemented is in [CONTRACT](../CONTRACT.md) and [IR](../IR.md); the scratch pages are not kept.

## Intl.PluralRules and Intl.DisplayNames

**What the north star needs.** The Translations Editor calls `new Intl.PluralRules(targetLocale, ordinal ? { type: "ordinal" } : undefined).resolvedOptions().pluralCategories` for any project locale, and `new Intl.DisplayNames([uiLocale], { type: "language" }).of(tag) ?? tag` with the UI locale `en` or `de` and any project tag, both inside `try`/`catch`. So plural rules are needed for every locale, display names for the verified UI locales, both with locales computed at run time.

**Data.**

- *Plural rules* come from Chromium's own ICU data: `icudtl.dat` next to its binary (ICU 78, `icudt78l`), decompiled with `icupkg` and `derb` from the locked nixpkgs. 65 rule sets, 227 locales with plural data (`locales` and `locales_ordinals`), parsed into relations at generation time. Chromium's API exposes only results, not the rules, and ICU4X's `icu_plurals` is not in the offline registry; the ICU data is the exact source.
- *Display names* are read through `Intl.DisplayNames` with `fallback: "none"` for every region (two letters, three digits), script (four letters), currency (three letters) and language (two or three letters) code, in en-US, en-GB, de-DE, fr-FR and ja-JP; en, de, fr and ja give identical tables and are aliases. Chromium's ICU data is trimmed (about 170 language names in English). Dialect names exist only for two-part keys (`en_US`, `zh_Hans`); the generator checks there are no three-part keys in any `lang/*.res`.
- *Size:* `locale_data.rs` is 137 KB of source: 2,689 strings and the tables. The data is static and reachable only from the new built-ins, so programs that do not use them do not link it.

**Behaviour found on the way** (each is in the vectors):

- ICU evaluates the keywords in resource order with `other` last; `=` requires an integer operand before the modulus (`n % 10 = 1` is false for 21.5); the number is first rounded to three fraction digits on its shortest digits, so `select(1.0005)` sees 1.001 and `select(0.0004)` sees 0; `i` keeps only the lowest 18 integer digits (`toLong(true)`), so French `select(1e21)` is `one`.
- The locale resolves by ECMA-402's lookup over the locales with plural data, else the default locale: `tlh` and `xx` get the default locale's rules, `pt-Latn-PT` gets `pt` (not `pt-PT`), `zh-Hant-TW` gets `zh`.
- V8 canonicalizes locale arguments and `DisplayNames#of` codes differently: `getCanonicalLocales("bh")` keeps `bh`, `new Intl.Locale("bh")` and `of("bh")` use `bho`; `jaw` becomes `jv` through ICU's legacy table, not its alias metadata; `sgn-NO` becomes `nsl` although `metadata.res` says `nsi`. The generator therefore reads the language aliases of both kinds from Chromium; regions that alias several regions (`SU`, `AN`, `YU`) depend on the language's likely region and are reported unsupported in tags.
- `of()` for regions and scripts is case-sensitive (`us` has no name and falls back to `us`); currencies are not (`usd` is US Dollar); the empty string is a valid script code (no name).
- Language names follow ICU's `LocaleDisplayNamesImpl`: with both a script and a region, the two-part dialect keys are looked up on a buffer that still holds the three-part key, so `zh-Hans-CN` is "Chinese (Simplified, China)" while `zh-Hans` is "Simplified Chinese"; parentheses inside the qualifiers become brackets ("English (Myanmar [Burma])"); `und` is named `root`.

**Vectors:** `tests/vectors/intl-locales.json` (2.1 MB): 36,019 `select`, 4,828 `pluralCategories` and 16,057 `of` cases, every one matched by `runic_js`; 349 of them (140, 30 and 179) use variants, extensions or ambiguous region aliases and are checked to be reported unsupported.

## React's continuous lane for scroll events

Scratch React page through the harness on the real clock, logging from the scroll listener, its microtasks, an animation frame callback, a `MessageChannel` message and a 0 ms timer posted by the listener, layout and passive effects, a MutationObserver and a ResizeObserver:

- `scroll handler`, `microtask` (old DOM), `raf after scroll` (old DOM), `message` and `timeout` posted by the listener (old DOM), then React's render (`layout effect`, `mutation`), its passive effects (after a microtask checkpoint), and the ResizeObserver in the next frame. The update renders in a scheduler task after the frame; a timer the listener posts runs before it.
- A click dispatched in the animation frame callback after the scroll (before the scheduler task) renders the scroll update with its own, in its microtask, and runs its passive effects before the microtask after the click (React's sync lane takes the pending continuous and default lanes).
- A focused input disabled by a key press that also scrolls: in the following frame the focus fixup's `blur` (Chromium's style update starts a 0 ms timer for it) and React's scroll render (a message delivered through a message pipe) race. Standalone runs put the render first in 18 of 18 runs, then the blur, whose update renders in its microtask after React flushed the pending passive effects; the conformance harness's runs put the blur first, with one render of both. The order is not stable, so no case uses it; the runtime takes the first (tasks in the order they were posted).

The native runtime defers default-priority tasks queued inside a frame (rendering step, layout, ResizeObserver) to the end of the frame, runs the focus fixup as a task after those queued before it, and moves a pending default-priority flush into the microtask queue when a discrete event writes state while it is dispatched. The probe lays the page out before measuring a step, as the harness's layout reads force a layout.

**Not modelled:** a timer posted by a scroll listener (rejected); timers due at the same instant, which Chromium runs back to back before the tasks they queue (React's renders, rejection reports), while the runtime runs each timer's default tasks before the next timer (an existing limit, not observable in the harness's fake clock: see below).

## Unhandled promise rejections

CDP `Runtime.exceptionThrown` gives `text` `Uncaught (in promise)` and the error's description (`TypeError: async failure` and its stack); Playwright reports the same as `pageerror`, which the harness treated as a harness error until M6.

- Real clock: the report comes after the task's console lines and microtasks, and after a `MessageChannel` message the task (or its microtasks) posted: Chromium posts a report task at the end of each microtask checkpoint with the rejections it left (HTML's "notify about rejected promises"), which reports those still without a handler when it runs. A message posted from inside a message handler runs after that handler's report.
- A rejection handled in a later microtask is not reported; handled in a later task it is reported, then revoked (`Runtime.exceptionRevoked`).
- Several rejections are reported in rejection order (`Promise.reject` before the rejection a `then` callback makes in a microtask).
- An empty message reports `Error`. Two timers due at the same instant both run before either report (t1, t2, report t1, report t2); 10 ms apart, each report follows its timer.
- Playwright's fake clock runs each due timer in a task of its own after a real `setTimeout(0)`, posted before the timer's report task, so with timers due in one `runFor` a report follows the next timer's callback (unlike the real clock). Cases keep rejecting timers apart.
- Vue's `callWithAsyncErrorHandling` catches a promise a listener returns and logs it with `console.error(err)` from Vue's code (with the stack), which the harness reports as a framework console error; no unhandled rejection is reported.
