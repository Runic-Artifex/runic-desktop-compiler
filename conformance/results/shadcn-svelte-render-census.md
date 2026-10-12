# shadcn-svelte render census (2026-10-12)

The 253 shadcn-svelte `3ef557c` component examples that lower at compiler `cb93d23` ([example census](shadcn-svelte-census.md)) were each built natively and their first settled frame compared with Chromium 153.0.8010.12 at 800x600. Each example ran in a host that renders it as the site's docs pages do (below). This was done by [`conformance/render-census.mjs`](../render-census.mjs) with the harness's capture, probe, comparison, gates and tolerances. No interactions were run. The run is at `6519107`, which is `cb93d23` plus the example census's results. Per-example statuses and clusters are in [shadcn-svelte-render-census.json](shadcn-svelte-render-census.json).

| Status | Examples | First run (260 examples, fixture theme) |
|---|---|---|
| matches | **194** | 186 |
| differs | 11 | 19 |
| reportsUnsupported | 48 | 45 |
| incomplete | 0 | 10 |
| buildFailed, nativeFailed, notLowered | 0 | 0 |

All 253 still lower and all 253 build. Every `cn-*` class an example uses now has its rule (the site's stylesheet), so the first run's split by theme coverage is gone: all 253 examples count under `themeStylesAllClasses` in the JSON.

Rerun with `RUNIC_TARGET_DIR=<main tree>/target node conformance/render-census.mjs --jobs 2`. That command uses the default output directory, `artifacts/render-census/`. `--resume` continues an interrupted run, and `--keep-shots <example>` keeps screenshots and traces for diagnosis.

## The site's example view

The census hosts ([`conformance/triage.mjs`](../triage.mjs)) reproduce the site's example view from corpus files:

- `ComponentPreview` sits inside the 11 elements and providers the docs layouts give it.
- `<html lang="en">` and `<body>` carry `app.html`'s attributes, including `class="group/body theme-blue style-vega … font-sans text-foreground antialiased …"`.
- The stylesheet is the site's `docs/src/app.css`. The host stylesheet's sha256 is `ffa919d47ca5138920351f87faf55b9a94fb8f803479b5be981a9918471e420f`. It imports tailwindcss, tw-animate-css and shadcn-svelte's `tailwind.css`, and the site's style-vega and theme files.
- The fonts are Geist Variable 5.2.8 and Geist Mono Variable 5.2.7, embedded as WOFF2 from the site's lockfile versions.

The example census's [`host.siteView`](shadcn-svelte-census.json) lists every file with its sha256, and what the view leaves out and why:

- 13 code-block rules for attributes that only rehype-pretty-code writes, which no host file names (checked per host);
- the page's other content and the code panel;
- ModeWatcher and the Toaster, which do not lower;
- Sidebar.Provider, which reaches `MediaQuery`;
- the two Tooltip.Provider ancestors, for examples that do not reach the tooltip: without a tooltip in the program its state does not lower.

Two measurement rules changed with the site's view:

- **404 pin.** The site serves no `/avatars/10.png` (`docs/static/avatars/` has 01–05.png). message-avatar and message-demo load it. It is pinned as `{"url": "/avatars/10.png", "status": 404}` in each host's `runic.images.json` and answered with that status on both sides: Chromium from the record, the app from its image table. Both show the avatar's fallback. Chromium's console line for the failed load is a browser diagnostic, as for a remote 404 pin, not an app console line.
- **Font smoothing.** The body's `antialiased` (`-webkit-font-smoothing: antialiased; -moz-osx-font-smoothing: grayscale`) is accepted as equivalent. Both renderers draw grayscale coverage only, which is what these values ask for, and Chromium 153 on this machine draws byte-identical pixels with and without them ([M6-CSS](../../docs/research/M6-CSS.md#properties)). Other smoothing values are still reported. Without this, every example stopped at mount on that report.

Images otherwise come from two sources (the user authorised fetching them for this census):

- remote URLs were pinned with `runic images`, one fetch per URL;
- root-relative paths were copied from the site's `docs/static/`.

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

The `#demo` region check uses the same tolerance as the viewport check. It is the census's stand-in for a case's pixel regions: a small example cannot pass on the empty page around it. The gates and tolerances are the first run's. Among the matches, the largest `#demo` region error is 2.487/255 and the median is 0.077/255.

## Changes against the first run

| Examples | First run → now | Examples and cause |
|---|---|---|
| 167 | matches → matches | |
| 36 | reportsUnsupported → reportsUnsupported | The same report, except for six examples. shimmer-angle, -duration, -none, -rtl and -spread go from `E_FONT` (monospace) to the `.shimmer` report. bubble-variants goes from `E_FONT` to the inline-border report. |
| 11 | differs → matches | accordion-basic, -borders and -card. Their `--bits-accordion-content-height` is now equal on both sides; in the first run Chromium's value was one line short. That fits the first run's hypothesis, a measurement taken before the web font loaded: the hosts now load the site's fonts. Also avatar-demo, avatar-dropdown, avatar-group, avatar-group-count, avatar-group-count-icon, avatar-size and dropdown-menu-avatar: `cn-avatar` now sizes the avatar, so the percentage-sized image no longer meets the layout gap. Also table-footer. |
| 8 | incomplete → matches | bubble-tooltip, input-group-label-demo, input-group-tooltip-demo, kbd-tooltip-demo, tooltip-disabled, tooltip-keyboard and tooltip-sides now have the site's Tooltip.Provider. message-avatar has the 404 pin. |
| 7 | reportsUnsupported → matches | command-dialog, input-group-kbd, kbd-button-demo, kbd-demo, kbd-group-demo, kbd-input-group-demo and typography-inline-code: `E_FONT` for monospace text is gone with Geist Mono |
| 11 | matches → reportsUnsupported | alert-action, alert-basic, alert-colors, alert-demo and alert-destructive: style-vega's `.cn-alert-description` has `text-wrap: balance`. marker-demo, marker-shimmer, shimmer-color, shimmer-demo, shimmer-marker and shimmer-once: shadcn-svelte's `.shimmer` utility has `-webkit-text-fill-color: var(--shimmer-text-fill, transparent)`. The first run's matches had no rule for these classes. |
| 7 | matches (6), differs (1) → no longer lowered | attachment-sizes, attachment-states, attachment-trigger, message-attachment, scroll-fade-horizontal and scroll-fade-rtl stop at the scroll-driven animations of the `scroll-fade-*` utilities. card-small stops at the `step` utility's `content: counter(step)`, which no element can match ([example census](shadcn-svelte-census.md)). |
| 1 | reportsUnsupported → no longer lowered | scroll-fade-edge, for the same reason as the scroll-fade examples |
| 2 | matches → differs | field-responsive-layout-demo and input-group-button-group-demo: input geometry (below) |
| 1 | incomplete → differs | button-group-input-group-demo: button geometry (below) |
| 1 | reportsUnsupported → differs | button-group-select-demo: button geometry (below) |
| 1 | incomplete → reportsUnsupported | message-demo: the 404 pin lets it run, and it stops at the `.shimmer` report |
| 1 | not lowered → matches | field-select, lowered since the first run |
| 7 | differs → differs | card-demo, input-disabled, input-fieldgroup, input-form and input-group-icon-demo: the `<input type=email>` selection. select-scrollable: `RunicAttrsError`. table-demo: column widths. |

## reportsUnsupported (48)

In each of these, the app stops at a run-time report instead of approximating.

| Examples | Report | Source and examples |
|---|---|---|
| 15 | `text-wrap: balance` | style-vega's `.cn-alert-description` (the five alert examples), the `text-balance` utility (empty-*, spinner-empty-demo, toggle-group-font-weight-selector, typography-demo, typography-h1). Stylo has no `text-wrap: balance`. |
| 12 | `field-sizing: content` | The textarea and input-group block/textarea examples, spinner-input-group-demo. Stylo has no `field-sizing`. |
| 12 | `-webkit-text-fill-color: var(--shimmer-text-fill, transparent)` | shadcn-svelte's `.shimmer` utility: the shimmer, marker-demo, marker-shimmer and message-demo examples. Stylo drops the property. |
| 8 | `-webkit-line-clamp: 2` (7) and `: 1` (spinner-demo) | The item-* examples and spinner-item-demo |
| 1 | a non-solid or rounded border on an ordinary inline box with horizontal edges | bubble-variants: an inline `<code>`, which the site's `.mdsx code:not(pre code)` rule (app.css) gives `rounded-md` and horizontal padding, because the example sits inside the docs page's `.mdsx` wrapper. In the first run it reported `E_FONT` for the same `<code>`. |

## differs (11), by cause

| Examples | Worst gate | Evidence | Cause |
|---|---|---|---|
| 5 | Semantics: `<input>` selection | card-demo, input-disabled, input-fieldgroup, input-form, input-group-icon-demo, each at an `<input type="email">`. Chromium's selection is `null`; the app's is `[0,0]`. | Unchanged from the first run: `type=email` has no selection API in Chromium (`selectionStart` is `null`), but the app exposes one. |
| 2 | Geometry: `<input>` 44 px narrower | field-responsive-layout-demo: `#name` is 213 px wide at x 443 in Chromium, 169 px at x 487 in the app. input-group-button-group-demo: `#url` is 207 px in Chromium, 163 px in the app. Pixels pass (MAE ≤ 0.2). | New with the site's view; not attributed yet. In both, the input shares a flex row with other content, which takes 44 px more in the app. |
| 2 | Geometry: `<button>` x off by 22 px | button-group-input-group-demo: the input group's button is at x 511.5 in Chromium and x 489.5 in the app. button-group-select-demo: the Select trigger is at x 246.8 in Chromium and x 268.8 in the app. Pixels pass (MAE ≤ 0.22). | New with the site's view, where both examples render for the first time; not attributed yet. These may share a cause with the inputs above (22 = 44/2: a centred row whose content is 44 px wider). |
| 1 | Pixels: `#demo` only | table-demo has region MAE 4.712 (viewport 2.852), on the table's cells. | Unchanged from the first run: auto table layout distributes column widths differently at the sub-pixel level. |
| 1 | Semantics: native render error | select-scrollable: `runic: render error: TypeError: RunicAttrsError: the spread passes items a value of another type than the prop's`. The app's snapshot has no content under the root; Chromium renders the trigger. | Unchanged from the first run: an app-only failure at run time, a defect in the lowering of a rest-props spread with `items`. It needs a reduction ([gap](../../docs/gaps/FRAMEWORKS.md)). |

## incomplete (0)

The first run's ten are measured now. The eight that threw `Context "Tooltip.Provider" not found` have the site's providers. message-avatar and message-demo have the 404 pin.

## Timing and disk

- **Full run:** 2801 s wall for the 253 examples at `--jobs 2`, on the shared target and its lock (5592 s summed over examples).
- **Per example (median):**

  | Stage | Median |
  |---|---|
  | Build | 13.6 s |
  | Chromium | 1.2 s |
  | Probe | 0.4 s |
  | Comparison | 0.19 s |
  | Total | 15.3 s |

- **Disk:** about 117 MB per example at its peak (median), of which the binary is 106 MB (dev profile). The binary, generated crate, screenshots, Vite cache and host are removed after each comparison, so the shared target does not grow from example to example.
