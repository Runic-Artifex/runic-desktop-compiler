# Phase 2 results

Implemented on 2026-10-02: independent React and Vue frontends, shared semantic analysis/IR/Rust generation, typed controlled text editing and an actual additional Vue version. The implementation and automated conformance checks pass. Full OS keyboard, platform IME and Wayland resize verification remain incomplete; Phase 2 does not close those desktop gates.

The Phase 2 accepted surface is preserved in [contract v3](CONTRACT-V3.md), with its [typed text validation model](TEXT-VALIDATION.md). The [Phase 2 plan](PHASE2.md) and [architecture decisions](ARCHITECTURE.md) remain separate from compatibility claims.

## Delivered milestones

| Milestone | Delivery and limits |
|---|---|
| 1. Compiler boundaries | `frontend.mjs` dispatches versioned React/Vue adapters. Shared `language.mjs`, schema 3 validation, mappings, Rust generator and native controls have no framework-specific backend branch. Schema 2 validates and explicitly migrates. A framework-free IR consumer reaches Rust generation. |
| 2. Second frontend | Vue SFC parsing uses the official compiler. Equivalent finite counters expose captured values, immediate ref reads, computed output, boolean interpolation, disabled buttons and conditional content. Each app is compared with its original framework runtime. |
| 3. Native editing | A standalone Rust consumer passes 14 internal control checks on the unchanged Blitz pin. Live editor updates, echo preservation and read-only/length guards are shared bindings. X11 pointer delivery passes; OS keyboard and platform IME remain unverified. |
| 4. Typed validation | One scalar single-line text slot, at most 256 UTF-16 units. The checker establishes an operation grammar before exact exploration of length/control classes. Unsupported content predicates and malformed payload uses fail explicitly. |
| 5. Two editable consumers | Ordinary React and Vue apps compile to Rust, with preview/count, clear, read-only, disabled and conditional details. Both pass original-runtime conformance and isolated installation. Desktop input certification remains incomplete. |
| 6. Version maintenance | The same Vue source is compiled and executed with Vue/compiler-sfc 3.5.43 and 3.5.24 using separate locked dependency environments. Normalized generated Rust behavior and validation are identical; backend/binding bytes are unchanged. |

Vue was chosen for its official SFC parser and its immediate ref reads, which expose a useful difference from React's render snapshot. After the sequence handler, React's counter state is `[3,1,1,true]` and Vue's is `[3,1,3,true]`. Neither is rewritten to imitate the other. Vue boolean interpolation becomes an explicit string operation; React boolean children remain non-rendering. These are frontend semantic decisions represented in the shared IR.

Applications remain authored in JavaScript/TypeScript. Generated application code and native bindings are Rust. A predominantly Rust compiler is a future option; this phase does not initiate that rewrite or claim support for Angular, Svelte or Solid.

## Verification and evidence

The aggregate [verification report](../evidence/phase2/verification.json) checks source/IR/native-input/binary identities rather than accepting the presence of old reports. Its final status remains `incomplete` for the desktop gate. Passing checks include:

| Check | Result |
|---|---|
| Compiler tests | 29 tests, including preserved Phase 1 cases, framework-free IR, migration, scheduling, all text length classes and explicit rejection cases. [Receipt](../evidence/phase2/compiler-tests.json), [log](../evidence/phase2/compiler-tests.txt). |
| Native regression | 16 current optimized/baseline release builds; 9,228 transition cases. This includes all finite reachable edges and 2,088 typed witnesses per editor/build mode. [Report](../evidence/phase2/native/regression.json). |
| Text closure | Each editor has 2,056 projected states and 536,616 transitions. These are length/control classes, not an enumeration of strings. Arbitrary accepted content is preserved through direct copy/rendering; no universal pixel or OS-input proof is claimed. |
| Editing conformance | 13 scenarios and 88 observations per frontend/runtime: React, Vue 3.5.43 and Vue 3.5.24. Selection, deletion, Unicode, echo, identity, clear, read-only, disabled and length-limit behavior pass; geometry tolerance remains 2 px. Browser actions are programmatic and native actions use the internal EventDriver. [React](../evidence/phase2/browser/editor-react.json), [Vue](../evidence/phase2/browser/editor-vue.json), [additional Vue](../evidence/phase2/browser/editor-vue-3.5.24.json). |
| Finite browser regressions | All reachable transition paths in the four unchanged Phase 1 fixtures and three counter runtime variants, at 420×600 and 800×600; 948 cases in total. Reports are under [browser evidence](../evidence/phase2/browser/). |
| Optimization parity | 30 editor trace pairs, including composition and invalid-payload rollback, compare state, elements, focus and final framebuffer bytes in both modes. |
| Browser keyboard boundary | T3-delivered browser keys reject an insertion at length 256 without moving the caret, and permit selection replacement, in both original framework editors. This is additional browser evidence, not native OS certification. [Report](../evidence/phase2/browser/keyboard-boundary.json). |
| Pixels | 24 raw image pairs using the unchanged 3/255 mean absolute error threshold. Sixteen replay the unchanged historical browser references for the frozen Phase 1 apps; eight fresh captures cover initial/interaction states of the new React/Vue counters/editors at 800×600. [Report](../evidence/phase2/pixels.json), [capture calibration](../evidence/phase2/probes/capture-path.json). |
| Version reuse | Identical source and normalized Rust behavior on the additional Vue version, plus actual original-runtime/browser/native comparisons. [Report](../evidence/phase2/versions.json). |
| Installation | All four new apps unpacked into empty directories and run with imported runtime closures in an isolated local store, empty environment and no home/compiler/Node/browser/shared font directory. Includes actual X11 first presentation and editor input/clear traces. [Report](../evidence/phase2/fresh-install.json). |

The baseline mode bypasses accepted mapping rewrites; it does not bypass adapters or text validation. Native witness counts supplement the compiler proof. They do not exhaust the Unicode string domain.

Both existing numeric mapping candidates retain their original bytes. Because the validator changed, they were independently revalidated and accepted with new Phase 2 proofs: [pure clamp](../evidence/phase2/mappings/pure-clamp.json), 60,430 cases, and [bounded increase](../evidence/phase2/mappings/bounded-increase.json), 51,880 cases. [Applicability](../mappings/APPLICABILITY.md) follows resolved pure semantics and preconditions. Historical Phase 1 proofs and discovery receipts remain unchanged; there was no new model discovery run in this phase.

## Native findings and open gates

The Blitz pin remains `89e5e615aea649a1a9630c526956aa3d90a3afa7`. Its editor accepts a read-only edit without our binding guard: the standalone probe records the raw value `あx`. The shared Rust binding prevents that edit, preserves selection on equal-value echoes and blocks overflowing character-key edits before mutation. A local embedded font is required for reliable editing layout. [Probe](../evidence/phase2/native/editing-probe.json), [source](../native/editing_probe.rs), [binding](../native/controls.rs).

No archived patches were imported and the cancelled Blitz/Blazor initiative was left unchanged. Its [review](BLITZ-BLAZOR-REVIEW.md) informed probe cases; this repository does not depend on its SDK, bridge or caches.

The current native Vue binary received an actual X11 pointer click, toggled read-only and retained editor identity. Native CUA keyboard/text calls timed out without a native key/input trace. After the Codex Desktop socket disappeared, restarting it recovered inventory, screenshots and pointer input; keyboard delivery still timed out. [OS observations](../evidence/phase2/native/os-input.json), [pointer trace](../evidence/phase2/native/os-mouse.json). Internal key/selection/composition tests cannot certify the missing OS route.

Platform IME, clipboard/paste truncation and boundary semantics, textarea, general forms/select, arbitrary editor APIs and accessibility remain outside verified support. The Phase 1 Wayland resize gate remains open. Pixel checks cover the recorded states and fixed dimensions; editor defaults required explicit width/block layout because browser and Blitz default geometry differ. The retained [default-layout diagnostic](../evidence/phase2/probes/input-default-layout.json) documents that finding.

Packages include the full configured runtime closure and retain the existing kernel/compositor/display boundary. The four complete compressed distributions are approximately 27 MiB each, with installed boundaries approximately 79 MiB. Reports under [packages](../evidence/phase2/packages/) state the byte metrics. No Phase 2 speed or size improvement is claimed; first-presentation observations are installation checks, not a new performance study.

## Reproduction

Use the locked environment described in the repository [README](../README.md). The following commands run within that environment and reuse existing caches:

```sh
npm ci
npm ci --prefix conformance/vue-3.5.24
node scripts/phase2-native.mjs --build
node scripts/phase2-versions.mjs --build
node scripts/phase2-verify.mjs --test --serve
```

The reference server command prints ports 5190–5199. In T3 preview, visit finite references at `/?runicCase=0`, at both 420×600 and 800×600. Visit the three editors at `/?case=0`, at 800×600. Each suite writes a complete report only after every case returns. Conformance settling uses timers after framework microtasks so background previews do not wait indefinitely for paused animation frames; geometry reads force layout. Pixel capture separately waits for fonts/paint and uses the calibrated background route without modifying application CSS.

Capture each new application's original runtime at its plain URL, initially and after event 0 for counters, or input payload `Native é😀` followed by blur for editors. Save raw captures with the paths used by `scripts/phase2-pixels.mjs`, then:

```sh
node scripts/phase2-pixels.mjs
node scripts/package.mjs counter-react phase2
node scripts/package.mjs counter-vue phase2
node scripts/package.mjs editor-react phase2
node scripts/package.mjs editor-vue phase2
node scripts/fresh-install.mjs phase2
node scripts/phase2-verify.mjs
node scripts/phase2-manifest.mjs
```

The verifier returns 0 for fully passed, 1 for failed and 2 for incomplete. It leaves OS gates incomplete until actual delivered input/resize evidence replaces the observations. Generated additional-version fixture copies are disposable and can be recreated by the version script; their dependency cache and lockfiles are retained. [Phase 2 source manifest](../evidence/phase2/source-manifest.json) records final source and artifact hashes. Phase 0 archives and Phase 1 evidence are preserved.
