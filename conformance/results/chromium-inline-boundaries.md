# Chromium caller shaping boundaries — isolated checkpoint

Ordinary inline spans now supply explicit shaping-boundary intent, including CSS
`vertical-align:0px`. Alignment restyles update geometry while retaining shaping
history. The new oracles repair 141 geometry and fragment-list states, 72 hit states
and seven strict pixel states. Across 4,322 exact before/after pairs, no measured
gate regresses; every retained passing gate remains. All 389 compiled states pass
semantics, geometry and strict pixels.

| New oracle | Geometry before → after | Fragments | Hits | Strict pixels |
|---|---|---|---|---|
| [Caller intent](../inline-shaping-intent.mjs), 150 states | 30 → 129 | 30 → 129 | 69 → 126 | 42 → 46 |
| [Alignment history](../inline-shaping-refresh.mjs), 132 states | 30 → 72 | 30 → 72 | 36 → 51 | 49 → 52 |

The intent oracle covers empty/nonempty spans, explicit zero lengths/percentages/
calc, nonzero and keyword alignment, internal versus crossing ligatures, nested
owners, display:contents, whitespace timing, intrinsic wrapping and mutation.
The history oracle covers add/remove/restore alignment and a later font change.
Both use pinned Chromium 153.0.8010.12 at DPR 1/1.25/2 and fractional origins.
No reference output, crop rule or tolerance was changed to obtain these repairs.

Stylo retains the initial/shorthand-omitted zero category separately from explicit
numeric zero. CSSOM exposes numeric zero; shorthand serialization retains the
distinction. Blitz binds CSS intent for standards-mode ordinary spans and refreshes
current ordinary/atomic alignment before line breaking. Parley's additive tree API
normalizes opening/closing requests into private UTF-8 boundaries, preserving
internal ligatures and delayed-whitespace ordering. Its layout refresh API recomputes
parent-relative metrics from cached font data without changing text or glyphs;
callers must rebreak lines. Existing defaults and the positioned-item enum remain.
CSS, layout, paint and framework knowledge stay in their existing owners; no IR,
framework, renderer or font-hinting change is involved. The
[ADR](../../docs/ARCHITECTURE.md#chromium-parity-caller-shaping-boundary-intent-2026-10-08-isolated)
records the interfaces and their limits.

Pinned Blink source and 66/66 horizontal geometry/fragment comparisons support
retaining prior shaping on pure alignment restyles while using current alignment
for geometry. Browser geometry is a proxy, not glyph/cache instrumentation.
The final font step first restores initial alignment, so it does not prove clearing
stale boundary intent at every differing category. Parley's unit tests separately
verify glyph contents and allocation retention. Fresh font/text shaping and wrap-mode
invalidation remain independently covered.

Style-attribute set/clear now uses computed-style damage instead of unconditional
recollection. Full workspace verification exposed two stale table-snapshot regressions.
Blitz now rebuilds snapshots when table-owner geometry or captured border inputs
change, while live alignment, color and caption geometry retain layout-only handling.
Seven focused damage tests and all 13 table-document probes pass. The failed partial
run is archived; all 45 final commands were rerun against the signed frozen sources.

Root and independent audits agree across 32 direct matrices and eight gates, with
4,040 retained and 282 new exact pairs. Raw observations validate all 8,644 before/
after rows. Required screenshots, input hashes, finite measurements and 65 empty
clipped crop regions were checked. Direct geometry uses 0.125 CSS px; compiled
geometry retains its 2 CSS px comparator. Strict pixels require finite viewport/
container measurements and every measured local crop at MAE ≤3/255. Some already
failing local crops have higher MAE after corrected fragment geometry shrinks their
crop; none becomes a new strict failure. Eleven pixel regressions from the preceding
empty-shaping checkpoint remain explicit retained failures.

| Verification | Result |
|---|---|
| Compiler / Rust workspace | 297 / 122 passed, zero failures |
| Blitz DOM | 73 passed; two existing failures |
| Blitz paint / HTML | 13 / 3 passed, zero failures |
| Parley std / engine | 162 passed with four existing failures / 39 passed |
| Stylo / Parley libm | 16 passed / check passed |
| Compiled tables, forms and controls | 389 states pass all three gates |

The existing failures are Blitz hover invalidation and scroll bubbling, and Parley's
four fontless cluster-position alignment tests. Parley std uses an exact-source
143-file test mirror with frozen manifests/lockfile and system-font features disabled.
System-font/default-feature tests, OS keyboard/pointer/IME delivery and the unavailable
named `/code-review` stage remain incomplete. Independent static and numerical reviews
supplement those stages without certifying them.

| Repository | Signed source revision tested |
|---|---|
| Compiler | `0b0518e4e44cb8f440a308fb9452e50f501213ad` |
| Blitz | `8251561557216bd9d248b5852cc59f0282a50cf5` |
| Parley | `27d8320695548514178fca3eea72a5157c424368` |
| Stylo | `568059da762e9ecfdd4c7d1b11474da82f37339c` |
| Vello, unchanged | `a8efce54ab03eb9d366ff0fe0d799758597b204f` |

The [JSON record](chromium-inline-boundaries.json) includes per-oracle counts,
remaining failures, source proofs and hashed evidence/observation manifests. All
nine older records, 1,654 evidence references and 194,588 observation references
remain unchanged. Canonical captures are retained; 2,224 bit-exact duplicate candidate
PNGs and task-owned temporary test/profile paths were removed after verification.
One existing isolated worktree per repository is retained, original trees are
unchanged, and no merge, push or milestone tag was performed.

The next useful slice is generic ordered span-edge flow and full-atom ownership.
Baseline-compatible shaping still leaves 21 intent and 60 history geometry/
fragment states failing. Horizontal margins/padding/borders require normalized
owner/start/end events, intrinsic sizing, whitespace rollback and saved-break replay
in Parley, with CSS resolution in Stylo/Blitz. First/last wrapped fragments, negative/
percentage edges, slice/clone and mutation need direct gates before another additive
API is frozen. The [targeted plan](../../docs/research/CHROMIUM-PARITY.md#next-ordinary-inline-slice-generic-edge-flow-and-ownership)
retains 60 margin hit losses and 132 omitted-control-margin geometry states. Complete
fragment segmentation, complex-script/bidi/caret behavior, quirks, tabs and editor/OS
delivery remain separate work.
