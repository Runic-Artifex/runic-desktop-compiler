# Implementation and evidence — 2026-10-02

The prototype compiles ordinary React source to a validated finite-state IR and generated Rust using Blitz. Both fixtures run as real native windows, with embedded CSS/font and no JavaScript engine. The supported semantics and rejection boundaries are specified in [CONTRACT.md](CONTRACT.md).

## Checkpoints and remaining gaps

| Gate | Evidence and result |
|---|---|
| A: environment, native compilation and input | Completed for the Linux/X11 route. A minimal Blitz probe responded to real mouse input before compiler construction. Both compiled fixtures respond to real native mouse input; the final quantity distribution ran outside the development shell. |
| B: state semantics and optimization | 12 focused test groups pass, 106 exhaustive reachable Rust transitions match the IR, and 212 browser/native state/event comparisons pass text, classes, disabled state and geometry at two sizes. Optimization preserves conditional DOM identity and pixel output. One initial-state pixel comparison exceeds the fixed tolerance, so the strict visual gate remains incomplete. Keyboard automation timed out and keyboard compatibility is unverified. |
| C: dictionary growth | Rejection, explicit discovery interface, independent validation, pinned acceptance and unchanged held-out reuse demonstrated with a **compiler-owned replay fixture**. No available authorized live model interface was found. Live LLM discovery remains unvalidated. |

The code and evidence do not establish arbitrary React/JavaScript equivalence, a globally minimal implementation, or complete Blitz CSS compatibility. Startup measurement reaches the renderer's presentation return, not a compositor display acknowledgment.

## Pinned implementation

The environment is pinned through `flake.lock` to nixpkgs `b6c8664de9b6cc07fe5666a29f91884ba81197c4`. Measurements used Rust 1.98.1, Cargo 1.98.0, Node 24.21.0, Linux 7.2.8, and an Intel Core i9-12900K. JavaScript dependencies are exact versions in `package.json` and `package-lock.json`: React/react-dom 19.3.0, Vite 8.3.2, TypeScript 5.9.3, PostCSS 8.5.6, postcss-value-parser 4.2.0, parse5 8.0.1 and entities 8.1.0.

Blitz is pinned to [`89e5e615aea649a1a9630c526956aa3d90a3afa7`](https://github.com/DioxusLabs/blitz/tree/89e5e615aea649a1a9630c526956aa3d90a3afa7). Its DOM, HTML provider, window/event driver and data-URI font APIs were inspected and exercised in the probe. Default features are disabled; optional Boa scripting, networking, accessibility and system fonts are excluded. Painting uses anyrender_vello_cpu 0.17.0 and softbuffer; the selected path does not require a GPU driver. `Cargo.lock` pins transitive dependencies. The bundled DejaVu Sans WOFF2 has its license in [FONT-LICENSE.txt](FONT-LICENSE.txt).

Frontend design follows the [Vite plugin API](https://vite.dev/guide/api-plugin). The supported update contract follows React's [queued functional updates](https://react.dev/learn/queueing-a-series-of-state-updates) and [useState semantics](https://react.dev/reference/react/useState). Collection runs before JSX transformations; TypeScript resolved symbols recognize adapters and helper implementations. No fixture filename or helper spelling grants applicability.

The release configuration is `opt-level="s"`, one codegen unit, stripped symbols and `panic="abort"`; LTO is not enabled. [measurements.json](../evidence/measurements.json) retains samples, binary hashes, application/IR hashes and generator/runtime/lockfile hashes. [source-manifest.json](../evidence/source-manifest.json) records final implementation inputs.

## Native input and deployment verification

[native-probe.log](../evidence/native-probe.log) records the initial window receiving a real click and incrementing its visible counter. Native windows were inspected and clicked through the desktop computer-use connection. Wayland screenshot capture failed at the portal on this machine, so explicit X11 windows on XWayland were used. Rendering remains live CSS layout; compiler output contains no precomputed window coordinates.

The quantity app was clicked through ordered `Add two` updates (2→4→6→8), details mount/unmount, repeated removal to 1, and attempted clicks on disabled boundary controls. Its final trace contains 12 dispatched events; disabled attempts produce no dispatch. The final adapter supplies button focus explicitly because Blitz's ordinary button default click cleared it. Focus is recorded on enabled clicks and removed when the clicked control becomes disabled. See [quantity-native-input.json](../evidence/quantity-native-input.json) and its [log](../evidence/quantity-native-input.log). The thermostat was clicked from 20 to its 16 boundary, eco off, repeatedly to its 28 boundary, and eco on; disabled boundary attempts left state unchanged. See [thermostat-native-input.json](../evidence/thermostat-native-input.json) and [log](../evidence/thermostat-native-input.log). The thermostat trace predates the final focus adapter; it establishes mouse delivery/state, not focus behavior.

Tab/Return automation timed out twice. Internal handler tests are not used as evidence for keyboard input or focus navigation. Accessibility is outside this version's contract.

The packaged quantity launcher was run with `LD_LIBRARY_PATH`, `IN_NIX_SHELL` and `LOCALE_ARCHIVE` removed from the parent environment. The launcher restores its declared library paths and uses the C locale. [native-loaded-files.json](../evidence/native-loaded-files.json) records the running process's mappings: no loaded file falls outside the declared Nix closure, aside from the executable and runtime shared-memory buffer. The [normal Cargo dependency tree](../evidence/native-dependency-tree.txt) contains no selected JS/browser engine. Build-time Node/React/Vite and reference servers are not required by the native process.

## Semantic and visual comparison

[semantic-tests.txt](../evidence/semantic-tests.txt) covers update ordering, captured render snapshots across slots, bounded state closure, disabled controls, negative source constructs, hook restrictions, resolved helper identities, malformed IR, JSX entities/Unicode, CSS/HTML rejection, deterministic generation and provider provenance. [backend-tests.json](../evidence/backend-tests.json) compares all 64 quantity transitions across 16 reachable states and all 42 thermostat transitions across 14 states with the compiled Rust transitions. These counts include no-op disabled transitions. Baseline and optimized bindings preserve the identity of an unchanged mounted conditional subtree and produce identical framebuffers for the verification sequence.

The browser comparison runs the original React source through Vite. Each case reloads initial state, replays a BFS path to a reachable state, dispatches the selected actual DOM button click, waits two animation frames, and compares visible text, class and disabled attributes plus rectangles to the same native sequence. All 64 quantity and 42 thermostat cases pass at each viewport (212 total). These automated comparisons validate browser/native behavior; desktop mouse testing separately validates native hit testing and delivery.

Geometry tolerance is 2 CSS pixels. Initial-state images use the same bundled font, scale 1, viewport and data. Pixel tolerance is a fixed mean absolute channel error of 3/255, computed with ImageMagick; it was not enlarged after observing the discrepancy.

| Fixture/viewport | Cases | Maximum geometry difference | Pixel MAE, 8-bit units | Pixel gate |
|---|---:|---:|---:|---|
| Quantity 420×600 | 64 | 1.0625 px | 2.845341 | Pass |
| Quantity 800×600 | 64 | 1.0625 px | 1.849699 | Pass |
| Thermostat 420×600 | 42 | 0.984375 px | **3.255891** | **Fail** |
| Thermostat 800×600 | 42 | 0.984375 px | 2.099683 | Pass |

[visual-comparison.json](../evidence/visual-comparison.json) links the retained browser/native PNG pairs. Browser screenshots came from T3's collaborative preview. Native comparison PNGs came from the CPU renderer framebuffer, **not OS window captures**. The real native windows were also visually inspected during mouse testing. Differences appear around text and rounded edges; the root cause of the failing pixel result was not isolated. References were preserved. `scripts/visual-report.mjs` deliberately exits unsuccessfully while this gate fails.

Detailed event reports: [quantity 420](../evidence/quantity-browser/report-420x600.json), [quantity 800](../evidence/quantity-browser/report-800x600.json), [thermostat 420](../evidence/thermostat-browser/report-420x600.json), [thermostat 800](../evidence/thermostat-browser/report-800x600.json). Pixel coverage is the initial state at each size; geometry and semantic coverage spans all listed events.

## Discovery experiment

With the registry disabled, quantity is rejected with source-located `E_MAPPING`; see [pre-mapping.json](../evidence/pre-mapping.json). The explicit discovery operation collects the helper implementation, relevant resolved dependencies, partial IR context, diagnostic and mapping schema into a bounded bundle. The [bundle](../evidence/discovery/bundle.json) contains no thermostat source. The [candidate](../evidence/discovery/candidate.json) is inert JSON supplied by `--replay`, not executable compiler code or a claimed live model response. [provenance.json](../evidence/discovery/provenance.json) records replay/provider identity, input/prompt hashes and candidate hash.

Independent validation uses a compiler-owned JavaScript oracle and corpus: 60,025 exhaustive ordered-bound triples over −16…32, 405 larger boundary triples, seven numeric negatives and eleven structural cases. A deliberately incorrect lowering is rejected by tests. See [mapping-validation.json](../evidence/mapping-validation.json). This is differential evidence for the restricted matcher, not a proof for arbitrary JavaScript. Whole-application reachable-state validation additionally enforces exact numeric domains.

Acceptance reruns validation and pins candidate bytes with SHA-256 `2367e77fd665122f94a327ac38d522e8ae7b4e7238ae152b90454169da879710` in `mappings/registry.lock.json`. The independently structured thermostat resolves the same helper pattern under a different name, constants and composition and compiles using that unchanged rule, with no further discovery call. Reversed bounds fail with source-located `E_MAPPING_PRECONDITION`; see [incompatible.json](../evidence/incompatible.json). The rule adds input support; it is not demonstrated as a size optimization.

The external provider command boundary was tested with a stub executable. It records wrapper identity and treats wrapper claims as separate provenance; arbitrary command execution does not certify a live model invocation. An authorized wrapper may receive JSON on stdin and produce a candidate on stdout via `--provider /absolute/executable`. Credentials are not placed in the bundle or retained output.

## Measurements

Measurements used X11/XWayland, 800×600, scale 1, bundled font and the pinned release configuration. Each build has eight launches: first observed run reported separately, followed by seven warm runs. Page caches were not evicted; none is claimed as a cold launch. First-present timing starts at Rust `main` and ends at the first softbuffer render/present return. It excludes loader time and does not establish when the compositor displays the frame. Spawn-to-exit timing is an upper bound covering loader and scheduling; the process exits immediately after the first presentation call.

| Build | Executable bytes | gzip executable bytes | Warm main→present median (range), ms | Warm spawn→exit median, ms | Update median / mean, µs |
|---|---:|---:|---:|---:|---:|
| Quantity optimized | 15,004,624 | 5,631,341 | 25.033 (24.068–28.326) | 29.705 | 115.344 / 78.194 |
| Quantity baseline | 15,004,624 | 5,630,863 | 24.747 (24.141–27.812) | 30.245 | 115.800 / 79.332 |
| Thermostat optimized | 15,000,528 | 5,629,496 | 26.038 (24.596–27.073) | 31.869 | 34.328 / 52.301 |

First observed main→present times were 29.209, 23.496 and 30.537 ms respectively. Update measurements comprise five batches of 20 warmups and 100 samples (500 retained samples per build), using representative repeated interactions including conditional UI. They cover dispatch, binding evaluation/mutation and style/layout resolution; they exclude paint/presentation. They are headless measurements rather than native input latency. The sample mix explains why mean and median differ.

Dependency filtering is implemented and verified, but these fixtures show **no meaningful measured performance or size improvement**. Raw executable size is identical for quantity; optimized gzip is 478 bytes larger. Timing differences are small compared with run variability. There is no speedup claim or globally minimal output claim.

The complete quantity distribution is separately measured in [quantity-distribution.json](../evidence/quantity-distribution.json):

| Deployment item | Bytes |
|---|---:|
| Installed application, launcher and instructions | 15,006,741 |
| Full runtime closure, 21 Nix store paths (NAR metric) | 67,774,416 |
| Complete installed boundary | **82,781,157** (78.95 MiB) |
| Application tar.gz | 5,632,927 |
| Runtime closure.nar.gz | 22,647,646 |
| Complete compressed distribution | **28,280,573** (26.97 MiB) |

The closure includes linked and dynamically loaded X11/Wayland/keyboard libraries, transitive dependencies, and metadata/docs in their selected Nix outputs. It excludes the existing x86_64 Linux kernel, desktop compositor/X server, Nix installation and POSIX shell. CSS/font are in the executable. Only the quantity fixture has a complete exported distribution measurement; thermostat executable size is reported without pretending its full closure was separately measured.

## Reproduction

Run from the repository root. Start with `df -h . /tmp`, inspect `.envrc` and `flake.nix`, then load the locked environment. Reuse the development profile until its inputs change:

```sh
nix develop . --profile .cache/dev-profile -c true
nix develop .cache/dev-profile
npm ci
npm test
node compiler/cli.mjs build fixtures/quantity --release
node compiler/cli.mjs build fixtures/quantity --no-opt --release --out artifacts/quantity-no-opt-release
node compiler/cli.mjs build fixtures/thermostat --release
node scripts/verify.mjs
node scripts/measure.mjs
node scripts/package.mjs quantity
node scripts/manifest.mjs
```

The measurement command needs access to an existing X11 display. It replaces measurement evidence; retain the original if comparing different hardware/configurations. The generated Cargo projects share `target` and use `--locked`. The root Cargo package is only the probe/backend template; application compilation happens through the CLI.

Replay the mapping workflow (the first and last analyze commands are expected failures):

```sh
node compiler/cli.mjs analyze fixtures/quantity --no-mappings
node compiler/cli.mjs discover fixtures/quantity --replay --out artifacts/discovery
node compiler/cli.mjs validate artifacts/discovery/candidate.json
node compiler/cli.mjs accept artifacts/discovery/candidate.json
node compiler/cli.mjs build fixtures/thermostat --release
node compiler/cli.mjs analyze fixtures/incompatible
node compiler/cli.mjs analyze fixtures/unsupported-effect
```

Native input reproduction:

```sh
cargo run --locked --bin native-probe
RUNIC_TRACE=artifacts/quantity/native-input.json ./artifacts/quantity/runic-app --x11
RUNIC_TRACE=artifacts/thermostat/native-input.json ./artifacts/thermostat/runic-app --x11 --width 420 --height 600
# Outside the development shell, after packaging:
env -u LD_LIBRARY_PATH -u IN_NIX_SHELL -u LOCALE_ARCHIVE ./artifacts/distribution/quantity/launch --x11
```

Click the visible controls through their boundaries and toggle the conditional section. The trace logs committed state, visible element attributes/rectangles, focus and writes after each dispatched click. Disabled clicks should leave state/UI unchanged. The root probe embeds the quantity fixture's font, so run from the repository root.

For browser evidence, start two reference servers in separate terminals in the environment:

```sh
node compiler/cli.mjs compare fixtures/quantity --port 5173
node compiler/cli.mjs compare fixtures/thermostat --port 5174
```

Use T3 `preview_status`, then `preview_open` if needed. At a preview viewport of 420×600, navigate to `http://localhost:5173/?runicCase=0` and wait for `window.runicSuite.complete === true`; repeat at 800×600. Do the same for port 5174. Reports are saved as `evidence/<fixture>-browser/report-<width>x600.json`; inspect their `cases`, `semanticsPassed` and `geometryPassed` fields. Completion alone does not establish success. Actual DOM click sequences run in the browser; no global browser installation or standalone Playwright is required.

Capture browser initial-state PNGs at each viewport after navigating to `/` and waiting for the font to load (`document.fonts.ready`). Save as `evidence/<fixture>-browser-<width>x600.png`. Generate the corresponding native frames, repeating this example for both fixtures and widths:

```sh
./artifacts/quantity/runic-app --headless 420 600 evidence/quantity-native-420x600
node scripts/visual-report.mjs
```

The last command currently fails for the recorded thermostat 420×600 mismatch. Preserve that failure and its references when investigating it. Shut down task-owned reference servers/windows after comparison; preserve reusable `target`, npm and Nix caches.
