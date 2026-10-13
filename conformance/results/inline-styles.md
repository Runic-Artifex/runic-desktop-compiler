# Inline styles under the CSS contract (2026-10-13)

CSS compatibility slice 1b. Until now the compiler checked stylesheets only: `<div style="position: sticky; text-shadow: 1px 1px red">` built without a diagnostic (checked with `analyze`), and a declaration Stylo drops in an inline style vanished silently, also where Chromium applies it. No fork change.

## The rules

`runic_css::inline::problems` applies, to the declarations of one inline style and its element, the declaration checks `compiler/collect.mjs` gives stylesheet declarations (its tables mirror collect.mjs's):

- **Rejected where literal** (a stylesheet rejects these wherever its rule may apply): fill modes `forwards`/`both`, scroll-driven animation properties, `allow-discrete`, filter functions the renderers do not draw (`url()`), images in `content` (on an element Chromium uses only those), `text-transform: full-width`/`full-size-kana`, SVG paint servers and SVG-only properties. The validator (`runic-ir` `inline_style_check`) gives `E_CSS_PROPERTY` at the element for a literal `style` attribute, style text or style property (Svelte, Vue, React).
- **Reported when set** (a stylesheet gives a style guard): a declaration Stylo drops that Chromium 153 parses, unless verified equivalent (the `EQUIVALENT_*` tables, `resize`) or overridden later in the same style; `-moz-box-orient`; `text-shadow`; `text-wrap: balance`/`pretty` on a text area; `field-sizing: content` on a select or a search, number, password or file input. The runtime (`Dom::check_inline_style`, at every write of the `style` attribute and before the CSSOM composes a style value and its properties, which drops what Stylo does not parse) and the reference interpreter report each once.
- **Values known only at run time** are reported when set, whatever their kind.

A declaration of a property Chromium 153 does not parse is an equivalent drop: `crates/runic-css/src/chromium-properties.txt` lists the 722 of the 794 names of Blink's css_properties.json5 (at 153.0.8010.12, without `-internal-` ones) for which `CSS.supports(name, "inherit")` holds in the harness's Chromium (`node conformance/chromium-properties.mjs <css_properties.json5> <css_value_keywords.json5>` reproduces it byte for byte). collect.mjs's `chromiumDrops` reads the same file, so stylesheets no longer report such declarations either (before: only `-moz-`, `-o-` and `-ms-` names). This is what keeps Vue's `styles-vue` fixture (a `p-a-d-d-i-n-g` key, which both engines drop) passing.

## Correction (94fc642)

0aded01 reported every declaration Stylo drops whatever Chromium does with it, and bits-ui's floating layer spreads `z-index: undefined`: bits-popover, bits-select and bits-tooltip stopped at mount (6 runs), although Chromium drops that value too. A drop is now equivalent only where Chromium is shown to drop the declaration as well: a property it does not parse, or a value of one identifier that it accepts neither as a keyword of the property nor as a custom ident. `conformance/chromium-properties.mjs` measures that table too (`crates/runic-css/src/chromium-keywords.txt`, 389 properties since Stylo parses `-webkit-text-fill-color` and `background-clip: text` (slice 2): per property, whether Chromium accepts any identifier, and the Blink keywords of css_value_keywords.json5 it accepts where Stylo drops them, or all it accepts where Stylo parses no value of the property), with Stylo's verdicts from `runic_css::check`. Other values Stylo drops (functions, numbers, several tokens) are still reported. The stylesheet checks use the same table.

## Correction (longer values)

The full differential found bits-progress-svelte stopping in 4 of 20 random traces: its indicator's `style="transform: translateX(-{100 - (100 * (value ?? 0)) / (max ?? 1)}%)"` becomes `translateX(--25%)` past the maximum, which Chromium drops too, but 94fc642 decided only single identifiers. Longer values are now decided by a second measured table, `crates/runic-css/src/chromium-grammar.txt` (`node conformance/chromium-grammar.mjs <bootstrap.css>`):

- **Corpus.** The style-rule declarations of Bootstrap 5.3.8 and of every stylesheet under fixtures/ and examples/ (values with `var()`, `env()` or `attr()`, and single identifiers, left out), and each value with one number at a time replaced by what JavaScript string building makes of a number: a written minus before it (`-25%` becomes `--25%`), `NaN`, `undefined`, `null`, `Infinity`. 6082 samples.
- **Agreement.** Each sample is checked with `CSS.supports` in the harness's Chromium and with Stylo. A property where the engines agree on every one of at least 20 samples is listed with its vocabulary: the function names, units and identifiers its samples use (47 properties, among them `transform`, `width`, `height`, `margin`, `padding`, the insets, `background*`, `border*`, `box-shadow`, `filter`, `transition`, `animation`, `font-size`, `z-index`). Properties where they disagree (vendor aliases Stylo lacks) are listed as comments.
- **Decision.** A value Stylo drops is an equivalent drop where its property is listed and every function, unit and identifier of the value (cssparser's tokens, the CSS Syntax tokenizer Blink also implements; `compiler/css-vocabulary.mjs` in JavaScript) occurs in the property's vocabulary; identifiers that are number artifacts (`--25`, `NaNpx`, `undefined`, `null`) count as one class, which the mutated samples cover. Anything else Stylo drops is reported: a function Stylo lacks (`calc-size()`, `anchor-size()`, `if()`), a unit or keyword outside the corpus, any property outside the table. This is measured agreement over the corpus's vocabulary, not a proof for every combination of it; the remaining risk is a combination of known words in a position where only one engine accepts them.

## Verification

- `tests/inline-styles.test.mjs`: literal rejections in Svelte attributes and directives; reports of static, dynamic (a directive set to `forwards` on a click) and React style-object declarations; equivalent declarations neither rejected nor reported. `runic-css` unit test `inline_declarations_get_the_stylesheet_checks`.
- Every fixture and example (240 that lower) mounted in the interpreter with each case's actions: no inline style report after the Chromium property list (before it, only `styles-vue`'s `p-a-d-d-i-n-g`).
- `npm test` and `node compiler/cargo.mjs test --offline --workspace`.

## Left open

Values through `var()` are checked as written; `text-wrap` in an inline style of a text area's ancestor and inline `scroll-margin`/`scroll-padding` (reported when set, where stylesheet guards wait for a scroll) are recorded in [gaps](../../docs/gaps/PLATFORM.md#css-and-rendering-p4).
