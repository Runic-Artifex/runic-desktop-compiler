# shadcn-svelte render census (2026-10-12)

The 260 shadcn-svelte `3ef557c` component examples that lower at compiler `868db79` ([example census](shadcn-svelte-census.md)) were each built natively and their first settled frame compared with Chromium 153.0.8010.12 at 800x600. This was done by [`conformance/render-census.mjs`](../render-census.mjs) with the harness's capture, probe, comparison, gates and tolerances. No interactions were run. The compiler, frontend and crates are those of `868db79`; the run's script is at `771d3a4`. Per-example statuses and clusters are in [shadcn-svelte-render-census.json](shadcn-svelte-render-census.json).

| Status | Examples |
|---|---|
| matches | **186** |
| differs | 19 |
| reportsUnsupported | 45 |
| incomplete | 10 |
| buildFailed, nativeFailed, notLowered | 0 |

All 260 still lower and all 260 build.

Rerun with `RUNIC_TARGET_DIR=<main tree>/target node conformance/render-census.mjs --jobs 2`. That command uses the default output directory, `artifacts/render-census/`. `--resume` continues an interrupted run, and `--keep-shots <example>` keeps screenshots and traces for diagnosis.

## Protocol

Each example uses its census host and is built with `node compiler/cli.mjs build <host> --probe`: the dev profile and CPU renderer, as `run.mjs` builds. Chromium and the probe both run on the virtual clock. Two states are compared:

- the mount;
- the state after `wait 0`: the zero-delay work runs, such as bits-ui Avatar's image load, but virtual time does not advance.

The gates apply to both states.

| Gate | Passes when |
|---|---|
| Semantics | The DOM, document and body attributes, focus and host effects are equal in compare.mjs's canonical form. A Chromium page error fails it. |
| Geometry | Every element with an id is within 2 px per coordinate. |
| Pixels | The mean absolute error is at most 3/255 over the viewport, and also over the `#demo` region (the element the host mounts the example in). |

The `#demo` region check uses the same tolerance as the viewport check. It is the census's stand-in for a case's pixel regions: a small example cannot pass on the empty page around it.

Images come from two sources (the user authorised fetching them for this census):

- remote URLs were pinned with `runic images`, one fetch per URL;
- root-relative paths were copied from the site's `docs/static/`.

**Caveat: the theme.** The census hosts use the bits-dialog fixture's theme. Of the 421 `cn-*` classes in style-vega.css, it styles 39 (Button, Dialog, Field, Input and Label). A match therefore means the app renders the same stylesheet as Chromium does, not that it looks like the site.

| Theme coverage | Examples | matches | differs | reportsUnsupported | incomplete |
|---|---|---|---|---|---|
| The theme styles all of the example's `cn-*` classes | 64 | 53 | 2 | 9 | 0 |
| The example uses classes the theme has no rule for | 196 | 133 | 17 | 36 | 10 |

Several of the differences below only show up because a component is unstyled, for example an avatar without its size.

## reportsUnsupported (45)

In each of these, the app stops at a run-time report instead of approximating.

| Examples | Report | Cause |
|---|---|---|
| 14 | `E_FONT` for text in `font-family: ui-monospace, …, monospace` (`kbd`, `⌘`, `$`, `font-mono` labels, inline `<code>`) | The host theme sets `--font-sans` to the embedded fixture font but leaves `--font-mono` at Tailwind's system stack, which no app embeds. The site uses `Geist Mono Variable`. This is a census-host gap: a monospace fixture font in the theme would measure these. |
| 1 | `E_FONT` for the `<p>` in bubble-variants (`font-family: RunicFixture`) | The paragraph contains an inline `<code>`, which is monospace. Its other paragraphs draw. The report names the paragraph's family, not the run without a font: this belongs with the row above, and the attribution is misleading. |
| 12 | `unsupported: field-sizing: content` | Stylo has no `field-sizing`. Affects the textarea and input-group block/textarea examples. |
| 10 | `unsupported: text-wrap: balance` | Stylo has no `text-wrap: balance`. Affects the empty-* examples, typography-demo and typography-h1. |
| 8 | `unsupported: -webkit-line-clamp: 2` (7) and `: 1` (spinner-demo) | Affects the item-* examples and spinner-item-demo. |

## differs (19), by cause

| Examples | Worst gate | Evidence | Cause |
|---|---|---|---|
| 7 | Geometry and pixels | See the avatar rows below the table. | Percentage-sized replaced elements, described below. |
| 5 | Semantics: `<input>` selection | card-demo, input-disabled, input-fieldgroup, input-form, input-group-icon-demo, each at an `<input type="email">`. Chromium's selection is `null`; the app's is `[0,0]`. Pixels pass (MAE ≤ 0.22). | `type=email` has no selection API in Chromium (`selectionStart` is `null`). The app exposes one. |
| 3 | Semantics: `<div> style` | accordion-basic, -borders, -card. `--bits-accordion-content-height` is 48/72/96 px in Chromium and 72/96/120 px in the app; the width is equal. Pixels pass (MAE 0.20–0.35). | bits-ui measures the open content once (`getBoundingClientRect` after a tick). Chromium's value is one line (24 px) less than its own final height of the element (72 px in accordion-basic). The app's value is the final height. Not attributed yet; Chromium probably measured before its final text layout, for example before the web font loaded. |
| 2 | Pixels: `#demo` only | table-demo has region MAE 3.864 (viewport 2.077), and table-footer has 3.012 (1.156), both on the table's cells (bbox 357x231 at 221,69). | The table columns sit about 1 px apart: auto table layout distributes column widths differently at sub-pixel level. The glyphs are otherwise identical. |
| 1 | Pixels: viewport | message-attachment has MAE 42.9 over the viewport (region 44.3); 46% of pixels differ, in the bbox 382x370 at 209,113. | The attachment media (`flex aspect-square`, without the theme's width) holds an `<img class="aspect-square w-full object-cover">`. Chromium sizes it 383 px wide; the app makes it wider than the viewport. This is the same cause as the avatars. |
| 1 | Semantics: native render error | select-scrollable: `runic: render error: TypeError: RunicAttrsError: the spread passes items a value of another type than the prop's`. The app's snapshot has no content under the root; Chromium renders the trigger. | This is an app-only failure at run time, a real defect in the lowering of a rest-props spread with `items`, and needs a reduction. |

**Avatars (7 examples): percentage-sized replaced elements.**

- **Affected:** avatar-demo, avatar-group, avatar-group-count, avatar-group-count-icon, avatar-size, avatar-dropdown and dropdown-menu-avatar.
- **Evidence:**
  - In avatar-group, the avatar `#bits-c1` is 460x460 at x 64 in Chromium and at x −282 in the app, so the group overflows centred rather than from the start; viewport MAE is 57.3.
  - In avatar-demo, it is 460 px in Chromium and 1476 px in the app; MAE is 141.5.
  - In avatar-dropdown, it is 460 px in Chromium and 34 px in the app; MAE is 42.8.
- **Cause:** with the theme's `cn-avatar` size absent, the root is an unsized `relative flex shrink-0` box around `<img class="aspect-square size-full">`. Chromium treats a replaced element with a percentage size as compressible: its min-content contribution is 0, and the image falls back to its natural 460 px. Blitz/Taffy sizes these boxes differently in each context. The site's own sizes (`size-8`) would hide this, but the layout rule is a real gap.

## incomplete (10): never counted as passed

| Examples | Reason |
|---|---|
| 8 | bubble-tooltip, button-group-input-group-demo, input-group-label-demo, input-group-tooltip-demo, kbd-tooltip-demo, tooltip-disabled, tooltip-keyboard and tooltip-sides throw `Context "Tooltip.Provider" not found` on mount, both in Chromium (page error) and in the app (`runic: render error`). The site provides `Tooltip.Provider` in its layout; the census host does not. |
| 2 | message-avatar and message-demo load `/avatars/10.png`, which the site does not serve: `docs/static/avatars/` has 01–05.png only. These cannot be pinned. |

## Timing and disk

- **Full run:** 6038 s wall for the 260 examples at `--jobs 2`, on the shared target and its lock. The 23 examples reclassified after the first pass, and select-scrollable, were run again.
- **Per example (median):**

  | Stage | Median |
  |---|---|
  | Build | 20.9 s |
  | Chromium | 1.2 s |
  | Probe | 0.4 s |
  | Comparison | 0.25 s |
  | Total | 23.0 s |

- **Slower examples:** the first build of a feature variant took about 72 s (Stylo and Blitz). Examples that waited on another worktree's builds took 150–360 s.
- **Disk:** about 116 MB per example at its peak (median), of which the binary is 105 MB (dev profile). The binary, generated crate, screenshots, Vite cache and host are removed after each comparison, so the shared target does not grow from example to example.
