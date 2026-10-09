# Chromium parity: private content-flow views

Parley now has private borrowed `ContentFlow` and `BoxFlow` iterators over current
committed lines. Ordinary-span bounds use whole shaping atoms and in-flow box
advances. Empty-anchor box positions keep their existing run-grouped arithmetic.
The views retain visual origins, global box ordinals and bidi side, clone on
demand, and read current alignment and justification without a positioned cache.
Nine focused tests cover shaping atoms, real glyphless content, box kinds,
replay, cloning and exact floating-point compatibility with the old formulas.

This is a behavior-preserving extraction under the
[ADR](../../docs/ARCHITECTURE.md#chromium-parity-private-visual-content-flow-2026-10-09-isolated).
It adds no used span-edge advances, public API, paint, caret or selection change.
The two views deliberately preserve different accumulation and out-of-flow
policies. A later effective edge path must define shared positions for every
consumer before consuming nonzero edges.

All 48 serial commands completed against five clean signed source heads. Root
and independent audits agree on 4,820 exact before/after pairs across 35 direct
matrices: all result JSONs, native state JSONs and whole screenshots are unchanged.
Every eligible gate has zero repairs and zero regressions. The extraction and
zero-regression checks pass; absolute Chromium parity retains 761 geometry and
3,391 strict pixel failures. All 389 compiled table/form/focus/control states
pass semantics, geometry and strict pixels, including selected GPU tables.

The additive [driving oracle](../inline-edge-drivers.mjs) has 27 states at DPR
1, 1.25 and 2. Its negative opening margin changes wrapping from 32px to 64px and
back. A controlling min-content edge changes width from 50.28125px to 60.4375px
and back. Immediate `br` closing decoration has one observed fragment, distinct
from the retained intervening-empty-child reduction. These browser observations
drive future implementation; they do not instrument internal overflow recovery,
cache identity or the intrinsic branch. Initial-style prerequisites cover initial
states only.

| New driving oracle | Passed / measured |
|---|---:|
| Geometry / client fragments | 3 / 27 each |
| Rectangle-relative hits | 24 / 27 |
| Explicit point hits | 18 / 27 |
| Strict viewport/container/local pixels | 0 / 27 |

Compiler and Rust workspace checks pass 297 and 122 tests. Blitz DOM remains
76 passed with two existing failures; Parley std is 200 passed with four existing
fontless cluster-position failures. Those two suites remain unpassed. Blitz paint
and HTML pass 13 and 3 tests, Parley engine passes 39, Stylo passes 16, and Parley
libm checks successfully. The exact-source Parley mirror contains 148 files.
Initial focused attempts exposed a generic ownership compile error and incorrect
test assumptions about SHY glyphs and caller-managed out-of-flow breaking. The
corrected nine-test run passes; the failed attempts and corrections are retained.

All 9,640 raw states validate. The completeness check finds 108,718 required
observations and crops; 130 null local measurements have empty clipped unions
and remain unmeasured. Direct geometry stays at 0.125 CSS px, line widths at
0.02 CSS px, strict MAE at 3/255 and compiled geometry at 2 CSS px. Audits validate
recorded finite metrics and corresponding files without independently recomputing
PNG MAEs. Twelve prior records, 2,266 evidence references and 472,717 observation
references remain intact. The [JSON record](chromium-inline-flow-views.json)
authenticates 211 evidence files and 97,499 canonical observations.

Tested heads are compiler `194e7cd`, Parley `4105c65`, Blitz `f7d0a01`, Stylo
`568059d` and Vello `a8efce5`. System-font/default-feature tests, OS keyboard,
pointer and IME delivery, and the unavailable named `/code-review` stage remain
incomplete. The original checkouts were unchanged throughout this verification.

Next, consolidate these reviewed forks and Opus's hover implementation into the
canonical checkouts using exact Git pins. Form submission follows that checkpoint.
Then continue the [ordinary-inline plan](../../docs/research/CHROMIUM-PARITY.md#next-ordinary-inline-slice-generic-edge-flow-and-ownership):
fixed signed advances, breaker rollback and intrinsic sizing, consistent paint
and editing positions, followed by refreshed percentage/calc edges and wrapped
slice/clone decoration. Keep CSS resolution in Blitz and generic flow in Parley.
