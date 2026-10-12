# Gaps: verification, tooling and product

Part of the [gap register](../GAPS.md). Clusters: **T1** reference interpreter, **T2** test infrastructure, **T3** product and later milestones, **T4** diagnostics quality.

## Reference interpreter (T1)

Programs using these are "incomplete" in the differential test (`conformance/differential.mjs`) and checked against Chromium only. The interpreter has no layout, style, input modality or mutable DOM.

| Not covered | Error | Location |
|---|---|---|
| Layout and geometry reads (`getBoundingClientRect`, client rects, offset/client/scroll metrics, window and document metrics, `elementFromPoint`, `devicePixelRatio`) | RunicLayoutError | interp.rs:2833; builtins.rs:218-261 |
| Scrolling (scrollTo/By, scrollTop/Left writes, scrollIntoView, scroll listeners, fragment links to elements) | RunicLayoutError / E_LAYOUT | interp.rs:6684-6700; differential.mjs:78 |
| Inline style reads and writes, computed style, animations and `getAnimations` | RunicLayoutError | interp.rs:2833 |
| Resize, Intersection and Mutation observers; floating-ui; tabbable | RunicLayoutError | interp.rs:2833 |
| `:focus-visible` (no input modality) | RunicLayoutError | interp.rs:2984 |
| Script `setAttribute` and `appendChild` (no mutable DOM) | RunicLayoutError | interp.rs:2904-2917 |
| `closest`/`document.querySelector` matching html, head or the container; `firstNonCommentNode` on text children | RunicUnsupportedError | interp.rs:2880-2897,8017-8107 |
| Elements hidden by CSS during the focus fix-up | not modelled | interp.rs:6186 |
| Image loading: the interpreter loads no images, so a program with `<img>` `load` or `error` listeners (`images-svelte`) or setting an image object's `src` (`new Image()`, `bits-avatar-svelte`) is incomplete in the differential and checked against Chromium only (`conformance/run.mjs images bits-avatar`); an `<img>` without them compares (its attributes only), and the interpreter keeps image objects' other state (handlers, listeners, `crossOrigin`, `referrerPolicy`) but throws `RunicUnsupportedError` on reading `src` | incomplete (E_DIFFERENTIAL_ACTION) | differential.mjs (`eventKinds`) |

Every M6 bits-ui fixture is incomplete in the differential (13 of them), so library behaviour is checked against Chromium only. Covering it would need layout in the interpreter (a Blitz instance, which defeats its independence) or interpreter models of the specific APIs.

## Test infrastructure (T2)

| Not covered | Reason | What it would take |
|---|---|---|
| OS keyboard and IME delivery, Wayland resize, accessibility (AccessKit); OS clipboard and console checked once by hand | Need real compositor sessions | The desktop-input track (computer use); required by M8 |
| Svelte 5.49.2 and Vue 3.5.24 pins; the site's pins (Svelte 5.54.0, Vite 8.1.5) | Not in the automated campaign | Version environments (M7) |
| Probes do not model Playwright's scroll-into-view before pointer actions | Not modelled | Cases click visible elements |
| Paint-only regressions (placeholders, ellipsis, small loaders, one mis-rendered word: synthetic italic leaned left in `style-objects` for months within 3/255) | The whole-viewport gate (mean error 3/255) misses them | Region gates (`pixelRegions`) on the text and controls a case is about, or inspection |
| GPU pixel runs: representative cases on lavapipe only; hardware drivers and Wayland presentation | — | Hardware runs |
| Corpus scan of 20–50 apps; shadcn/ui and shadcn-vue not scanned; the editor's scan dates from M1; no island or native-coverage baseline | M6 exit criteria not reached | M6 step 10 |
| Example coverage of the north star (2026-10-12), with each example hosted as the site's docs pages show it (the site's stylesheet, fonts, body attributes and layout ancestors). 258 of the 404 top-level shadcn-svelte component examples lower (2026-10-13). Of the 253 that lowered when the render census ran, 194 match Chromium on their first settled frame (no interactions), 11 differ, 48 stop at a run-time report and 0 are incomplete | Work in progress | The [census](../../conformance/results/shadcn-svelte-census.md) and [render census](../../conformance/results/shadcn-svelte-render-census.md) blockers; interactions; conformance cases for lowered examples |
| What the census hosts leave out of the site's view: the page's other content and code panel; the layouts' ModeWatcher, Toaster and Sidebar.Provider, which do not lower; and the Tooltip.Provider pair, for examples that do not reach the tooltip. Each omission has its reason in the census's `host.siteView.omitted` | The site shell does not lower yet (P4, L1, F1, L4) | Covering those rows, then hosting the examples in the full docs page |
| `kit-docs-svelte` is incomplete in a plain `conformance/differential.mjs` run: its generated inputs are missing until `node compiler/cli.mjs generate fixtures/kit-docs-svelte` has run, and the run reports that command | Generated inputs are not committed (by policy), and neither builds nor the harness run generation | Generate first, then run the differential (and remove the generated outputs after) |
| Conformance route selection (`--routes`) for the whole site | Proposed only | — |

## Product and later milestones (T3)

| Not covered | Milestone |
|---|---|
| QuickJS islands (`--allow-js-islands`), island and native-coverage reports; model-assisted pack discovery | M6 step 10 (not implemented) |
| Whole-site builds: per-route lazy initialisation, chunked codegen (one `app.rs` today; estimated 40–200 MiB) | M7 |
| Linux packaging (Nix closure, AppImage/Flatpak); multiple windows | M7 |
| Embedder C ABI, Godot host, `runic-bridge`, the SDK's native UI mode, the Translations Editor | M8 (SDK changes need the user's sign-off) |
| Angular (M9); optimisation and the dev loop (M10); Windows (M11); macOS (M12); Solid and a Rust frontend (M13) | ROADMAP |
| Reference cycles leak (`Rc`) | M10 option |

## Diagnostics quality (T4)

Found by the 2026-10-07 survey; small fixes.

| Issue | Location |
|---|---|
| A top-level `enum` gets "Top-level effects in modules are planned for M4"; inside functions "Unsupported statement: EnumDeclaration" | modules.ts:477 |
| A `function*` is rejected only at its `yield` ("Unsupported expression: YieldExpression") | language.ts:5288 |
| One diagnostic has no source location (`this.fail(undefined as never, …)`) | language.ts:2879 |
| Stale milestone wording in messages: "planned for M3" (modules.ts:383), "planned for M4" (svelte.ts:3898, language.ts:2665, modules.ts:477), "planned for M5" (svelte.ts:4927), "SvelteMap and SvelteSet are planned for M6" (validate.rs:3930) | as listed |
