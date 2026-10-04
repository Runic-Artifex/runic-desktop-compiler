# M6 research: the CPU renderer against the GPU renderer and Chromium

Where does the CPU renderer (D12: pixel conformance is pinned to it) draw what Blitz emits differently from the GPU renderer and from Chromium, and what does it take to close the gaps, starting with CSS filters? Done 2026-10-04 on branch `m6-cpu-renderer`.

**Versions.**
- Blitz fork `runic` at `2054ea1`; blitz-paint emits anyrender `PaintScene` commands.
- CPU: `anyrender_vello_cpu` 0.18.0 → `vello_cpu` 0.3.0, `vello_common` 0.3.0, `glifo` 0.4.0.
- GPU: `anyrender_vello` 0.15.0 → `vello` 0.11.0 (classic Vello on wgpu).
- Reference: the conformance Chromium 153.0.8010.12.

The published crates equal their repository sources: `anyrender` 0.14, `anyrender_vello_cpu` 0.18, `anyrender_vello` 0.15, `softbuffer_window_renderer`, `anyrender_svg` and `wgpu_context` at DioxusLabs/anyrender `cf0f147` ("Release AnyRender 0.14"), and `vello_cpu`, `vello_common`, `glifo` and `vello` 0.11 at linebender/vello `f3000c8d` (`sparse-strips-v0.3.0`, `v0.11.0`), checked by diffing `~/.cargo/registry` against `git archive` of those commits. `f3000c8d` is also vello's `main`: nothing newer is merged.

## Summary

- **Filters now work in the CPU renderer.** Every CSS filter function, `drop-shadow()`, filter lists and `backdrop-filter` are drawn, through two local forks ([below](#the-forks)). The conformance cases `filters` and `backdrop-filters` pass the pixel gate (largest region error 1.6/255, a 5 px blur); without the forks every filtered region fails (17–52/255), and with the published crates' `filters` feature the probe panics on the first colour matrix.
- **Chromium applies CSS filter functions in sRGB**, on unpremultiplied colours, clamping after each function, and keeps the intermediate results of a list in float. `drop-shadow(x y r)` and `blur(r)` use `r` as the standard deviation. All measured, below.
- **The GPU renderer draws no filters at all**: `anyrender_vello` 0.15 drops both `filter` and `backdrop_filter` (`scene.rs:69-80`). GPU builds keep semantic conformance only (D12), so this is recorded, not fixed.
- **Blitz itself puts part of a filtered element outside its filter**: outlines and outer box shadows are painted before the filter layer, the layer is clipped to the border box plus the filter's reach, and a backdrop is clipped to the border box's bounding rectangle. These cases stop a probe (`E_FILTER`) instead of drawing differently; a Blitz patch is prepared ([below](#blitz)).
- **Other CPU/GPU/Chromium differences** that matter for pixel parity are anti-aliasing (the GPU window renderer uses MSAA16), gradient colour spaces and ramp resolution (GPU), image edge handling (Blitz uses `Repeat`), box-shadow blur, glyph coverage, and bitmap emoji. They are listed [below](#other-differences); none was changed here.

## Method

- **Sources.** Published crate sources from `~/.cargo/registry`, the upstream clones, and blitz-paint at `2054ea1` (`git show`). Every PaintScene command blitz-paint emits was traced through both backends.
- **Chromium.** Scratch pages in the conformance Chromium, sampling pixels of a 100×100 `rgb(200, 100, 50)` box on white: each filter function, lists in both orders, `drop-shadow` against `box-shadow`, and backdrops under ancestors with effects.
- **Upstream.** `gh pr list` (read only) on linebender/vello and DioxusLabs/anyrender, and anyrender's `main` after the 0.14 release.
- **Conformance.** New cases `filters` and `backdrop-filters` (`--pixels`, every filtered box a pixel region), run with the forks, without them, and with the published crates' `filters` feature.

## Filters

### What Chromium does

| Input | Chromium | Conclusion |
|---|---|---|
| `brightness(0.5)` | (100, 50, 25) | sRGB: in linear light it would be (146, …) |
| `grayscale(1)` | (118, 118, 118) | 0.2126·200 + 0.7152·100 + 0.0722·50 = 117.6, the spec's sRGB matrix |
| `grayscale(2)` | (118, 118, 118) | amounts clamp to 1 (Stylo clamps at parse time too) |
| `saturate(.5)`, `hue-rotate(90deg)`, `sepia(1)`, `contrast(.5)`, `invert(1)`, `opacity(.5)` | (159, 109, 84), (50, 146, 35), (165, 147, 114), (164, 114, 89), (55, 155, 205), (228, 178, 152) on white | the Filter Effects matrices, in sRGB |
| `brightness(.5) contrast(2)` / `contrast(2) brightness(.5)` | (73, 0, 0) / (128, 36, 0) | functions apply in order and clamp after each; 36 (not 37) shows that intermediate results are not rounded to 8 bits |
| `drop-shadow(10px 0 4px blue)` | edge profile equal to `box-shadow: 10px 0 8px blue` | the blur length is the standard deviation (σ = 4; a box-shadow blur is 2σ) |
| `blur(4px)` | — | σ = 4 (the spec; matches the vello_cpu output in the case) |
| backdrop under an ancestor with `opacity: .99` or `filter: brightness(1)` | unblurred | the ancestor is a Backdrop Root: the backdrop holds only what it painted |
| element with `opacity` and `backdrop-filter` | the filtered backdrop is composited with the opacity, then the element over it | not one isolated group |

### What each renderer did

| Feature | blitz-paint emits | CPU before (published) | CPU now (forks) | GPU |
|---|---|---|---|---|
| `brightness`, `contrast`, `grayscale`, `hue-rotate`, `invert`, `opacity`, `saturate`, `sepia` | `FilterEffect::ColorMatrix` (anyrender 0.14 lowers all eight to spec matrices) | feature off: nothing; feature on: `unimplemented!` in `vello_common/src/filter/mod.rs:102` | drawn: vello PR #1765's `ColorMatrix` primitive on straight colours, clamped | dropped |
| `blur()` | `GaussianBlur { σ = r }` | first function only | drawn | dropped |
| `drop-shadow()` | `DropShadow { σ = r }`; colour resolved with black for `currentColor` (`filters.rs` TODO) | first function only | drawn | dropped |
| lists | `Filter::linear_list` | first node only (`anyrender_vello_cpu/src/filters.rs:15`); vello panics on graphs with more nodes | every node, in order; consecutive matrices in one float pass | dropped |
| list reach | union of the primitives' expansions | — | sum along the chain (anyrender and vello), so Blitz's layer clip and vello's layer size hold the whole result | — |
| `backdrop-filter` | `push_layer(…, backdrop_filter)` | ignored (`_backdrop_filter`) | drawn ([below](#backdrop-filter)) | dropped |
| `url()` references | dropped by Blitz (and Stylo's servo mode does not parse them) | — | — | — |
| `multithreading` feature | — | filters dropped (vello_cpu's multi-threaded dispatcher panics on them) | unchanged; Runic does not enable it | — |

### Backdrop filter

vello_cpu renders a scene from recorded strips at the end, so a layer cannot read what is below it at push time. With the new `backdrop_filters` feature, `VelloCpuScenePainter` records the frame's commands (anyrender's recording `Scene`). A layer with a backdrop filter replays them into a second painter, closes the open layers and renders that: everything painted behind the layer. The image is filtered in a vello filter layer, sampled with `Extend::Reflect` beyond the viewport (Chromium's result at the viewport edges matched), clipped by the layer's clip and composited with the layer's opacity; then the layer is pushed as usual. Cost: one extra render of the scene so far per backdrop-filtered element per frame, plus recording every command while the feature is on.

Differences that remain, each reported by `E_FILTER`:
- the backdrop is everything painted behind the element; Chromium stops at the nearest Backdrop Root ancestor (opacity, filter, clip-path, mask, mix-blend-mode, backdrop-filter);
- Blitz passes the border box's bounding rectangle as the layer clip, so rounded corners do not clip the backdrop;
- with both `filter` and `backdrop-filter`, Blitz's clip includes the filter's reach.

### Blitz

blitz-paint (`render.rs:447-498`) draws the outline and outer box shadows before the clip-path and filter layers, and clips the opacity/filter layer to the border box's bounding rectangle grown by the filter's expansion. In Chromium a filter applies to the element's whole rendering, overflow included. The runtime reports these cases (`crates/runic-runtime/src/effects.rs`): an element with `filter` or `backdrop-filter` and an outer box shadow, an outline, content overflowing its border box, or the backdrop cases above stops a probe with `E_FILTER` and is reported once by an app. Each check was triggered by a scratch fixture (not committed).

A patch for the fork is prepared at `.cache/blitz-filters.patch` (in the worktree; not applied to the fork; `runic-runtime` type-checks against `2054ea1` with it, but no case ran with it). It:
- resolves a `drop-shadow()` without a colour with the element's `color`;
- clips a backdrop-filtered layer (without `filter`) to the border-box path, so that rounded corners clip the backdrop.

Still to write: painting the outline and outer shadows inside the filter layer when there is a filter, with the layer clip grown by their extent.

Until then the compiler rejects `drop-shadow()` that may resolve to `currentColor` (no colour, or `currentColor` reachable through `var()`), and the runtime checks above stay.

### The forks

Local clones, branch `runic`, unsigned commits, not pushed. The compiler workspace pins them with `[patch.crates-io]` git entries (`file://` URLs and revisions, like the Blitz fork). Every crate of each repository that is in the graph is patched (`vello_cpu`, `vello_common`, `glifo`; `anyrender`, `anyrender_vello_cpu`, `anyrender_vello`, `anyrender_svg`, `softbuffer_window_renderer`, `wgpu_context`), so crates.io and git copies never mix. Generated apps are workspaces of their own: codegen copies the section into their manifests.

| Repository | Base | Commits |
|---|---|---|
| `/home/viktor/Development/RunicArtifex/vello` | `f3000c8d` (vello_cpu/vello_common/glifo 0.3.0/0.3.0/0.4.0) | `17874e71` *sparse_strips: Add `ColorMatrix` filter* (upstream PR #1765 by Adrian Eddy, cherry-picked; one import conflict in a test resolved); `03638425` *Apply multi-primitive filter graphs as linear chains* (sequential execution, summed expansions, non-panicking `PreparedFilter::from_primitive`/`chain`); `8c7a8b6e` *Apply consecutive colour matrices of a filter chain in one pass* |
| `/home/viktor/Development/RunicArtifex/anyrender` | `cf0f147` (0.14 release) | `e106fc6` build against the local vello fork (a `[patch]` its consumers ignore); `4f83dbd` *anyrender: Add up the expansions of chained filter primitives*; `a76d1ba` *anyrender_vello_cpu: Draw every function of a filter list*; `d585cd1` *anyrender_vello_cpu: Draw backdrop filters* (`backdrop_filters` feature) |

Unit tests: vello_cpu filter chains (order, chained offsets, an unsupported primitive leaves the layer unfiltered); anyrender expansions; anyrender_vello_cpu against Chromium's values for every colour function, lists in both orders, drop shadows, and backdrops (nested in open layers, blur reach, opacity).

**Upstream.** vello PR #1765 (open) adds `ColorMatrix`; #1623/#1624/#1625 are its predecessors (#1624 lowers `FilterFunction` variants to matrices). No open vello PR runs multi-primitive graphs or backdrops; #784 (render graph for filters) targets classic Vello and is stale. anyrender has no open PR for CPU filter lists or backdrops (#95 "Pass Backdrop into render*" is about preserving the render target). The fork commits are written to be offered upstream: the chain semantics and expansions to vello; the list conversion, expansions and backdrop recording to anyrender.

## Other differences

Traced from the sources for what blitz-paint emits; Chromium columns are from the specs and general knowledge unless a case measured them. Paths are relative to each crate.

| Capability | CPU | GPU | Chromium | Evidence |
|---|---|---|---|---|
| Pixel pipeline | u8 only (`u8_pipeline`), single-threaded | f32 per pixel, layers saved as 8-bit | Skia, blending in sRGB | anyrender `Cargo.toml` vello_cpu features; vello_shaders `fine.wgsl:1120-1135` |
| Anti-aliasing | analytic coverage (sparse strips) | the window renderer uses `AaConfig::Msaa16`; the image renderer area coverage | Skia analytic | anyrender_vello `window_renderer.rs:85-95,174-175`. Edge differences are a recorded gap ([BLITZ-GAPS](../BLITZ-GAPS.md), shape anti-aliasing) |
| Clip layers | always isolated buffers in 0.18 (anyrender `main` adds rect fast paths, #114/#115) | edge tiles only; blends nested in clip layers are wrong (vello #1198) | non-isolated | vello_cpu `coarse/bucketer.rs`; vello `scene.rs:170-186` |
| Compose modes (CSS masks, inset shadows) | all implemented | all implemented | native | vello_cpu `fine/lowp/compose.rs` |
| Mix modes (inline SVG only; Blitz emits none for CSS) | all, some through f32 | all, subject to #1198 | all | vello_cpu `fine/lowp/blend.rs:54-78` |
| Gradient colour space | peniko's interpolation space and hue direction honoured, but Blitz drops `color_interpolation_method` and always sends sRGB | interpolation space and hue direction ignored | legacy colours in sRGB; others in oklab by default | blitz-paint `gradient.rs:56-86`; vello_encoding `ramp_cache.rs:119-155` |
| Gradient ramp | adaptive 256–4096 entries | fixed 512 samples (hard stops smeared) | per pixel | vello_common `encode.rs:1131-1160`; vello_encoding `ramp_cache.rs:12` |
| Image sampling | Medium = bilinear, downgraded to nearest for integer translations; High = bicubic (Blitz never asks for High) | all in the shader | bilinear, edges clamped | vello_common `encode.rs:495-518` |
| Image edges | Blitz samples with `Extend::Repeat`: scaled images bleed the opposite edge, on both renderers | same | clamp | blitz-paint `render.rs:653-656` |
| Image limits | over 65535 px per side: assertion panic | over 8192 px: not drawn | — | anyrender_vello_cpu `image_convert.rs:16-20`; vello_encoding `image_cache.rs:9-10` |
| Box shadows | blurred rounded rect (erf approximation, cut at 2.5σ) | same algorithm | Gaussian with σ = blur / 2, per-corner radii | blitz-paint passes the CSS blur as σ and averages the radii (`box_shadow.rs:62,78`); anyrender PR #117 changes the API to CSS terms. Not measured by a case |
| `Paint::Resource`/`Custom` | transparent | resolved for fills | — | not emitted by blitz-paint for CSS |
| Glyph hinting | skrifa autohint fallback, `Smooth{Lcd}`, baseline rounded | identical options | FreeType slight hinting (fontconfig `hintslight` on this machine), Skia mask gamma | glifo `glyph.rs:1287-1289`; vello `glyph_cache.rs:342-349`. Text weight is the largest text difference; vello PR #1790 adds a Skia-like coverage contrast |
| Subpixel positions | exact (glyph atlas off; anyrender `main` #116 adds an opt-in cache with 4 buckets) | exact | fractional advances in full Chromium | vello_cpu `render.rs:477-492` |
| Bitmap emoji | PNG strikes only with glifo's `png` feature (not enabled by anyrender_vello_cpu); otherwise not drawn | BGRA, PNG and mask strikes | drawn | glifo; vello `scene.rs:703-790`. Apps embed their own fonts, so this matters only for embedded colour fonts |

**Panics reachable from Blitz commands**, besides the filter ones fixed here: an image over 65535 px (CPU), a font without a `head` table (glifo `glyph.rs:1734-1738`), a malformed PNG emoji frame (GPU, vello `scene.rs:747`). anyrender PR #32 makes the traits fallible.

## Verification

- `filters` (fixture `filters-svelte`, 800×600 and 420×600, 4 steps): each function, a nested filtered element, hard and soft drop shadows, two lists, a filter under opacity, and a filter transition sampled mid-way. Region errors 0.04–1.59/255 (blur 1.59, the list with blur and drop shadow 0.75); whole viewport 0.17.
- `backdrop-filters` (fixture `backdrop-svelte`, 800×600, 2 steps): a translucent blurred panel, a list, a backdrop under the element's opacity, and a full-viewport dialog overlay. Region errors up to 1.14/255; whole viewport 0.08 and 0.43.
- Without the forks (published crates, no `filters` feature) both cases fail the pixel gate in every step: regions 3.2–52.3/255. With the published `filters` feature the `filters` probe panics (`not implemented: Other filter primitives not yet implemented`). The compiler at `1c0a2fd` rejects both fixtures (`E_CSS_PROPERTY`).
- With the forks: `filters`, `backdrop-filters`, `tailwind`, `animations`, `icons`, `packs` and `blitz-has` pass all gates with `--pixels` (25 runs); `npm test` (175 tests) and `cargo test --offline --workspace` pass.

## Not verified

- Chromium's edge mode for backdrop blurs at the viewport edges beyond what the overlay case shows (its stripes are uniform at the edges, so mirroring and clamping give the same pixels).
- Filters on transformed (rotated, scaled) elements: vello scales filter parameters by the layer transform; no case covers it.
- The prepared Blitz patch: it type-checks, but no case ran with it.
- Performance of backdrop filters (one extra scene render each) and of recording every frame's commands.
- Everything in the GPU column: GPU builds were not run.

## Scratch files

Chromium sampling scripts, the scratch `E_FILTER` fixture, test scripts and unpatched runs lived under the worktree's `.cache/` and were removed; the Blitz patch stays there until it is applied to the fork.
