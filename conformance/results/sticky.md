# position: sticky (2026-10-13)

CSS compatibility slice 1: the compiler's `position: sticky` guard (`E_CSS_PROPERTY`) is lifted. Three fork commits:

- Blitz `40f7e900` *Constrain sticky boxes to the scrollport without its padding, as Chromium does* and `ceb522c3` *Paint table-part backgrounds in the layer of a sticky row group, row or cell* (branch `position-sticky` on `runic` `c8760598`);
- Parley `9baa4d1a` *Keep adjacent inline boxes of a nowrap span on one line* (branch `position-sticky` on `runic` `7e728565`).

Chromium 153.0.8010.12, CPU renderer.

## Chromium's rules (Blink at 153.0.8010.12)

- **View rectangle.** `LayoutBox::ComputeStickyConstrainingRect`: the scroll container's overflow clip rect without its borders, contracted by its padding. Percentage insets resolve against its size. Blitz used the padding box.
- **Containing block.** `ComputeStickyPositionConstraints`: the containing block's padding box contracted by its padding and by the sticky box's margins (`LayoutIgnoreMarginsForSticky` has no status, so it is off); anonymous containing blocks are skipped. When both insets of an axis cannot hold, the end inset gives way, or the start one where the sticky container's direction is flipped (`IsFlippedX`, right-to-left).
- **Offsets.** `StickyPositionScrollingConstraints::ComputeOffset`: the end inset first, then the start inset, each limited by the containing block; ancestor sticky offsets shift the box and, between the containing block and the scroll container, the containing block too.
- **Table parts.** A sticky row group, row or cell is a stacking context, and the backgrounds of its table parts are painted in its layer, so they move with it.
- **Inline boxes.** A sticky ordinary inline box is offset by its lines' bounding box.

## What was wrong, and the fixes

- The view rectangle and percentage insets (above): `top: 0` in a pane with 14px top padding stuck at the pane's border (Chromium: 14px below it), and `top: 10%`, `left: 5%` resolved against the padding box.
- A sticky header row group's background stayed at its laid-out position, which the table root painted: the stuck header row had no background, and body cells scrolled under it showed through.
- `white-space: nowrap` did not hold two adjacent inline-blocks together (Parley): a strip of chips with a sticky end (`right: 0`) broke onto two lines, so the end never stuck.
- Sticky ordinary inline boxes stay in flow in Blitz: they are now reported (`take_unsupported_layout_reports`, then `unsupported` at run time).

## Verification

- **Compiled case `sticky`** (fixture `sticky-svelte`): the shadcn-svelte site's header, docs sidebar (`top: calc(var(--header-height) + 0.6rem)`, its own scrolling, a sticky fade at `bottom: -4px`) and table of contents (`overflow: hidden`, a sticky title), a data table with a sticky header row group and a sticky first column scrolled both ways, a dialog body with a sticky footer, a sticky box in a grid area, nested scroll containers with a sticky header each, a strip with a sticky end, and the sidebar and contents pushed by the end of their containing block; 15 wheel turns and clicks on stuck buttons. It passes semantics, geometry and pixels at 800x600 and 420x600 (`node conformance/run.mjs sticky --pixels`). At the old pins it is rejected at build time (`E_CSS_PROPERTY`).
- **Rendering cases** (`node conformance/scrolling.mjs`, HTML in Chromium and Blitz's probe, 0.125 px geometry, 3/255 pixels, hit testing): the nine earlier sticky cases and twelve new ones (`sticky_padding`, `sticky_percent`, `sticky_margins`, `sticky_flex_grid`, `sticky_thead`, `sticky_thead_collapse`, `sticky_transformed`, `sticky_no_overflow`, `sticky_in_sticky`, `sticky_negative_bottom`, `sticky_right`, `sticky_fractional`) pass all 148 steps at 420x300 and 800x300. At the old pins `sticky_padding`, `sticky_percent`, `sticky_thead` and `sticky_right` failed (geometry up to 440px, region pixels up to 32/255).
- **Fork tests:** Blitz `blitz-dom` 175 passed (new: `sticky_view_excludes_scroll_container_padding`, `sticky_percentages_resolve_against_the_sticky_view`, `sticky_inline_box_is_reported`), failing only the known `hover_styles_apply_and_clear` and `scroll_by_clamps_and_bubbles`; Parley `parley_tests` 241 passed (new: `text_wrap_mode_nowrap_keeps_adjacent_inline_boxes_together`), failing only `cursor_next_visual` and `cursor_previous_visual`, which fail at `runic` `7e728565` too.
- **Render census** (10 examples with nowrap inline content and tables: badge-demo, badge-variants, button-demo, kbd-demo, kbd-group-demo, input-group-kbd, table-demo, typography-table, tabs-demo, toggle-group-demo)): all 10 match (`node conformance/render-census.mjs <examples>`, evidence in the main tree's `artifacts/css/position-sticky/render-census`). No lowered census example uses `position: sticky` (the site uses it in its layout, and dialog-sticky-footer does not lower for another reason).

## Left open

- Sticky ordinary inline boxes (reported).
- Vertical writing modes and fragmentation, which Blitz does not lay out at all.
