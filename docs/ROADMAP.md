# Roadmap

A rough plan for the whole compiler, written on 2026-10-03. It replaces the Phase 5–8 plan in [history/PHASES5-8.md](history/PHASES5-8.md). Milestones are numbered M0–M10 so they don't collide with the historical Phases 0–4. Each milestone is driven by **example applications** rather than by abstract capability lists: a milestone is done when its examples pass conformance in every supported framework.

How each kind of work is executed (standalone, subagents or workflows) is defined in [WORKING.md](WORKING.md). Each milestone below states which mode to use and why.

## Overview

| Milestone | Outcome | Driving examples | Main mode | Status |
|---|---|---|---|---|
| M0 | Repository restructure and plan | — | Standalone | Done 2026-10-03 |
| M1 | Rust IR, codegen and runtime library; automated conformance harness | all 15 existing fixtures | Standalone, 2 spikes | Next |
| M2 | JS values, statements and functions | 7GUIs Counter, Temperature Converter, Flight Booker | Standalone design, then a workflow for built-ins | Planned |
| M3 | Components, slots, keyed lists, instance lifetimes | 7GUIs CRUD, TodoMVC (in memory) | Standalone core, then parallel subagents per adapter | Planned |
| M4 | Effects, timers, async, event loop, storage | 7GUIs Timer, TodoMVC with persistence | Standalone, then a workflow to mine ordering cases | Planned |
| M5 | Full event model, forms, host services, routing | 7GUIs Circle Drawer, Cells; TodoMVC with routes | Subagents per service; desktop track standalone | Planned |
| M6 | npm libraries, mapping packs, corpus scan, QuickJS islands | corpus of real open-source apps | Workflows for corpus and packs | Planned |
| M7 | Real applications and delivery (Linux, then Windows/macOS) | RealWorld "Conduit" in React, Vue, Svelte | Workflow for triage, standalone for packaging | Planned |
| M8 | Optimisation: size, startup, compile time, dev loop | M7 apps | Standalone with measured experiments | Planned |
| M9 | More frontends: Solid, then Angular | 7GUIs + TodoMVC per new framework | Subagent per adapter | Planned |
| M10 | (Optional) Port frontends/language layer to Rust | — | Decided by M8 profiling | Optional |

**Continuous tracks that run alongside the milestones:**

- **Desktop input:** OS keyboard, IME, Wayland resize, accessibility. Needs real compositor sessions, so it is done standalone with computer use. It never blocks compiler milestones, and its results are reported separately.
- **Blitz upstream:** report and fix renderer and control bugs upstream and keep the pin current (D11).
- **Native coverage:** from M6 on, the island count and native-coverage % of the corpus apps are tracked per milestone and must not regress.

## M0: Restructure (done)

- Sol's work is committed unchanged and tagged `baseline/phase4`.
- Historical plans, evidence reports and old contracts moved to `docs/history/`. Raw evidence, baselines and the per-phase scripts are removed from the tree and stay reproducible from the tag ([history/README.md](history/README.md)).
- Mapping proofs moved to `mappings/proofs/` and were re-accepted against the formatted validator. The candidate bytes are unchanged.
- The compiler is formatted with Prettier (now in the dev shell). `npm test` passes (45/45) and the native fixture build still works.
- New [ARCHITECTURE.md](ARCHITECTURE.md), this roadmap, [WORKING.md](WORKING.md) and `AGENTS.md`.

## M1: Foundation

Replace the parts that cannot scale before adding any capability.

**Scope**

1. **Workspace.** A cargo workspace with `crates/runic-ir`, `crates/runic-codegen` (library + `runic-codegen` binary), `crates/runic-runtime` and `crates/runic-probe`. The generated crate depends on `runic-runtime` by path, so files are no longer copied into each app. Assets use `include_bytes!` instead of base64 inside the CSS constant. Add a `RUNIC_TARGET_DIR` override and a shared build lock so worktrees can share one cargo target (see WORKING.md).
2. **IR v4 core.** Rust types (serde) for the current capabilities, rebuilt around D4/D5: cells, derived values, handlers, static blocks with holes, conditional regions, and capability declarations. Leave room for instances and lists without implementing them yet. Add the validator, the reference interpreter, JSON Schema export and `schema 3 → 4` migration. Port `TEXT-VALIDATION` guarantees as interpreter and validator rules.
3. **Runtime rewrite.** Keep a `NodeId` handle table, build nodes directly with the Blitz mutator API, replace the `set_inner_html` conditionals with constructed subtrees, and move probe/trace modes behind a `probe` feature. Keep the existing live-control behaviour of `controls.rs` (equal-value echo, read-only guard, overflow stop) along with its probes.
4. **Frontends.** Convert `compiler/` to TypeScript (type-stripped `.ts`, `tsc --noEmit` in `npm test`) and emit IR v4 JSON. Delete `ir.mjs` and `codegen.mjs` once the Rust path passes. Move the mapping validator's oracle to the interpreter and re-prove the mappings.
5. **Conformance harness.** A single harness in `conformance/` replaces the per-phase scripts. It uses a case manifest (app, framework, version, viewport, action trace, expected-observation kinds) and drives:
   - headless Chromium through Playwright from nixpkgs, running the original framework;
   - native apps in headless snapshot mode;
   - the reference interpreter.

   It compares DOM/text semantics first, then geometry, then pixels at the existing 3/255 calibrated tolerance. The report is JSON plus a short summary, written under `artifacts/` with only a summary committed. The T3 preview stays for manual inspection only.
6. **`runic scan`.** Analyse an app and report every unsupported construct by diagnostic code and frequency without stopping at the first error. This gives the data used to prioritise M2–M6.

**Exit criteria:** all 15 fixtures and the incompatible fixtures pass, or reject with the same diagnostics, on the new pipeline through the harness, both `--no-opt` and optimised. The old JS IR and codegen are deleted. CI-equivalent `npm test && cargo test --workspace` passes, and one command runs full conformance.

**Work mode: standalone.** The IR, runtime and codegen are tightly coupled design work where coherence matters more than parallelism. Two parallel **subagent spikes** at the start, each in a worktree, JS/Nix only and with no native builds:
- (a) Playwright + Chromium from nixpkgs, headless, capturing DOM, geometry and screenshots for one existing fixture;
- (b) a survey of the Blitz mutator, NodeId and live-control APIs at the pinned revision, listing which `controls.rs` behaviours need which calls.

**User checkpoint:** review the IR v4 schema before the codegen port.

## M2: Values and functions

**Scope:**
- **Numbers:** `f64` with exact JS semantics, including `NaN`, `-0` and shortest round-trip `toString`.
- **Strings:** JS strings with UTF-16 indexing; decide WTF-8 vs UTF-16 storage in a spike.
- **Other values:** `null`/`undefined`, typed objects (structs), arrays (`Vec`) and `Math`/`Number`/`String`/`Array`/`JSON` built-ins in `runic-js`.
- **Language features:** template literals, local `let` and mutation, control flow (`if`, loops, `switch`, `return`, `break`/`continue`), closures inside components, destructuring, optional chaining.
- **Types and checks:** type inference from the TypeScript checker, with source-located diagnostics for `any` or unknown shapes; a range analysis that narrows `f64` to integers where provably safe.
- **Island boundary:** define the marshalling boundary that M6 islands will use, so values never need redesigning.

**Examples:** 7GUIs Counter, Temperature Converter (parse/format numbers, two-way text), Flight Booker (validation, disabled states, string parsing), each in React, Vue and Svelte.

**Work mode:**
- **Standalone:** the value-model ADR and the language-layer lowering.
- **Workflow (with user opt-in):** implement built-in families in parallel (Number, String, Array, Math, JSON). Each agent writes Rust and differential tests against Node and test262 excerpts; an independent verifier agent attacks each family. This fits well because the units are independent and have an objective oracle.

## M3: Components and lists

**Scope:**
- **Components:** props (read-only), callbacks/emits, children/slots and snippets, component-local state with instance lifetimes, and conditional mount/unmount with reset and cleanup.
- **Lists:** keyed lists (`map`, `v-for`, `{#each}`) with stable identity and moves.
- **React:** regions for code that analysis cannot make fine-grained. Spike: reuse React Compiler's reactive-scope analysis vs our own. For Vue, evaluate the Vapor compiler IR as an input.
- **Refs:** DOM refs limited to focus and measurement.

**Examples:** 7GUIs CRUD and TodoMVC (in-memory) in all three frameworks.

**Work mode:**
- **Standalone:** IR instance/list/region constructs, the runtime reconciler, and the conformance cases. The cases are written *first* and serve as the specification.
- **Parallel subagents:** after the IR is frozen, one per adapter (React, Vue, Svelte), each in a worktree working against the shared cases, with native builds serialised through the shared target (WORKING.md). I integrate and review; `/code-review` runs before merge.

## M4: Effects, time and async

**Scope:**
- **Effects:** `useEffect`/`useLayoutEffect`, `watch`/`watchEffect`/`onMounted`/`onUnmounted`, and `$effect`/`$effect.pre`/`onMount`, including cleanup ordering.
- **Timers and async:** `setTimeout`/`setInterval`/`requestAnimationFrame`, Promises and `async`/`await` lowered to futures, and microtask vs macrotask ordering.
- **Event loop:** a native event loop on winit.
- **Storage:** `localStorage` as the first host service.

**Examples:** 7GUIs Timer, and TodoMVC with persistence.

**Work mode:**
- **Standalone:** the event loop and scheduler. Ordering semantics are subtle and cross-cutting.
- **Workflow:** mine ordering behaviour. Agents generate small probe apps per framework, run them in the original runtime and record observed effect and flush orders as conformance cases. Verifier agents re-run and cross-check them before they become expectations.

## M5: Events, forms, services and routing

**Scope:**
- **Events:** the full DOM event model (capture, bubble, `preventDefault`, `stopPropagation`, keyboard, pointer, wheel, focus).
- **Form controls:** textarea, select, checkbox, radio and multiple editors. Lift the single-editor and 256-unit limits.
- **Host services:** fetch, clipboard, history and hash routing, console, a `Date`/`Intl` subset, and window title/size.
- **Rendering:** SVG as far as Blitz renders it.
- **Accessibility:** through AccessKit.

**Examples:** 7GUIs Circle Drawer (pointer, undo, dialog) and Cells (parser, dependency graph); TodoMVC with `#/active` routes.

**Work mode:**
- **Standalone:** design the host-service capability interface first.
- **Parallel subagents:** one per independent service crate and form control family.
- **Desktop-input track:** standalone with computer use. Port fixes catalogued in the Blitz/Blazor review.

## M6: Libraries, packs and islands

**Scope:**
- **Dependencies:** compile pure npm dependencies through the language layer.
- **Mapping packs:** packs for frequent libraries (for example `clsx`, `date-fns`, `nanoid`), validated against the real package.
- **Corpus:** a curated corpus of 20–50 open-source apps scanned with `runic scan`.
- **QuickJS islands (D7):** opt-in, with island and coverage reports.
- **Discovery:** model-assisted discovery generalised to library packs. It proposes only; acceptance stays independent.

**Exit:** a corpus coverage report with the top blockers ranked, and island counts recorded as the baseline to reduce from.

**Work mode: workflows.**
- Corpus scanning fans out with one agent per app plus an aggregator.
- Pack authoring fans out with independent validator agents.
- The QuickJS bridge is built standalone.

## M7: Real apps and delivery

**Scope:**
- **Apps:** RealWorld "Conduit" frontends in React, Vue and Svelte (routing, fetch, auth, lists, forms) plus 2–3 corpus apps chosen with the user.
- **Packaging:** Linux packages (Nix closure first, then AppImage or Flatpak), followed by Windows and macOS builds.
- **Budgets:** size and startup budgets compared against Tauri and Electron builds of the same apps.

**Work mode:**
- **Workflow:** triage blockers per app.
- **Standalone:** packaging and cross-platform work.

## M8: Optimisation and developer loop

**Scope:**
- **IR optimisation:** constant folding, static subtree hoisting, dead state, integer narrowing.
- **Size:** Blitz feature trimming, and a decision between the CPU and GPU renderer.
- **Compile time:** incremental generated crates.
- **Developer loop:** `runic dev` watch mode.

Every change is measured with paired measurements, keeping the Phase 1 discipline of claiming no speed-up without evidence.

**Work mode: standalone,** with subagents running measurement batches.

## M9: More frontends

**Scope:**
- **Solid** first. It maps almost directly onto D4.
- **Angular** (signals and templates) second.
- **Upgrades:** a version-upgrade workflow that runs conformance against a new framework release and reports the affected adapters.

**Work mode:** one subagent per adapter, against the existing example cases.

## M10: Optional Rust frontends

Profile M8 compile times. Port the language layer or adapters to Rust (oxc for JS/TS) only where that is measurably worth it and official parsers allow it. This needs a user decision.

## Open decisions for the user

- North-star applications for M7: is there a specific Runic app this should ultimately compile?
- Platform priority after Linux: Windows or macOS first, and when.
- Renderer: stay with `vello_cpu` (portable, larger CPU cost) or move to GPU Vello by default.
