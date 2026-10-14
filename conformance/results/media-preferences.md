# Media queries on user preferences (2026-10-13)

CSS compatibility slice 0b, from the [Bootstrap 5.3 survey](bootstrap-5.3-css-survey.md). Two fork commits:

- Stylo `3a2013ca` *servo: Evaluate prefers-reduced-motion, prefers-contrast and forced-colors* (branch `media-defaults` on `runic` `6d580873`);
- Blitz `c8760598` *Let the embedder set the reduced motion and contrast preferences media queries see* (branch `media-preferences` on `runic` `a12c37e3`).

Case `media-preferences` (fixture `media-preferences-svelte`, no Tailwind), Chromium 153.0.8010.12, CPU renderer, 800x600 and 420x600.

## What was wrong

Stylo's servo mode knew none of the three features, so every query naming one was invalid and its rules never applied. The compiler accepted the drop as equivalent (`EQUIVALENT_DROPPED_RULE`), on the claim that Chromium's defaults make these queries false. That holds for `reduce`, `more` and `active`, but `(prefers-reduced-motion: no-preference)`, `(prefers-contrast: no-preference)` and `(forced-colors: none)` match in the harness's Chromium (measured). Bootstrap's `:root { scroll-behavior: smooth }` and Tailwind's `motion-safe:` rules were silently lost.

## Chromium's rules

- `forced-colors` is `none` on Linux: `OsSettingsProvider::ForcedColorsActive` is false there, and only the `--force-high-contrast` switch forces colors (ui/native_theme at 153.0.8010.12).
- `prefers-reduced-motion` is `reduce` when GTK's `gtk-enable-animations` is off (ui/gfx/animation/animation_linux.cc); `prefers-contrast` is `more` for a GTK theme whose name contains "high" and "contrast" (ui/gtk/os_settings_provider_gtk.cc). Without a desktop UI (the harness's headless Chromium) both are `no-preference`.
- Boolean forms: `(prefers-reduced-motion)` matches `reduce`, `(prefers-contrast)` anything but `no-preference`, `(forced-colors)` anything but `none`.

## The change

The Stylo device carries the two preferences (no preference unless the embedder sets them) and evaluates `forced-colors` from `Device::forced_colors` (`none`). Blitz exposes `BaseDocument::set_media_preferences`. The runtime sets them from what its queries see: a probe's emulated preferences (Playwright's `emulateMedia`, the case's `emulate` actions), otherwise none. A native app cannot read the desktop's settings, so the compiler gives every rule under a query on `prefers-reduced-motion` or `prefers-contrast` a guard that reports it natively once it matches an element (`when: "native"`; keyframes and other at-rules inside: at once), and the runtime reports `matchMedia` of such a query natively.

## Verification

- The case passes semantics, geometry and pixels at both viewports (`node conformance/run.mjs media-preferences --pixels`): nine boxes sized by the queries, without a preference, with reduced motion, with more contrast, and without both again.
- At the old pins (compiler `7bf23d7`, Stylo `6d580873`, Blitz `a12c37e3`), with the fixture's `@charset` line removed (that compiler rejects it), it fails geometry and pixels at both viewports: the `no-preference`, `none` and `not … reduce` rules never apply natively.
- Blitz's unit test `user_preference_media_queries` covers the features with values, without them, and after a change.
- `npm test` (472 tests) and `node compiler/cargo.mjs test --offline --workspace` pass; Blitz `blitz-dom` with the Stylo branch passes 172 tests, failing only the known `hover_styles_apply_and_clear` and `scroll_by_clamps_and_bubbles`.
- The same slice makes the compiler accept `@charset "UTF-8"`, stop reporting vendor declarations Chromium drops or that a later declaration of their rule overrides, and report `text-shadow` (Blitz paints none). Bootstrap 5.3.8's stylesheet is no longer rejected at its first line; its 108 vendor-fallback reports are gone, and its 31 `prefers-reduced-motion` rules are native-only reports.

Since CSS slice 2b a native app reads both preferences from the desktop as Chromium does and reports only those it cannot read: [desktop-preferences](desktop-preferences.md).
