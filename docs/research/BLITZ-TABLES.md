# Blitz table formatting experiment

Based on compiler commit `485fc86` and Blitz fork `e8dd36c6`, in isolated branches:

- Blitz: `table-layout`, `/home/viktor/Development/RunicArtifex/blitz-tables`.
- Compiler verification: `blitz-tables`, `/home/viktor/Development/RunicDesktopCompiler-tables`.

The compiler worktree patches the existing local Blitz URL to the Blitz worktree's
packages. All other dependency pins are unchanged. Neither branch is integrated
into `main` or `m6`. Tables remain rejected by the compiler.

Blitz implementation: signed commit `3971a7ba`. [Verification summary](../../conformance/results/blitz-tables.md).

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

Table boxes retain fractional layout coordinates in the final layout. Whole-pixel
rounding had changed text positions and boundary hits despite correct CSSOM rects.
Internal group/gap boxes do not intercept hits, and row clicks reach descendants
whose DOM ancestors include the row. These are internal hit tests, not OS input
certification.

## Reproduce

Use this worktree's locked flake environment and the shared target. The worktree reuses M6's existing `node_modules` through a symlink; it does not install another toolchain. From its root:

```sh
nix develop . -c bash -c 'export RUNIC_TARGET_DIR=/home/viktor/Development/RunicDesktopCompiler/target; node compiler/cargo.mjs build --offline -p runic-blitz-probes --bin table-probe'
nix develop . -c node conformance/tables.mjs
```

The Node oracle uses the locked full Chromium, an embedded DejaVu Sans font, a
640x300 viewport and unchanged DOM operations in both renderers. It compares every
id's rect at 1/8px tolerance, three hit targets per id, full-page pixels, and pixels
cropped to the table region at 3/255 MAE. It retains failures; it exits nonzero if
any geometry, hit or cropped pixel check fails. Selected case names can be passed
as arguments. Dynamic cases change contents, widths, spans, caption side and cell
alignment. Four font-independent native regression tests are also provided in the
Blitz worktree and the compiler's `table-probe` test module.

Results and screenshots are generated in `artifacts/tables/`; only short summaries
are committed. Build, npm and Cargo logs are retained there.

## Remaining scope

This is an implementation attempt, not a claim of general Chromium parity.
The direct oracle does not certify OS input, accessibility, pagination, anonymous
boxes for misparented CSS table parts, positioned internal table containing blocks,
caption/table effects and clipping, arbitrary percentage spanning constraints,
empty-cells/visibility-collapse semantics, or image backgrounds on internal table
boxes. Three-dimensional border styles still need proper painting; dashed/dotted
collapsed border patterns and junctions need pixel-level follow-up. The layout
currently performs extra cell layout passes for baselines and alignment; no
performance improvement is claimed. Compiler table acceptance waits for the
remaining renderer cases and framework conformance. Nothing has been offered
upstream yet.
