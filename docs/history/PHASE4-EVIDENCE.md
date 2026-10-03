# Phase 4 Shared module results

Implemented on 2026-10-02 and verified through 2026-10-03: Vue and Svelte component scripts can consume ordinary local JavaScript/TypeScript constants and mapped pure helpers through acyclic named imports and re-exports. React accepts explicit named re-exports through the same source fixtures. Generated applications remain Rust with the existing Blitz bindings. The accepted surface is [contract v5](CONTRACT.md), with [v4 preserved](CONTRACT-V4.md); the [Phase 4 plan](PHASE4.md) records scope and ownership.

## Delivered behavior

`compiler/modules.mjs` owns ordinary module dependency order, immutable scalar initialization, named bindings and bounded pure helper declarations. Vue/Svelte retain their own component setup captures, immediate writes and derived/ref reads. Pure helper calls reuse the unchanged pinned `bounded-increase` rule and its independent evidence. No model was called, no new mapping was accepted, and no framework scheduler was added to the shared runtime.

All adapters analyze collected original source snapshots. The new tests change a module on disk after collection and verify that analysis still uses the collected bytes; a subsequent collection changes source identity and transitions. Errors retain the original module or component filename, line and column. The shared resolver checks every collected imported module, including unused initialization, rather than trusting Vite tree shaking to remove effects.

Equivalent `modules-react`, `modules-vue` and `modules-svelte` fixtures consume byte-identical `base.ts`, `logic.ts` and `advance.js`. They exercise transitive constants, import/export aliases, explicit re-exports, module constants as state initializers and a mapped helper in handlers. Each has 16 reachable states and 64 transitions, with identical closure hashes. Vue/Svelte setup captures remain fixed; framework-specific scheduling continues to be covered by the unchanged counter regressions.

All collected application files are analyzed as ES modules, including files with no import/export statements. A focused negative test found that TypeScript's automatic script classification could merge a private `Math` declaration with its global library symbol and incorrectly accept a throwing initializer. Forced module classification rejects that call and keeps unrelated modules' private bindings separate. The [probe](../evidence/phase4/probes/markerless-module-scope.json) records the finding; the regression is part of the compiler suite.

## Verification

| Check | Result |
|---|---|
| Compiler | All 45 tests pass. Nine new tests cover shared closure, initialization order, collected snapshots, source locations, cycles, effects, mutation, unsupported exports/helpers, lexical Math identity and mapping preconditions. The final full-suite receipt is linked below. |
| Native transitions | 13,988 cases across 28 artifacts: 13,476 fresh executions on 20 retained Phase 3 artifacts, 384 cases on six new current-version builds and 128 on two additional-version builds. [Receipt](../evidence/phase4/native.json). |
| Native binding modes | 18 trace/framebuffer pairs over three current fixtures, two widths and three scenarios. State, DOM/control identity, focus, geometry and final image bytes match. Timing and binding write counts remain recorded measurements and are excluded from semantic equality. |
| Version reuse | Vue 3.5.43/3.5.24 and Svelte 5.57.1/5.49.2 compile identical original module/component source with identical transitions and normalized generated Rust. Isolated environments resolve their actual pinned runtimes and compilers. |
| Original runtime conformance | All 512 semantic/geometry cases pass: 64 transitions at two widths for each current React/Vue/Svelte fixture, plus 64 at 800×600 for each additional Vue/Svelte runtime. The geometry tolerance remains 2 px. [Reports](../evidence/phase4/browser/). |

Schema 3, the IR validator, Rust generator, mapping validator/registry, native source and locked dependencies remain unchanged. Older ordinary fixtures, binaries and Phase 0 archives retain their exact identities; the Phase 4 verifier checks them without rewriting older receipts. The aggregate [verification report](../evidence/phase4/verification.json) retains incomplete native OS keyboard, platform IME and Wayland resize gates. The [compiler receipt](../evidence/phase4/compiler-tests.json), [test log](../evidence/phase4/compiler-tests.txt) and [source manifest](../evidence/phase4/source-manifest.json) record final identities.

An initial Svelte reference found that four unconstrained inline buttons accumulated intrinsic font-width rounding beyond the unchanged 2 px geometry tolerance. Semantic comparisons passed. Final ordinary fixtures use the existing flex controls style and explicit 120 px button widths. The [failed report, source, generated Rust and finding](../evidence/phase4/probes/unconstrained-buttons/) are preserved; acceptance does not widen the tolerance or adjust reference observations.

Repeated unconditional version-fixture copying initially triggered hot reloads in completed browser tabs. Each additional-version report then had 66 observations instead of 64 because the last case ran twice more. The strict completeness check failed despite no individual observation mismatches. Synchronization now skips byte-identical files, and both suites were rerun from case zero to produce exactly 64 observations each. The [failed reports and finding](../evidence/phase4/probes/repeated-version-copy/) are retained. Current-runtime reports remain complete at both widths.

## Reproduction and limits

Use the repository's locked Nix development environment. The aggregate regression requires the exact retained Phase 3 artifacts described by its source manifest. Direct builds of the new fixtures work from source. For version comparisons, install the existing isolated locks if needed:

```sh
npm ci
npm ci --prefix conformance/vue-3.5.24
npm ci --prefix conformance/svelte-5.49.2
node scripts/phase4-native.mjs --build
node scripts/phase4-browser.mjs
```

The native driver builds missing/stale new artifacts, checks unchanged native inputs before reuse, executes all transitions and writes `evidence/phase4/native.json`. It synchronizes only changed/missing ordinary fixture files into the additional-version environments. The browser server exposes original React/Vue/Svelte sources on ports 5300/5301/5302, additional Vue on 5303 and additional Svelte on 5304. Run `/?runicCase=0` through T3 preview at 420×600 and 800×600 for the three current runtimes, and 800×600 for the two additional versions. Wait for `window.runicSuite.complete` and the corresponding complete report before changing a tab's viewport or navigation. Then run:

```sh
node scripts/phase4-verify.mjs --test
```

Exit code 2 preserves the inherited incomplete OS gate. The verifier checks current source/IR/binary/native-input identities, compiler log, mapping pins, transition reports, binding-mode trace/image parity and original-runtime semantic/geometry results. It writes a new source manifest; it does not regenerate historical manifests.

This is a bounded module capability. Child component props/state lifetimes, Svelte rune modules, arbitrary helper captures, external packages, mutation, effects and general TypeScript remain separate work. Browser actions are programmatic clicks compared with internal native events. No new OS-delivery, raw browser pixel, packaging, startup/performance or accessibility certification is claimed. Earlier Phase 3 text/pixel/install evidence remains an unchanged historical result. A broader composition contract is the next useful capability to plan; the compiler remains Node-hosted and a Rust migration remains optional future work.
