//! `tabbable` 6.5.0 over the Blitz document (M6 overlays: bits-ui's focus
//! scope and menus): `tabbable`, `focusable`, `isTabbable` and `isFocusable`
//! with the options bits-ui passes (`{ includeContainer, getShadowRoot: true
//! }`, or none) and the default `displayCheck` (`'full'`), ported function
//! by function as Chromium evaluates them.
//!
//! `getShadowRoot: true` selects the package's iterative candidate walk
//! (`getCandidatesIteratively`) instead of `querySelectorAll`; it enables
//! shadow DOM support but presumes no undisclosed shadows (it is not a
//! function), and the runtime has no shadow roots, so the walk descends into
//! every element's light children. What remains of the shadow support is the
//! `<slot>` handling: outside a shadow tree a slot has no assigned elements,
//! so its children form a scope (`{ scopeParent, candidates }`), which
//! `tabbable` sorts as one item at the slot's tab index (0 without a
//! `tabindex` attribute) and `focusable` flattens; the slot itself is never a
//! candidate. `isTabbable(node, { getShadowRoot: true })` and
//! `isTabbable(node)` agree (the option only matters for undisclosed
//! shadows, which `true` does not presume).
//!
//! The element properties the package reads are Chromium's (measured in the
//! conformance Chromium): `tabIndex` is the `tabindex` attribute parsed by
//! the HTML rules for integers (ASCII whitespace, a sign, digits; out of the
//! 32-bit range is an error), else 0 for `a`, `area`, `button`, `input`,
//! `select`, `textarea`, `iframe`, `object`, `audio`, `video` and a details
//! element's first summary, else -1 (`details` and editing hosts included).
//! `disabled` reflects the attribute on the elements that have the property;
//! `form` is the form owner; `checked` the live checkedness.
//!
//! The display check is `getClientRects().length`: an attached element has
//! client rects iff it has a box (an empty inline element has one rect in
//! Chromium as well; `display: contents` has none). Chromium renders no
//! children of `video`, `audio` and `canvas` (measured); the runtime's Blitz
//! may, so they are answered as Chromium has them. What the runtime cannot
//! answer as Chromium does is reported with [`crate::unsupported`]:
//!
//! - an SVG element inside an `<svg>` reaching the display check (Chromium
//!   gives its SVG bounding box; Blitz draws the `<svg>` as one image), and
//!   an SVG element's default `tabIndex`;
//! - elements inside `img`, `iframe`, `embed`, `object`, `input`,
//!   `textarea`, `select`, `meter` and `progress` (whether Chromium renders
//!   them depends on the element's state: a list box's options have boxes, a
//!   drop-down's do not; an object shows its fallback until it loads);
//! - `hidden="until-found"` (Chromium keeps the box with `content-visibility:
//!   hidden`; Blitz's presentational `hidden` is `display: none` for every
//!   value);
//! - a node that is not an element (the package's `matches` call throws).

use blitz_dom::{BaseDocument, Node, ns};
use blitz_traits::node_id::NodeId;
use runic_js::{JsString, Maybe};
use std::collections::VecDeque;

use crate::dom::Host;

impl Host {
    /// `tabbable(container, { includeContainer, getShadowRoot: true })`: the
    /// tabbable elements in the container, positive tab indexes first
    /// (ascending, then in document order), then the rest in document order.
    pub fn tabbables(&self, container: u64, include_container: bool) -> Vec<u64> {
        let Some(dom) = self.dom() else {
            return vec![];
        };
        crate::layout::resolve(dom.doc);
        let doc = &*dom.doc;
        let container = NodeId::from_u64(container);
        if element(doc, container).is_none() {
            crate::unsupported("tabbable: a container that is not an element");
            return vec![];
        }
        let candidates = candidates(doc, &[container], include_container, false, &|n| {
            tabbable_filter(doc, n)
        });
        sort_by_order(doc, &candidates)
            .into_iter()
            .map(NodeId::as_u64)
            .collect()
    }

    /// `focusable(container, { includeContainer, getShadowRoot: true })`:
    /// the focusable elements in the container, in document order.
    pub fn focusables(&self, container: u64, include_container: bool) -> Vec<u64> {
        let Some(dom) = self.dom() else {
            return vec![];
        };
        crate::layout::resolve(dom.doc);
        let doc = &*dom.doc;
        let container = NodeId::from_u64(container);
        if element(doc, container).is_none() {
            crate::unsupported("focusable: a container that is not an element");
            return vec![];
        }
        let mut out = vec![];
        flatten(
            &candidates(doc, &[container], include_container, true, &|n| {
                focusable_filter(doc, n)
            }),
            &mut out,
        );
        out.into_iter().map(NodeId::as_u64).collect()
    }

    /// `isTabbable(node)` (the same with `{ getShadowRoot: true }`).
    pub fn is_tabbable(&self, node: u64) -> bool {
        let Some(dom) = self.dom() else {
            return false;
        };
        crate::layout::resolve(dom.doc);
        let doc = &*dom.doc;
        let node = NodeId::from_u64(node);
        if element(doc, node).is_none() {
            crate::unsupported("isTabbable: a node that is not an element");
            return false;
        }
        is_candidate(doc, node, false) && tabbable_filter(doc, node)
    }

    /// `isFocusable(node)` (the same with `{ getShadowRoot: true }`): an
    /// `iframe` is a candidate here, unlike in `focusable()`.
    pub fn is_focusable(&self, node: u64) -> bool {
        let Some(dom) = self.dom() else {
            return false;
        };
        crate::layout::resolve(dom.doc);
        let doc = &*dom.doc;
        let node = NodeId::from_u64(node);
        if element(doc, node).is_none() {
            crate::unsupported("isFocusable: a node that is not an element");
            return false;
        }
        is_candidate(doc, node, true) && focusable_filter(doc, node)
    }
}

/// A candidate of the iterative walk: an element, or a slot's scope.
enum Candidate {
    Element(NodeId),
    Scope(NodeId, Vec<Candidate>),
}

fn flatten(items: &[Candidate], out: &mut Vec<NodeId>) {
    for item in items {
        match item {
            Candidate::Element(e) => out.push(*e),
            Candidate::Scope(_, inner) => flatten(inner, out),
        }
    }
}

fn element(doc: &BaseDocument, node: NodeId) -> Option<&Node> {
    doc.get_node(node).filter(|n| n.element_data().is_some())
}

/// The local name (what a type selector compares).
fn local_name(doc: &BaseDocument, node: NodeId) -> Option<&str> {
    Some(&doc.get_node(node)?.element_data()?.name.local)
}

/// The lowercased `tagName` of an HTML element (`tagName === 'INPUT'` is
/// false outside the HTML namespace).
fn html_tag(doc: &BaseDocument, node: NodeId) -> Option<&str> {
    let e = doc.get_node(node)?.element_data()?;
    (e.name.ns == ns!(html)).then_some(&*e.name.local)
}

fn attr<'a>(doc: &'a BaseDocument, node: NodeId, name: &str) -> Option<&'a str> {
    doc.get_node(node)?.attr(name.into())
}

fn parent_element(doc: &BaseDocument, node: NodeId) -> Option<NodeId> {
    let parent = doc.get_node(node)?.parent?;
    element(doc, parent).map(|_| parent)
}

/// The element ancestors of `node`, nearest first (not `node` itself).
fn ancestors(doc: &BaseDocument, node: NodeId) -> impl Iterator<Item = NodeId> + '_ {
    std::iter::successors(parent_element(doc, node), move |&n| parent_element(doc, n))
}

/// `element.children`.
fn children(doc: &BaseDocument, node: NodeId) -> Vec<NodeId> {
    doc.get_node(node).map_or(vec![], |n| {
        n.children
            .iter()
            .copied()
            .filter(|&c| element(doc, c).is_some())
            .collect()
    })
}

/// The nodes of the subtree at `root` (not `root`), in tree order.
fn descendants(doc: &BaseDocument, root: NodeId) -> Vec<NodeId> {
    let mut out = crate::events::subtree_order(doc, root);
    out.remove(0);
    out
}

fn in_document(doc: &BaseDocument, node: NodeId) -> bool {
    doc.get_node(node).is_some_and(|n| n.flags.is_in_document())
}

/// `details>summary:first-of-type`.
fn is_details_summary(doc: &BaseDocument, node: NodeId) -> bool {
    let Some(e) = doc.get_node(node).and_then(|n| n.element_data()) else {
        return false;
    };
    if &*e.name.local != "summary" {
        return false;
    }
    let Some(parent) = parent_element(doc, node) else {
        return false;
    };
    if local_name(doc, parent) != Some("details") {
        return false;
    }
    children(doc, parent).into_iter().find(|&c| {
        doc.get_node(c)
            .and_then(|n| n.element_data())
            .is_some_and(|x| x.name == e.name)
    }) == Some(node)
}

/// `[inert], [inert] *`: the `inert` attribute, with any value, on the
/// element or an ancestor (the selectors' part of the inert check; the
/// walk's own `isInert(node, false)` only skips subtrees these exclude).
fn inert_inclusive(doc: &BaseDocument, node: NodeId) -> bool {
    std::iter::once(node)
        .chain(ancestors(doc, node))
        .any(|n| attr(doc, n, "inert").is_some())
}

/// `isInert(node, false)`: its own `inert` attribute is empty or `true`.
fn is_inert_self(doc: &BaseDocument, node: NodeId) -> bool {
    matches!(attr(doc, node, "inert"), Some("" | "true"))
}

/// `isContentEditable(node)`: the attribute is empty or `true`.
fn is_content_editable(doc: &BaseDocument, node: NodeId) -> bool {
    matches!(attr(doc, node, "contenteditable"), Some("" | "true"))
}

/// `node.matches(candidateSelector)` (with `iframe` for
/// `focusableCandidateSelector`).
fn is_candidate(doc: &BaseDocument, node: NodeId, with_iframe: bool) -> bool {
    let Some(tag) = local_name(doc, node) else {
        return false;
    };
    if inert_inclusive(doc, node) {
        return false;
    }
    let has = |name: &str| attr(doc, node, name).is_some();
    match tag {
        "input" | "select" | "textarea" | "button" | "details" => return true,
        "a" | "area" if has("href") => return true,
        "audio" | "video" if has("controls") => return true,
        "iframe" if with_iframe => return true,
        _ => {}
    }
    (has("tabindex") && tag != "slot")
        || attr(doc, node, "contenteditable").is_some_and(|v| v != "false")
        || is_details_summary(doc, node)
}

/// `getCandidatesIteratively(elements, includeContainer, { filter, flatten
/// })` without shadow roots: tree order, skipping inert subtrees; a slot
/// gives a scope of its children (its assigned elements are none outside a
/// shadow tree), spliced in place when flattening.
fn candidates(
    doc: &BaseDocument,
    elements: &[NodeId],
    include_container: bool,
    flatten: bool,
    filter: &dyn Fn(NodeId) -> bool,
) -> Vec<Candidate> {
    let mut out = vec![];
    let mut to_check: VecDeque<NodeId> = elements.iter().copied().collect();
    while let Some(el) = to_check.pop_front() {
        if is_inert_self(doc, el) {
            continue;
        }
        if html_tag(doc, el) == Some("slot") {
            let nested = candidates(doc, &children(doc, el), true, flatten, filter);
            if flatten {
                out.extend(nested);
            } else {
                out.push(Candidate::Scope(el, nested));
            }
        } else {
            if is_candidate(doc, el, false)
                && filter(el)
                && (include_container || !elements.contains(&el))
            {
                out.push(Candidate::Element(el));
            }
            for (i, child) in children(doc, el).into_iter().enumerate() {
                to_check.insert(i, child);
            }
        }
    }
    out
}

/// The HTML rules for parsing integers, as Chromium applies them to
/// `tabindex` (an error outside the 32-bit range).
fn html_integer(value: &str) -> Option<i32> {
    let s = value.trim_start_matches(['\t', '\n', '\x0C', '\r', ' ']);
    let (negative, s) = match s.as_bytes().first() {
        Some(b'-') => (true, &s[1..]),
        Some(b'+') => (false, &s[1..]),
        _ => (false, s),
    };
    let digits = s.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let mut v: i64 = 0;
    for b in s[..digits].bytes() {
        v = v.checked_mul(10)?.checked_add(i64::from(b - b'0'))?;
        if v > i64::from(i32::MAX) + 1 {
            return None;
        }
    }
    i32::try_from(if negative { -v } else { v }).ok()
}

/// `element.tabIndex` in Chromium.
fn tab_index_property(doc: &BaseDocument, node: NodeId) -> i32 {
    if let Some(v) = attr(doc, node, "tabindex").and_then(html_integer) {
        return v;
    }
    match html_tag(doc, node) {
        Some(
            "a" | "area" | "button" | "input" | "select" | "textarea" | "iframe" | "object"
            | "audio" | "video",
        ) => 0,
        // The summary for its parent details.
        Some("summary") => {
            let main = parent_element(doc, node).is_some_and(|p| {
                html_tag(doc, p) == Some("details")
                    && children(doc, p)
                        .into_iter()
                        .find(|&c| html_tag(doc, c) == Some("summary"))
                        == Some(node)
            });
            if main { 0 } else { -1 }
        }
        Some(_) => -1,
        None => {
            crate::unsupported("tabbable: the default tabIndex of an SVG element");
            -1
        }
    }
}

/// `hasTabIndex(node)`: `!isNaN(parseInt(node.getAttribute('tabindex'), 10))`.
fn has_tab_index(doc: &BaseDocument, node: NodeId) -> bool {
    attr(doc, node, "tabindex")
        .is_some_and(|v| !runic_js::parse_int(&JsString::from(v), Maybe::Some(10.0)).is_nan())
}

/// `getTabIndex(node)`.
fn get_tab_index(doc: &BaseDocument, node: NodeId) -> i32 {
    let t = tab_index_property(doc, node);
    if t < 0
        && (matches!(html_tag(doc, node), Some("audio" | "video" | "details"))
            || is_content_editable(doc, node))
        && !has_tab_index(doc, node)
    {
        return 0;
    }
    t
}

/// `getSortOrderTabIndex(node, isScope)`.
fn sort_order_tab_index(doc: &BaseDocument, node: NodeId, is_scope: bool) -> i32 {
    let t = get_tab_index(doc, node);
    if t < 0 && is_scope && !has_tab_index(doc, node) {
        return 0;
    }
    t
}

/// `sortByOrder(candidates)`: items with a non-zero tab index by tab index,
/// then position (a scope sorted within, as one item); then the rest.
fn sort_by_order(doc: &BaseDocument, items: &[Candidate]) -> Vec<NodeId> {
    let mut regular = vec![];
    let mut ordered: Vec<(i32, usize, Vec<NodeId>)> = vec![];
    for (i, item) in items.iter().enumerate() {
        let (tab_index, elements) = match item {
            Candidate::Element(e) => (sort_order_tab_index(doc, *e, false), vec![*e]),
            Candidate::Scope(slot, inner) => (
                sort_order_tab_index(doc, *slot, true),
                sort_by_order(doc, inner),
            ),
        };
        if tab_index == 0 {
            regular.extend(elements);
        } else {
            ordered.push((tab_index, i, elements));
        }
    }
    ordered.sort_by_key(|o| (o.0, o.1));
    ordered
        .into_iter()
        .flat_map(|o| o.2)
        .chain(regular)
        .collect()
}

/// `node.disabled`: the reflected attribute on the elements with the property.
fn disabled_property(doc: &BaseDocument, node: NodeId) -> bool {
    matches!(
        html_tag(doc, node),
        Some(
            "button"
                | "input"
                | "select"
                | "textarea"
                | "fieldset"
                | "optgroup"
                | "option"
                | "link"
        )
    ) && attr(doc, node, "disabled").is_some()
}

/// An HTML `input` whose `type` property is `kind`.
fn input_of_type(doc: &BaseDocument, node: NodeId, kind: &str) -> bool {
    html_tag(doc, node) == Some("input")
        && attr(doc, node, "type").is_some_and(|t| t.eq_ignore_ascii_case(kind))
}

/// `details:not([open]) *`.
fn in_closed_details(doc: &BaseDocument, node: NodeId) -> bool {
    ancestors(doc, node)
        .any(|a| local_name(doc, a) == Some("details") && attr(doc, a, "open").is_none())
}

/// Whether an attached element has client rects (`getClientRects().length`).
fn has_client_rects(doc: &BaseDocument, node: NodeId) -> bool {
    let svg = |n: NodeId| {
        doc.get_node(n)
            .and_then(|x| x.element_data())
            .is_some_and(|e| e.name.ns == ns!(svg))
    };
    if svg(node) && parent_element(doc, node).is_some_and(svg) {
        crate::unsupported("tabbable: the client rects of an element inside an <svg>");
    }
    for a in std::iter::once(node).chain(ancestors(doc, node)) {
        if attr(doc, a, "hidden").is_some_and(|v| v.eq_ignore_ascii_case("until-found")) {
            crate::unsupported("tabbable: hidden=\"until-found\"");
        }
        if a == node {
            continue;
        }
        match html_tag(doc, a) {
            Some("video" | "audio" | "canvas") => return false,
            Some(
                tag @ ("img" | "iframe" | "embed" | "object" | "input" | "textarea" | "select"
                | "meter" | "progress"),
            ) => crate::unsupported(&format!(
                "tabbable: whether an element inside <{tag}> has client rects"
            )),
            _ => {}
        }
    }
    crate::layout::rendered(doc, node)
}

/// `isHidden(node, { displayCheck: 'full' })`.
fn is_hidden(doc: &BaseDocument, node: NodeId) -> bool {
    // A detached element has an empty computed style, no closed details
    // ancestor matters, and it is hidden as not attached.
    if !in_document(doc, node) {
        return true;
    }
    // An element without styles is inside a `display: none` subtree: hidden
    // whatever its visibility, as it has no client rects. (Its style is not
    // computed on demand: Blitz's `resolve_undisplayed_style` trips Stylo's
    // thread-state assertion outside a traversal.)
    if doc
        .get_node(node)
        .is_none_or(|n| n.primary_styles().is_none())
    {
        return true;
    }
    let visibility = doc.resolved_style_value(node, "visibility");
    if visibility == "hidden" || visibility == "collapse" {
        return true;
    }
    let under = if is_details_summary(doc, node) {
        parent_element(doc, node).unwrap_or(node)
    } else {
        node
    };
    if in_closed_details(doc, under) {
        return true;
    }
    !has_client_rects(doc, node)
}

/// `isDetailsWithSummary(node)`.
fn is_details_with_summary(doc: &BaseDocument, node: NodeId) -> bool {
    html_tag(doc, node) == Some("details")
        && children(doc, node)
            .into_iter()
            .any(|c| html_tag(doc, c) == Some("summary"))
}

/// `isDisabledFromFieldset(node)`.
fn is_disabled_from_fieldset(doc: &BaseDocument, node: NodeId) -> bool {
    if !matches!(
        html_tag(doc, node),
        Some("input" | "button" | "select" | "textarea")
    ) {
        return false;
    }
    for parent in ancestors(doc, node) {
        if html_tag(doc, parent) == Some("fieldset") && attr(doc, parent, "disabled").is_some() {
            let legend = children(doc, parent)
                .into_iter()
                .find(|&c| html_tag(doc, c) == Some("legend"));
            return match legend {
                Some(legend) => {
                    let nested = ancestors(doc, parent).any(|a| {
                        local_name(doc, a) == Some("fieldset") && attr(doc, a, "disabled").is_some()
                    });
                    nested
                        || !std::iter::once(node)
                            .chain(ancestors(doc, node))
                            .any(|a| a == legend)
                }
                None => true,
            };
        }
    }
    false
}

/// `isNodeMatchingSelectorFocusable(options, node)`.
fn focusable_filter(doc: &BaseDocument, node: NodeId) -> bool {
    !(disabled_property(doc, node)
        || input_of_type(doc, node, "hidden")
        || is_hidden(doc, node)
        || is_details_with_summary(doc, node)
        || is_disabled_from_fieldset(doc, node))
}

/// `isNodeMatchingSelectorTabbable(options, node)`.
fn tabbable_filter(doc: &BaseDocument, node: NodeId) -> bool {
    !(is_non_tabbable_radio(doc, node)
        || get_tab_index(doc, node) < 0
        || !focusable_filter(doc, node))
}

/// `element.checked`: the live checkedness (the `checked` attribute until
/// Blitz has created the live state).
fn checked(doc: &BaseDocument, node: NodeId) -> bool {
    doc.get_node(node).is_some_and(|n| {
        n.element_data()
            .and_then(|e| e.checkbox_input_checked())
            .unwrap_or_else(|| n.attr("checked".into()).is_some())
    })
}

/// `element.form`: the form owner. A connected element with a `form`
/// attribute is owned by the first element in tree order with that ID if it
/// is a form (else none); otherwise by its nearest ancestor form.
fn form_owner(doc: &BaseDocument, node: NodeId) -> Option<NodeId> {
    runic_js::forms::form_owner(
        attr(doc, node, "form"),
        in_document(doc, node),
        |id| {
            crate::events::tree_order(doc)
                .into_iter()
                .find(|&n| element(doc, n).is_some() && attr(doc, n, "id") == Some(id))
                .map(|n| (n.as_u64(), html_tag(doc, n) == Some("form")))
        },
        ancestors(doc, node)
            .find(|&a| html_tag(doc, a) == Some("form"))
            .map(NodeId::as_u64),
    )
    .map(NodeId::from_u64)
}

/// `isTabbableRadio(node)`: unnamed, or the checked radio of its group
/// (`input[type="radio"][name="…"]` in its form or its tree, with the same
/// form owner), or a radio of a group without one.
fn is_tabbable_radio(doc: &BaseDocument, node: NodeId) -> bool {
    let Some(name) = attr(doc, node, "name").filter(|n| !n.is_empty()) else {
        return true;
    };
    let form = form_owner(doc, node);
    let scope = form.unwrap_or_else(|| {
        let mut root = node;
        while let Some(p) = doc.get_node(root).and_then(|n| n.parent) {
            root = p;
        }
        root
    });
    let checked = descendants(doc, scope).into_iter().find(|&r| {
        local_name(doc, r) == Some("input")
            && attr(doc, r, "type").is_some_and(|t| t.eq_ignore_ascii_case("radio"))
            && attr(doc, r, "name") == Some(name)
            && checked(doc, r)
            && form_owner(doc, r) == form
    });
    checked.is_none_or(|c| c == node)
}

/// `isNonTabbableRadio(node)`.
fn is_non_tabbable_radio(doc: &BaseDocument, node: NodeId) -> bool {
    input_of_type(doc, node, "radio") && !is_tabbable_radio(doc, node)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::{Dom, Listeners};
    use blitz_dom::DocumentConfig;
    use blitz_traits::shell::{ColorScheme, Viewport};
    use std::collections::HashMap;

    /// An element (tag, attributes in order, children) or a text node.
    enum T {
        E(
            &'static str,
            &'static [(&'static str, &'static str)],
            Vec<T>,
        ),
        Text(&'static str),
    }

    fn e(tag: &'static str, attrs: &'static [(&'static str, &'static str)], kids: Vec<T>) -> T {
        T::E(tag, attrs, kids)
    }

    fn t(text: &'static str) -> T {
        T::Text(text)
    }

    /// One document and the package's answers for it in the conformance
    /// Chromium: `tabbable` and `focusable` of the container with
    /// `{ includeContainer: false | true, getShadowRoot: true }`, and the
    /// elements (by id; every element has one) for which `isTabbable` and
    /// `isFocusable` are true.
    struct Case {
        name: &'static str,
        /// Built in a `div` that is not in the document.
        detached: bool,
        container: &'static str,
        tree: Vec<T>,
        tabbable: [&'static [&'static str]; 2],
        focusable: [&'static [&'static str]; 2],
        is_tabbable: &'static [&'static str],
        is_focusable: &'static [&'static str],
    }

    /// The case's document in an 800×600 viewport, built with the runtime's
    /// DOM operations (attributes set before the element is inserted, as
    /// the parser does).
    struct Fixture {
        doc: Box<BaseDocument>,
        listeners: Box<Listeners>,
        ids: HashMap<&'static str, NodeId>,
    }

    impl Fixture {
        fn new(detached: bool, tree: Vec<T>) -> Fixture {
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
            dom.append(html, head);
            dom.append(html, body);
            dom.append(root, html);
            fn build(
                dom: &mut Dom,
                parent: NodeId,
                nodes: Vec<T>,
                ids: &mut HashMap<&'static str, NodeId>,
            ) {
                for node in nodes {
                    match node {
                        T::Text(text) => {
                            let n = dom.text(text);
                            dom.append(parent, n);
                        }
                        T::E(tag, attrs, kids) => {
                            let el = dom.element(tag);
                            for &(name, value) in attrs {
                                dom.set_attr(el, name, value);
                                if name == "id" {
                                    ids.insert(value, el);
                                }
                            }
                            dom.append(parent, el);
                            build(dom, el, kids, ids);
                        }
                    }
                }
            }
            let mut ids = HashMap::new();
            let parent = if detached { dom.element("div") } else { body };
            build(&mut dom, parent, tree, &mut ids);
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

        fn names(&self, nodes: Vec<u64>) -> Vec<String> {
            nodes
                .into_iter()
                .map(|node| {
                    self.ids
                        .iter()
                        .find(|(_, v)| v.as_u64() == node)
                        .map_or_else(|| format!("#{node}"), |(k, _)| k.to_string())
                })
                .collect()
        }
    }

    #[test]
    fn matches_chromium() {
        let mut failures = vec![];
        for case in cases() {
            let mut fx = Fixture::new(case.detached, case.tree);
            let host = fx.host();
            let c = fx.ids[case.container].as_u64();
            for (i, include) in [false, true].into_iter().enumerate() {
                let got = fx.names(host.tabbables(c, include));
                if got != case.tabbable[i] {
                    failures.push(format!(
                        "{}: tabbable(includeContainer: {include}) = {got:?}, Chromium {:?}",
                        case.name, case.tabbable[i]
                    ));
                }
                let got = fx.names(host.focusables(c, include));
                if got != case.focusable[i] {
                    failures.push(format!(
                        "{}: focusable(includeContainer: {include}) = {got:?}, Chromium {:?}",
                        case.name, case.focusable[i]
                    ));
                }
            }
            let mut ids: Vec<(&str, NodeId)> = fx
                .ids
                .iter()
                .filter(|(k, _)| **k != "body")
                .map(|(k, v)| (*k, *v))
                .collect();
            ids.sort();
            for (id, node) in ids {
                let (tabbable, focusable) = (
                    host.is_tabbable(node.as_u64()),
                    host.is_focusable(node.as_u64()),
                );
                if tabbable != case.is_tabbable.contains(&id) {
                    failures.push(format!("{}: isTabbable({id}) = {tabbable}", case.name));
                }
                if focusable != case.is_focusable.contains(&id) {
                    failures.push(format!("{}: isFocusable({id}) = {focusable}", case.name));
                }
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[test]
    fn integers() {
        for (s, v) in [
            ("1.5", Some(1)),
            (" 2", Some(2)),
            ("+3", Some(3)),
            ("\u{a0}4", None),
            ("07", Some(7)),
            ("-0", Some(0)),
            ("99999999999", None),
            ("2147483647", Some(i32::MAX)),
            ("2147483648", None),
            ("-2147483648", Some(i32::MIN)),
            ("-2147483649", None),
            ("2abc", Some(2)),
            ("", None),
            (" ", None),
            ("\t5", Some(5)),
            ("\x0C6", Some(6)),
            ("-", None),
            ("+-1", None),
            ("0x10", Some(0)),
        ] {
            assert_eq!(html_integer(s), v, "{s:?}");
        }
    }

    /// Generated by `.cache/tabbable-vectors.mjs`: the real package in the
    /// conformance Chromium (Playwright headless, 800×600) on the same
    /// documents (`<!doctype html>`, inline styles).
    fn cases() -> Vec<Case> {
        vec![
            Case {
                name: "controls",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("button", &[("id", "b")], vec![t("B")]),
                        e("input", &[("id", "i")], vec![]),
                        e("a", &[("id", "a1"), ("href", "#")], vec![t("L")]),
                        e("a", &[("id", "a2")], vec![t("N")]),
                        e("textarea", &[("id", "t")], vec![]),
                        e(
                            "select",
                            &[("id", "s")],
                            vec![e("option", &[("id", "o")], vec![t("1")])],
                        ),
                        e("div", &[("id", "d")], vec![t("plain")]),
                        e("span", &[("id", "sp"), ("tabindex", "0")], vec![t("s")]),
                        e("a", &[("id", "a3"), ("href", "#")], vec![]),
                    ],
                )],
                tabbable: [
                    &["b", "i", "a1", "t", "s", "sp", "a3"],
                    &["b", "i", "a1", "t", "s", "sp", "a3"],
                ],
                focusable: [
                    &["b", "i", "a1", "t", "s", "sp", "a3"],
                    &["b", "i", "a1", "t", "s", "sp", "a3"],
                ],
                is_tabbable: &["b", "i", "a1", "t", "s", "sp", "a3"],
                is_focusable: &["b", "i", "a1", "t", "s", "sp", "a3"],
            },
            Case {
                name: "tabindex_order",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("button", &[("id", "b1"), ("tabindex", "2")], vec![t("1")]),
                        e("button", &[("id", "b2")], vec![t("2")]),
                        e("button", &[("id", "b3"), ("tabindex", "1")], vec![t("3")]),
                        e("div", &[("id", "d1"), ("tabindex", "0")], vec![t("4")]),
                        e("div", &[("id", "d2"), ("tabindex", "-1")], vec![t("5")]),
                        e("button", &[("id", "b4"), ("tabindex", "2")], vec![t("6")]),
                        e("button", &[("id", "b5"), ("tabindex", "-1")], vec![t("7")]),
                        e("div", &[("id", "d3"), ("tabindex", "abc")], vec![t("8")]),
                        e("div", &[("id", "d4"), ("tabindex", " 3")], vec![t("9")]),
                        e("div", &[("id", "d5"), ("tabindex", "+1")], vec![t("10")]),
                        e("a", &[("id", "a1"), ("tabindex", "x")], vec![t("11")]),
                        e(
                            "button",
                            &[("id", "b6"), ("tabindex", "1.5")],
                            vec![t("12")],
                        ),
                    ],
                )],
                tabbable: [
                    &["b3", "d5", "b6", "b1", "b4", "d4", "b2", "d1", "a1"],
                    &["b3", "d5", "b6", "b1", "b4", "d4", "b2", "d1", "a1"],
                ],
                focusable: [
                    &[
                        "b1", "b2", "b3", "d1", "d2", "b4", "b5", "d3", "d4", "d5", "a1", "b6",
                    ],
                    &[
                        "b1", "b2", "b3", "d1", "d2", "b4", "b5", "d3", "d4", "d5", "a1", "b6",
                    ],
                ],
                is_tabbable: &["b1", "b2", "b3", "d1", "b4", "d4", "d5", "a1", "b6"],
                is_focusable: &[
                    "b1", "b2", "b3", "d1", "d2", "b4", "b5", "d3", "d4", "d5", "a1", "b6",
                ],
            },
            Case {
                name: "tabindex_parse",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("div", &[("id", "n1"), ("tabindex", " 4")], vec![t("nbsp")]),
                        e(
                            "details",
                            &[("id", "d1"), ("tabindex", "99999999999")],
                            vec![t("overflow")],
                        ),
                        e(
                            "details",
                            &[("id", "d2"), ("tabindex", " 5")],
                            vec![t("nbsp")],
                        ),
                        e(
                            "details",
                            &[("id", "d3"), ("tabindex", "x")],
                            vec![t("invalid")],
                        ),
                        e(
                            "video",
                            &[("id", "v1"), ("controls", ""), ("tabindex", "x")],
                            vec![],
                        ),
                        e(
                            "div",
                            &[
                                ("id", "e1"),
                                ("contenteditable", ""),
                                ("tabindex", "2147483648"),
                            ],
                            vec![t("overflow")],
                        ),
                        e(
                            "div",
                            &[("id", "e2"), ("contenteditable", ""), ("tabindex", "\t2")],
                            vec![t("tab")],
                        ),
                        e(
                            "button",
                            &[("id", "b1"), ("tabindex", "2147483647")],
                            vec![t("max")],
                        ),
                        e(
                            "button",
                            &[("id", "b2"), ("tabindex", "-0")],
                            vec![t("minus zero")],
                        ),
                        e(
                            "button",
                            &[("id", "b3"), ("tabindex", "")],
                            vec![t("empty")],
                        ),
                    ],
                )],
                tabbable: [
                    &["e2", "b1", "d3", "v1", "b2", "b3"],
                    &["e2", "b1", "d3", "v1", "b2", "b3"],
                ],
                focusable: [
                    &["n1", "d1", "d2", "d3", "v1", "e1", "e2", "b1", "b2", "b3"],
                    &["n1", "d1", "d2", "d3", "v1", "e1", "e2", "b1", "b2", "b3"],
                ],
                is_tabbable: &["d3", "v1", "e2", "b1", "b2", "b3"],
                is_focusable: &["n1", "d1", "d2", "d3", "v1", "e1", "e2", "b1", "b2", "b3"],
            },
            Case {
                name: "disabled",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("button", &[("id", "b"), ("disabled", "")], vec![t("b")]),
                        e("input", &[("id", "i"), ("disabled", "")], vec![]),
                        e("select", &[("id", "s"), ("disabled", "")], vec![]),
                        e("textarea", &[("id", "t"), ("disabled", "")], vec![]),
                        e(
                            "div",
                            &[("id", "d"), ("tabindex", "0"), ("disabled", "")],
                            vec![t("d")],
                        ),
                        e(
                            "fieldset",
                            &[("id", "f"), ("tabindex", "0"), ("disabled", "")],
                            vec![e("legend", &[("id", "lg")], vec![t("x")])],
                        ),
                        e(
                            "a",
                            &[("id", "a"), ("href", "#"), ("disabled", "")],
                            vec![t("a")],
                        ),
                        e("button", &[("id", "b2")], vec![t("ok")]),
                    ],
                )],
                tabbable: [&["d", "a", "b2"], &["d", "a", "b2"]],
                focusable: [&["d", "a", "b2"], &["d", "a", "b2"]],
                is_tabbable: &["d", "a", "b2"],
                is_focusable: &["d", "a", "b2"],
            },
            Case {
                name: "fieldset",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "fieldset",
                            &[("id", "f1"), ("disabled", "")],
                            vec![
                                e(
                                    "legend",
                                    &[("id", "l1")],
                                    vec![
                                        e("input", &[("id", "li")], vec![]),
                                        e(
                                            "span",
                                            &[("id", "_1")],
                                            vec![e("button", &[("id", "lb")], vec![t("x")])],
                                        ),
                                    ],
                                ),
                                e("input", &[("id", "i1")], vec![]),
                                e(
                                    "legend",
                                    &[("id", "l2")],
                                    vec![e("input", &[("id", "li2")], vec![])],
                                ),
                                e("div", &[("id", "d1"), ("tabindex", "0")], vec![t("d")]),
                                e("a", &[("id", "a1"), ("href", "#")], vec![t("a")]),
                            ],
                        ),
                        e(
                            "fieldset",
                            &[("id", "f2"), ("disabled", "")],
                            vec![
                                e(
                                    "div",
                                    &[("id", "_2")],
                                    vec![e(
                                        "legend",
                                        &[("id", "_3")],
                                        vec![e(
                                            "button",
                                            &[("id", "nl")],
                                            vec![t("not a child legend")],
                                        )],
                                    )],
                                ),
                                e("select", &[("id", "s2")], vec![]),
                            ],
                        ),
                        e(
                            "fieldset",
                            &[("id", "f3")],
                            vec![
                                e(
                                    "legend",
                                    &[("id", "_4")],
                                    vec![e("input", &[("id", "i3")], vec![])],
                                ),
                                e("textarea", &[("id", "t3")], vec![]),
                            ],
                        ),
                    ],
                )],
                tabbable: [
                    &["li", "lb", "d1", "a1", "i3", "t3"],
                    &["li", "lb", "d1", "a1", "i3", "t3"],
                ],
                focusable: [
                    &["li", "lb", "d1", "a1", "i3", "t3"],
                    &["li", "lb", "d1", "a1", "i3", "t3"],
                ],
                is_tabbable: &["li", "lb", "d1", "a1", "i3", "t3"],
                is_focusable: &["li", "lb", "d1", "a1", "i3", "t3"],
            },
            Case {
                name: "fieldset_nested",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "fieldset",
                            &[("id", "o"), ("disabled", "")],
                            vec![e(
                                "legend",
                                &[("id", "_5")],
                                vec![
                                    e(
                                        "fieldset",
                                        &[("id", "in"), ("disabled", "")],
                                        vec![
                                            e(
                                                "legend",
                                                &[("id", "_6")],
                                                vec![e("input", &[("id", "x")], vec![])],
                                            ),
                                            e("input", &[("id", "y")], vec![]),
                                        ],
                                    ),
                                    e("button", &[("id", "z")], vec![t("z")]),
                                ],
                            )],
                        ),
                        e(
                            "fieldset",
                            &[("id", "o2")],
                            vec![e(
                                "fieldset",
                                &[("id", "in2"), ("disabled", "")],
                                vec![
                                    e(
                                        "legend",
                                        &[("id", "_7")],
                                        vec![e("input", &[("id", "p")], vec![])],
                                    ),
                                    e("input", &[("id", "q")], vec![]),
                                ],
                            )],
                        ),
                    ],
                )],
                tabbable: [&["z", "p"], &["z", "p"]],
                focusable: [&["z", "p"], &["z", "p"]],
                is_tabbable: &["z", "p"],
                is_focusable: &["z", "p"],
            },
            Case {
                name: "display_hidden",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "div",
                            &[("id", "h"), ("style", "display:none")],
                            vec![e("button", &[("id", "h1")], vec![t("x")])],
                        ),
                        e(
                            "button",
                            &[("id", "h2"), ("style", "display:none")],
                            vec![t("x")],
                        ),
                        e(
                            "div",
                            &[("id", "dc"), ("style", "display:contents")],
                            vec![e("button", &[("id", "h3")], vec![t("x")])],
                        ),
                        e(
                            "div",
                            &[
                                ("id", "h4"),
                                ("tabindex", "0"),
                                ("style", "display:contents"),
                            ],
                            vec![t("x")],
                        ),
                        e("button", &[("id", "h5"), ("hidden", "")], vec![t("x")]),
                        e("button", &[("id", "ok")], vec![t("x")]),
                    ],
                )],
                tabbable: [&["h3", "ok"], &["h3", "ok"]],
                focusable: [&["h3", "ok"], &["h3", "ok"]],
                is_tabbable: &["h3", "ok"],
                is_focusable: &["h3", "ok"],
            },
            Case {
                name: "visibility",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "div",
                            &[("id", "v"), ("style", "visibility:hidden")],
                            vec![
                                e("button", &[("id", "v1")], vec![t("x")]),
                                e(
                                    "button",
                                    &[("id", "v2"), ("style", "visibility:visible")],
                                    vec![t("x")],
                                ),
                            ],
                        ),
                        e(
                            "button",
                            &[("id", "v3"), ("style", "visibility:collapse")],
                            vec![t("x")],
                        ),
                        e(
                            "button",
                            &[("id", "v4"), ("style", "opacity:0")],
                            vec![t("x")],
                        ),
                    ],
                )],
                tabbable: [&["v2", "v4"], &["v2", "v4"]],
                focusable: [&["v2", "v4"], &["v2", "v4"]],
                is_tabbable: &["v2", "v4"],
                is_focusable: &["v2", "v4"],
            },
            Case {
                name: "zero_size",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "div",
                            &[
                                ("id", "z"),
                                ("tabindex", "0"),
                                ("style", "width:0;height:0"),
                            ],
                            vec![],
                        ),
                        e(
                            "button",
                            &[
                                ("id", "zb"),
                                ("style", "width:0;height:0;padding:0;border:0"),
                            ],
                            vec![],
                        ),
                        e(
                            "div",
                            &[("id", "_8"), ("style", "overflow:hidden;height:0")],
                            vec![e("button", &[("id", "clip")], vec![t("x")])],
                        ),
                        e(
                            "div",
                            &[
                                ("id", "_9"),
                                (
                                    "style",
                                    "position:relative;width:10px;height:10px;overflow:hidden",
                                ),
                            ],
                            vec![e(
                                "button",
                                &[("id", "off"), ("style", "position:absolute;left:100px")],
                                vec![t("x")],
                            )],
                        ),
                        e("a", &[("id", "empty"), ("href", "#")], vec![]),
                        e("span", &[("id", "es"), ("tabindex", "0")], vec![]),
                    ],
                )],
                tabbable: [
                    &["z", "zb", "clip", "off", "empty", "es"],
                    &["z", "zb", "clip", "off", "empty", "es"],
                ],
                focusable: [
                    &["z", "zb", "clip", "off", "empty", "es"],
                    &["z", "zb", "clip", "off", "empty", "es"],
                ],
                is_tabbable: &["z", "zb", "clip", "off", "empty", "es"],
                is_focusable: &["z", "zb", "clip", "off", "empty", "es"],
            },
            Case {
                name: "radios",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("input", &[("id", "u1"), ("type", "radio")], vec![]),
                        e(
                            "input",
                            &[("id", "u2"), ("type", "radio"), ("checked", "")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "g1"), ("type", "radio"), ("name", "g")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "g2"), ("type", "radio"), ("name", "g")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "h1"), ("type", "radio"), ("name", "h")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[
                                ("id", "h2"),
                                ("type", "radio"),
                                ("name", "h"),
                                ("checked", ""),
                            ],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "h3"), ("type", "radio"), ("name", "h")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "e1"), ("type", "radio"), ("name", "")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[
                                ("id", "k1"),
                                ("type", "RADIO"),
                                ("name", "k"),
                                ("checked", ""),
                            ],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "k2"), ("type", "radio"), ("name", "k")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "cb"), ("type", "checkbox"), ("name", "h")],
                            vec![],
                        ),
                    ],
                )],
                tabbable: [
                    &["u1", "u2", "g1", "g2", "h2", "e1", "k1", "cb"],
                    &["u1", "u2", "g1", "g2", "h2", "e1", "k1", "cb"],
                ],
                focusable: [
                    &[
                        "u1", "u2", "g1", "g2", "h1", "h2", "h3", "e1", "k1", "k2", "cb",
                    ],
                    &[
                        "u1", "u2", "g1", "g2", "h1", "h2", "h3", "e1", "k1", "k2", "cb",
                    ],
                ],
                is_tabbable: &["u1", "u2", "g1", "g2", "h2", "e1", "k1", "cb"],
                is_focusable: &[
                    "u1", "u2", "g1", "g2", "h1", "h2", "h3", "e1", "k1", "k2", "cb",
                ],
            },
            Case {
                name: "radio_forms",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "form",
                            &[("id", "f1")],
                            vec![
                                e(
                                    "input",
                                    &[
                                        ("id", "a1"),
                                        ("type", "radio"),
                                        ("name", "g"),
                                        ("checked", ""),
                                    ],
                                    vec![],
                                ),
                                e(
                                    "input",
                                    &[("id", "a2"), ("type", "radio"), ("name", "g")],
                                    vec![],
                                ),
                            ],
                        ),
                        e(
                            "form",
                            &[("id", "f2")],
                            vec![
                                e(
                                    "input",
                                    &[("id", "b1"), ("type", "radio"), ("name", "g")],
                                    vec![],
                                ),
                                e(
                                    "input",
                                    &[("id", "b2"), ("type", "radio"), ("name", "g")],
                                    vec![],
                                ),
                            ],
                        ),
                        e(
                            "input",
                            &[("id", "o1"), ("type", "radio"), ("name", "g")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[
                                ("id", "o2"),
                                ("type", "radio"),
                                ("name", "g"),
                                ("form", "f1"),
                            ],
                            vec![],
                        ),
                        e(
                            "input",
                            &[
                                ("id", "o3"),
                                ("type", "radio"),
                                ("name", "g"),
                                ("form", "nope"),
                            ],
                            vec![],
                        ),
                        e(
                            "input",
                            &[
                                ("id", "o4"),
                                ("type", "radio"),
                                ("name", "x y\"z"),
                                ("checked", ""),
                            ],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "o5"), ("type", "radio"), ("name", "x y\"z")],
                            vec![],
                        ),
                    ],
                )],
                tabbable: [
                    &["a1", "b1", "b2", "o1", "o3", "o4"],
                    &["a1", "b1", "b2", "o1", "o3", "o4"],
                ],
                focusable: [
                    &["a1", "a2", "b1", "b2", "o1", "o2", "o3", "o4", "o5"],
                    &["a1", "a2", "b1", "b2", "o1", "o2", "o3", "o4", "o5"],
                ],
                is_tabbable: &["a1", "b1", "b2", "o1", "o3", "o4"],
                is_focusable: &["a1", "a2", "b1", "b2", "o1", "o2", "o3", "o4", "o5"],
            },
            Case {
                name: "details",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "details",
                            &[("id", "d1")],
                            vec![
                                e("summary", &[("id", "s1")], vec![t("a")]),
                                e("button", &[("id", "db1")], vec![t("x")]),
                            ],
                        ),
                        e(
                            "details",
                            &[("id", "d2"), ("open", "")],
                            vec![
                                e("summary", &[("id", "s2")], vec![t("b")]),
                                e("button", &[("id", "db2")], vec![t("x")]),
                            ],
                        ),
                        e("details", &[("id", "d3")], vec![t("no summary")]),
                        e(
                            "details",
                            &[("id", "d4"), ("open", "")],
                            vec![
                                e("div", &[("id", "d4x")], vec![t("x")]),
                                e("summary", &[("id", "s4a")], vec![t("first")]),
                                e(
                                    "summary",
                                    &[("id", "s4b"), ("tabindex", "0")],
                                    vec![t("second")],
                                ),
                            ],
                        ),
                        e(
                            "details",
                            &[("id", "d5"), ("open", "")],
                            vec![e(
                                "details",
                                &[("id", "d6")],
                                vec![
                                    e("summary", &[("id", "s6")], vec![t("inner")]),
                                    e(
                                        "details",
                                        &[("id", "d7"), ("open", "")],
                                        vec![e("summary", &[("id", "s7")], vec![t("deep")])],
                                    ),
                                ],
                            )],
                        ),
                        e("details", &[("id", "d8"), ("tabindex", "-1")], vec![t("x")]),
                    ],
                )],
                tabbable: [
                    &["s1", "s2", "db2", "d3", "s4a", "s4b", "d5", "s6"],
                    &["s1", "s2", "db2", "d3", "s4a", "s4b", "d5", "s6"],
                ],
                focusable: [
                    &["s1", "s2", "db2", "d3", "s4a", "s4b", "d5", "s6", "d8"],
                    &["s1", "s2", "db2", "d3", "s4a", "s4b", "d5", "s6", "d8"],
                ],
                is_tabbable: &["s1", "s2", "db2", "d3", "s4a", "s4b", "d5", "s6"],
                is_focusable: &["s1", "s2", "db2", "d3", "s4a", "s4b", "d5", "s6", "d8"],
            },
            Case {
                name: "contenteditable",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "div",
                            &[("id", "e1"), ("contenteditable", "")],
                            vec![t("a")],
                        ),
                        e(
                            "div",
                            &[("id", "e2"), ("contenteditable", "true")],
                            vec![t("b")],
                        ),
                        e(
                            "div",
                            &[("id", "e3"), ("contenteditable", "false")],
                            vec![t("c")],
                        ),
                        e(
                            "div",
                            &[("id", "e4"), ("contenteditable", "plaintext-only")],
                            vec![t("d")],
                        ),
                        e(
                            "div",
                            &[("id", "e5"), ("contenteditable", "TRUE")],
                            vec![t("e")],
                        ),
                        e(
                            "div",
                            &[("id", "e6"), ("contenteditable", ""), ("tabindex", "-1")],
                            vec![t("f")],
                        ),
                        e(
                            "div",
                            &[("id", "e7"), ("contenteditable", "")],
                            vec![e("span", &[("id", "e7s")], vec![t("g")])],
                        ),
                        e(
                            "div",
                            &[("id", "e8"), ("contenteditable", ""), ("tabindex", "3")],
                            vec![t("h")],
                        ),
                    ],
                )],
                tabbable: [&["e8", "e1", "e2", "e7"], &["e8", "e1", "e2", "e7"]],
                focusable: [
                    &["e1", "e2", "e4", "e5", "e6", "e7", "e8"],
                    &["e1", "e2", "e4", "e5", "e6", "e7", "e8"],
                ],
                is_tabbable: &["e1", "e2", "e7", "e8"],
                is_focusable: &["e1", "e2", "e4", "e5", "e6", "e7", "e8"],
            },
            Case {
                name: "hidden_inputs",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("input", &[("id", "h1"), ("type", "hidden")], vec![]),
                        e("input", &[("id", "h2"), ("type", "HIDDEN")], vec![]),
                        e("input", &[("id", "t1"), ("type", "text")], vec![]),
                        e("input", &[("id", "t2"), ("type", "bogus")], vec![]),
                        e("input", &[("id", "cb"), ("type", "checkbox")], vec![]),
                        e(
                            "input",
                            &[("id", "h3"), ("type", "hidden"), ("tabindex", "0")],
                            vec![],
                        ),
                    ],
                )],
                tabbable: [&["t1", "t2", "cb"], &["t1", "t2", "cb"]],
                focusable: [&["t1", "t2", "cb"], &["t1", "t2", "cb"]],
                is_tabbable: &["t1", "t2", "cb"],
                is_focusable: &["t1", "t2", "cb"],
            },
            Case {
                name: "inert",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "div",
                            &[("id", "n"), ("inert", "")],
                            vec![e("button", &[("id", "n1")], vec![t("x")])],
                        ),
                        e("button", &[("id", "n2"), ("inert", "")], vec![t("x")]),
                        e(
                            "div",
                            &[("id", "nf"), ("inert", "false")],
                            vec![e("button", &[("id", "n3")], vec![t("x")])],
                        ),
                        e(
                            "div",
                            &[("id", "n4"), ("inert", ""), ("tabindex", "0")],
                            vec![t("x")],
                        ),
                        e("button", &[("id", "ok")], vec![t("x")]),
                    ],
                )],
                tabbable: [&["ok"], &["ok"]],
                focusable: [&["ok"], &["ok"]],
                is_tabbable: &["ok"],
                is_focusable: &["ok"],
            },
            Case {
                name: "inert_container",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c"), ("inert", ""), ("tabindex", "0")],
                    vec![e("button", &[("id", "b")], vec![t("x")])],
                )],
                tabbable: [&[], &[]],
                focusable: [&[], &[]],
                is_tabbable: &[],
                is_focusable: &[],
            },
            Case {
                name: "inert_ancestor",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "p"), ("inert", "false")],
                    vec![e(
                        "div",
                        &[("id", "c"), ("tabindex", "0")],
                        vec![e("button", &[("id", "b")], vec![t("x")])],
                    )],
                )],
                tabbable: [&[], &[]],
                focusable: [&[], &[]],
                is_tabbable: &[],
                is_focusable: &[],
            },
            Case {
                name: "include_container",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c"), ("tabindex", "0")],
                    vec![
                        e("button", &[("id", "b")], vec![t("x")]),
                        e("div", &[("id", "i"), ("tabindex", "1")], vec![t("y")]),
                    ],
                )],
                tabbable: [&["i", "b"], &["i", "c", "b"]],
                focusable: [&["b", "i"], &["c", "b", "i"]],
                is_tabbable: &["c", "b", "i"],
                is_focusable: &["c", "b", "i"],
            },
            Case {
                name: "container_negative",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c"), ("tabindex", "-1")],
                    vec![
                        e("button", &[("id", "b"), ("tabindex", "4")], vec![t("x")]),
                        e("button", &[("id", "b2")], vec![t("y")]),
                    ],
                )],
                tabbable: [&["b", "b2"], &["b", "b2"]],
                focusable: [&["b", "b2"], &["c", "b", "b2"]],
                is_tabbable: &["b", "b2"],
                is_focusable: &["c", "b", "b2"],
            },
            Case {
                name: "container_control",
                detached: false,
                container: "c",
                tree: vec![e(
                    "button",
                    &[("id", "c")],
                    vec![e("span", &[("id", "s"), ("tabindex", "0")], vec![t("x")])],
                )],
                tabbable: [&["s"], &["c", "s"]],
                focusable: [&["s"], &["c", "s"]],
                is_tabbable: &["c", "s"],
                is_focusable: &["c", "s"],
            },
            Case {
                name: "container_hidden",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c"), ("tabindex", "0"), ("style", "display:none")],
                    vec![e("button", &[("id", "b")], vec![t("x")])],
                )],
                tabbable: [&[], &[]],
                focusable: [&[], &[]],
                is_tabbable: &[],
                is_focusable: &[],
            },
            Case {
                name: "nested",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("button", &[("id", "x1"), ("tabindex", "3")], vec![t("a")]),
                        e(
                            "div",
                            &[("id", "c2"), ("tabindex", "1")],
                            vec![
                                e("button", &[("id", "x2"), ("tabindex", "2")], vec![t("b")]),
                                e(
                                    "div",
                                    &[("id", "c3")],
                                    vec![
                                        e("button", &[("id", "x3")], vec![t("c")]),
                                        e(
                                            "button",
                                            &[("id", "x4"), ("tabindex", "1")],
                                            vec![t("d")],
                                        ),
                                    ],
                                ),
                            ],
                        ),
                        e("button", &[("id", "x5")], vec![t("e")]),
                    ],
                )],
                tabbable: [
                    &["c2", "x4", "x2", "x1", "x3", "x5"],
                    &["c2", "x4", "x2", "x1", "x3", "x5"],
                ],
                focusable: [
                    &["x1", "c2", "x2", "x3", "x4", "x5"],
                    &["x1", "c2", "x2", "x3", "x4", "x5"],
                ],
                is_tabbable: &["x1", "c2", "x2", "x3", "x4", "x5"],
                is_focusable: &["x1", "c2", "x2", "x3", "x4", "x5"],
            },
            Case {
                name: "media",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("audio", &[("id", "au"), ("controls", "")], vec![]),
                        e("audio", &[("id", "au2"), ("tabindex", "0")], vec![]),
                        e("video", &[("id", "vi"), ("controls", "")], vec![]),
                        e("video", &[("id", "vi2")], vec![]),
                        e("video", &[("id", "vi3"), ("tabindex", "0")], vec![]),
                        e(
                            "video",
                            &[("id", "vi4"), ("controls", ""), ("tabindex", "-1")],
                            vec![],
                        ),
                        e(
                            "video",
                            &[("id", "vi5")],
                            vec![e("button", &[("id", "vb")], vec![t("x")])],
                        ),
                        e(
                            "canvas",
                            &[("id", "cv")],
                            vec![e("button", &[("id", "cb")], vec![t("x")])],
                        ),
                    ],
                )],
                tabbable: [&["au", "vi", "vi3"], &["au", "vi", "vi3"]],
                focusable: [&["au", "vi", "vi3", "vi4"], &["au", "vi", "vi3", "vi4"]],
                is_tabbable: &["au", "vi", "vi3"],
                is_focusable: &["au", "vi", "vi3", "vi4"],
            },
            Case {
                name: "links",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c"), ("style", "width:60px")],
                    vec![
                        e("a", &[("id", "a1"), ("href", "")], vec![t("empty href")]),
                        e("a", &[("id", "a2"), ("href", "#")], vec![]),
                        e(
                            "a",
                            &[("id", "a3"), ("href", "#"), ("tabindex", "-1")],
                            vec![t("neg")],
                        ),
                        e(
                            "a",
                            &[("id", "a4"), ("href", "#")],
                            vec![t("a long link that wraps over several lines")],
                        ),
                        e(
                            "map",
                            &[("id", "_10"), ("name", "m")],
                            vec![e("area", &[("id", "ar"), ("href", "#")], vec![])],
                        ),
                        e(
                            "a",
                            &[
                                ("id", "a5"),
                                ("href", "#"),
                                ("style", "display:block;width:0;height:0;overflow:hidden"),
                            ],
                            vec![t("x")],
                        ),
                    ],
                )],
                tabbable: [&["a1", "a2", "a4", "a5"], &["a1", "a2", "a4", "a5"]],
                focusable: [
                    &["a1", "a2", "a3", "a4", "a5"],
                    &["a1", "a2", "a3", "a4", "a5"],
                ],
                is_tabbable: &["a1", "a2", "a4", "a5"],
                is_focusable: &["a1", "a2", "a3", "a4", "a5"],
            },
            Case {
                name: "slot",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e(
                            "button",
                            &[("id", "before"), ("tabindex", "3")],
                            vec![t("u")],
                        ),
                        e(
                            "slot",
                            &[("id", "sl")],
                            vec![
                                e("button", &[("id", "sb")], vec![t("x")]),
                                e("button", &[("id", "sb2"), ("tabindex", "1")], vec![t("y")]),
                            ],
                        ),
                        e("button", &[("id", "after")], vec![t("z")]),
                        e(
                            "slot",
                            &[("id", "sl2"), ("tabindex", "2")],
                            vec![
                                e("button", &[("id", "sb3")], vec![t("w")]),
                                e("button", &[("id", "sb5"), ("tabindex", "5")], vec![t("w")]),
                            ],
                        ),
                        e(
                            "slot",
                            &[("id", "sl3"), ("tabindex", "-1")],
                            vec![e("button", &[("id", "sb4")], vec![t("v")])],
                        ),
                    ],
                )],
                tabbable: [
                    &["sb4", "sb5", "sb3", "before", "sb2", "sb", "after"],
                    &["sb4", "sb5", "sb3", "before", "sb2", "sb", "after"],
                ],
                focusable: [
                    &["before", "sb", "sb2", "after", "sb3", "sb5", "sb4"],
                    &["before", "sb", "sb2", "after", "sb3", "sb5", "sb4"],
                ],
                is_tabbable: &["before", "sb", "sb2", "after", "sb3", "sb5", "sb4"],
                is_focusable: &["before", "sb", "sb2", "after", "sb3", "sb5", "sb4"],
            },
            Case {
                name: "misc_tabindex",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("label", &[("id", "l"), ("tabindex", "0")], vec![t("l")]),
                        e(
                            "img",
                            &[
                                ("id", "img"),
                                ("tabindex", "0"),
                                ("style", "width:10px;height:10px"),
                            ],
                            vec![],
                        ),
                        e(
                            "table",
                            &[("id", "_11")],
                            vec![e(
                                "tbody",
                                &[("id", "_12")],
                                vec![e(
                                    "tr",
                                    &[("id", "_13")],
                                    vec![e("td", &[("id", "td"), ("tabindex", "0")], vec![t("x")])],
                                )],
                            )],
                        ),
                        e(
                            "ul",
                            &[("id", "_14")],
                            vec![e("li", &[("id", "li"), ("tabindex", "0")], vec![t("x")])],
                        ),
                        e("p", &[("id", "p"), ("tabindex", "0")], vec![t("x")]),
                        e(
                            "dialog",
                            &[("id", "dg")],
                            vec![e("button", &[("id", "db")], vec![t("x")])],
                        ),
                        e(
                            "dialog",
                            &[("id", "dg2"), ("open", "")],
                            vec![e("button", &[("id", "db2")], vec![t("x")])],
                        ),
                    ],
                )],
                tabbable: [
                    &["l", "img", "td", "li", "p", "db2"],
                    &["l", "img", "td", "li", "p", "db2"],
                ],
                focusable: [
                    &["l", "img", "td", "li", "p", "db2"],
                    &["l", "img", "td", "li", "p", "db2"],
                ],
                is_tabbable: &["l", "img", "td", "li", "p", "db2"],
                is_focusable: &["l", "img", "td", "li", "p", "db2"],
            },
            Case {
                name: "input_types",
                detached: false,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("button", &[("id", "b1"), ("type", "submit")], vec![t("x")]),
                        e("button", &[("id", "b2"), ("type", "reset")], vec![t("y")]),
                        e(
                            "input",
                            &[("id", "i1"), ("type", "button"), ("value", "z")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "i2"), ("type", "checkbox"), ("checked", "")],
                            vec![],
                        ),
                        e(
                            "input",
                            &[("id", "i3"), ("type", "checkbox"), ("disabled", "")],
                            vec![],
                        ),
                        e("input", &[("id", "i4"), ("type", "password")], vec![]),
                        e(
                            "input",
                            &[("id", "i5"), ("type", "number"), ("tabindex", "7")],
                            vec![],
                        ),
                    ],
                )],
                tabbable: [
                    &["i5", "b1", "b2", "i1", "i2", "i4"],
                    &["i5", "b1", "b2", "i1", "i2", "i4"],
                ],
                focusable: [
                    &["b1", "b2", "i1", "i2", "i4", "i5"],
                    &["b1", "b2", "i1", "i2", "i4", "i5"],
                ],
                is_tabbable: &["b1", "b2", "i1", "i2", "i4", "i5"],
                is_focusable: &["b1", "b2", "i1", "i2", "i4", "i5"],
            },
            Case {
                name: "detached",
                detached: true,
                container: "c",
                tree: vec![e(
                    "div",
                    &[("id", "c")],
                    vec![
                        e("button", &[("id", "b")], vec![t("x")]),
                        e("a", &[("id", "a"), ("href", "#")], vec![t("y")]),
                        e(
                            "input",
                            &[("id", "r"), ("type", "radio"), ("name", "g")],
                            vec![],
                        ),
                    ],
                )],
                tabbable: [&[], &[]],
                focusable: [&[], &[]],
                is_tabbable: &[],
                is_focusable: &[],
            },
            Case {
                name: "body",
                detached: false,
                container: "body",
                tree: vec![
                    e("button", &[("id", "b1")], vec![t("x")]),
                    e(
                        "div",
                        &[("id", "d")],
                        vec![e(
                            "a",
                            &[("id", "a"), ("href", "#"), ("tabindex", "2")],
                            vec![t("y")],
                        )],
                    ),
                    e("input", &[("id", "i")], vec![]),
                ],
                tabbable: [&["a", "b1", "i"], &["a", "b1", "i"]],
                focusable: [&["b1", "a", "i"], &["b1", "a", "i"]],
                is_tabbable: &["b1", "a", "i"],
                is_focusable: &["b1", "a", "i"],
            },
        ]
    }
}
