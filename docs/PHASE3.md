# Phase 3 Svelte compiler frontend

Planned and authorized for implementation on 2026-10-02. Add a bounded Svelte 5 frontend to the existing semantic IR and Rust backend. Svelte's compiler-generated DOM updates provide another test of framework independence. This document records scope and milestones; delivered behavior and verification belong in [the Phase 3 results](PHASE3-EVIDENCE.md) and the [current contract](CONTRACT.md). [Contract v3](CONTRACT-V3.md) preserves the Phase 2 surface.

## Approach

Use original `.svelte` source and the official modern parser AST for native lowering. Use Svelte's official Vite plugin and runtime for the browser reference. Svelte's emitted JavaScript is a build/reference artifact; the native application remains generated Rust with shared Blitz bindings. Svelte provides both [parsing and compilation APIs](https://svelte.dev/docs/svelte/svelte-compiler).

The current IR UI tree describes initial structure and bindings; the native backend already applies changes to live DOM nodes. Adding Svelte does not require a virtual DOM layer. For pure scalar computations, derived reads can lower to explicit expressions over the latest supported writes. That is a proposed lowering strategy to validate against Svelte, not a claim that all reactive behavior fits the current IR.

## Milestones

1. Pin Svelte 5 and official Vite tooling, then make original script/import extraction an adapter responsibility. Preserve original source offsets and existing React/Vue graphs.
2. Implement scalar `$state`, pure `$derived`/bounded `$derived.by`, setup captures, ordered handler writes, modern `onclick` attributes, interpolation and native conditional markup. Reject uncovered effects and mutation explicitly.
3. Compile a finite counter that observes state and derived values between writes. Compare setup captures, local captures and boolean interpolation with the original Svelte runtime. Read current [derived semantics](https://svelte.dev/docs/svelte/$derived) rather than inheriting another adapter's scheduling.
4. Compile a controlled text editor using simple identifier `bind:value`, retaining the Phase 2 Unicode/UTF-16 domain and shared Rust controls. Reject a simultaneous user input listener: the current text handler only admits a direct payload copy. Inspect [binding order](https://svelte.dev/docs/svelte/bind) and verify the actual modern event route before accepting combined handlers. The implementation probe found that delegated `oninput` sees the updated bound value on the pinned runtime; the docs' description of an existing element listener must not be generalized to that route.
5. Run compiler negatives, finite closure/native transitions, browser semantics/geometry, editing traces, raw pixels, baseline/optimized parity and isolated packaged execution. Carry forward native OS keyboard/IME and Wayland resize gates without equating internal events with desktop input.
6. Exercise one additional pinned Svelte 5 version with the same source, compiler/backend and scenarios. Record actual package identities and any normalized source/behavior differences. Preserve Phase 0–2 receipts and manifests.

## Initial scope

One root component in runes mode, JavaScript or supported TypeScript syntax, scalar state and pure total expressions within existing numeric/text domains. One unconditional text editor, finite controls, static/native attributes and `{#if}` content. Styles initially come from imported local CSS with an embedded WOFF2 font.

Deep object/array proxies, writable derived overrides, effects/lifecycle, stores/context, child component props, snippets, lists, transitions, SvelteKit/SSR/hydration, function bindings and scoped component styles are separate capabilities. Reject them with source diagnostics. Svelte's [scoped CSS](https://svelte.dev/docs/svelte/scoped-styles) changes selectors and generated classes; accepting it requires its own validated collection/DOM association rather than removing the scoping.

## Completion and evidence

Svelte source must reach the same validator, Rust generator and live controls as React/Vue. The backend must not branch on framework identity. Preserve existing behavior and supported diagnostics, including exact finite validation and the text length projection. A new IR operation or version is warranted only by a supported observable behavior that cannot already be expressed.

Pin exact versions in lockfiles before conformance. Record source, adapter, package, IR, native-input and binary identities. New results belong under `evidence/phase3/`; do not regenerate earlier manifests to make them describe the new source. Performance improvements are not an acceptance promise.

The implementation pins Svelte 5.57.1 and an additional 5.49.2 environment, with the official Vite plugin 7.3.1. Adapter changes are contained at source collection/lowering; schema 3, the validator, Rust generator and native bindings remain unchanged. Results distinguish fresh comparisons from retained references whose source, IR, native inputs and captures are unchanged.
