# Phase 6 Reusable components and scalar props

Status: planned, 2026-10-03. Depends on [Phase 5](PHASE5.md); see the [execution plan](PHASES5-8.md).

## Scope and ownership

Extend Vue and Svelte from one component to an acyclic tree of local components. Start with child components that own no state or mount-dependent captures: explicit readonly numeric, boolean and finite-string props, pure render/derived expressions and zero-argument button callbacks/events routed to a supported parent handler. Exercise equivalent React composition through its existing path.

Use ordinary local component imports and each framework's explicit props/event authoring surface. Validate the exact parser/runtime behavior at the existing admitted version pins. The adapter owns prop access, reactivity, event wiring and scheduling; shared analysis owns ordinary module expressions; the existing IR/backend owns scalar reads and transitions. Prefer lowering into existing operations. Component expansion must preserve source locations and produce distinct identities for repeated instances.

Defaults/rest/spread props, slots/snippets/children, arbitrary function values or callback payloads, prop mutation, two-way component bindings, local child state, setup captures of changing props, dynamic/recursive components and effects remain unsupported. The existing single editor stays owned by the root component for this phase.

## Work and acceptance

1. Define and document the accepted prop/callback subset for each adapter; reject uncovered constructs before lowering.
2. Resolve local component graphs from collected source snapshots, separately from ordinary module helpers. Preserve component/module dependency diagnostics and reject cycles.
3. Add equivalent fixtures with two instances of one child, nested composition, changing scalar props, callback routing and shared mapped helpers. Distinguish each instance's node/event identity. Include stateless conditional children only where the existing conditional contract can express them faithfully.
4. Check lexical shadowing, missing/extra props, unsupported captures, invalid callbacks, recursion and original component error locations. Preserve React scheduling and all earlier fixtures.
5. Compare each source against its own original runtime, including both admitted Vue/Svelte versions, then execute finite native transitions and binding-mode parity at the existing two widths. Require exact case completeness and unchanged geometry tolerances.

Deliver the verified subset, preserved preceding contract, updated current contract, fresh campaign and `PHASE6-EVIDENCE.md`. Equal cross-framework results are expected only for deliberately equivalent source behavior; they do not justify imposing one framework's update model on another.
