# Blitz rendering gaps

Differences between the pinned Blitz revision and Chromium found by conformance runs, kept for the Blitz upstream track (D11). Fixtures avoid them with explicit author CSS so that conformance keeps checking everything else; each entry says how.

| Gap | Observed | Workaround in fixtures | Found |
|---|---|---|---|
| Default focus ring of text inputs | Chromium draws a 2px `#101010` ring over the border with a 1px white halo (`outline: auto`); Blitz draws a 2px blue outline outside the border and ignores `outline-offset`, so the ring cannot be matched from a UA stylesheet | an author `input:focus` style (`outline: none` plus a border colour) | M3, `components-svelte` |
| Inline inputs in a line box | an `<input>` inside a `<p>` gives a line box 4.8px shorter than Chromium's (inline form-control baseline/strut) | inputs are `display: block` | M3, `components-svelte` (also why the M1 editors use block inputs) |
| Input placeholders | `placeholder` text is not painted | none: examples omit placeholders until Blitz paints them (needed by the M8 editor) | M3, `todomvc-svelte` |
| Checkbox appearance | Blitz paints checkboxes in the element's `color` and ignores `accent-color`; Chromium uses a grey border and a blue accent fill | the runtime's UA parity sheet sets Chromium's colours for `:checked` and unchecked boxes | M3, `todomvc-svelte` |
| Checkbox box model | author padding, borders and `flex` change a checkbox's box in Blitz; Chromium ignores them for native checkboxes | style text inputs by id or type, not `input` | M3, `todomvc-svelte` |
| Text input line height | with `line-height: normal`, a text input's line box is fractional in Blitz (21.59px for an 18px DejaVu font) and rounded in Chromium (21px) | an explicit `line-height` on text inputs | M3, `todomvc-svelte` |
| Shrink-to-fit widths | buttons sized by their content get a width rounded up to a whole pixel in Blitz (39.36px → 40px); rows of such buttons drift by the sum | fixed widths where several content-sized buttons share a row | M3, `todomvc-svelte` |
