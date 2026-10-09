# Gaps: DOM, host services, CSS and rendering

Part of the [gap register](../GAPS.md). Rendering details of Blitz, Stylo and Taffy are in [BLITZ-GAPS](../BLITZ-GAPS.md); this file lists what they leave uncovered. Locations as of commit `9add179` (2026-10-07). Clusters: **P1** elements, **P2** events and forms, **P3** script DOM, **P4** CSS and rendering, **P5** host services, **P6** Intl, **P7** images and fonts.

## Elements (P1)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| Elements outside the 77-tag shared IR/Svelte lists or 71-tag React/Vue lists: `img`, `details`/`summary`, `dialog`, `q` (generated quotes, P4), `fieldset`/`legend`, `progress`, `meter`, `video`, `iframe`, `canvas`, `bdi`/`bdo`, `wbr`, `ruby`, …; React and Vue also lack `a`, `dl`, `dt`, `dd`, `figure`, `figcaption`. `form` and all ten table tags are accepted by all three adapters | E_IR / E_TEMPLATE / E_JSX | Elements with uncovered behavior remain rejected | Add inert elements with conformance; interactive elements need their behavior | validate.rs (`TAGS`); frontend/elements.ts; adapter `TAGS` |
| CSS table behavior beyond the verified table fixtures: complete anonymous fix-up, `empty-cells`, `visibility: collapse`, row/group effects, height distribution, border ordering and image backgrounds | unverified | The pinned Blitz formatting context and compiler table tags cover the bounded [consolidated surface](../../conformance/results/chromium-consolidation.md), not the complete CSS table model | Attributed WPT/app reductions with independent geometry, hit and local-pixel gates | [Targeted parity plan](../research/CHROMIUM-PARITY.md), CP-TABLE-WPT |
| SVG beyond `svg, g, path, circle, ellipse, line, polyline, polygon, rect`: `text`, `use`, `defs`, `clipPath`, gradients, `mask`, `symbol`, `image`; nested `<svg>`; text, components or `{@html}` inside SVG; SVG without `viewBox` | E_SVG | Blitz renders an `<svg>` through usvg from attributes | Per element, measured against Chromium | validate.rs:30-176,2340-2438 |
| Listeners, refs, spreads and inline styles on SVG elements; `:hover`/`:active` on SVG children | E_SVG / E_CSS | Blitz hit-tests an inline `<svg>` as one box | SVG child boxes in Blitz | validate.rs:139-155; collect.mjs:1044 |
| `preserveAspectRatio` other than the default | E_TEMPLATE | usvg fits as `object-fit: contain` | Blitz fork | BLITZ-GAPS |
| `{@html}` of run-time strings; fragments with links, controls, SVG, images, tables or `on*` | run time / E_IR | No HTML parsing at run time | Blitz's parser with an allow-list | dom.rs:1268; validate.rs:1726-1800 |
| `<iframe>` | E_TEMPLATE | A second app instance | M8 embedder design | CONTRACT |
| Nested `<button>` | E_IR | — | — | validate.rs:2607 |

## Events and forms (P2)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| Event kinds outside the list: `reset`, `keypress`, `copy`/`cut`/`paste`, `beforeinput`, composition, `pointercancel`, touch, drag, `animationend`/`transitionend` (and animation/transition events generally), `toggle`, `load`/`error` | E_EVENT / E_IR | Each needs its dispatch modelled and a case; animation events need Blitz to report them | Per event; a Blitz change returning animation events from `resolve` | lib.rs:987-1026; svelte.ts:4793; react.ts:2370; vue.ts:4353 |
| React programs combining `onMouseEnter`/`onMouseLeave` with `onMouseOver`/`onMouseOut` (or the pointer pairs) | E_EVENT | React dispatches enter and leave from the `out` event, before the over handlers; the IR binds them to the native enter and leave events | Bind React's enter and leave to the out (and, from outside the root, over) dispatch | react.ts (`checkEvents`) |
| Submission defaults beyond canceled `submit`: reset, FormData/serialization, navigation and dialog completion | run time / frontend diagnostics | The bounded checkpoint dispatches common submit events and requires cancellation; these defaults are not implemented | Shared default-action model with independent browser/native/interpreter cases before acceptance | runic-js/forms.rs; runtime/forms.rs; events.rs; codegen builtins.rs; [design](../design/M6-FORM-SUBMISSION.md) |
| Intrinsic/constraint validity, custom validity/UI, invalid events, dirty-value history and validity/user-validity CSS states; Enter triggers outside text/search/tel/password | run time / E_CSS / frontend diagnostics | Shared helper admits only proved-valid domains/barred controls or the actual validation bypass; never guesses from a value. CSS validity states remain rejected with novalidate too | A shared validity model and independent lifecycle/attribute/group cases; OS composition delivery separately | runic-js/forms.rs; runtime/forms.rs; interp.rs; collect.mjs (checkValiditySelectors) |
| React native element submit registration combined anywhere in the program with a synthetic submit handler (including rest props); `SubmitEvent.submitter`, SubmitEvent construction, argumented `requestSubmit`, React synthetic DOM-event `instanceof`/`nativeEvent`; programmatic control click | frontend / run time diagnostics | Only common Event operations and native SubmitEvent/Event instanceof are covered; no-argument requests do not choose a submitter | Per interface/default with independent framework cases | language.ts; frontend/dom.d.ts; adapters/react.ts; dom.rs; [design](../design/M6-FORM-SUBMISSION.md) |
| Non-form/removed-non-form request receivers; requestSubmit shadowing by owned name/id; legacy image fallback; nested/parser-specific forms | run time / E_TEMPLATE / E_JSX | Conservative diagnostics protect receiver/method/ownership boundaries. Removed known forms retain identity and descendant shadow facts; external detached ownership is not fully retained. img is rejected by the element allowlist, so source E2E rejection does not prove the native legacy-image guard | Direct adapter unit reductions where admitted source cannot reach a branch, then broader DOM/named-property/parser ownership design | runtime/forms.rs; dom.rs; interp.rs; validate.rs; adapter TAGS |
| `change` only on checkboxes and selects; `input` only on text inputs, textareas and selects; live properties other than `value`/`checked`/`defaultValue`/`selectValue`; text domains single-line and bounded | E_IR / RunicDomainError | The control model | Per property | validate.rs:2652-2736; interp.rs:424 |
| `<input type="range">`; other input types (date, number, color, file) | — | Blitz draws nothing for range | Runtime-drawn controls (as for select) | BLITZ-GAPS |
| `<select>` popup past the window; author `display: block` on a closed select | — | Runtime-drawn | Window APIs (desktop-input track) | BLITZ-GAPS |
| `element.click()` on elements with activation behaviour; `dispatchEvent` of native event types; native listeners whose type is known only at run time | run time | Only listeners run | Activation behaviour per element | dom.rs:1100-1130; builtins.rs:1057-1064 |
| Members of script-created events beyond the basic set; `pointerId`/`pointerType` of non-pointer events; event interfaces outside the table; `keyCode` other than the 229 test; `touches`, `dataTransfer`, `clipboardData`, `composedPath` | run time / E_EVENT | Uncovered members remain unmodelled; focus and accepted pointer/mouse boundary events carry nullable element `relatedTarget`, not arbitrary synthetic event support | Per member and event interface | event.rs; frontend/dom.d.ts; language.ts |
| Listener options beyond the covered `once`/`capture`/`passive` forms (`signal`, `once` with a named function) | E_EVENT | — | — | language.ts:8785-8823 |
| `new PointerEvent`, `new Proxy`, `releasePointerCapture`; pointer capture never happens | run time | Not modelled | — | CONTRACT; language.ts:9642,10861 |

## Script DOM (P3)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| The framework inserting into a parent whose children script reordered (bits-ui Command: clearing the search, a query without matches) | run time | The runtime keeps no comment anchors; Svelte places blocks by them | Comment anchors in the runtime (Blitz has `create_comment_node`); then `appendChild` generally | dom.rs:1426-1433 |
| `appendChild` of nodes that are not already children, or of the focused element; `insertBefore`, `removeChild`, `replaceChildren`, `cloneNode`, `createElement` | run time / E_CALL | Only reordering is covered | General DOM mutation on the anchor model | dom.rs:796-812; language.ts:9554-9902 |
| The framework writing an attribute script set to another value | run time | The frameworks skip unchanged writes; the runtime rewrites | Per-key change tracking in attribute application | dom.rs:1366-1388 |
| `removeAttribute`/`toggleAttribute`/`classList` on arbitrary elements (covered on html/body) | E_CALL | — | As `setAttribute` | language.ts:8646 |
| Selector subset for `querySelector(All)`/`closest`/`matches`: no `+`, `~`, `^=`, `$=`, `*=`, `~=`, `\|=`, pseudo-classes other than `:not()` (and `:focus-visible` alone) | run time | runic-js selector engine | Use Stylo's selector matching (Blitz has it) | runic-js selector.rs:1-188 |
| Element properties beyond the metrics and covered members: `innerHTML`, `children`, `firstChild`, `nodeType`, `innerText`, …; `style.cssText`; `getComputedStyle` beyond the read set or of percentage margins/paddings; `getClientRects` per line box | E_MEMBER / run time | Not modelled | Per member | language.ts:6062,7786; dom.rs:588; layout.rs:398 |
| `createRange`/`getSelection`, `checkVisibility`, `AbortController`, `navigator.userAgent`, `onbeforeunload`, `document.cookie` | not in the contract | — | Per API | design/M6-SVELTEKIT; research |
| `MutationObserver` beyond child lists; `IntersectionObserver` with element roots, `scrollMargin`, targets under non-translation transforms or `clip-path`; Chromium's notification order | run time / E_CALL | Not covered | Per option | builtins.rs:678; layout.rs:340-355 |
| `next/previousElementSibling` or `firstNonCommentChild` reaching the container or a text node (except the covered data-read case) | run time | Script values are elements | Node values | dom.rs:745-791 |
| Tab navigation right after a reorder continues from the moved element, not Chromium's live range | known gap | Exact framework move sequence | Live-range model (M8) | case `reorder-navigation` |
| Links: to other documents, to `#`/`#top`, to named anchors, to fragments naming elements (outside Kit) | run time / E_TEMPLATE | Navigation and scrolling to targets not modelled | Scroll and focus targets | events.rs:1142-1195; svelte.ts:2827 |

## CSS and rendering (P4)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| `position: sticky` (site header, sidebar, table of contents) | E_CSS_PROPERTY | Compiler guard remains although pinned Blitz implements bounded shared sticky paint/hit/DOM geometry | Lift the guard only with compiled acceptance across the intended scroll/transform/clip domain | collect.mjs; BLITZ-GAPS |
| `:target` | E_CSS | Blitz never matches it | Blitz | collect.mjs:1030 |
| `content` other than strings: `open-quote`/`close-quote` (and so `<q>`), `counter()`, `counters()`, `attr()`, images (a `var()` holding one is not detected) | E_CSS_PROPERTY | Blitz generates strings only | Blitz: quote depth in document order, counters | collect.mjs (`content`) |
| At-rules `@starting-style`, `@scope`, `@page`, `@import`, style and scroll-state container queries | E_CSS | — | Per rule | collect.mjs:1002-1016 |
| `text-transform` other than none/upper/lower (`capitalize`) | E_CSS_PROPERTY | Blitz transforms case only | Blitz | collect.mjs:1088 |
| `animation-fill-mode: forwards/both`; animation and transition events; scroll-driven animations; `transition-behavior: allow-discrete`; animation lifetime beyond the verified reductions | E_CSS_PROPERTY / run time | Fill compiler/runtime guards remain despite pinned Stylo lifetime/cancellation/skipped-iteration repairs; animation events and other listed surfaces remain uncovered | Accept each guarded surface with framework and browser evidence; retain broader lifetime gaps | collect.mjs; BLITZ-GAPS |
| Declarations Stylo drops, reported where they apply: `field-sizing`, `line-clamp`, `text-wrap: balance\|pretty`, `scroll-margin` on scroll, container units, … | run time | Servo-mode Stylo, Parley | Stylo/Parley patches ("large") | timeline.rs:84-143 |
| Backdrop filters under a Backdrop Root, or with `filter` | E_FILTER | Renderer semantics | Renderer forks | effects.rs |
| `url()` filters; SVG paint servers; SVG CSS other than `fill`/`stroke`; 3D perspective | E_CSS_PROPERTY | — | Renderer and Blitz | collect.mjs:894,1094,1103 |
| Smooth scrolling (`behavior: smooth`); scroll snapping | E_CALL / — | Blitz has none | — | language.ts:9910 |
| Remaining rendering differences and retained fixture workarounds: ordinary-inline `offsetWidth`/`getClientRects`, native appearance/theme and control raster, sub-1/64px authored lengths, `<svg>` overflow clipping, `<br>` in flex containers, glyph/outline/rounded-border raster and broader inline/RTL fragment flow | — | Pinned table/control/scroll/metric repairs cover their measured domains; historical fixture workarounds are not proof of universal equivalence | Per remaining gap and local crop in BLITZ-GAPS; preserve existing fixtures until independently verified | BLITZ-GAPS; [consolidation record](../../conformance/results/chromium-consolidation.md) |
| Behaviour the runtime re-implements over Blitz (click default, focus events, boundary order, dblclick, wheel sign, programmatic scrolling, `:focus-visible`, inline-style CSSOM) | — | Blitz differs | Move into the fork, offer upstream | BLITZ-GAPS |
| Fork patches not yet offered upstream (Blitz, Stylo, renderers, Taffy) | — | D11 says upstream first | Offer them | BLITZ-GAPS |

## Host services (P5)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| `fetch` (network, and local resources outside Kit's build-time tables) | — | The editor needs it through the bridge | M8 bridge; local fetch | ROADMAP |
| `location.href`/origin reads and navigation (`assign`, `replace`, `reload`) | E_HOST / E_MEMBER | No origin natively | A defined origin from runic.json | language.ts:4411,7234,7375 |
| `history.go(0)`, object states, cross-origin URLs, concurrent traversals, a second fragment navigation while loading, more than 50 entries, traversal to an earlier document | E_* / run time | Chromium ordering not modelled | — | validate.rs:219; history.rs |
| `localStorage.key()`, `length`, the `storage` event (runed `PersistedState`); `document.cookie` | E_* | — | A cookie jar like localStorage (M7) | CONTRACT |
| Console format strings, non-primitive arguments, methods beyond log/info/warn/error/debug | E_BUILTIN | Chromium previews objects | — | validate.rs:196-218; language.ts:7076-7113 |
| Overlapping clipboard operations; clipboard beyond `writeText`/`readText` | run time / E_CALL | Ordering | — | lib.rs:2107 |
| `matchMedia` features beyond prefers-color-scheme, contrast, reduced-motion, width, height, orientation; OS preferences ignored natively | E_BUILTIN | Assumed Chromium defaults | Desktop-input track | validate.rs:1064 |
| Window title and size at run time; multiple windows | — | M8 packaging | — | ROADMAP |
| A rejection handler added after the unhandled report | run time | Chromium revokes the report | — | lib.rs:58-67 |

## Intl (P6)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| Locales other than en-US, en-GB, de-DE, fr-FR, ja-JP (literal: E_INTL; run time: RunicUnsupportedError) | E_INTL / run time | Only Chromium-verified data | Generate vectors per locale (a translations editor needs many) | intl/mod.rs:92-146 |
| DateTimeFormat `timeStyle` full/long, `timeZoneName`, `era`, `hourCycle`, `fractionalSecondDigits`, `dayPeriod`, calendars, numbering systems, unverified combinations and zones | E_INTL | Not verified | Vectors | intl/datetime.rs |
| NumberFormat notations, `signDisplay`, units, rounding options, `currencyDisplay: name`, currencies outside nine | E_INTL | Not verified | Vectors | intl/number.rs |
| PluralRules options; DisplayNames types other than region/script/currency/language, styles other than long; tags with variants or extensions; region aliases with several replacements | E_INTL | Not verified | Vectors | intl/plural.rs; intl/names.rs; intl/tag.rs |
| `RelativeTimeFormat`, `ListFormat`, `Segmenter`, Collator `usage: search`; several locales in a list; formatters as values | E_INTL | — | Builtins with vectors | builtins.rs:1765; language.ts:12430-12895 |

## Images and fonts (P7)

| Not covered | Code | Reason | What it would take | Location |
|---|---|---|---|---|
| Images: `<img>`, `new Image()`, Avatar.Image, card images, the site's static assets, `enhanced:img`; assets other than WOFF2 (png, svg files, ttf) | E_ASSET / E_TEMPLATE | The runtime loads no images | Embedded image assets and `<img>` (Blitz decodes images) | collect.mjs:546; CONTRACT |
| Text in a font stack naming no embedded font (`system-ui`) | E_FONT at run time | Native builds load only embedded fonts | A compile-time check; optionally system fonts | events.rs:481; BLITZ-GAPS |
| `@font-face` `unicode-range`, weight ranges, nested rules; bitmap emoji on the CPU renderer | — | Blitz font loader | Patches | research/M6-CSS |
