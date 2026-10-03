# Compatibility contract v3

Phase 2 implements React and Vue adapters sharing expression analysis, validated IR and Rust generation. This is a bounded source contract, with desktop limitations recorded in [Phase 2 evidence](PHASE2-EVIDENCE.md). Native applications execute no JavaScript engine or model provider. The unchanged [Phase 1 contract](CONTRACT-V2.md) preserves the previous subset and historical findings.

## Collection and adapter selection

`runic.json` selects a local entry, title and optional `framework`: `react` (default) or `vue`. Both use an empty `div#root` and one module script. Vite collects original sources, ordered local CSS and WOFF2 assets. Collection no longer creates a React-configured TypeScript program; framework tooling belongs to adapters.

Checked identities are React/React DOM 19.3.0 and Vue/compiler-sfc 3.5.43 or 3.5.24. Vue runtime/compiler versions must match. Other versions fail with `E_FRONTEND_VERSION`. Vite 8.3.2, TypeScript 5.9.3 and plugin-vue 6.0.9 remain pinned tools. The additional Vue environment has an isolated package lock and dependency directory.

Existing graph, resource, CSS-order, bootstrap and local-asset restrictions remain. CSS `width` joins the previous property set for explicit input geometry; accepting a property does not imply complete browser value/rasterization parity. Browser and Blitz input defaults differ, so verified editors specify width and block layout. Native builds require an embedded local WOFF2 font.

## React source

The [v2 React grammar](CONTRACT-V2.md) remains: supported function/arrow components and composition, const render declarations, scalar `useState`, pure expressions, replacement/updater queues and stateless conditional subtrees. Reads retain the committed render snapshot; updaters read the target's pending value. Numeric bounds, finite enum limits and unsupported effects/signatures remain.

One unconditional controlled `<input>` can bind a direct string state, `type="text"`, `maxLength={256}`, optional boolean `disabled`/`readOnly` and `onChange={event => setText(event.target.value)}` or its supported resolved-function equivalent. The handler has exactly one direct assignment to the bound slot. Other event parameter uses, refs, imperative DOM/editor access, transforms and conditional editor mounts are rejected. Supported `.length` lowers to UTF-16 length.

## Vue source

The entry imports `createApp` from Vue, one local default SFC and optional local CSS, then calls `createApp(App).mount('#root')`. The SFC contains one plain template and `<script setup>` in JavaScript or TypeScript syntax. This adapter supports one SFC. Component/module composition, normal `<script>`, inline/scoped styles, custom blocks and generic setup parameters are outside its contract.

Setup accepts named `ref`/`computed` imports, const scalar literal refs, pure zero-parameter computed getters, const captures and plain synchronous handler functions. Handlers contain const captures and ordered `ref.value = expression` assignments. Reads observe earlier writes immediately. Setup constants capture once; handler constants capture at their statement. The adapter lowers these semantics into explicit expressions over entry state. Async work, watchers, lifecycle hooks, objects/arrays, general mutation and typed function signatures are rejected.

Templates accept the declared native tags, static attributes, supported `:class`, `:title`, `:aria-label`, `:disabled`, `:readonly`, `:value`, interpolation, `v-if` and named `@click`/`@input` functions. Directive modifiers, `v-model`, loops, dynamic components and other event expressions are rejected. Ref unwrapping belongs to the adapter. Boolean interpolation becomes `boolean-text`; numeric/string interpolation shares common text operations.

An editor uses `type="text" maxlength="256" :value="text" @input="input"`, where `input(event)` directly assigns `event.target.value` to that string ref. This explicit input binding does not claim Vue `v-model` composition behavior.

## Shared semantics and native controls

Finite apps retain exact reachable-state validation and numeric/enum/resource limits. Open text follows [typed text validation](TEXT-VALIDATION.md): one scalar single-line string of at most 256 UTF-16 units, copy/reset/rendering, empty checks and length observations, with exact projected control closure. Unsupported operations and invalid payloads fail explicitly. Finite enums and open text are distinct domains.

Schema 3 records generic adapter/version/package/tool provenance, typed click/text-input handlers and live control operations. The backend does not select semantics by framework identity. Schema 2 finite artifacts remain valid; `migrateIR` produces a schema 3 copy with fresh validation/hash metadata. Historical evidence is not rewritten.

The shared Rust binding updates the existing Blitz editor through its live API. Equal-value echoes preserve selection/composition; unrelated updates preserve editor identity. Read-only edits are guarded because the pinned Blitz accepts them without that guard. Character-key overflow is stopped before mutation. Space remains editable input text, Enter has no form action and input delivery does not force focus changes. Tab includes enabled editors/buttons, including read-only editors.

The internal probe covers typing, deletion, Unicode replacement, UTF-16 offsets, equal-value echoes, live clear, identity/focus, composition commit, locked controls, length-limit caret preservation and blur. Browser/native traces check both original frameworks and the additional Vue version. OS keyboard delivery and platform IME certification remain incomplete. Clipboard/paste, textarea, select/options, forms, arbitrary editor APIs, lists, persistence, multi-window behavior and accessibility remain outside verified support.

## Mappings, builds and evidence

The bounded numeric mapping format, deterministic registry, explicit discovery and independent acceptance rules remain. Applicability follows resolved pure semantics and preconditions, rather than a framework name. Phase 2 revalidates existing candidate bytes against the changed validator and records new proofs; Phase 1 receipts remain unchanged. See [mapping applicability](../mappings/APPLICABILITY.md).

Atomic builds and both binding modes remain. Compiler tests, finite native transitions, typed witnesses, original-runtime comparisons, pixel checks and isolated deployment have separate reports. Traces are not an exhaustive proof of strings; internal events cannot close an OS gate. No performance improvement is claimed. See [Phase 2 evidence](PHASE2-EVIDENCE.md) for results and remaining gates.
