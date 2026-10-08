# Blitz gaps

Differences between Blitz (found at revision `89e5e61` and upstream `8b54d6d`, the fork's base), with its dependencies (Stylo, Taffy, Parley, Vello), and Chromium, found by conformance runs. They feed the Blitz upstream track (D11) and the fork assessment below. Each entry says how conformance works around the gap so that everything else stays checked.

Layers: **UA** is Blitz's user-agent stylesheet (`blitz-dom/assets/default.css`), **layout** is `blitz-dom` layout, **paint** is `blitz-paint`, **events** is `blitz-dom` event handling, **Parley** is text layout and line breaking.

The [targeted Chromium parity plan](research/CHROMIUM-PARITY.md) ranks the remaining
work by the pinned shadcn sources and editor needs, preserving these layer
boundaries. Isolated worktree fixes below are not integrated fork support.
The [control-box continuation](../conformance/results/chromium-control-boxes.md)
records the repaired UA boxes, textarea baselines/overflow, mode/strut policy and
fontless logical selections, with explicit residual geometry/paint gates.
The [text-metric continuation](../conformance/results/chromium-text-metrics.md)
adds opt-in Parley logical metrics, conditional inner-editor line height and shared
signed centering/pointer boundaries. DPR 1/2 geometry passes both new text matrices;
fractional-DPR boxes, raster placement and selected-text/RTL pointer states remain
open. Two older input crops newly fail paint after their box offset is corrected.
The [line-width continuation](../conformance/results/chromium-line-widths.md)
repairs those fractional-DPR control boxes through Stylo's opt-in CSS-pixel
rounding, preserving its device-pixel default and physical hairlines. All 176 new
width and 76 supplemental states match geometry/computed widths; raster coverage,
inline fragments and editor interactions retain separate gates.
The [inline-fragment continuation](../conformance/results/chromium-inline-fragments.md)
repairs first-font span bounds and short-line scroll overflow, sharing positioned
run geometry with pointer targets. All 108 font-size/line-height states match
geometry/fragment lists; the full new matrix passes 189/363 bounding states and
270/363 hits, with 12 newly exposed narrow-gap hit failures. All 2,579 retained
direct states preserve their passing gates and all 389 compiled states pass.
The [pointer-geometry continuation](../conformance/results/chromium-pointer-geometry.md)
adds a shared private footprint for clips, inverse transforms, snapped text and
rounded contours. The new oracle passes 234/234 standard hits and 216/234 exact
point states; the 150 paired states repair 54 explicit-point failures without a
passing gate regression. Table-control hits improve 2→4/4. Main inline hits
change 270→258, effects 87→93 and text metrics 408→420, including 81 new hit losses
(60 margins, 3 nested boundaries, 9 child/parent priorities, 9 marker edges).
All paired non-hit gates and 389 compiled states preserve their passing states.
The [text-provenance continuation](../conformance/results/chromium-inline-source-order.md)
adds optional normalized source ranges in Parley and a private reverse fragment
walk in Blitz. It repairs 69 paired standard-hit states and three explicit-point
states, including all 12 preceding nested/effects losses. Main hits are 261/363,
effects 102/102 and pointer explicit points 219/234. The new oracle passes
192/216 hits and 186/216 geometry states, with 18/18 explicit-point states.
Three new middle-alignment hit losses expose the unchanged 0.296875px metric
error; 60 margin-flow and nine marker losses remain. No paired non-hit gate
regresses, and all 389 compiled states retain their gates.
The [middle-metric continuation](../conformance/results/chromium-middle-metrics.md)
repairs those three geometry/fragment/hit failures through Parley's opt-in hinted
x-height fallback. The new 180-state matrix passes 120 geometry, 60/120 fragment
lists, 138 hits and 75 strict pixel states. All 3,674 exact direct pairs preserve
their passing gates; all 389 compiled states retain theirs. Sixty nested-middle
geometry states still fail, with 27 atomic and 15 nested hit failures in the new
matrix. Device/unquantized behavior and declared font metrics are preserved.
The [nested-alignment continuation](../conformance/results/chromium-nested-alignment.md)
repairs all 60 nested-middle geometry and fragment-list failures with a private
per-line descendant union in Parley and fixes atomic length-shift scaling in
Blitz. The middle matrix now passes 180/180 geometry, 120/120 measured
fragment states, 147 hits and 78 strict pixels. A new 72-state oracle passes
66 geometry, 57 fragments and 63 hits, with 0 strict pixels. Six empty-span
geometry states remain failed. All 3,746 exact direct pairs preserve passing
nonpixel gates, with 10 strict pixel repairs and 7 pixel regressions. All 389
compiled states retain their gates. Device/unquantized behavior,
the prior x-height repairs and public interfaces are preserved.
The [text-paint continuation](../conformance/results/chromium-text-paint-origins.md)
repairs all seven preceding pixel regressions through private CSS fragment anchors
in Blitz, without changing logical geometry or renderer hinting. Middle pixels
improve 78→89/180; the new paint-origin oracle improves 38→85/108
with 108/108 geometry and fragments. Across 3,890 exact direct pairs, 63 strict
pixel states are repaired without a measured gate regression. All 389 compiled
states retain their gates.
The additive Parley primary-font metrics getter preserves existing layout policy.
Tight child crops, sticky materialization history, layer-local/transformed anchors,
containment/SVG and complete bidi fragment provenance remain independent gaps.
The [empty-inline continuation](../conformance/results/chromium-empty-inline.md)
materializes standards-mode zero-advance spans in Parley and consumes their own-font
fragments in Blitz. All 108 new geometry/list/hit states pass; strict pixels are
21/108. The retained nested matrix now passes 72 geometry, 63 fragments and 69 hits
out of 72, with 0 pixels. A private normalized boundary stream repairs all 42 new
ligature geometry/list failures while preserving 42 hits. Tight shaping pixels
change 11→6/42, with six repairs and eleven new failures. All 4,040 exact direct
pairs preserve passing retained gates; all 389 compiled states retain their gates.

The next patches need explicit caller shaping-boundary intent and generic span-edge
flow in Parley, then CSS binding in Blitz. Geometric alignment cannot distinguish
CSS vertical-align:0px from baseline; nonempty boundaries and horizontal edges
remain open. Full deferred nested top/bottom
alignment, DOM sibling heuristics, fragment lists, preserved tabs/RTL atomic
flow, odd-height/negative-origin hits and local glyph paint retain independent
gates.

## Rendering and layout

| Gap | Layer | Observed | Workaround | Found |
|---|---|---|---|---|
| Default focus ring of text inputs | UA, paint | Chromium draws a 2px `#101010` ring over the border with a 1px white halo (`outline: auto`); Blitz draws a 2px blue outline outside the border and ignores `outline-offset`, so the ring cannot be matched from a UA stylesheet | fixtures: an author `input:focus` style (`outline: none` plus a border colour) | M3, `components-svelte` |
| Inline checkboxes | layout | a checkbox inline with its label text makes the line 2–3px taller, and the inline `<label>`'s box differs ([inline boxes](#rendering-and-layout)) | fixtures: a checkbox's `<label>` is a flex container | M3, `components-svelte`; M6, `blitz-inline-baselines` (the row was left out of the case) |
| Checkbox box model | layout | author padding, borders and `flex` change a checkbox's box in Blitz; Chromium ignores them for native checkboxes | fixtures: style text inputs by id or type, not `input` | M3, `todomvc-svelte` |
| Radio metrics | UA | Blitz: 14×14 with margin `3px 3px 3px 4px`; Chromium: 13×13 with margin `3px 3px 0 5px` | runtime: the UA parity sheet | M5, `radio-svelte` |
| Form-control font size | UA | Chromium's controls use `font: -webkit-small-control` (13.33px); Blitz inherits | runtime: the UA parity sheet | M3 |
| Text input line height | layout | with `line-height: normal`, a text input's line box is fractional in Blitz (21.59px for an 18px DejaVu font) and rounded in Chromium (21px) | fixtures: an explicit `line-height` on text inputs | M3, `todomvc-svelte` |
| `<select>` | paint, events | nothing is drawn for a select: no closed control, no popup | runtime: a UA sheet draws the closed control from its options (grid-stacked, the shown one marked by an attribute that snapshots omit, a rotated-border arrow), and the runtime draws the popup into the page and implements its keyboard and pointer model. Headless Chromium also draws the popup into the page; windowed Chromium uses a separate widget that can extend past the window, which the runtime cannot. The closed control relies on the UA sheet's `display: inline-grid`: an author `display: block` stacks the options (fixtures keep the default display or make the select a flex item) | M5, `select-svelte`, `select-popup`, `7guis-flight` |
| `<input type="range">` | paint, events | nothing is drawn and there is no slider behaviour | none: examples use buttons (7GUIs Circle Drawer) | M5, `7guis-circles` |
| Text in fonts the app does not embed | paint | native builds load only the app's embedded fonts (no system fonts), so text whose font stack names none of them (the UA's `system-ui, sans-serif` on buttons and inputs, or generic families) is not drawn at all; Chromium falls back to a system font | runtime: text with visible characters that lays out to zero width stops a probe (`E_FONT`, naming the text, its element and its font stack) and is reported once on stderr by an app; fixtures set the embedded family on controls. A compile-time check remains to do | M6, `derived-equality-svelte` |
| Textarea resize grip | paint, events | Chromium draws a resize grip on text areas and lets the user drag it (UA `resize: both`; Tailwind's preflight sets `vertical`); Blitz has no grip, and Stylo's servo mode does not parse `resize` | none: the compiler accepts `resize` (the default already differs); the whole-viewport pixel gate cannot see the small grip, fixtures with text areas set `resize: none` | M3, M6 |
| Overflowing textarea | layout | a textarea whose text is taller than its box shows scrolled in Blitz and unscrolled in Chromium | fixtures: a textarea tall enough for its text | M5, `patterns-svelte` |
| Text controls in an overflowing flex row | layout | text inputs and text areas in a flex row too narrow for them are laid out about 53px narrower than in Chromium (their automatic minimum size); a text area with text also adds about 0.4 pixel error at 420px | fixtures: the text area on its own row, sized by the fixture's CSS | M5, `forms-vue` |
| Fractional lengths | layout | Chromium converts each CSS length to a layout unit (1/64 px, truncated: `7.7px` is 7.6875px) before layout; Blitz lays out the exact floats, so boxes and positions differ by up to 1/64 px per length, and printed geometry differs | fixtures: lengths that are multiples of 1/64 px | M5, `measure-svelte` |
| `:target` | style | Blitz's selector matching never matches `:target`; Chromium matches the element a followed fragment link names | compiler: `:target` selectors are rejected (`E_CSS`); the runtime follows links to fragments naming an element (scrolling and focus, docs/IR.md, links), which match no `:target` rule since none is accepted | M6, `blitz-dom/src/stylo.rs` |
| `<svg>` overflow | UA, paint | Blitz's UA sheet has no rule for `svg`: strokes beyond the viewBox are drawn outside the box, and an `<svg>` flex item keeps its width where Chromium shrinks it (Chromium's UA `svg:not(:root) { overflow: hidden; overflow-clip-margin: content-box }`). With `overflow: hidden`, Blitz clips at the padding box, Chromium at the content box | runtime: the UA parity sheet sets `svg { overflow: hidden }`; fixtures: no padding on `<svg>` elements whose drawing overflows the viewBox | M5, SVG spike (uncommitted comparison page) |
| `preserveAspectRatio` | paint | Blitz draws an inline `<svg>` by mapping its viewBox into the size its `width`/`height` attributes give (usvg) and fitting that drawing into the CSS content box as `object-fit: contain`; Chromium maps the viewBox into the content box by `preserveAspectRatio`. The two agree for the default `xMidYMid meet` only, whatever the CSS size | compiler: `preserveAspectRatio` is rejected (`E_TEMPLATE`); bits-ui's Arrow carries `none`, in a branch shadcn's tooltip never renders | M6, `blitz-paint/src/render.rs` `draw_svg` |
| System fonts for SVG | paint | blitz-dom parses every inline `<svg>` with a usvg font database that loads all system fonts on first use (`util.rs` `FONT_DB`: 417 font files opened on the development machine); they serve `<text>`, which the compiler rejects. Release first frame: 29–30 ms for the `icons` fixtures, 24 ms for `counter-svelte` | none (a static in blitz-dom); a patch would give usvg an empty or document-font database | M5, `icons` |
| Hit testing inside SVG | events, style | SVG children have no layout boxes in Blitz, so a press on a painted shape targets the `<svg>`; Chromium targets the shape (`event.target`). For the same reason `:hover` and `:active` never match an SVG child in Blitz, which matters now that CSS reaches SVG content | compiler: no listeners or refs on SVG elements; a selector giving an SVG child element type (`path:hover`, `g:active rect`, also through nesting and `:is()`) a pointer state is rejected (`E_CSS`). A class selector with `:hover` that lands on an SVG child cannot be found from the stylesheet and is not rejected. `event.target` of a press on an icon inside a listening element still differs; it is observable only through layout reads of the target | M5, from the Blitz source (`layout/construct.rs` builds no boxes under an `<svg>`; `Node::hit_inner` walks paint children); not reproduced |
| Tailwind 4 output | style, layout, paint | `field-sizing`, `line-clamp`, `text-wrap: balance`, `scroll-margin` and container units (`cqw`, …) are not supported by Stylo's servo mode (container queries are, through the forks, below) | M6 compiler: Stylo as a build-time oracle reports them, at build time, or, in a style rule without pseudo-elements, at run time once the rule matches an element where no later rule of at least its specificity sets the property (scroll margins: once such an element is scrolled into view; `line-clamp`'s `-webkit-line-clamp` and `-webkit-box-orient` where its `display: -webkit-box` applies, measured in Chromium 153); fork patches for the ones the editor needs ([M6-CSS](research/M6-CSS.md)) | M6, CSS research; `blitz-container-queries` (container units) |
| `animation-fill-mode: forwards` / `both` | style (Stylo) | Stylo's servo mode keeps a finished animation's filled values only until its element is next restyled (`process_animations_for_style` drops finished animations); a hover after the end restores the unfilled value. Chromium keeps the fill | compiler: rejected (`E_CSS_PROPERTY`), also through `var()` | M6, animations (probe check) |
| Animations in `display: none` subtrees | style (Stylo) | Stylo does not restyle elements under a `display: none` ancestor, so their animations keep their state and run on; Chromium cancels them, and a new animation starts when the subtree is shown again | runtime: `getAnimations()` lists none for such elements and cancels their objects (`finished` rejects), as Chromium does; the rendering after the subtree is shown again is not handled | M6, from the Stylo and Blitz source; not reproduced |
| Animation iterations shorter than a frame | style (Stylo) | Stylo advances an animation by at most one iteration per style resolution (`iterate_if_necessary`), so an iteration shorter than the time between resolutions shows its last keyframe and falls behind | none (the runtime resolves at every frame natively and in probe waits) | M6, from the Stylo source; not reproduced |
| Backdrop filters | paint | the renderers' backdrop (CPU and GPU) is everything painted behind the element, where Chromium stops at the nearest Backdrop Root ancestor (opacity, filter, clip-path, mask, mix-blend-mode; checked in Chromium 153). An element with both `filter` and `backdrop-filter` keeps one layer, so its backdrop is clipped with the filter's reach (and to the bounding rectangle of rounded corners) | runtime: `E_FILTER` for a backdrop-filtered element with a Backdrop Root ancestor or also a `filter` | M6, CPU renderer research |
| Absolutely positioned content in the scroll size | layout | Chromium counts absolutely positioned descendants in a scroller's (and the document's) scrollable overflow; Blitz leaves them out (a document 1536px tall in Blitz, 1558px in Chromium), which changes `scrollHeight` and floating-ui's `document` clipping rectangle | fixtures: absolutely positioned content inside the document's content box | M6 overlays, floating-ui platform vectors |
| Inline boxes | layout | an inline element's `offsetWidth` is 0 in the runtime where Chromium gives the bounding box of its line fragments (0 against 30 measured), and `getClientRects()` has one rectangle per line box in Chromium | runtime: floating-ui's `getCssDimensions` of such an element and `getClientRects()` of an inline element are reported unsupported | M6 overlays |
| Web fonts while the app mounts | layout | Chromium loads the app's `@font-face` fonts (data URLs) after the app's module has mounted it, and lays text out with a fallback font until then; native builds have the embedded fonts from the start. Layout read while the app mounts differs (a 47-character 14px line measured 272px in Chromium, 340px natively and in Chromium once loaded; bits-ui's accordion measures its open content's height while it mounts) | fixtures: content that reads layout while mounting mounts after a first action (the accordion fixtures' Show button); the harness waits for fonts only after mounting | M6, `bits-accordion-svelte` |
| `text-transform` | layout | Blitz transforms text to upper and lower case only: `capitalize`, `full-width` and `full-size-kana` leave it unchanged (shadcn-svelte's toggle-group-spacing labels stay lower case) | compiler: rejected (E_CSS_PROPERTY); the fixture keeps Tailwind's `capitalize` out of its stylesheet | M6, `bits-toggle-group-single-svelte` |
| `position: sticky` | layout, paint | Blitz lays sticky boxes out as relative ones (Taffy has the position, blitz-paint never offsets them): when their scroll container scrolls they scroll away, where Chromium keeps them in view (the shadcn-svelte site's header, sidebar and table of contents; a native probe found the kit-docs fixture's table of contents scrolled out of view, 2026-10-06) | compiler: rejected (`E_CSS_PROPERTY`), also through `var()`; the kit-docs fixture scrolls its page in a pane of its own. A Blitz fork patch (sticky offsets from the scroll container at paint and hit testing) would lift it | M6, `kit-docs-svelte` |
| Glyph rasterisation | paint (Glifo/Vello) | with identical boxes, small text in a dense region differs by more than 3/255 (3.8/255 over a 388×36 row of four 14px toggle labels and a centred button label; the same row passes at 800px). Measured 2026-10-05: sampled glyph positions agree; coverage differs. A paint-only quarter-grid experiment was dropped. The 2026-10-07 isolated renderer worktree instead rounds complete hinted device origins with atlas carry and uses TrueType light auto hinting: both table text failures pass, but new positive/negative fractional-origin controls still fail at 4.063/4.100 per 255. [Evidence](../conformance/results/blitz-tables.md) | no fixture adjustment; compiler integration and broader font/DPR/cache coverage remain pending | M6, `bits-toggle-group-svelte`; table experiment |
| Rounded dotted borders and corner hits | paint, events | the ordinary 5px dotted-border control with a 12px radius and fractional origin differs by 27.407/255 locally; Blitz also hits a rounded-away corner that Chromium omits. The square-border control passes. This is separate from the now-passing collapsed table borders | retained failing control `border_dots5_rounded`; [plan](research/CHROMIUM-PARITY.md) | 2026-10-07, expanded table/primitive oracle |
| `<br>` in a flex container | layout | Blitz wraps only text runs in a flex container in anonymous items, so a `<br>` between two runs is an item of its own: `Ab<br>Cd` in an `inline-flex` or `flex` button lays the runs side by side (18.5px wider); Chromium keeps text and `<br>` in one anonymous item, on two lines (grid containers and flow buttons match) | fixtures: two-line labels wrap in a fixed width (`blitz-button-baseline`) | M6, `blitz-button-baseline-svelte` |
| Shape anti-aliasing | paint | vello_cpu and Skia anti-alias shape edges differently: per icon box (16–48 px, `icons` case) a mean absolute error of at most 2.7/255, single edge pixels up to 81/255, total ink within −6 % to +1 % (thin strokes are lighter in Blitz: a 2 px dashed ellipse −5 %, a half-transparent arc −5 %), ink centroids within 0.2 px; dash phases, joins, caps, `fill-rule`, transforms and opacity match | none needed (within the pixel tolerance) | M5, `icons` |
| Text decoration offsets | paint | with identical glyphs, an underline one device pixel higher and a line-through one lower than Chromium's (both snapped to whole pixels since `e8dd36c`): Blitz rounds the font's underline position and a third of the ascent from the unrounded baseline | — (case `text-elements` declares it) | M6 element sweep |
| Generated content other than strings | layout | `content: open-quote`, `close-quote`, `counter()`, `attr()` and images generate nothing (`pe_content_text` keeps strings), so `<q>` has no quotation marks | the collector rejects such `content` values; `<q>` stays outside the element list | M6 element sweep |
| Fractional line boxes | layout | Parley rounds line heights (`quantize`); Chromium keeps them in LayoutUnits, so after a line of fractional height (a `sup` and a `sub` with the user agent's line height: 30.53px) everything below is up to half a pixel off | fixtures give `sup` and `sub` `line-height: 0`, as Tailwind's preflight does | M6 element sweep |
| Tables | layout, paint | integrated pin: grid approximation drops captions, content sizing, row/group boxes and vertical alignment. The isolated `table-layout` worktree supplies a formatting context and passes 69/69 table states for geometry, internal hits and local pixels; all three previously retained pixel failures are fixed. [Implementation](research/BLITZ-TABLES.md), [results](../conformance/results/blitz-tables.md) | tables stay outside the compiler element list pending the responsive/interactive/framework integration gate in the [plan](research/CHROMIUM-PARITY.md) | M6 element sweep; table experiment, 2026-10-07 |

## Fixed in the fork

The fork is [`Runic-Artifex/blitz`](https://github.com/Runic-Artifex/blitz), branch `runic`, one commit per gap on upstream `8b54d6d`. Each has a conformance case that fails without it (checked against the unpatched base, 2026-10-04; *Colour stop fix-up* through *Grid container baselines* against the pin before each, 2026-10-05; *Inline baselines* against the pin before it, 2026-10-06; *Unstyled layout children* against the pin before it, 2026-10-07). Commits marked *runic* support the runtime's own emulation and are not offered upstream.

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
| `currentColor` of a non-sRGB colour in SVG | the serialisation for usvg wrote the computed `color` in its own space (`oklch(…)` in the shadcn themes), which usvg does not parse, so such icons were not drawn | *Resolve currentColor in inline SVG to sRGB*: converted as painting converts colours, written as `rgba()` | `shadcn-basics` (lucide icons under the shadcn theme; paint only, screenshots inspected 2026-10-04) |
| Text colour in flex and grid containers | the anonymous blocks wrapping text in a flex or grid container (default buttons are `inline-flex`) kept the style they got at box construction, so a `:hover` or state colour (or a colour transition) never reached their text | *Restyle anonymous blocks when their parent is restyled* (from the animations work) | `blitz-anonymous-restyle` (fails without the patch on the hover step) |
| 3D transforms | transforms whose matrix is not 2D were dropped (`translate3d`/`scale3d` in tw-animate-css's keyframes, `rotateX`/`rotateY`) | *Apply 3D transforms without perspective, flattened*: the affine part divided by m44 when there are no perspective terms (perspective stays unsupported) | `tailwind-animate` (a `zoom-in-95` panel mid-animation) |
| `woff2-variations` fonts | `format("woff2-variations")` sources were skipped, and so were `data:` URLs without a known format (the extension lookup returned early) | *Load fonts with legacy \*-variations format hints and data: URLs*; the collector accepts the hint | `blitz-line-breaks` (the paragraph uses such a font) |
| `:placeholder-shown` | never matched | *Support :placeholder-shown*: the state follows the control's value, synced before each style pass | `blitz-placeholder-shown` |
| `:focus-within` | never matched | *Support :focus-within*: focus changes set `FOCUS_WITHIN` on the focused element and its ancestors | `blitz-focus-within` |
| `:focus-visible` | never matched; focusing always set `FOCUSRING` | *Let embedders set whether the focused element is focus-visible*; the runtime applies Blink's modality rule (below) | `blitz-focus-visible` |
| Angle gradients | a `linear-gradient(<angle>, …)` was centred on the border box instead of the background tile: off by the border width under `background-origin: padding-box` (6.4/255 for a 6 px border), by half a tile with `background-size: 200%` (52.6/255) | *Centre angle gradients on the background tile* | `blitz-gradients` (both renderers) |
| Colour stop fix-up | a stop position below an earlier one (`conic-gradient(#000 0 25%, #fff 0 50%)`) was not raised to it (CSS Images 3), so the stops reached the renderer unsorted and vello_cpu filled the gradient with its first colour (100.7/255) | *Raise colour stop positions to the largest earlier one* | `blitz-gradients` (both renderers) |
| Inherited `currentColor` in SVG, CSS on SVG content | an inline `<svg>` was drawn from its subtree's attributes, `currentColor` replaced with the colour of the element holding it: stylesheet `fill`, `stroke`, `display`, `visibility`, `opacity` and transforms of SVG content did not reach usvg, and a child whose `color` differs was painted in its ancestor's | *Draw inline SVG with each element's computed SVG properties*: presentation attributes are part of the cascade (author level, zero specificity; `transform` parsed with SVG's syntax), and the source for usvg carries each element's computed painting properties, `currentColor` resolved per element; children with `display: none` are left out; children's `visibility`, `opacity` and transforms (about the user-space origin, `transform-origin: 0 0` in the UA sheet as in Chromium) are written as computed. Stylo's servo mode computes `fill`, `stroke` and their longhands; the other SVG properties stay rejected | `blitz-svg-css` (region error up to 41.5/255 before, at most 1.4/255 after), `bits-toggle` (shadcn-svelte's toggle-demo: 7.0/255 before on its region while pressed) |
| Form-control line height | controls inherited the line height; Chromium's UA font gives them `line-height: normal` (a button under `line-height: 32px` 17px taller, a two-row text area 34px) | *Give form controls line-height: normal* (Blitz's UA sheet) | `blitz-control-line-height`; the `portal` fixture's explicit button line height is gone (4px off before) |
| Buttons with an author `display`, flex buttons without `justify-content` | the UA sheet's `inline-flex` with centred alignment: an author flex button kept its content centred (shadcn-svelte's Switch thumb 5–7px right), an author `display: block` button stretched with its content at the top | *Lay buttons out as browsers do*: `<button>` is an inline-block; a button with a flow display is laid out as HTML's anonymous button content box (all content in one anonymous block, the single item of a nowrap flex column with `justify-content: safe center` and `align-items: stretch`), shrink-to-fit when block-level in a block container; author flex and grid buttons get no UA alignment | `blitz-buttons` (label 57px off, a block button 344px wide before), `bits-switch` (no longer a known gap), `virtual-list` (rows with an inline-block and text) |
| Filtered elements, `drop-shadow()` in `currentColor`, backdrop corners | an element's outline and outer box shadows were drawn outside its opacity or filter layer, which was clipped to the border box (cutting off overflowing content); a `drop-shadow()` without a colour was black; a backdrop showed outside rounded corners | *Paint filter and opacity layers over the element's whole rendering*: decorations inside the layer, the layer clip grown to them and the scrollable overflow; a backdrop without `filter` in its own layer clipped to the rounded border box; `currentColor` resolved with the element's `color` | `blitz-filter-layers` (regions 4.2–9.3/255 before, at most 2.5/255 after; both renderers) |
| Button baselines | with buttons as inline-blocks (*Lay buttons out as browsers do*), the CSS 2.1 rule put a button's baseline at its bottom margin edge when `overflow` is not `visible` (floating-ui's reference button, `overflow: hidden` with an author line height, pushed the content below it 4px down); a flow button gave its content's first line on a line, not its last, and as a flex item one synthesized from its content's bottom edge; an empty button sat on its bottom margin edge | *Give buttons Chromium's baselines*: as Chromium's LayoutButton (measured in Chromium 153 over `overflow` visible, hidden, auto and clip, author `display`, line heights and empty buttons), a button is a flex box whatever its `display`: a flow button exports its anonymous content box's baselines (the last line on a line, the first as a flex or grid item; none for an item without a line), clamped to the border box when it is a scroll container (`hidden`, `auto`; not `clip`); a button without a baseline (empty, only block or out-of-flow content, `contain: layout`) sits on a line at its content box's bottom edge | `blitz-button-baseline` (before: 159 boxes per viewport more than 2px off, whole-viewport pixels 3.1–15.0/255; after: within 0.04px, 0.2–0.7/255) |
| Grid container baselines | Taffy computes baselines only for grid items aligned on baselines, so a grid container's first baseline was synthesized from the bottom edge of its first row's first item (the line of an inline-grid button 2px taller than Chromium's, 10px with a wrapping label) | *Give grid containers their first item's baseline*: that item's first baseline (css-grid-1 §10.8), clamped if it is a scroll container; an item without one keeps the synthesized baseline | `blitz-button-baseline` (inline-grid and grid buttons; inline grids with a padded first item and an item placed in the second row) |
| Inline baselines | text inputs exported no baseline, so an input sat on its line with its bottom edge and the line grew by the strut's descent (a text input alone in a block 4–7px taller, beside text in a `<p>` 4.8px shorter); and when a line was only measured, as a flex item's height is, inline-flex and inline-grid boxes and buttons were measured without their baselines (a 36px inline-flex button alone in a block inside a flex column 7px taller: shadcn-svelte's toggle-with-text demo and the dialog demo's trigger in its `<form>`) | *Give single-line text inputs a baseline*: the editor line's, centred in the content box as it is painted; *Lay inline boxes out in full when a line's height is measured*, as Taffy does for items aligned on baselines | `blitz-inline-baselines` (block flow, a flex column and flex rows; before: the shadcn-svelte dialog's Label and Input rows 7px taller) |
| Container queries | `query_container_size` was a stub reporting an unknown size, so every container query was false (and Stylo's servo mode did not parse `@container`, below) | *Support container queries*: a size query container reports the content box of its last layout; when one's size changes, its descendants are restyled and the document laid out again in the same resolve (as many passes as containers are nested, at most 4); `container-type: size \| inline-size` applies layout containment and an intrinsic inline size as if empty | `blitz-container-queries` (new: at the previous pins the compiler rejected `@container`), `bits-dialog` (shadcn-svelte's Field.Group) |
| Unstyled layout children | the debug check that every layout child points back at its container also checked elements inside `display: none` subtrees, which keep layout children from before until they are styled again, and panicked on one naming a node removed since (bits-ui's Command hides a group while items in it are removed) | *Skip unstyled elements in the layout-parent consistency check* | `bits-command` |
| `vertical-align: sub` and `super` | Parley shifted by a fifth and a third of the parent's font size; Blink adds a pixel to both, so a line with both was 2.5px shorter | `487d5cc` | `text-elements` |
| Text decorations antialiased | underlines and line-throughs were stroked at fractional positions (blurred two-pixel lines); Blink snaps their top to a device pixel and draws whole pixels (`DrawLineForText`) | `e8dd36c` | `text-elements` |

## Fixed in the renderer forks

Local forks of linebender/vello (`vello_cpu`, `vello_common`, `glifo`, and `vello`, `vello_encoding`, `vello_shaders` of the GPU renderer) and DioxusLabs/anyrender, branch `runic` on the published releases, pinned with `[patch.crates-io]` ([M6-CPU-RENDERER](research/M6-CPU-RENDERER.md#the-forks)). The cases fail without them (CPU checked 2026-10-04, GPU 2026-10-05 with `--renderer gpu`).

| Gap | Was | Commits | Case |
|---|---|---|---|
| CSS filter functions in the CPU renderer | `anyrender_vello_cpu`'s `filters` feature was off; with it on, vello_cpu 0.3 panicked on colour-matrix filters (`brightness()`, `grayscale()`, …) | vello: upstream PR #1765 (`ColorMatrix`), cherry-picked | `filters` |
| Filter lists | only the first function was drawn, and a graph with more primitives panicked | vello: chains run in order, with summed expansions and consecutive matrices in one float pass; anyrender: lists converted whole, expansions summed | `filters` |
| `backdrop-filter` | ignored by the CPU renderer | anyrender: the painter records the frame and replays it to draw the backdrop (`backdrop_filters` feature) | `backdrop-filters` |
| Filters and backdrop filters in the GPU renderer | `anyrender_vello` dropped both (regions up to 52.3/255) | anyrender: filtered layers are rendered offscreen by Vello, filtered by wgpu render passes and drawn back as images; backdrops are rendered from the frame so far ([GPU section](research/M6-CPU-RENDERER.md#the-gpu-renderer)) | `filters`, `backdrop-filters` with `--renderer gpu` |
| Gradients and box shadows half a pixel off in the GPU renderer | vello's fine shader evaluated gradients and blurred rounded rectangles at pixel corners (a five-stop gradient 3.4/255, a repeating radial gradient 9.2/255) | vello: sampled at pixel centres | `gradients` with `--renderer gpu` |
| Synthetic italic in the CPU renderer | glyphs leaned left: Blitz gives the skew in font space (y up), vello_cpu applied it after flipping to layout space | anyrender: `22b336b` (conjugates the glyph transform with the flip) | `text-elements`, `style-objects` |

## Fixed in the Stylo fork

A fork of servo/stylo ([`Runic-Artifex/stylo`](https://github.com/Runic-Artifex/stylo), local clone `/home/viktor/Development/RunicArtifex/stylo`), branch `runic` on tag `v0.22.0` (`34d25f7`, the commit the published `stylo` 0.22.0 crates were packaged from; their sources are identical), signed commits; each commit message explains its patch. The workspace pins it with `[patch.crates-io]` for every crate of the repository in the graph (`stylo`, `stylo_atoms`, `stylo_derive`, `stylo_dom`, `stylo_malloc_size_of`, `stylo_static_prefs`, `stylo_traits`, `selectors`, `servo_arc`, `to_shmem`, `to_shmem_derive`). Both patches are small enough to offer upstream.

| Gap | Was | Commit | Case |
|---|---|---|---|
| Eased animations | Stylo's servo mode solved a cubic-bezier timing function (`ease`, `ease-out`, …) with an epsilon of `1 / (200 × duration in seconds)` (`PropertyAnimation::timing_function_output`): 0.025 for a 200 ms animation, so a frame was eased up to about 2% off. A 200 ms `ease-out` height animation from 0 to 1000px at 16/50/100 ms: Chromium 129.625/378.125/684.641px, Blitz 146.34/379.77/694.67px, now 129.63/378.14/684.64px | `9ff5306` *servo: Solve cubic-bezier timing functions to Chromium's precision*: Chromium's `kBezierEpsilon`, 1e-7, for animations and transitions | `bits-accordion`, `bits-accordion-multiple` (mid-animation frames; they were a known gap of geometry and pixels before) |
| Animations cancelled by a style change | an animation whose name the new style no longer lists was cancelled without recascading the element (`update_animations_for_new_style` did not mark the animation set dirty), so the element kept the animation's last values until it was next restyled; Chromium shows the unanimated style at once. bits-ui sets `animation-name: none` and measures the content, which read the animated height. The runtime restyled such elements once more after each resolution (`animations::restyle_cancelled`, removed) | `e251013` *servo: Recascade an element whose animation a style change cancels*: the set is marked dirty, as for cancelled transitions | `bits-accordion`, `bits-accordion-multiple`, `bits-collapsible`: with only the easing patch and without the runtime restyle, all three fail every gate (checked 2026-10-05; bits-ui measures the collapsible content at its animated 19.2px instead of 60px) |
| Keyframes reading changed variables | an element's running CSS animations kept the keyframe values computed when they started (`needs_animations_update` ignored custom properties), while browsers resolve `var()` in keyframes against the element's current style: tw-animate-css's `slide-in-from-*` take the direction from variables, which floating-ui's flip changes through `data-side` after the animation started (a submenu flipped to the left slid in from the right side, 16px off for the animation's first frames) | *servo: Update CSS animations when custom properties change* | `bits-dropdown-menu` (420px) |
| `@container` in servo builds | the `@container` rule and the `container` shorthand were parsed in Gecko builds only, whatever `layout.container-queries.enabled` says (the `container-type` and `container-name` longhands followed the pref) | *servo: Parse @container and the container shorthand behind a pref* | `blitz-container-queries` |
| `<mark>` colour | the light-scheme `Mark` system colour was (255, 235, 59); Chromium paints yellow (255, 255, 0) | `260e70f` | `text-elements` |

## Fixed in the Taffy fork

A fork of DioxusLabs/taffy ([`Runic-Artifex/taffy`](https://github.com/Runic-Artifex/taffy), local clone `/home/viktor/Development/RunicArtifex/taffy`), branch `runic` on Blitz's Taffy revision `ceb7443`, signed commits; the workspace patches the git source (`[patch."https://github.com/DioxusLabs/taffy"]`), and generated apps repeat every patch section. Taffy's own tests pass (its 6,225 Chrome-generated fixtures included).

| Gap | Was | Commit | Case |
|---|---|---|---|
| Percentage flex basis against an indefinite main size | a percentage `flex-basis` that could not be resolved (the container's main size indefinite) was replaced by the item's main size property, where css-flexbox-1 and Chromium use `content`: bits-ui's Select viewport (`flex: 1 1 0%`, `height: var(--bits-select-anchor-height)`) in its auto-height content was 36px tall instead of its items' 196px, showing the scroll buttons | *Flexbox: an unresolvable percentage flex basis is content* (`e7be3d5`), with a hand-written test | `bits-select` |

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

> **Status note (2026-10-07).** This assessment is from 2026-10-04, before the fork. Several gaps it lists as needing a patch have been fixed since (shrink-to-fit widths, placeholders, hyphen line breaks, inline baselines, hit testing a scrolled container: see [Fixed in the fork](#fixed-in-the-fork)). Open rendering gaps are summarised in the [gap register](GAPS.md) (P4).

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
| Inherited `currentColor`, CSS on SVG content (found after the upstream check) | upstream has an unmerged branch with the same approach (`devin/1785529235-svg-computed-paint`: presentation attributes as hints, computed paint properties serialised; paint properties only) | fixed in the fork (above), about 250 lines with the serialiser |
| System fonts for SVG (found after the upstream check) | not checked | an option for the usvg font database, a few lines in `util.rs` |
| `currentColor` of a non-sRGB colour (found in M6) | not checked | convert to sRGB before serialising (`node/serialize.rs`, `write_outer_html_in_style`), a few lines |
| Filters: `drop-shadow()` colour, backdrop corners, outline and shadows outside the filter layer (found in M6) | not checked | fixed in the fork (above), about 100 lines in `render.rs`, `filters.rs` |
| Angle gradients, colour stop fix-up (found in M6) | not checked | fixed in the fork (above); both are small enough to offer upstream |
| Form-control line height, button layout (found in M6) | upstream gives controls a UA font family only (`devin/1790294707-form-control-fonts`); buttons are still `inline-flex` | fixed in the fork (above): a UA rule, and about 80 lines in `node.rs`, `construct.rs` and `stylo_taffy`; button baselines about 90 lines in `layout/mod.rs`, `inline.rs` and `node` |
| Grid container baselines (found in M6) | a Taffy gap (grid item baselines are computed for baseline-aligned items only); upstream not checked | fixed in the fork (above) from Blitz's side, about 70 lines in `layout/mod.rs`; the fix belongs in Taffy |

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
