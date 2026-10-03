# Phase 3 results

Implemented on 2026-10-02: a bounded Svelte 5 frontend using original source and the official parser/compiler, with scalar runes, ordered writes, derived values, conditional markup and controlled text editing. Applications compile to the existing Rust backend and live Blitz controls. The new implementation and automated conformance checks pass. Native OS keyboard, platform IME and Wayland resize gates remain incomplete.

The accepted surface is [contract v4](CONTRACT-V4.md). The [Phase 3 plan](PHASE3.md) records milestones; [architecture decisions](ARCHITECTURE.md) preserve framework independence and incremental version maintenance. [Contract v3](CONTRACT-V3.md) preserves Phase 2 unchanged.

## Delivered milestones

| Milestone | Delivery |
|---|---|
| Tooling and collection | Svelte/compiler 5.57.1 and official Vite plugin 7.3.1, with an isolated Svelte 5.49.2 environment using the same plugin and Vite 8.3.2. Adapters own component extensions and original script extraction. Original offsets and collection diagnostics survive Vite's error wrapping. |
| Source lowering | Scalar `$state`, pure `$derived` and bounded `$derived.by`, setup/handler captures, ordered writes, modern handlers, scalar interpolation and native conditionals. Unsupported reactive/template/component behavior is diagnosed explicitly. |
| Finite consumer | The counter observes state and derived reads between writes, frozen setup captures, disabled controls, boolean text and conditional content. Each pin has 12 reachable states and 36 transitions. |
| Editing consumer | Simple `bind:value` reaches the same typed payload, UTF-16 validation and stable live editor as React/Vue. Read-only, disabled, clear, identity, selection and Unicode scenarios pass on both pins. |
| Conformance and deployment | Compiler/native/browser/geometry/pixel/optimization checks and both isolated packaged installations pass. Original React/Vue counters/editors are also compared afresh. Desktop OS gates remain separate. |
| Version maintenance | Identical original Svelte source, validation and normalized generated Rust on 5.57.1 and 5.49.2, with actual execution on each runtime. No Rust backend or binding changes were needed. |

Schema 3, `compiler/ir.mjs`, `compiler/codegen.mjs` and all native source bytes remain unchanged from Phase 2. The UI tree is a construction/binding plan; generated Rust updates live nodes. Svelte support adds no virtual DOM runtime and does not port its private generated helpers. The predominantly Rust compiler remains a future option.

## Semantic findings

The sequence handler captures `n`, writes `n = 2`, captures the derived double, then writes `n = 3` and reads that derived value again. From the initial state `[1,0,0,0,true]`, both original Svelte runtimes and native Rust produce `[3,1,6,4,true]`. The setup capture displayed by `#initial` stays `1`. Pure scalar derived reads lower to explicit expressions over earlier supported writes; this does not claim arbitrary reactive graph, object identity, effects or scheduling support. Svelte documents [derived invalidation and reads](https://svelte.dev/docs/svelte/$derived).

The reference-only combined-listener probe sets `oninput={() => before = text}` beside `bind:value={text}`. On Svelte 5.57.1, modern delegated `oninput` observes `first` after the first payload and `second` after the second. The binding documentation describes an existing element listener running before the bound update; that description must not be generalized to the checked delegated route. Native lowering rejects the combination in either attribute order, until its actual ordered handler/payload semantics are supported. [Source and identity](../evidence/phase3/browser/binding-order-source.json), [observations](../evidence/phase3/browser/binding-order.json), [binding documentation](https://svelte.dev/docs/svelte/bind).

Initial editor comparisons captured a transient browser focus on Clear after Svelte made that button disabled. Background preview timers alone did not reliably trigger paint and focus teardown. A standalone observation saw natural blur after about 50 ms; an actual T3 frame capture also released it. The harness now pauses at that condition for a raw frame capture and acknowledgement of natural blur. It does not force blur, alter application styles or suppress a focus mismatch. Final traces compare the same post-render boundary as native snapshots. The retained [initial failures](../evidence/phase3/probes/editor-svelte-before-paint.json), [additional-version failures](../evidence/phase3/probes/editor-svelte-5.49.2-before-paint.json), [timer-only retry](../evidence/phase3/probes/editor-svelte-timer-only.json), [natural blur observation](../evidence/phase3/probes/focus-paint.json) and [frame barriers](../evidence/phase3/probes/paint-barriers.json) explain the correction.

The supported source uses external local CSS. Svelte's scoped styles add generated classes/selectors, so accepting them needs a validated association with the native DOM rather than dropping the scoping. Effects, deep proxies, stores/context, component composition, snippets/lists, transitions, writable derived overrides and SvelteKit remain outside the first adapter.

## Verification and evidence

The aggregate [verification report](../evidence/phase3/verification.json) checks current source/IR/native-input/binary identities and retains `incomplete` solely for the inherited desktop gate.

| Check | Result |
|---|---|
| Compiler | 36 tests pass, including all previous phases and Svelte ordering, captures, derived getters, binding payloads, conditionals, source locations, bootstrap identity, shadowed globals and explicit negatives. [Receipt](../evidence/phase3/compiler-tests.json), [log](../evidence/phase3/compiler-tests.txt). |
| Native transitions | 13,476 cases across 20 optimized/baseline artifacts, plus 2,124 on the two additional Svelte artifacts: 15,600 total. Six new Svelte builds; 16 existing builds reused only after their unchanged native inputs were checked, then re-executed. [Regression](../evidence/phase3/native/regression.json), [additional version](../evidence/phase3/versions.json). |
| Typed closure | Each Svelte editor has 2,056 projected states and 536,616 transitions. The domain remains one scalar single-line string up to 256 UTF-16 units. These are length/control classes, not an enumeration of strings. [Validation model](TEXT-VALIDATION.md). |
| Fresh browser comparison | 288 finite cases: React/Vue counters and both Svelte pins, each at 420×600 and 800×600. Editing runs 13 scenarios/88 observations per runtime: React, Vue and both Svelte pins, totaling 52 scenarios and 352 observations. Semantic/focus/selection/identity checks and the unchanged 2 px geometry tolerance pass. [Current Svelte editor](../evidence/phase3/browser/editor-svelte.json), [additional Svelte editor](../evidence/phase3/browser/editor-svelte-5.49.2.json), [browser reports](../evidence/phase3/browser/). |
| Retained browser regression | 732 original-runtime cases for the four frozen Phase 1 apps, with source, IR, binary and native-input identities unchanged. Their native transitions are re-executed in this phase; browser reports remain their original Phase 2 receipts. |
| Internal control probe | 14 checks re-executed with the unchanged Rust controls/probe source and verified binary. [Report](../evidence/phase3/native/editing-probe.json). |
| Optimization parity | 15 Svelte editor trace/framebuffer pairs: the 13 scenarios, internal composition commit and invalid-payload restoration. State, elements, focus and final image bytes match both modes. |
| Browser keys | Actual T3-delivered keys reject insertion at the 256-unit boundary without moving the caret, then allow selection replacement in the original Svelte editor. This is browser evidence, not native OS delivery. [Report](../evidence/phase3/browser/keyboard-boundary.json). |
| Pixels | Ten fresh raw Svelte pairs across both pins, including the current counter at both widths. Maximum 8-bit MAE is 0.752, below the unchanged 3/255 tolerance. Capture calibration has zero error. The 24 earlier React/Vue pairs are retained with unchanged identities. [Pixel report](../evidence/phase3/pixels.json), [calibration](../evidence/phase3/probes/capture-path.json). |
| Native dependencies | Cargo normal-edge dependency scan finds no JavaScript engine or WebView. Frontend tooling remains on the build/reference side. [Tree](../evidence/phase3/native/dependency-tree.txt). |
| Installation | Both Svelte apps unpack and launch in a fresh imported local Nix store, with empty environment, no home/compiler/Node/browser/shared font directory, actual X11 first presentation and interaction traces. [Report](../evidence/phase3/fresh-install.json). |

Finite native cases cover every reachable edge; editor witnesses cover every length/control combination plus Unicode examples. The typed operation proof and concrete traces establish different guarantees. Neither certifies arbitrary string rasterization or platform input behavior.

Both complete compressed distributions are approximately 27 MiB, with full installed boundary accounting approximately 79 MiB. Packages include their configured native closure and retain the existing Linux kernel/compositor/display boundary. First presentations are installation observations, not cold-start benchmarks. No performance improvement is claimed. [Counter package](../evidence/phase3/packages/counter-svelte.json), [editor package](../evidence/phase3/packages/editor-svelte.json).

Native OS keyboard, platform IME and Wayland resize remain the [Phase 2 observations](../evidence/phase2/native/os-input.json). Runtime/control bytes are unchanged. Internal composition, browser keys and packaged window presentation cannot close those gates. Clipboard/paste, general forms, accessibility and broad framework/application support remain outside verified capabilities.

## Reproduction

Use the repository's [locked development environment](../README.md#build-and-run). The aggregate driver uses this established Phase 2 workspace: retain its prior ordinary/additional-Vue artifacts and `target/release/editing-probe`, whose identities are checked against the historical receipts. The source manifest also records the retained additional-Vue artifacts. On a fresh source checkout, the direct CLI builds in the README demonstrate Svelte independently; reproducing the aggregate retained-reference gates additionally requires the matching prior artifacts. Do not rewrite historical receipts to bypass an identity mismatch. Within the established environment:

```sh
npm ci
npm ci --prefix conformance/svelte-5.49.2
node scripts/phase3-native.mjs --build
node scripts/phase3-versions.mjs --build
node scripts/phase3-browser.mjs
```

The server provides current/additional Svelte counters on 5200/5202, editors on 5201/5203, React/Vue counters on 5204/5205, editors on 5206/5207 and the reference-only binding probe on 5208. Run counters with `/?runicCase=0` at both widths and editors with `/?case=0` at 800×600. Wait for each complete report before reusing that tab.

For the editor paint barrier, inspect `window.phase2NeedsPaint` through T3 preview. When true, take a raw `preview_snapshot`, then evaluate `window.phase2AfterPaint()`. Continue capture/checking if it returns `{settled:false}`; never force blur. The barrier preserves post-render observations when background preview paint is deferred. Geometry reads and framework microtasks alone do not certify that boundary.

Pixel capture uses the calibrated background preview at DPR 1, the plain original URL, loaded fonts and settled paint. Capture initial and interaction states for both Svelte pins at 800×600, plus the current counter at 420×600. Counter interaction is event 0; editor interaction is focus, payload `Native é😀`, then blur. Save raw files with the names consumed by `scripts/phase3-pixels.mjs`. Then:

```sh
node scripts/phase3-pixels.mjs
node scripts/package.mjs counter-svelte phase3
node scripts/package.mjs editor-svelte phase3
node scripts/fresh-install.mjs phase3
node scripts/phase3-verify.mjs --test
node scripts/phase3-manifest.mjs
```

The verifier returns 0 for fully passed, 1 for failed and 2 for incomplete. Current code returns 2 for the retained OS gate. The [Phase 3 source manifest](../evidence/phase3/source-manifest.json) records final source/lockfile/documentation and all 24 artifact identities. Phase 0 archives and Phase 1–2 receipts/manifests remain unchanged. Generated version copies can be recreated by the version script; dependency caches and locked environments are retained.
