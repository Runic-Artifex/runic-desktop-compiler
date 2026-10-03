# Compatibility contract v7

The input that is implemented and verified as of milestone M3. This is a living document: milestones update it in place, and git history and the `m<N>` tags record earlier versions (v6 is at tag `m2`, v5 at `m1`; v1–v4 are in `history/`). Roadmap items are not part of the contract until a milestone verifies them.

The TypeScript frontends (`frontend/`) lower every framework through one shared language layer to [IR schema 4](IR.md). Ordinary JavaScript/TypeScript code follows the JavaScript value model. M3 added component instances, props, lists, slots, element refs, checkboxes and `keydown` ([design](design/M3-COMPONENTS.md)). Native applications execute no JavaScript engine.

## Collection

`runic.json` selects a local entry, title, optional `framework` (`react`, the default, `vue` or `svelte`) and optional `renderer` (`cpu`, the default, or `gpu`). All apps use an empty `div#root` and one module script. Vite collects original sources, ordered local CSS and WOFF2 assets; inline HTML scripts are rejected.

Checked identities are React/React DOM 19.3.0, Vue/compiler-sfc 3.5.43 or 3.5.24, and Svelte/compiler 5.57.1 or 5.49.2. Runtime and compiler versions must match; other versions fail with `E_FRONTEND_VERSION`. Vite 8.3.2, TypeScript 5.9.3, plugin-vue 6.0.9 and the Svelte Vite plugin 7.3.1 are pinned tools.

CSS may use any selectors and properties; Blitz/Stylo renders them and conformance checks the result. At-rules other than `@font-face` and `@media`, and `animation`/`transition` properties, are rejected (time-based behaviour is M10). Resources must be bounded local WOFF2 files; native builds require one embedded font.

## Language

Every adapter lowers ordinary code through the shared layer. TypeScript's checker supplies types; in untyped JavaScript the frontend infers IR types from the lowered values and specialises untyped helper functions per call-site argument types.

**Values** ([value model](design/M2-VALUES.md)): numbers with exact double semantics; UTF-16 strings; booleans; `null`/`undefined` and nullable types (`T | null | undefined`); string/number/boolean literal unions; objects with a fixed shape (records); arrays; `Map`/`Set`; functions and closures. Other unions, `any`/`unknown` that cannot be inferred, classes, symbols, bigint and heterogeneous tuples are rejected with `E_TYPE_UNSUPPORTED`/`E_TYPE_UNION`.

**Statements and expressions:** `const`/`let`, assignment and compound assignment to locals, cells, fields and array elements; `if`, `switch`, `while`, `do`/`for`/`for-of` with labelled `break`/`continue`; functions, arrow functions and closures (captured variables are shared by reference); `return`, `throw`, `try`/`catch`/`finally`; template literals; object/array destructuring and spread; optional chaining and `??`; all arithmetic, bitwise, comparison, logical and `typeof` operators; `Number`/`String`/`Boolean` conversions.

**Built-ins:** `Math` (except `random`), `Number`, string and array methods, `Array.from`/`isArray`, `Object.keys/values/entries/assign`, `JSON.stringify`/`JSON.parse` into a declared type, `Map`/`Set` and `structuredClone`, as listed in [M2-VALUES](design/M2-VALUES.md). Identifiers resolve by symbol, so a local `Math` shadows the global one. Unknown globals and methods are rejected (`E_UNRESOLVED`, `E_MEMBER`, `E_BUILTIN`).

**Object keys** are observable (`Object.keys`, `JSON.stringify`), so a record keeps the key order of the literal that creates it; a spread contributes its source's keys in their order. A literal whose properties are in a different order than its declared type is rejected (`E_OBJECT`).

**Modules:** components can import named bindings from local `.js`/`.ts` modules, with aliases, export lists and named re-exports, and import other components (`.svelte`, `.vue`, function components). Modules initialise once, dependencies first. Module functions become shared functions; constants become program globals, evaluated once in order (object constants keep their identity). Mutable module state, top-level statements, default/namespace/star imports of plain modules, cycles and npm dependencies are rejected (M4/M6).

**Outside M3:** classes, `async`/`await`, generators, `RegExp`, `Date`, `Math.random`, getters/setters, `in`/`instanceof`, rest parameters, computed keys, logical assignment and string literals containing lone surrogates.

## React

The entry calls `createRoot(document.getElementById('root')).render(<App />)` for a local function component. Every function component is a component with instances: a rendered `<Child/>` gets its own state, created and destroyed with its region (a conditional branch, a list item), so state resets on remount. A component body holds `useState` declarations (non-lazy initialisers), const render values, nested functions and one returned JSX tree; expression-bodied arrow components are accepted. Reads see the render snapshot; setters with values or updater functions queue in order and commit after the handler.

- **Props:** destructured or through a `props` parameter, typed by TypeScript or, in JavaScript, by the first call site. Callbacks are function props. `children` and other `ReactNode` props rendered as `{children}`, and render props `(x: T) => ReactNode` called as `{row(x)}`, are slots evaluated in the parent.
- **Lists:** `items.map(item => <Row key={…}/>)`, keyed or (without a key) by index, with React's forward-placement reorder; React DOM's focus restore after a commit is reproduced. A `key` elsewhere remounts its element when it changes.
- **JSX:** the native tag allow-list, string and expression attributes (entities decoded), `className`, `&&`/`?:` conditionals and fragments.
- **Events:** `onClick`, `onChange` on text inputs (`e.target.value`) and controlled checkboxes (`checked`, `e.target.checked`), `onKeyDown` (`e.key`); event fields may be read in closures inside the handler. Handlers that read list items are inline arrows.
- **Refs:** `useRef<HTMLInputElement | null>(null)` attached with `ref={r}` to one element of the same component; `r.current` reads the live element (`focus()`, `blur()`, null checks). `useRef` of numbers, strings and booleans is a mutable box that never re-renders. Callback refs, refs passed to components, one ref on several elements, refs in list items or slot content, ref reads during render and refs holding objects are rejected.
- Rejected: effects and other hooks (M4), lazy initialisers, spread attributes and props, rest and nested prop destructuring, style objects, recursive components, other events (M5).

## Vue

The entry calls `createApp(App).mount('#root')` on a local SFC with `<script setup>` (JS or TS). Setup supports `ref`, `computed`, functions, const values and local module imports; `ref` reads see earlier writes immediately and nested mutation is tracked. Templates support the tag allow-list, static attributes, `:attr` bindings, interpolation and `v-if`/`v-else-if`/`v-else`. Vue marks `#root` with `data-v-app`.

- **Components:** child SFCs are instances. `defineProps<T>()` (destructured or as an object, optionally with `withDefaults`), `defineEmits<T>()` (as `on<Event>` callbacks) and `defineModel<T>()` with the parent's `v-model`.
- **Lists:** `v-for` over arrays with `:key`, keyed or by index, with Vue's longest-increasing-subsequence reorder.
- **Slots:** `<slot>` outlets (default, named, scoped, with fallback), typed by `defineSlots<T>()` or inferred; `<template #name>`, `v-slot` and default content in the parent, with destructured slot props.
- **Events:** `@click`, `@input` (`$event`), `@change` and `:checked`/`v-model` on checkboxes, `@keydown` with key modifiers (`withKeys` aliases); several listeners of one event run in order.
- **Refs:** `ref="name"` on an element bound to a `ref()`/`shallowRef()` of that name or to `useTemplateRef<T>('name')`; the ref holds the element while it is mounted and `null` after removal. Refs read during rendering, writes to template refs, `:ref`, refs in `v-for` or slot content and refs on components, slots or `<template>` are rejected.
- Rejected: other directive modifiers, `v-model` on text inputs (IME composition), `v-show`, watchers and lifecycle hooks (M4), dynamic slot names, `$slots`, slot content that may render nothing where the child has a fallback.

## Svelte

The entry calls `mount(App, {target: document.getElementById('root')})` (or `querySelector('#root')`) on a local component in runes mode. Scripts support `$state`, `$state.raw`, `$derived`, `$derived.by`, functions, `let`/`const` values and module imports. Reads see earlier writes immediately and derived values recompute on read. Markup supports the tag allow-list, attributes with expressions (an empty `class` is omitted), interpolation and `{#if}`/`{:else if}`/`{:else}`.

- **Deep state:** `$state` stores proxies of plain objects and arrays, with Svelte's identity: storing a raw object gives a new proxy, and only writes through the proxy are reactive ([ownership](design/M3-COMPONENTS.md#svelte-deep-state-ownership)).
- **Components:** child components are instances; `$props()` with defaults and `$bindable`, `bind:prop`, callback props.
- **Lists:** `{#each}` with index, key, destructured items and `{:else}`, with Svelte's keyed reconcile; `{#key}` remounts its content.
- **Snippets:** `children`, named snippets and `{@render}` with arguments.
- **Events and bindings:** `onclick`, `oninput`, `onchange`, `onkeydown` (`e.key`); `bind:value` on text inputs, `checked`/`bind:checked` on checkboxes (also into list items and props), `bind:this` element refs.
- Rejected: `$effect` and lifecycle functions (M4), `<script module>`, component styles, legacy `on:` directives, actions, class directives, function bindings, `experimental.async`.

## Native runtime and controls

The Rust backend validates every program and generates an application crate linked against `crates/runic-runtime`. The runtime builds the DOM directly through Blitz's mutator API under `<div id="root">`, keeps node handles, and updates only bindings whose cells changed (or all bindings with `--no-opt`). Conditional content and component instances are mounted and removed as subtrees; keyed lists move existing nodes with the framework's reorder strategy, and moving a focused element blurs it as in Chromium. It supplies the browser behaviour the pinned Blitz lacks:

- **Focus.** Focus moves on mousedown: pointer activation focuses buttons, and pressing on non-focusable content (including a disabled control) clears focus. Tab and Shift+Tab move through rendered, enabled buttons and inputs in tree order, resuming from Chromium's sequential starting point when nothing is focused. A focused control that becomes disabled loses focus.
- **Activation and events.** Clicks and `keydown` bubble through the listeners on the path, target first; `keydown` listeners run before default actions. Nothing is dispatched for targets inside disabled controls. Enter (key down) and Space (key up after key down on the same button) activate focused buttons. Checkbox activation toggles `checked`, then dispatches `click` and `change`.
- **Refs.** Element refs are set when their element mounts and cleared when it is removed; `focus()` and `blur()` apply after the update.
- **Editors.** Script-set values update the live control only when they differ, so echoes preserve selection and composition; a script-set value puts the caret at the end and keyboard focus selects all text. Read-only and disabled edits are blocked. Insertion beyond `maxlength` (UTF-16 units) and control characters are stopped before mutation.
- **Rendering.** The canvas is painted white beneath the document. Form controls use Chromium's 13.333 px default font size. The CPU (vello_cpu) and GPU (vello) renderers are selected per project.

## Verification

`conformance/run.mjs` drives the original framework in headless Chromium and the native app's probe build with the same pointer and key input. It compares DOM semantics (tags, attributes, text, live values, selections, focus), geometry within 2 px and, with `--pixels`, screenshots within a mean absolute error of 3/255. `conformance/differential.mjs` compares generated code with the reference interpreter on seeded random traces. Comparisons observe committed output after natural paint and focus settling and never force blur. [M3 results](../conformance/results/m3.md) list the cases, results and known deviations.

OS keyboard delivery, IME and Wayland resize are not certified (internal events do not prove them). Clipboard, textarea, select, forms, timers, persistence, multiple windows and accessibility are outside verified support. Builds are atomic and run `--offline` against the workspace `Cargo.lock`. No performance improvement is claimed beyond the measured startup and size figures in the results.
