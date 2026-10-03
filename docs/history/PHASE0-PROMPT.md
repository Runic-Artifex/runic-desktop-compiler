# Runic Desktop Compiler — implementation prompt

This is the original Phase 0 prototype brief. The current agreed direction is recorded in [the architecture decisions](docs/ARCHITECTURE.md), with shared local module scope and milestones in [Phase 4](docs/PHASE4.md). React is the first frontend; React, Vue and Svelte now exercise shared machinery and versioned adapters. Generated application code and native Blitz bindings are Rust. See [the documentation index](docs/README.md) for implemented contracts and historical results. The original brief below is preserved as context.

You are implementing a research prototype in `/home/viktor/Development/RunicDesktopCompiler` on a NixOS development machine. Read this entire document before starting. It is the complete handoff from the design discussion; no access to that conversation is required.

## Objective

Build a small, genuine application compiler that converts a documented subset of ordinary React web applications into native Rust applications rendered with Blitz. Then demonstrate an LLM proposing a reusable compiler mapping that is independently validated and applied to another application.

Deliver working software and reproducible evidence, not just a design document or hand-translated demo. Work through the checkpoints below. Use focused experiments to resolve uncertainties and document actual limitations.

The long-term ambition is to package existing web applications as small desktop applications without shipping Chromium or an OS WebView. A compiler will analyze the application, recognize supported behavior, and select smaller implementations from a growing library of handwritten and machine-proposed mappings. Future inputs may include React, Vue, Svelte, and Angular.

The target is the smallest implementation found that preserves behavior within an explicit compatibility contract. Do not promise globally minimal output or universal equivalence for arbitrary JavaScript.

## Decisions already made

- Use Rust and Blitz for the generated native application.
- Use a framework-independent intermediate representation (IR) between source analysis and Rust generation.
- Begin with a small React subset and Linux on this machine.
- Use a Vite integration to collect source, imports, CSS, and assets. Inspect source before useful framework information disappears into generated or minified code.
- Bun can be a build-time package manager or script runner. A Bun fork is not part of this prototype, and Bun must not be required by the generated application.
- The initial accepted programs compile without a JavaScript engine. Unsupported constructs fail with actionable diagnostics. Do not implement a broad JavaScript fallback in this first experiment.
- Retaining a small existing JavaScript engine for unsupported regions is a possible later architecture. Engine-free output is conditional on full coverage of the application's required behavior.
- Normal compilation is deterministic and uses pinned accepted mappings. LLM-assisted discovery is a separate, explicit operation.
- An LLM proposes transformations; it does not certify their correctness.
- Keep this project independent of existing Runic SDK repositories. Do not modify sibling projects or introduce SDK integration as a prerequisite.

## Prototype applications and compatibility contract

Create two small, ordinary React applications: a quantity picker and a thermostat control. They should exercise similar capabilities while differing in source structure, constants, styling, and composition.

Initially support a clearly defined subset of:

- Function components and local numeric/boolean state.
- Static HTML elements, component composition, text expressions, and conditional rendering.
- Click handlers and functional state updates.
- Derived labels, disabled buttons, and conditional classes.
- A small expression language of pure computations.
- Local imports with available source, CSS, and embedded assets.

Implement a smaller coherent subset first if needed, then extend it to both fixtures. Document exactly which constructs and values are accepted. Support must be established by analysis, not by application names or hardcoded fixture paths.

Unsupported effects, arbitrary DOM manipulation, asynchronous work, dependency behavior, or JavaScript constructs must be rejected with source locations and explanations. Never silently drop code, replace unknown behavior with a constant, or use screenshots as the generated UI.

Numeric restrictions require explicit justification. JavaScript numbers, coercion, `NaN`, signed zero, overflow, and string formatting cannot silently become different Rust behavior. A bounded finite-integer domain is acceptable when its invariants are established and enforced; a TypeScript annotation alone is not proof.

Define the observable semantics of supported state updates, event handlers, conditional mount/unmount, and UI bindings. In particular, model functional updates and their ordering correctly, and define when updates become visible. Reject unsupported closure, hook, or scheduling patterns rather than guessing. If conditionals are initially restricted to stateless elements, say so and enforce that restriction.

Use the same application source for the browser reference and compiler input. A normal application production build may contain JavaScript; the generated native program must not execute it.

## Architecture

### 1. Frontend and analysis

Implement a Vite plugin or closely integrated build step that collects a reproducible input graph. Use ASTs and resolved symbol identities, not regular expressions or source-name matching, to recognize constructs.

Handle application code before transforms that erase needed semantics. Inspect both source and resolved dependency information as appropriate. Keep collection separate from lowering so another build tool could eventually supply equivalent inputs.

Produce diagnostics with source locations, construct descriptions, and the missing capability or failed precondition. Pin relevant frontend and framework versions.

### 2. Intermediate representation

Define and validate a small IR with:

- State slots and their value domains.
- UI nodes and stable identities.
- Pure expressions and their effects/type information.
- Event handlers and ordered state transitions.
- Bindings between state and text, attributes, classes, and conditional nodes.
- Required native/runtime capabilities.
- Source provenance for diagnostics.

The IR is the semantic contract, not merely an AST with React names removed. Framework-specific adapters must preserve behavior before sharing generic optimizations.

### 3. Rust and Blitz backend

Generate Rust that constructs a Blitz document, maintains state, dispatches native input, updates bindings, and manages the window lifecycle. Embed the application's local assets and CSS.

First inspect the actual pinned Blitz APIs and examples. Validate a minimal native window and real input before investing heavily in compiler infrastructure. Reuse its supported DOM and rendering interfaces; do not assume upstream has JavaScript bindings or complete Chromium compatibility.

Preserve CSS and allow Blitz to lay out the application as the window changes. Do not precompute fixed screen coordinates as a substitute for layout. Use a bundled font to reduce comparison variability.

Start with a straightforward update mechanism. Then implement a dependency-based optimization that updates only affected bindings. Retain an optimization-disabled mode so the same accepted input can be compared before and after optimization.

The compiled application must run without a browser, WebView, dev server, separately installed Bun, or JavaScript engine. Report the complete deployment boundary, including shared libraries and assets; do not hide dependencies when reporting size. A single fully static executable is not required.

### 4. Mapping library

Give mappings a documented, versioned format/interface containing:

- Recognizer/matcher using resolved symbols or IR patterns.
- Applicability conditions and how they are checked.
- Lowering or rewrite.
- Required capabilities.
- Positive fixtures, negative fixtures, and boundary cases.
- Validation evidence and provenance.
- Supported framework/dependency versions where relevant.

Prefer declarative rules or a restricted mapping language for machine-proposed mappings. Treat arbitrary executable compiler extensions as a separate trust boundary. Keep candidates out of the accepted registry until validation completes.

Use a small set of handwritten rules to establish the compiler. A concrete candidate for the discovery experiment is a pure clamping helper lowered to supported minimum/maximum operations, under a justified numeric domain and evaluation-order contract. Inspect the helper's implementation; a familiar name is not enough. Choose another similarly bounded construct if it makes a better experiment, and explain why.

Mappings may expand supported input or improve runtime size/performance. Record which result was actually achieved. Adding support is not automatically a size optimization.

### 5. LLM-assisted discovery

When analysis encounters an unsupported construct, emit a bounded discovery bundle with relevant source, resolved dependencies, IR context, source locations, and diagnostics.

An explicit discovery command supplies that bundle and the mapping schema to an LLM. The model proposes a mapping, applicability conditions, positive and negative tests, and a lowering using supported compiler operations.

Run validation independently of the proposal process. Use a compiler-owned test corpus, generated inputs, and differential execution against the JavaScript reference. For small bounded domains, use exhaustive enumeration where practical. Do not let tests proposed by the model be its only judge.

Accepted rules are saved as inspectable, versioned artifacts. Record model/provider identity when available, prompt/input hashes, the candidate, validation results, and accepted rule hash. Never store credentials in artifacts or logs.

Use an available authorized model interface if one exists. Otherwise implement and test the provider boundary with a clearly labeled replay fixture, and report that live discovery remains unvalidated. Do not present a manually authored or replayed candidate as a live LLM discovery. Missing model access should not prevent completion of independent compiler/backend work.

The central experiment is to discover a rule using the first application and reuse the unchanged rule on the second application. Keep the second application's source out of the discovery input. Include an incompatible example that the rule must reject.

## Validation and acceptance gates

### Checkpoint A — native compilation

- Inspect and pin dependencies and establish the project environment.
- Prove a minimal Blitz window with real input on Linux.
- Compile the first ordinary React fixture through source analysis, IR, and Rust generation.
- Exercise real native input and verify resulting state and visible UI.
- Establish that no browser, WebView, or JavaScript runtime executes in the generated application.

### Checkpoint B — semantics and optimization

- Compile the second independently structured fixture using the same compiler.
- Compare original browser behavior with generated native behavior for the same event sequences.
- Include boundary values, repeated interactions, disabled controls, conditional UI, and state-update ordering within the supported contract.
- Compare screenshots and element geometry at multiple viewport sizes with fixed fonts/data. Define tolerances and report discrepancies; do not simply update reference images to make failures disappear.
- Test IR/backend semantics independently from visual comparison. Calling an internal handler alone does not verify native hit testing, focus, or input delivery.
- Build the same accepted application with optimization disabled/enabled and measure actual results.

### Checkpoint C — growing the dictionary

- Demonstrate a construct rejected before a new mapping is available.
- Produce a candidate through the discovery interface, independently validate it, and retain the evidence.
- Accept and pin the mapping; rebuild without another LLM call.
- Apply the unchanged rule to the held-out application.
- Show a negative example rejected by the rule's preconditions.

Report installed artifact/dependency size, compressed distribution size, startup-to-first-presented-frame, and representative update cost. Include repeated measurements and the source/toolchain/configuration used. Distinguish cold and warm conditions where relevant. A transformation is not successful merely because generated source is shorter; report neutral results and regressions honestly.

Tests support claims within their coverage. Do not describe differential testing as a proof for all inputs. Formal checks may be used for restricted computations, but general JavaScript-to-native equivalence is not an assumed available tool.

## Suggested CLI and deliverables

The following command names describe the desired workflow, not an existing API:

```text
runic-compiler analyze ./app
runic-compiler build ./app
runic-compiler compare ./app
runic-compiler discover ./app
```

Keep the implementation small; adjust names or organization when useful. Deliver:

- Source, lockfiles, and reproducible Nix development/build instructions.
- Vite integration, IR specification/validator, and Rust/Blitz code generation.
- Two browser/native fixtures plus targeted incompatible fixtures.
- Handwritten mappings, the proposed mapping, and retained validation evidence.
- A usable CLI and actionable unsupported-input diagnostics.
- Focused semantic tests, differential comparisons, and native UI verification.
- An evidence report with measured results, exact reproduction commands, and limitations.
- A concise README explaining how to reproduce the demo and which checkpoint is actually complete.

Do not add full framework support, cross-platform packaging, automatic updater infrastructure, a Bun/JavaScriptCore fork, arbitrary JavaScript-to-Rust translation, or SDK integration to this first prototype.

## Working on this NixOS machine

- Inspect existing files and any applicable `AGENTS.md`, `flake.nix`, `.envrc`, and development instructions before editing or choosing commands. Preserve existing user work. The new folder may initially contain only this prompt.
- Reuse the project's locked toolchain and caches. If the environment is already loaded, run directly. Otherwise prefer `direnv exec <project-root> <command>` for a nix-direnv project, after inspecting `.envrc` and `direnv status`. If no environment exists, create a small reproducible project environment rather than guessing `/nix/store` paths or installing global SDKs/browsers.
- Prefer normal Git-aware `use flake` / `nix develop .`. Avoid `path:.` for a growing tree because it can snapshot ignored caches and build outputs. If initializing a repository, stage only necessary source inputs; never use `git add .` to make Nix inputs visible.
- Add `watch_file` entries before `use flake` for imported shell definitions that affect the environment. Reload when they change. A last-working-shell fallback does not validate a changed shell; explicitly evaluate the current environment when checking it.
- Without nix-direnv, group related work in one development shell or reuse a stable development profile outside source inputs. Refresh it when relevant inputs change.
- Reuse dependency caches and incremental outputs. Keep shell hooks cheap. Give temporary outputs an explicit lifetime; preserve failure reports and useful shared caches.
- Before expensive Rust/browser/build work, check `df -h` for the project and `/tmp`, and container storage if used. Start with focused checks and conservative concurrency. Do not overlap full verification runs.
- On `ENOSPC`, stop launching expensive work, identify the failing filesystem and relevant usage, and check inode exhaustion where applicable. Stop only task-owned processes. Clean identified task-owned disposable outputs; do not manually delete Nix store paths or broadly prune shared caches, containers, volumes, generations, or GC roots.
- Use the browser tooling required by the active agent environment. In T3 Code, prefer its collaborative preview tools and follow their availability/retry rules. Reuse the project's browser configuration for automated verification; do not install duplicate global browsers.
- For native UI inspection, this machine's computer-use plugin connects through `$XDG_RUNTIME_DIR/codex-desktop/computer-use-native.sock`. If it reports `native pipe path unavailable`, check Codex Desktop and `test -S "$XDG_RUNTIME_DIR/codex-desktop/computer-use-native.sock"`, start Codex Desktop if needed, reset the computer-use session, and retry. An inventory warning does not establish that all target operations are unavailable.

## References and research context

These references informed the design discussion on 2026-10-02. Recheck current APIs and status, then pin the actual versions/revisions used. Published measurements are context, not measurements of this prototype.

1. **Blitz source, architecture, examples, and status**  
   https://github.com/DioxusLabs/blitz  
   Modular HTML/CSS renderer with DOM, styling, layout, painting, and window integration. At the time of discussion, upstream documented missing features and no general JavaScript bindings. Inspect current APIs before implementing the backend.

2. **Vite plugin API**  
   https://vite.dev/guide/api-plugin  
   Source collection, resolution, transformation hooks, plugin ordering, and build integration. A module graph alone does not establish behavioral equivalence.

3. **React state update semantics**  
   https://react.dev/learn/queueing-a-series-of-state-updates  
   https://react.dev/reference/react/useState  
   Read these when specifying the supported hook and event-update contract. These are implementation references to consult, not a claim that the complete React model is in scope.

4. **Blitsen technical specification**  
   https://blitsen.dev/docs/tech/  
   Existing related work connecting web applications and Blitz. Useful for identifying DOM, event-loop, input, and rendering integration hazards. Its historical architecture sections may be superseded by migration documents.

5. **Blitsen Bun migration and measurements**  
   https://blitsen.dev/docs/bun-migration/  
   Describes Bun hosting a native renderer addon and records a Linux baseline around 144 MB for a particular build. This was not independently reproduced in our discussion. It illustrates that removing Chromium does not by itself establish a small runtime. Reusing Blitsen is optional, not an architectural requirement for this compiler experiment.

6. **Bun standalone executables and native addons**  
   https://bun.com/docs/bundler/executables  
   https://bun.com/docs/runtime/node-api  
   Relevant to the earlier bridge-based alternative. Bundling an executable with Bun is different from generating Rust without a JavaScript runtime. A compiled Bun application includes the Bun runtime.

7. **QuickJS embedding and bytecode compilation**  
   https://bellard.org/quickjs/quickjs.html  
   Possible future compatibility-engine reference. Its executable generation embeds bytecode and a runtime; it is not direct native compilation of JavaScript semantics. Some capabilities can be excluded under appropriate constraints.

8. **Alive2 — translation validation**  
   https://github.com/AliveToolkit/alive2  
   Architectural precedent for checking transformations independently of their producer. It validates LLVM transformations, not arbitrary JavaScript/React-to-Rust/Blitz programs. Do not treat it as an off-the-shelf equivalence checker for this project.

9. **egg — equality saturation and rewrite infrastructure**  
   https://egraphs-good.github.io/  
   Optional background for searching among equivalent representations with a cost model. An e-graph system is not necessary for the first prototype, and supplying rewrites does not establish their soundness.

## First actions

Inspect this folder and the machine's applicable instructions. Establish a short implementation plan around the three checkpoints. Investigate the smallest pinned Blitz integration and create the minimal native-input probe first. Then build the compiler incrementally, keeping unsupported behavior explicit and results reproducible.

The decisive demonstration is not a polished counter window. It is ordinary source passing through a reusable compiler, followed by a newly proposed mapping that survives independent validation and works unchanged on another application.
