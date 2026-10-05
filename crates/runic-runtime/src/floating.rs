//! `@floating-ui/dom` 1.7.4's platform over Blitz's layout (M6 overlays,
//! docs/design/M6-OVERLAYS.md: "the platform becomes a pack over native
//! layout reads"): the dom functions `getCssDimensions`, `getScale`,
//! `getBoundingClientRect`, `getWindowScrollBarX`, `getHTMLOffset`,
//! `convertOffsetParentRelativeRectToViewportRelativeRect`,
//! `getDocumentRect`, `getViewportRect`, `getInnerBoundingClientRect`,
//! `getClientRectFromClippingAncestor`, `hasFixedPositionAncestor`,
//! `getClippingElementAncestors`, `getClippingRect`, `getDimensions`,
//! `getRectRelativeToOffsetParent`, `getTrueOffsetParent`, `getOffsetParent`
//! and `isRTL`, and the `@floating-ui/utils` 0.2.10 dom helpers they use,
//! ported function by function as Chromium evaluates them.
//!
//! Chromium, not WebKit: `isWebKit()` is false (`CSS.supports(
//! '-webkit-backdrop-filter', 'none')` is false in Chromium), so the visual
//! viewport offsets are never added and `backdrop-filter`/`filter` make
//! containing blocks. There are no frames (`getFrameElement` is null), no
//! shadow roots or slots, and no top layer: the runtime implements neither
//! popovers nor modal dialogs, so `isTopLayer` (`:popover-open`, `:modal`)
//! is false for every element.
//!
//! The DOM reads map to the runtime's CSSOM View reads (`layout.rs`), so
//! geometry has the snapping the app's own `getBoundingClientRect` and
//! `offsetWidth` have: `getBoundingClientRect` is `layout::rect`, the element
//! metrics (`offsetWidth`, `clientLeft`, `clientWidth`, `scrollWidth`,
//! `scrollLeft`, …) are `layout::metric`, and the window's are
//! `layout::window_metric`. `getComputedStyle(element)[property]` is Blitz's
//! resolved value (`resolved_style_value`), except the layout-dependent
//! lengths read here (`width`, `height`, `margin-left`, `margin-right`):
//! Chromium serialises their used value, in layout units, with six
//! significant digits rounded half to even, and `parseFloat` reads that
//! string back; [`Reader::css_px`] computes the same number from the layout.
//! A disconnected element's computed style is empty in Chromium; so it is
//! here.
//!
//! Scrollbars: Blitz's are overlay scrollbars that take no space. The
//! conformance browser (Playwright's headless Chromium, which passes
//! `--hide-scrollbars`) gives scrollbars no space either: measured,
//! `clientWidth` of a 100px `overflow: scroll` box is 100 and the root's
//! `clientWidth` is the viewport width with a scrolling document. A desktop
//! Chromium with classic scrollbars differs there for every layout read, not
//! only these.
//!
//! What Blitz cannot answer as Chromium does is reported with
//! [`crate::unsupported`] where it would matter (see `unsupported` calls).

use blitz_dom::node::NodeData;
use blitz_dom::{BaseDocument, ns};
use blitz_traits::node_id::NodeId;
use runic_js::floating::{
    Boundary, Coords, Dimensions, OffsetParent, Rect, RootBoundary, Strategy,
};
use runic_js::math::round;
use runic_js::{JsString, max, min, parse_float};
use std::collections::HashMap;

use crate::dom::Host;

/// An entry of `getOverflowAncestors(element)`: the overflow elements from
/// the nearest outwards, then the window and its `visualViewport` (Chromium
/// has one), then `document.body` when the body is itself an overflow
/// element (in that order, as the utils list them). `autoUpdate` adds its
/// `scroll` and `resize` listeners to each.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OverflowAncestor {
    Element(u64),
    Window,
    VisualViewport,
}

/// The cache `computePosition` gives `getClippingRect` (`platform._c`): the
/// clipping element ancestors of each element, computed once per
/// `computePosition` call.
pub type ClippingCache = HashMap<u64, Vec<u64>>;

/// A node or the window (the values `getNodeScroll`, `getNodeName` and the
/// offset parent functions take).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Target {
    Node(NodeId),
    Window,
}

/// A clipping ancestor: `'viewport'`, `'document'`, an element or a rect.
#[derive(Clone, Copy, Debug)]
enum Clip {
    Viewport,
    Document,
    Element(NodeId),
    Rect(Rect),
}

/// `rectToClientRect`'s result (and a `DOMRect` with a non-negative size).
#[derive(Clone, Copy, Debug, PartialEq)]
struct ClientRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    top: f64,
    right: f64,
    bottom: f64,
    left: f64,
}

/// `rectToClientRect({ x, y, width, height })`.
fn client_rect(x: f64, y: f64, width: f64, height: f64) -> ClientRect {
    ClientRect {
        x,
        y,
        width,
        height,
        top: y,
        right: x + width,
        bottom: y + height,
        left: x,
    }
}

const SCROLLBAR_MAX: f64 = 25.0;

/// `parseFloat(value) || 0`.
fn or_zero(v: f64) -> f64 {
    if v.is_nan() || v == 0.0 { 0.0 } else { v }
}

/// `!x || !Number.isFinite(x)` replaced by 1 (`getScale`).
fn scale_or_one(v: f64) -> f64 {
    if v == 0.0 || !v.is_finite() { 1.0 } else { v }
}

/// The number Chromium's `getComputedStyle` serialises for a used length of
/// `units` layout units (1/64 px), as `parseFloat` reads it back: six
/// significant digits, rounded half to even (measured: 123.0625px is
/// "123.062px", 123.1875px is "123.188px", 456789.5px is "456790px").
fn serialized_px(units: i64) -> f64 {
    // The exact decimal value, in millionths (1/64 = 15625/10^6).
    let exact = units.unsigned_abs() as u128 * 15625;
    let digits = exact.checked_ilog10().map_or(1, |d| d + 1);
    let rounded = if digits > 6 {
        let p = 10u128.pow(digits - 6);
        let (q, r) = (exact / p, exact % p);
        let q = if 2 * r > p || (2 * r == p && q % 2 == 1) {
            q + 1
        } else {
            q
        };
        q * p
    } else {
        exact
    };
    let v = rounded as f64 / 1e6;
    if units < 0 { -v } else { v }
}

/// HTML elements Chromium's user-agent stylesheet gives a non-`visible`
/// `overflow` that Blitz's does not (measured: `img`, `video`, `canvas`,
/// `iframe`, `embed`, `object`, `input`, `select` compute to `clip`,
/// `textarea` to `auto`, `marquee` to `hidden`; the runtime's own UA sheet
/// already gives `svg` Chromium's `hidden`).
const UA_OVERFLOW: [&str; 10] = [
    "img", "video", "canvas", "iframe", "embed", "object", "input", "select", "textarea", "marquee",
];

/// Elements that have a box of their own whatever their `display` (Blitz's
/// list for used `width`/`height`).

/// The platform's reads of one document. Layout is resolved before one is
/// made; every read here is then of that layout (the runtime's reads
/// re-resolve, which is idempotent).
struct Reader<'a> {
    doc: &'a mut BaseDocument,
    /// `document.documentElement`.
    html: NodeId,
}

impl<'a> Reader<'a> {
    fn new(doc: &'a mut BaseDocument) -> Option<Reader<'a>> {
        crate::layout::resolve(doc);
        let html = doc.try_root_element()?.id;
        Some(Reader { doc, html })
    }

    fn is_element(&self, node: NodeId) -> bool {
        self.doc.get_node(node).is_some_and(|n| n.is_element())
    }

    /// `isHTMLElement`: an element in the HTML namespace.
    fn is_html_element(&self, node: NodeId) -> bool {
        self.doc
            .get_node(node)
            .filter(|n| n.is_element())
            .and_then(|n| n.element_data())
            .is_some_and(|e| e.name.ns == ns!(html))
    }

    /// An HTML element's local name (empty for anything else).
    fn html_tag(&self, node: NodeId) -> &str {
        match self.doc.get_node(node) {
            Some(n) if n.is_element() => n
                .element_data()
                .filter(|e| e.name.ns == ns!(html))
                .map_or("", |e| &e.name.local),
            _ => "",
        }
    }

    /// `getNodeName`: `nodeName` lowercased; `#document` for the window
    /// (not a node).
    fn node_name(&self, target: Target) -> String {
        let Target::Node(node) = target else {
            return "#document".into();
        };
        match self.doc.get_node(node).map(|n| &n.data) {
            Some(NodeData::Document(_)) => "#document".into(),
            Some(NodeData::Element(e)) => (*e.name.local).to_ascii_lowercase(),
            Some(NodeData::Text(_)) => "#text".into(),
            Some(NodeData::Comment { .. }) => "#comment".into(),
            _ => "#document-fragment".into(),
        }
    }

    /// `isLastTraversableNode`.
    fn is_last_traversable(&self, node: NodeId) -> bool {
        matches!(
            self.node_name(Target::Node(node)).as_str(),
            "html" | "body" | "#document"
        )
    }

    /// `isTableElement`.
    fn is_table_element(&self, node: NodeId) -> bool {
        matches!(
            self.node_name(Target::Node(node)).as_str(),
            "table" | "td" | "th"
        )
    }

    /// `document.body`: the first child of the `html` element that is a
    /// `body` or `frameset` element.
    fn body(&self) -> Option<NodeId> {
        if self.html_tag(self.html) != "html" {
            return None;
        }
        self.doc
            .get_node(self.html)?
            .children
            .iter()
            .copied()
            .find(|&c| matches!(self.html_tag(c), "body" | "frameset"))
    }

    /// `getParentNode`: the node itself for `html`; else `parentNode`, or
    /// the document element for a node without one (no slots or shadow
    /// roots here).
    fn parent_node(&self, node: NodeId) -> NodeId {
        if self.node_name(Target::Node(node)) == "html" {
            return node;
        }
        self.doc
            .get_node(node)
            .and_then(|n| n.parent)
            .unwrap_or(self.html)
    }

    /// `getComputedStyle(element)[property]`: empty for a disconnected
    /// element, as in Chromium.
    fn css(&self, node: NodeId, property: &str) -> String {
        match self.doc.get_node(node) {
            Some(n) if n.is_element() && n.flags.is_in_document() => {
                self.doc.resolved_style_value(node, property)
            }
            _ => String::new(),
        }
    }

    /// Whether the element is a non-atomic inline box (Blitz lays it out in
    /// its inline root's text, without a box of its own).
    fn non_atomic_inline(&self, node: NodeId) -> bool {
        crate::layout::non_atomic_inline(self.doc, node)
    }

    /// Whether Chromium's resolved `width`/`height`/margins are used values:
    /// the element has a box of its own (rendered, not `display: contents`,
    /// not a non-atomic inline).
    fn has_layout_box(&self, node: NodeId) -> bool {
        crate::layout::rendered(self.doc, node) && !self.non_atomic_inline(node)
    }

    /// `parseFloat(getComputedStyle(element)[property])` for `width`,
    /// `height`, `margin-left` and `margin-right`: Chromium's serialised used
    /// value for an element with a box ([`serialized_px`] of the layout in
    /// layout units, as the runtime quantises it), else the computed value.
    fn css_px(&self, node: NodeId, property: &str) -> f64 {
        if self.has_layout_box(node) {
            let n = self.doc.get_node(node).unwrap();
            let l = *n.unrounded_layout();
            let lu = |v: f32| crate::layout::lu(v as f64);
            let border_box = n.primary_styles().is_some_and(|s| {
                s.clone_box_sizing() == style::computed_values::box_sizing::T::BorderBox
            });
            let units = match property {
                "width" if border_box => lu(l.size.width),
                "height" if border_box => lu(l.size.height),
                "width" => (lu(l.size.width)
                    - lu(l.border.left)
                    - lu(l.border.right)
                    - lu(l.padding.left)
                    - lu(l.padding.right)
                    - lu(l.scrollbar_size.width))
                .max(0),
                "height" => (lu(l.size.height)
                    - lu(l.border.top)
                    - lu(l.border.bottom)
                    - lu(l.padding.top)
                    - lu(l.padding.bottom)
                    - lu(l.scrollbar_size.height))
                .max(0),
                "margin-left" => lu(l.margin.left),
                "margin-right" => lu(l.margin.right),
                other => panic!("used length {other}"),
            };
            return serialized_px(units);
        }
        parse_float(&JsString::from(self.css(node, property)))
    }

    /// An element metric (`offsetWidth`, `clientLeft`, `scrollTop`, …).
    fn metric(&mut self, node: NodeId, name: &str) -> f64 {
        crate::layout::metric(self.doc, node, name)
    }

    /// `element.getBoundingClientRect()`.
    fn dom_rect(&mut self, node: NodeId) -> ClientRect {
        let [x, y, w, h, ..] = crate::layout::rect(self.doc, node);
        client_rect(x, y, w, h)
    }

    /// Whether a scroll offset read at `node` (the viewport for the root)
    /// is right-to-left with something to scroll horizontally: Chromium's
    /// `scrollLeft` then runs from 0 at the right edge to negative values;
    /// the runtime's scroll offsets are not verified for that.
    fn check_rtl_scroll(&mut self, node: NodeId) {
        let rtl = if node == self.html {
            // The viewport takes the body's direction (CSS Writing Modes
            // propagate it from the body to the root in HTML).
            self.css(node, "direction") == "rtl"
                || self
                    .body()
                    .is_some_and(|b| self.css(b, "direction") == "rtl")
        } else {
            self.css(node, "direction") == "rtl"
        };
        if rtl && self.metric(node, "scrollWidth") > self.metric(node, "clientWidth") {
            crate::unsupported(
                "floating-ui read the scroll offset of a right-to-left scroll container \
                 (Chromium's scrollLeft is negative from the right edge; the runtime's \
                 RTL scroll origin is not verified)",
            );
        }
    }

    /// `getNodeScroll`: `scrollLeft`/`scrollTop` of an element, `scrollX`/
    /// `scrollY` of the window.
    fn node_scroll(&mut self, target: Target) -> (f64, f64) {
        match target {
            Target::Node(node) if self.is_element(node) => {
                self.check_rtl_scroll(node);
                (
                    self.metric(node, "scrollLeft"),
                    self.metric(node, "scrollTop"),
                )
            }
            Target::Node(_) => (0.0, 0.0),
            Target::Window => {
                self.check_rtl_scroll(self.html);
                (
                    crate::layout::window_metric(self.doc, "scrollX"),
                    crate::layout::window_metric(self.doc, "scrollY"),
                )
            }
        }
    }

    /// `isOverflowElement`.
    fn is_overflow_element(&self, node: NodeId) -> bool {
        let tag = self.html_tag(node);
        if UA_OVERFLOW.contains(&tag) {
            crate::unsupported(&format!(
                "floating-ui's isOverflowElement(<{tag}>): Chromium's user-agent stylesheet \
                 gives <{tag}> a non-visible overflow that Blitz's does not"
            ));
        }
        let overflow = format!(
            "{}{}{}",
            self.css(node, "overflow"),
            self.css(node, "overflow-y"),
            self.css(node, "overflow-x")
        );
        let display = self.css(node, "display");
        ["auto", "scroll", "overlay", "hidden", "clip"]
            .iter()
            .any(|k| overflow.contains(k))
            && !matches!(display.as_str(), "inline" | "contents")
    }

    /// `getComputedStyle(element).willChange` as Chromium serialises it:
    /// Stylo keeps the case of every identifier; Chromium lowercases the
    /// ones that name properties.
    fn will_change(&self, node: NodeId) -> String {
        let value = self.css(node, "will-change");
        if value.is_empty() || value == "auto" {
            return value;
        }
        value
            .split(", ")
            .map(|ident| {
                let lower = ident.to_ascii_lowercase();
                if style::properties::PropertyId::parse_enabled_for_all_content(&lower).is_ok()
                    || matches!(lower.as_str(), "scroll-position" | "contents")
                {
                    lower
                } else {
                    ident.to_owned()
                }
            })
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// `css[property] ? css[property] !== keyword : false`. A property
    /// Blitz's Stylo does not parse reads as empty (falsy): no stylesheet
    /// can set it (the compiler reports such declarations as dropped).
    fn is_not(&self, node: NodeId, property: &str, keyword: &str) -> bool {
        let v = self.css(node, property);
        !v.is_empty() && v != keyword
    }

    /// `isContainingBlock(element)` (utils 0.2.10, `isWebKit()` false).
    fn is_containing_block(&self, node: NodeId) -> bool {
        let will_change = self.will_change(node);
        let contain = self.css(node, "contain");
        ["transform", "translate", "scale", "rotate", "perspective"]
            .iter()
            .any(|p| self.is_not(node, p, "none"))
            || self.is_not(node, "container-type", "normal")
            || self.is_not(node, "backdrop-filter", "none")
            || self.is_not(node, "filter", "none")
            || [
                "transform",
                "translate",
                "scale",
                "rotate",
                "perspective",
                "filter",
            ]
            .iter()
            .any(|v| will_change.contains(v))
            || ["paint", "layout", "strict", "content"]
                .iter()
                .any(|v| contain.contains(v))
    }

    /// `getContainingBlock(element)`.
    fn containing_block(&self, node: NodeId) -> Option<NodeId> {
        let mut current = self.parent_node(node);
        while self.is_html_element(current) && !self.is_last_traversable(current) {
            if self.is_containing_block(current) {
                return Some(current);
            }
            // isTopLayer(current) is false.
            current = self.parent_node(current);
        }
        None
    }

    /// The `will-change` identifiers (lowercased property names), for the
    /// offset parent.
    fn will_change_idents(&self, node: NodeId) -> Vec<String> {
        let value = self.will_change(node);
        if value.is_empty() || value == "auto" {
            return vec![];
        }
        value.split(", ").map(str::to_owned).collect()
    }

    /// Whether Chromium makes `node` (an ancestor with a box) the containing
    /// block of fixed-position descendants, as its `offsetParent` walk sees
    /// it. Measured in the conformance Chromium: for a block-level box,
    /// `transform`, `translate`, `scale`, `rotate`, `perspective` other than
    /// `none`, `transform-style: preserve-3d`, `filter`, `backdrop-filter`,
    /// `contain` with `paint`, `layout`, `strict` or `content`,
    /// `content-visibility` other than `visible` (not parsed by Blitz), and
    /// `will-change` naming `transform`, `translate`, `scale`, `rotate`,
    /// `offset-path`, `perspective`, `transform-style`, `filter`,
    /// `backdrop-filter` or `contain`; for a non-atomic inline box only the
    /// filters (and `will-change` naming them). `container-type`,
    /// `offset-path`, `contain: size`/`style`, `opacity`, `clip-path`,
    /// `mask`, `isolation` and `mix-blend-mode` do not.
    fn is_fixed_container(&self, node: NodeId) -> bool {
        self.fixed_container(node, true)
    }

    /// [`Self::is_fixed_container`], with or without the filters (`filter`,
    /// `backdrop-filter` and `will-change` naming them).
    fn fixed_container(&self, node: NodeId, with_filters: bool) -> bool {
        let will_change = self.will_change_idents(node);
        let named = |list: &[&str]| will_change.iter().any(|w| list.contains(&w.as_str()));
        let filters = with_filters
            && (self.is_not(node, "filter", "none")
                || self.is_not(node, "backdrop-filter", "none")
                || named(&["filter", "backdrop-filter"]));
        if self.non_atomic_inline(node) {
            return filters;
        }
        let contain = self.css(node, "contain");
        ["transform", "translate", "scale", "rotate", "perspective"]
            .iter()
            .any(|p| self.is_not(node, p, "none"))
            || self.css(node, "transform-style") == "preserve-3d"
            || filters
            || contain
                .split(' ')
                .any(|c| matches!(c, "paint" | "layout" | "strict" | "content"))
            || self.is_not(node, "content-visibility", "visible")
            || named(&[
                "transform",
                "translate",
                "scale",
                "rotate",
                "offset-path",
                "perspective",
                "transform-style",
                "contain",
            ])
    }

    /// Whether `node` contains absolutely positioned descendants for the
    /// `offsetParent` walk: positioned, `will-change: position` (measured,
    /// block and inline), or a fixed-position container.
    fn is_absolute_container(&self, node: NodeId) -> bool {
        self.css(node, "position") != "static"
            || self
                .will_change_idents(node)
                .iter()
                .any(|w| w == "position")
            || self.is_fixed_container(node)
    }

    /// `element.offsetParent` as Chromium computes it (measured): none for
    /// an element without a box, the root and `body` elements; for a
    /// fixed-position element its fixed-position containing block, if not
    /// the viewport; otherwise the nearest ancestor with a box (skipping
    /// `display: contents`) that contains absolutely positioned
    /// descendants, or is a `body`, or (for a static element) a `table`,
    /// `td` or `th`.
    fn offset_parent_property(&self, node: NodeId) -> Option<NodeId> {
        if !crate::layout::rendered(self.doc, node)
            || node == self.html
            || self.html_tag(node) == "body"
        {
            return None;
        }
        let position = self.css(node, "position");
        let fixed = position == "fixed";
        let mut current = self.doc.get_node(node)?.parent;
        while let Some(a) = current {
            if !self.is_element(a) {
                return None;
            }
            let has_box = self.doc.get_node(a).is_some_and(|n| n.has_boxes());
            if has_box {
                if a == self.html {
                    // The root element. Measured for a fixed-position
                    // element: a `transform` on the root makes it the
                    // offsetParent, a `filter` does not (filters on the root
                    // make no containing block). The other cases are not
                    // measured.
                    let transformed = ["transform", "translate", "scale", "rotate", "perspective"]
                        .iter()
                        .any(|p| self.is_not(a, p, "none"));
                    if fixed && transformed {
                        return Some(a);
                    }
                    if (fixed && self.fixed_container(a, false))
                        || (!fixed && self.is_absolute_container(a))
                    {
                        crate::unsupported(
                            "offsetParent where the root element may be the containing block \
                             (not measured in Chromium)",
                        );
                    }
                    return None;
                }
                if fixed {
                    if self.is_fixed_container(a) {
                        return Some(a);
                    }
                } else if self.is_absolute_container(a)
                    || self.html_tag(a) == "body"
                    || (position == "static" && matches!(self.html_tag(a), "table" | "td" | "th"))
                {
                    return Some(a);
                }
            }
            current = self.doc.get_node(a).and_then(|n| n.parent);
        }
        None
    }

    /// `getCssDimensions(element)`: `(width, height, $)`.
    fn css_dimensions(&mut self, node: NodeId) -> (f64, f64, bool) {
        let html = self.is_html_element(node);
        if !html && self.is_element(node) {
            let outer_svg = self
                .doc
                .get_node(node)
                .and_then(|n| n.element_data())
                .is_some_and(|e| e.name.ns == ns!(svg) && &*e.name.local == "svg")
                && !self
                    .doc
                    .get_node(node)
                    .and_then(|n| n.parent)
                    .and_then(|p| self.doc.get_node(p))
                    .and_then(|p| p.element_data())
                    .is_some_and(|e| e.name.ns == ns!(svg));
            if !outer_svg {
                crate::unsupported(
                    "floating-ui's getCssDimensions of an SVG child element (Chromium's \
                     resolved width/height of SVG content are not modelled)",
                );
            }
        }
        if html && crate::layout::rendered(self.doc, node) && self.non_atomic_inline(node) {
            crate::unsupported(
                "floating-ui's getCssDimensions of a non-atomic inline element (its \
                 offsetWidth/offsetHeight are the bounding box of its line fragments)",
            );
        }
        let mut width = or_zero(self.css_px(node, "width"));
        let mut height = or_zero(self.css_px(node, "height"));
        let (offset_width, offset_height) = if html {
            (
                self.metric(node, "offsetWidth"),
                self.metric(node, "offsetHeight"),
            )
        } else {
            (width, height)
        };
        let fallback = round(width) != offset_width || round(height) != offset_height;
        if fallback {
            width = offset_width;
            height = offset_height;
        }
        (width, height, fallback)
    }

    /// `getScale(element)`.
    fn scale(&mut self, node: NodeId) -> Coords {
        if !self.is_html_element(node) {
            return Coords { x: 1.0, y: 1.0 };
        }
        let rect = self.dom_rect(node);
        let (width, height, fallback) = self.css_dimensions(node);
        let x = (if fallback {
            round(rect.width)
        } else {
            rect.width
        }) / width;
        let y = (if fallback {
            round(rect.height)
        } else {
            rect.height
        }) / height;
        Coords {
            x: scale_or_one(x),
            y: scale_or_one(y),
        }
    }

    /// `getBoundingClientRect(element, includeScale, isFixedStrategy,
    /// offsetParent)` (`offset_parent` `None`: not passed). Chromium adds no
    /// visual offsets (`isWebKit()` is false) and there are no frames.
    fn bounding_rect(
        &mut self,
        node: NodeId,
        include_scale: bool,
        _is_fixed_strategy: bool,
        offset_parent: Option<Target>,
    ) -> ClientRect {
        let r = self.dom_rect(node);
        let mut scale = Coords { x: 1.0, y: 1.0 };
        if include_scale {
            match offset_parent {
                Some(Target::Node(p)) if self.is_element(p) => scale = self.scale(p),
                Some(_) => {}
                None => scale = self.scale(node),
            }
        }
        // `+ 0.0`: the visual offset (0), which turns -0 into +0 as in JS.
        let x = (r.left + 0.0) / scale.x;
        let y = (r.top + 0.0) / scale.y;
        let width = r.width / scale.x;
        let height = r.height / scale.y;
        client_rect(x, y, width, height)
    }

    /// `getWindowScrollBarX(element, rect)` (`rect_left`: `rect.left`).
    fn window_scroll_bar_x(&mut self, node: NodeId, rect_left: Option<f64>) -> f64 {
        let left_scroll = self.node_scroll(Target::Node(node)).0;
        match rect_left {
            None => {
                let html = self.html;
                self.bounding_rect(html, false, false, None).left + left_scroll
            }
            Some(left) => left + left_scroll,
        }
    }

    /// `getHTMLOffset(documentElement, scroll)`.
    fn html_offset(&mut self, scroll: (f64, f64)) -> Coords {
        let html = self.html;
        let html_rect = self.dom_rect(html);
        let x = html_rect.left + scroll.0 - self.window_scroll_bar_x(html, Some(html_rect.left));
        let y = html_rect.top + scroll.1;
        Coords { x, y }
    }

    /// `convertOffsetParentRelativeRectToViewportRelativeRect`.
    fn convert_rect(&mut self, rect: Rect, offset_parent: Target, strategy: Strategy) -> Rect {
        let is_fixed = strategy == Strategy::Fixed;
        // `topLayer` (isTopLayer(elements.floating)) is false.
        if offset_parent == Target::Node(self.html) {
            return rect;
        }
        let mut scroll = (0.0, 0.0);
        let mut scale = Coords { x: 1.0, y: 1.0 };
        let mut offsets = Coords { x: 0.0, y: 0.0 };
        let is_element = matches!(offset_parent, Target::Node(p) if self.is_html_element(p));
        if is_element || !is_fixed {
            if self.node_name(offset_parent) != "body" || self.is_overflow_element(self.html) {
                scroll = self.node_scroll(offset_parent);
            }
            if let Target::Node(p) = offset_parent
                && is_element
            {
                let offset_rect = self.bounding_rect(p, false, false, None);
                scale = self.scale(p);
                offsets.x = offset_rect.x + self.metric(p, "clientLeft");
                offsets.y = offset_rect.y + self.metric(p, "clientTop");
            }
        }
        let html_offset = if !is_element && !is_fixed {
            self.html_offset(scroll)
        } else {
            Coords { x: 0.0, y: 0.0 }
        };
        Rect {
            width: rect.width * scale.x,
            height: rect.height * scale.y,
            x: rect.x * scale.x - scroll.0 * scale.x + offsets.x + html_offset.x,
            y: rect.y * scale.y - scroll.1 * scale.y + offsets.y + html_offset.y,
        }
    }

    /// `getDocumentRect(documentElement)`.
    fn document_rect(&mut self) -> Option<ClientRect> {
        let html = self.html;
        let Some(body) = self.body() else {
            crate::unsupported("floating-ui's getDocumentRect without document.body");
            return None;
        };
        let scroll = self.node_scroll(Target::Node(html));
        let metrics = |r: &mut Self, name: &str| {
            [
                r.metric(html, &format!("scroll{name}")),
                r.metric(html, &format!("client{name}")),
                r.metric(body, &format!("scroll{name}")),
                r.metric(body, &format!("client{name}")),
            ]
        };
        let [a, b, c, d] = metrics(self, "Width");
        let width = max(max(max(a, b), c), d);
        let [a, b, c, d] = metrics(self, "Height");
        let height = max(max(max(a, b), c), d);
        let mut x = -scroll.0 + self.window_scroll_bar_x(html, None);
        let y = -scroll.1;
        if self.css(body, "direction") == "rtl" {
            let (hw, bw) = (
                self.metric(html, "clientWidth"),
                self.metric(body, "clientWidth"),
            );
            x += max(hw, bw) - width;
        }
        Some(client_rect(x, y, width, height))
    }

    /// `getViewportRect(element, strategy)`. Chromium has `visualViewport`:
    /// its size is the layout viewport's less scrollbars (none take space,
    /// see the module docs) and its offsets are 0 (no pinch zoom).
    fn viewport_rect(&mut self, _strategy: Strategy) -> Option<ClientRect> {
        let html = self.html;
        let mut width = crate::layout::window_metric(self.doc, "innerWidth");
        let height = crate::layout::window_metric(self.doc, "innerHeight");
        let (x, y) = (0.0, 0.0);
        let window_scrollbar_x = self.window_scroll_bar_x(html, None);
        if window_scrollbar_x <= 0.0 {
            let Some(body) = self.body() else {
                crate::unsupported("floating-ui's getViewportRect without document.body");
                return None;
            };
            // `document.compatMode` is "CSS1Compat": the runtime's document
            // is in no-quirks mode, as a template with `<!doctype html>`.
            let body_margin_inline =
                or_zero(self.css_px(body, "margin-left") + self.css_px(body, "margin-right"));
            let clipping_stable_scrollbar_width = (self.metric(html, "clientWidth")
                - self.metric(body, "clientWidth")
                - body_margin_inline)
                .abs();
            if clipping_stable_scrollbar_width <= SCROLLBAR_MAX {
                width -= clipping_stable_scrollbar_width;
            }
        } else if window_scrollbar_x <= SCROLLBAR_MAX {
            width += window_scrollbar_x;
        }
        Some(client_rect(x, y, width, height))
    }

    /// `getInnerBoundingClientRect(element, strategy)`.
    fn inner_bounding_rect(&mut self, node: NodeId, strategy: Strategy) -> ClientRect {
        let r = self.bounding_rect(node, true, strategy == Strategy::Fixed, None);
        let top = r.top + self.metric(node, "clientTop");
        let left = r.left + self.metric(node, "clientLeft");
        let scale = if self.is_html_element(node) {
            self.scale(node)
        } else {
            Coords { x: 1.0, y: 1.0 }
        };
        let width = self.metric(node, "clientWidth") * scale.x;
        let height = self.metric(node, "clientHeight") * scale.y;
        let x = left * scale.x;
        let y = top * scale.y;
        client_rect(x, y, width, height)
    }

    /// `getClientRectFromClippingAncestor(element, clippingAncestor,
    /// strategy)`.
    fn clipping_ancestor_rect(&mut self, clip: Clip, strategy: Strategy) -> Option<ClientRect> {
        let rect = match clip {
            Clip::Viewport => self.viewport_rect(strategy)?,
            Clip::Document => self.document_rect()?,
            Clip::Element(node) => self.inner_bounding_rect(node, strategy),
            // Visual offsets are 0 in Chromium.
            Clip::Rect(r) => client_rect(r.x - 0.0, r.y - 0.0, r.width, r.height),
        };
        Some(client_rect(rect.x, rect.y, rect.width, rect.height))
    }

    /// `hasFixedPositionAncestor(element, stopNode)`.
    fn has_fixed_position_ancestor(&self, node: NodeId, stop: NodeId) -> bool {
        let parent = self.parent_node(node);
        if parent == stop || !self.is_element(parent) || self.is_last_traversable(parent) {
            return false;
        }
        self.css(parent, "position") == "fixed" || self.has_fixed_position_ancestor(parent, stop)
    }

    /// `getNearestOverflowAncestor(node)` (`None`: no `document.body`).
    fn nearest_overflow_ancestor(&self, node: NodeId) -> Option<NodeId> {
        let parent = self.parent_node(node);
        if self.is_last_traversable(parent) {
            return self.body();
        }
        if self.is_html_element(parent) && self.is_overflow_element(parent) {
            return Some(parent);
        }
        self.nearest_overflow_ancestor(parent)
    }

    /// `getOverflowAncestors(node, [], traverseIframes)`: there are no
    /// frames, so `traverseIframes` changes nothing.
    fn overflow_ancestors(&self, node: NodeId) -> Vec<OverflowAncestor> {
        let mut list = vec![];
        let mut node = node;
        loop {
            let Some(scrollable) = self.nearest_overflow_ancestor(node) else {
                crate::unsupported("floating-ui's getOverflowAncestors without document.body");
                return list;
            };
            if Some(scrollable) == self.body() {
                list.push(OverflowAncestor::Window);
                list.push(OverflowAncestor::VisualViewport);
                if self.is_overflow_element(scrollable) {
                    list.push(OverflowAncestor::Element(scrollable.as_u64()));
                }
                return list;
            }
            list.push(OverflowAncestor::Element(scrollable.as_u64()));
            node = scrollable;
        }
    }

    /// `getClippingElementAncestors(element, cache)`.
    fn clipping_element_ancestors(&self, node: NodeId, cache: &mut ClippingCache) -> Vec<NodeId> {
        if let Some(cached) = cache.get(&node.as_u64()) {
            return cached.iter().map(|&n| NodeId::from_u64(n)).collect();
        }
        let mut result: Vec<NodeId> = self
            .overflow_ancestors(node)
            .into_iter()
            .filter_map(|a| match a {
                OverflowAncestor::Element(n) => Some(NodeId::from_u64(n)),
                _ => None,
            })
            .filter(|&n| self.node_name(Target::Node(n)) != "body")
            .collect();
        // The last containing block's computed `position`.
        let mut containing_position: Option<String> = None;
        let element_is_fixed = self.css(node, "position") == "fixed";
        let mut current = if element_is_fixed {
            self.parent_node(node)
        } else {
            node
        };
        while self.is_element(current) && !self.is_last_traversable(current) {
            let position = self.css(current, "position");
            let containing = self.is_containing_block(current);
            if !containing && position == "fixed" {
                containing_position = None;
            }
            let drop = if element_is_fixed {
                !containing && containing_position.is_none()
            } else {
                (!containing
                    && position == "static"
                    && containing_position
                        .as_deref()
                        .is_some_and(|p| matches!(p, "absolute" | "fixed")))
                    || (self.is_overflow_element(current)
                        && !containing
                        && self.has_fixed_position_ancestor(node, current))
            };
            if drop {
                result.retain(|&a| a != current);
            } else {
                containing_position = Some(position);
            }
            current = self.parent_node(current);
        }
        cache.insert(node.as_u64(), result.iter().map(|n| n.as_u64()).collect());
        result
    }

    /// `getClippingRect({ element, boundary, rootBoundary, strategy })`.
    fn clipping_rect(
        &mut self,
        node: NodeId,
        boundary: &Boundary<u64>,
        root_boundary: &RootBoundary,
        strategy: Strategy,
        cache: &mut ClippingCache,
    ) -> Rect {
        let mut ancestors: Vec<Clip> = match boundary {
            // isTopLayer(element) is false.
            Boundary::ClippingAncestors => self
                .clipping_element_ancestors(node, cache)
                .into_iter()
                .map(Clip::Element)
                .collect(),
            Boundary::Elements(elements) => elements
                .iter()
                .map(|&e| Clip::Element(NodeId::from_u64(e)))
                .collect(),
        };
        ancestors.push(match root_boundary {
            RootBoundary::Viewport => Clip::Viewport,
            RootBoundary::Document => Clip::Document,
            RootBoundary::Rect(r) => Clip::Rect(*r),
        });
        let nan = Rect {
            x: f64::NAN,
            y: f64::NAN,
            width: f64::NAN,
            height: f64::NAN,
        };
        let Some(mut acc) = self.clipping_ancestor_rect(ancestors[0], strategy) else {
            return nan;
        };
        for &clip in &ancestors {
            let Some(rect) = self.clipping_ancestor_rect(clip, strategy) else {
                return nan;
            };
            acc.top = max(rect.top, acc.top);
            acc.right = min(rect.right, acc.right);
            acc.bottom = min(rect.bottom, acc.bottom);
            acc.left = max(rect.left, acc.left);
        }
        Rect {
            width: acc.right - acc.left,
            height: acc.bottom - acc.top,
            x: acc.left,
            y: acc.top,
        }
    }

    /// `getRectRelativeToOffsetParent(element, offsetParent, strategy)`.
    fn rect_relative_to_offset_parent(
        &mut self,
        node: NodeId,
        offset_parent: Target,
        strategy: Strategy,
    ) -> Rect {
        let is_element = matches!(offset_parent, Target::Node(p) if self.is_html_element(p));
        let html = self.html;
        let is_fixed = strategy == Strategy::Fixed;
        let rect = self.bounding_rect(node, true, is_fixed, Some(offset_parent));
        let mut scroll = (0.0, 0.0);
        let mut offsets = Coords { x: 0.0, y: 0.0 };
        if is_element || !is_fixed {
            if self.node_name(offset_parent) != "body" || self.is_overflow_element(html) {
                scroll = self.node_scroll(offset_parent);
            }
            if let Target::Node(p) = offset_parent
                && is_element
            {
                let offset_rect = self.bounding_rect(p, true, is_fixed, Some(offset_parent));
                offsets.x = offset_rect.x + self.metric(p, "clientLeft");
                offsets.y = offset_rect.y + self.metric(p, "clientTop");
            } else {
                offsets.x = self.window_scroll_bar_x(html, None);
            }
        }
        if is_fixed && !is_element {
            offsets.x = self.window_scroll_bar_x(html, None);
        }
        let html_offset = if !is_element && !is_fixed {
            self.html_offset(scroll)
        } else {
            Coords { x: 0.0, y: 0.0 }
        };
        Rect {
            x: rect.left + scroll.0 - offsets.x - html_offset.x,
            y: rect.top + scroll.1 - offsets.y - html_offset.y,
            width: rect.width,
            height: rect.height,
        }
    }

    /// `getTrueOffsetParent(element)` (no polyfill).
    fn true_offset_parent(&self, node: NodeId) -> Option<NodeId> {
        if !self.is_html_element(node) || self.css(node, "position") == "fixed" {
            return None;
        }
        let raw = self.offset_parent_property(node);
        // Chromium never returns the root element; the utils map it to the
        // body all the same.
        if raw == Some(self.html) {
            return self.body();
        }
        raw
    }

    /// `getOffsetParent(element)` (no polyfill).
    fn offset_parent(&self, node: NodeId) -> Target {
        // isTopLayer(element) is false.
        if !self.is_html_element(node) {
            let mut current = self.parent_node(node);
            while !self.is_last_traversable(current) {
                if self.is_element(current) && self.css(current, "position") != "static" {
                    return Target::Node(current);
                }
                current = self.parent_node(current);
            }
            return Target::Window;
        }
        let is_static = |n: NodeId| self.css(n, "position") == "static";
        let mut offset_parent = self.true_offset_parent(node);
        while let Some(p) = offset_parent
            && self.is_table_element(p)
            && is_static(p)
        {
            offset_parent = self.true_offset_parent(p);
        }
        if let Some(p) = offset_parent
            && self.is_last_traversable(p)
            && is_static(p)
            && !self.is_containing_block(p)
        {
            return Target::Window;
        }
        offset_parent
            .or_else(|| self.containing_block(node))
            .map_or(Target::Window, Target::Node)
    }
}

fn target(t: &OffsetParent<u64>) -> Target {
    match t {
        OffsetParent::Element(e) => Target::Node(NodeId::from_u64(*e)),
        OffsetParent::Window => Target::Window,
    }
}

/// `@floating-ui/dom`'s platform (see the module docs). Each method resolves
/// styles and layout first, as the other layout reads do; without an
/// attached document it returns empty values.
impl Host {
    fn floating<T>(&self, default: T, f: impl FnOnce(&mut Reader) -> T) -> T {
        let Some(dom) = self.dom() else {
            return default;
        };
        match Reader::new(dom.doc) {
            Some(mut reader) => f(&mut reader),
            None => default,
        }
    }

    /// `platform.getDimensions(element)`.
    pub fn floating_dimensions(&self, el: u64) -> Dimensions {
        let zero = Dimensions {
            width: 0.0,
            height: 0.0,
        };
        self.floating(zero, |r| {
            let (width, height, _) = r.css_dimensions(NodeId::from_u64(el));
            Dimensions { width, height }
        })
    }

    /// `platform.getOffsetParent(element)` (no polyfill).
    pub fn floating_offset_parent(&self, el: u64) -> OffsetParent<u64> {
        self.floating(OffsetParent::Window, |r| {
            match r.offset_parent(NodeId::from_u64(el)) {
                Target::Node(n) => OffsetParent::Element(n.as_u64()),
                Target::Window => OffsetParent::Window,
            }
        })
    }

    /// `getRectRelativeToOffsetParent(element, offsetParent, strategy)`.
    pub fn floating_rect_relative_to_offset_parent(
        &self,
        el: u64,
        offset_parent: &OffsetParent<u64>,
        strategy: Strategy,
    ) -> Rect {
        self.floating(ZERO_RECT, |r| {
            r.rect_relative_to_offset_parent(NodeId::from_u64(el), target(offset_parent), strategy)
        })
    }

    /// `platform.getClippingRect({ element, boundary, rootBoundary,
    /// strategy })` with a cache of its own (one call).
    pub fn floating_clipping_rect(
        &self,
        el: u64,
        boundary: &Boundary<u64>,
        root_boundary: &RootBoundary,
        strategy: Strategy,
    ) -> Rect {
        self.floating_clipping_rect_cached(
            el,
            boundary,
            root_boundary,
            strategy,
            &mut ClippingCache::new(),
        )
    }

    /// `platform.getClippingRect` with `computePosition`'s cache: pass one
    /// cache per `computePosition` call, as dom's wrapper does (`_c`), so a
    /// later `detectOverflow` in the same call reuses the clipping ancestors
    /// found before a `size` middleware's `apply` changed styles.
    pub fn floating_clipping_rect_cached(
        &self,
        el: u64,
        boundary: &Boundary<u64>,
        root_boundary: &RootBoundary,
        strategy: Strategy,
        cache: &mut ClippingCache,
    ) -> Rect {
        self.floating(ZERO_RECT, |r| {
            r.clipping_rect(
                NodeId::from_u64(el),
                boundary,
                root_boundary,
                strategy,
                cache,
            )
        })
    }

    /// `platform.getScale(element)`.
    pub fn floating_scale(&self, el: u64) -> Coords {
        self.floating(Coords { x: 1.0, y: 1.0 }, |r| r.scale(NodeId::from_u64(el)))
    }

    /// `platform.isRTL(element)`.
    pub fn floating_is_rtl(&self, el: u64) -> bool {
        self.floating(false, |r| r.css(NodeId::from_u64(el), "direction") == "rtl")
    }

    /// `platform.convertOffsetParentRelativeRectToViewportRelativeRect({
    /// elements, rect, offsetParent, strategy })`. `floating` is only read by
    /// `isTopLayer`, which is false here.
    pub fn floating_convert_rect(
        &self,
        floating: u64,
        rect: Rect,
        offset_parent: &OffsetParent<u64>,
        strategy: Strategy,
    ) -> Rect {
        let _ = floating;
        self.floating(rect, |r| {
            r.convert_rect(rect, target(offset_parent), strategy)
        })
    }

    /// `target.clientWidth` (`width`) or `target.clientHeight`; `None` for
    /// the window (`undefined`).
    pub fn floating_client_size(&self, target: &OffsetParent<u64>, width: bool) -> Option<f64> {
        let OffsetParent::Element(el) = *target else {
            return None;
        };
        let name = if width { "clientWidth" } else { "clientHeight" };
        Some(self.floating(0.0, |r| r.metric(NodeId::from_u64(el), name)))
    }

    /// dom's `getBoundingClientRect(element)` (no scale): `autoUpdate`'s
    /// `animationFrame` loop and `observeMove`'s `element.getBoundingClientRect()`.
    pub fn floating_bounding_rect(&self, el: u64) -> Rect {
        self.floating(ZERO_RECT, |r| {
            let c = r.bounding_rect(NodeId::from_u64(el), false, false, None);
            Rect {
                x: c.x,
                y: c.y,
                width: c.width,
                height: c.height,
            }
        })
    }

    /// `getOverflowAncestors(element)`.
    pub fn floating_overflow_ancestors(&self, el: u64) -> Vec<OverflowAncestor> {
        self.floating(vec![], |r| r.overflow_ancestors(NodeId::from_u64(el)))
    }
}

const ZERO_RECT: Rect = Rect {
    x: 0.0,
    y: 0.0,
    width: 0.0,
    height: 0.0,
};

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::{Dom, Listeners};
    use blitz_dom::DocumentConfig;
    use blitz_traits::shell::{ColorScheme, Viewport};

    /// An element: tag, id, inline style, children.
    struct N {
        tag: &'static str,
        id: &'static str,
        style: &'static str,
        kids: Vec<N>,
    }

    fn n(tag: &'static str, id: &'static str, style: &'static str, kids: Vec<N>) -> N {
        N {
            tag,
            id,
            style,
            kids,
        }
    }

    /// A document of `<html><head></head><body style>tree</body></html>` in
    /// an 800×600 viewport, built with the runtime's DOM operations.
    struct Fixture {
        doc: Box<BaseDocument>,
        listeners: Box<Listeners>,
        ids: HashMap<&'static str, NodeId>,
    }

    impl Fixture {
        fn new(body_style: &str, tree: Vec<N>) -> Fixture {
            let doc = BaseDocument::new(DocumentConfig {
                viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
                ..Default::default()
            });
            let mut fx = Fixture {
                doc: Box::new(doc),
                listeners: Box::default(),
                ids: HashMap::new(),
            };
            let mut dom = Dom {
                doc: &mut fx.doc,
                listeners: &mut fx.listeners,
            };
            let root = dom.doc.root_node().id;
            let html = dom.element("html");
            let head = dom.element("head");
            let body = dom.element("body");
            if !body_style.is_empty() {
                dom.set_attr(body, "style", body_style);
            }
            dom.append(html, head);
            dom.append(html, body);
            dom.append(root, html);
            fn build(
                dom: &mut Dom,
                parent: NodeId,
                nodes: Vec<N>,
                ids: &mut HashMap<&'static str, NodeId>,
            ) {
                for node in nodes {
                    let el = dom.element(node.tag);
                    if !node.id.is_empty() {
                        dom.set_attr(el, "id", node.id);
                        ids.insert(node.id, el);
                    }
                    if !node.style.is_empty() {
                        dom.set_attr(el, "style", node.style);
                    }
                    dom.append(parent, el);
                    build(dom, el, node.kids, ids);
                }
            }
            let mut ids = HashMap::new();
            build(&mut dom, body, tree, &mut ids);
            ids.insert("body", body);
            crate::layout::resolve(dom.doc);
            fx.ids = ids;
            fx
        }

        fn host(&mut self) -> Host {
            Host::attach(&mut Dom {
                doc: &mut self.doc,
                listeners: &mut self.listeners,
            })
        }

        fn id(&self, name: &str) -> u64 {
            self.ids[name].as_u64()
        }

        fn name(&self, node: u64) -> String {
            self.ids
                .iter()
                .find(|(_, v)| v.as_u64() == node)
                .map_or_else(|| format!("#{node}"), |(k, _)| k.to_string())
        }

        fn scroll(&mut self, id: &str, left: f64, top: f64) {
            let node = (id != "window").then(|| self.ids[id]);
            crate::layout::scroll(&mut self.doc, node, false, Some(left), Some(top));
        }
    }

    /// One document and the platform's answers for it in the conformance
    /// Chromium with the real @floating-ui/dom 1.7.4 (`f` is the floating
    /// element, `r` the reference); rects are `[x, y, width, height]`.
    struct Case {
        name: &'static str,
        body: &'static str,
        tree: Vec<N>,
        strategy: Strategy,
        scrolls: Vec<(&'static str, f64, f64)>,
        /// `getOffsetParent(f)`.
        op: &'static str,
        /// `getDimensions(f)`.
        dims: [f64; 2],
        /// `getElementRects`' reference: `getRectRelativeToOffsetParent(r,
        /// getOffsetParent(f), strategy)`.
        reference: [f64; 4],
        /// `getClippingRect` of `f`: clipping ancestors, viewport root.
        clip_viewport: [f64; 4],
        /// The same with the document root.
        clip_document: [f64; 4],
        /// `getClippingRect` of `r`: boundary `[r]`, root rect
        /// `{ x: 1, y: 2, width: 300, height: 400 }`.
        clip_reference: [f64; 4],
        /// `getScale(getOffsetParent(f))` for an element.
        scale: Option<[f64; 2]>,
        /// `convertOffsetParentRelativeRectToViewportRelativeRect` of
        /// `{ x: 5.5, y: 7.25, width: 11, height: 13 }`.
        convert: [f64; 4],
        rtl: bool,
        /// `getOverflowAncestors(r)`.
        ancestors: Vec<&'static str>,
        /// `r.getBoundingClientRect()`.
        bounding: [f64; 4],
    }

    fn same(a: f64, b: f64) -> bool {
        a == b || (a.is_nan() && b.is_nan())
    }

    fn rect(r: Rect) -> [f64; 4] {
        [r.x, r.y, r.width, r.height]
    }

    /// Generated by running the real package in the conformance Chromium
    /// (Playwright headless, 800×600, device scale 1) on the same documents
    /// (`<!doctype html>`, inline styles).
    fn cases() -> Vec<Case> {
        vec![
            Case {
                name: "static",
                body: "",
                tree: vec![
                    n(
                        "div",
                        "r",
                        "margin-top:50px;width:100px;height:20px",
                        vec![],
                    ),
                    n(
                        "div",
                        "f",
                        "position:absolute;width:50px;height:30px",
                        vec![],
                    ),
                ],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "window",
                dims: [50.0, 30.0],
                reference: [8.0, 50.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [8.0, 50.0, 100.0, 20.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [8.0, 50.0, 100.0, 20.0],
            },
            Case {
                name: "relative",
                body: "",
                tree: vec![n(
                    "div",
                    "c",
                    "position:relative;left:30px;top:40px;border:2px solid;padding:5px;width:300px;height:200px",
                    vec![
                        n(
                            "div",
                            "r",
                            "width:100px;height:20px;margin-left:10px",
                            vec![],
                        ),
                        n(
                            "div",
                            "f",
                            "position:absolute;width:50.5px;height:30.25px",
                            vec![],
                        ),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "c",
                dims: [50.5, 30.25],
                reference: [15.0, 5.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [55.0, 55.0, 100.0, 20.0],
                scale: Some([1.0, 1.0]),
                convert: [45.5, 57.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [55.0, 55.0, 100.0, 20.0],
            },
            Case {
                name: "fixed",
                body: "",
                tree: vec![
                    n(
                        "div",
                        "r",
                        "margin-top:50px;width:100px;height:20px",
                        vec![],
                    ),
                    n("div", "f", "position:fixed;width:50px;height:30px", vec![]),
                ],
                strategy: Strategy::Fixed,
                scrolls: vec![],
                op: "window",
                dims: [50.0, 30.0],
                reference: [8.0, 50.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [8.0, 50.0, 100.0, 20.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [8.0, 50.0, 100.0, 20.0],
            },
            Case {
                name: "transformed",
                body: "",
                tree: vec![n(
                    "div",
                    "t",
                    "transform:translate(10px,20px);margin:15px;width:300px;height:100px",
                    vec![
                        n("div", "r", "width:100px;height:20px", vec![]),
                        n(
                            "div",
                            "f",
                            "position:absolute;width:50px;height:30px",
                            vec![],
                        ),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "t",
                dims: [50.0, 30.0],
                reference: [0.0, 0.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [33.0, 35.0, 100.0, 20.0],
                scale: Some([1.0, 1.0]),
                convert: [38.5, 42.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [33.0, 35.0, 100.0, 20.0],
            },
            Case {
                name: "scaled",
                body: "",
                tree: vec![n(
                    "div",
                    "t",
                    "position:relative;transform:scale(2);transform-origin:0 0;width:100px;height:50px;margin-left:40px",
                    vec![
                        n("div", "r", "width:10px;height:10px;margin-left:5px", vec![]),
                        n(
                            "div",
                            "f",
                            "position:absolute;width:20px;height:10px",
                            vec![],
                        ),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "t",
                dims: [20.0, 10.0],
                reference: [5.0, 0.0, 10.0, 10.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [58.0, 8.0, 20.0, 20.0],
                scale: Some([2.0, 2.0]),
                convert: [59.0, 22.5, 22.0, 26.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [58.0, 8.0, 20.0, 20.0],
            },
            Case {
                name: "fixed_in_transformed",
                body: "",
                tree: vec![n(
                    "div",
                    "t",
                    "transform:translateX(5px);margin-top:20px;height:100px",
                    vec![
                        n("div", "r", "width:100px;height:20px", vec![]),
                        n(
                            "div",
                            "f",
                            "position:fixed;width:50px;height:30px;top:10px",
                            vec![],
                        ),
                    ],
                )],
                strategy: Strategy::Fixed,
                scrolls: vec![],
                op: "t",
                dims: [50.0, 30.0],
                reference: [0.0, 0.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [13.0, 20.0, 100.0, 20.0],
                scale: Some([1.0, 1.0]),
                convert: [18.5, 27.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [13.0, 20.0, 100.0, 20.0],
            },
            Case {
                name: "scroller",
                body: "",
                tree: vec![n(
                    "div",
                    "s",
                    "overflow:auto;width:200px;height:100px;margin-top:30px;border:3px solid",
                    vec![
                        n(
                            "div",
                            "r",
                            "margin-top:120px;width:50px;height:20px",
                            vec![],
                        ),
                        n(
                            "div",
                            "f",
                            "position:absolute;width:40px;height:40px",
                            vec![],
                        ),
                        n("div", "", "height:400px", vec![]),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![("s", 0.0, 60.0)],
                op: "window",
                dims: [40.0, 40.0],
                reference: [11.0, 93.0, 50.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [11.0, 93.0, 50.0, 20.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["s", "window", "vv"],
                bounding: [11.0, 93.0, 50.0, 20.0],
            },
            Case {
                name: "scroller_static_floating",
                body: "",
                tree: vec![n(
                    "div",
                    "s",
                    "overflow:auto;width:200px;height:100px;margin-top:30px;border:3px solid",
                    vec![
                        n(
                            "div",
                            "r",
                            "margin-top:120px;width:50px;height:20px",
                            vec![],
                        ),
                        n("div", "f", "width:40px;height:40px", vec![]),
                        n("div", "", "height:400px", vec![]),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![("s", 0.0, 60.0)],
                op: "window",
                dims: [40.0, 40.0],
                reference: [11.0, 93.0, 50.0, 20.0],
                clip_viewport: [11.0, 33.0, 200.0, 100.0],
                clip_document: [11.0, 33.0, 200.0, 100.0],
                clip_reference: [11.0, 93.0, 50.0, 20.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["s", "window", "vv"],
                bounding: [11.0, 93.0, 50.0, 20.0],
            },
            Case {
                name: "scroller_relative",
                body: "",
                tree: vec![n(
                    "div",
                    "s",
                    "position:relative;overflow:auto;width:200px;height:100px;margin-top:30px;border:3px solid",
                    vec![
                        n(
                            "div",
                            "r",
                            "margin-top:120px;width:50px;height:20px",
                            vec![],
                        ),
                        n(
                            "div",
                            "f",
                            "position:absolute;width:40px;height:40px",
                            vec![],
                        ),
                        n("div", "", "height:400px", vec![]),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![("s", 0.0, 60.0)],
                op: "s",
                dims: [40.0, 40.0],
                reference: [0.0, 120.0, 50.0, 20.0],
                clip_viewport: [11.0, 33.0, 200.0, 100.0],
                clip_document: [11.0, 33.0, 200.0, 100.0],
                clip_reference: [11.0, 93.0, 50.0, 20.0],
                scale: Some([1.0, 1.0]),
                convert: [16.5, -19.75, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["s", "window", "vv"],
                bounding: [11.0, 93.0, 50.0, 20.0],
            },
            Case {
                name: "window_scroll",
                body: "",
                tree: vec![
                    n(
                        "div",
                        "f",
                        "position:absolute;width:50px;height:30px",
                        vec![],
                    ),
                    n("div", "", "height:1500px", vec![]),
                    n("div", "r", "width:100px;height:20px", vec![]),
                ],
                strategy: Strategy::Absolute,
                scrolls: vec![("window", 0.0, 400.0)],
                op: "window",
                dims: [50.0, 30.0],
                reference: [8.0, 1508.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, -400.0, 800.0, 1536.0],
                clip_reference: [8.0, 1108.0, 100.0, -706.0],
                scale: None,
                convert: [5.5, -392.75, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [8.0, 1108.0, 100.0, 20.0],
            },
            Case {
                name: "window_scroll_fixed",
                body: "",
                tree: vec![
                    n("div", "f", "position:fixed;width:50px;height:30px", vec![]),
                    n("div", "", "height:1500px", vec![]),
                    n("div", "r", "width:100px;height:20px", vec![]),
                ],
                strategy: Strategy::Fixed,
                scrolls: vec![("window", 0.0, 400.0)],
                op: "window",
                dims: [50.0, 30.0],
                reference: [8.0, 1108.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, -400.0, 800.0, 1536.0],
                clip_reference: [8.0, 1108.0, 100.0, -706.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [8.0, 1108.0, 100.0, 20.0],
            },
            Case {
                name: "rtl",
                body: "",
                tree: vec![n(
                    "div",
                    "c",
                    "direction:rtl;width:300px",
                    vec![
                        n("div", "r", "width:100px;height:20px", vec![]),
                        n(
                            "div",
                            "f",
                            "position:absolute;width:50px;height:30px",
                            vec![],
                        ),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "window",
                dims: [50.0, 30.0],
                reference: [208.0, 8.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [208.0, 8.0, 93.0, 20.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: true,
                ancestors: vec!["window", "vv"],
                bounding: [208.0, 8.0, 100.0, 20.0],
            },
            Case {
                name: "table",
                body: "",
                tree: vec![n(
                    "table",
                    "",
                    "",
                    vec![n(
                        "tbody",
                        "",
                        "",
                        vec![n(
                            "tr",
                            "",
                            "",
                            vec![n(
                                "td",
                                "td",
                                "padding:4px",
                                vec![
                                    n("div", "r", "width:30px;height:10px", vec![]),
                                    n("div", "f", "width:20px;height:10px", vec![]),
                                ],
                            )],
                        )],
                    )],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "window",
                dims: [20.0, 10.0],
                reference: [14.0, 14.0, 30.0, 10.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [14.0, 14.0, 30.0, 10.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [14.0, 14.0, 30.0, 10.0],
            },
            Case {
                name: "td_relative",
                body: "",
                tree: vec![n(
                    "table",
                    "",
                    "",
                    vec![n(
                        "tbody",
                        "",
                        "",
                        vec![n(
                            "tr",
                            "",
                            "",
                            vec![n(
                                "td",
                                "td",
                                "position:relative;padding:4px",
                                vec![
                                    n("div", "r", "width:30px;height:10px", vec![]),
                                    n(
                                        "div",
                                        "f",
                                        "position:absolute;width:20px;height:10px",
                                        vec![],
                                    ),
                                ],
                            )],
                        )],
                    )],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "td",
                dims: [20.0, 10.0],
                reference: [4.0, 4.0, 30.0, 10.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [14.0, 14.0, 30.0, 10.0],
                scale: Some([1.0, 1.0]),
                convert: [15.5, 17.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [14.0, 14.0, 30.0, 10.0],
            },
            Case {
                name: "contents_positioned",
                body: "",
                tree: vec![n(
                    "div",
                    "",
                    "display:contents;position:relative",
                    vec![
                        n("div", "r", "width:100px;height:20px", vec![]),
                        n(
                            "div",
                            "f",
                            "position:absolute;width:50px;height:30px",
                            vec![],
                        ),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "window",
                dims: [50.0, 30.0],
                reference: [8.0, 8.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [8.0, 8.0, 100.0, 20.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [8.0, 8.0, 100.0, 20.0],
            },
            Case {
                name: "contents_in_relative",
                body: "",
                tree: vec![n(
                    "div",
                    "p",
                    "position:relative;margin-left:20px;height:50px",
                    vec![n(
                        "div",
                        "",
                        "display:contents",
                        vec![
                            n("div", "r", "width:100px;height:20px", vec![]),
                            n(
                                "div",
                                "f",
                                "position:absolute;width:50px;height:30px",
                                vec![],
                            ),
                        ],
                    )],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "p",
                dims: [50.0, 30.0],
                reference: [0.0, 0.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [28.0, 8.0, 100.0, 20.0],
                scale: Some([1.0, 1.0]),
                convert: [33.5, 15.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [28.0, 8.0, 100.0, 20.0],
            },
            Case {
                name: "clip_chain",
                body: "",
                tree: vec![n(
                    "div",
                    "o",
                    "overflow:hidden;width:300px;height:200px;position:relative",
                    vec![n(
                        "div",
                        "i",
                        "overflow:auto;width:150px;height:150px;margin-left:200px",
                        vec![
                            n("div", "r", "width:20px;height:20px", vec![]),
                            n("div", "f", "width:30px;height:30px", vec![]),
                            n("div", "", "height:500px", vec![]),
                        ],
                    )],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![("i", 0.0, 40.0)],
                op: "o",
                dims: [30.0, 30.0],
                reference: [200.0, -40.0, 20.0, 20.0],
                clip_viewport: [208.0, 8.0, 100.0, 150.0],
                clip_document: [208.0, 8.0, 100.0, 150.0],
                clip_reference: [208.0, 2.0, 20.0, -14.0],
                scale: Some([1.0, 1.0]),
                convert: [13.5, 15.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["i", "o", "window", "vv"],
                bounding: [208.0, -32.0, 20.0, 20.0],
            },
            Case {
                name: "fixed_drops_overflow",
                body: "",
                tree: vec![n(
                    "div",
                    "o",
                    "overflow:hidden;width:100px;height:100px",
                    vec![
                        n("div", "r", "width:20px;height:20px", vec![]),
                        n(
                            "div",
                            "f",
                            "position:fixed;width:30px;height:30px;left:50px;top:60px",
                            vec![],
                        ),
                    ],
                )],
                strategy: Strategy::Fixed,
                scrolls: vec![],
                op: "window",
                dims: [30.0, 30.0],
                reference: [8.0, 8.0, 20.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [8.0, 8.0, 20.0, 20.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["o", "window", "vv"],
                bounding: [8.0, 8.0, 20.0, 20.0],
            },
            Case {
                name: "will_change",
                body: "",
                tree: vec![n(
                    "div",
                    "w",
                    "will-change:transform;margin-left:12px;width:200px;height:50px",
                    vec![
                        n("div", "r", "width:100px;height:20px", vec![]),
                        n(
                            "div",
                            "f",
                            "position:absolute;width:50px;height:30px",
                            vec![],
                        ),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "w",
                dims: [50.0, 30.0],
                reference: [0.0, 0.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [20.0, 8.0, 100.0, 20.0],
                scale: Some([1.0, 1.0]),
                convert: [25.5, 15.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [20.0, 8.0, 100.0, 20.0],
            },
            Case {
                name: "filter",
                body: "",
                tree: vec![n(
                    "div",
                    "w",
                    "filter:blur(0px);margin-left:12px;width:200px;height:50px",
                    vec![
                        n("div", "r", "width:100px;height:20px", vec![]),
                        n(
                            "div",
                            "f",
                            "position:absolute;width:50px;height:30px",
                            vec![],
                        ),
                    ],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "w",
                dims: [50.0, 30.0],
                reference: [0.0, 0.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [20.0, 8.0, 100.0, 20.0],
                scale: Some([1.0, 1.0]),
                convert: [25.5, 15.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [20.0, 8.0, 100.0, 20.0],
            },
            Case {
                name: "fractional",
                body: "",
                tree: vec![
                    n(
                        "div",
                        "r",
                        "margin-left:3.296875px;width:100.703125px;height:20.203125px",
                        vec![],
                    ),
                    n(
                        "div",
                        "f",
                        "position:absolute;box-sizing:border-box;width:50.296875px;padding:3.296875px;height:20.703125px",
                        vec![],
                    ),
                ],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "window",
                dims: [50.2969, 20.7031],
                reference: [11.296875, 8.0, 100.703125, 20.203125],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [11.296875, 8.0, 101.00012536865833, 20.000024748677184],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv"],
                bounding: [11.296875, 8.0, 100.703125, 20.203125],
            },
            Case {
                name: "body_overflow",
                body: "overflow:auto",
                tree: vec![
                    n("div", "r", "width:100px;height:20px", vec![]),
                    n(
                        "div",
                        "f",
                        "position:absolute;width:50px;height:30px",
                        vec![],
                    ),
                ],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "window",
                dims: [50.0, 30.0],
                reference: [8.0, 8.0, 100.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [8.0, 8.0, 100.0, 20.0],
                scale: None,
                convert: [5.5, 7.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["window", "vv", "body"],
                bounding: [8.0, 8.0, 100.0, 20.0],
            },
            Case {
                name: "overflow_outside_fixed",
                body: "",
                tree: vec![n(
                    "div",
                    "o",
                    "overflow:hidden;width:100px;height:100px;margin-left:30px",
                    vec![n(
                        "div",
                        "x",
                        "position:fixed;top:20px;left:10px;width:300px;height:200px;overflow:hidden",
                        vec![
                            n("div", "r", "width:20px;height:20px", vec![]),
                            n("div", "f", "width:30px;height:30px", vec![]),
                        ],
                    )],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "x",
                dims: [30.0, 30.0],
                reference: [0.0, 0.0, 20.0, 20.0],
                clip_viewport: [10.0, 20.0, 300.0, 200.0],
                clip_document: [10.0, 20.0, 300.0, 200.0],
                clip_reference: [10.0, 20.0, 20.0, 20.0],
                scale: Some([1.0, 1.0]),
                convert: [15.5, 27.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["x", "o", "window", "vv"],
                bounding: [10.0, 20.0, 20.0, 20.0],
            },
            Case {
                name: "abs_in_overflow_in_relative",
                body: "",
                tree: vec![n(
                    "div",
                    "p",
                    "position:relative;margin:10px;padding:7px;border:1px solid",
                    vec![n(
                        "div",
                        "o",
                        "overflow:hidden;width:100px;height:100px",
                        vec![
                            n("div", "r", "width:20px;height:20px", vec![]),
                            n(
                                "div",
                                "f",
                                "position:absolute;width:30px;height:30px",
                                vec![],
                            ),
                        ],
                    )],
                )],
                strategy: Strategy::Absolute,
                scrolls: vec![],
                op: "p",
                dims: [30.0, 30.0],
                reference: [7.0, 7.0, 20.0, 20.0],
                clip_viewport: [0.0, 0.0, 800.0, 600.0],
                clip_document: [0.0, 0.0, 800.0, 600.0],
                clip_reference: [26.0, 18.0, 20.0, 20.0],
                scale: Some([1.0, 1.0]),
                convert: [24.5, 18.25, 11.0, 13.0],
                rtl: false,
                ancestors: vec!["o", "window", "vv"],
                bounding: [26.0, 18.0, 20.0, 20.0],
            },
        ]
    }

    #[test]
    fn floating_platform_matches_chromium() {
        let mut failures = vec![];
        for case in cases() {
            let mut fx = Fixture::new(case.body, case.tree);
            for &(id, left, top) in &case.scrolls {
                fx.scroll(id, left, top);
            }
            let host = fx.host();
            let (r, f) = (fx.id("r"), fx.id("f"));
            let mut check = |what: &str, got: &[f64], want: &[f64]| {
                if got.len() != want.len() || got.iter().zip(want).any(|(a, b)| !same(*a, *b)) {
                    failures.push(format!(
                        "{}: {what}: got {got:?}, Chromium {want:?}",
                        case.name
                    ));
                }
            };
            let op = host.floating_offset_parent(f);
            let dims = host.floating_dimensions(f);
            check("dimensions", &[dims.width, dims.height], &case.dims);
            let reference = host.floating_rect_relative_to_offset_parent(r, &op, case.strategy);
            check("reference rect", &rect(reference), &case.reference);
            let clip = host.floating_clipping_rect(
                f,
                &Boundary::ClippingAncestors,
                &RootBoundary::Viewport,
                case.strategy,
            );
            check("clipping rect (viewport)", &rect(clip), &case.clip_viewport);
            let clip = host.floating_clipping_rect(
                f,
                &Boundary::ClippingAncestors,
                &RootBoundary::Document,
                case.strategy,
            );
            check("clipping rect (document)", &rect(clip), &case.clip_document);
            let root = Rect {
                x: 1.0,
                y: 2.0,
                width: 300.0,
                height: 400.0,
            };
            let clip = host.floating_clipping_rect(
                r,
                &Boundary::Elements(vec![r]),
                &RootBoundary::Rect(root),
                case.strategy,
            );
            check(
                "clipping rect (boundary)",
                &rect(clip),
                &case.clip_reference,
            );
            if let (OffsetParent::Element(e), Some(want)) = (&op, case.scale) {
                let s = host.floating_scale(*e);
                check("scale", &[s.x, s.y], &want);
            }
            let given = Rect {
                x: 5.5,
                y: 7.25,
                width: 11.0,
                height: 13.0,
            };
            let converted = host.floating_convert_rect(f, given, &op, case.strategy);
            check("converted rect", &rect(converted), &case.convert);
            let rtl = host.floating_is_rtl(f);
            check("isRTL", &[rtl as u8 as f64], &[case.rtl as u8 as f64]);
            let bounding = host.floating_bounding_rect(r);
            check("bounding rect", &rect(bounding), &case.bounding);
            let op_name = match op {
                OffsetParent::Element(e) => fx.name(e),
                OffsetParent::Window => "window".into(),
            };
            if op_name != case.op {
                failures.push(format!(
                    "{}: offset parent: got {op_name}, Chromium {}",
                    case.name, case.op
                ));
            }
            let ancestors: Vec<String> = host
                .floating_overflow_ancestors(r)
                .into_iter()
                .map(|a| match a {
                    OverflowAncestor::Element(e) => fx.name(e),
                    OverflowAncestor::Window => "window".into(),
                    OverflowAncestor::VisualViewport => "vv".into(),
                })
                .collect();
            if ancestors != case.ancestors {
                failures.push(format!(
                    "{}: overflow ancestors: got {ancestors:?}, Chromium {:?}",
                    case.name, case.ancestors
                ));
            }
        }
        assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    }

    fn offset_parent_name(fx: &mut Fixture, id: &str) -> String {
        let node = fx.ids[id];
        let reader = Reader::new(&mut fx.doc).unwrap();
        let got = reader.offset_parent_property(node);
        got.map_or("null".to_string(), |g| fx.name(g.as_u64()))
    }

    /// `element.offsetParent` as measured in the conformance Chromium: an
    /// ancestor `a` with `style` above a static, a fixed and an absolutely
    /// positioned child (`None`: not measured).
    #[test]
    fn offset_parent_property_matches_chromium() {
        let block: &[(&str, [Option<&str>; 3])] = &[
            ("transform: translateX(1px)", [Some("a"), None, None]),
            ("transform: none", [Some("body"), None, None]),
            ("translate: 1px", [Some("a"), None, None]),
            ("scale: 2", [Some("a"), None, None]),
            ("rotate: 1deg", [Some("a"), None, None]),
            ("perspective: 10px", [Some("a"), None, None]),
            ("filter: blur(1px)", [Some("a"), None, None]),
            ("backdrop-filter: blur(1px)", [Some("a"), None, None]),
            ("will-change: transform", [Some("a"), None, None]),
            ("will-change: filter", [Some("a"), None, None]),
            ("will-change: opacity", [Some("body"), None, None]),
            ("will-change: perspective", [Some("a"), None, None]),
            ("will-change: backdrop-filter", [Some("a"), None, None]),
            ("will-change: Transform", [Some("a"), None, None]),
            ("contain: paint", [Some("a"), None, None]),
            ("contain: layout", [Some("a"), None, None]),
            ("contain: size", [Some("body"), None, None]),
            ("contain: style", [Some("body"), None, None]),
            ("contain: strict", [Some("a"), None, None]),
            ("contain: content", [Some("a"), None, None]),
            ("transform-style: preserve-3d", [Some("a"), None, None]),
            ("position: relative", [Some("a"), None, None]),
            ("position: sticky", [Some("a"), None, None]),
            ("overflow: hidden", [Some("body"), None, None]),
            ("will-change: translate", [Some("a"), Some("a"), Some("a")]),
            ("will-change: scale", [Some("a"), Some("a"), Some("a")]),
            ("will-change: rotate", [Some("a"), Some("a"), Some("a")]),
            (
                "will-change: offset-path",
                [Some("a"), Some("a"), Some("a")],
            ),
            (
                "will-change: contents",
                [Some("body"), Some("null"), Some("body")],
            ),
            (
                "will-change: position",
                [Some("a"), Some("null"), Some("a")],
            ),
            ("will-change: contain", [Some("a"), Some("a"), Some("a")]),
            (
                "will-change: transform-style",
                [Some("a"), Some("a"), Some("a")],
            ),
            ("filter: none", [Some("body"), Some("null"), Some("body")]),
            (
                "backdrop-filter: none",
                [Some("body"), Some("null"), Some("body")],
            ),
            (
                "clip-path: inset(1px)",
                [Some("body"), Some("null"), Some("body")],
            ),
            ("opacity: 0.5", [Some("body"), Some("null"), Some("body")]),
            (
                "isolation: isolate",
                [Some("body"), Some("null"), Some("body")],
            ),
            (
                "mix-blend-mode: multiply",
                [Some("body"), Some("null"), Some("body")],
            ),
            (
                "contain: inline-size",
                [Some("body"), Some("null"), Some("body")],
            ),
            (
                "contain: layout; display: inline",
                [Some("body"), Some("null"), Some("body")],
            ),
            (
                "contain: paint; display: inline",
                [Some("body"), Some("null"), Some("body")],
            ),
        ];
        let inline: &[(&str, &str)] = &[
            ("transform: translateX(1px)", "body"),
            ("filter: blur(1px)", "a"),
            ("backdrop-filter: blur(1px)", "a"),
            ("will-change: transform", "body"),
            ("will-change: filter", "a"),
            ("will-change: backdrop-filter", "a"),
            ("will-change: position", "a"),
            ("will-change: contain", "body"),
            ("contain: paint", "body"),
            ("position: relative", "a"),
            ("position: sticky", "a"),
        ];
        let mut failures = vec![];
        for (style, want) in block {
            for (i, child) in ["static", "fixed", "absolute"].iter().enumerate() {
                let Some(want) = want[i] else { continue };
                let mut fx = Fixture::new(
                    "",
                    vec![n(
                        "div",
                        "a",
                        style,
                        vec![n(
                            "div",
                            "x",
                            ["", "position:fixed", "position:absolute"][i],
                            vec![],
                        )],
                    )],
                );
                let got = offset_parent_name(&mut fx, "x");
                if got != want {
                    failures.push(format!("{style} ({child}): got {got}, Chromium {want}"));
                }
            }
        }
        for (style, want) in inline {
            let mut fx = Fixture::new(
                "",
                vec![n(
                    "span",
                    "a",
                    style,
                    vec![n("b", "x", "display:inline-block", vec![])],
                )],
            );
            let got = offset_parent_name(&mut fx, "x");
            if got != *want {
                failures.push(format!("inline {style}: got {got}, Chromium {want}"));
            }
        }
        // A fixed element in a positioned box, an element in an undisplayed
        // box, an undisplayed element, the body, an element in a positioned
        // `display: contents` box.
        let mut fx = Fixture::new(
            "",
            vec![
                n(
                    "div",
                    "rel",
                    "position:relative",
                    vec![n("div", "fx", "position:fixed", vec![])],
                ),
                n(
                    "div",
                    "",
                    "display:none",
                    vec![n("div", "innone", "", vec![])],
                ),
                n("div", "dn", "display:none", vec![]),
                n(
                    "div",
                    "",
                    "display:contents;position:relative",
                    vec![n("div", "inc", "", vec![])],
                ),
            ],
        );
        let got: Vec<String> = ["fx", "innone", "dn", "body", "inc"]
            .iter()
            .map(|x| offset_parent_name(&mut fx, x))
            .collect();
        if got != ["null", "null", "null", "null", "body"] {
            failures.push(format!("fixed/undisplayed/body/contents: got {got:?}"));
        }
        assert!(failures.is_empty(), "\n{}", failures.join("\n"));
    }

    /// Chromium's serialisation of used lengths (measured: six significant
    /// digits, ties to even).
    #[test]
    fn serialized_px_matches_chromium() {
        for (px, want) in [
            (123.0625, 123.062),
            (123.1875, 123.188),
            (12.09375, 12.0938),
            (12.03125, 12.0312),
            (1.015625, 1.01562),
            (1.046875, 1.04688),
            (4567.5, 4567.5),
            (45678.5, 45678.5),
            (456789.5, 456790.0),
            (0.015625, 0.015625),
            (1234.015625, 1234.02),
            (33.328125, 33.3281),
            (10.140625, 10.1406),
            (0.0, 0.0),
        ] {
            let units = (px * 64.0) as i64;
            assert_eq!(serialized_px(units), want, "{px}");
        }
    }
}
