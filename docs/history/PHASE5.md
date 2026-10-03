# Phase 5 Reproducible current conformance

Status: planned, 2026-10-03. See the [execution plan](PHASES5-8.md). This phase changes verification infrastructure, not the accepted source language.

## Problem and scope

Phase 4 can build its new fixtures from source, but its aggregate regression requires exact retained Phase 3 executables. Create a reusable current campaign that builds the supported regression corpus from source and writes fresh evidence without those executable prerequisites. Historical receipts remain separate immutable snapshots; a newly built binary must never be substituted into an old receipt.

Reuse the current React/Vue/Svelte fixture families, existing additional Vue/Svelte pins, shared Cargo outputs and both binding modes. Centralize campaign selection, expected cases, input identities and results instead of adding another driver that depends on the previous phase's binary inventory. Support explicit run/output directories, resumption of unchanged inputs and separate compiler, native, browser and desktop stages. Missing, duplicated, stale or mismatched cases must fail or remain incomplete, including resumed runs.

## Work and acceptance

1. Define a versioned campaign/report format and fixture/version manifest. Record actual runtime resolutions and distinguish current execution from historical audits and reference replay.
2. Build into new task-owned output directories. Reuse a result only after checking its relevant source, IR, native inputs, profile and executable identity. Preserve existing fixtures/artifacts and the atomic build lock.
3. Exercise the current compiler suite, finite transitions, text traces and binding-mode parity. Run original-runtime semantic/geometry references with strict completeness and paint/focus barriers. Keep expensive visual/installation/desktop stages selectable and visibly separate.
4. Demonstrate the source-only path in an empty campaign output directory while retaining the shared toolchain/dependency caches. Audit that historical evidence bytes remain unchanged.
5. Verify meaningful failures: an absent binary is rebuilt, stale input invalidates reuse, a corrupted receipt is rejected, missing/duplicate observations cannot pass, and an interrupted stage can resume safely.

Deliver documented commands, a complete fresh core campaign and `PHASE5-EVIDENCE.md`. Aggregate status retains inherited desktop gaps. Existing historical verifiers remain usable; no dependency upgrade, schema change or performance claim is needed.
