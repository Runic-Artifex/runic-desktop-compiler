# Blitz gaps

Differences between Blitz (found at revision `89e5e61` and upstream `8b54d6d`, the fork's base), with its dependencies (Stylo, Taffy, Parley, Vello), and Chromium, found by conformance runs. They feed the Blitz upstream track (D11) and the fork assessment below. Each entry says how conformance works around the gap so that everything else stays checked.

Layers: **UA** is Blitz's user-agent stylesheet (`blitz-dom/assets/default.css`), **layout** is `blitz-dom` layout, **paint** is `blitz-paint`, **events** is `blitz-dom` event handling, **Parley** is text layout and line breaking.

## Rendering and layout

| Gap | Layer | Observed | Workaround | Found |
|---|---|---|---|---|
| Default focus ring of text inputs | UA, paint | Chromium draws a 2px `#101010` ring over the border with a 1px white halo (`outline: auto`); Blitz draws a 2px blue outline outside the border and ignores `outline-offset`, so the ring cannot be matched from a UA stylesheet | fixtures: an author `input:focus` style (`outline: none` plus a border colour) | M3, `components-svelte` |
| Inline inputs in a line box | layout | an `<input>` inside a `<p>` gives a line box 4.8px shorter than Chromium's (inline form-control baseline and strut); a text input placed inline in a block gives one 4px taller | fixtures: inputs are `display: block` or flex items | M3, `components-svelte`; M5, `events-svelte` |
| Buttons with an author `display` | layout | Blitz gets centred, shrink-to-fit buttons from its UA `display: inline-flex`. With an author `display: block` (or `inline-block`), Chromium still lays a button out as a button: shrink-to-fit width and its content vertically centred in the anonymous button content box. Blitz stretches a block button to its container, lays its content out from the top (the label sits about 3px high in a 32px button) and, without an explicit height, makes it 17px shorter | fixtures: fixed-height buttons are flex containers with `align-items: center` (as shadcn's buttons are); a fork patch later | M6, `blitz-fork-svelte` |
| Checkbox box model | layout | author padding, borders and `flex` change a checkbox's box in Blitz; Chromium ignores them for native checkboxes | fixtures: style text inputs by id or type, not `input` | M3, `todomvc-svelte` |
| Radio metrics | UA | Blitz: 14×14 with margin `3px 3px 3px 4px`; Chromium: 13×13 with margin `3px 3px 0 5px` | runtime: the UA parity sheet | M5, `radio-svelte` |
| Form-control font size | UA | Chromium's controls use `font: -webkit-small-control` (13.33px); Blitz inherits | runtime: the UA parity sheet | M3 |
| Text input line height | layout | with `line-height: normal`, a text input's line box is fractional in Blitz (21.59px for an 18px DejaVu font) and rounded in Chromium (21px) | fixtures: an explicit `line-height` on text inputs | M3, `todomvc-svelte` |
| `<select>` | paint, events | nothing is drawn for a select: no closed control, no popup | runtime: a UA sheet draws the closed control from its options (grid-stacked, the shown one marked by an attribute that snapshots omit, a rotated-border arrow), and the runtime draws the popup into the page and implements its keyboard and pointer model. Headless Chromium also draws the popup into the page; windowed Chromium uses a separate widget that can extend past the window, which the runtime cannot. The closed control relies on the UA sheet's `display: inline-grid`: an author `display: block` stacks the options (fixtures keep the default display or make the select a flex item) | M5, `select-svelte`, `select-popup`, `7guis-flight` |
| `<input type="range">` | paint, events | nothing is drawn and there is no slider behaviour | none: examples use buttons (7GUIs Circle Drawer) | M5, `7guis-circles` |
| Text in fonts the app does not embed | paint | native builds load only the app's embedded fonts (no system fonts), so text whose font stack names none of them (the UA's `system-ui, sans-serif` on buttons and inputs, or generic families) is not drawn at all; Chromium falls back to a system font | none yet; fixtures set the embedded family on controls. To do in M6: a compile-time check that every text-bearing element's resolved font stack reaches an embedded face (`E_FONT`), instead of invisible text | M6, `derived-equality-svelte` |
| Textarea resize grip | paint, events | Chromium draws a resize grip on text areas and lets the user drag it (UA `resize: both`; Tailwind's preflight sets `vertical`); Blitz has no grip, and Stylo's servo mode does not parse `resize` | none: the compiler accepts `resize` (the default already differs); the whole-viewport pixel gate cannot see the small grip, fixtures with text areas set `resize: none` | M3, M6 |
| Overflowing textarea | layout | a textarea whose text is taller than its box shows scrolled in Blitz and unscrolled in Chromium | fixtures: a textarea tall enough for its text | M5, `patterns-svelte` |
| Text controls in an overflowing flex row | layout | text inputs and text areas in a flex row too narrow for them are laid out about 53px narrower than in Chromium (their automatic minimum size); a text area with text also adds about 0.4 pixel error at 420px | fixtures: the text area on its own row, sized by the fixture's CSS | M5, `forms-vue` |
| Fractional lengths | layout | Chromium converts each CSS length to a layout unit (1/64 px, truncated: `7.7px` is 7.6875px) before layout; Blitz lays out the exact floats, so boxes and positions differ by up to 1/64 px per length, and printed geometry differs | fixtures: lengths that are multiples of 1/64 px | M5, `measure-svelte` |
| Inherited `currentColor` in SVG | paint | Blitz draws an inline `<svg>` from a serialisation of its subtree (`node/serialize.rs` `svg_source`) that replaces the text `currentColor` in each attribute with the computed `color` of the element holding it; usvg then inherits the resolved color. Chromium inherits the `currentColor` keyword and resolves it with each element's own `color`, so a child whose CSS `color` differs (a `class` on a `path`) is drawn in its own color in Chromium and in its ancestor's in Blitz | fixtures: the paint attribute (`stroke="currentColor"`) also on the child whose color differs (`icons-*`) | M5, `icons` |
| `currentColor` of a non-sRGB colour in SVG | paint | the serialisation writes the computed `color` with `to_css_string()`, which keeps its colour space: `oklch(…)`, `lab(…)`, `color(…)`. usvg does not parse these, so a shape painted with `currentColor` under an oklch `color` (every shadcn theme colour) is not drawn at all; Chromium draws it. A hex or `rgb()` colour is drawn | none yet: a fork patch converts the colour to sRGB (`to_color_space(Srgb)`, as `ToColorColor` does for painting) and writes `rgb()`, a few lines in `node/serialize.rs`. The whole-viewport pixel gate does not see missing icons; the `shadcn-basics` case states the gap | M6, `shadcn-basics` |
| `:target` | style | Blitz's selector matching never matches `:target`; Chromium matches the element a followed fragment link names | compiler: `:target` selectors are rejected (`E_CSS`); links to fragments that name an element are rejected or reported by the runtime (docs/IR.md, links) | M6, `blitz-dom/src/stylo.rs` |
| CSS on SVG content | paint | the serialisation carries attributes only, so stylesheet properties of SVG elements do not reach usvg: `fill`, `stroke` and the other SVG paint and geometry properties, and `display`, `visibility`, `opacity`, `transform` on SVG children (checked: a `display: none` path and an `opacity: 0.3` path are drawn plainly). CSS `color` reaches it through `currentColor`; the `<svg>` box's own layout, opacity and transform apply | compiler: SVG-only CSS properties and inline styles on SVG elements are rejected (`E_CSS_PROPERTY`, `E_SVG`); stylesheet `display`/`visibility`/`opacity`/`transform` on SVG children cannot be found statically and are not rejected. Fixtures use attributes | M5, SVG spike (uncommitted comparison page) |
| `<svg>` overflow | UA, paint | Blitz's UA sheet has no rule for `svg`: strokes beyond the viewBox are drawn outside the box, and an `<svg>` flex item keeps its width where Chromium shrinks it (Chromium's UA `svg:not(:root) { overflow: hidden; overflow-clip-margin: content-box }`). With `overflow: hidden`, Blitz clips at the padding box, Chromium at the content box | runtime: the UA parity sheet sets `svg { overflow: hidden }`; fixtures: no padding on `<svg>` elements whose drawing overflows the viewBox | M5, SVG spike (uncommitted comparison page) |
| System fonts for SVG | paint | blitz-dom parses every inline `<svg>` with a usvg font database that loads all system fonts on first use (`util.rs` `FONT_DB`: 417 font files opened on the development machine); they serve `<text>`, which the compiler rejects. Release first frame: 29–30 ms for the `icons` fixtures, 24 ms for `counter-svelte` | none (a static in blitz-dom); a patch would give usvg an empty or document-font database | M5, `icons` |
| Hit testing inside SVG | events | SVG children have no layout boxes in Blitz, so a press on a painted shape targets the `<svg>`; Chromium targets the shape (`event.target`) | compiler: no listeners or refs on SVG elements. `event.target` of a press on an icon inside a listening element still differs; it is observable only through layout reads of the target | M5, from the Blitz source (`layout/construct.rs` builds no boxes under an `<svg>`; `Node::hit_inner` walks paint children); not reproduced |
| Tailwind 4 output | style, layout, paint | `@container` queries, `field-sizing`, `line-clamp`, `text-wrap: balance`, `filter` and `backdrop-filter` in the CPU renderer (its `filters` feature is off: with it on, vello_cpu 0.3 panics on colour-matrix filters such as `brightness()` and draws only the first function of a filter list, so it stays off) are parsed but have no effect, or are not supported by Stylo's servo mode | M6 compiler: Stylo as a build-time oracle reports them; fork patches for the ones the editor needs ([M6-CSS](research/M6-CSS.md)) | M6, CSS research |
| Shape anti-aliasing | paint | vello_cpu and Skia anti-alias shape edges differently: per icon box (16–48 px, `icons` case) a mean absolute error of at most 2.7/255, single edge pixels up to 81/255, total ink within −6 % to +1 % (thin strokes are lighter in Blitz: a 2 px dashed ellipse −5 %, a half-transparent arc −5 %), ink centroids within 0.2 px; dash phases, joins, caps, `fill-rule`, transforms and opacity match | none needed (within the pixel tolerance) | M5, `icons` |

## Fixed in the fork

The fork is [`Runic-Artifex/blitz`](https://github.com/Runic-Artifex/blitz), branch `runic`, one commit per gap on upstream `8b54d6d`. Each has a conformance case that fails without it (checked against the unpatched base, 2026-10-04). Commits marked *runic* support the runtime's own emulation and are not offered upstream.

| Gap | Was | Commit | Case |
|---|---|---|---|
| Hit testing a scrolled container | a scroll container scrolled by *d* took pointer hits in the *d* pixels above (and left of) its box; its descendants, painted clipped, were hit-tested unclipped | *Hit-test scroll containers with their paint clip*: painting and hit testing share `Node::clips_overflow` | `blitz-hit-scrolled` (a toolbar directly above a scrolled list) |
| Shrink-to-fit widths | content-sized boxes were rounded up to a whole pixel (39.36px → 40px), so a row drifted by the sum | *Round shrink-to-fit widths up to a layout unit*: 1/64 px, Blink's `LayoutUnit::FromFloatCeil` | `blitz-shrink-to-fit` (a wrapping row of nine buttons) |
| Option widths (*runic*) | with 1/64 px rounding, selects drawn by the runtime were narrower than Chromium's, which rounds the widest option text up to a whole pixel | *Round option text widths up to whole pixels* | `select`, `select-react`, `select-vue`, `select-popup` |
| Line breaks | plain UAX #14: no break after the hyphen in `1999-12-31` | *Break lines where Chromium does*: Parley's `CHROMIUM_LINE_BREAK_OVERRIDE` for paragraphs (text controls lack the setter) | `blitz-line-breaks` (geometry through a `min-content` box) |
| Placeholders | not painted | upstream PR #552, cherry-picked | `blitz-placeholders`: paint only, so the case states that its screenshots are inspected; the whole-viewport pixel gate cannot see a missing placeholder |
| `:has()` | disabled in Stylo's prefs; 60 of 71 Tailwind rules dropped | *Support :has() with coarse invalidation*: any DOM mutation or state change restyles the document while a stylesheet has a relative selector | `blitz-has` (state and DOM mutation invalidation) |
| `text-overflow: ellipsis` | computed but not painted | *Paint text-overflow: ellipsis*: an overflowing line of a clipping box draws the glyphs that fit whole, then U+2026 | `blitz-ellipsis`: paint only, so the case states that its screenshots are inspected (checked 2026-10-04: identical truncation points and ellipsis placement) |
| Checkbox and radio colours | painted in the element's `color`; the runtime's UA sheet set Chromium's, which reset styles (Tailwind's `color: inherit`) override | *Paint checkboxes and radio buttons in Chromium's colours*, including the hovered colours and a crisp one-pixel border (sampled pixels equal Chromium's); the UA sheet rules are gone | `tailwind` (a checked checkbox under Tailwind's preflight), `radio`, `forms`, `todomvc` |
| `woff2-variations` fonts | `format("woff2-variations")` sources were skipped, and so were `data:` URLs without a known format (the extension lookup returned early) | *Load fonts with legacy \*-variations format hints and data: URLs*; the collector accepts the hint | `blitz-line-breaks` (the paragraph uses such a font) |
| `:placeholder-shown` | never matched | *Support :placeholder-shown*: the state follows the control's value, synced before each style pass | `blitz-placeholder-shown` |
| `:focus-within` | never matched | *Support :focus-within*: focus changes set `FOCUS_WITHIN` on the focused element and its ancestors | `blitz-focus-within` |
| `:focus-visible` | never matched; focusing always set `FOCUSRING` | *Let embedders set whether the focused element is focus-visible*; the runtime applies Blink's modality rule (below) | `blitz-focus-visible` |

## Behaviour the runtime implements

These work today and are covered by conformance. The cost is code in `runic-runtime` that cancels or reorders Blitz's own handling.

| Gap | Layer | Observed | Runtime | Found |
|---|---|---|---|---|
| Click default action | events | Blitz focuses checkboxes and radios on click (text inputs on pointer down) and clears focus without focus events when nothing focusable was clicked (`events/pointer.rs` `handle_click`); Chromium moves focus on `mousedown`, to the nearest focusable ancestor or nowhere | always cancels Blitz's click default; moves focus on `mousedown` and does label, checkbox and radio activation itself (`events.rs`) | M5, `focus` |
| Focus events and sequential navigation | events | Chromium's `blur`/`focusout`/`focus`/`focusin` order with `relatedTarget`, `tabindex` focusability and positive-`tabindex`-first Tab order | `move_focus` and `tab_order` | M5, `focus`, `radio` |
| Pointer and mouse boundary events | events | Blitz interleaves pointer and mouse boundary events; Chromium sends all pointer boundary events first | buffers and replays Chromium's order | M5, `events` |
| `dblclick` | events | Blitz drops `dblclick` when the click was cancelled (which the runtime always does) | counts clicks itself | M5, `events` |
| Text control guards | events | Blitz dispatches `input` after the editor changed, not cancelable; no read-only or disabled guards, no `maxlength` | checks before mutation (`controls.rs`) | M3 |
| Wheel deltas | events | Blitz's wheel deltas have the opposite sign to the DOM's (a convention, not a defect) | negated when the DOM event is built (line deltas as 20px) | M5, `events` |
| Bounding rect of a scroll container | layout | `get_client_bounding_rect` subtracts the node's own scroll offset, which only moves its content | `layout::client_rect` adds it back (layout reads, probes, the select popup) | M5, `measure` |
| Scroll offset after content shrinks | layout | a scroller (or the viewport) keeps an offset past the end of its new range and paints blank; Chromium clamps it in layout and sends a `scroll` event a frame later | `layout::resolve` clamps after every layout the runtime runs; frames queue the clamped scrollers' events (`Native::layout_frame`) | M5, `scroll-events`, `virtual-list` |
| Programmatic scrolling | layout | Blitz keeps fractional scroll offsets, where Chromium rounds them to device pixels (`scrollBy(0, 33.5)` from 45 gives 79); `scroll_into_view` scrolls only the viewport, where Chromium scrolls every scroll container; no `scroll` event for programmatic scrolls | `layout.rs`: rounding, every scroller in `scrollIntoView` with Blink's closest-edge rule | M5, `measure` |
| `:focus-visible` modality | events | Blitz has no input-modality heuristic | the runtime tracks it as Blink's `MatchesFocusVisiblePseudoClass` does (text input, a key pressed since the last mousedown, or the last user focus not by mouse; script focus keeps it) and sets the state through the fork's `set_focus_visible` | M6, `blitz-focus-visible` |
| Inline style CSSOM | API | no `CSSStyleDeclaration`: inline styles exist only as the `style` attribute | crate `runic-css` parses and serialises with Stylo | M5, `style-directives` |
| Text input scroll after blur | events, paint | Chromium scrolls a single-line text input back to its start when it loses focus; Blitz keeps the horizontal offset the caret last needed (and clamps it only for the focused input), so a shorter value set later is drawn scrolled out of view | `controls::reset_scroll_on_blur` on every focus loss | M5, `7guis-cells` |

## Fork assessment

D11 already allows local patches in a documented patch set. The question is whether the gaps justify carrying one now rather than waiting for upstream.

**Upstream status (checked 2026-10-04).** Upstream Blitz main is 8 commits ahead of the pin: Taffy revision bumps, `align-items: normal` left unset, and AnyRender 0.14 (vello 0.11, vello_cpu 0.3, wgpu 30). None of them touch blitz-dom, blitz-traits, blitz-shell or blitz-html, and none fixes a gap listed here. Per gap:

| Gap | Upstream | Patch (estimated) |
|---|---|---|
| Shrink-to-fit widths | the `.ceil()` in `layout/inline.rs` was added deliberately (`a1c00e08`) to stop float error from wrapping text on relayout | round up to 1/64 px (Chromium's layout unit) instead of whole pixels, a few lines |
| Placeholders | open PR #552 (`::placeholder` as a pseudo-element with its own Parley layout); it cherry-picks cleanly onto the pin | carry #552 |
| Line breaks after hyphens | Parley already has `CHROMIUM_LINE_BREAK_OVERRIDE` (Parley #640) at the version Blitz uses; Blitz does not set it | a few lines in `layout/construct.rs`; inputs and textareas also need a small Parley `PlainEditor` setter |
| `dblclick` | it is dispatched from click's default action, so a cancelled click drops it | dispatch it after the click in `handle_pointerup`, about 10 lines |
| Text input line height, inline baselines | text inputs are layout leaves using `font-size * 1.2` for `line-height: normal`, with no baseline | about 15–30 lines each in `dispatch_child_layout` |
| Hit testing a scrolled container | `hit_inner` adds the scroll offset before testing the node's own box | test the own box in unscrolled coordinates, a few lines |
| Fractional lengths | Taffy works in `f32` | quantise lengths to 1/64 px in the Stylo-to-Taffy conversion (`stylo_taffy`); intermediate results (percentages, flex distribution) stay floats, so how exact this gets needs measuring |
| Overflowing textarea | likely cause (not reproduced): after any click or key down Blitz scrolls the focused text control to its caret, even when the event targeted something else | limit that to events on the control, about 10 lines |
| Focus ring | `outline: auto` is not painted and `outline-offset` is ignored; open PR #799 moves the UA rule to `:focus-visible` | 15–25 lines for the offset, 30–50 for an `auto` ring |
| Checkbox box model | no issue or PR | about 30–60 lines, gated on `appearance` |
| Click default action | a large draft event refactor (#513) rewrites the same code | the runtime handles it; leave it |
| `<select>` | tracking issue #258, no PR; an overlay popup needs window APIs (#302, open) | not a small patch; the runtime handles it |
| Inherited `currentColor`, CSS on SVG content (found after the upstream check) | not checked | serialise each element's computed SVG properties (`color` as an attribute, so usvg resolves `currentColor` itself; `display`, `opacity`, …) instead of replacing text, about 30–60 lines in `node/serialize.rs`; Stylo must compute the SVG properties |
| System fonts for SVG (found after the upstream check) | not checked | an option for the usvg font database, a few lines in `util.rs` |
| `currentColor` of a non-sRGB colour (found in M6) | not checked | convert to sRGB before serialising (`node/serialize.rs`, `write_outer_html_in_style`), a few lines |

**What only a patched Blitz can fix.** The rendering and layout gaps with a fixture-only workaround cannot be fixed from the runtime:
- shrink-to-fit rounding;
- inline control baselines;
- text input line height;
- placeholders;
- the focus ring;
- textarea scrolling;
- hyphen breaks (Parley).

The fixtures avoid them, but real applications are not written around them. The Translations Editor will have rows of content-sized buttons, inline inputs and placeholders. Placeholders are required for M8, and the drift and line-box differences are visible misalignments in real layouts.

**What a fork would simplify.** Selects, the click default, boundary ordering and text guards work in the runtime, so they are not a reason to fork. Two things would change with a fork:
- a select popup as a real overlay window needs Blitz;
- moving these behaviours into Blitz would remove the cancel-and-reimplement layer.

Neither is urgent.

**What needs no fork.** UA defaults (radio and checkbox metrics, control fonts and colours) are fixed from the runtime's UA parity sheet.

**Decision (2026-10-04).** The fork is [`Runic-Artifex/blitz`](https://github.com/Runic-Artifex/blitz), based on upstream main; the patches live on its `runic` branch. It is the first step of M6 ([roadmap](ROADMAP.md#m6-libraries-css-pipeline-sveltekit-islands)).

**Recommendation.** Carry a thin fork:
- **Commits.** One commit per gap, each with the conformance case that shows it, each offered upstream. A patch is dropped when the pin moves past an upstream fix.
- **Wiring.** Cargo `[patch]` on the Blitz git URL.
- **Order.** Each patch is roughly 2–60 lines:
  1. hit testing of scrolled containers, and 1/64 px rounding;
  2. placeholders (#552);
  3. the line-break override;
  4. `dblclick`;
  5. text input line height and baselines;
  6. textarea scrolling;
  7. the focus ring.
- **Base.** Either the current pin or upstream main. Starting from main costs one pin move now (AnyRender version bumps and a conformance rerun for the Taffy changes) and saves rebasing the patches across those commits later. It is a dependency upgrade, so the milestone that carries it must plan it.
- **Parley.** Paragraphs need no Parley fork. Inputs and textareas need the `PlainEditor` setter, to be offered upstream first.
- **Selects.** Native select popups wait for the desktop-input track.
- **Cost.** Rebasing the series when the pin moves. Pin moves are already planned work, and a small series with one case per patch keeps them cheap.
