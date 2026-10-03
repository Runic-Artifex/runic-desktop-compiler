# Working on Runic Desktop Compiler

## Project direction

Read [the architecture decisions](docs/ARCHITECTURE.md) when changing compiler boundaries or adding capabilities. [Phase 4](docs/PHASE4.md) records shared local module scope; [its results](docs/PHASE4-EVIDENCE.md) distinguish delivered capabilities from inherited desktop gates. [The documentation index](docs/README.md) distinguishes plans, implemented contracts and historical evidence.

[Phases 5–8](docs/PHASES5-8.md) are the next authorized autonomous work queue. Follow their dependencies and acceptance checks; planned capabilities do not extend the current contract until implemented and verified.

- Generate Rust application code and use Rust for the native binding layer with Blitz.
- React is the first frontend. Keep shared language analysis, IR, optimization and native generation reusable by Angular, Svelte, Vue, Solid and other frontend adapters.
- Put framework/version assumptions in frontend adapters and applicable mapping packs. Preserve observable scheduling, input and lifecycle behavior through explicit semantics.
- Use versioned conformance tests and incremental adapter changes for framework upgrades; do not turn the shared runtime into an implementation of React.
- A future compiler implemented predominantly in Rust is an option. Do not initiate a broad rewrite as a side effect of a feature task.
- Normal builds remain deterministic and use pinned validated mappings. Model-assisted discovery is an explicit separate operation.

## Implementation and verification

The current accepted input is defined by [contract v5](docs/CONTRACT.md), not by proposed roadmap capabilities. React, Vue and Svelte share schema 3 and the Rust backend. Ordinary local modules belong to shared language analysis; framework reactivity remains in adapters. Preserve useful diagnostics and reject uncovered behavior. [Phase 3 evidence](docs/PHASE3-EVIDENCE.md) carries incomplete native OS keyboard/IME and Wayland resize checks; do not promote internal events or transport timeouts into desktop verification claims. In background browser conformance, observe natural focus teardown after a real frame capture rather than forcing blur or dropping mismatches.

Reuse the project's locked environment: inspect `flake.nix`, `.envrc` and README development instructions before choosing commands. Match verification to changed behavior and preserve historical source/evidence snapshots. Documentation-only changes do not require rebuilding native applications.

The archived Blitz and Blazor initiative is reference material. Use [the review](docs/BLITZ-BLAZOR-REVIEW.md) to find focused native cases/fixes; keep this repository independent of its SDK, bridge and caches, and leave the archive unchanged.
