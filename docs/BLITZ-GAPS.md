# Blitz gaps

Differences between the pinned Blitz revision (`89e5e61`), with its dependencies (Stylo, Taffy, Parley, Vello), and Chromium, found by conformance runs. They feed the Blitz upstream track (D11) and the fork assessment below. Each entry says how conformance works around the gap so that everything else stays checked.

Layers: **UA** is Blitz's user-agent stylesheet (`blitz-dom/assets/default.css`), **layout** is `blitz-dom` layout, **paint** is `blitz-paint`, **events** is `blitz-dom` event handling, **Parley** is text layout and line breaking.

## Rendering and layout

| Gap | Layer | Observed | Workaround | Found |
|---|---|---|---|---|
| Default focus ring of text inputs | UA, paint | Chromium draws a 2px `#101010` ring over the border with a 1px white halo (`outline: auto`); Blitz draws a 2px blue outline outside the border and ignores `outline-offset`, so the ring cannot be matched from a UA stylesheet | fixtures: an author `input:focus` style (`outline: none` plus a border colour) | M3, `components-svelte` |
| Inline inputs in a line box | layout | an `<input>` inside a `<p>` gives a line box 4.8px shorter than Chromium's (inline form-control baseline and strut); a text input placed inline in a block gives one 4px taller | fixtures: inputs are `display: block` or flex items | M3, `components-svelte`; M5, `events-svelte` |
| Input placeholders | paint | `placeholder` text is not painted | none: examples omit placeholders (the M8 editor needs them) | M3, `todomvc-svelte` |
| Checkbox appearance | paint | Blitz paints checkboxes in the element's `color` and ignores `accent-color`; Chromium uses a grey border and a blue accent fill | runtime: the UA parity sheet sets Chromium's colours | M3, `todomvc-svelte` |
| Checkbox box model | layout | author padding, borders and `flex` change a checkbox's box in Blitz; Chromium ignores them for native checkboxes | fixtures: style text inputs by id or type, not `input` | M3, `todomvc-svelte` |
| Radio metrics | UA | Blitz: 14×14 with margin `3px 3px 3px 4px`; Chromium: 13×13 with margin `3px 3px 0 5px` | runtime: the UA parity sheet | M5, `radio-svelte` |
| Form-control font size | UA | Chromium's controls use `font: -webkit-small-control` (13.33px); Blitz inherits | runtime: the UA parity sheet | M3 |
| Text input line height | layout | with `line-height: normal`, a text input's line box is fractional in Blitz (21.59px for an 18px DejaVu font) and rounded in Chromium (21px) | fixtures: an explicit `line-height` on text inputs | M3, `todomvc-svelte` |
| Shrink-to-fit widths | layout | content-sized boxes (buttons, labels, flex items) get their measured inline width rounded up to a whole pixel: `layout/inline.rs` calls `.ceil()` on the computed and measured widths (39.36px → 40px). A row of such boxes drifts by the sum (M5: 3.2px over six items) | fixtures: fixed widths where several content-sized boxes share a row | M3, `todomvc-svelte`; M5, `radio-svelte` |
| `<select>` | paint, events | nothing is drawn for a select: no closed control, no popup | runtime: a UA sheet draws the closed control from its options (grid-stacked, the shown one marked by an attribute that snapshots omit, a rotated-border arrow), and the runtime draws the popup into the page and implements its keyboard and pointer model. Headless Chromium also draws the popup into the page; windowed Chromium uses a separate widget that can extend past the window, which the runtime cannot. The closed control relies on the UA sheet's `display: inline-grid`: an author `display: block` stacks the options (fixtures keep the default display or make the select a flex item) | M5, `select-svelte`, `select-popup`, `7guis-flight` |
| `<input type="range">` | paint, events | nothing is drawn and there is no slider behaviour | none: examples use buttons (7GUIs Circle Drawer) | M5, `7guis-circles` |
| Overflowing textarea | layout | a textarea whose text is taller than its box shows scrolled in Blitz and unscrolled in Chromium | fixtures: a textarea tall enough for its text | M5, `patterns-svelte` |
| Text controls in an overflowing flex row | layout | text inputs and text areas in a flex row too narrow for them are laid out about 53px narrower than in Chromium (their automatic minimum size); a text area with text also adds about 0.4 pixel error at 420px | fixtures: the text area on its own row, sized by the fixture's CSS | M5, `forms-vue` |
| Fractional lengths | layout | Chromium converts each CSS length to a layout unit (1/64 px, truncated: `7.7px` is 7.6875px) before layout; Blitz lays out the exact floats, so boxes and positions differ by up to 1/64 px per length, and printed geometry differs | fixtures: lengths that are multiples of 1/64 px | M5, `measure-svelte` |
| Hit testing a scrolled container | events | a scroll container scrolled by *d* also takes pointer hits in the *d* pixels above (and left of) its box: `Node::hit_inner` tests the container's own box in scrolled coordinates | fixtures: no click targets above a scrolled container (`measure-svelte` puts the list first). A real toolbar above a scrolled list is affected | M5, `measure-svelte` |
| Line breaks after hyphens | Parley | Chromium breaks a full line after the hyphen in `1999-12-31`; Blitz does not | fixtures: shorter sample text | M5, `patterns-svelte` |
| Inherited `currentColor` in SVG | paint | Blitz draws an inline `<svg>` from a serialisation of its subtree (`node/serialize.rs` `svg_source`) that replaces the text `currentColor` in each attribute with the computed `color` of the element holding it; usvg then inherits the resolved color. Chromium inherits the `currentColor` keyword and resolves it with each element's own `color`, so a child whose CSS `color` differs (a `class` on a `path`) is drawn in its own color in Chromium and in its ancestor's in Blitz | fixtures: the paint attribute (`stroke="currentColor"`) also on the child whose color differs (`icons-*`) | M5, `icons` |
| CSS on SVG content | paint | the serialisation carries attributes only, so stylesheet properties of SVG elements do not reach usvg: `fill`, `stroke` and the other SVG paint and geometry properties, and `display`, `visibility`, `opacity`, `transform` on SVG children (checked: a `display: none` path and an `opacity: 0.3` path are drawn plainly). CSS `color` reaches it through `currentColor`; the `<svg>` box's own layout, opacity and transform apply | compiler: SVG-only CSS properties and inline styles on SVG elements are rejected (`E_CSS_PROPERTY`, `E_SVG`); stylesheet `display`/`visibility`/`opacity`/`transform` on SVG children cannot be found statically and are not rejected. Fixtures use attributes | M5, SVG spike (uncommitted comparison page) |
| `<svg>` overflow | UA, paint | Blitz's UA sheet has no rule for `svg`: strokes beyond the viewBox are drawn outside the box, and an `<svg>` flex item keeps its width where Chromium shrinks it (Chromium's UA `svg:not(:root) { overflow: hidden; overflow-clip-margin: content-box }`). With `overflow: hidden`, Blitz clips at the padding box, Chromium at the content box | runtime: the UA parity sheet sets `svg { overflow: hidden }`; fixtures: no padding on `<svg>` elements whose drawing overflows the viewBox | M5, SVG spike (uncommitted comparison page) |
| System fonts for SVG | paint | blitz-dom parses every inline `<svg>` with a usvg font database that loads all system fonts on first use (`util.rs` `FONT_DB`: 417 font files opened on the development machine); they serve `<text>`, which the compiler rejects. Release first frame: 29–30 ms for the `icons` fixtures, 24 ms for `counter-svelte` | none (a static in blitz-dom); a patch would give usvg an empty or document-font database | M5, `icons` |
| Hit testing inside SVG | events | SVG children have no layout boxes in Blitz, so a press on a painted shape targets the `<svg>`; Chromium targets the shape (`event.target`) | compiler: no listeners or refs on SVG elements. `event.target` of a press on an icon inside a listening element still differs; it is observable only through layout reads of the target | M5, from the Blitz source (`layout/construct.rs` builds no boxes under an `<svg>`; `Node::hit_inner` walks paint children); not reproduced |
| Shape anti-aliasing | paint | vello_cpu and Skia anti-alias shape edges differently: per icon box (16–48 px, `icons` case) a mean absolute error of at most 2.7/255, single edge pixels up to 81/255, total ink within −6 % to +1 % (thin strokes are lighter in Blitz: a 2 px dashed ellipse −5 %, a half-transparent arc −5 %), ink centroids within 0.2 px; dash phases, joins, caps, `fill-rule`, transforms and opacity match | none needed (within the pixel tolerance) | M5, `icons` |

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
