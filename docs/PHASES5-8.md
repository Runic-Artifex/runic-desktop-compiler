# Phases 5–8 Autonomous work plan

Planned on 2026-10-03 for the next overnight work period. The starting point is the implemented [Phase 4 result](PHASE4-EVIDENCE.md), [contract v5](CONTRACT.md) and schema 3. These four phases are proposed work, not additional accepted compatibility. The user has authorized autonomous work within this plan; routine implementation decisions and local verification do not need another confirmation.

The sequence addresses a concrete verification limitation before expanding composition, then exercises the result in a distributable application. It retains JavaScript/TypeScript authoring, Rust generation and native bindings, framework-owned semantics, deterministic pinned mappings and the [agreed architecture](ARCHITECTURE.md).

## Sequence

| Phase | Outcome | Dependency | Initial status |
|---|---|---|---|
| [5: Reproducible conformance](PHASE5.md) | A current verification campaign that builds from source without requiring retained historical executables | Phase 4 source and locks | Planned |
| [6: Reusable components](PHASE6.md) | Vue/Svelte child components with readonly scalar props and bounded button callbacks/events; React regression parity | Phase 5 reporting and baseline | Planned |
| [7: Component state lifetimes](PHASE7.md) | Independent finite child state, stable instance identity and explicit conditional mount/reset behavior | Phase 6 composition | Planned |
| [8: Application and delivery](PHASE8.md) | Equivalent modular settings applications, fresh conformance and complete Linux/Nix packages | Verified capabilities from Phases 6–7 | Planned |

This is an ordered work queue, not a promise that all four phases finish before morning. Finish and verify each capability before depending on it. If time runs out, retain the last verified result and a precise account of work in progress.

## Working independently

Start with Phase 5. Read the applicable phase plan and current contract, inspect existing code, and choose the smallest implementation that satisfies its acceptance checks. Check official framework documentation and execute the actual locked runtime before relying on a new source construct or ordering assumption. Apply the required Svelte skills when working on Svelte components/modules. Keep ordinary module analysis shared and framework behavior in adapters; the Rust backend must not branch on framework names.

Use the locked Nix environment, existing dependency/Cargo caches and sequential native builds. Run focused checks while iterating and the applicable full campaign when the phase is ready. Before a large native/browser/package matrix, check available space and choose conservative concurrency. Browser comparisons use the T3 collaborative preview; desktop input remains a separate stage. Stop task-owned servers/windows and remove disposable task outputs after their consumers finish.

Each phase delivers its source/tests, a `PHASE<N>-EVIDENCE.md` report and a new run under `evidence/phase<N>/`. Record source, adapter/runtime, mapping, IR, native input and executable identities, exact expected/observed case counts and each gate's status. Separate freshly executed references from replayed observations. Do not overwrite old contracts, receipts, manifests or baseline archives. Publish a new accepted contract only when a source capability has passed its required checks; archive the preceding contract unchanged. Verification tooling alone does not require a contract version bump.

Compiler/native correctness, original-runtime semantics, geometry/visual checks, installation and OS input are distinct results. The inherited OS keyboard, platform IME and Wayland resize gates remain incomplete until directly demonstrated. Missing tooling or a transport timeout cannot count as a pass. Keep existing tolerances and natural browser focus teardown; do not manufacture parity by forcing blur, omitting cases or rewriting reference output.

## Decisions and interruptions

Resolve routine details independently and record meaningful decisions in the phase evidence. A newly required IR operation needs a framework-independent definition, malformed-input checks and a Rust implementation. Version the schema when its serialized contract changes and preserve schema 2/3 compatibility through explicit validation/migration; do not disguise a new operation as an old one.

If a runtime probe disproves a proposed subset, implement a narrower useful subset only with explicit diagnostics and document the deviation. Do not mark the original phase complete or let later phases claim the omitted capability. A semantic ambiguity that cannot be resolved from official sources and runtime evidence blocks that feature; independent verification/documentation work can continue. An unavailable browser/desktop stage remains incomplete. Storage failures stop expensive work until the measured cause is resolved.

This authorization covers repository implementation, local builds, tests and local distribution artifacts. Publishing releases, external deployment, broad dependency upgrades, model-assisted mapping discovery, archive modification and a compiler rewrite are outside this plan. New frameworks, lists, general effects/async behavior and multiple editors are deferred so composition has a clear, verifiable boundary.

## Morning handoff

Update the table with actual progress and link each completed phase's evidence. Give a short summary of delivered behavior, meaningful verification, open limitations and the next concrete task. Include runnable commands for the current example/packages and identify unfinished work without treating it as accepted support.
