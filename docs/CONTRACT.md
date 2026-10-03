# Compatibility contract v5

Implemented surface as of the `baseline/phase4` tag and the M0 restructure. This is a living document: milestones update it in place, and git history and the `m<N>` tags record earlier versions. The earlier copied contracts are kept in `history/`.

Phase 4 adds shared local JavaScript/TypeScript modules to the Vue and Svelte adapters and explicit named re-exports to React. All three share expression analysis, validated IR and Rust generation. This is a bounded source contract; [Phase 4 evidence](history/PHASE4-EVIDENCE.md) records results and verification limits. Native applications execute no JavaScript engine or model provider. The unchanged [Phase 3 contract](history/CONTRACT-V4.md), [Phase 2 contract](history/CONTRACT-V3.md) and [Phase 1 contract](history/CONTRACT-V2.md) preserve previous subsets and findings.

## Collection and adapter selection

`runic.json` selects a local entry, title and optional `framework`: `react` (default), `vue` or `svelte`. All use an empty `div#root` and one module script. Vite collects original sources, ordered local CSS and WOFF2 assets. Component extensions and original script/import extraction belong to adapters, with original offsets preserved. Collection does not create a React-configured TypeScript program.

Checked identities are React/React DOM 19.3.0, Vue/compiler-sfc 3.5.43 or 3.5.24, and Svelte/compiler 5.57.1 or 5.49.2. Runtime/compiler versions must match. Other versions fail with `E_FRONTEND_VERSION`. Vite 8.3.2, TypeScript 5.9.3, plugin-vue 6.0.9 and the official Svelte Vite plugin 7.3.1 are pinned tools. Additional Vue and Svelte environments have isolated package locks and dependency directories; their browser references execute their own resolved runtimes.

Existing graph, resource, CSS-order, bootstrap and local-asset restrictions remain. CSS `width` joins the previous property set for explicit input geometry; accepting a property does not imply complete browser value/rasterization parity. Browser and Blitz input defaults differ, so verified editors specify width and block layout. Native builds require an embedded local WOFF2 font.

## Ordinary local modules

Vue and Svelte component scripts can import runtime named bindings from collected local `.js` and `.ts` files. Imports and exports can use aliases, explicit `export {name}` lists and named re-exports through a barrel. Acyclic dependencies initialize before component setup, including when a component import declaration appears later in its script. Each dependency initializes once. Analysis uses the original collected source snapshot rather than rereading application bodies from disk.

The shared module analyzer accepts scalar const declarations with supported pure initializers, function declarations and const arrow/function expressions. Constants evaluate once in source order; forward const reads are rejected. Plain helper bodies must match the bounded pure numeric grammar without captured values, and calls require a matching pinned mapping and valid applicability conditions. Math calls resolve to the actual standard-library symbol; a local binding cannot impersonate it. The current mapping interface accepts numeric arguments, even when its result is boolean. Unsupported helper declarations are rejected even if unused.

Cycles, mutable module state, top-level effects/await, dynamic imports, CommonJS, external dependencies, default/namespace/star exports, side-effect module imports, destructuring and typed declarations/signatures are outside this subset. Svelte `.svelte.js`/`.svelte.ts` rune modules are not ordinary shared modules. Component composition, framework effects and lifecycle retain each adapter's restrictions. Component imports of CSS remain subject to their existing rules; ordinary modules cannot import CSS.

React retains its existing symbol-based module analysis and component grammar, with explicit named runtime export lists and local named re-exports now accepted. The three equivalent Phase 4 fixtures consume identical ordinary module source and the same accepted mapping; this does not make their broader component subsets identical.

## React source

The [v2 React grammar](history/CONTRACT-V2.md) remains: supported function/arrow components and composition, const render declarations, scalar `useState`, pure expressions, replacement/updater queues and stateless conditional subtrees. Reads retain the committed render snapshot; updaters read the target's pending value. Numeric bounds, finite enum limits and unsupported effects/signatures remain.

One unconditional controlled `<input>` can bind a direct string state, `type="text"`, `maxLength={256}`, optional boolean `disabled`/`readOnly` and `onChange={event => setText(event.target.value)}` or its supported resolved-function equivalent. The handler has exactly one direct assignment to the bound slot. Other event parameter uses, refs, imperative DOM/editor access, transforms and conditional editor mounts are rejected. Supported `.length` lowers to UTF-16 length.

## Vue source

The entry imports `createApp` from Vue, one local default SFC and optional local CSS, then calls `createApp(App).mount('#root')`. The SFC contains one plain template and `<script setup>` in JavaScript or TypeScript syntax. This adapter supports one SFC, with ordinary local module imports as described above. Component composition, normal `<script>`, inline/scoped styles, custom blocks and generic setup parameters are outside its contract.

Setup accepts named `ref`/`computed` imports, ordinary local module bindings, const scalar literal refs (including module constants), pure zero-parameter computed getters, const captures and plain synchronous handler functions. Handlers contain const captures and ordered `ref.value = expression` assignments. Reads observe earlier writes immediately. Setup constants capture once; handler constants capture at their statement. The adapter lowers these semantics into explicit expressions over entry state. Async work, watchers, lifecycle hooks, objects/arrays, general mutation and typed function signatures are rejected.

Templates accept the declared native tags, static attributes, supported `:class`, `:title`, `:aria-label`, `:disabled`, `:readonly`, `:value`, interpolation, `v-if` and named `@click`/`@input` functions. Directive modifiers, `v-model`, loops, dynamic components and other event expressions are rejected. Ref unwrapping belongs to the adapter. Boolean interpolation becomes `boolean-text`; numeric/string interpolation shares common text operations.

An editor uses `type="text" maxlength="256" :value="text" @input="input"`, where `input(event)` directly assigns `event.target.value` to that string ref. This explicit input binding does not claim Vue `v-model` composition behavior.

## Svelte source

The entry imports `mount` from Svelte, one local default `.svelte` component and optional local CSS, then calls `mount(App, {target: document.getElementById('root')})`. `document.querySelector('#root')` is also accepted; imports may not shadow the global document. Legacy `new App(...)`, additional mount options, props, additional bootstrap module imports and child component composition are rejected. The component instance script can import ordinary local modules as described above.

The component has one native root element and one instance script, optionally `lang="js"` or `lang="ts"`. The official modern Svelte parser supplies original source structure; the official Vite compiler/runtime executes the browser reference in runes mode. Native lowering does not recognize private generated JavaScript helpers or execute Svelte's runtime.

Setup supports `let name = $state(scalarLiteral)` (including module constants), pure `$derived(expression)`, and `$derived.by` with a plain zero-parameter expression getter or a block containing one return. Ordinary setup values are const captures; setup expressions must reference already-declared state/derived bindings or admitted module bindings. Functions and const function values can provide plain synchronous handlers. Typed declarations/signatures, object/array proxies, effects, stores/context, lifecycle, unmapped calls, writable derived overrides, module scripts, script generics and component options are rejected.

Handlers contain new const captures and ordered scalar state assignments. Numeric `+=`, `-=`, `*=`, and standalone `++`/`--` are admitted when finite validation establishes bounds. Reads see earlier writes immediately; a derived read recomputes the admitted pure expression over those latest writes. Setup captures retain their initial value, and handler captures retain the value at their statement. This lowering preserves supported observations without a general reactive runtime or virtual DOM layer. Native rendering commits the final handler result; imperative DOM reads and effects that could observe intermediate rendering are outside this contract. See Svelte's [state](https://svelte.dev/docs/svelte/$state) and [derived](https://svelte.dev/docs/svelte/$derived) semantics.

Markup supports the shared native tags, static attributes and pure attribute expressions, scalar interpolation, modern `onclick` with named/inline handlers, and `{#if}`/`{:else}` stateless content. Boolean text becomes the shared `boolean-text` operation. Fragment-edge whitespace is trimmed and whitespace adjacent to native elements is collapsed; preservation options are rejected. Legacy `on:` directives, actions, class directives, spreads, snippets, lists, transitions, child components, SSR/hydration and SvelteKit are outside the contract. Component/scoped styles are rejected; import local CSS rather than discarding its [scoping semantics](https://svelte.dev/docs/svelte/scoped-styles).

One unconditional editor uses `type="text" maxlength="256" bind:value={text}` for a direct scalar string state, with optional boolean `disabled`/`readonly`. An explicit `value={text}` plus a single `oninput` handler directly copying `event.target.value` or `event.currentTarget.value` is also admitted by the same typed payload rules. Function bindings, derived targets, conditional mounts, additional input effects and `bind:value` combined with `value` or a user input listener are rejected. The checked modern delegated listener probe observes the updated bound value; combined listener order is not inferred from another event route. See [the probe and its limits](history/PHASE3-EVIDENCE.md#semantic-findings).

## Shared semantics and native controls

Finite apps retain exact reachable-state validation and numeric/enum/resource limits. Open text follows [typed text validation](TEXT-VALIDATION.md): one scalar single-line string of at most 256 UTF-16 units, copy/reset/rendering, empty checks and length observations, with exact projected control closure. Unsupported operations and invalid payloads fail explicitly. Finite enums and open text are distinct domains.

Schema 3 records generic adapter/version/package/tool provenance, typed click/text-input handlers and live control operations. The backend does not select semantics by framework identity. Schema 2 finite artifacts remain valid; `migrateIR` produces a schema 3 copy with fresh validation/hash metadata. Historical evidence is not rewritten.

The shared Rust binding updates the existing Blitz editor through its live API. Equal-value echoes preserve selection/composition; unrelated updates preserve editor identity. Read-only edits are guarded because the pinned Blitz accepts them without that guard. Character-key overflow is stopped before mutation. Space remains editable input text, Enter has no form action and input delivery does not force focus changes. Tab includes enabled editors/buttons, including read-only editors.

The internal probe covers typing, deletion, Unicode replacement, UTF-16 offsets, equal-value echoes, live clear, identity/focus, composition commit, locked controls, length-limit caret preservation and blur. Browser/native traces check React, Vue and both Svelte pins; Phase 2 retains the additional Vue runtime evidence. Comparisons observe committed output after natural browser paint/focus settling, never force blur to manufacture parity. OS keyboard delivery and platform IME certification remain incomplete. Clipboard/paste, textarea, select/options, forms, arbitrary editor APIs, lists, persistence, multi-window behavior and accessibility remain outside verified support.

## Mappings, builds and evidence

The bounded numeric mapping format, deterministic registry, explicit discovery and independent acceptance rules remain. Applicability follows resolved pure semantics and preconditions, rather than a framework name. Phase 2 revalidates existing candidate bytes against the changed validator and records new proofs; Phase 1 receipts remain unchanged. See [mapping applicability](../mappings/APPLICABILITY.md).

Atomic builds and both binding modes remain. Phase 4 leaves schema 3, the IR validator, Rust generator, mapping validator and native bindings unchanged. New module fixtures have compiler, finite native, original-runtime semantic/geometry and native framebuffer parity reports. Earlier text, raw browser pixels and isolated deployment evidence remains historical; Phase 4 does not rerun or extend those certifications. Traces are not an exhaustive proof of strings; internal events cannot close an OS gate. No performance improvement is claimed. See [Phase 4 evidence](history/PHASE4-EVIDENCE.md) and [Phase 3 evidence](history/PHASE3-EVIDENCE.md) for their distinct results and remaining gates.
