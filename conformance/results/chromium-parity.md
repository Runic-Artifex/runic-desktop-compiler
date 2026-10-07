# Targeted Chromium parity experiment — 2026-10-08

This is an isolated implementation record, not an integration milestone or a
claim of complete Chromium parity. The original repositories remain unchanged.
There is one experiment worktree per affected repository and one shared Cargo
target, `/home/viktor/Development/RunicDesktopCompiler/target`.

| Repository | Worktree / branch | Signed implementation revision |
|---|---|---|
| Compiler | `RunicDesktopCompiler-tables` / `blitz-tables` | `428b31c` |
| Blitz | `RunicArtifex/blitz-tables` / `table-layout` | `5464bd09` |
| Vello | `RunicArtifex/vello-raster-parity` / `runic-raster-parity` | `a8efce54` (earlier raster repair retained) |
| Stylo | `RunicArtifex/stylo-chromium-parity` / `runic-chromium-parity` | `715f4d98b` |

## Changes and ownership

- Blitz owns table intrinsic contributions and percentage over-constraints,
  caption height in flex/grid wrappers, sticky offsets, overflow clips, rounded
  hits, scroll ranges/IntoView, layout-time anchoring and editor scroll metrics.
  Painter, pointer traversal and CSSOM use the same sticky geometry. Transformed
  static boxes participate in the positioned stacking level.
- Standards tables inherit line-height; the HTML parser applies the legacy
  table reset only to full quirks documents. Fragment replacement preserves the
  containing document's policy and author rules override the UA reset. This
  follows Chromium's [standards UA table rules](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/resources/html.css)
  and [quirks table rules](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/html/resources/quirks.css).
  It is not a complete quirks-mode implementation.
- Native-control sizing uses primary-font average/max metrics; native checkables
  ignore authored padding/borders while `appearance:none` retains CSS geometry.
  Checkables export a border-box baseline; textarea exports its editor baseline.
  Checkbox/radio frames and authored control backgrounds remain separate paint
  paths. Rounded dotted-border phase improves, but raster failures remain.
- Stylo retains finished filled animations, cancels on `display:none`, and catches
  up multiple skipped iterations with alternate-direction parity. Its existing
  scroll margin/padding and anchoring properties are enabled.
- Runic delegates geometry/scrolling to Blitz and emits events for moved
  ancestors and offsets clamped by layout. Every timeline resolution observes
  layout-induced changes, including animation/focus paths. Blitz rounds explicit
  CSSOM requests while preserving fractional layout clamping and scrollports.
  All adapters accept experimental table
  structure; React maps `colSpan`/`rowSpan` at its adapter boundary. The shared IR
  and backend have no framework-specific table path or schema change.
- The reusable rendering oracle compares DOM rectangles, exact hit targets,
  scroll metrics and tight pixel regions after mutation, resize and timed states.
  Compiled fixtures exercise keyed rows, selection/editing, focus/Tab, bubbling,
  stopPropagation and dynamic colspan in React, Vue and Svelte. Explicit
  `scrollIntoView` actions exercise the same API on both sides before clicks.

## Verification

Gates remain
geometry **0.125 CSS px** and local pixel MAE **3/255**. No cases, blur steps,
tolerances or reference outputs were changed to obtain parity. Raw reports and
screenshots remain in the worktree's ignored `artifacts/` directory.

The direct CPU matrix uses Chromium 153.0.8010.12 and pinned DejaVu WOFF2
SHA-256 `a75044e4dab293c1ac7f8eba9f20df03f183f41b9319054f43b955959981632a`.
The glyph expansion covers 12/14/16/24 px, origins -0.125/0.375/0.875 and
DPR 1/1.25/2, plus Arabic at DPR 1/2. Other suites retain their specified
420/800 or original 640 px viewports. Each report records input/binary hashes,
dependency revisions and dirty-source hashes.

| Direct suite | States | Geometry passed | Hits passed | Scroll passed | Local pixels passed |
|---|---:|---:|---:|---:|---:|
| Original tables (55 cases) | 69 | 69 | 69 | 69 | 69 |
| Legacy glyph/border controls alongside tables | 8 | 8 | 8 | 8 | 5 |
| Standards/quirks inheritance and replacement (3 cases) | 12 | 12 | 12 | 12 | 12 |
| Scrolling/sticky (19 cases) | 148 | 148 | 148 | 148 | 148 |
| CSS animations (4 cases) | 40 | 40 | 40 | 40 | 40 |
| Native controls | 9 | 8 | 8 | 9 | 6 |
| Tables in flex/grid/scrollers/RTL with mutations | 30 | 22 | 24 | 30 | 23 |
| Pinned compiled-table reduction, quirks/standards | 4 | 2 | 2 | 4 | 0 |
| Expanded glyphs | 38 | 38 | 38 | 38 | 3 |
| Rounded dotted borders | 7 | 7 | 7 | 7 | 0 |

The three original failing crops remain fixed: baseline **0.950**, empty caption
**1.439**, and five-pixel collapsed dots **1.072** MAE. The extra rounded-dot crop
improves from 27.406 to **24.297**, still failing. Both fractional-origin glyph
controls still fail locally. The expanded matrices preserve those failures.

Control residuals include checked-radio local MAE **3.265**, scrolled textarea
**11.540**, and the unpinned UA-font packaging case. Table integration's failing
control states retain that font gap. The pinned reduction isolates a **0.5 px**
checkbox baseline difference in quirks mode; standards geometry passes. A
fractional rounded-button edge hit remains at 800 px in both modes, and local
pane paint fails at both widths. These are not hidden by whole-page averages.
Two scrolling states move the named target entirely outside the viewport: its
local crop has no visible area, while the viewport crop, geometry and hits are
still observed.

Compiled CPU tables pass semantics and geometry in **6 runs / 96 states**:
React, Vue and Svelte at 420 and 800 px. The standards inheritance fix removes
the three-pixel table-height difference. All six still fail local paint; initial
pane MAE is **4.318–4.488**, reaching **8.151** during the action sequence. The
static face advertised as a weight range retains a font registration/selection
gap; control/focus paint also remains part of this integration gate.

Selected Svelte GPU tables pass semantics and geometry in **2 runs / 32 states**
on Mesa 26.2.3 lavapipe, llvmpipe LLVM 21.1.8, Vulkan/Area antialiasing. Local
paint still fails: initial pane MAE **4.547–4.639**, maximum **8.313**. The first
GPU attempt lacked the experiment shell's ICD setting and was incomplete; its
logs remain separate. Repeating in the correct locked shell completed the stage
and exposed the retained pixel failures.

The initial broader CPU matrix had **34 runs / 436 states** and exposed eight
measure/scroll-event semantic regressions. Moving layout-change observation into
every timeline resolution fixed them; their focused replay passes all gates in
**8 runs / 92 states**. The scroll-lane replay also passes all gates. Combining
those replays with the final table runs gives semantics and geometry in all
34 runs, and all gates in the **28 non-table runs / 340 states**. This combines
recorded reports from the checks affected by each change; it is not a claim that
every run was repeated at the final revision. The
[machine-readable summary](chromium-parity-summary.json) records report hashes.

Compiler `npm test`: **297 passed**, including TypeScript checking.
Rust `node compiler/cargo.mjs test --offline --workspace`: **117 passed**.
Blitz HTML library: **1 passed**; paint library: **8 passed**. Blitz DOM library: **48 passed, 2 failed**;
the identical failures reproduce at pre-change Blitz `166f3a61` with the same
locked toolchain and Stylo patch (`hover_styles_apply_and_clear`,
`scroll_by_clamps_and_bubbles`). They remain failures rather than being skipped.
The two private Stylo iteration tests passed in the focused owner check.

The available tools do not expose the repository's `/code-review` command.
Manual diff review and a bounded read-only review covered the shared geometry,
guard boundaries and animation/scrolling oracle. That does not claim an
unavailable automated review stage passed.

## Release layout costs

[Full median/p95 and memory observations](chromium-parity-bench.json) compare
Blitz `166f3a61` with `5464bd09` in the **same** worktree, restoring `table-layout`
after the baseline measurement. Other dependency revisions and benchmark code
are unchanged. Each run has 3 warmups and 15 samples; initial includes parsing,
embedded-font ingestion and four resolves. Mutations use one resolve. No raster
or framework work is timed.

| Rows | Operation | Baseline median ms | Current repeat median ms |
|---|---|---:|---:|
| 100 | Initial | 17.78 | 17.63 |
| 100 | Cell text update | 2.69 | 2.69 |
| 100 | Row insertion | 3.14 | 3.17 |
| 100 | Parent resize | 3.16 | 3.19 |
| 1,000 | Initial | 71.18 | 70.38 |
| 1,000 | Cell text update | 38.04 | 37.38 |
| 1,000 | Row insertion | 42.55 | 40.44 |
| 1,000 | Parent resize | 38.76 | 37.97 |

The first final-source observation had higher medians (100-row initial **22.43**
ms, 1,000-row initial **74.10** ms) and a 1,000-row initial p95 of **209.41** ms.
One serial repeat on the active desktop gave the table above and initial p95
**17.72 / 76.14** ms. Both observations and the intermediate runs are retained;
this does not establish the cause of the variation or controlled tail-latency
equivalence. Baseline high-water/RSS was 34,088 KiB; the repeat was 35,636/34,304
KiB. Large-data virtualization and frame-budget tests remain app-level work.

## Integration limits

The compiler experiment accepts tables through local path overrides. Shipping
table support still requires closing compiled paint and retained control/hit
gaps, replacing the paths with reproducible reviewed pins, replaying on the normal Runic bases,
and the applicable upstream/integration process. Sticky and forwards/both
collector/runtime restrictions remain on the normal compilation path pending
compiled/API integration gates; the direct engine probes exercise their repairs.

Missing system fonts remain P7. Remaining font-range/inline-metric, editor-wrap,
fractional hit and raster failures have explicit follow-ups in the
[targeted plan](../../docs/research/CHROMIUM-PARITY.md). Anchoring does not certify
persistent anchor state, event-loop suppression windows, subpixel anchor shifts,
negative RTL half-ties, smooth-scroll interactions or arbitrary reparenting;
vertical writing, transformed scrollports, fragmentation and scroll-snap are not
certified. Animation events/full Web Animations controls, WPT breadth, accessibility,
OS keyboard/IME and interpreter layout/DOM parity remain separate gates.
