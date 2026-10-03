# Runic Desktop Compiler

A research compiler for supported JavaScript and TypeScript applications to native Rust + Blitz. React, Vue and Svelte are implemented frontends, through bounded subsets. Generated applications execute **no JavaScript engine**. Vite collects original source and assets; versioned frontend adapters lower components to validated IR; the backend emits Rust state transitions and live DOM bindings.

The long-term design uses framework/version adapters with shared semantic analysis, IR and Rust generation. Native bindings are Rust; a predominantly Rust compiler is a future option. Start with the [documentation index](docs/README.md), [architecture decisions](docs/ARCHITECTURE.md) and [Phase 4 plan](docs/PHASE4.md) for framework independence, shared modules and version maintenance.

The next authorized work is the [Phases 5–8 autonomous plan](docs/PHASES5-8.md): reproducible current conformance, reusable components, finite child-state lifetimes and a packaged modular application. These phases are planned; the contract below remains the implemented surface.

Phase 4 adds ordinary local JavaScript/TypeScript module imports to Vue and Svelte and named re-exports to React. Three equivalent multi-file fixtures share constant/helper source and an existing pinned mapping. Both Vue and Svelte version pairs reuse the unchanged IR validator, Rust generator and native bindings. See [contract v5](docs/CONTRACT.md) and [Phase 4 results](docs/PHASE4-EVIDENCE.md). In the locked environment:

```sh
node compiler/cli.mjs build fixtures/modules-svelte --release
./artifacts/modules-svelte/runic-app --x11
node scripts/phase4-native.mjs --build
node scripts/phase4-browser.mjs
# After the documented T3 original-runtime comparisons:
node scripts/phase4-verify.mjs --test
```

The aggregate regression checks exact retained Phase 3 artifact identities; direct new fixture builds work from source. See the Phase 4 report for ports, viewports, additional-version dependencies and verification limits. Inherited native OS keyboard/IME and Wayland resize gates remain incomplete.

Phase 3 adds Svelte 5 runes, derived values, captures, ordered writes, native conditional markup and a `bind:value` editor. Svelte 5.57.1 and an isolated 5.49.2 environment reuse schema 3, the existing Rust generator and live controls unchanged. The compiler preserves Svelte's immediate/derived reads without a virtual DOM runtime. See [preserved contract v4](docs/CONTRACT-V4.md), [text validation](docs/TEXT-VALIDATION.md) and [Phase 3 results](docs/PHASE3-EVIDENCE.md). Its automated checks pass; native OS keyboard/IME and Wayland resize gates remain incomplete.

```sh
npm ci
npm ci --prefix conformance/svelte-5.49.2
node compiler/cli.mjs build fixtures/counter-svelte --release
node compiler/cli.mjs build fixtures/editor-svelte --release
./artifacts/editor-svelte/runic-app --x11
# Focused native/version checks and original-runtime browser references:
node scripts/phase3-native.mjs --build
node scripts/phase3-versions.mjs --build
node scripts/phase3-browser.mjs
# After browser suites and raw captures, in another shell:
node scripts/phase3-pixels.mjs
for app in counter-svelte editor-svelte; do
  node scripts/package.mjs "$app" phase3
done
node scripts/fresh-install.mjs phase3
node scripts/phase3-verify.mjs --test
node scripts/phase3-manifest.mjs
```

Run these inside the locked development environment described below. The direct Svelte CLI builds work from source; the aggregate phase regression uses retained Phase 2 artifacts/probe after checking their unchanged identities. The reference server stays running while T3 executes the browser suites. Follow [the Phase 3 evidence instructions](docs/PHASE3-EVIDENCE.md#reproduction) for prerequisites, ports, dimensions, natural paint/focus barriers and pixel captures before running the final verifier. The Svelte editor reference is `http://localhost:5201/?case=0`, at 800×600. A verifier exit code of 2 preserves incomplete desktop gates.

[Phase 2 results](docs/PHASE2-EVIDENCE.md) retain the React/Vue adapter, controlled text, schema migration, additional Vue version and four-package evidence. [Contract v3](docs/CONTRACT-V3.md) preserves that surface; historical receipts remain snapshots of their original inputs.

The following results describe historical Phase 1:

Phase 1 implements arrow components, replacement/updater queues, finite string state, ordered local CSS imports, strict schema 2 validation, atomic builds and a generic declarative mapping registry. Four applications compile from the same source used by the browser reference. A live model proposal was independently validated, pinned without editing its bytes, and reused on frozen held-out source.

| Gate | Retained result |
|---|---|
| Compiler | 22 tests pass; 366 exhaustive transitions pass in each native optimization mode |
| Browser/native | 732 semantic/geometry cases pass; 16 calibrated pixel comparisons pass the unchanged 3/255 threshold |
| Discovery | Two live attempts; second accepted after 51,880 independent cases; unchanged held-out reuse |
| Deployment | All four complete packages launch in an isolated fresh imported Nix store |
| Desktop input | Real X11 and Wayland mouse input, visible focus and X11 resize pass; full OS keyboard and Wayland resize verification remain incomplete |
| Performance | Paired measurements retained; no consistent binding speedup and no new default optimization promoted |

**Phase 1 remains incomplete at its desktop verification gates.** Read [compatibility contract v2](docs/CONTRACT-V2.md), the [Phase 1 evidence report](docs/PHASE1-EVIDENCE.md), and the machine-readable [verification summary](evidence/phase1/verification/run-1/summary.json). [Phase 0 evidence](docs/EVIDENCE.md) and [its frozen archives](baselines/phase0/baseline.json) are preserved as historical results.

## Build and run

From this Git repository on x86_64 Linux:

```sh
nix develop .
npm ci
npm test
node compiler/cli.mjs build fixtures/quantity --release
node compiler/cli.mjs build fixtures/thermostat --release
node compiler/cli.mjs build fixtures/pricing --release
node compiler/cli.mjs build fixtures/settings-wizard --release
./artifacts/pricing/runic-app --x11
```

Omit `--x11` to use the desktop's default display route. CSS and local WOFF2 fonts are embedded; the development shell or packaged launcher supplies native shared libraries. Node is used only for compilation and verification. No fixture-name recognition, hand-translated native application, image-based UI, Chromium, WebView or sibling SDK integration is involved.

Inspect `.envrc` before `direnv allow`, then use `direnv exec . <command>`. Alternatively reuse a development profile:

```sh
nix develop . --profile .cache/dev-profile -c true
nix develop .cache/dev-profile -c npm test
```

Refresh that profile when the flake or lockfile changes. Keep build outputs and dependency caches ignored; use the normal Git-aware flake reference.

## Verify and package

```sh
# Build and check four apps, then serve original React references on ports 5180–5183:
node scripts/verify.mjs --build --serve --run-dir evidence/phase1/verification/local
# After the documented T3 browser/native stages, aggregate the same directory:
node scripts/verify.mjs --run-dir evidence/phase1/verification/local
node scripts/package.mjs quantity
node scripts/package.mjs thermostat
node scripts/package.mjs pricing
node scripts/package.mjs settings-wizard
node scripts/fresh-install.mjs
```

The driver reports passed, failed and incomplete checks with case counts and current artifact hashes. Exit codes are 0 for passed, 1 for failed and 2 for incomplete; missing desktop/browser evidence cannot produce success. See the evidence report for baseline-mode builds, calibrated T3 capture and distinct native input stages. `npm run verify` uses a new default report directory, so it requires browser evidence for that directory.

Packages are under `artifacts/distribution/phase1/<app>/`. Both `app.tar.gz` and `closure.nar.gz` comprise the deployment; follow `IMPORT.txt`. Each complete compressed distribution is approximately 27 MiB; full installed boundary accounting is approximately 79 MiB, excluding the documented host OS/display prerequisites.

## Explicit discovery

Normal analysis/build uses pinned accepted rules and never calls a model. A candidate remains outside the registry until acceptance reruns independent validation.

```sh
# Expected source-located E_MAPPING:
node compiler/cli.mjs analyze fixtures/pricing --no-mappings
# Requires existing Codex authentication; use a fresh output directory:
node compiler/cli.mjs discover fixtures/pricing --no-mappings --codex \
  --model gpt-6-sol --constraints mappings/discovery-constraints.json \
  --out artifacts/discovery-new
node compiler/cli.mjs validate artifacts/discovery-new/candidate.json
# Explicitly pin a validated new rule/version:
node compiler/cli.mjs accept artifacts/discovery-new/candidate.json
```

The retained live experiment used separate feedback and a second invocation after rejecting the first proposal. Future output may differ or fail validation. `--replay` and `--provider /absolute/executable` remain available; replay or an arbitrary wrapper does not establish a live model call. If validator code changes, explicitly reaccept the existing exact candidate bytes to refresh its proof rather than bypassing the stale-proof diagnostic.
