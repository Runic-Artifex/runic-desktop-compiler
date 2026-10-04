//! Layout reads and scrolling (CSSOM View) over Blitz's layout, with
//! Chromium's arithmetic: geometry in layout units of 1/64 px, integer
//! metrics pixel-snapped as Blink snaps them (`SnapSizeToPixel`), offsets
//! measured from the `offsetParent`'s padding edge without scroll.

use blitz_dom::{BaseDocument, ScrollBehavior};
use blitz_traits::node_id::NodeId;

/// A length in layout units (1/64 px, Blink's `LayoutUnit`).
fn lu(v: f64) -> i64 {
    (v * 64.0).round() as i64
}

/// `LayoutUnit::Round()`: half up.
fn round_lu(raw: i64) -> i64 {
    (raw + 32) >> 6
}

/// Blink's `SnapSizeToPixel(size, location)`: the snapped size of a box at
/// `location` (only the location's fraction matters).
fn snap_size(size: f64, location: f64) -> f64 {
    let fraction = lu(location) % 64;
    let size = lu(size);
    let snapped = round_lu(fraction + size) - round_lu(fraction);
    if snapped == 0 && size.abs() > 4 {
        return size.signum() as f64;
    }
    snapped as f64
}

fn style(doc: &BaseDocument, node: NodeId, property: &str) -> String {
    doc.resolved_style_value(node, property)
}

/// The root element scrolls the viewport.
fn is_root(doc: &BaseDocument, node: NodeId) -> bool {
    doc.try_root_element().is_some_and(|r| r.id == node)
}

fn element(doc: &BaseDocument, node: NodeId) -> Option<&blitz_dom::Node> {
    doc.get_node(node).filter(|n| n.element_data().is_some())
}

/// The node's border box position relative to the document, ignoring
/// scrolling (layout coordinates).
fn layout_position(doc: &BaseDocument, node: NodeId) -> (f64, f64) {
    let (mut x, mut y) = (0.0, 0.0);
    let mut current = doc.get_node(node);
    while let Some(n) = current {
        let l = n.unrounded_layout().location;
        x += l.x as f64;
        y += l.y as f64;
        current = n.containing_block().and_then(|p| doc.get_node(p));
    }
    (x, y)
}

/// Whether `node` qualifies as an `offsetParent` (positioned, or body, td, th).
fn is_offset_parent(doc: &BaseDocument, node: NodeId) -> bool {
    let Some(n) = element(doc, node) else {
        return false;
    };
    let tag = &*n.element_data().unwrap().name.local;
    style(doc, node, "position") != "static" || matches!(tag, "body" | "td" | "th")
}

/// `offsetLeft`/`offsetTop` in layout units, and the border box size.
fn offset_rect(doc: &BaseDocument, node: NodeId) -> Option<(f64, f64, f64, f64)> {
    let n = element(doc, node)?;
    let size = n.unrounded_layout().size;
    let (mut x, mut y) = layout_position(doc, node);
    // A fixed box has no offsetParent: measured from the document origin.
    let mut parent = n.parent.filter(|_| style(doc, node, "position") != "fixed");
    while let Some(p) = parent {
        if is_offset_parent(doc, p) {
            let pn = doc.get_node(p)?;
            let body = &*pn.element_data().unwrap().name.local == "body";
            if !(body && style(doc, p, "position") == "static") {
                let (px, py) = layout_position(doc, p);
                let border = pn.unrounded_layout().border;
                x -= px + border.left as f64;
                y -= py + border.top as f64;
            }
            break;
        }
        parent = doc.get_node(p).and_then(|n| n.parent);
    }
    Some((x, y, size.width as f64, size.height as f64))
}

/// The border box relative to the viewport. Blitz offsets a scroller by its
/// own scroll offset, which only moves its content: that is added back.
pub(crate) fn client_rect(doc: &BaseDocument, node: NodeId) -> Option<blitz_dom::BoundingRect> {
    let mut r = doc.get_client_bounding_rect(node)?;
    if !is_root(doc, node) {
        if let Some(n) = doc.get_node(node) {
            let s = n.scroll_offset();
            r.x += s.x;
            r.y += s.y;
        }
    }
    Some(r)
}

/// `getBoundingClientRect()`: x, y, width, height, top, right, bottom, left
/// (layout units, relative to the viewport).
pub(crate) fn rect(doc: &mut BaseDocument, node: NodeId) -> [f64; 8] {
    doc.resolve(0.0);
    let r = client_rect(doc, node).filter(|_| element(doc, node).is_some_and(|n| n.has_boxes()));
    let (x, y, w, h) = r.map_or((0.0, 0.0, 0.0, 0.0), |r| (r.x, r.y, r.width, r.height));
    [x, y, w, h, y, x + w, y + h, x]
}

/// The scroll offset of a scroller (the viewport's for the root element).
fn scroll_offset(doc: &BaseDocument, node: NodeId) -> (f64, f64) {
    if is_root(doc, node) {
        let s = doc.viewport_scroll();
        return (s.x, s.y);
    }
    element(doc, node).map_or((0.0, 0.0), |n| {
        let s = n.scroll_offset();
        (s.x, s.y)
    })
}

/// The viewport size in CSS pixels.
fn viewport(doc: &BaseDocument) -> (f64, f64) {
    let v = doc.viewport();
    let scale = v.scale() as f64;
    (
        v.window_size.0 as f64 / scale,
        v.window_size.1 as f64 / scale,
    )
}

/// An element metric (`offsetWidth`, `clientHeight`, `scrollTop`, …).
pub(crate) fn metric(doc: &mut BaseDocument, node: NodeId, name: &str) -> f64 {
    doc.resolve(0.0);
    let Some(n) = element(doc, node).filter(|n| n.has_boxes()) else {
        return 0.0;
    };
    let layout = *n.unrounded_layout();
    let border = layout.border;
    let scrollbar = layout.scrollbar_size;
    let (x, y) = (layout.location.x, layout.location.y);
    let (left, top) = (x as f64 + border.left as f64, y as f64 + border.top as f64);
    let client_w =
        (layout.size.width - border.left - border.right - scrollbar.width).max(0.0) as f64;
    let client_h =
        (layout.size.height - border.top - border.bottom - scrollbar.height).max(0.0) as f64;
    let root = is_root(doc, node);
    let (vw, vh) = viewport(doc);
    match name {
        "offsetWidth" | "offsetHeight" | "offsetLeft" | "offsetTop" => {
            let Some((ox, oy, w, h)) = offset_rect(doc, node) else {
                return 0.0;
            };
            match name {
                "offsetWidth" => snap_size(w, ox),
                "offsetHeight" => snap_size(h, oy),
                "offsetLeft" => round_lu(lu(ox)) as f64,
                _ => round_lu(lu(oy)) as f64,
            }
        }
        "clientWidth" if root => vw,
        "clientHeight" if root => vh,
        "clientWidth" => snap_size(client_w, left),
        "clientHeight" => snap_size(client_h, top),
        "clientLeft" => round_lu(lu(border.left as f64)) as f64,
        "clientTop" => round_lu(lu(border.top as f64)) as f64,
        "scrollWidth" | "scrollHeight" => {
            let overflow = layout.scrollable_overflow_rect;
            if name == "scrollWidth" {
                let w = client_w.max(overflow.right as f64);
                if root { vw.max(w) } else { snap_size(w, left) }
            } else {
                let h = client_h.max(overflow.bottom as f64);
                if root { vh.max(h) } else { snap_size(h, top) }
            }
        }
        "scrollLeft" => scroll_offset(doc, node).0,
        "scrollTop" => scroll_offset(doc, node).1,
        other => panic!("validated element metric {other}"),
    }
}

/// A window metric (`innerWidth`, `innerHeight`, `scrollX`, `scrollY`).
pub(crate) fn window_metric(doc: &mut BaseDocument, name: &str) -> f64 {
    doc.resolve(0.0);
    let (vw, vh) = viewport(doc);
    let s = doc.viewport_scroll();
    match name {
        "innerWidth" => vw,
        "innerHeight" => vh,
        "scrollX" => s.x,
        "scrollY" => s.y,
        other => panic!("validated window metric {other}"),
    }
}

/// Scroll `node` (none: the viewport) to or by `left`/`top`; an absent
/// coordinate keeps that axis. Returns the scroller when its offset changed.
pub(crate) fn scroll(
    doc: &mut BaseDocument,
    node: Option<NodeId>,
    by: bool,
    left: Option<f64>,
    top: Option<f64>,
) -> Option<NodeId> {
    doc.resolve(0.0);
    let target = match node {
        Some(n) => n,
        None => doc.try_root_element()?.id,
    };
    element(doc, target)?;
    let (cx, cy) = scroll_offset(doc, target);
    // Non-finite coordinates are 0 (CSSOM View).
    let finite = |v: f64| if v.is_finite() { v } else { 0.0 };
    let (x, y) = if by {
        (cx + left.map_or(0.0, finite), cy + top.map_or(0.0, finite))
    } else {
        (left.map_or(cx, finite), top.map_or(cy, finite))
    };
    // Scroll offsets are whole device pixels (scale 1), rounded as Chromium
    // rounds them.
    let (x, y) = (x.round(), y.round());
    doc.scroll_to(target, x, y, ScrollBehavior::Instant);
    (scroll_offset(doc, target) != (cx, cy)).then_some(target)
}

/// `scrollTop = v` / `scrollLeft = v`.
pub(crate) fn set_scroll(
    doc: &mut BaseDocument,
    node: NodeId,
    vertical: bool,
    value: f64,
) -> Option<NodeId> {
    if vertical {
        scroll(doc, Some(node), false, None, Some(value))
    } else {
        scroll(doc, Some(node), false, Some(value), None)
    }
}

/// Whether `node` is a scroll container (overflow other than visible/clip).
fn is_scroller(doc: &BaseDocument, node: NodeId) -> bool {
    ["overflow-x", "overflow-y"]
        .iter()
        .any(|p| matches!(style(doc, node, p).as_str(), "auto" | "scroll" | "hidden"))
}

/// The aligned scroll offset for a target edge range in a scrollport
/// (CSSOM View "determine the scroll-into-view position").
fn aligned(current: f64, port: f64, start: f64, size: f64, how: &str) -> f64 {
    let end = start + size;
    match how {
        "start" => start,
        "end" => end - port,
        "center" => start + size / 2.0 - port / 2.0,
        _ => {
            // nearest, as Blink aligns to the closest edge: no scroll when
            // fully visible, else the end edge when the box lies past the end
            // and is smaller, or before it and larger; else the start edge.
            let port_end = current + port;
            if start >= current && end <= port_end {
                current
            } else if (end > port_end && size < port) || (end < port_end && size > port) {
                end - port
            } else {
                start
            }
        }
    }
}

/// `scrollIntoView({block, inline})`: every scroll container from the
/// element outwards, then the viewport, aligns the element's border box.
/// Returns the scrollers whose offset changed, innermost first.
pub(crate) fn scroll_into_view(
    doc: &mut BaseDocument,
    node: NodeId,
    block: &str,
    inline: &str,
) -> Vec<NodeId> {
    doc.resolve(0.0);
    let mut changed = vec![];
    if element(doc, node).is_none_or(|n| !n.has_boxes()) {
        return changed;
    }
    let mut scrollers = vec![];
    let mut parent = doc.get_node(node).and_then(|n| n.parent);
    while let Some(p) = parent {
        if is_root(doc, p) {
            break;
        }
        if element(doc, p).is_some() && is_scroller(doc, p) {
            scrollers.push(p);
        }
        parent = doc.get_node(p).and_then(|n| n.parent);
    }
    let root = doc.try_root_element().map(|r| r.id);
    for scroller in scrollers.into_iter().map(Some).chain([None]) {
        let Some(target) = scroller.or(root) else {
            continue;
        };
        let r = rect(doc, node);
        let (cx, cy) = scroll_offset(doc, target);
        // The scrollport (padding box) in viewport coordinates.
        let (px, py, pw, ph) = match scroller {
            Some(s) => {
                let sr = rect(doc, s);
                let l = *doc.get_node(s).unwrap().unrounded_layout();
                (
                    sr[0] + l.border.left as f64,
                    sr[1] + l.border.top as f64,
                    (l.size.width - l.border.left - l.border.right - l.scrollbar_size.width) as f64,
                    (l.size.height - l.border.top - l.border.bottom - l.scrollbar_size.height)
                        as f64,
                )
            }
            None => {
                let (vw, vh) = viewport(doc);
                (0.0, 0.0, vw, vh)
            }
        };
        // The element's position in the scroller's content coordinates.
        let (sx, sy) = (r[0] - px + cx, r[1] - py + cy);
        let x = aligned(cx, pw, sx, r[2], inline);
        let y = aligned(cy, ph, sy, r[3], block);
        if let Some(t) = scroll(doc, Some(target), false, Some(x), Some(y)) {
            changed.push(t);
        }
    }
    changed
}
