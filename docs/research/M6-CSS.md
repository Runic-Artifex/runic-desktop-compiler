# M6 research: Tailwind 4 output on Stylo and Blitz

Can the Translations Editor's plugin-generated CSS be accepted? This report checks every feature in that CSS against the pinned Stylo and the Blitz fork. Done 2026-10-04 for the M6 CSS pipeline ([roadmap](../ROADMAP.md#m6-libraries-css-pipeline-sveltekit-islands)).

**Versions.**
- Stylo 0.22.0 (`servo` feature) with Blitz's prefs.
- Blitz fork `runic` at `5f083d6`.
- Tailwind CSS and `@tailwindcss/vite` 4.3.3, Vite 8.3.2, Svelte 5.57.1.
- Reference browser: the conformance Chromium 153.0.8010.12.

## Summary

- **Already works.** Most of the output needs no lowering:
  - `@layer` and `@property` (registered initial values included);
  - `@supports`, custom properties and `var()` fallbacks (empty ones too);
  - `calc`, `oklch`, `color-mix`, nesting and range media queries.

  Stylo parses, cascades and computes all of them, and Blitz paints the result. Tailwind's design depends on `@property`: `.border` gets `border-style: solid` only through the registered initial value of `--tw-border-style`. Stylo implements this in servo mode, as verified below.
- **Breaking gaps:**
  - `:has()` is disabled in Stylo by default and Blitz does not enable it. Of the 71 rules that contain `:has()`, 60 are dropped at parse time and 11 never match. They include the shadcn button and icon paddings (`has-data-[icon=inline-end]:pr-2`).
  - `@container` is gecko-only in Stylo (4 rules).
  - Several properties have no effect: `text-overflow: ellipsis` (`truncate`, 22 uses in the editor), `field-sizing`, `line-clamp`, `text-wrap: balance`/`pretty`, and `filter`/`backdrop-filter` in the CPU renderer.
  - `:focus-visible` behaves like `:focus` in Blitz.
- **Fonts.** `@fontsource-variable/inter` declares `format("woff2-variations")`. Blitz skips that source when its URL is a `data:` URL, and the collector inlines fonts as `data:` URLs. Rewriting the hint to `woff2` at build time fixes it.
- **Time.** Stylo animates and Blitz drives `transition`/`animation` from `resolve(time)`, but they are time-based. They appear in 21 rules (transitions) and 9 rules (animations), and the compiler still rejects them (M10). The editor's screens cannot be compiled without a decision here.
- **Compiler direction.** Accept `@layer`, `@property` and `@supports`. Run Stylo as a build-time oracle: every rule or declaration that Stylo drops becomes a diagnostic, except an allow-list of drops verified to be harmless. Keep a short manual list of properties that Stylo computes but Blitz ignores. No `@layer` flattening or `@property` resolution is needed.

## Method

**CSS.** The editor's `build/` output (Oct 1) predates source changes made on Oct 4, so it is stale. Instead:
- The Git-visible files of `apps/translations-editor/Frontend` were copied to `.cache/m6-css/editor`.
- `node_modules` there is a directory of per-package symlinks into the SDK's installed packages, so no file was written into the SDK.
- `vite build` ran there with `build.minify: false`, as the collector builds.
- No file in the editor directory changed during the run. The SDK's `git status` changed only through unrelated commits made meanwhile.

The build produced two stylesheets:
- `layout.css` (136.8 KB): Tailwind and the layout's own CSS;
- `page.css` (24.7 KB): Svelte component styles and bits-ui styles.

They are kept in `.cache/m6-css/`.

What reaches the collector depends on Tailwind's build-time `optimize` step. In `@tailwindcss/node` 4.3.3 it runs Lightning CSS with these settings:
- `include: Nesting | MediaQueries`;
- `exclude: LogicalProperties | DirSelector | LightDark`;
- targets Safari 16.4, Chrome 111 and Firefox 128.

So nesting and range media queries are lowered, and `oklch`, `color-mix` and logical properties stay. `optimize` defaults to on for builds and is independent of `minify`.

**Checks.**
- An inventory script (`inventory.mjs`, postcss).
- A scratch binary (`.cache/m6-css/probe`) linked against the same Stylo and Blitz, with Blitz's prefs set as in `blitz-dom/src/document.rs:397-405`. It:
  1. parses each sheet with a `ParseErrorReporter`;
  2. parses all 865 unique declarations one by one. Stylo hides unknown non-Mozilla vendor properties from the reporter (`properties/declaration_block.rs:1714-1722`);
  3. loads a Blitz document with the editor CSS plus 47 probe elements and prints computed values;
  4. loads the Inter subsets as `@font-face` and measures text.
- `CSS.supports`, `matchMedia` and `:focus-visible` in the conformance Chromium.
- Source reading, cited below.

There was one probe build (incremental rebuilds included), serialised through `target/.runic-build.lock`.

## Inventory

| | `layout.css` | `page.css` |
|---|---|---|
| Rules / declarations | 1,005 / 1,916 | 166 / 582 |
| Custom-property declarations | 535 | 0 |
| `!important` | 18 | 14 |
| Nested rules, `&` | 0 (lowered) | 0 |
| `@property` | 83 (74 `syntax: "*"`, 4 `<length-percentage>`, 3 `<percentage>`, 1 `<length>`, 1 `<angle>`; 38 with `initial-value`; 1 `inherits: true`) | 0 |
| `@supports` | 52: 49 × `(color: color-mix(in lab, red, red))`; 1 × the `@property` fallback test (`-webkit-hyphens`/`margin-trim`/`-moz-orient`/`rgb(from …)`); 1 × `not (-webkit-appearance: -apple-pay-button) or (contain-intrinsic-size: 1px)`; 1 × `(backdrop-filter: var(--tw))` | 0 |
| `@media` | 22: `(hover: hover)` 7; `min-width` 10 (40/48/64/80/96 rem, 360 px); `forced-colors` 2; `prefers-reduced-motion` 2; `prefers-contrast` 1 | 2 (`min-width` px) |
| `@layer` | 5: `properties`, `theme`, `base`, `components` (statement), `utilities`; no unlayered rule precedes a layered one | 0 |
| `@font-face` | 7 (Inter Variable: 7 `unicode-range` subsets, `font-weight: 100 900`, `format("woff2-variations")`) | 0 |
| `@container` | 4 (`field-group (min-width: 28rem)`), plus 2 `container:` declarations | 0 |
| `@keyframes` | 4 (`spin`, `pulse`, `enter`, `exit`) | 1 |
| Not present | `@theme`/`@apply`/`@custom-variant` leftovers, `@starting-style`, `@scope`, `@import`, `light-dark()`, `env()`, relative colours in values (only inside `@supports`) | |

**Selectors** (`layout` + `page`):
- logical pseudo-classes: `:where()` 185+79, `:is()` 171, `:not()` 48+7, `:has()` 74 (in 71 rules);
- interaction states: `:hover` 36+8, `:focus-visible` 25+6, `:focus` 11+1, `:focus-within` 5, `:disabled` 6+5, `:active` 3;
- tree-structural pseudo-classes: `:first-child`/`:last-child`/`:nth-*`;
- shadow DOM: `:host` 3;
- pseudo-elements: `::file-selector-button` 11, `::placeholder` 4, `::backdrop` 2, `::selection` 1, `::-webkit-*` 17+3, `:-moz-*` 2;
- other: 441 attribute selectors (`[data-state="open"]`, `[data-open]:not([data-open="false"])`, 7 × `*=`), 148 universal selectors, 64 combinators.

**Values:**
- `var()` 1,016+186, of which 195 have a fallback (often empty: `var(--tw-ring-inset, )`);
- `calc()` 339+1, `oklch()` 244;
- `color-mix()` 49 `in oklab` (layout), and 32 `in oklch` and 1 `in oklab` (page);
- 35 hex colours with alpha, `minmax`/`repeat` 27;
- `min()`/`clamp()` 5 (page);
- units `svh` 4, `lh` 1, `ch` 2, `fr` 41.

**Properties:** 168 distinct in `layout.css` and 79 in `page.css`. Notable ones:
- time-based: `transition-*` in 20+1 rules, `animation*` in 8+1 rules;
- effects: `box-shadow` 26+5, `translate` 19, `rotate` 3, `filter` 4+2, `backdrop-filter` 2;
- `fill` 1 (`.fill-foreground`, an SVG paint property the collector already rejects).

## Results per feature

Stylo results come from the probe unless a source location is given. "Works" means parsed, computed and used by Blitz.

### At-rules

| Feature | Stylo 0.22 (servo) | Blitz | Class | Compiler |
|---|---|---|---|---|
| `@layer` | Parsed and ordered (`stylist.rs:4311-4324`). Verified: an unlayered rule beats a later layered one; `@layer a, b` orders b above a; layered `!important` beats unlayered `!important` | n/a | works | accept; no flattening needed |
| `@property` | Enabled by default (`layout.css.properties-and-values.enabled = true`; gate at `stylesheets/rule_parser.rs:291`); registered in `stylist.rs:4138`; initial values seeded into every cascade (`stylist.rs:927-970`, `properties/cascade.rs:1638`). Verified: `.border` gives `border-top-style: solid`; `.shadow-sm` and `.ring-2` resolve the full `--tw-*` chain; `--tw-ring-offset-width` is `0px`; a `<length>` initial value applies | n/a | works | accept; no build-time resolution needed |
| `@supports` | Each declaration test is parsed in servo mode (`stylesheets/supports_rule.rs:398-408`). The four conditions in the CSS evaluate to true, false, true, true, the same as Chromium 153. The false one guards Tailwind's fallback for browsers without `@property`, which Stylo has | n/a | works | accept these; for other conditions see the oracle below (Stylo's answer is wrong for properties it lacks, e.g. `field-sizing`) |
| `@media` widths, `hover`, range syntax | 15 servo media features (`servo/media_features.rs:163`); hover defaults to `FINE \| HOVER` on desktop; `(width >= 40rem)` verified | n/a | works | accept (already) |
| `@media` `forced-colors`, `prefers-contrast`, `prefers-reduced-motion` (5 rules) | Not servo features: `MediaQueryExpectedFeatureName`, so the query never matches | n/a | parsed as never | accept with a stated assumption: Chromium's defaults are also false (verified). *Corrected 2026-10-13:* that holds for queries testing a preference (`reduce`, `more`, `active`), but `(prefers-reduced-motion: no-preference)`, `(prefers-contrast: no-preference)` and `(forced-colors: none)` match in Chromium 153, and Stylo dropped them too. The Stylo fork evaluates the three features since ([BLITZ-GAPS](../BLITZ-GAPS.md)). Native apps read these OS preferences as Chromium does since CSS slice 2b ([results](../../conformance/results/desktop-preferences.md)) |
| `@container`, `container:` | The rule is parsed only `if cfg!(feature = "gecko")` (`rule_parser.rs:285`); `container` is an unknown property; `layout.container-queries.enabled = false` | `query_container_size` is a stub (`blitz-dom/src/stylo.rs:1210`, "FIXME: Implement container queries") | unsupported in servo, Blitz gap | reject (`E_CSS`). Support needs a Stylo patch and container sizes in Blitz |
| `@keyframes`, `animation*`, `transition*` | Parsed and run by Stylo's servo animation code | Blitz keeps a `DocumentAnimationSet` (`document.rs:237`) and advances it in `resolve(current_time)`; it re-renders while animations are active | works, time-based | rejected today (M10). Decision needed for M6, see below |
| `@font-face` | Parsed; `format("woff2-variations")` is kept as an unknown string | `fetch_font_face_rules` (`blitz-dom/src/net.rs` ~405-500) maps only the strings `woff2`/`ttf`/`otf`, then falls back to the URL's extension. A `data:` URL has none, so the source is skipped (verified: text renders 0 px wide). It also ignores `unicode-range`, registers a weight range as its first value (`100`), and fetches only top-level `@font-face` rules | Blitz gap | lower `woff2-variations` to `woff2` after checking the `wOF2` magic, or patch the loader to sniff bytes. Reject `@font-face` nested in other rules |

**Fonts, verified.** All 7 Inter subsets under one family give the same text widths as the Latin subset alone: 334 px at weight 400 and 348 px at 700; 315 vs 316 px at 100. Variable weights apply. The missing `unicode-range` and the single weight are therefore harmless for Latin text. Other scripts are untested.

### Selectors

| Feature | Stylo | Blitz | Class | Compiler |
|---|---|---|---|---|
| `:is`, `:where`, `:not` lists, attribute selectors, combinators, `:root`, `:host` | Supported (`servo/selector_parser.rs:593`; forgiving lists outside `@supports`, `:613`) | n/a | works | accept |
| Nesting `&` | `parse_parent_selector` is true (`:603`). Verified: `#nest { &.n {…} }` applies. Not present after Tailwind's lowering | n/a | works | accept |
| `:has()` (74 uses in 71 rules) | `parse_has` returns the pref `layout.css.has-selector.enabled`, default false (`:598`), and Blitz does not set it. So 60 rules are dropped as invalid and 11 never match: there `:has` sits inside `:is()`/`:where()`, whose forgiving lists drop it. With the pref on, both kinds parse and match (verified). Invalidation: Stylo leaves `RelativeSelectorInvalidator` (`invalidation/element/relative_selector.rs:733,768`) to the embedder, and Blitz never calls it | Blitz gap | unsupported (pref), and dynamic changes would not restyle | fork patch: enable the pref and invalidate; until then reject |
| `:focus-visible` (31) | Parsed (`FocusVisible`) | `Node::focus` sets `FOCUS \| FOCUSRING` for every focus (`node/node.rs:711-715`). In Chromium a button focused by a mouse click does not match `:focus-visible`; one focused by keyboard does (verified) | Blitz gap | fork or runtime patch: the runtime already moves focus itself (`runic-runtime/src/events.rs:881`) |
| `::placeholder` | Parsed | The fork's `5f083d6` resolves `::placeholder` styles for placeholder text, including `color-mix(in oklab, currentcolor 50%, transparent)` | works (fork) | accept |
| `::backdrop`, `::selection`, `::file-selector-button` | Parsed (`servo/selector_parser.rs:689-701`) | Painting not checked; the editor has no file inputs or modal top layer known to need them | parsed | accept |
| `::-webkit-*`, `:-moz-*` (20 rules) | Unknown, so the rule is dropped | Chromium applies the `::-webkit-*` rules. They hide scrollbars, which `scrollbar-width: none` also does and Blitz honours, and they style date, search and spin-button internals, which Blitz has no controls for | dropped, equivalent | accept through an allow-list |

### Values

| Feature | Stylo | Blitz | Class | Compiler |
|---|---|---|---|---|
| Custom properties, `var()` fallbacks (empty ones too), `calc`/`min`/`clamp`/`minmax`/`repeat` | Verified, e.g. `calc(15px var(--nope, ))` is 15px and `.text-sm` is 14px/20px | used | works | accept |
| `oklch()`, `color-mix(in oklab \| oklch, …)` | Parsed (`values/specified/color.rs:43`) and computed (e.g. `.bg-background/80` is `oklab(0.965 -0.0017 0.0199 / 0.8)`) | Converted to sRGB for painting (`blitz-paint/src/color.rs:14-17`, `blitz-dom/src/util.rs:171`) | works; gamut handling against Chromium is unverified at pixel level | accept; conformance checks pixels |
| Relative colours, `light-dark()` | Verified: `rgb(from rgb(255 0 0) r g b / 50%)` and `light-dark()` under `color-scheme: light` | used | works (not in this output) | accept |
| `svh`, `lh`, `ch` | Verified (`h-svh` is 800px in an 800px viewport; `2lh` is 40px) | used | works | accept |

### Properties

Every property in the output parses in servo mode except the following 25 unique declarations (`decls-dropped.txt`):

| Dropped by Stylo (servo) | Uses | Effect vs Chromium | Class | Compiler |
|---|---|---|---|---|
| `-webkit-text-size-adjust`, `-webkit-tap-highlight-color`, `-ms-overflow-style`, `-webkit-overflow-scrolling` | preflight, bits-ui | none on desktop | dropped, harmless | allow-list |
| `-webkit-text-decoration`, `-webkit-backdrop-filter` | always next to the unprefixed property | none | dropped, harmless | allow-list |
| `-webkit-text-fill-color` | only inside a `prefers-reduced-motion` rule, which never matches | none | dropped, harmless | allow-list |
| `-webkit-font-smoothing: antialiased`, `-moz-osx-font-smoothing: grayscale` (added 2026-10-12) | Tailwind's `antialiased`, on the shadcn-svelte site's `<body>` | Chromium 153 on this Linux machine: the same page (Geist, Geist Mono and a system font at 12–32 px, dark and light, rotated and composited layers, device scale 1 and 2) is byte-identical with and without each value, and with `subpixel-antialiased` and `none`. On macOS these values ask for grayscale antialiasing. That is what both renderers always draw: glyph outlines are filled as paths with one coverage value per pixel and no subpixel (LCD) path (glifo `renderer.rs` `fill_uncached_outline_glyph`/`render_outline_to_atlas` → `fill_path`; vello_common strip alphas; vello `fine.wgsl` `area[]`; skrifa's `SmoothMode::Lcd` in glifo `glyph.rs` `hinting_options` is a hinting target for non-glyf outlines, not a rasterisation mode) | equivalent | allow-list, these values only: `auto`, `subpixel-antialiased`, `none` and other `-moz-osx-font-smoothing` values stay reported |
| `field-sizing: content \| fixed` | 4 (shadcn textarea and input) | Chromium sizes the textarea to its content | unsupported in servo | reject; Stylo and Blitz patch later |
| `text-wrap: balance \| pretty` | 7 | different line breaks | unsupported in servo (and Parley) | reject or accept as a recorded deviation (user decision) |
| `-webkit-line-clamp`, `-webkit-box-orient`, `display: -webkit-box` | 3 (`line-clamp-N`) | Chromium clamps to N lines; Blitz shows every line under `overflow: hidden` | unsupported in servo (`layout.css.line-clamp.enabled = false`, no `-webkit-box`) | reject |
| `resize` | textarea preflight, `resize-*` | Chromium paints a resize grip on textareas | unsupported in servo | accept as a known paint gap, or reject on textareas |
| `accent-color` | 1 | known gap (BLITZ-GAPS, checkbox) | unsupported in servo | as today (UA parity sheet) |
| `scroll-margin-block` | 2 | affects `scrollIntoView` only | unsupported in servo | reject while the runtime implements `scrollIntoView` |
| `container` | 2 | see `@container` | unsupported in servo | reject |
| `font-synthesis: none` | 1 (`:root` in `page.css`) | Inter ships no italic face, so Chromium shows `font-style: italic` text upright; Parley may synthesise an oblique (not verified) | unsupported in servo | verify, then decide |

These are computed by Stylo but **not used by Blitz**, or not by the CPU renderer:

| Property | Evidence | Uses | Compiler |
|---|---|---|---|
| `text-overflow: ellipsis` | no reads in `blitz-dom`/`blitz-paint`/`stylo_taffy` | `truncate`: 22 in the editor | Blitz patch (high value); reject until then |
| `filter` | Blitz converts it (`blitz-paint/src/filters.rs`, `render.rs:467`), but `anyrender_vello_cpu` 0.18 applies it only with its `filters` feature (off in the workspace `Cargo.toml`) and without `multithreading` (`src/scene.rs:83-92`) | 4+2 | enable the feature and verify; GPU renderer not checked |
| `backdrop-filter` | `anyrender_vello_cpu` ignores the argument (`_backdrop_filter`, `scene.rs:81`) | 2 (`backdrop-blur-*`, 4 in the editor) | reject on CPU, or accept as a paint deviation |
| `outline-offset` | known gap (BLITZ-GAPS) | 2 | as today |
| `fill` on SVG | known (BLITZ-GAPS, `E_CSS_PROPERTY`) | 1 | as today |

Used by Blitz (spot-checked in source):
- transforms: `translate`, `rotate`, `scale`, `transform` (2D, `stylo_to_kurbo.rs:25-70`);
- box painting: `box-shadow`, `clip-path`, `mask`, `isolation`, `opacity`;
- scrollbars: `scrollbar-width`, `scrollbar-color`;
- interaction and stacking: `user-select`, `pointer-events`, `touch-action`, `z-index`;
- sizing: `aspect-ratio`, `object-fit`;
- text: `text-decoration-*`, `text-underline-offset`, `letter-spacing`, `font-feature-settings`, `font-variation-settings`, `white-space-collapse`, `text-wrap-mode`.

### Effect of the drops on this stylesheet

Stylo reports 105 parse errors in `layout.css` (45 with `:has()` enabled) and 5 in `page.css`:

| Cause | Errors |
|---|---|
| Rules dropped for a selector (60 for `:has`, 19 for vendor pseudo-classes and pseudo-elements) | 79 |
| `@container` rules | 4 |
| `@media` rules with unknown features | 5 |
| Unknown properties or invalid values | 17 |

## Animations and transitions

**What the CSS uses:**
- transitions: `transition-[color,box-shadow]`, `transition-colors`, `transition-all` and one Svelte `transition`, for hover and focus colours;
- tw-animate-css `animate-in`/`animate-out` (keyframes `enter`/`exit`) on bits-ui open and closed states;
- `animate-spin` and `animate-pulse`, plus one Svelte `pulse` animation.

**Interaction with bits-ui.** bits-ui waits for exit animations with `node.getAnimations()` before unmounting (`bits-ui/dist/internal/animations-complete.js:25-50`). Without `getAnimations` it resolves at once. Animations are therefore observable from JavaScript as well as in paint.

**Options:**
1. Keep rejecting them, the current contract. The editor's screens then do not compile in M6.
2. Drive Blitz's existing animation engine from the runtime's event-loop clock, and in conformance compare against Chromium with its fake clock. Settled states are compared as now; intermediate frames are checked at chosen clock times. `getAnimations` is mapped to Stylo's running animations, or reported as an island.
3. Strip time-based declarations at build time. This changes intermediate frames and the bits-ui unmount timing, so under the verification rules it is an approximation that needs an explicit, recorded user decision.

Recommendation: option 2 for transitions and the `enter`/`exit` keyframes, pulled forward from M10 as far as the editor needs it.

## Recommendations for the compiler

1. **Collector at-rules.** Accept `@layer`, `@property` and `@supports`, in addition to `@media` and `@font-face`. Keep rejecting:
   - `@container`;
   - `@keyframes` and time-based properties (until the decision above);
   - `@starting-style`, `@scope`;
   - `@font-face` nested in other rules.
2. **Stylo as the build-time oracle.** In Rust (`runic-css` already links this Stylo), parse the collected CSS in servo mode with Blitz's prefs and an error reporter. Also re-parse declarations individually, because vendor-prefixed unknown properties are silent. Then:
   - every dropped rule or declaration becomes `E_CSS`/`E_CSS_PROPERTY` with the generated selector, which names the Tailwind class;
   - except for an explicit allow-list of drops verified equivalent to Chromium: the vendor pseudo-elements and properties above, and the three media features with Chromium's defaults;
   - add a hand-kept list of properties computed but ignored by Blitz (`text-overflow`, `filter`/`backdrop-filter` on the CPU renderer, `outline-offset`, `:focus-visible` semantics), shrinking as fork patches land;
   - evaluate `@supports` conditions with the same oracle. A condition whose answer depends on a property outside the verified set is a diagnostic.
3. **Reachability.** Tailwind emits a rule for every class candidate found in the scanned sources, including library components. Rejecting a rule only when its selector can match the program's class sets would keep unused utilities from blocking the editor. It depends on class-string analysis (`clsx`, `tailwind-merge`, `tailwind-variants` packs). Start by reporting every rule, then prune.
4. **Lowering.** Rewrite `format("woff2-variations")` to `format("woff2")` after checking the bytes. Nothing else needs lowering.
5. **Pipeline.**
   - The collector builds with `configFile: false` and only the framework plugins, so it must also run the app's CSS plugins (`@tailwindcss/vite`) with `optimize` left on.
   - SvelteKit emits one stylesheet per route node (layout `0.*.css`, page `2.*.css`). The SvelteKit subset needs an ordered concatenation instead of `E_CSS_ORDER`.

## Fork patches, by value for the editor

| # | Patch | Where | Size (estimate) |
|---|---|---|---|
| 1 | `:has()`: set `layout.css.has-selector.enabled`, plus invalidation (coarse first: restyle the document on a DOM or state change when the stylist has relative selectors; then `RelativeSelectorInvalidator`) | Blitz `document.rs:397`, mutation and snapshot paths | 1 line + 30–150 |
| 2 | `text-overflow: ellipsis` | Blitz inline layout and paint (Parley ellipsis) | 50–150 |
| 3 | `:focus-visible`: `FOCUSRING` only for keyboard and programmatic focus, and for text inputs | Blitz `node.rs:711` / event handling, or the runtime | 10–40 |
| 4 | Font loader: accept `woff2-variations`, sniff `data:` bytes, honour `unicode-range` | Blitz `net.rs` | 10–60 |
| 5 | Turn on `anyrender_vello_cpu/filters` (a workspace feature, not a fork patch); `backdrop-filter` needs AnyRender/vello_cpu work | workspace `Cargo.toml`, upstream | 1 line; larger |
| 6 | `field-sizing`, `line-clamp`, `text-wrap: balance` | Stylo servo property support (a Stylo fork or upstream) + Blitz/Parley | large |
| 7 | Container queries | Stylo `rule_parser.rs:285` gate and container evaluation + Blitz `query_container_size` | large |

Patches 6 and 7 need Stylo changes. Stylo is a crates.io dependency, so they mean an upstream change or a second fork.

## Not verified

- Pixel parity of `oklch`/`color-mix` colours and of shadows against Chromium. Conformance will measure it.
- `filter`/`backdrop-filter` in the GPU renderer.
- The effect of `font-synthesis: none` on italic Inter text.
- Painting of `::selection` and `::file-selector-button`.
- Whether Inter's non-Latin subsets are chosen for their scripts.
- The startup cost of parsing about 160 KB of CSS (M10 budget). Build-time pruning of unreachable rules would also reduce it.

## Scratch files

`.cache/m6-css/` (not committed) holds:

| Path | Content |
|---|---|
| `layout.css`, `page.css` | the regenerated CSS |
| `built-*.css` | the stale SDK build, for comparison |
| `inventory.mjs`, `inventory.txt` | the inventory script and its output |
| `parse-*.txt` | Stylo parse errors |
| `decls.tsv`, `decls-dropped.txt` | the per-declaration check |
| `render*.txt` | computed values |
| `make-test.mjs`, `make-fonts.mjs`, `chromium-check.mjs` | the generators and the Chromium check |
| `probe/` | the Rust probe. Rebuild it with `cargo build --offline` and `CARGO_TARGET_DIR` set to the shared target; its build artifacts were removed after the run |
