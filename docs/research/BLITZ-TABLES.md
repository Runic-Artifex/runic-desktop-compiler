# Blitz table formatting experiment

Based on compiler commit `485fc86` and Blitz fork `e8dd36c6`, in isolated branches:

- Blitz: `table-layout`, `/home/viktor/Development/RunicArtifex/blitz-tables`.
- Compiler verification: `blitz-tables`, `/home/viktor/Development/RunicDesktopCompiler-tables`.
- Shared renderer: `runic-raster-parity`, `/home/viktor/Development/RunicArtifex/vello-raster-parity`, based on the existing Vello pin `2a06f3e9`.

The compiler worktree patches the existing local Blitz URL to the Blitz worktree's
packages and the existing Vello packages to the renderer worktree. Dependency
versions and other pins are unchanged. These branches are not integrated into
`main` or `m6`. Tables remain rejected by the compiler.

Blitz implementation: signed commits `3971a7ba`, `f85b2539` and `166f3a61`.
The follow-ups improve cell heights, collapsed-border painting and round-dot
geometry. Shared glyph painting lives in renderer commit `a8efce54`.
[Verification summary](../../conformance/results/blitz-tables.md).

The width and baseline rules follow [CSS 2 table layout](https://www.w3.org/TR/CSS2/tables.html); Chromium is the comparison oracle.

## Implementation

The table formatting context computes column min/max-content contributions,
including spanning cells, and distributes automatic widths between those bounds.
It handles definite/percentage widths, min/max widths, column widths, fixed-layout
first-row colspans, and retains the existing grid solver as a track-placement
primitive. Rowspans are bounded by their row group; zero spans cover its remaining
rows. Header/footer ordering is retained.

Rows and groups now participate in the layout/paint tree with actual boxes; cells
are rebased into those boxes. Row/group backgrounds are still painted at the table
behind the cells so they do not fill separated border-spacing. Captions are laid
out above/below the grid, including margins, and table decorations use the grid box.

Cell content gets top/middle/bottom/baseline alignment. Baseline rows accommodate
the maximum ascent and descent of different cells. Inline tables export the first
row baseline, using the bottom content edge when the row has no baseline-aligned
cells. Table-cell alignment is kept out of Parley's inline text alignment.

Collapsed borders resolve conflicts between cells, rows/groups, columns/groups
and the table (hidden, width, style, origin priority). Their used half-widths reach
both sizing and painting. Spanning cells suppress internal boundaries. RTL uses
logical column placement and physical border sides.

Cell heights are border-box minima. The cell's natural content layout remains
unconstrained, so oversized content grows the row. Non-spanning percentage cells
in a definite-height table reserve their row's share before automatic tracks
absorb remaining space; subsequent content and height mutations recompute it.

Shared border decorations snap in device space without rounding the layout.
Dashed borders fit complete endpoint dashes, thin dotted borders use square dots,
and thick dotted borders use explicit circles (the path stroker drops zero-length
dashes). Junction ownership includes width, normalized style, origin and source
order. Groove/ridge and inset/outset share the collapsed-style normalization in
both conflict resolution and painting, with canonical top/left edge shading.

Ordinary cell backgrounds, including gradients, paint before shared borders.
Independent cell paint layers retain their normal opacity and foreground phase;
their backgrounds are clipped inside the shared borders. Hidden cell backgrounds
are omitted. These rules follow the
[Chromium table painter](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/paint/table_painters.cc),
[border painter](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/core/paint/box_border_painter.cc)
and [stroke fitting](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/platform/graphics/styled_stroke_data.cc).

Round dots are flattened explicitly at 0.01 device pixels before the backend's
general curve flattening. Its 0.25px tolerance had visibly reduced the area of
small circles. The helper is shared with ordinary dotted borders; it changes
neither table layout nor border conflict resolution. Later CSS transforms may
scale the approximation; transformed/DPR cases still need broader verification.

Text fixes live in Glifo, not in the table context or Blitz text painter. Hinted
outlines use quarter-pixel horizontal device origins, including run translation
and scale, and the atlas bucket wraps with the matching integer carry. TrueType
outlines use light auto hinting, following
[Skia's Fontations light-hinting policy](https://github.com/google/skia/blob/main/src/ports/fontations/src/hinting.rs).
Linear advances remain the layout engine's. Other outline formats retain their
previous hinting policy; unhinted and rotated outlines retain their transforms.
This is a shared renderer experiment verified on Linux CPU, not certification
of CFF/variable fonts, other platforms or the research Vello GPU text path.

Table boxes retain fractional layout coordinates in the final layout. Whole-pixel
rounding had changed text positions and boundary hits despite correct CSSOM rects.
Internal group/gap boxes do not intercept hits, and row clicks reach descendants
whose DOM ancestors include the row. These are internal hit tests, not OS input
certification.

## Reproduce

Use this worktree's locked flake environment and the shared target. The worktree reuses M6's existing `node_modules` through a symlink; it does not install another toolchain. From its root:

```sh
nix develop . -c node conformance/tables.mjs
```

The oracle builds the probe and holds the project PID lock through observation,
so another worktree cannot remove the probe during a run. It uses the locked full
Chromium, an embedded DejaVu Sans font, a 640x300 viewport and unchanged DOM operations in both renderers. It compares every
id's rect at 1/8px tolerance, three hit targets per id, full-page pixels, and pixels
cropped to the table region at 3/255 MAE. It retains failures; it exits nonzero if
any geometry, hit or cropped pixel check fails. Selected case names can be passed
as arguments. Table, ordinary-border and glyph controls are reported separately;
the latter two isolate shared painting from table layout. Environment, font,
binary and input hashes are retained alongside the observations. Dynamic cases
change contents, widths, spans, caption side and cell
alignment and absolute/percentage heights. Six font-independent native regression
tests are also provided in the Blitz worktree and the compiler's `table-probe` test module.

Results and screenshots are generated in `artifacts/tables/`; only short summaries
are committed. Build, npm and Cargo logs are retained there.

## Remaining scope

This is an implementation attempt, not a claim of general Chromium parity.
The direct oracle does not certify OS input, accessibility, pagination, anonymous
boxes for misparented CSS table parts, positioned internal table containing blocks,
arbitrary caption/table effects and clipping, overconstrained percentage rows,
percentage spanning/calc constraints, empty-cells/visibility-collapse semantics,
or row/group effects and image backgrounds on internal table boxes. All three
previous table-region failures now pass. The wider controls retain two dense
fractional-origin text failures and a rounded ordinary dotted-border paint/hit
failure. No tolerance relaxation is included. The layout currently performs extra
cell layout passes for baselines and alignment; no
performance improvement is claimed. Compiler table acceptance waits for the
practical integration gate and framework conformance. Nothing has been offered
upstream yet. The [targeted Chromium parity plan](CHROMIUM-PARITY.md) assigns the
remaining work to its modules and defines the next gates.
