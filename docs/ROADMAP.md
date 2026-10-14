# Roadmap

A rough plan for the whole compiler, written on 2026-10-03. It replaces the Phase 5–8 plan in [history/PHASES5-8.md](history/PHASES5-8.md). Milestones are numbered M0–M13 so they don't collide with the historical Phases 0–4. Each milestone is driven by **example applications** rather than by abstract capability lists.

**The goal** is a general compiler for framework UIs that need no browser: the Runic SDK's WebView-free deployment path, and hosts such as a Godot UI. The north star (decided 2026-10-04) is the **shadcn sites**, pulled from GitHub at pinned commits:
- the [shadcn-svelte](https://www.shadcn-svelte.com/) documentation site as a whole: SvelteKit, Svelte 5, Tailwind 4, bits-ui, lucide, tailwind-variants, markdown pages;
- the component examples and blocks of [shadcn/ui](https://ui.shadcn.com/) (React 19, Radix) and of [shadcn-vue](https://www.shadcn-vue.com/) (Vue, Reka UI), each in a Vite host page. The ui.shadcn.com site itself is a Next.js app with server components, which needs a Next.js adapter of its own.

They cover a wider range of components than one application, and keep early verification independent of Runic. The Runic Translations Editor follows with the application bridge (M8).

**Framework rule (D14).** Every capability milestone must pass in **Svelte**. React and Vue follow in the same milestone when the adapter work is small; otherwise they keep explicit diagnostics until later.

**Platform rule (D15).** Everything runs on Linux first. Windows starts only after the north star works on Linux, and macOS comes last.

How each kind of work is executed (standalone, subagents or workflows) is defined in [WORKING.md](WORKING.md). Each milestone below states which mode to use and why.

## Overview

| Milestone | Outcome | Driving examples | Main mode | Status |
|---|---|---|---|---|
| M0 | Repository restructure and plan | — | Standalone | Done 2026-10-03 |
| M1 | Rust IR, codegen and runtime library; renderer toggle; automated conformance; startup/size measurement | all 15 existing fixtures | Standalone, 2 spikes | Done 2026-10-03 ([results](../conformance/results/m1.md)) |
| M2 | JS values, statements and functions | 7GUIs Counter, Temperature Converter, ledger example | Standalone design ([M2-VALUES](design/M2-VALUES.md)), then subagents for built-ins | Done 2026-10-03 ([results](../conformance/results/m2.md)) |
| M3 | Components, slots and snippets, keyed lists, instance lifetimes | 7GUIs CRUD, TodoMVC (in memory) | Standalone core, then subagents per adapter | Done 2026-10-03 ([results](../conformance/results/m3.md)) |
| M4 | Effects, timers, async, event loop | 7GUIs Timer, TodoMVC with persistence | Standalone core, ordering research subagent, subagents per adapter | Done 2026-10-03 ([results](../conformance/results/m4.md)) |
| M5 | Full event model, forms, layout/measurement APIs, host services | 7GUIs Circle Drawer, Cells; a virtualized list | Subagents per service; desktop track standalone | Done 2026-10-04 ([results](../conformance/results/m5.md)) |
| M6 | Blitz fork; npm and component libraries, Tailwind/CSS pipeline, SvelteKit SPA subset, mapping packs, corpus scan, QuickJS islands | shadcn-svelte component examples, corpus apps | Workflows for corpus and packs | In progress |
| M7 | **North star on Linux:** the shadcn-svelte site, and the shadcn/ui and shadcn-vue examples, compiled, verified and packaged | shadcn-svelte, shadcn/ui, shadcn-vue | Workflow for triage, standalone integration | Planned |
| M8 | Embedding: a host-agnostic embedder interface, a Godot host first, then the Runic application bridge to .NET and the Translations Editor | a Godot sample, an SDK sample app, then the Runic Translations Editor | Standalone + spike | Planned |
| M9 | Angular adapter | 7GUIs + TodoMVC in Angular, an SDK Angular sample | Standalone design, subagents for cases | Planned |
| M10 | Optimisation: startup, size, compile time, dev loop | M8 app | Standalone with measured experiments | Planned |
| M11 | Windows | M8 app on Windows | Standalone | Planned |
| M12 | macOS | M8 app on macOS | Standalone | Planned |
| M13 | (Optional) Solid and further frontends; port frontends/language layer to Rust | — | Decided by M10 profiling | Optional |
| M14 | Pages without a framework: a plain-JavaScript frontend (`index.html` plus module scripts), then Alpine.js and HTMX pages | a plain-JavaScript TodoMVC; Alpine and HTMX samples | Standalone design per frontend ([M6-SCRIPT-DOM](design/M6-SCRIPT-DOM.md)) | Planned (user decision 2026-10-13) |

**Continuous tracks that run alongside the milestones:**

- **Startup and size budget.** From M1 on, the harness records cold-start time to first frame and stripped binary size for every example. Each milestone reports both. A regression needs a stated reason.
- **Desktop input.** OS keyboard, IME, Wayland resize and accessibility on Linux. This needs real compositor sessions, so it is done standalone with computer use. It never blocks compiler milestones, but M8 requires it complete for the editor.
- **Blitz upstream.** Report and fix renderer and control bugs upstream and keep the pin current (D11). Known gaps and the fork assessment: [BLITZ-GAPS.md](BLITZ-GAPS.md).
- **Native coverage.** From M6 on, island count and native-coverage % of the north-star and corpus apps are tracked per milestone and must not regress.

## M0: Restructure (done)

- Sol's work is committed unchanged and tagged `baseline/phase4`.
- Historical plans, evidence reports and old contracts moved to `docs/history/`. Raw evidence, baselines and the per-phase scripts are removed from the tree and stay reproducible from the tag ([history/README.md](history/README.md)).
- Mapping proofs moved to `mappings/proofs/` and were re-accepted against the formatted validator. The candidate bytes are unchanged.
- The compiler is formatted with Prettier (now in the dev shell). `npm test` passes (45/45) and the native fixture build still works.
- New [ARCHITECTURE.md](ARCHITECTURE.md), this roadmap, [WORKING.md](WORKING.md) and `AGENTS.md`.

## M1: Foundation

Replace the parts that cannot scale before adding any capability.

**Scope**

1. **Workspace.** A cargo workspace with `crates/runic-ir`, `crates/runic-codegen` (library + binary), `crates/runic-runtime` and `crates/runic-probe`. The generated crate depends on `runic-runtime` by path, so files are no longer copied into each app. Assets use `include_bytes!`. Add a `RUNIC_TARGET_DIR` override and a shared build lock so worktrees can share one cargo target (WORKING.md).
2. **IR v4 core.** Rust types (serde) for the current capabilities, rebuilt around D4/D5: cells, derived values, handlers, static blocks with holes, conditional regions, and capability declarations. Leave room for instances and lists without implementing them yet. Add the validator, the reference interpreter, JSON Schema export and `schema 3 → 4` migration. Port the `TEXT-VALIDATION` guarantees as validator and interpreter rules.
3. **Runtime rewrite.**
   - Keep a `NodeId` handle table and build nodes directly with the Blitz mutator API; constructed subtrees replace the `set_inner_html` conditionals.
   - Move probe and trace modes behind a `probe` feature.
   - Keep the live-control behaviour of `controls.rs` and its probes.
   - **Renderer toggle (D12):** `renderer-cpu`/`renderer-gpu` features selected from `runic.json`, with CPU as the default. GPU gets a smoke test.
4. **Frontends.** *(Revised during M1.)* The existing JS adapters keep emitting schema 3, which the Rust backend migrates. The adapters are rewritten in TypeScript on a new shared language layer in M2 (`frontend/`, see [M2-VALUES](design/M2-VALUES.md)), so converting the old code first would be wasted work. `codegen.mjs` is now a bridge to the Rust backend; `ir.mjs` is removed with the old adapters.
5. **Conformance harness.** A single harness in `conformance/` replaces the per-phase scripts. It uses a case manifest (app, framework, version, viewport, action trace, observation kinds) and drives:
   - headless Chromium through Playwright from nixpkgs, running the original framework;
   - native apps in headless snapshot mode;
   - the reference interpreter.

   It compares DOM/text semantics first, then geometry, then pixels at the existing 3/255 tolerance, and records startup time and binary size. Reports go to `artifacts/`, with only a summary committed. The T3 preview is for manual inspection only.
6. **`runic scan`.** Analyse an app and report every unsupported construct by diagnostic code and frequency without stopping at the first error. Run it on the Translations Editor from the start; its blocker list is the running to-do for M2–M8.

**Exit criteria:**
- All 15 fixtures, including the rejection fixtures, pass or reject with the same diagnostics on the new pipeline through the harness, with and without `--no-opt`.
- The old JS IR and codegen are deleted.
- `npm test && cargo test --workspace` passes, and one command runs full conformance.
- The first editor scan report is committed.

**Work mode: standalone.** The IR, runtime and codegen are tightly coupled design work. Two parallel **subagent spikes** at the start, each in a worktree, JS/Nix only and with no native builds:
- (a) Playwright + Chromium from nixpkgs, headless, capturing DOM, geometry and screenshots for one fixture;
- (b) a survey of the Blitz mutator, NodeId, live-control and anyrender backend APIs at the pinned revision.

**User checkpoint:** review the IR v4 schema before the codegen port.

## M2: Values and functions

**Scope:**
- **Numbers:** `f64` with exact JS semantics, including `NaN`, `-0` and shortest round-trip `toString`.
- **Strings:** JS strings with UTF-16 indexing; decide WTF-8 vs UTF-16 storage in a spike.
- **Other values:** `null`/`undefined`, typed objects (structs), arrays (`Vec`), `Map`/`Set`, and `Math`/`Number`/`String`/`Array`/`JSON`/`RegExp` built-ins in `runic-js`.
- **Language features:** template literals, local `let` and mutation, control flow, closures, destructuring, spread, optional chaining.
- **Types and checks:** type inference from the TypeScript checker, with diagnostics for `any` or unknown shapes; range analysis that narrows `f64` to integers where provably safe.
- **Island boundary:** define the marshalling boundary that M6 islands and the M7 bridge will use.

**Examples:** 7GUIs Counter, Temperature Converter and a ledger example (objects, arrays, strings and Map without list rendering). Flight Booker needs `<select>`, so it moves to M5.

**Work mode:**
- **Standalone:** the value-model ADR and the language-layer lowering.
- **Workflow (with user opt-in):** implement built-in families in parallel against Node and test262 excerpts, with independent verifier agents.

**Outcome (done):**
- The value model (D16) is implemented in `runic-js`, the IR, the interpreter and codegen; the four built-in families were written by parallel subagents against Node-generated vectors.
- React, Vue and Svelte run on the TypeScript frontend (`frontend/`), which emits schema 4 directly. The old JS adapters, the schema 3 IR and the schema 3 mapping registry with its discovery tooling were deleted (see the decisions log).
- The three examples run in all three frameworks; with the 14 M1 fixtures that is 55 conformance runs, all passing semantics, geometry and pixels, and no interpreter/codegen mismatch in the differential test.
- The island and bridge boundary is defined in [M2-VALUES](design/M2-VALUES.md#island-and-bridge-boundary).
- Moved out: integer range analysis to M10 (integer narrowing); `RegExp`, `Date` and `Math.random` to M5; Svelte proxy identity to M3. Known deviations are listed in the [results](../conformance/results/m2.md).

## M3: Components and lists

**Scope:**
- **Components:** props (including Svelte `$props` and `$bindable`), callbacks/events, children, slots and Svelte snippets, component-local state with instance lifetimes, and conditional mount/unmount with reset and cleanup.
- **Lists:** keyed lists (`{#each}`, `map`, `v-for`) with stable identity and moves.
- **React regions:** spike React Compiler's reactive-scope analysis vs our own.
- **Refs:** DOM refs (`bind:this`) for focus and measurement.
- **Svelte deep state ownership:** values stored into `$state` behave like Svelte's proxies (identity and raw-write visibility), replacing the M2 deviation.

**Examples:** 7GUIs CRUD and TodoMVC (in memory).

**Work mode:**
- **Standalone:** IR instance/list/region constructs, the runtime reconciler, and the conformance cases, written first as the specification.
- **Parallel subagents:** one per adapter (Svelte first, then React and Vue) in worktrees against the shared cases; native builds are serialised. I integrate; `/code-review` runs before merge.

**Outcome (done):**
- Components, props, two-way bindings, keyed and unkeyed lists with each framework's reorder, slots and snippets, element refs, checkboxes and `keydown` run in all three frameworks ([M3-COMPONENTS](design/M3-COMPONENTS.md#outcome)); Svelte deep state follows Svelte's proxy identity.
- TodoMVC (in memory) and 7GUIs CRUD run in React, Vue and Svelte; 101 conformance runs pass with pixels, optimised and `--no-opt`, except the declared `reorder-navigation` gap (M5 focus model). The differential test covers 29 fixtures and 15 examples without mismatch.
- The React regions spike is reported in [REACT-REGIONS](research/REACT-REGIONS.md); its conclusions feed the M4 reactivity model.
- A review before the tag found eight defects. Three were fixed (cyclic deep state, checkbox toggle order, expression-bodied handlers); three are fixed on the M4 branch by the flush model (per-event dispatch, a flush per timer task, ref writes); the rest are recorded deviations in the [results](../conformance/results/m3.md).

## M4: Effects, time and async

**Scope:**
- **Effects:** `$effect`/`$effect.pre`/`onMount`/`onDestroy`, `useEffect`/`useLayoutEffect`, `watch`/`watchEffect`/`onMounted`, including cleanup ordering.
- **Timers and async:** `setTimeout`/`setInterval`/`requestAnimationFrame`, Promises and `async`/`await` lowered to futures, with microtask vs macrotask ordering.
- **Event loop:** a native event loop on winit.
- **Storage:** `localStorage` as the first host service.
- **Reactivity model** (carried from M3 and [the React regions report](research/REACT-REGIONS.md)), needed before effects can depend on it:
  - dependency analysis shared by the interpreter and codegen, with each framework's update granularity (Svelte block template effects, Vue component re-render, React component re-render that cascades to children), so values read without reactivity refresh as in the framework;
  - derived values computed once per update in per-instance slots (`$derived`, `computed`, React render constants) instead of once per read, which fixes their identity within a render; `useMemo`/`useCallback` as cached slots (not done in M4; [gap register](GAPS.md), F3);
  - an "instance rendered" notion for React effects, and closures that keep their own render's state (stale-closure semantics for timers and `await`);
  - the Rules of React as compile errors (mutating props or state during render, render-time `setState`), which also lets React reference props use identity tracking;
  - refining deep tracking (by reachability or property path) before effects depend on dirtiness.

**Examples:** 7GUIs Timer, and TodoMVC with persistence.

**Work mode:**
- **Standalone:** the event loop and scheduler.
- **Workflow:** probe apps per framework record effect and flush orders in the original runtime as conformance cases. Verifier agents re-run and cross-check them.

**Outcome (done):**
- The event loop (tasks, microtasks, flush jobs, default-priority tasks, virtual time in tests), effects with each framework's phases and orders, timers, promises and `async`/`await` (a state machine in the language layer), `localStorage`, `tick`/`nextTick`, cached derived values and slot-level deep tracking run in all three frameworks ([M4-EFFECTS](design/M4-EFFECTS.md#outcome)).
- 7GUIs Timer and TodoMVC with persistence run in React, Vue and Svelte. The ordering research ([M4-ORDERING](design/M4-ORDERING.md)) became conformance cases for mount, update, unmount, writes from effects, microtask and flush timing, derived values and deep tracking.
- Update granularity was replaced by a validator check (`E_REACTIVITY`) that rejects the template reads where it would be observable; React state and props are read-only. Vue's watcher queue order and unmount position and React's element-position unmount order are rejected with diagnostics.

## M5: Events, forms, layout APIs, services

**Scope:**
- **Events:** the full DOM event model (capture, bubble, `preventDefault`, `stopPropagation`, keyboard, pointer, wheel, focus, scroll).
- **Focus model:** Chromium's sequential navigation starting point as a live range (after a list move blurs the focused element, case `reorder-navigation`), `dblclick`/`blur` editing (TodoMVC's edit mode), placeholders (Blitz gap).
- **Form controls:** textarea, select, radio and multiple editors (controlled checkboxes landed in M3; the single-editor and 256-unit limits ended with the M2 frontends).
- **Layout and measurement:** `getBoundingClientRect`, `ResizeObserver`, scroll position, `matchMedia` (including `prefers-color-scheme`) and inline style bindings. The editor's virtualized list, popovers and floating positioning need these.
- **Host services:** fetch of local resources, clipboard, history and hash routing, console, a `Date`/`Intl` subset, and window title/size.
- **Rendering and accessibility:** SVG icons as far as Blitz renders them; accessibility through AccessKit.

**Examples:** 7GUIs Circle Drawer and Cells; a virtualized 10,000-row list.

**Moved out of M5** (with the reason):
- `ResizeObserver`: to M6. The editor uses it only through its component libraries (bits-ui, floating-ui).
- Fetch of local resources: to M8 (originally M7, before the north star moved there). The editor's only `fetch` reads the desktop appearance, which the application bridge provides natively.
- Window title and size: to M8 packaging. The title comes from `runic.json`; no app sets either at run time.
- Accessibility through AccessKit: to the desktop-input track. It needs a real OS session to verify.
- Sequential navigation from a live range after a move-induced blur (case `reorder-navigation`): to M8. Modelling it exactly needs each framework's exact sequence of DOM moves, in the generated code and in the interpreter, and only Tab presses right after the focused item is reordered can observe it.
- Placeholders: with the Blitz fork in M6 ([BLITZ-GAPS.md](BLITZ-GAPS.md)).
- `Intl.PluralRules` and `Intl.DisplayNames`: to M6. The editor uses both.
- Console reports of unhandled promise rejections (an M4 deviation): to M6. No example relies on them.
- React virtualized lists: React renders scroll-driven updates after the frame (continuous priority), which the IR does not model yet; to M6.

**Work mode:**
- **Standalone:** design the host-service capability interface first.
- **Parallel subagents:** one per independent service crate and control family.
- **Desktop-input track:** standalone with computer use. Port fixes catalogued in the Blitz/Blazor review.

**Outcome (done):**
- The DOM event model, forms (`textarea`, `label`, `select` with a runtime-drawn popup, radio groups), the focus model, layout reads and scrolling with `scroll` events, media query lists, the window `resize` event and the host services (console, clipboard, history, `Date`/`Intl`, `RegExp`, randomness) run in React, Vue and Svelte ([M5-PLATFORM](design/M5-PLATFORM.md)); inline SVG icons render from an allow-listed subset.
- 7GUIs Flight Booker, Circle Drawer and Cells run in all three frameworks, and the virtualized 10,000-row list in Svelte and Vue. 291 conformance runs over 78 cases pass with pixels, optimised and `--no-opt`, except the declared `reorder-navigation` and `ownership-cycles` gaps; the differential test covers 97 fixtures and 29 examples without mismatch.
- The Blitz gaps found on the way and the fork assessment are in [BLITZ-GAPS](BLITZ-GAPS.md); the fork is the first M6 step.

## M6: Libraries, CSS pipeline, SvelteKit, islands

**Scope:**
- **Dependencies:** compile npm dependencies and *component libraries* (bits-ui, shadcn-svelte, `@lucide/svelte`) from source through the adapters and language layer.
- **Mapping packs:** packs for frequent utilities (`clsx`, `tailwind-merge`, `tailwind-variants`, `@internationalized/date`), validated against the real packages.
- **CSS pipeline:** accept plugin-generated CSS (Tailwind 4 via Vite), and audit Blitz/Stylo support for its output (`@layer`, custom properties, `oklch`, `color-mix`, nesting).
- **SvelteKit:** a static SPA subset (`adapter-static`, layouts/pages, the `$app`/`$lib` modules the shadcn-svelte site and the editor use).
- **Corpus and islands:** `runic scan` over a corpus of 20–50 open-source Svelte, React and Vue apps; QuickJS islands (D7), opt-in, with island and coverage reports; model-assisted discovery generalised to library packs.
- **Blitz fork** (decided 2026-10-04, the first step): [`Runic-Artifex/blitz`](https://github.com/Runic-Artifex/blitz), based on upstream main. Move the pin to it (AnyRender 0.14, Taffy and Parley updates, a full conformance rerun), then carry one commit per gap in the order of [BLITZ-GAPS](BLITZ-GAPS.md#fork-assessment), each with the conformance case that shows it and offered upstream; fixture workarounds are removed as their gaps close. Placeholders come with it.
- **Script DOM** (gap P3, user decision 2026-10-13): as much of the DOM as Chromium gives scripts: node values (the document and the window included), script-created nodes and their ownership next to framework-rendered ones, insertion, traversal, attributes and reflected properties, queries, events created by script, observers; first for bits-ui's announcer (the calendars and date pickers) and embla-carousel (the carousels), then breadth ([design](design/M6-SCRIPT-DOM.md)). Run-time HTML parsing waits for a user decision.
- **Carried from M5:** `ResizeObserver`, `Intl.PluralRules`/`DisplayNames`, React's continuous lane (scroll-driven updates rendered after the frame, for the React virtualized list), console reports of unhandled promise rejections.

**Exit:** the shadcn-svelte site's component examples render from source, the corpus coverage report (including the three shadcn sources) is committed, and island counts are recorded as the baseline to reduce from.

**Design:** [M6-LIBRARIES](design/M6-LIBRARIES.md) (decisions, work order, verification), from the research in [M6-LIBRARIES](research/M6-LIBRARIES.md) and [M6-CSS](research/M6-CSS.md). CSS transitions and animations move here from M10 as far as the north star and the editor need them.

**Work mode: workflows** for corpus scanning (one agent per app plus an aggregator) and pack authoring (independent validator agents); standalone for SvelteKit and the QuickJS bridge.

## M7: North star on Linux

The north star compiles from pinned, unmodified upstream sources and passes conformance against the browser:
- **shadcn-svelte:** the documentation site as a whole SvelteKit app (static SPA subset), page by page, including its markdown content and theming;
- **shadcn/ui:** the component examples and blocks (`apps/v4/registry`, `examples`), each mounted in a Vite host page; React's pinned version follows the upstream lockfile;
- **shadcn-vue:** its component examples, mounted the same way.

The apps are packaged for Linux (Nix closure, then AppImage or Flatpak), startup and size are measured, and the desktop-input track is complete for them. QuickJS islands are allowed, but every one is listed with a plan to remove it.

**Work mode:**
- **Workflow:** triage the remaining blockers from the scan, one agent per blocker cluster with verification.
- **Standalone:** integration and packaging.

## M8: Embedding: Godot, then the Runic application bridge

Compiled UIs run inside other programs. The embedder interface is designed once, host-agnostic, and proven with Godot before the Runic SDK depends on it (user decision 2026-10-04: Godot first, then the SDK).

**Scope:**
- **Embedder interface:** the generated app as a library: a C ABI to create, drive (input events, frames, resize) and render it into a host-provided surface or texture, and a typed message channel between the UI and the host. Process model (in-process library or separate process over IPC) decided by a measured spike.
- **Godot host:** a GDExtension that shows a compiled UI in a Godot scene (rendered into a texture, input forwarded from Godot), with a sample project whose game state talks to the UI through the message channel.
- **Runic application bridge (D13):**
  - **Recognition:** recognise the SDK's generated bridge client (generator identity and contract metadata) and lower calls to a native `runic-bridge` client over the embedder interface.
  - **SDK hosting:** the desktop host in `Runic.Desktop` gains a "native UI" mode next to its WebView hosts. This change lives in the SDK repository and is coordinated with the user.
- **The Translations Editor** compiles from its unmodified source and passes conformance against its WebView build; it is packaged for Linux and compared with the WebKitGTK build.

**Examples:** a Godot sample scene, a minimal SDK sample app with a C# view model, then the editor.

**Work mode:**
- **Standalone:** the embedder interface and the cross-language ABI.
- **Subagent spikes:** Godot's GDExtension rendering and input integration; the SDK's `CsWebUiBridge` generator and contract format, and the archived initiative's C ABI.
- **User checkpoint:** before any change in the SDK repository.

## M9: Angular

**Scope:** an Angular adapter (standalone components, signals, control flow blocks, templates) on the shared IR, plus an SDK Angular sample with the bridge.

**Work mode:** standalone adapter design; a workflow to mine Angular runtime conformance cases.

## M10: Optimisation and developer loop

**Scope:**
- **IR optimisation:** constant folding, static subtree hoisting, dead state, integer narrowing.
- **Size and startup:** Blitz feature trimming, font subsetting, startup profiling.
- **Compile time:** incremental generated crates.
- **Developer loop:** `runic dev` watch mode.

Every change is measured with paired measurements; no speed-up is claimed without evidence.

**Work mode: standalone,** with subagents running measurement batches.

## M11: Windows, M12: macOS

**Scope:** port windowing, input, IME and packaging, then run the M8 app on the platform, followed by the full conformance suite. Both need a test environment (VM or machine), which is to be arranged when the milestone starts.

**Work mode: standalone.**

## M13: Optional

Solid and further frontends; porting the language layer or adapters to Rust (oxc) only where M10 profiling shows it is worth it. These need a user decision.

## M14: Pages without a framework (planned)

Added by the user on 2026-10-13 (decisions log). It builds on the M6 script DOM ([design](design/M6-SCRIPT-DOM.md)) and is not started.

- **Plain JavaScript:** a frontend for an `index.html` with module scripts and no framework. The page markup becomes script-owned nodes created at start, and the modules go through the shared language layer. Its first proof, a plain-JavaScript TodoMVC, may land within M6 as the script DOM's end-to-end case.
- **Alpine.js:** an adapter that compiles a page's `x-*` attribute expressions at build time (Alpine itself evaluates them with `new Function`, which would need a JavaScript engine), with Alpine's scheduling verified against Alpine in Chromium.
- **HTMX:** needs run-time HTML parsing (excluded by a deliberate policy today, so a user decision), a network host service with an origin (after M8), and a native implementation of htmx's attribute semantics validated against htmx.

**Work mode:** standalone design per frontend; conformance against the original library in Chromium.

## Decisions log

- 2026-10-03: no specific app was named initially. The Translations Editor is the north star, to be revisited at M8 if needed.
- 2026-10-03: platform order is Linux, then Windows, then macOS, and only after Linux works.
- 2026-10-03: the renderer is selectable per project (D12).
- 2026-10-03: Svelte leads (D14), derived from the SDK's web packages and the editor's stack.
- 2026-10-03 (M2): the schema 3 mapping registry and its model-assisted discovery were retired with the schema 3 IR. Its rules mapped `Math.min`/`Math.max` helper shapes, which the language layer now compiles exactly, and its validator was built on the deleted `ir.mjs`. Mapping packs return in M6 for library APIs (D9), validated against the reference interpreter; the old implementation is at tag `m1`.
- 2026-10-03 (M2): an uncaught exception in a handler keeps the writes made before it, as the frameworks do; the earlier draft's rollback rule was wrong.
- 2026-10-03 (M3): object literals have JavaScript key order (keys are observable), so a literal written in a different order than its declared type is rejected instead of silently reordered.
- 2026-10-03 (M4): effects come before promises in M4's work order; the Timer and persistence examples need them, while promises matter first for the application bridge (M7).
- 2026-10-03 (M4): conformance compiles the Svelte reference for production; generated apps implement production semantics, and Svelte's development build changes `await` timing.
- 2026-10-03 (M4): instead of reproducing each framework's re-render granularity, templates may not read values that change without notifying the framework (`E_REACTIVITY`); granularity is observable only through such reads.
- 2026-10-04 (M6): the Blitz fork is `Runic-Artifex/blitz`, based on upstream main (user decision); its patches are listed in [BLITZ-GAPS](BLITZ-GAPS.md).
- 2026-10-04 (M6): CSS transitions and animations move from M10 into M6 as far as the editor needs them, driven by the runtime's clock and compared with Chromium's fake clock; the editor's components animate their open and closed states and bits-ui awaits `getAnimations()`, and stripping them would be an approximation ([M6 design](design/M6-LIBRARIES.md)).
- 2026-10-04: the north star is the shadcn sites (user decision): the whole shadcn-svelte documentation site, and the shadcn/ui (React) and shadcn-vue component examples, from pinned GitHub commits (M7). They are more diverse than one application and keep verification independent of Runic; the compiler is also meant for hosts other than Runic (a Godot UI). The Runic application bridge and the Translations Editor move to M8.
- 2026-10-04: M8 starts with a host-agnostic embedder interface proven by a Godot host, then the Runic bridge and the Translations Editor (user suggestion). Claude works autonomously until a change to the Runic SDK repository is needed.
- 2026-10-07 (M6, user decisions after the [approach review](research/APPROACH-REVIEW.md)): default builds keep containing no JavaScript engine (D7 stands); a time-boxed spike of a dynamic value tier for untyped code starts now (adopting it would amend D16, so its result comes back to the user); after it, breadth sweeps from the [gap register](GAPS.md) (elements, events, missing framework APIs) come before further hard components, and progress is measured in working previews and pages.
- 2026-10-07 (M6): the dynamic values spike is implemented behind `runic.json` `"dynamicValues": true` ([results](design/M6-DYNAMIC-VALUES.md#results-2026-10-07)): bits-ui's Pagination compiles with no new inference rule and passes its case; nothing changes without the opt-in. The user adopted it as an opt-in (D16 amended); breadth sweeps follow, using it where package code is untyped.
- 2026-10-12 (M6, user decisions after the example census, `conformance/triage.mjs`): a shadcn-svelte component example counts as the shadcn-svelte CLI installs it. The corpus's own pinned icon transform rewrites `IconPlaceholder` to `@lucide/svelte` imports in the host copies; the upstream sources stay unmodified. This makes the bits-* fixtures' existing practice explicit.
- 2026-10-12 (M6): remote images become pinned build assets. A separate, explicit fetch operation records each remote image by URL and SHA-256 into the app; builds stay offline and deterministic, and an unpinned remote source is rejected. Local images use the same asset path. The IR change gets its architecture checkpoint before implementation.
- 2026-10-13 (M6, user decision): CSS compatibility is a workstream of its own: as much CSS as possible behaves as in Chromium 153 in compiled apps, slice by slice in the Runic forks (Blitz, Stylo, Taffy, Parley) and the compiler, so that rules are laid out and painted faithfully instead of rejected or reported. It matters beyond the shadcn north star: full Bootstrap 5.3 compatibility is planned future scope, not done. Its first survey is [bootstrap-5.3-css-survey](../conformance/results/bootstrap-5.3-css-survey.md).
- 2026-10-13 (M6, user decision, verbatim): "the next workstreams should be a full run on as much DOM support as possible. (So in the future we can even get simple apps that use handwritten javascript or Alpine.js or HTMX working)". The script DOM (gap P3) becomes an M6 workstream ([design](design/M6-SCRIPT-DOM.md)); a plain-JavaScript frontend, Alpine.js and HTMX pages are new planned scope (M14), not done.
- 2026-10-13 (M6, user decisions on the script DOM design): the IR's `element` type becomes a general node handle (elements, text and other nodes, the document, the window) within schema 5, with no schema bump; run-time HTML parsing is accepted as an opt-in capability, `runic.json` `"htmlParsing": true` (Blitz's html5ever fragment parser linked only then; default builds unchanged), planned as a later script DOM slice ([design](design/M6-SCRIPT-DOM.md#4-html-strings)).
- 2026-10-13 (M6, CSS slice 2b, user decision; implemented 2026-10-14): native apps read `prefers-reduced-motion` and `prefers-contrast` from the desktop as Chromium 153 does on Linux, through two new direct dependencies of runic-runtime on Linux: `x11rb` (XSETTINGS on X11) at the version already in Cargo.lock through winit (`=0.13.2`, no default features), and `zbus` (the XDG settings portal on Wayland) pinned to one exact version with minimal features (`=5.19.0`, `blocking-api` and its `async-io` runtime). The lock was resolved once (offline, from the local registry cache: 36 crates) and builds stay `--offline`. Where no setting is readable the runtime keeps reporting the rules that test it ([results](../conformance/results/desktop-preferences.md)).
