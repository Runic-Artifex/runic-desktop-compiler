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

Every M6 bits-ui fixture is incomplete in the differential (13 of them), so library behaviour is checked against Chromium only. Covering it would need layout in the interpreter (a Blitz instance, which defeats its independence) or interpreter models of the specific APIs.

## Test infrastructure (T2)

| Not covered | Reason | What it would take |
|---|---|---|
| OS keyboard and IME delivery, Wayland resize, accessibility (AccessKit); OS clipboard and console checked once by hand | Need real compositor sessions | The desktop-input track (computer use); required by M8 |
| Svelte 5.49.2 and Vue 3.5.24 pins; the site's pins (Svelte 5.54.0, Vite 8.1.5) | Not in the automated campaign | Version environments (M7) |
| Probes do not model Playwright's scroll-into-view before pointer actions | Not modelled | Cases click visible elements |
| Paint-only regressions (placeholders, ellipsis, small loaders) | The whole-viewport gate misses them | Region gates or inspection |
| GPU pixel runs: representative cases on lavapipe only; hardware drivers and Wayland presentation | — | Hardware runs |
| Corpus scan of 20–50 apps; shadcn/ui and shadcn-vue not scanned; the editor's scan dates from M1; no island or native-coverage baseline | M6 exit criteria not reached | M6 step 10 |
| Example coverage of the north star: 34 of 374 previews on the shadcn-svelte component pages, 25 of 59 component wrappers vendored (2026-10-07) | Work in progress | [Clusters](../GAPS.md#clusters) |
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
