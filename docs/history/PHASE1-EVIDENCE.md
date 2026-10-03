# Phase 1 implementation evidence

Phase 1 implements the compiler, registry, four applications, live discovery experiment, verification driver and deployment work in [the accepted plan](PHASE1.md). Its overall status is **incomplete** because full OS keyboard and Wayland resize verification remain open. Compiler, browser, visual, discovery and isolated installation gates pass. The [machine-readable summary](../evidence/phase1/verification/run-1/summary.json) is authoritative for individual gates; [contract v2](CONTRACT-V2.md) defines the supported input.

## Reproducibility and baseline

Phase 0's source and evidence were frozen before implementation in [baseline metadata](../baselines/phase0/baseline.json), `source.tar.gz` and `evidence.tar.gz`. All original 62 source inputs matched its manifest; the historical source hash is `2d5e366cc8d96925b655d0932ef8b07e2d92900a8369195cbf909adc6425b621`. Original root evidence and [the Phase 0 report](EVIDENCE.md) remain unchanged. New reports live under `evidence/phase1/`.

The final [source manifest](../evidence/phase1/source-manifest.json) records current compiler, native runtime, fixtures, tests, documentation, mappings and lock hashes, plus nine binary variants and checked baseline archive hashes. The locked environment uses Node 24.21.0, Rust 1.98.1, Cargo 1.98.0, React 19.3.0, Vite 8.3.2 and TypeScript 5.9.3. Blitz remains pinned to `89e5e615aea649a1a9630c526956aa3d90a3afa7`; Vello's CPU renderer and softbuffer present the frames. The retained Cargo dependency scan finds no browser/WebView/JavaScript engine. Networking and system-font loading are disabled.

## Compiler and original React comparisons

The final suite has **22 passing tests**. It covers original semantics plus mixed replacement/updater queues, enum state, arrows/import aliases/composition, deterministic generation, malformed/cyclic IR, resource limits, unsupported effects/controls/assets, original evaluation of dropped mapping arguments, held-out reuse, immutable multi-rule acceptance, ambiguity and preservation of usable output after a simulated Cargo failure.

| Application | Reachable states | Enabled transitions | Browser cases at two widths |
|---|---:|---:|---:|
| Quantity | 16 | 64 | 128 |
| Thermostat | 14 | 42 | 84 |
| Pricing | 36 | 180 | 360 |
| Settings wizard | 16 | 80 | 160 |
| Total | 82 | 366 | 732 |

Every native optimization mode matches all **366** IR transitions. Original React DOM replay at 420×600 and 800×600 matches all **732** semantic and geometry cases, using the unchanged 2 px geometry tolerance. The driver requires complete nonzero case sets and current source/IR hashes. It also compares nine snapshots per app between optimization modes: states, element identities and native PNG bytes agree. Reports retain individual mismatches rather than only totals.

The new pricing and wizard applications combine finite string choices, derived labels, conditional sections, arrow/function components, mixed reset queues and two local CSS imports whose cascade order changes appearance. They use ordinary buttons for choices. A real pinned-backend select probe rendered the surrounding paragraph and button but omitted select/options, so that capability remains rejected rather than partially implemented.

## Pixel gate and capture calibration

All **16** final comparisons pass the original **3/255 mean absolute error** threshold: four apps × two widths × initial/post-interaction states. Errors range from **0.354 to 1.014** in 8-bit units. [Corrected results](../evidence/phase1/verification/run-1/corrected/pixels.json) include source/IR hashes and both image hashes, verified by the driver.

Initial Phase 1 capture retained four failures, including the original thermostat 420-wide discrepancy. A DOM calibration, independent of application styling, established an error in the visible inline T3 capture path: a viewport-filling 7×11 px two-color checker had MAE **18.805**, despite DPR 1. Canvas checkers captured exactly, so the earlier canvas-only probe had missed the problem. Promoting the DOM to a composited layer did not fix it.

A fresh T3 background preview (`open:false`, `reuseExistingTab:false`) captured the same DOM checker with **MAE 0**. After explicit viewport, font readiness and two animation frames, the unchanged application source was recaptured through this calibrated path. No CSS adjustment, threshold change, filtering or reference-image editing was applied. Both initial failures and corrected images remain available; a first background snapshot taken before calibration paint is retained and excluded. The [capture-path receipt](../evidence/phase1/probes/capture-path.json) names the images, exact intervention and policy. Its DOM result supersedes the narrower historical canvas probe.

## Live rule discovery and held-out reuse

Pricing and wizard source graphs, mapping schema and independent corpus were [frozen before discovery](../evidence/phase1/frozen-inputs.json). Pricing failed with `E_MAPPING` for a helper implementing `Math.min(current + amount, maximum)`, structurally distinct from the original clamp family. Wizard independently expresses the same behavior through a differently named arrow helper and import alias. Neither fixture was edited after freezing; final tests recheck both source hashes.

Discovery used the installed Codex CLI with existing authentication, selecting `gpt-6-sol` explicitly. It ran in an empty temporary directory with read-only sandbox, shell tools disabled, ephemeral configuration and bounded input/output/time. Bundles contain pricing's unresolved implementation, diagnostic and context; no held-out source was sent. Actual CLI invocation/thread/usage receipts are separate from candidate-authored provenance. The model name records the requested CLI selection, not an independently attested server-side model identity. This invocation uses the documented [noninteractive Codex interface](https://developers.openai.com/codex/noninteractive/).

Two live attempts are retained. [Attempt 1](../evidence/phase1/discovery/attempt-1/rejection.json) used a string version and omitted required evaluation metadata; validation rejected its original bytes. Separate feedback in [attempt 2's bundle](../evidence/phase1/discovery/attempt-2/bundle.json) restated the compiler contract. [Attempt 2's candidate](../evidence/phase1/discovery/attempt-2/candidate.json) was accepted without editing its bytes. Thread IDs, usage and invocation limits are retained alongside each bundle; neither invocation emitted tool-call items. Feedback is part of the experiment, not a claim of first-attempt success.

The accepted `bounded-increase` v1 SHA-256 is `1b7a9380d96bf1c0c0163e5e971b9f83cfa9cc2f1187be085fee321a134b85f6`. Its [independent proof](../evidence/phase1/mappings/bounded-increase-v1-1b7a9380d96b.json) covers **51,880 cases**, including 51,744 exhaustive accepted-domain triples, plus 10 numeric and 11 structural negatives. Fifty cases whose original arithmetic leaves the intermediate integer contract are explicitly excluded. The migrated clamp rule passes 60,430 differential cases plus the same negative categories. The independent corpus predates discovery; candidate tests are supplemental.

The generic interpreter handles both families without rule-specific helper recognizers. The accepted bytes are pinned in the multi-rule registry and compile both unchanged new apps. A helper changed by `+1` fails `E_MAPPING`; a negative increment fails `E_MAPPING_PRECONDITION`. Overlapping valid rules with different lowerings fail explicitly. Later generic validator hardening refreshed proofs by reaccepting the same candidate bytes; the schema, corpus, fixtures and proposal were not changed to fit a candidate. Bounded corpus evidence and exact reachable application validation do not establish equivalence for arbitrary JavaScript.

## Native desktop evidence and open gates

[Native checks](../evidence/phase1/native-checks.json) separate internal events from OS input. Fifteen internal UiEvent actions pass Tab/Shift+Tab traversal, Enter/Space activation, disabled skipping and conditional mount/unmount. The adapter also implements repeat/cancellation guards, but the retained sequence does not verify every such path. Real X11 resize executes 800×600 → 420×600 → 800×600 after redraw, preserving identities and restored geometry.

Real CUA pointer input on the final X11 quantity binary changed 2 items to 3 and displayed 21 EUR. Its focused Add border visibly changed to the text color. A retained registered-click-to-presentation-return sample was **2,358.63 µs**, including a 249.224 µs dispatch/binding/layout update. This is one observation from the application event boundary through softbuffer return, not OS input latency, a compositor acknowledgement or a distribution.

CUA/KWin identified the pricing window as a genuine Wayland client. Real More and Change plan clicks produced `[2,"basic",false]` and `[2,"pro",false]`, with a 40 EUR monthly total. [OS observations](../evidence/phase1/probes/os-observations.json) and application logs retain those actions. Wayland mouse input passes.

**Full OS keyboard verification remains incomplete.** One native Tab is recorded; subsequent Return/Shift+Tab requests, including a final 45-second Return attempt on the focused rebuilt window, timed out without corresponding application key records. Internal key tests therefore cannot certify the full desktop route, and delivery timeouts do not establish a runtime activation defect. Wayland resizing also remains incomplete: its compositor ignored application-requested test sizes. No accessibility or full Wayland keyboard/resize claim is made. These open gates keep the overall driver result incomplete (exit 2).

## Measurements and deployment

[Measurements](../evidence/phase1/measurements.json) retain eight variants, alternating pair order, eight startup observations each and five runs per update endpoint, each with 20 warmups and 100 samples. The first observed startup is separate from seven warm observations; caches were not evicted. Startup runs on X11 at 800×600 with embedded fonts. Medians below use optimized / baseline binding modes.

| Application | Warm main → first present (ms) | Dispatch/layout (µs) | Dispatch → CPU framebuffer (µs) |
|---|---:|---:|---:|
| Quantity | 24.752 / 24.345 | 112.404 / 113.200 | 1,872.521 / 1,935.954 |
| Thermostat | 25.172 / 26.005 | 33.990 / 34.561 | 1,595.736 / 1,571.483 |
| Pricing | 24.655 / 24.966 | 58.324 / 38.140 | 1,864.137 / 1,790.909 |
| Settings wizard | 25.368 / 26.047 | 55.162 / 55.595 | 1,897.450 / 1,884.592 |

Plain update samples exclude paint. Framebuffer samples include CPU paint into a fresh reset renderer, excluding window/compositor presentation. Startup ends at softbuffer first-present return. Full samples show variance, including a slower pricing run; there is **no consistent binding time improvement**. CPU rendering dominates this measured update workload. Existing comparison modes remain available and no new default optimization was promoted.

A bounded [thin-LTO quantity experiment](../evidence/phase1/profile-experiment.json) reduced the executable from 15,029,200 to 13,243,328 bytes (11.88%), while preserving all 64 transitions and identical framebuffer bytes. Gzip size fell from 5,640,372 to 5,255,981 bytes. ELF section accounting identifies native code as the largest section (default .text 9.81 MB); this is not a function-level hotspot profile. The experiment retains eight interleaved startup samples, but does not establish a general startup speedup or justify changing all four apps' default profile. Default LTO remains off.

| Package | Executable bytes | Complete compressed distribution bytes | Full installed boundary bytes |
|---|---:|---:|---:|
| Quantity | 15,029,200 | 28,292,052 | 82,814,621 |
| Thermostat | 15,029,200 | 28,292,918 | 82,814,621 |
| Pricing | 15,033,296 | 28,294,006 | 82,818,717 |
| Settings wizard | 15,033,296 | 28,293,693 | 82,818,717 |

Each package includes the app/launcher/license/instructions and the complete selected 21-path Nix native closure, including libraries dynamically loaded by windowing/presentation. Installed dependency sizes use full NAR output sizes, including metadata/docs. Libraries shared between apps need only one installed copy; per-app figures count the whole boundary. The existing Linux kernel, Nix importer, POSIX shell, compositor/display server and display permissions are host prerequisites, excluded explicitly. The CPU renderer needs no GPU driver; no Node, browser or system-font directory is needed at runtime.

[Fresh installation](../evidence/phase1/fresh-install.json) passed for all four current binaries. Exported closures were imported into an empty root-backed Nix store, and archives unpacked into empty application directories. Bubblewrap exposed only that imported store, the app, proc/dev and existing X11 display/auth sockets with an empty environment and `PATH=/app`; an explicit POSIX-shell prerequisite closure was imported separately. All four windows reached first presentation and all four five-snapshot traces passed. The isolated store was removed afterward. This is a fresh installation on the same kernel/compositor, not another physical machine or a cold-cache OS experiment.

## Reproduction

Use the locked project shell or the reusable profile described in the README. Build the four defaults and the four baseline variants before running the complete driver:

```sh
for app in quantity thermostat pricing settings-wizard; do
  node compiler/cli.mjs build "fixtures/$app" --release
  node compiler/cli.mjs build "fixtures/$app" --release --no-opt \
    --out "artifacts/$app-no-opt-release"
done
node scripts/verify.mjs --serve --run-dir evidence/phase1/verification/local
```

The server exposes the original React references on ports 5180–5183. In T3, create a fresh background preview, calibrate the DOM checker at DPR 1, and visit each port at `/?runicCase=0` for both viewport sizes. Await completed case replay, font loading and two animation frames. Retain initial and selected-interaction browser captures; native `--headless` creates matching state frames. `scripts/visual-report.mjs <capture-directory>` compares the 16 pairs with the fixed threshold. Keep raw and corrected capture paths separately. Browser reports are stored by the comparison server; the driver does not automate or replace the product-native T3 adapter.

`node scripts/native-checks.mjs` asserts the retained internal event/resize probes and labels OS results separately. Repeat real desktop mouse/key observations through native CUA and retain delivered-event logs; a timed-out keyboard request does not close the gate. Package each app with `node scripts/package.mjs <app>`, then run `node scripts/fresh-install.mjs`. `node scripts/measure.mjs` produces the eight-variant paired measurements. The optional thin-LTO build uses `CARGO_PROFILE_RELEASE_LTO=thin` and a separate `artifacts/quantity-lto-thin` output before `node scripts/profile.mjs`.

Finally run the driver for the same directory, then `node scripts/manifest.mjs`. The driver rechecks source/IR, generated native inputs, image, binary and package hashes. Retained summary exit 2 is expected until the named desktop gates pass. A new run without its own browser reports is incomplete; old evidence cannot silently stand in for a changed source or binary.
