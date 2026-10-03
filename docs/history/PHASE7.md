# Phase 7 Finite child state and instance lifetimes

Status: planned, 2026-10-03. Depends on [Phase 6](PHASE6.md); see the [execution plan](PHASES5-8.md).

## Scope and semantics

Allow a bounded number of statically declared child instances to own the existing finite scalar state: literal/module-constant initializers, numeric/boolean/finite-string values and already supported synchronous handlers. First establish independent unconditional instances; then admit one explicit boolean conditional mount site with an empty alternative. Keep existing state/resource limits and exact finite exploration.

Define identity by the accepted static component position, not its display label or component filename. Parent prop changes and sibling events preserve a live child's state. A committed removal makes its handlers inactive and disposes its owned state; a subsequent mount restores the declared initial state. Two instances of the same component must never alias. Probe hide/show within one handler and nested parent/child writes against each actual runtime to determine commit behavior instead of equating every intermediate scalar write with a mount change.

Adapters preserve React snapshots/updater queues and Vue/Svelte immediate reactive reads. Shared IR describes instance ownership, active conditions and initialization/disposal at explicit commit boundaries; Rust implements those operations without a framework scheduler. Add/version IR only when existing operations cannot express the observations. Inactive state must have a canonical validated representation so unreachable hidden values do not create artificial state-space growth.

## Work and acceptance

1. Record the independent semantic model and source restrictions before adding operations. Maintain old schema acceptance/migration and reject invalid ownership, cycles, guards or reset references.
2. Implement unconditional child state across the three adapters, with distinct state/handler/node identities and useful original locations.
3. Implement the narrow conditional lifetime contract. Reject ambiguous branch replacement, dynamic keys/lists and unsupported mount expressions rather than guessing identity.
4. Verify two-instance independence, updates while retained, hide/remount reset, disabled/hidden event handling, same-handler toggles and state writes around parent callbacks. Compare original-runtime traces and exhaustively explore the admitted finite closure.
5. Run shared native transition and framebuffer parity checks, version conformance and earlier regressions. Retain counterexamples if a framework needs a different lowering.

Deliver the verified contract/schema changes, a fresh campaign and `PHASE7-EVIDENCE.md`. This phase does not add user lifecycle hooks, effects, async work, stores/context, captured dynamic initializers, conditional editors or a general runtime implementation of any framework.
