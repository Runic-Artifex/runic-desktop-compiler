# Bootstrap 5.3 CSS survey (2026-10-13)

Slice 0 of the CSS compatibility workstream: what the compiler's CSS checks say about Bootstrap's compiled stylesheet. Bootstrap 5.3 is planned future scope ([ROADMAP](../../docs/ROADMAP.md#decisions-log)); nothing here is supported yet.

**Input.** `bootstrap@5.3.8` (npm `latest`, the newest 5.3.x), tarball `https://registry.npmjs.org/bootstrap/-/bootstrap-5.3.8.tgz`, sha256 `8b02d4a7482e0f0a2b1da58f1c9c86830e96cc2f77f094f89e4681b19886bc38` (npm integrity `sha512-HP1SZDqa…f0Ee+tg==` and shasum `6401a100…0656aeed` match). Surveyed file: `dist/css/bootstrap.css`, 280311 bytes, sha256 `4a50207b956a4ab943640ee993118b554a34e96a23261cfe58b9aa1807a7849b`: 2556 style rules, 5543 declarations. The RTL, grid-only, reboot-only and utilities-only builds are subsets or mirrors of it and were not surveyed separately. Bootstrap's JavaScript is out of scope.

**Method.** The stylesheet went through the checks a plain-CSS module gets in `compiler/collect.mjs` at `543b3b5` (`checkRules`, the `url()` rule, `checkWithStylo` with the Stylo oracle `runic_css::check`), with each rejection recorded instead of stopping at the first. The D17 proof (rules no element can match) is not applied: it depends on an app's elements, and a Bootstrap page may use any class. Stylo's raw verdict on every declaration and rule was recorded beside the compiler's decision. The data was treated as untrusted and never executed.

## Findings by cause

Status: **build** = rejected when met; **rule** = rejected unless no element can match the rule (D17); **run time** = a style guard reports the app unsupported where the rule matches; **equivalent** = accepted silently as having Chromium's effect.

| Cause | Count | Where in Bootstrap | Status | Slice |
|---|---|---|---|---|
| `@charset "UTF-8"` (line 1) | 1 | the stylesheet's first rule | build (`E_CSS`): the whole stylesheet is rejected | 0b |
| `url("data:image/svg+xml,…")` | 23 (19 in custom properties) | `.form-select`, `.form-check-input` (checked, indeterminate), `.form-switch`, validation icons, `.navbar-toggler-icon`, `.accordion-button::after`, `.btn-close`, carousel controls | build (`E_ASSET`: data URLs) | 7 |
| `:valid` / `:invalid` | 26 rules | `.was-validated …:valid/:invalid` (form validation feedback) | rule (`E_CSS`: the runtime does not maintain validity) | 7 (forms) |
| `position: sticky` | 13 | `.sticky-top`, `.sticky-bottom`, `.sticky-{sm…xxl}-{top,bottom}` | rule (`E_CSS_PROPERTY`) | 1 |
| `content: counters(section, ".") ". "` with `counter-reset`/`counter-increment` | 1 | `.list-group-numbered > .list-group-item::before` | rule | 4 |
| `-webkit-margin-end` in `::file-selector-button` rules | 3 rules | `.form-control{,-sm,-lg}::file-selector-button` (the standard `margin-inline-end` follows) | rule | 0b |
| Vendor declaration Stylo drops, followed in the same rule by its standard form | 108 | `-moz-column-gap` (36, `.column-gap-*`), `-o-object-fit` (30, `.object-fit-*`), `-webkit-text-decoration-color` (28, `.link-*`, `!important`), `position: -webkit-sticky` (13), `width: -webkit-max-content` (`.toast-container`) | run time | 0b |
| `print-color-adjust`, `-webkit-print-color-adjust`, `color-adjust` | 3 | `.form-check-input` | run time | 0b |
| `-moz-appearance` | 4 | `.form-select`, `.form-check-input`, `.form-range`, `.form-control` (`appearance: none` follows) | run time | 0b |
| `text-align: -webkit-match-parent` | 1 | `th` (after `text-align: inherit`) | run time | 7 |
| `word-break: break-word` | 1 | `.text-break` (Chromium: `overflow-wrap: anywhere`) | run time | 7 |
| `text-decoration-skip-ink: none` (and `-webkit-`) | 2 | `abbr[title]` | run time | 7 (Blitz never skips ink; Chromium's default `auto` does) |
| `@media (prefers-reduced-motion: no-preference)` | 1 | `:root { scroll-behavior: smooth }` | **equivalent, wrongly** (below) | 0b, then 6 |
| `@media (prefers-reduced-motion: reduce)` | 31 | transitions and animations switched off | equivalent (false in Chromium, measured) | — |
| Vendor pseudo-elements and pseudo-classes (`::-webkit-*`, `::-moz-*`, `:-moz-focusring`, `:-webkit-autofill`) | 33 rules | reboot and form controls | equivalent (no such parts in Blitz) | — |
| `-webkit-text-size-adjust`, `-webkit-tap-highlight-color`, `-webkit-overflow-scrolling` (6), `-webkit-text-decoration`, `resize` | 10 | reboot, `.table-responsive`, `.modal`, `textarea` | equivalent (existing table) | — |

## Defects found in the compiler's classification

- **`prefers-reduced-motion: no-preference` is dropped as equivalent.** `EQUIVALENT_DROPPED_RULE` matches every `(prefers-reduced-motion`, `(prefers-contrast` and `(forced-colors` query, on the claim that Chromium's default makes them false. In Chromium 153.0.8010.12 (harness, headless, measured) `(prefers-reduced-motion: no-preference)`, `(prefers-contrast: no-preference)` and `(forced-colors: none)` all match: Bootstrap's `:root { scroll-behavior: smooth }` applies there and is silently lost natively. Tailwind's `motion-safe:` variant compiles to the same query. Stylo (servo mode) does not know these media features.
- **Equivalent drops that are reported.** 108 vendor declarations are followed in the same rule by the standard declaration Stylo parses. Chromium either does not parse the vendor form or treats it as an alias that the later declaration overrides, so dropping it changes nothing; the compiler's `overriding` check looks only at later rules, not at later declarations of the same rule. Each is a run-time report on a common utility class (`.column-gap-*`, `.object-fit-*`, `.link-*`, `.sticky-*`).
- **`@charset` is rejected**, although for a UTF-8 stylesheet it has no effect in Chromium (Stylo ignores it too: it is not among Stylo's drops).

## Not detected by the checks

The checks see only what Stylo drops or the compiler rejects. Grepping the pinned Blitz fork (`a12c37e3`) for each longhand Bootstrap uses found one property that Stylo parses and Blitz never paints: **`text-shadow`**. It is read only for hit testing (`inline_hit.rs`), and the compiler neither rejects nor reports it. Bootstrap uses only `text-shadow: none` (and one in a dropped `-moz` rule), so it does not matter here, but any other value is a silent approximation today. `backface-visibility: hidden` (carousel) has no effect without 3D transforms, which Blitz does not draw. `counter-reset`/`counter-increment` are unread, covered by the `content` rejection.

## Consequences for the slice order

- Slices 1–6 stay as planned. Bootstrap adds evidence for slice 1 (13 `sticky-*` utilities, besides the shadcn-svelte site header, sidebar, table of contents, sticky table headers and the dialog sticky footer), slice 4 (`counters()`) and slice 6 (smooth scrolling through `prefers-reduced-motion: no-preference`).
- **New slice 0b, before slice 1:** the three classification defects (a silent approximation and two over-reports) and a guard for `text-shadow`. These are compiler changes plus the three media features in the Stylo fork, evaluated as in the harness's Chromium. With them and slice 1, a Bootstrap stylesheet is no longer rejected at the first line, and the remaining blockers are its data-URL SVG icons and validation states.
- **Slice 7 (breadth) gains, with Bootstrap evidence:** SVG `data:` URLs as background images (form controls, accordion, close button, navbar toggler, carousel: 23 declarations); `:valid`/`:invalid` (26 rules); `text-align: -webkit-match-parent`, `word-break: break-word`, `text-decoration-skip-ink`.
