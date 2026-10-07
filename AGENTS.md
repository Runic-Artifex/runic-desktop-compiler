# Working on Runic Desktop Compiler

The compiler turns JavaScript/TypeScript framework applications (React, Vue and Svelte today) into native Rust applications rendered with Blitz, with no browser, WebView or (by default) JavaScript engine. It gives the [Runic SDK](/home/viktor/Development/RunicArtifex/runic-sdk), and other hosts such as a Godot UI, a WebView-free, fast-starting UI path. The north star is the shadcn sites (shadcn-svelte as a whole SvelteKit site, plus the shadcn/ui and shadcn-vue component examples); the SDK's Translations Editor follows with the application bridge.

Start here:

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): binding decisions D1–D16.
- [docs/ROADMAP.md](docs/ROADMAP.md): the current milestone and its work mode.
- [docs/WORKING.md](docs/WORKING.md): when to work standalone, delegate to a subagent or propose a workflow, and the resource rules for parallel work.
- [docs/CONTRACT.md](docs/CONTRACT.md): what is actually implemented. Roadmap items are not supported until a milestone has verified them.
- [docs/GAPS.md](docs/GAPS.md): what is not covered yet, why, and what it would take. A change that adds a rejection or an unsupported report adds a row; one that covers it removes the row.

## Layout

| Path | Content |
|---|---|
| `compiler/` | Node CLI: Vite collector (`collect.mjs`, framework tooling in `adapters/tooling.mjs`), adapter dispatch (`frontend.mjs`), `scan`, and `codegen.mjs`, the bridge to the Rust backend |
| `frontend/` | TypeScript frontends run by Node's type stripping: shared language layer (`language.ts`, `types.ts`, `irtype.ts`, `modules.ts`), schema 4 types (`ir.ts`) and framework adapters (`adapters/`) |
| `crates/` | Rust workspace: `runic-ir` (schema 4 types, validator, migration, reference interpreter), `runic-codegen` (Rust generation, `runic-codegen` binary), `runic-runtime` (library linked by every generated app), `runic-js` (JS value semantics), `runic-blitz-probes` (Blitz behaviour probes) |
| `fixtures/` | Example and conformance applications per framework, including expected-rejection fixtures |
| `conformance/` | Harness (`run.mjs`: browser vs native; `differential.mjs`: interpreter vs native; `measure.mjs`: startup/size), case manifests (`cases/`), committed result summaries (`results/`), isolated framework-version environments |
| `tests/` | `node --test` suites (`npm test` also type-checks `frontend/`) |
| `docs/` | Living docs at the top level; `history/` holds the Phases 0–4 record (raw evidence is at tag `baseline/phase4`) |

## Rules

- **Direction.**
  - Generated application code and native bindings are Rust.
  - Framework- and version-specific knowledge lives only in adapters (and, from M6, mapping packs); the backend never branches on framework names.
  - Shared language analysis, IR, optimisation and codegen must stay reusable by every frontend.
- **Rejecting unsupported code.** Reject uncovered behaviour with a source-located diagnostic. Never drop or approximate it.
- **QuickJS.** It is an opt-in crutch only (D7). Default builds contain no JS engine, and every island must be reported with the reason it could not be lowered.
- **Deterministic builds.**
  - Normal builds are deterministic and make no model calls. Mapping packs (M6) will be pinned and validated; model-assisted discovery stays an explicit separate operation.
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
node compiler/cargo.mjs test --offline --workspace   # Rust crates (cargo on the shared target, under its lock)
node conformance/run.mjs [case…] [--pixels] [--no-opt] [--renderer gpu]   # browser vs native (GPU builds on lavapipe)
node conformance/differential.mjs        # interpreter vs generated code
node conformance/measure.mjs             # release size and first-frame time (Xvfb)
node compiler/cli.mjs scan <project>     # feature census against the roadmap
node compiler/cli.mjs build fixtures/counter-svelte --release
./artifacts/counter-svelte/runic-app --x11
prettier --write "compiler/**/*.mjs" "frontend/**/*.ts" "tests/*.mjs" "conformance/*.mjs"   # formatting (in dev shell)
cargo fmt
```

Native builds share one cargo target (`RUNIC_TARGET_DIR`, default `target/`) and serialise through `<target>/.runic-build.lock`, which also keeps one worktree from linking another's build of the workspace crates; worktrees point `RUNIC_TARGET_DIR` at the main tree's `target/` (see WORKING.md). Builds are `--offline` against the workspace `Cargo.lock`. Documentation-only changes need no native rebuild.
