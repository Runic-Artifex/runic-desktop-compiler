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

### Isolated implementation checkpoint (2026-10-08)

The experiment now implements the shared scrolling layer in Blitz, responsive
table integration, native-control sizing/baselines/paint, and the Stylo animation
fill/cancellation/late-iteration repairs. The shared HTML oracle has been extracted
from `tables.mjs`; scrolling, controls, borders, glyphs and animation cases use it
without framework-specific layout logic. React, Vue and Svelte table fixtures
exercise the same runtime and IR. There is no schema change.

The table UA now distinguishes inherited standards-mode line-height from the
legacy quirks reset. Compiled tables pass semantics and geometry across 96 CPU
states in all three frameworks, and 32 selected Svelte GPU states. Their local
paint gate now passes after the focus and selection repair. The original 69 table
states, 12 document-mode states, 148 scrolling states and 40 animation states pass
their direct geometry/hit/scroll/pixel gates.

One isolated worktree is used per changed repository: compiler `blitz-tables`,
Blitz `table-layout`, Vello `runic-raster-parity`, Stylo
`runic-chromium-parity`, and Parley/Fontique `runic-chromium-parity`. Originals
remain unchanged. The compiler worktree accepts
table tags for integration experiments; its dependency overrides are local paths.
The normal compiler contract and the sticky/animation-fill compiler restrictions
are not lifted by this experiment. Before integration, replay the patches on the
project pins and replace the paths with reviewed, reproducible revisions.

Implementation is narrower than Chromium parity. Sticky covers horizontal writing
modes; anchoring is layout-time vertical anchoring with live DOM candidates and
fallbacks, not the complete persistent-anchor/suppression-window model. Scroll
margins and padding, RTL scroll ranges, transformed targets and all ancestor
scrollers share Blitz primitives with the runtime. Scaled/rotated scrollports,
vertical writing, fragmentation and scroll-snap remain separate gates. Animation
rendering coverage does not certify animation events or the full Web Animations
API. Internal probes do not certify desktop keyboard/IME delivery.

The focus continuation paints selected control text, visible collapsed carets,
Chromium-style automatic outlines and default placeholders in Blitz. Disabled
requests preserve focus, and Tab traversal uses HTML boolean-attribute presence.
All 252 direct editor states match; local pixels improve from 8 to 66 with
identical inputs. Standards UA box geometry, textarea baselines, Unicode fallback
and all DPR 2 states retain failures. Compiled table carets remain transparent;
the direct reductions use visible manual carets with a computed-style assertion.
[Results](../../conformance/results/chromium-control-focus.md).

The control continuation repairs ordinary UA sizing, context-dependent textarea
baselines/overflow and fontless editor positions. Full-document mode now belongs
to HTML parsing and travels through Blitz style/layout; a generic Parley option
removes only the unconditional root strut. Fragments preserve the containing
mode, author sizing wins, and editors retain empty caret metrics. Focus geometry
improves 144→240/252 and pixels 66→80/252 against identical inputs. The new
264-state layout matrix passes every hit/editor/scroll check but only 84 full
geometry checks and no full pixel checks. Initial selections are repaired in
the 48-state refresh matrix and the older control/integration suites.
[Results](../../conformance/results/chromium-control-boxes.md) and the
[API contract](../ARCHITECTURE.md#chromium-parity-document-mode-and-empty-line-struts-2026-10-08-isolated)
record the scope. Legacy CSS parsing and empty inline/forced-break behavior
remain distinct gaps.

The text continuation implements an opt-in Parley logical metric policy while
preserving the device default, and Blitz's private inner-editor line-height,
signed centering and ordinary pointer-boundary policy. Identical inputs improve
text geometry 128→304/432, input geometry 64→336/504 and pointer editor state
141→231/264. Every DPR 1/2 geometry state in both new text matrices passes.
The older focus matrix now passes geometry 252/252 and pixels 164/252; layout
geometry is 132/264. Compiled tables, forms and button/inline checks retain their
gates. Two document-mode pixel states newly fail after fixing their 0.5px box
position; retain that glyph-placement reduction explicitly.
[Results](../../conformance/results/chromium-text-metrics.md) and the
[logical-mode contract](../ARCHITECTURE.md#chromium-parity-logical-text-metric-quantization-2026-10-08-isolated)
record scope and unchanged gates.

The next useful order is fractional-DPR border/box geometry, ordinary inline span
bounds, then the measured editor pointer/alignment and glyph-placement gaps.
Keep native theme paint and document-mode edges separate. Float layout needs an
explicitly enabled build; the compiler currently disables that feature. Preserve
all focus/table regressions and the newly exposed failures. Owners and gates:

| Gap | Evidence and owner | Next acceptance gate |
|---|---|---|
| CP-FONT-RANGE | Registration, range-aware matching/subset fallback and weight clamping are repaired in isolated Blitz/Fontique commits; 13 Fontique tests pass. This was not the table label paint cause | Keep the direct static/variable range matrix, decide the public struct-field API/semver change, then integrate reviewed pins; broader font paint remains open |
| CP-INTRINSIC-TEXT | Fixed: sizing queries overwrote settled Parley line positions, moving table button labels outside their boxes despite correct DOM geometry | Preserve the compiled table and reduced table/flex/grid mutation/resize pixel cases; measure the retained-layout copy cost |
| CP-TEXT-MEASURE-COST | Retaining text during intrinsic queries adds a measured mutation cost to the 100/1,000-row release benchmark | Reuse a separate scratch measurement layout or narrower retained state in the text/layout owner; require the same cache/mutation pixel regressions and before/after median/p95 measurements |
| CP-EDITOR-FOCUS | Fixed for compiled table CPU/GPU fixtures: selected foreground/background, auto outlines and placeholder paint; disabled focus/traversal also repaired. The 252-state direct suite now retains 88 pixel failures | Preserve visible/manual caret and independent editor-state checks; extend authored selection, dark/platform themes, bidi/IME and multibox outline cases when required |
| CP-EDITOR-INITIAL | Repaired in Parley: valid logical positions survive fontless layouts instead of moving to EOF. All 48 refresh states, 9 older control states and 30 integration states match | Preserve resource/style/width/scale refresh cases; bidi, OS/IME and arbitrary invalid UTF-8 cursor offsets remain separate gates |
| CP-CONTROL-UA-BOX | Ordinary text/search/textarea/button box models and textarea context baselines/visible overflow are repaired in Blitz/Stylo. The full layout matrix is now 132/264 geometry, with all hits/editor/scroll passing | Keep default/authored sizing, standards/quirks, inline/flex/grid/table and visible/hidden/clip cases; close span bounds, fixed-height input alignment and DPR metrics without loosening gates |
| CP-CONTROL-CENTER | Repaired in Blitz: conditional inner-editor line height and signed centering share geometry with baselines, paint and pointers. New input geometry is 336/504; all DPR 1/2 states pass | Preserve auto/fixed/percent/calc and integer-threshold cases, authored outer CSS, textarea behavior and refreshes; fractional-DPR boxes remain separate |
| CP-TEXT-METRIC-GRID | Repaired metric scaling in opt-in Parley Logical mode: textarea is 15/35 CSS px at all scales, 30/70 device px at DPR 2. Text geometry is 304/432, but only 48 local pixel states pass | Preserve Device default, unquantized behavior, builder reuse/editor refresh, fractional authored geometry and std/libm checks; raster coverage stays separately owned |
| CP-CONTROL-FRACTIONAL-BOX | At DPR 1.25, control borders produce about 0.4px outer-size differences; all 128 text and 168 height-matrix geometry residuals are here. Stylo device-pixel border snapping differs from Chromium layout rounding | Reduce border widths and CSS zoom on plain boxes/controls at DPR 1/1.25/1.5/2; freeze a style-owner policy before changing public APIs; share computed, layout, paint and hit values |
| CP-EDITOR-POINTER | Outside-line ordinary clicks/drags now use logical boundaries, including RTL; 231/264 editor states pass. Fifteen selected-text click and eighteen RTL inside-editor states fail | Preserve all new states; reduce delayed collapse/drag initiation separately from RTL content-width/alignment, and keep single-line no-wrap scrolling |
| CP-INLINE-SPAN-BOUNDS | Ordinary `#text` spans in the control matrix retain whole-line height and omit their 8px inline margin placement | Reduce inline fragment bounds and margins in Blitz/Parley across wrapping and bidi; share geometry with hits/DOM reads rather than compensating control paint |
| CP-CONTROL-THEME | A default button label matches bounds and passes its interior crop at MAE 1.464, while its full crop is 22.076 from native lower/right bevel colors | Reduce `appearance:auto` theme paint separately from authored CSS borders and `appearance:none`; cover active/disabled/focus states and preserve custom control/table cases |
| CP-DOCUMENT-MODE | Parser mode, fragment preservation, device rebuilds and empty root struts are repaired. Core mode geometry is now 60/60; full 132-state oracle retains float and break/newline failures | Keep mode/cache regressions; separately reduce quirks/limited-quirks `<br>` and preserved newlines (19px residual), empty/collapsed whitespace and inline border/padding. Enable floats only for a measured float scope |
| CP-NESTED-INLINE | Nested atomic inline/button reductions retain local paint failures while geometry passes; baseline measurement can promote child sizing to PerformLayout | Compare retained child line positions and baselines across table/flex/grid intrinsic passes; keep nested failures in the oracle |
| CP-FONT-INSTANCES | Variable-font auto optical sizing/normal-line-height states retain geometry and paint failures; static single-face synthetic bold and DPR 2 paint also fail | Resolve CSS variation precedence and optical sizing in the Blitz font bridge and metrics provider, consume synthesis in paint, then compare pinned glyph regions across DPR |
| CP-FONT-ORDER | Both source orders of overlapping static/variable CSS face declarations retain geometry/pixel failures in `font-weights.mjs` | Preserve CSS face priority at the registration/query boundary independently of generic/system Fontique family ordering; cover overlapping ranges and resource completion order without dropping subset fallback |
| CP-INLINE-BASELINE | Retained table-control geometry now passes 4/4 in standards and quirks; pixels remain 4/4, with corner hits still 2/4 | Preserve primary-font/atomic-box/table alignment reductions across fonts and mutations; corner hits remain CP-ROUNDED-HIT |
| CP-ROUNDED-HIT | Fractional rounded buttons retain an edge hit discrepancy after the inline child-coordinate fix | Use Chromium's rounded-rectangle intersection model and consistent layout coordinates; keep corner hits independent of painting |
| CP-EDITOR-WRAP | `controls.mjs` textarea after scrolling retains different wrapping and paint; authored input intrinsic widths are covered separately | Compare editor content widths, line advances and break opportunities; repair editor geometry rather than alter its text or font |
| CP-RASTER | `glyphs.mjs`, `borders.mjs` and checked-radio crop retain local paint failures | Separate outline/hinting, coverage and dotted-stroke phase/count in their renderer owners; retain local MAE 3 across sizes/origins/DPR |
| CP-TABLE-WPT | Practical table oracle does not cover the complete CSS table model | Add attributed anonymous-box, `empty-cells`, collapse, height distribution and border-order reductions from WPT as the app corpus needs them |

The checked-in [initial verification record](../../conformance/results/chromium-parity.md),
[font/inline continuation](../../conformance/results/chromium-font-inline.md) and
[focus continuation](../../conformance/results/chromium-control-focus.md), followed by
[control boxes](../../conformance/results/chromium-control-boxes.md) and
[text metrics](../../conformance/results/chromium-text-metrics.md), separate
fixed worktree behavior, residual failures and shipping gates. None of
the broader P1/P4/P7 clusters is closed merely by these patches.

The logical-grid ADR and 432-state text matrix are implemented. Keep the public
Device default, fractional authored positions, shared glyph/selection/caret metrics,
and independent geometry/hit/editor/scroll/pixel gates as regressions. Synthesis,
optical sizing and CSS face ordering remain font-owner work; native theme paint
cannot change general authored border semantics.

The next bounded reductions should be implemented in this order:

1. **Fractional-DPR boxes (Stylo/Blitz device).** Compare computed and used border
   widths, content/border boxes and minimum sizes across plain elements and text
   controls, including fractional widths and CSS zoom. Chromium's converter rounds
   computed layout lengths; Stylo currently uses device-pixel app units. Record
   unchanged defaults and a style-owner ADR before introducing a public policy.
   Close the retained DPR 1.25 failures without a painter-only compensation.
2. **Inline fragments (Blitz/Parley).** Reduce ordinary span font bounds and inline
   margins across wrapping, empty content, nested vertical alignment and bidi.
   Share visual fragment geometry with DOM reads and hits; preserve the table,
   flex/grid intrinsic, mutation and resize cases.
3. **Editor interaction (Blitz events/layout).** Separate clicks inside a selected
   range and drag initiation from RTL/start/end/center alignment. Determine editor
   alignment width independently of single-line no-wrap shaping and scroll extent;
   require retained selection/caret behavior across width, font and scale changes.
   Add exact boundary and double/triple-click cases before expanding the claim.
4. **Glyph placement (Glifo/Vello).** Retain the two newly failing standards input
   crops and isolate fractional container/editor translations whose final baseline
   is integral. Compare cached/direct outline paths and hinting/coverage; geometry
   stays correct and pixel MAE remains 3. Keep font instances/order and theme paint
   as distinct reductions.

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
the existing direct 1/8px and 3/255 gates. The compiled framework harness retains
its separate 2px geometry gate; report these tolerances separately. No stage is
passed by a missing tool, a known gap annotation or a largely white whole-page screenshot. Failures stay runnable.

Use distinct status: **reproduced**, **fixed in isolated worktree**, **integrated
and verified**, **upstreamed**. Remove a compiler gap only after integration and
the applicable contract/conformance update. Keep one patch per owning layer and
linked regression evidence; re-evaluate the patch when its dependency pin moves.
Use the shared Cargo target/PID lock, focused checks while iterating, and the
required compiler/workspace checks once ready. This keeps the gap-closing effort
bounded and the modularity reviewable.
