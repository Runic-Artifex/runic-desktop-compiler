//! Layout reads and scrolling (CSSOM View) over Blitz's layout, with
//! Chromium's arithmetic: geometry in layout units of 1/64 px, integer
//! metrics pixel-snapped as Blink snaps them (`SnapSizeToPixel`), offsets
//! measured from the `offsetParent`'s padding edge without scroll.

use blitz_dom::{BaseDocument, ScrollBehavior};
use blitz_traits::node_id::NodeId;

thread_local! {
    /// Scrollers whose offset a layout clamped, not yet seen by a frame.
    static CLAMPED: std::cell::RefCell<Vec<NodeId>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Resolve layout and retain layout-induced scroll changes for the next
/// frame's scroll events. Blitz owns clamping and anchoring; capture before
/// resolving so those operations cannot hide a changed offset from Runic.
pub(crate) fn resolve(doc: &mut BaseDocument) {
    crate::timeline::resolve(doc);
}

/// Every timeline resolution can clamp or anchor a scroller, including the
/// animation and focus lifecycle steps that precede `layout_frame`.
pub(crate) fn capture_scroll_offsets(doc: &BaseDocument) -> Vec<(NodeId, (f64, f64))> {
    let root = doc.try_root_element().map(|r| r.id);
    let mut before: Vec<_> = doc
        .tree()
        .iter()
        .filter(|(id, n)| {
            Some(*id) != root
                && n.element_data().is_some()
                && n.scroll_position() != blitz_dom::Point::ZERO
        })
        .map(|(id, n)| (id, (n.scroll_position().x, n.scroll_position().y)))
        .collect();
    if let Some(root) = root.filter(|_| doc.viewport_scroll() != blitz_dom::Point::ZERO) {
        before.push((root, scroll_offset(doc, root)));
    }
    before
}

pub(crate) fn record_layout_scroll_changes(
    doc: &BaseDocument,
    mut before: Vec<(NodeId, (f64, f64))>,
) {
    if before.is_empty() {
        return;
    }
    let order = crate::events::tree_order(doc);
    before.retain(|(id, _)| order.contains(id));
    before.sort_by_key(|(id, _)| order.iter().position(|x| x == id));
    for (node, offset) in before {
        if scroll_offset(doc, node) != offset {
            CLAMPED.with(|c| {
                let mut c = c.borrow_mut();
                if !c.contains(&node) {
                    c.push(node);
                }
            });
        }
    }
}

/// The scrollers clamped since the last call: a frame's lifecycle queues
/// their `scroll` events (Chromium: clamped in a task or a frame's layout,
/// the event is dispatched in the rendering step of the frame after).
pub(crate) fn take_clamped() -> Vec<NodeId> {
    CLAMPED.with(|c| std::mem::take(&mut *c.borrow_mut()))
}

/// Whether a layout clamped a scroller that no frame has seen yet.
pub(crate) fn any_clamped() -> bool {
    CLAMPED.with(|c| !c.borrow().is_empty())
}

/// Whether any scroller is scrolled (only then can a layout clamp).
pub(crate) fn any_scrolled(doc: &BaseDocument) -> bool {
    doc.viewport_scroll() != blitz_dom::Point::ZERO
        || doc.tree().iter().any(|(_, n)| {
            n.element_data().is_some() && n.scroll_position() != blitz_dom::Point::ZERO
        })
}

/// A length in layout units (1/64 px, Blink's `LayoutUnit`).
pub(crate) fn lu(v: f64) -> i64 {
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

/// Whether an element is rendered with boxes: it has boxes of its own (in
/// the document, not `display: none` or `contents`) and no ancestor is
/// `display: none`. Others have an empty rectangle at the origin.
pub(crate) fn rendered(doc: &BaseDocument, node: NodeId) -> bool {
    let Some(n) = element(doc, node).filter(|n| n.has_boxes()) else {
        return false;
    };
    let mut current = n.parent.and_then(|p| doc.get_node(p));
    while let Some(a) = current {
        if a.primary_styles()
            .is_some_and(|s| s.clone_display().is_none())
        {
            return false;
        }
        current = a.parent.and_then(|p| doc.get_node(p));
    }
    true
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

/// The visual border box relative to the viewport, using Blitz's shared
/// sticky, scrolling and transform geometry.
pub(crate) fn client_rect(doc: &BaseDocument, node: NodeId) -> Option<blitz_dom::BoundingRect> {
    doc.get_transformed_client_bounding_rect(node)
}

/// `getBoundingClientRect()`: x, y, width, height, top, right, bottom, left
/// (layout units, relative to the viewport).
pub(crate) fn rect(doc: &mut BaseDocument, node: NodeId) -> [f64; 8] {
    resolve(doc);
    let r = client_rect(doc, node).filter(|_| rendered(doc, node));
    let (x, y, w, h) = r.map_or((0.0, 0.0, 0.0, 0.0), |r| (r.x, r.y, r.width, r.height));
    [x, y, w, h, y, x + w, y + h, x]
}

/// Elements of inline display that are atomic inline boxes (one box, not
/// line fragments).
const ATOMIC: [&str; 9] = [
    "img", "svg", "canvas", "video", "embed", "iframe", "input", "textarea", "button",
];

/// Whether `node` is a non-atomic inline box (its content flows in its
/// inline root's text, without a box of its own).
pub(crate) fn non_atomic_inline(doc: &BaseDocument, node: NodeId) -> bool {
    use style::values::specified::box_::{DisplayInside, DisplayOutside};
    let Some(n) = doc.get_node(node) else {
        return false;
    };
    let Some(display) = n.primary_styles().map(|s| s.clone_display()) else {
        return false;
    };
    display.outside() == DisplayOutside::Inline
        && display.inside() == DisplayInside::Flow
        && !n.flags.is_inline_root()
        && !n
            .element_data()
            .is_some_and(|e| ATOMIC.contains(&&*e.name.local))
}

/// What an IntersectionObserver computes for a target (M6 overlays):
/// rectangles as x, y, width, height in viewport coordinates.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Intersection {
    /// The target's bounding box (`getBoundingClientRect`).
    pub target: [f64; 4],
    /// The part of it inside its clipping ancestors and the root.
    pub intersection: [f64; 4],
    /// The root intersection rectangle: the viewport grown by the margins.
    pub root: [f64; 4],
    /// Whether target and root intersect (edge-adjacent ones do).
    pub intersecting: bool,
    pub ratio: f64,
}

/// The edge-inclusive intersection of two rectangles, if they intersect.
fn inclusive_intersect(a: [f64; 4], b: [f64; 4]) -> Option<[f64; 4]> {
    let x0 = a[0].max(b[0]);
    let y0 = a[1].max(b[1]);
    let x1 = (a[0] + a[2]).min(b[0] + b[2]);
    let y1 = (a[1] + a[3]).min(b[1] + b[3]);
    (x1 >= x0 && y1 >= y0).then_some([x0, y0, x1 - x0, y1 - y0])
}

/// The IntersectionObserver geometry of `node` with the document's
/// viewport as root (the implicit root and `root: document` of a top-level
/// document): its bounding box clipped by each ancestor of its containing
/// block chain that clips overflow (to the padding box), then by the root
/// intersection rectangle. A target without boxes does not intersect.
/// Clipping under a transformed ancestor and `clip-path` are not covered
/// (reported unsupported).
pub(crate) fn intersection(
    doc: &mut BaseDocument,
    node: NodeId,
    margins: &[runic_js::intersection::Margin; 4],
) -> Intersection {
    resolve(doc);
    let (vw, vh) = viewport(doc);
    let root = {
        let [top, right, bottom, left] = *margins;
        let (t, r, b, l) = (
            top.resolve(vh),
            right.resolve(vw),
            bottom.resolve(vh),
            left.resolve(vw),
        );
        [-l, -t, (vw + l + r).max(0.0), (vh + t + b).max(0.0)]
    };
    let none = Intersection {
        target: [0.0; 4],
        intersection: [0.0; 4],
        root,
        intersecting: false,
        ratio: 0.0,
    };
    let Some(r) = client_rect(doc, node).filter(|_| rendered(doc, node)) else {
        return none;
    };
    let target = [r.x, r.y, r.width, r.height];
    let mut clipped = Some(target);
    let mut current = doc.get_node(node).and_then(|n| n.containing_block());
    while let (Some(id), Some(rect)) = (current, clipped) {
        let Some(a) = doc.get_node(id) else { break };
        if is_root(doc, id) {
            break;
        }
        // A translation (floating-ui positions floating elements with one:
        // a submenu's anchor) moves the ancestor's box, which `client_rect`
        // gives as it is drawn; other transforms are not covered.
        if let Some(t) = a.transform().as_deref() {
            let [xx, yx, xy, yy, _, _] = t.as_coeffs();
            if xx != 1.0 || yx != 0.0 || xy != 0.0 || yy != 1.0 {
                crate::unsupported(
                    "IntersectionObserver of a target under an ancestor transformed other than by a translation",
                );
            }
        }
        if style(doc, id, "clip-path") != "none" {
            crate::unsupported("IntersectionObserver of a target under a clip-path");
        }
        let (ox, oy) = (style(doc, id, "overflow-x"), style(doc, id, "overflow-y"));
        if ox != "visible" || oy != "visible" {
            if let Some(b) = client_rect(doc, id) {
                let l = *a.unrounded_layout();
                let px = b.x + l.border.left as f64;
                let py = b.y + l.border.top as f64;
                let pw = (b.width
                    - (l.border.left + l.border.right + l.scrollbar_size.width) as f64)
                    .max(0.0);
                let ph = (b.height
                    - (l.border.top + l.border.bottom + l.scrollbar_size.height) as f64)
                    .max(0.0);
                // An axis whose overflow is visible is not clipped.
                let big = f64::MAX / 4.0;
                let clip = [
                    if ox == "visible" { -big } else { px },
                    if oy == "visible" { -big } else { py },
                    if ox == "visible" { 2.0 * big } else { pw },
                    if oy == "visible" { 2.0 * big } else { ph },
                ];
                clipped = inclusive_intersect(rect, clip);
            }
        }
        current = a.containing_block();
    }
    let Some(inter) = clipped.and_then(|c| inclusive_intersect(c, root)) else {
        return Intersection { target, ..none };
    };
    let area = target[2] * target[3];
    let ratio = if area > 0.0 {
        inter[2] * inter[3] / area
    } else {
        1.0
    };
    Intersection {
        target,
        intersection: inter,
        root,
        intersecting: true,
        ratio,
    }
}

/// `getClientRects()`: the border box (as [`rect`]), none without a box.
pub(crate) fn client_rects(doc: &mut BaseDocument, node: NodeId) -> Vec<[f64; 8]> {
    resolve(doc);
    if client_rect(doc, node).is_none() || !rendered(doc, node) {
        return vec![];
    }
    if non_atomic_inline(doc, node) {
        crate::unsupported("getClientRects of an inline element (one rect per line box)");
    }
    vec![rect(doc, node)]
}

/// The scroll offset of a scroller (the viewport's for the root element).
fn scroll_offset(doc: &BaseDocument, node: NodeId) -> (f64, f64) {
    if is_root(doc, node) {
        let s = doc.viewport_scroll();
        return (s.x, s.y);
    }
    element(doc, node).map_or((0.0, 0.0), |n| {
        let s = n.scroll_position();
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
    resolve(doc);
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
                let w = if n
                    .element_data()
                    .is_some_and(|e| e.text_input_data().is_some())
                {
                    n.scroll_width() as f64
                } else {
                    client_w.max(overflow.right as f64)
                };
                if root { vw.max(w) } else { snap_size(w, left) }
            } else {
                let h = if n
                    .element_data()
                    .is_some_and(|e| e.text_input_data().is_some())
                {
                    n.scroll_height() as f64
                } else {
                    client_h.max(overflow.bottom as f64)
                };
                if root { vh.max(h) } else { snap_size(h, top) }
            }
        }
        "scrollLeft" => scroll_offset(doc, node).0,
        "scrollTop" => scroll_offset(doc, node).1,
        other => panic!("validated element metric {other}"),
    }
}

/// What a ResizeObserver reports for `node` (M6), from the current layout:
/// the content rectangle (x and y are the padding's left and top, then the
/// content width and height), the border box size, and the content box
/// size in device pixels (snapped at the box's position, as Blink snaps
/// it). Lengths are in layout units (1/64 px). An element without boxes
/// (`display: none`, or inside such an element) reports zeros.
pub(crate) fn observed_sizes(doc: &BaseDocument, node: NodeId) -> [f64; 8] {
    let Some(n) = element(doc, node).filter(|_| rendered(doc, node)) else {
        return [0.0; 8];
    };
    let l = *n.unrounded_layout();
    let q = |v: f32| lu(v as f64) as f64 / 64.0;
    let (b, p, sb) = (l.border, l.padding, l.scrollbar_size);
    let cw = (l.size.width - b.left - b.right - p.left - p.right - sb.width).max(0.0);
    let ch = (l.size.height - b.top - b.bottom - p.top - p.bottom - sb.height).max(0.0);
    let (x, y) = layout_position(doc, node);
    let scale = doc.viewport().scale_f64();
    let cx = (x + b.left as f64 + p.left as f64) * scale;
    let cy = (y + b.top as f64 + p.top as f64) * scale;
    [
        q(p.left),
        q(p.top),
        q(cw),
        q(ch),
        q(l.size.width),
        q(l.size.height),
        snap_size(cw as f64 * scale, cx),
        snap_size(ch as f64 * scale, cy),
    ]
}

/// The depth of `node` in the document (its number of ancestors), for the
/// order of ResizeObserver deliveries.
pub(crate) fn depth(doc: &BaseDocument, node: NodeId) -> usize {
    let mut d = 0;
    let mut current = doc.get_node(node).and_then(|n| n.parent);
    while let Some(p) = current {
        d += 1;
        current = doc.get_node(p).and_then(|n| n.parent);
    }
    d
}

/// `document.elementFromPoint(x, y)` (M6 overlays: bits-ui's submenu
/// intent): the element Blitz's hit test finds at the viewport point, as
/// pointer events are targeted (a hit text or anonymous box stands for its
/// element); none outside the viewport, as in Chromium.
pub(crate) fn element_from_point(doc: &mut BaseDocument, x: f64, y: f64) -> Option<u64> {
    resolve(doc);
    let (vw, vh) = viewport(doc);
    if !(0.0..vw).contains(&x) || !(0.0..vh).contains(&y) {
        return None;
    }
    let scroll = doc.viewport_scroll();
    let mut node = doc
        .hit((x + scroll.x) as f32, (y + scroll.y) as f32)?
        .node_id;
    loop {
        let n = doc.get_node(node)?;
        if n.is_element() {
            return Some(node.as_u64());
        }
        node = n.parent?;
    }
}

/// A window metric (`innerWidth`, `innerHeight`, `scrollX`, `scrollY`).
pub(crate) fn window_metric(doc: &mut BaseDocument, name: &str) -> f64 {
    resolve(doc);
    let (vw, vh) = viewport(doc);
    let s = doc.viewport_scroll();
    match name {
        "innerWidth" => vw,
        "innerHeight" => vh,
        "scrollX" => s.x,
        "scrollY" => s.y,
        // CSS pixels per device pixel (M6 overlays: floating-ui rounds by it).
        "devicePixelRatio" => doc.viewport().scale_f64(),
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
    resolve(doc);
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
    // Blitz owns the used scroll-offset rounding and range policy.
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

/// Scroll containers on the containing-block chain, innermost first.
fn scrollers(doc: &BaseDocument, node: NodeId) -> Vec<NodeId> {
    let mut result = Vec::new();
    let mut current = doc.get_node(node).and_then(|n| n.containing_block());
    while let Some(id) = current {
        if is_root(doc, id) {
            break;
        }
        if element(doc, id).is_some() && is_scroller(doc, id) && !propagated_to_viewport(doc, id) {
            result.push(id);
        }
        current = doc.get_node(id).and_then(|n| n.containing_block());
    }
    result
}

fn propagated_to_viewport(doc: &BaseDocument, node: NodeId) -> bool {
    let Some(root) = doc.try_root_element().map(|r| r.id) else {
        return false;
    };
    let body = doc.get_node(node).is_some_and(|n| {
        n.parent == Some(root) && n.element_data().is_some_and(|e| &*e.name.local == "body")
    });
    body && ["overflow-x", "overflow-y"]
        .iter()
        .all(|p| style(doc, root, p) == "visible")
}

/// The scrollport padding box less scrollbars, or the
/// viewport, in viewport coordinates: x, y, width, height.
fn scrollport(doc: &mut BaseDocument, scroller: Option<NodeId>) -> (f64, f64, f64, f64) {
    match scroller {
        Some(s) => {
            let sr = rect(doc, s);
            let l = *doc.get_node(s).unwrap().unrounded_layout();
            (
                sr[0] + l.border.left as f64,
                sr[1] + l.border.top as f64,
                (l.size.width - l.border.left - l.border.right - l.scrollbar_size.width) as f64,
                (l.size.height - l.border.top - l.border.bottom - l.scrollbar_size.height) as f64,
            )
        }
        None => {
            let (vw, vh) = viewport(doc);
            (0.0, 0.0, vw, vh)
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
    resolve(doc);
    crate::timeline::check_scroll_target(doc, node);
    if element(doc, node).is_none_or(|n| !n.has_boxes()) {
        return vec![];
    }
    let targets: Vec<_> = scrollers(doc, node)
        .into_iter()
        .chain(doc.try_root_element().map(|r| r.id))
        .collect();
    let before: Vec<_> = targets.iter().map(|id| scroll_offset(doc, *id)).collect();
    let logical = |value: &str| match value {
        "start" => blitz_dom::ScrollLogicalPosition::Start,
        "center" => blitz_dom::ScrollLogicalPosition::Center,
        "end" => blitz_dom::ScrollLogicalPosition::End,
        _ => blitz_dom::ScrollLogicalPosition::Nearest,
    };
    doc.scroll_into_view(
        node,
        ScrollBehavior::Instant,
        logical(block),
        logical(inline),
    );
    targets
        .into_iter()
        .zip(before)
        .filter_map(|(id, old)| (scroll_offset(doc, id) != old).then_some(id))
        .collect()
}

/// Whether `node`'s border box, expanded to whole pixels, lies inside the
/// scrollport of every scroll container around it and inside the viewport.
/// Playwright scrolls a pointer action's target into view first
/// (`DOM.scrollIntoViewIfNeeded`, which scrolls only what is not fully
/// visible); for such a target that moves nothing.
#[cfg(feature = "probe")]
pub(crate) fn fully_visible(doc: &mut BaseDocument, node: NodeId) -> bool {
    resolve(doc);
    let r = rect(doc, node);
    let (left, top) = (r[0].floor(), r[1].floor());
    let (right, bottom) = ((r[0] + r[2]).ceil(), (r[1] + r[3]).ceil());
    scrollers(doc, node)
        .into_iter()
        .map(Some)
        .chain([None])
        .all(|scroller| {
            let (px, py, pw, ph) = scrollport(doc, scroller);
            left >= px && top >= py && right <= px + pw && bottom <= py + ph
        })
}

/// Text that no font draws: an element's inline content holds visible
/// characters but its laid-out width is zero, because none of the faces its
/// `font-family` names was loaded (native builds load only the app's
/// embedded fonts; Chromium would fall back to a system font). Each entry
/// names the text and the font stack.
pub(crate) fn unfonted_text(doc: &BaseDocument) -> Vec<String> {
    let mut out = vec![];
    for (_, node) in doc.tree().iter() {
        let Some(element) = node.element_data() else {
            continue;
        };
        let Some(text) = element.inline_layout_data.as_ref() else {
            continue;
        };
        if text.text.trim().is_empty() || text.layout.width() > 0.0 {
            continue;
        }
        let family = node
            .primary_styles()
            .map(|s| {
                use style_traits::ToCss as _;
                s.get_font().font_family.to_css_string()
            })
            .unwrap_or_default();
        let sample: String = text.text.trim().chars().take(40).collect();
        // Text of an anonymous block (inline content of a flex or grid
        // container, such as a button) is named by its element.
        let mut owner = node;
        while matches!(owner.data, blitz_dom::node::NodeData::AnonymousBlock(_)) {
            match owner.parent.and_then(|p| doc.get_node(p)) {
                Some(p) => owner = p,
                None => break,
            }
        }
        let tag = owner
            .element_data()
            .map_or_else(String::new, |e| e.name.local.to_string());
        out.push(format!("{sample:?} in <{tag}> (font-family: {family})"));
    }
    out
}

/// Print `message` to stderr the first time it occurs.
#[cfg(not(feature = "probe"))]
pub(crate) fn report_once(message: String) {
    thread_local! {
        static SEEN: std::cell::RefCell<std::collections::HashSet<String>> = Default::default();
    }
    if SEEN.with(|s| s.borrow_mut().insert(message.clone())) {
        eprintln!("{message}");
    }
}
