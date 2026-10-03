# Runic Desktop Compiler

A research compiler that turns JavaScript/TypeScript framework applications into native Rust desktop applications rendered with [Blitz](https://github.com/DioxusLabs/blitz). Generated applications contain no browser, no WebView and no JavaScript engine. Vite collects the original sources and assets, versioned framework adapters lower components to a validated IR, and the backend generates Rust state transitions and live DOM bindings.

**Purpose:** a WebView-free, fast-starting deployment path for [Runic SDK](/home/viktor/Development/RunicArtifex/runic-sdk) apps. The north star is the SDK's Translations Editor (Svelte 5 + SvelteKit with a C# view model).

**Status (2026-10-03):** M2 is complete. React, Vue and Svelte share a TypeScript frontend that lowers ordinary JavaScript (numbers, strings, objects, arrays, `Map`/`Set`, closures, exceptions and the common built-ins) to a Rust backend; components are still single-component apps with conditionals and text inputs. See [contract v6](docs/CONTRACT.md) and the [M2 results](conformance/results/m2.md). The plan to a general compiler is in [docs/ROADMAP.md](docs/ROADMAP.md); the next milestone (M3) adds components and lists.

## Quick start

On x86_64 Linux with Nix:

```sh
nix develop .            # or: direnv allow (after inspecting .envrc)
npm ci
npm ci --prefix conformance/svelte-5.49.2   # optional extra version environments
npm ci --prefix conformance/vue-3.5.24
npm test
node compiler/cli.mjs build fixtures/settings-wizard --release
./artifacts/settings-wizard/runic-app --x11
```

Omit `--x11` to use the desktop's default display backend. Other fixtures are `counter-*`, `editor-*` and `modules-*` (for `react`, `vue` and `svelte`), plus `quantity`, `thermostat`, `pricing` and `settings-wizard` (React); `examples/` holds 7GUIs Counter, Temperature Converter and a ledger in all three frameworks. `node compiler/cli.mjs analyze <app>` reports diagnostics without building. `fixtures/unsupported-effect` shows a rejection.

## Repository

See [AGENTS.md](AGENTS.md) for the layout and working rules, and [docs/](docs/README.md) for architecture, roadmap and contract. The history of Phases 0–4 is in [docs/history/](docs/history/README.md); its raw evidence and verification scripts are preserved at the git tag `baseline/phase4`.
