# Targeted Chromium parity work (2026-10-07)

Close rendering and behavior gaps that block the pinned shadcn sites and examples,
then the Translations Editor. This is a proposed implementation sequence within
M6–M8, not a new supported contract or a promise of whole-browser equivalence.
The [gap register](../GAPS.md) supplies the backlog; [BLITZ-GAPS](../BLITZ-GAPS.md)
supplies renderer details. Corpus counts should replace the current priority
judgments when the M6 scan is available.

The [table experiment](BLITZ-TABLES.md) is the first slice. Its three retained
failures are fixed locally without changing tolerances: baseline text, empty-table
caption text and 5px dotted borders. All 69 table states pass the direct CPU
oracle. Two added fractional-origin glyph controls still exceed the local pixel
gate; an ordinary rounded dotted-border control also fails paint and corner hits.
Keep those as separate renderer gaps; do not call the renderer complete or
enable compiler tables on this evidence alone. [Results](../../conformance/results/blitz-tables.md).

## Module boundaries

| Owner | Responsibilities | Boundary to preserve |
|---|---|---|
| Blitz DOM/layout | Table formatting, anonymous boxes, used geometry, overflow, visual offsets, inline fragments | HTML/CSS rules only; no shadcn, framework, editor or fixture names |
| Blitz paint | Borders, backgrounds, clips, control decorations; consume used geometry | No layout repair or coordinate changes invisible to hit testing and DOM reads |
| Glifo / Vello | Outline hinting, glyph cache placement, path coverage | Font/device/rendering policy; no table-specific text correction |
| Parley | Shaping, advances, line boxes, line breaking | Glyph raster policy stays in the renderer; Blitz consumes line metrics |
| Stylo | Cascade, computed properties, animation lifetime, selectors | No duplicate CSS parser or fixture-specific restyle sequence in the runtime |
| Runic runtime | DOM facade, events/default actions, scheduling, host integration | Reuse Blitz geometry and primitives; application sorting and selection stay application logic |
| Compiler/adapters | Validate the verified surface, lower syntax and attributes | Shared IR/backend never branches on framework names; framework/version knowledge stays in adapters/packs (D10) |

These patches need no new IR construct. Any future public interface or schema
change gets the architecture checkpoint required by WORKING.md. Keep renderer
selection independent (D12), Linux verification first (D15), and default builds
without a JS engine (D7).

## Ordered batches

| Batch | Gaps and app relevance | Owning modules | Completion evidence |
|---|---|---|---|
| 1. Practical tables | P1: documentation API tables, shadcn Table/data-table, editor rows | Blitz table layout/paint; runtime events; compiler validation | Responsive and interactive cases below, framework conformance, selected CPU/GPU checks, measured layout cost |
| 2. Scrolling and sticky | P4/P3: site header/sidebar/TOC, sticky table headers, nested panes, floating-ui clipping | Blitz used geometry/overflow/hit testing; runtime geometry facade | Same visual position for painting, hits and DOM reads through scroll, resize and mutation; accurate scroll extents |
| 3. Text and inline geometry | Glyph rasterisation, decoration offsets, fractional line boxes, inline boxes, flex `<br>` | Glifo/Vello, Parley, Blitz inline layout/paint | Local text regions across font/size/DPR/origin/cache modes; multiline inline DOM metrics and hits; retained failures closed |
| 4. Controls and icons | Checkbox box model, input auto-min sizing, inline baselines, focus ring, textarea overflow; rounded border paint/corner hits; SVG clip and aspect ratio | Blitz UA/layout/paint/events; runtime control defaults | Restore the documented fixture workarounds one at a time with before/after regressions; form and icon cases at 420/800px |
| 5. CSS behavior | P4: `:target`, scroll margins, Unicode capitalization, generated quotes; animation fill/cancellation/iterations | Stylo, Blitz text/generated boxes, runtime navigation/events | State traces and timed rendering after restyle, show/hide, retargeting and resize; actual source cases needing each property |

Images and fonts (P7), general DOM mutation (P3) and form default actions (P2)
remain explicit parallel milestone dependencies. A renderer patch does not close
those compiler/runtime gaps. Accessibility and real desktop input remain separate
shipping gates. Defer printing/pagination, vertical writing, media and unrelated
web APIs until the corpus or editor demonstrates a need.

## Batch 1: table integration gate

Extend the existing pure HTML oracle before removing the rejection:

1. Put auto/fixed tables in flex/grid parents at 420 and 800px, with a horizontal
   scroller and a nested scroll pane. Include long translated headers, RTL labels,
   wrapping and ellipsis; resize the parent and mutate column contents.
2. Add buttons, checkboxes and text inputs inside cells. Check the exact event
   target and row bubbling, stop-propagation, focus, Tab/Shift-Tab and scrolling to
   the focused control. Internal probe hits certify hit geometry only; use the
   project's event harness for dispatch and the desktop track for OS delivery.
3. Exercise row insertion/removal/reordering, colspan/rowspan updates and caption
   changes under those parents. Add percentage/calc constraints and positioned
   captions/internal containing blocks when found in the driving sources.
4. Reduce relevant tests from [CSS tables WPT](https://wpt.live/css/css-tables/):
   anonymous table fix-up, height distribution, caption positioning, cell overflow
   and collapsed-border paint ordering. Preserve attribution and compare with the
   pinned Chromium. Keep unimplemented `empty-cells`, `visibility: collapse`,
   row/group effects and image backgrounds explicit until exercised and fixed.
5. Add compiled Table/API-table fixtures, starting with Svelte and then React/Vue.
   Verify DOM attributes (`colspan`, `rowspan`, `scope`, etc.), dynamic state and
   events through shared IR/runtime. Sorting, selection and data-grid navigation
   come from the application/library, not a new Blitz data-grid widget.
6. Measure release builds with 100 and 1,000 rows: initial layout, a cell-text
   update, row insertion and parent resize; record median/p95 and memory against
   the same toolchain/source baseline. Current alignment/baseline work performs
   extra cell layout passes. Optimize only measured costs and rerun the oracle.

Before integration, offer the owner-specific patches upstream (D11), replay them
on the current Runic pins, replace local absolute path patches with reproducible
pins, and run affected framework conformance on CPU and selected lavapipe GPU
cases. The CPU Glifo result does not certify the research Vello GPU text path.
Only then update the contract and remove verified element/attribute rejections.
The interpreter currently lacks layout/style/mutable DOM: differential checks
cover its modeled value/event behavior and must report the remaining stage as
incomplete.

## Batch 2: shared scroll coordinates

Implement sticky constraints from the nearest scroll container and containing
block, with one shared representation of visual offsets consumed by paint, hit
testing and DOM geometry. A paint-only offset would leave floating-ui, pointer
targets and `getBoundingClientRect()` inconsistent. Preserve normal-flow sizing.
Cover top/bottom and left/right constraints, RTL, nested scrollers, containing
block limits, clips, resize and dynamic row heights. Add absolute descendants to
scrollable overflow and check `scrollWidth`/`scrollHeight`, including negative
overflow. Then verify `scrollIntoView`, focus scrolling, fragment navigation and
scroll margins on the same coordinates. Start with the site's header/TOC and a
sticky table header as the two driving fixtures.

## Batch 3: renderer and text closure

Keep the two fractional-origin controls in the default oracle. The current Linux
TrueType experiment uses light auto hinting, matching the policy in
[Skia's Fontations hinting code](https://github.com/google/skia/blob/main/src/ports/fontations/src/hinting.rs),
and rounds hinted device origins to quarter pixels with a matching atlas carry.
It preserves linear layout advances. Other outline formats retain their previous
hinting policy; unhinted/rotated outlines retain their transforms. Those boundaries
need broader coverage before adopting this default across platforms.

Next isolate outline differences from coverage differences using font hashes,
baseline/advance observations and tight glyph crops. Cover DejaVu plus the pinned
site font, 12/14/16/24px, positive/negative fractional origins, DPR 1/1.25/2,
transforms and cache on/off. Add CFF/variable fonts before altering their policy.
Include representative Latin, Arabic and CJK editor labels with pinned fonts that
contain those glyphs: mixed-direction labels, fallback selection, wrapping and
cursor/hit geometry need their own evidence. Missing font coverage belongs to P7
and must not be mistaken for an anti-aliasing defect.
Compare multiple glyphs rather than fitting constants to one word. Fix coverage
in Vello or hinting in Glifo; never recolor, widen or shift a particular caption
or label to pass a region. Separately fix fractional line heights in Parley,
inline fragment rectangles in Blitz, and text decoration offsets in paint.

## Evidence and gap closure

Each task records a stable gap ID, a real source occurrence, owning module,
supported input domain, minimal initial/mutated HTML cases and the failing baseline.
Keep cases independent of framework syntax, with thin framework fixtures that
exercise lowering and runtime behavior. Extract reusable observation code from
the table oracle when the second layout family needs it, rather than growing a
table-specific driver for every feature.

Record Chromium version, viewport/DPR, font hash, renderer/adapter, source/pin and
native binary hashes. The table oracle now records environment hashes and each
input hash. Compare geometry, local pixels and event traces independently; keep
the existing 1/8px and 3/255 gates. No stage is passed by a missing tool, a known
gap annotation or a largely white whole-page screenshot. Failures stay runnable.

Use distinct status: **reproduced**, **fixed in isolated worktree**, **integrated
and verified**, **upstreamed**. Remove a compiler gap only after integration and
the applicable contract/conformance update. Keep one patch per owning layer and
linked regression evidence; re-evaluate the patch when its dependency pin moves.
Use the shared Cargo target/PID lock, focused checks while iterating, and the
required compiler/workspace checks once ready. This keeps the gap-closing effort
bounded and the modularity reviewable.
