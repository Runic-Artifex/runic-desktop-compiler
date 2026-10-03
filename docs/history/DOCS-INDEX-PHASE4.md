# Project documentation

The project compiles supported JavaScript and TypeScript application behavior into native Rust applications rendered with Blitz. React, Vue and Svelte adapters share language analysis, validation and native generation. The long-term architecture supports additional framework adapters and incremental framework upgrades.

## Direction and next work

| Document | Purpose |
|---|---|
| [Architecture and decisions](ARCHITECTURE.md) | Agreed language choices, compiler boundaries, framework independence, version maintenance and future Rust migration |
| [Phases 5–8 autonomous plan](PHASES5-8.md) | Ordered next work: source-based conformance, component composition, state lifetimes and packaged applications; all currently planned |
| [Phase 4 plan](PHASE4.md) | Shared local JavaScript/TypeScript modules with Vue/Svelte consumers and React re-export parity |
| [Phase 3 plan](PHASE3.md) | Authorized Svelte scope and milestones; delivered results are recorded separately |
| [Blitz and Blazor archive review](BLITZ-BLAZOR-REVIEW.md) | Findings from the cancelled initiative and how to reuse its native knowledge |

Start with the architecture document when making design changes. Phase plans describe intended work; the contract and evidence reports define implemented capabilities and verification limits.

## Current implementation and historical evidence

| Document | Scope |
|---|---|
| [Compatibility contract v5](CONTRACT.md) | Current local module, React/Vue/Svelte source, typed input, IR and native capabilities |
| [Phase 4 evidence](PHASE4-EVIDENCE.md) | Shared modules, existing mapping reuse, two Vue/Svelte versions, regression and bounded verification |
| [Compatibility contract v4](CONTRACT-V4.md) | Preserved Phase 3 React/Vue/Svelte source and behavior contract |
| [Phase 3 evidence](PHASE3-EVIDENCE.md) | Svelte runes, binding semantics, two actual versions, regression/deployment and open desktop gates |
| [Compatibility contract v3](CONTRACT-V3.md) | Preserved Phase 2 React/Vue source and behavior contract |
| [Phase 2 evidence](PHASE2-EVIDENCE.md) | Shared backend, editing, version reuse, deployment and open desktop gates |
| [Phase 2 plan](PHASE2.md) | The preserved plan used for Phase 2 |
| [Typed text validation](TEXT-VALIDATION.md) | Domain, sound length projection, permitted operations and proof limits |
| [Compatibility contract v2](CONTRACT-V2.md) | Preserved Phase 1 input and behavior contract |
| [Phase 1 evidence](PHASE1-EVIDENCE.md) | Implemented results, measurements, packages and incomplete desktop gates |
| [Phase 1 plan](PHASE1.md) | The preserved plan used for Phase 1 |
| [Phase 0 evidence](EVIDENCE.md) | Historical prototype results |
| [Original prototype brief](../PROMPT.md) | Original Phase 0 requirements, with a pointer to the current direction |

The repository [README](../README.md) contains build and run instructions. Phase 1 remains incomplete for full OS keyboard and Wayland resize verification; the architecture discussion does not change those results.

## Maintaining these documents

Keep enduring decisions in `ARCHITECTURE.md`, phase-specific work in its phase plan, and actual results in evidence reports. Mark proposed choices and implemented capabilities explicitly. When a decision changes, update the architecture and affected plan together, recording the reason and date. Preserve historical receipts, manifests and baseline archives as snapshots of their original source and verification runs; do not regenerate them merely because planning documentation changed.
