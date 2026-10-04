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
| `<select>` | paint, events | nothing is drawn for a select: no closed control, no popup | runtime: a UA sheet draws the closed control from its options (grid-stacked, the shown one marked by an attribute that snapshots omit, a rotated-border arrow), and the runtime draws the popup into the page and implements its keyboard and pointer model. Headless Chromium also draws the popup into the page; windowed Chromium uses a separate widget that can extend past the window, which the runtime cannot | M5, `select-svelte`, `select-popup` |
| Overflowing textarea | layout | a textarea whose text is taller than its box shows scrolled in Blitz and unscrolled in Chromium | fixtures: a textarea tall enough for its text | M5, `patterns-svelte` |
| Line breaks after hyphens | Parley | Chromium breaks a full line after the hyphen in `1999-12-31`; Blitz does not | fixtures: shorter sample text | M5, `patterns-svelte` |

## Behaviour the runtime implements

These work today and are covered by conformance. The cost is code in `runic-runtime` that cancels or reorders Blitz's own handling.

| Gap | Layer | Observed | Runtime | Found |
|---|---|---|---|---|
| Click default action | events | Blitz's default click action moves or clears focus, unlike Chromium (focus moves on `mousedown`, a click on a non-focusable element keeps it) | always cancels Blitz's click default and implements focus, label activation and checkbox and radio activation itself (`events.rs`) | M5, `focus` |
| Focus events and sequential navigation | events | Chromium's `blur`/`focusout`/`focus`/`focusin` order with `relatedTarget`, `tabindex` focusability and positive-`tabindex`-first Tab order | `move_focus` and `tab_order` | M5, `focus`, `radio` |
| Pointer and mouse boundary events | events | Blitz interleaves pointer and mouse boundary events; Chromium sends all pointer boundary events first | buffers and replays Chromium's order | M5, `events` |
| `dblclick` | events | Blitz drops `dblclick` when the click was cancelled (which the runtime always does) | counts clicks itself | M5, `events` |
| Text control guards | events | Blitz dispatches `input` after the editor changed, not cancelable; no read-only or disabled guards, no `maxlength` | checks before mutation (`controls.rs`) | M3 |
| Wheel deltas | events | Blitz's wheel deltas have the opposite sign to the DOM's (a convention, not a defect) | negated when the DOM event is built (line deltas as 20px) | M5, `events` |
| Inline style CSSOM | API | no `CSSStyleDeclaration`: inline styles exist only as the `style` attribute | crate `runic-css` parses and serialises with Stylo | M5, `style-directives` |

## Fork assessment

D11 already allows local patches in a documented patch set. The question is whether the gaps justify carrying one now rather than waiting for upstream.

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

**Recommendation.** Carry a thin fork from M6 on:
- **Base.** Branch at the pinned revision, so it is not a dependency upgrade.
- **Commits.** One commit per gap, each with the conformance case that shows it, each offered upstream. A patch is dropped when the pin moves past an upstream fix.
- **Wiring.** Cargo `[patch]` on the Blitz git URL.
- **Order.** Shrink-to-fit rounding (two `.ceil()` calls), placeholders, then inline control baselines and text input line height. The focus ring and textarea scrolling follow when an application needs them.
- **Parley and selects.** A Parley patch for hyphen breaks is decided separately, after checking upstream Parley. Native select popups wait for the desktop-input track.
- **Cost.** Rebasing the series when the pin moves. Pin moves are already planned work, and a small series with one case per patch keeps them cheap.
