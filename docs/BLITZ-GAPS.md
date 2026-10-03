# Blitz rendering gaps

Differences between the pinned Blitz revision and Chromium found by conformance runs, kept for the Blitz upstream track (D11). Fixtures avoid them with explicit author CSS so that conformance keeps checking everything else; each entry says how.

| Gap | Observed | Workaround in fixtures | Found |
|---|---|---|---|
| Default focus ring of text inputs | Chromium draws a 2px `#101010` ring over the border with a 1px white halo (`outline: auto`); Blitz draws a 2px blue outline outside the border and ignores `outline-offset`, so the ring cannot be matched from a UA stylesheet | an author `input:focus` style (`outline: none` plus a border colour) | M3, `components-svelte` |
| Inline inputs in a line box | an `<input>` inside a `<p>` gives a line box 4.8px shorter than Chromium's (inline form-control baseline/strut) | inputs are `display: block` | M3, `components-svelte` (also why the M1 editors use block inputs) |
