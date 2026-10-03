# Compatibility contract v6

The input that is implemented and verified as of milestone M2. This is a living document: milestones update it in place, and git history and the `m<N>` tags record earlier versions (v5 is at tag `m1`; v1–v4 are in `history/`). Roadmap items are not part of the contract until a milestone verifies them.

M2 replaced the Phase 1–4 adapters with TypeScript frontends on one shared language layer (`frontend/`), which emit [IR schema 4](IR.md) directly. Ordinary JavaScript/TypeScript code now follows the JavaScript value model instead of the earlier bounded scalar subset. Native applications execute no JavaScript engine.

## Collection

`runic.json` selects a local entry, title, optional `framework` (`react`, the default, `vue` or `svelte`) and optional `renderer` (`cpu`, the default, or `gpu`). All apps use an empty `div#root` and one module script. Vite collects original sources, ordered local CSS and WOFF2 assets; inline HTML scripts are rejected.

Checked identities are React/React DOM 19.3.0, Vue/compiler-sfc 3.5.43 or 3.5.24, and Svelte/compiler 5.57.1 or 5.49.2. Runtime and compiler versions must match; other versions fail with `E_FRONTEND_VERSION`. Vite 8.3.2, TypeScript 5.9.3, plugin-vue 6.0.9 and the Svelte Vite plugin 7.3.1 are pinned tools.

CSS may use any selectors and properties; Blitz/Stylo renders them and conformance checks the result. At-rules other than `@font-face` and `@media`, and `animation`/`transition` properties, are rejected (time-based behaviour is M10). Resources must be bounded local WOFF2 files; native builds require one embedded font.

## Language

Every adapter lowers ordinary code through the shared layer. TypeScript's checker supplies types; in untyped JavaScript the frontend infers IR types from the lowered values and specialises untyped helper functions per call-site argument types.

**Values** ([value model](design/M2-VALUES.md)): numbers with exact double semantics; UTF-16 strings; booleans; `null`/`undefined` and nullable types (`T | null | undefined`); string/number/boolean literal unions; objects with a fixed shape (records); arrays; `Map`/`Set`; functions and closures. Other unions, `any`/`unknown` that cannot be inferred, classes, symbols, bigint and heterogeneous tuples are rejected with `E_TYPE_UNSUPPORTED`/`E_TYPE_UNION`.

**Statements and expressions:** `const`/`let`, assignment and compound assignment to locals, cells, fields and array elements; `if`, `switch`, `while`, `do`/`for`/`for-of` with labelled `break`/`continue`; functions, arrow functions and closures (captured variables are shared by reference); `return`, `throw`, `try`/`catch`/`finally`; template literals; object/array destructuring and spread; optional chaining and `??`; all arithmetic, bitwise, comparison, logical and `typeof` operators; `Number`/`String`/`Boolean` conversions.

**Built-ins:** `Math` (except `random`), `Number`, string and array methods, `Array.from`/`isArray`, `Object.keys/values/entries/assign`, `JSON.stringify`/`JSON.parse` into a declared type, `Map`/`Set` and `structuredClone`, as listed in [M2-VALUES](design/M2-VALUES.md). Identifiers resolve by symbol, so a local `Math` shadows the global one. Unknown globals and methods are rejected (`E_UNRESOLVED`, `E_MEMBER`, `E_BUILTIN`).

**Modules:** components can import named bindings from local `.js`/`.ts` modules, with aliases, export lists and named re-exports. Modules initialise once, dependencies first. Module functions become shared functions; constants are evaluated once in order (object constants keep their identity). Mutable module state, top-level statements, default/namespace/star imports and exports, cycles and npm dependencies are rejected (M3/M4/M6).

**Outside M2:** classes, `async`/`await`, generators, `RegExp`, `Date`, `Math.random`, getters/setters, `in`/`instanceof`, rest parameters, computed keys, logical assignment and string literals containing lone surrogates.

## React

The entry calls `createRoot(document.getElementById('root')).render(<App />)` for a local function component. The root component's body holds `useState` declarations (non-lazy initialisers), const render values, nested functions and one returned JSX tree; an expression-bodied arrow component is accepted. Reads see the render snapshot; setters with values or updater functions queue in order and commit after the handler, as in React. State, effects and other hooks in child components are M3/M4 (`E_COMPONENT`, `E_CAPABILITY`).

Stateless child components are inlined: props (destructured or through a `props` parameter, typed or untyped) bind to the caller's values. JSX supports the native tag allow-list, string and expression attributes (entities decoded), `className`, `onClick`, `onChange` on inputs (the handler may read `e.target.value`), `&&` and `?:` conditionals and fragments. Lists, children props, spreads, style objects and other events are rejected.

## Vue

The entry calls `createApp(App).mount('#root')` on one local SFC with `<script setup>` (JS or TS). Setup supports `ref`, `computed`, functions, const values and local module imports. `ref` reads see earlier writes immediately and mutation of nested values is tracked. Templates support the tag allow-list, static attributes, `:attr` bindings, interpolation, `v-if`/`v-else-if`/`v-else` and `@click`/`@input` with named handlers or inline expressions (`$event`). Directive modifiers, `v-model`, `v-for`, `v-show`, watchers and lifecycle hooks are rejected. Vue marks `#root` with `data-v-app`.

## Svelte

The entry calls `mount(App, {target: document.getElementById('root')})` (or `querySelector('#root')`) on one local component in runes mode. The instance script supports `$state` (deeply tracked), `$state.raw`, `$derived`, `$derived.by`, functions, `let`/`const` values and module imports. Reads see earlier writes immediately and derived values recompute on read. Markup supports the tag allow-list, attributes with expressions, interpolation, `onclick`/`oninput` handlers, `bind:value` on a text input bound to a string `$state`, and `{#if}`/`{:else if}`/`{:else}`. `$effect`, `$props`, `<script module>`, component styles, legacy `on:` directives, actions, class directives, `{#each}`, snippets and child components are rejected (M3–M6).

## Native runtime and controls

The Rust backend validates every program and generates an application crate linked against `crates/runic-runtime`. The runtime builds the DOM directly through Blitz's mutator API under `<div id="root">`, keeps node handles, and updates only bindings whose cells changed (or all bindings with `--no-opt`). Conditional content is mounted and removed as subtrees. It supplies the browser behaviour the pinned Blitz lacks:

- **Focus.** Focus moves on mousedown: pointer activation focuses buttons, and pressing on non-focusable content (including a disabled control) clears focus. Tab and Shift+Tab move through rendered, enabled buttons and inputs in tree order, resuming from Chromium's sequential starting point when nothing is focused. A focused control that becomes disabled loses focus.
- **Activation and events.** Clicks bubble through all click listeners on the path, target first. Nothing is dispatched for targets inside disabled controls. Enter (key down) and Space (key up after key down on the same button) activate focused buttons.
- **Editors.** Script-set values update the live control only when they differ, so echoes preserve selection and composition; a script-set value puts the caret at the end and keyboard focus selects all text. Read-only and disabled edits are blocked. Insertion beyond `maxlength` (UTF-16 units) and control characters are stopped before mutation.
- **Rendering.** The canvas is painted white beneath the document. Form controls use Chromium's 13.333 px default font size. The CPU (vello_cpu) and GPU (vello) renderers are selected per project.

## Verification

`conformance/run.mjs` drives the original framework in headless Chromium and the native app's probe build with the same pointer and key input. It compares DOM semantics (tags, attributes, text, live values, selections, focus), geometry within 2 px and, with `--pixels`, screenshots within a mean absolute error of 3/255. `conformance/differential.mjs` compares generated code with the reference interpreter on seeded random traces. Comparisons observe committed output after natural paint and focus settling and never force blur. [M2 results](../conformance/results/m2.md) list the cases, results and known deviations.

OS keyboard delivery, IME and Wayland resize are not certified (internal events do not prove them). Clipboard, textarea, select, forms, lists, persistence, multiple windows and accessibility are outside verified support. Builds are atomic and run `--offline` against the workspace `Cargo.lock`. No performance improvement is claimed beyond the measured startup and size figures in the results.
