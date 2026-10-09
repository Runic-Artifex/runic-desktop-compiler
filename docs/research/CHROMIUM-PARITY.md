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

## Consolidated checkpoint (2026-10-09)

The [consolidation record](../../conformance/results/chromium-consolidation.md)
verifies compiler `4d94133` with exact Git pins for Blitz `f7d0a01`, Parley
`4105c65`, Stylo `568059d` and Vello `a8efce5`. Table tags and the four hover
over/out events are integrated. Compiler and workspace checks pass 316 and 128
tests. Optimized/unoptimized hover cases pass 180 states; 389 retained compiled
states pass. Differential endpoint replay compares 3,120 complete states at real
native-selected endpoints; browser/native cases retain independent hit checking.
The fresh table and edge-driver matrices pair 104 states unchanged, retaining
three table-suite primitive strict-pixel failures and 27 driver strict-pixel
failures. The historical private-flow checkpoint keeps all 4,820 states across
35 matrices byte-identical; those matrices are not all recaptured by consolidation.
Six known fork unit failures, OS/device delivery, default/system-font parity and
the named review stage remain incomplete. Sticky/fill compiler guards and public
ordinary-inline `getClientRects()` rejection remain.

Form submission/reset is the next compiler/runtime checkpoint. Generic nonzero
inline edges follow the retained ordinary-inline plan below. Historical isolated
checkpoints, source revisions, counts and ADRs remain unchanged.

## Module boundaries

| Owner | Responsibilities | Boundary to preserve |
|---|---|---|
| Blitz DOM/layout | Table formatting, anonymous boxes, used geometry, overflow, visual offsets, inline fragments | HTML/CSS rules only; no shadcn, framework, editor or fixture names |
| Blitz paint | Borders, backgrounds, clips, control decorations and CSS text paint anchors; consume used geometry | Preserve logical geometry; keep paint snapping separate from DOM reads and hit targets |
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

### Historical isolated implementation checkpoint (2026-10-08)

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

The line-width continuation closes the measured fractional-DPR border/box gap
through Stylo's opt-in CssPixel policy, preserving its DevicePixel default and
physical hairlines. Retained text/input/pointer geometry is now 432/432, 504/504
and 264/264; hits improve to 408/432 and 504/504 in the first two. The new 176-state
width matrix and 76-state zoom/logical-side/animation matrix pass geometry and
computed widths. Pixel and pointer-state counts remain independent; no retained
gate regressed. [Results](../../conformance/results/chromium-line-widths.md) and
the [style-owner contract](../ARCHITECTURE.md#chromium-parity-line-width-rounding-2026-10-08-isolated)
record source pins and scope.

The inline-fragment continuation adds Parley's read-only first-font bounds and
shares run advances/font-content bounds across Blitz DOM reads and pointer
targets. All 108 font-size/line-height states match bounding and fragment-list
geometry. The full 363-state matrix improves geometry 15→189, fragment lists
15→174 and hits 231→270, including 51 repairs and 12 new narrow leading-gap
failures. Supplemental measured scroll passes 54/54; terminal breaks improve
scroll 0→36 and hits 12→36. Retained 2,579 direct states have no gate regressions;
font-weight geometry is now 20/36 and hits 36/36. All 389 compiled states retain
their gates. Every new local pixel gate still fails.
[Results](../../conformance/results/chromium-inline-fragments.md) and the
[inline API contract](../ARCHITECTURE.md#chromium-parity-inline-font-content-bounds-2026-10-08-isolated)
record exact sources, measurements and remaining scope.

The pointer continuation implements the private footprint/quad, logical positions,
transform-layer phases and snapped rounded/text intersections. Its 234-state
oracle passes all standard hits and 216 explicit-point states;150 paired states
repair 54 explicit-point failures without regression. All 12 preceding leading-gap
losses are repaired, and table-control hits improve 2→4/4. Main hits270→258,
effects 87→93 and text metrics 408→420 expose 81 passing-to-failing hit states.
All paired non-hit gates and 389 compiled states preserve their passing states.
[Results](../../conformance/results/chromium-pointer-geometry.md) separate every
regression from geometry and pixel gates.

The text-provenance continuation adds optional normalized source ids in Parley,
with no new shaping boundaries, and a private reverse inline hit walk in Blitz.
Its new oracle passes 192/216 hits and 186/216 geometry; 144 exact pairs repair
54 hits without regression. Across 3,422 exact direct pairs there are 69 standard
hit repairs, three explicit-point repairs and three new middle-alignment hit
failures. All 12 previous nested/effects losses are repaired; 60 margin-flow and
nine marker-edge losses remain. Every paired non-hit gate and all 389 compiled
states preserve their passing states.
[Results](../../conformance/results/chromium-inline-source-order.md) retain
the three new losses and their unchanged 0.296875px geometry mismatch.

The primary-font metric continuation repairs all three middle geometry/fragment/
hit failures. Missing x-height is now synthesized from a hinted x contour only
in Parley's enabled logical mode. The new oracle passes 120/180 geometry and
138/180 hits; 60 nested geometry states remain. Across 3,674 exact direct pairs,
123 geometry, 63 fragment-list, nine hit and 45 strict pixel states are repaired
without regression. All 389 compiled states retain their gates.
[Results](../../conformance/results/chromium-middle-metrics.md).

The text-paint continuation implements private CSS anchor snapping in Blitz and
an additive read-only Parley primary-font metric getter. All seven preceding
pixel regressions are repaired; middle strict pixels improve 78→89/180
and the 108-state paint-origin oracle improves 38→85/108.
Logical baselines, geometry, selection/background coordinates and renderer
hinting are preserved. Across 3,890 exact direct pairs, 63 strict pixel states are
repaired without a measured gate regression.
All 389 compiled states retain their gates.
[Results](../../conformance/results/chromium-text-paint-origins.md) retain tight
child crop failures and the layer/materialization/fragment scope boundaries.

The empty-inline continuation adds opt-in Parley participation, standards-mode
Blitz geometry and private shaping boundaries. All 108 new geometry/list/hit states
and all 42 ligature geometry/list/hit states pass. Nested geometry reaches 72/72,
fragments 63/72 and hits 69/72. Across 4,040 exact pairs, retained passes are
preserved; the new shaping oracle keeps eleven tight-crop pixel regressions.
[Results](../../conformance/results/chromium-empty-inline.md).

The caller-boundary continuation implements generic Parley boundary intent,
Stylo's implicit/explicit zero category and standards-mode Blitz binding. It also
refreshes alignment metrics without reshaping on pure style changes, preserving
the observed Chromium history. Intent geometry/fragments improve 30→129/150;
history geometry/fragments improve 30→72/132. Across 4,322 exact pairs, there are
141 geometry/fragment, 72 hit and seven pixel repairs with no new gate regressions.
All 389 compiled states retain their passes. The six existing dependency failures
and incomplete stages remain explicit.
[Results](../../conformance/results/chromium-inline-boundaries.md).

The ordinary-span ownership continuation adds normalized owner ranges and atomic
ordinals in Parley, with standards CSSOM binding in Blitz. Intent and history
geometry/fragments now pass 150/150 and 132/132. Across 4,628 exact pairs there
are 156 geometry/fragment and 159 hit repairs without regressions in those gates.
All native whole PNGs are byte-identical; corrected crops repair 39 strict pixel
states and expose two new strict failures. The completed audit retains its failed
zero-regression gate and all 389 compiled passes.
[Results](../../conformance/results/chromium-inline-ownership.md).

The authored-edge continuation retains private normalized opening/closing order
in Parley under the same tracking opt-in. Ten focused tests pass. All 4,793 exact
direct pairs and native whole PNGs are unchanged, with zero repairs/regressions
and all 389 compiled states passing. The new 165-state flow-affinity oracle
retains 9 geometry, 6 fragment, 60 hit, 51 explicit-point and zero strict pixel
passes. Used advances and rendering consumers remain subsequent work.
[Results](../../conformance/results/chromium-inline-authored-edges.md).

The next useful order is generic span edges/CSS margins, then full
segmentation/RTL/tab/atomic reductions, editor interaction
and remaining paint coverage.
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
| CP-CONTROL-UA-BOX | Ordinary text/search/textarea/button box models and textarea context baselines/visible overflow are repaired in Blitz/Stylo. The full layout matrix remains 132/264 geometry; remaining differences are solely the text span's omitted 8px margin. Hits/editor gates pass; this matrix has no scroll probe | Keep default/authored sizing, standards/quirks, inline/flex/grid/table and overflow cases; close inline margin flow and retained paint/wrapping gaps; preserve the repaired metrics, centering and fractional-width suites |
| CP-CONTROL-CENTER | Repaired in Blitz: conditional inner-editor line height and signed centering share geometry with baselines, paint and pointers. Input geometry and hits now pass 504/504, with pixels 134/504 | Preserve auto/fixed/percent/calc and integer-threshold cases, authored outer CSS, textarea behavior and refreshes; retain pixel gates independently |
| CP-TEXT-METRIC-GRID | Repaired metric scaling in opt-in Parley Logical mode: textarea is 15/35 CSS px at all scales, 30/70 device px at DPR 2. Text geometry now passes 432/432; hits are 420/432 (21 repairs, 9 marker-edge regressions) and pixels 48/432 | Preserve Device default, unquantized behavior, builder reuse/editor refresh, fractional authored geometry and std/libm checks; retain tiny marker edge hits and renderer coverage separately |
| CP-CONTROL-FRACTIONAL-BOX | Repaired in Stylo/Blitz: CssPixel is opt-in; DevicePixel/default and physical hairlines are preserved. All 176 width and 76 supplemental states match computed widths/geometry across DPR 1/1.25/1.5/2, including CSS zoom | Preserve before-app-unit tiny/near-integer thresholds, default/opt-in cache invalidation, logical sides, inheritance, zoom and mutation samples; broad transitions/additivity and animated zoom require their own gates |
| CP-EDITOR-POINTER | Outside-line ordinary clicks/drags now use logical boundaries, including RTL; geometry is 264/264 and editor state 231/264. Fifteen selected-text click and eighteen RTL inside-editor states fail | Preserve all new states; reduce delayed collapse/drag initiation separately from RTL content-width/alignment, and keep single-line no-wrap scrolling |
| CP-INLINE-SPAN-BOUNDS | First-font content height and short-line overflow are repaired in Parley/Blitz; all 108 font states match geometry/lists. The 180-state margin group passes 24 bounding, 15 list and 90 hit states, including 60 new hit losses; 132 retained control states still omit an 8px text margin | Add generic ordered owner/start/end advances in Parley, then bind CSS margins in Blitz. Cover intrinsic/break replay, negative/empty/percent/nested spans and first/last wrapped fragments; margins stay outside own border rects/hits |
| CP-INLINE-HIT-LOCATION | Private footprint/quad plus normalized source metadata and reverse fragments repair preceding narrow-gap/nested/effects losses. Pointer is 234/234 standard and 219/234 explicit points; source ordering is 192/216 hits. The three middle metric/hit losses are repaired; sixty margin and nine marker losses remain | Preserve shaping atoms, eligible ancestors and per-line parent groups. Reduce exact layout-object siblings versus DOM heuristics, preserved tabs, narrowed RTL wraps and atomic flow. Repair metrics/margins in their owners; retain large-gap, negative viewport and exact marker samples |
| CP-INLINE-FRAGMENT-LISTS | Blitz retains one union per line; bidi passes 0/12 list states and effects 60/102 despite 102/102 bounding geometry | Preserve bidi/culled/nested segmentation, zero-width newlines and preserved trailing spaces. Keep list order/count independent of bounding unions and pointer gates |
| CP-INLINE-ALIGN-METRICS | Logical x-height, bottom-up line alignment and empty participation are repaired in the isolated forks. Middle is 180/180 geometry, 120/120 measured fragments and 147/180 hits; nested is 72/72 geometry, 63/72 fragments and 69/72 hits | Preserve Device/unquantized metrics, saved/default breakers and atomic scale conversion; reduce the nine nested fragment and three hit residuals plus full deferred top/bottom/fixed-point semantics; strict pixels remain separate |
| CP-EMPTY-INLINE | Opt-in Parley anchors and standards-mode Blitz font-area fragments pass all 108 geometry/list/hit states; private shaping boundaries pass all 42 ligature geometry/list/hit states. Generic caller intent now covers explicit 0px and nonempty spans | Retain default/reset, normalization, both breakers, real-zero versus empty-list CSSOM and full-atom controls; quirks and broad bidi/grapheme behavior remain separate |
| CP-INLINE-SHAPING-INTENT | Parley normalizes caller opening/closing boundaries; Stylo retains implicit/explicit zero; Blitz supplies standards-mode CSS intent. Owned atom bounds close intent/history geometry/lists to 150/150 and 132/132; hits are 147/150 and 111/132 | Preserve internal ligatures, whitespace timing, DPR and cached alignment history. Browser geometry proxies do not certify glyph/cache identity or every font-triggered category reset |
| CP-INLINE-OWNERSHIP | Opt-in Parley ranges/all-box ordinals and standards Blitz CSSOM assign whole atoms and real zero continuations. The 306 edge states pass 141 geometry/lists and 159 hits; two tighter-crop strict pixel losses remain | Add signed nonzero edge flow with shared visual/caret offsets, intrinsic sizing and saved-break replay. Preserve normalized ownership and independently gate wrapped fragments, paint and hits |
| CP-INLINE-EDGE-FLOW | Private authored open/close order, normalized endpoints and all-box ordinals are retained in Parley; ten new tests pass and rendering is unchanged. The 165-state oracle records wrap/direction/intrinsic targets | Freeze a shared offset and edge-consumption interface; add driving negative-wrap/min-content and immediate br-close reductions. Then implement signed advances, rollback and CSS mapping without changing default consumers |
| CP-TEXT-PAINT-ANCHOR | Private Blitz CSS anchor snapping repairs all seven prior losses; new oracle 85/108 pixels, 108/108 geometry/fragments. Parley supplies primary metrics; renderer hinting stays unchanged | Retain all origin/DPR/background/mutation states and tight child crops; add sticky materialization, layer-local/transformed, containment/SVG and bidi fragment provenance reductions before broader claims |
| CP-CONTROL-THEME | A default button label matches bounds and passes its interior crop at MAE 1.464, while its full crop is 22.076 from native lower/right bevel colors | Reduce `appearance:auto` theme paint separately from authored CSS borders and `appearance:none`; cover active/disabled/focus states and preserve custom control/table cases |
| CP-DOCUMENT-MODE | Parser mode, fragment preservation, device rebuilds and empty root struts are repaired. Core mode geometry is now 60/60; full 132-state oracle retains float and break/newline failures | Keep mode/cache regressions; separately reduce quirks/limited-quirks `<br>` and preserved newlines (19px residual), empty/collapsed whitespace and inline border/padding. Enable floats only for a measured float scope |
| CP-NESTED-INLINE | Nested atomic inline/button reductions retain local paint failures while geometry passes; baseline measurement can promote child sizing to PerformLayout | Compare retained child line positions and baselines across table/flex/grid intrinsic passes; keep nested failures in the oracle |
| CP-FONT-INSTANCES | Font-weight geometry improves 12→20/36 and hits 28→36/36 through span bounds. Variable-font auto optical sizing/normal-line-height and static synthetic-bold/DPR 2 paint remain open | Resolve CSS variation precedence and optical sizing in the Blitz font bridge and metrics provider, consume synthesis in paint, then compare pinned glyph regions across DPR; the bounds repair does not certify font matching |
| CP-FONT-ORDER | Both source orders of overlapping static/variable CSS face declarations retain geometry/pixel failures in `font-weights.mjs` | Preserve CSS face priority at the registration/query boundary independently of generic/system Fontique family ordering; cover overlapping ranges and resource completion order without dropping subset fallback |
| CP-INLINE-BASELINE | Retained table-control geometry now passes 4/4 in standards and quirks; pixels and corner hits now pass 4/4 | Preserve primary-font/atomic-box/table alignment reductions across fonts and mutations; keep the expanded rounded/transform point oracle independently gated |
| CP-ROUNDED-HIT | Snapped constrained outer radii and quad/corner-ellipse intersections repair retained table controls and positive-origin rounded/constrained-corner reductions. Negative viewport edges still fail | Preserve exact points through inverse transforms/scroll clips; expand negative-origin and nested-layer contours as needed. Painting remains independently gated |
| CP-EDITOR-WRAP | `controls.mjs` textarea after scrolling retains different wrapping and paint; authored input intrinsic widths are covered separately | Compare editor content widths, line advances and break opportunities; repair editor geometry rather than alter its text or font |
| CP-RASTER | `glyphs.mjs`, `borders.mjs` and checked-radio crop retain local paint failures; new width/effects matrices pass only 30/176 and 45/76 pixels despite matching geometry/computed widths | Separate glyph placement/hinting, outline coverage and dotted-stroke phase/count in their renderer owners; retain local MAE 3 across sizes/origins/DPR |
| CP-TABLE-WPT | Practical table oracle does not cover the complete CSS table model | Add attributed anonymous-box, `empty-cells`, collapse, height distribution and border-order reductions from WPT as the app corpus needs them |

The checked-in [initial verification record](../../conformance/results/chromium-parity.md),
[font/inline continuation](../../conformance/results/chromium-font-inline.md) and
[focus continuation](../../conformance/results/chromium-control-focus.md), followed by
[control boxes](../../conformance/results/chromium-control-boxes.md) and
[text metrics](../../conformance/results/chromium-text-metrics.md) and
[line widths](../../conformance/results/chromium-line-widths.md) and
[inline fragments](../../conformance/results/chromium-inline-fragments.md) and
[pointer geometry](../../conformance/results/chromium-pointer-geometry.md) and
[text provenance](../../conformance/results/chromium-inline-source-order.md),
[middle metrics](../../conformance/results/chromium-middle-metrics.md) and
[nested alignment](../../conformance/results/chromium-nested-alignment.md) and
[text paint origins](../../conformance/results/chromium-text-paint-origins.md),
[empty inline participation](../../conformance/results/chromium-empty-inline.md) and
[caller shaping boundaries](../../conformance/results/chromium-inline-boundaries.md), separate
fixed worktree behavior, residual failures and shipping gates. None of
the broader P1/P4/P7 clusters is closed merely by these patches.

The logical-grid ADR and 432-state text matrix are implemented. Keep the public
Device default, fractional authored positions, shared glyph/selection/caret metrics,
and independent geometry/hit/editor/scroll/pixel gates as regressions. Synthesis,
optical sizing and CSS face ordering remain font-owner work; native theme paint
cannot change general authored border semantics.

The next bounded reductions should be implemented in this order:

The fractional-DPR box reduction is implemented. Keep its style-owner ADR,
additive opt-in API and default preservation, and all paired width/zoom/control
cases as regressions. No renderer adjustment substitutes for these shared widths.

Text provenance and the private fragment hit walk are implemented. Preserve the
seven Parley metadata/normalization/shaping tests, the 216 source-order states,
all repaired nested/effects edges, 18 eligible ancestors and leading-gap/wrap
controls. Source records are optional metadata; they must not split shaping atoms.

The per-line alignment reduction is implemented in Parley's private logical
layout module. Preserve all 180 middle states, the new 72-state oracle, the three
primary-font repairs and the eight union/replay/default-policy tests. Textless
ancestors retain their own strut; fully empty spans still lack participation.
Blitz owns atomic CSS-to-layout length conversion. Neither change adds a public
API, IR field or framework branch. That checkpoint introduced seven strict
text-crop regressions, alongside ten repairs; the paint continuation now repairs
all seven. The frozen 18-state diagnostic exposes the formerly anonymous child:
both ancestor and child geometry/fragment lists match, while two tighter child
crops still fail the pixel gate.

1. **Text paint anchors (implemented in Blitz paint).** Keep the seven repaired
   states, frozen inner-span diagnostic and 108-state origin/materialization
   matrix. Logical baselines agree; nearest materialized CSS fragment anchors
   select the paint phase before device hinting. Preserve the private module and
   additive read-only primary metrics API. Tight child crops and broad font
   coverage remain failed. Trace layer-local/transformed coordinates, sticky
   materialization flags after restyles, empty/pseudo/contents participation and
   bidi fragment owners before extending this bounded ordinary-inline model.
2. **Inline margin flow (Parley, then Blitz).** Empty participation and
   zero-advance ownership and private authored edge order are implemented. Next freeze
   edge consumption and shared visual offsets in a separate ADR,
   preserving public enum compatibility and source provenance. Cover pending
   whitespace, equal-offset empty/nested owners, atomic/OOF order, soft-break
   affinity, intrinsic sizing and saved-break replay. Bind percentages/calc/auto
   and per-side shaping intent in Blitz. Measure box direction and containing
   progression separately when mapping physical sides. Preserve table/flex/grid
   sizing and measure style history.
3. **Deferred alignment edges (Parley).** Reduce nested top/bottom placement at
   the nearest deferred ancestor and its descendant union before claiming the
   full Blink model. Cover text-top/text-bottom, fallback-font boxes, fractional
   fixed-point boundaries and odd/negative leading. Preserve declared OS/2/MVAR,
   the hinted provider, Device defaults and unquantized behavior. Geometry,
   fragments, hits and pixels remain separate gates.
4. **Fragment lists and remaining hits (Blitz/Parley).** Retain full fragment count/order,
   bidi/culled segmentation and newline/whitespace fragments. Reduce nine tiny marker
   boundaries, preserved tabs, narrowed RTL wraps and RTL atomic flow. Compare the
   DOM sibling heuristic with layout-object siblings for empty/display:contents
   nodes and complex source seams. Keep transformed/overlapping atomic traversal,
   odd-height/negative-origin points and nested shifts independently gated.
5. **Editor interaction (Blitz events/layout).** Separate clicks inside a selected
   range and drag initiation from RTL/start/end/center alignment. Determine editor
   alignment width independently of single-line no-wrap shaping and scroll extent;
   require retained selection/caret behavior across width, font and scale changes.
   Add exact boundary and double/triple-click cases before expanding the claim.
6. **Paint and cost (Blitz paint/Glifo/Vello).** Fix flattened hidden-descendant
   text paint and profile run/style scans before caching, with refresh and intrinsic
   layout-copy regressions. Retain the two previously exposed standards input
   crops and isolate fractional container/editor translations whose final baseline
   is integral. Compare cached/direct outline paths and hinting/coverage; geometry
   stays correct and pixel MAE remains 3. Keep the new fontless outline crops too;
   matching computed widths do not certify paint. Font instances/order and native
   theme paint stay distinct reductions.

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

Extend the existing pure HTML oracle for behavior beyond the accepted bounded table surface:

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

The consolidation checkpoint replaces local paths with exact Git pins and
verifies affected framework cases on CPU and selected lavapipe GPU tables. D11
upstream work remains separate; integration is not upstream acceptance. Preserve
that gate for each later table extension and measure the remaining large-row
performance/WPT domains. The CPU Glifo result does not certify general GPU text.
The interpreter currently lacks layout/style/mutable DOM: differential checks
cover its modeled value/event behavior and must report the remaining stage as
incomplete.

## Batch 2: shared scroll coordinates

The pinned Blitz fork implements bounded horizontal-writing sticky constraints
with shared visual offsets consumed by paint, hit testing and DOM geometry.
Expand and accept the compiler surface only with the remaining scroll/transform/
clip reductions. A paint-only offset would leave floating-ui, pointer
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

## Next ordinary-inline slice: generic edge flow and ownership

The zero-advance ownership layer and private authored edge stream are implemented
under their respective ADRs. Nonzero edges need a separate interface checkpoint. Keep
CSS resolution in Stylo/Blitz and generic text flow in Parley; preserve defaults,
source provenance and the public positioned-item enum.

The [private-flow checkpoint](../../conformance/results/chromium-inline-flow-views.md)
extracts ordinary-span atom traversal and empty-anchor box traversal without
merging their arithmetic policies. Nine focused tests pass, and all 4,820 direct
results and native screenshots remain identical. Paint, cluster/caret, selection
and breaker cursors still need a defined effective used-edge path. The additive
[27-state driver](../../conformance/inline-edge-drivers.mjs) now changes negative
margin wrapping and controlling min-content width, and captures immediate `br`
closing decoration at locked Chromium 153. These observations supply the three
requested reductions; internal overflow recovery and cache branches remain
uninstrumented.

1. Private normalized event order is retained and tested. Freeze consumption and
   wrap affinity with reductions: pending
   spaces, equal-position empty/nested owners, atomic and out-of-flow ordinals,
   forced breaks, opening lookahead and closing-edge break opportunities. Byte
   positions alone cannot define that order. Saved opportunities must restore
   the active owner state and signed cursor, including negative opening edges
   that bring overflow back within the line width. First add a negative-margin
   case that actually changes wrapping and an immediate `br`-close case.
2. Share edge-aware visual offsets across glyph positioning, empty anchors,
   cluster point/visual-offset lookup, caret/selection geometry and both breakers
   before adding advances. Freeze compatibility policies for glyphless spacing,
   out-of-flow width, grouping and f32/f64 accumulation; today's consumers differ.
   Prove zero-edge behavior unchanged. A breaker-only
   cursor patch would leave those consumers inconsistent.
3. Implement fixed signed advances in Parley and bind standards CSS edges in
   Blitz. Opening and closing sums remain separate. Own margins are excluded
   from border/client rectangles and hits; ancestor bounds include descendant
   advances. Measure box direction and containing progression separately: own
   direction changes asymmetric fragment placement under an unchanged parent.
   Shaping intent is per edge and independent of the numeric used advance.
4. Add negative/percentage/calc/auto, intrinsic sizing, and layout-only mutation.
   An indefinite percentage basis resolves to zero while retaining the fixed
   calc contribution and authored shaping intent. Include refreshed edge values
   and content-width invalidation in intrinsic layout clones/restoration and
   saved-break replay; keep shape retention independently measured. Add a
   min-content mutation whose edge segment actually controls the queried width.
5. Implement and gate wrapped slice/clone fragments, decoration paint and hit
   geometry. Match the pinned browser's default behavior: ideal clone end-edge
   reservation is behind a test-only Blink feature. Do not silently adopt it as
   the default reference. Re-run the 306 edge states and all retained matrices.

Completion targets stay concrete: the 60 retained margin hit failures and 84
standards control states with an omitted 8px text margin, followed by the 48
quirks control states under a separately measured policy. Full bidi fragment
segmentation, grapheme/caret behavior, tabs, font/raster parity and OS editor
delivery remain separate work. Profile per-owner atom scans before adding a
cache; correctness and style/width/scale invalidation must precede optimization.

This follows pinned Blink's [open/end edge flow](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/layout/inline/line_breaker.cc#3937),
[intrinsic line breaking](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/layout/inline/inline_node.cc#1986)
and [boundary shaping](https://chromium.googlesource.com/chromium/src/+/971a7443b0c9b0a9b2860529b33331b76077ec62/third_party/blink/renderer/core/layout/inline/inline_node.cc#493).
The [306-state oracle](../../conformance/inline-span-edges.mjs) retains fixed,
negative, percentage/calc and auto edges, padding/border, empty/nested owners,
atomic ordering, intrinsic wrapping, slice/clone and style/width/font history.
The [165-state oracle](../../conformance/inline-flow-affinity.mjs) adds authored
order, wrap, direction and intrinsic observations. Its negative margin moves an
owner by 26.375px while every step remains two lines. Its min-content mutation
leaves CCC's controlling width at 50.28125px; max-content changes 14.25px and
restores. Neither observation certifies a recovery/cache branch. Preserved newline
and `br` followed by an empty child have different closing fragments; immediate
`br`-close remains to be reduced. Own direction changes first/last fragment-side
placement, while parent direction also changes alignment. Trailing space-only
and empty observations coincide; the out-of-flow case covers one fixed checkpoint.
Initial-style prerequisites and browser geometry do not instrument glyph/cache
identity. T3 Chrome 152 exploration supplies candidates only; acceptance uses the
locked Chromium 153.0.8010.12. Keep these limits in the
[authored-edge checkpoint](../../conformance/results/chromium-inline-authored-edges.md).

The [ownership checkpoint](../../conformance/results/chromium-inline-ownership.md)
records the current geometry repairs and the two newly exposed strict pixel failures.
