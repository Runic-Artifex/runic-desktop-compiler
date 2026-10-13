# Text fill and backgrounds clipped to text: shadcn-svelte's shimmer (2026-10-13)

CSS compatibility slice 2. Two fork commits:

- Stylo `c7f58a4e` *servo: Parse -webkit-text-fill-color and background-clip: text* (branch `text-fill-clip` on `runic` `3a2013ca`);
- Blitz `fc2e707e` *Fill text with -webkit-text-fill-color and paint backgrounds clipped to text* and `f2e6b1ad` *Test the report of background-clip: text outside the element's own text* (branch `text-fill-clip` on `runic` `ceb522c3`).

Chromium 153.0.8010.12, CPU renderer.

## What was wrong

Stylo's servo mode parsed neither `-webkit-text-fill-color` nor `background-clip: text`, so the app reported the `.shimmer` utility (`-webkit-text-fill-color: var(--shimmer-text-fill, transparent)`) at mount: 12 examples of the 2026-10-12 render census (the shimmer examples, marker-demo, marker-shimmer, message-demo).

## Chromium's rules (measured in the harness)

- `-webkit-text-fill-color` fills the glyphs; `currentcolor` (the initial value) is `color`.
- A text decoration's `currentcolor` resolves to the fill colour, not to `color`: with `color: #c00; -webkit-text-fill-color: #036` the underline is `#036`, and a transparent fill hides the underline too.
- `background-clip: text` paints the background (the layer, or the colour with the last layer's clip) only where the element's glyphs are, within the border box. Decorations are not part of the clip: an underlined shimmer shows no underline (its colour is the transparent fill) and no background through it.

## The change

Blitz fills glyphs with the resolved fill colour and resolves decorations' `currentcolor` to it. A text-clipped background layer is painted in an isolated layer over the border box; the glyphs of the element's own inline formatting context (with its `text-overflow` ellipsis and line clamp, without decorations) are then drawn in opaque black in a nested destination-in layer, which keeps the background only under them. Both renderers composite destination-in (vello_cpu's `fine` compose, vello's layers). Where the element's text is not all in its own inline formatting context (block or atomic inline descendants, or an ordinary inline box with the clip), Blitz reports it at layout (`BACKGROUND_CLIP_TEXT_DESCENDANTS`).

## Verification

- **Compiled case `shimmer`** (fixture `shimmer-svelte`, the utility as Tailwind CSS 4 compiles it from shadcn-svelte's `tailwind.css` at `3ef557c`, with `oklch(from currentColor …)`, `color-mix`, the registered `--shimmer-angle` and the `tw-shimmer` animation): ten shimmering texts (muted and large, the angle, colour, duration and spread variants, `shimmer-once`, right-to-left, a Marker.Content flex item, a truncated attachment title with an ellipsis), `shimmer-none` toggled off and on, on virtual time through 3 s. It passes semantics, geometry and pixels at 800x600 and 420x600 (`node conformance/run.mjs shimmer --pixels`). At the old pins the app reports `-webkit-text-fill-color` at mount.
- **Rendering cases** (`node conformance/text-fill.mjs`, HTML in Chromium and Blitz's probe): fill colours (inherited, `currentColor` reset, transparent with an underline), gradients through text at three positions, a padded and bordered element with a clipped background colour, a half-transparent fill over a clipped gradient, flex items, an ellipsis, right-to-left and wrapped text, an underlined shimmer: all pass at 420x300 and 800x300. (An underline over a visible fill is left out: Blitz draws underlines a device pixel higher than Chromium, a separate [gap](../../docs/BLITZ-GAPS.md).)
- **Render census** on the 12 examples the report stopped: CENSUS_LINE (evidence in the main tree's `artifacts/css/text-fill-clip/render-census`).
- **Fork tests:** Blitz `blitz-dom` (new: `text_clip_outside_the_own_inline_formatting_context_is_reported`), failing only the known `hover_styles_apply_and_clear` and `scroll_by_clamps_and_bubbles`.

## Left open

Text clips that reach descendants' inline layouts (reported), `-webkit-text-stroke` (still dropped by Stylo, reported where it applies).
