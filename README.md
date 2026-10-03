# Runic Desktop Compiler

A research compiler that turns JavaScript/TypeScript framework applications into native Rust desktop applications rendered with [Blitz](https://github.com/DioxusLabs/blitz). Generated applications contain no browser, no WebView and no JavaScript engine. Vite collects the original sources and assets, versioned framework adapters lower components to a validated IR, and the backend generates Rust state transitions and live DOM bindings.

**Status (2026-10-03):** React, Vue and Svelte are supported through a deliberately small subset: scalar state, pure expressions, a single text editor, conditionals and shared local modules. See [contract v5](docs/CONTRACT.md). The plan from here to a general compiler is in [docs/ROADMAP.md](docs/ROADMAP.md). The next milestone (M1) moves the IR, code generation and runtime into Rust crates and adds an automated conformance harness.

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

Omit `--x11` to use the desktop's default display backend. Other fixtures are `counter-*`, `editor-*` and `modules-*` (for `react`, `vue` and `svelte`), plus `quantity`, `thermostat`, `pricing` and `settings-wizard` (React). `node compiler/cli.mjs analyze <app>` reports diagnostics without building. `fixtures/incompatible` and `fixtures/unsupported-effect` show rejections.

## Mappings and discovery

Normal builds use the pinned, independently validated rules in [`mappings/`](mappings/APPLICABILITY.md) and never call a model. Discovery is a separate explicit operation (`node compiler/cli.mjs discover … --codex`, then `validate` and `accept`). A candidate enters the registry only through `accept`, which reruns the independent validation.

## Repository

See [AGENTS.md](AGENTS.md) for the layout and working rules, and [docs/](docs/README.md) for architecture, roadmap and contract. The history of Phases 0–4 is in [docs/history/](docs/history/README.md); its raw evidence and verification scripts are preserved at the git tag `baseline/phase4`.
