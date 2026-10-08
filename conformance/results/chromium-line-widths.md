# Chromium line-width geometry

The measured fractional-DPR control-box gap is closed in the isolated branches.
The retained text, input-height and pointer matrices now pass geometry **432/432,
504/504 and 264/264**, respectively. Text hits improve **280→408/432** and input
hits **336→504/504**; editor-state and pixel counts stay unchanged. The remaining
24 text hit failures are tiny baseline-marker edge probes. This is geometry and
computed-style parity, with raster and interaction gaps still open.

This continues [text metrics](chromium-text-metrics.md) in the same one experiment
worktree per repository. Verified source is compiler `99c16ca`, Blitz `35bc90b5`,
Stylo `f0e404e2d`, Parley `ac9bed8` and Vello `a8efce54`. All source commits are
signed and original checkouts remain unchanged. The [machine record](chromium-line-widths.json)
retains exact revisions, commands, independent gates, environment and evidence
hashes. Local overrides still require reviewed reproducible pins before integration.
The final record commit adds documentation/results and a rustfmt-only assertion
wrap; its probe source matches the verified revision after formatting.

## Ownership and contract

Stylo's Servo `Device` exposes additive `LineWidthRounding::{DevicePixel,CssPixel}`
and a consuming builder method. **DevicePixel remains the default** and preserves
the old conversion; Gecko is unchanged. Blitz selects CssPixel in its shared
device factory, including rebuilds. No framework-specific lowering, DOM geometry
facade or painter compensation is introduced.

CssPixel resolves the length after effective CSS zoom and before viewport scaling:
zero stays zero; any positive subpixel becomes one CSS layout pixel; larger values
truncate. The positive/fractional value is retained before integer app-unit
conversion, so `.001px` survives and `1.999px` does not round up to two first.
Keywords use effective CSS zoom too. Border and outline widths share the policy;
text stroke, radii, ordinary lengths, outline offsets and physical hairlines do not.
`column-rule-width` is Gecko-only and outside the Servo branch.

The [ADR](../../docs/ARCHITECTURE.md#chromium-parity-line-width-rounding-2026-10-08-isolated)
freezes the public default and ownership. Chromium's
[converter](https://raw.githubusercontent.com/chromium/chromium/main/third_party/blink/renderer/core/css/resolver/style_builder_converter.cc)
explains its layout rounding; the CSS Values
[line-width algorithm](https://drafts.csswg.org/css-values-4/#snap-a-length-as-a-border-width)
uses device pixels. The opt-in policy therefore targets Chromium compatibility
without changing Servo's default. Moving source links explain the implementation;
**Chromium 153.0.8010.12** is the pinned behavior oracle.

A policy change through `Stylist::set_device` reports all origins for invalidation,
which Blitz's existing device replacement path consumes. The cache regression
checks computed widths and the raw Taffy layout input changing **1→0.8→1px** at
DPR 1.25, with physical hairlines still **48 app units**. It checks raw layout
before ordinary block rounding, rather than assuming a fractional computed border
must survive that later operation unchanged. The native probe verifies tiny and
near-integer widths, all four sides and outlines through DPR 1→1.25→1.5→2→1.

## Verification

Resolved line widths have a new independent **0.02 CSS px** gate. Existing direct
geometry stays **0.125 CSS px**, compiled geometry **2 CSS px**, and local pixels
**MAE 3/255**. No existing case, ID, state, reference or tolerance was removed or
relaxed. The paired width matrix has identical HTML hashes and state order; its
fixture/action and harness sources differ only in formatting between baseline
and final. All eighteen retained matrices preserve their inputs and state order.

| New oracle | States | Geometry before→after | Resolved widths before→after | Hits | Local pixels before→after |
|---|---:|---:|---:|---:|---:|
| Line-width grid | 176 | 116→176 | 110→176 | 176 | 25→30 |
| Line-width effects | 76 | —→76 | —→76 | 76 | —→45 |

The grid covers ordinary boxes, inputs, textareas and buttons, zero/tiny/fractional/
keyword/calc widths, CSS zoom 0.5/1.25/2, inheritance, `none`/`hidden` and mutations,
at DPR 1/1.25/1.5/2. The supplemental oracle has 36 zoomed-keyword states, 16 logical
side/direction-mutation states and 24 animation states. The latter samples a 1→4px
border/outline animation at 0/25/50/75/100/125ms; both engines report widths
1/1/2/3/4/4 at DPR 1. This certifies those samples, not arbitrary transitions,
additivity or animated CSS-zoom interaction.

| Retained oracle | States | Geometry | Hits | Editor | Scroll | Local pixels |
|---|---:|---:|---:|---:|---:|---:|
| text-metric-grid | 432 | 432 | 408 | 432 | 432 | 48 |
| input-line-height | 504 | 504 | 504 | 504 | 504 | 134 |
| input-pointer | 264 | 264 | 264 | 231 | 264 | 13 |
| control-document-mode | 132 | 92 | 120 | 132 | 132 | 84 |
| control-layout | 264 | 132 | 264 | 264 | 264 | 0 |
| control-selection | 48 | 48 | 48 | 48 | 48 | 12 |
| control-focus | 252 | 252 | 252 | 252 | 252 | 164 |
| tables | 77 | 77 | 77 | 77 | 77 | 74 |
| table-document-mode | 12 | 12 | 12 | 12 | 12 | 12 |
| table-controls | 4 | 4 | 2 | 4 | 4 | 4 |
| table-integration | 30 | 22 | 24 | 30 | 30 | 23 |
| controls | 9 | 8 | 8 | 9 | 9 | 6 |
| scrolling | 148 | 148 | 148 | 148 | 148 | 148 |
| css-animations | 40 | 40 | 40 | 40 | 40 | 40 |
| intrinsic-text | 30 | 30 | 30 | 30 | 30 | 20 |
| font-weights | 36 | 12 | 28 | 36 | 36 | 16 |
| glyphs | 38 | 38 | 38 | 38 | 38 | 4 |
| borders | 7 | 7 | 7 | 7 | 7 | 0 |

Compiled tables pass every gate across 96 CPU and 32 selected GPU states;
forms/focus pass 242 states, and button/inline regressions pass 19. The worst local
MAEs remain 1.270, 2.396, 0.388 and 0.594, respectively. The complete direct
verification contains **2,579 states** across twenty matrices.

Compiler tests pass **297/297**, including frontend TypeScript checking. The Rust
workspace passes **119/119**. The focused Stylo regression passes **1/1**; Blitz
paint passes **8/8** and HTML **3/3**. Blitz DOM passes **51**, including the new
policy/cache test, and retains the same two known failures. Earlier failed focused
attempts are retained: a missing test import and incorrect assumptions about
ordinary block rounding were corrected before the complete verification.

No previously passing geometry, hit, editor, scroll or local pixel gate regressed
in the eighteen retained matrices. The paired new width matrix also has no pixel
pass regression. New geometry gains do not imply pixel completion: text remains
48/432, input height 134/504 and pointer crops 13/264; the new width/effects
matrices retain 146 and 31 pixel failures, respectively.

Two scrolling crops remain offscreen/unmeasured; full-screen and available crops
pass. The two pixel failures exposed by the prior text-metric repair remain open;
they are not new failures from this continuation. Root and read-only agent reviews
found no remaining blocker. `/code-review` is unavailable, so that named tool stage
is incomplete. Gecko was source-reviewed, not built. Parley and Vello are unchanged;
the previous Parley std/libm evidence and fontless/system-font limitations remain
in the linked text-metric record. Internal events do not certify OS delivery/IME.

## Next useful parity work

[The updated plan](../../docs/research/CHROMIUM-PARITY.md) keeps owners and gates
separate. Next reduce ordinary inline span font bounds and margins, sharing fragment
geometry with DOM reads and hits. Then close selected-text click/drag initiation and
RTL editor alignment (33 retained pointer-state failures), and glyph/outline raster
placement, including the two previously exposed input crops. Native theme paint,
font instances/order, document-mode edges and text-measurement cost retain their
own reductions. Geometry success alone does not promote the isolated branch to the
shipping contract.
