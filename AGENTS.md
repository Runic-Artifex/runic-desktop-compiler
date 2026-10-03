# Working on Runic Desktop Compiler

The compiler turns JavaScript/TypeScript framework applications (React, Vue and Svelte today) into native Rust applications rendered with Blitz, with no browser, WebView or (by default) JavaScript engine.

Start here:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): binding decisions D1–D11.
- [docs/ROADMAP.md](docs/ROADMAP.md): the current milestone and its work mode.
- [docs/WORKING.md](docs/WORKING.md): when to work standalone, delegate to a subagent or propose a workflow, and the resource rules for parallel work.
- [docs/CONTRACT.md](docs/CONTRACT.md): what is actually implemented. Roadmap items are not supported until a milestone has verified them.

## Layout

| Path | Content |
|---|---|
| `compiler/` | Node-hosted compiler: collector, language layer, framework adapters (`adapters/`), IR, codegen, mappings, CLI. M1 moves IR/codegen to `crates/` and converts the rest to TypeScript |
| `native/` | Rust runtime and probes copied into generated apps (becomes `crates/runic-runtime` in M1) |
| `fixtures/` | Example and conformance applications per framework, including expected-rejection fixtures |
| `conformance/` | Isolated framework-version environments (more Vue/Svelte pins); the conformance harness lands here in M1 |
| `mappings/` | Pinned mapping packs (`accepted/`), their proofs (`proofs/`), `registry.lock.json`, validation corpus |
| `tests/` | `node --test` suites; `tests/data/` holds frozen inputs |
| `docs/` | Living docs at the top level; `history/` holds the Phases 0–4 record (raw evidence is at tag `baseline/phase4`) |

## Rules

- **Direction.**
  - Generated application code and native bindings are Rust.
  - Framework- and version-specific knowledge lives only in adapters and mapping packs; the backend never branches on framework names.
  - Shared language analysis, IR, optimisation and codegen must stay reusable by every frontend.
- **Rejecting unsupported code.** Reject uncovered behaviour with a source-located diagnostic. Never drop or approximate it.
- **QuickJS.** It is an opt-in crutch only (D7). Default builds contain no JS engine, and every island must be reported with the reason it could not be lowered.
- **Deterministic builds.**
  - Normal builds use pinned validated mappings and make no model calls; model-assisted discovery is an explicit separate operation.
  - When `compiler/ir.mjs`, `compiler/mappings.mjs` or `mappings/validation-corpus.json` change, re-accept the unchanged candidates with `node compiler/cli.mjs accept mappings/accepted/<file>`. Never bypass `E_REGISTRY_STALE`.
- **Verification honesty.**
  - A missing or unavailable stage is *incomplete*, never passed.
  - Do not force blur, drop cases, widen tolerances or rewrite reference output to manufacture parity.
  - Internal events do not prove OS keyboard/IME delivery.
- **History.**
  - Use git history and tags instead of copying documents or evidence. Don't commit large generated output; commit short conformance summaries.
  - Leave `docs/history/` and the external Blitz/Blazor archive unchanged.
- **Scope.** Make no broad rewrites or dependency upgrades outside the milestone that plans them.

## Environment and commands

Use the locked flake environment. Check `flake.nix`, `.envrc` and the README first. Without an allowed `.envrc`, prefix commands with `nix develop . -c`.

```sh
npm ci                                   # once
npm test                                 # compiler suites
node compiler/cli.mjs build fixtures/counter-svelte --release
./artifacts/counter-svelte/runic-app --x11
prettier --write "compiler/**/*.mjs" "tests/*.mjs"   # formatting (in dev shell)
cargo fmt
```

Native builds share `target/` and serialise through `.cache/build.lock`. Run them one at a time and not from separate worktrees (see WORKING.md). Documentation-only changes need no native rebuild.
