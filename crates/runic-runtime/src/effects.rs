//! Filters and blending that Blitz would draw differently from Chromium.
//!
//! Both renderers (CPU and GPU) draw `filter` and `backdrop-filter` with the
//! same semantics (docs/research/M6-CPU-RENDERER.md), and the Blitz fork
//! filters an element's whole rendering (outline, outer shadows and overflow
//! included) and clips a backdrop to the rounded border box. Two cases remain
//! different: an element with both `filter` and `backdrop-filter` (one layer,
//! its backdrop clipped with the filter's reach), and a backdrop below a
//! Backdrop Root ancestor. These checks find them, and the blending cases
//! described at [`report_blend_deviations`].

use blitz_dom::BaseDocument;
use blitz_dom::node::Node;
use style::Zero as _;
use style::properties::ComputedValues;

/// Filters Blitz would draw differently from Chromium stop a probe
/// (`E_FILTER`); an app reports each once on stderr.
pub(crate) fn report_filter_deviations(doc: &BaseDocument) {
    let deviations = filter_deviations(doc);
    #[cfg(feature = "probe")]
    if let Some(element) = deviations.first() {
        panic!("E_FILTER: {element}");
    }
    #[cfg(not(feature = "probe"))]
    for element in deviations {
        crate::layout::report_once(format!("runic: E_FILTER: {element}"));
    }
}

/// Why each filtered element would be drawn differently, naming the element.
fn filter_deviations(doc: &BaseDocument) -> Vec<String> {
    let mut out = vec![];
    for (_, node) in doc.tree().iter() {
        let Some(element) = node.element_data() else {
            continue;
        };
        let Some(style) = node.primary_styles() else {
            continue;
        };
        let effects = style.get_effects();
        // An identity filter (`blur(0)`, `brightness(1)`, …: tw-animate-css's
        // keyframes when nothing sets their blur) draws nothing, so where Blitz
        // paints the rest of the element does not show.
        let filter = !effects.filter.0.iter().all(is_identity);
        let backdrop = !effects.backdrop_filter.0.iter().all(is_identity);
        if !filter && !backdrop {
            continue;
        }
        let property = if filter { "filter" } else { "backdrop-filter" };
        let mut reasons = vec![];
        if backdrop {
            if filter {
                let mut reason = "it has both filter and backdrop-filter (Blitz clips the backdrop with the filter's reach".to_owned();
                if !rounded_corners_zero(&style) {
                    reason.push_str(", to the border box's bounding rectangle");
                }
                reason.push(')');
                reasons.push(reason);
            }
            if let Some(root) = backdrop_root(doc, node) {
                reasons.push(format!(
                    "its ancestor <{root}> is a backdrop root (opacity, filter, clip-path, mask or mix-blend-mode): Chromium filters only what that ancestor paints behind it, the renderers everything behind it"
                ));
            }
        }
        if reasons.is_empty() {
            continue;
        }
        out.push(format!(
            "<{}{}> with {property}: {}",
            element.name.local,
            id_suffix(element),
            reasons.join("; ")
        ));
    }
    out
}

fn rounded_corners_zero(style: &ComputedValues) -> bool {
    let border = style.get_border();
    border.border_top_left_radius.is_zero()
        && border.border_top_right_radius.is_zero()
        && border.border_bottom_right_radius.is_zero()
        && border.border_bottom_left_radius.is_zero()
}

/// The nearest ancestor that is a Backdrop Root other than the root element
/// (Filter Effects 2), by tag name.
fn backdrop_root(doc: &BaseDocument, node: &Node) -> Option<String> {
    let root = doc.try_root_element().map(|r| r.id);
    let mut parent = node.parent.and_then(|p| doc.get_node(p));
    while let Some(ancestor) = parent {
        if Some(ancestor.id) == root {
            return None;
        }
        if let (Some(element), Some(style)) = (ancestor.element_data(), ancestor.primary_styles()) {
            let effects = style.get_effects();
            let is_root = effects.opacity < 1.0
                || !effects.filter.0.is_empty()
                || !effects.backdrop_filter.0.is_empty()
                || effects.mix_blend_mode != style::computed_values::mix_blend_mode::T::Normal
                || !matches!(
                    style.clone_clip_path(),
                    style::values::generics::basic_shape::ClipPath::None
                )
                || style.get_svg().mask_image.0.iter().any(|image| {
                    !matches!(image, style::values::generics::image::GenericImage::None)
                });
            if is_root {
                return Some(element.name.local.to_string());
            }
        }
        parent = ancestor.parent.and_then(|p| doc.get_node(p));
    }
    None
}

/// Whether a filter function leaves its input unchanged.
fn is_identity(f: &style::values::computed::effects::Filter) -> bool {
    use style::values::generics::effects::GenericFilter as F;
    match f {
        F::Blur(l) => l.0.px() == 0.0,
        F::Brightness(n) | F::Contrast(n) | F::Saturate(n) => n.0 == 1.0,
        F::Opacity(n) => n.0 == 1.0,
        F::Grayscale(n) | F::Invert(n) | F::Sepia(n) => n.0 == 0.0,
        F::HueRotate(a) => a.radians() == 0.0,
        F::DropShadow(_) | F::Url(_) => false,
    }
}

/// Blending Blitz would draw differently from Chromium stops a probe
/// (`E_BLEND`); an app reports each once on stderr.
///
/// The Blitz fork draws `mix-blend-mode` (every value Stylo parses) and
/// `background-blend-mode` as Chromium does, on both renderers: the element
/// blends with what its isolated group (its nearest stacking context) has
/// painted behind it. Some blended elements are drawn differently and are
/// found here: SVG content, a non-atomic inline box, an element that also
/// has `backdrop-filter`, and one whose nearest stacking context in Chromium
/// is not one in Blitz.
pub(crate) fn report_blend_deviations(doc: &BaseDocument) {
    let deviations = blend_deviations(doc);
    #[cfg(feature = "probe")]
    if let Some(element) = deviations.first() {
        panic!("E_BLEND: {element}");
    }
    #[cfg(not(feature = "probe"))]
    for element in deviations {
        crate::layout::report_once(format!("runic: E_BLEND: {element}"));
    }
}

const SVG_NS: &str = "http://www.w3.org/2000/svg";

/// Why each blended element would be drawn differently, naming the element.
fn blend_deviations(doc: &BaseDocument) -> Vec<String> {
    use style::computed_values::mix_blend_mode::T as MixBlendMode;
    let root = doc.try_root_element().map(|r| r.id);
    let mut out = vec![];
    for (_, node) in doc.tree().iter() {
        let Some(element) = node.element_data() else {
            continue;
        };
        let Some(style) = node.primary_styles() else {
            continue;
        };
        // Chromium ignores mix-blend-mode on the root element.
        if style.get_effects().mix_blend_mode == MixBlendMode::Normal || Some(node.id) == root {
            continue;
        }
        // SVG content and a non-atomic inline box have no box of their own:
        // they are drawn with their outermost `<svg>` and their inline root.
        let outermost_svg = svg_content_root(doc, node);
        let inline = outermost_svg.is_none() && crate::layout::non_atomic_inline(doc, node.id);
        let drawn_with = match outermost_svg {
            Some(svg) => Some(svg),
            None if inline => inline_root(doc, node),
            None => Some(node.id),
        };
        if !drawn_with.is_some_and(|n| crate::layout::rendered(doc, n))
            || style.clone_display().is_none()
        {
            continue;
        }
        let mut reasons = vec![];
        if outermost_svg.is_some() {
            reasons.push(
                "it is SVG content (Blitz hands the <svg> to usvg without mix-blend-mode)"
                    .to_owned(),
            );
        } else if inline {
            reasons.push(
                "it is a non-atomic inline box (Blitz draws its text and backgrounds with its line's text, without the blend)"
                    .to_owned(),
            );
        } else {
            if !style.get_effects().backdrop_filter.0.is_empty() {
                reasons.push(
                    "it also has backdrop-filter (the renderers do not blend a filtered backdrop)"
                        .to_owned(),
                );
            }
            if let Some((ancestor, property)) = unisolated_stacking_context(doc, node) {
                reasons.push(format!(
                    "its ancestor <{ancestor}> is a stacking context in Chromium ({property}), which isolates the blend, but not in Blitz"
                ));
            }
        }
        if reasons.is_empty() {
            continue;
        }
        out.push(format!(
            "<{}{}> with mix-blend-mode: {}",
            element.name.local,
            id_suffix(element),
            reasons.join("; ")
        ));
    }
    out
}

/// The inline root whose text a non-atomic inline box flows in: its nearest
/// ancestor that is not one.
fn inline_root(doc: &BaseDocument, node: &Node) -> Option<blitz_dom::NodeId> {
    let mut parent = node.parent;
    while let Some(id) = parent {
        if !crate::layout::non_atomic_inline(doc, id) {
            return Some(id);
        }
        parent = doc.get_node(id)?.parent;
    }
    None
}

/// The outermost `<svg>` of SVG content (an SVG element inside another).
fn svg_content_root(doc: &BaseDocument, node: &Node) -> Option<blitz_dom::NodeId> {
    let is_svg = |n: &Node| n.element_data().is_some_and(|e| &*e.name.ns == SVG_NS);
    if !is_svg(node) {
        return None;
    }
    let mut outermost = None;
    let mut parent = node.parent.and_then(|p| doc.get_node(p));
    while let Some(ancestor) = parent.filter(|a| is_svg(a)) {
        outermost = Some(ancestor.id);
        parent = ancestor.parent.and_then(|p| doc.get_node(p));
    }
    outermost
}

fn id_suffix(element: &blitz_dom::node::ElementData) -> String {
    element
        .attrs()
        .iter()
        .find(|a| &*a.name.local == "id")
        .map(|a| format!("#{}", a.value))
        .unwrap_or_default()
}

/// The nearest ancestor that Chromium makes a stacking context (so the
/// isolated group a blended descendant blends within) for a property Blitz's
/// stacking contexts lack, by tag name and property. None when Blitz finds
/// the same group: the nearest stacking context is one in Blitz too.
fn unisolated_stacking_context(doc: &BaseDocument, node: &Node) -> Option<(String, String)> {
    const WILL_CHANGE: [&str; 14] = [
        "opacity",
        "transform",
        "translate",
        "scale",
        "rotate",
        "perspective",
        "filter",
        "backdrop-filter",
        "clip-path",
        "mask",
        "isolation",
        "mix-blend-mode",
        "contain",
        "offset-path",
    ];
    let root = doc.try_root_element().map(|r| r.id);
    let mut current = node.layout_parent.get().or(node.parent);
    while let Some(id) = current {
        if Some(id) == root {
            return None;
        }
        let ancestor = doc.get_node(id)?;
        if ancestor.is_stacking_context_root(is_flex_or_grid_item(doc, ancestor)) {
            return None;
        }
        if let Some(element) = ancestor.element_data() {
            let css = |property: &str| doc.resolved_style_value(id, property);
            let will_change = css("will-change");
            let contain = css("contain");
            let container = css("container-type");
            let property = if let Some(w) = will_change
                .split(", ")
                .find(|w| WILL_CHANGE.contains(&w.to_ascii_lowercase().as_str()))
            {
                Some(format!("will-change: {w}"))
            } else if ["paint", "layout", "strict", "content"]
                .iter()
                .any(|v| contain.split(' ').any(|c| c == *v))
            {
                Some(format!("contain: {contain}"))
            } else if container == "size" || container == "inline-size" {
                Some(format!("container-type: {container}"))
            } else {
                ["backdrop-filter", "perspective", "offset-path"]
                    .iter()
                    .find_map(|p| {
                        let v = css(p);
                        (!v.is_empty() && v != "none").then(|| format!("{p}: {v}"))
                    })
                    .or_else(|| {
                        (css("transform-style") == "preserve-3d")
                            .then(|| "transform-style: preserve-3d".to_owned())
                    })
            };
            if let Some(property) = property {
                return Some((element.name.local.to_string(), property));
            }
        }
        current = ancestor.layout_parent.get().or(ancestor.parent);
    }
    None
}

/// Whether the node is a flex or grid item (z-index makes it a stacking
/// context without a position).
fn is_flex_or_grid_item(doc: &BaseDocument, node: &Node) -> bool {
    use style::values::specified::box_::DisplayInside;
    node.layout_parent
        .get()
        .and_then(|parent| doc.get_node(parent))
        .and_then(|parent| parent.primary_styles())
        .is_some_and(|style| {
            matches!(
                style.clone_display().inside(),
                DisplayInside::Flex | DisplayInside::Grid
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::{Dom, Listeners};
    use blitz_dom::DocumentConfig;
    use blitz_traits::shell::{ColorScheme, Viewport};

    /// An element: tag, id, inline style, children.
    struct N(&'static str, &'static str, &'static str, Vec<N>);

    /// The blend deviations of `<html><body>tree</body></html>`.
    fn deviations(tree: Vec<N>) -> Vec<String> {
        let mut doc = BaseDocument::new(DocumentConfig {
            viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
            ..Default::default()
        });
        let mut listeners = Listeners::default();
        let mut dom = Dom {
            doc: &mut doc,
            listeners: &mut listeners,
        };
        let root = dom.doc.root_node().id;
        let html = dom.element("html");
        let body = dom.element("body");
        dom.append(html, body);
        dom.append(root, html);
        fn build(dom: &mut Dom, parent: blitz_dom::NodeId, nodes: Vec<N>) {
            for N(tag, id, style, kids) in nodes {
                let el = dom.element(tag);
                dom.set_attr(el, "id", id);
                dom.set_attr(el, "style", style);
                dom.append(parent, el);
                build(dom, el, kids);
            }
        }
        build(&mut dom, body, tree);
        crate::layout::resolve(dom.doc);
        blend_deviations(dom.doc)
    }

    const BOX: &str = "width: 40px; height: 40px; background: red";
    const BLEND: &str = "width: 40px; height: 40px; background: red; mix-blend-mode: multiply";

    fn inside(style: &'static str) -> Vec<N> {
        vec![N("div", "a", style, vec![N("div", "b", BLEND, vec![])])]
    }

    #[test]
    fn blends_blitz_draws_are_not_reported() {
        assert!(deviations(vec![N("div", "b", BLEND, vec![])]).is_empty());
        for style in [
            "isolation: isolate",
            "opacity: 0.5",
            "transform: translateX(1px)",
            "position: relative; z-index: 0",
            "filter: blur(1px)",
            "overflow: hidden",
        ] {
            assert!(deviations(inside(style)).is_empty(), "{style}");
        }
        // The nearest stacking context decides.
        let tree = vec![N(
            "div",
            "a",
            "will-change: transform",
            vec![N("div", "i", "isolation: isolate", inside(BOX))],
        )];
        assert!(deviations(tree).is_empty());
        // An element without a box draws nothing.
        let tree = vec![N(
            "div",
            "a",
            "display: none",
            inside("will-change: opacity"),
        )];
        assert!(deviations(tree).is_empty());
        // The outermost <svg> is drawn by Blitz.
        let tree = vec![N("svg", "s", "mix-blend-mode: multiply", vec![])];
        assert!(deviations(tree).is_empty());
    }

    #[test]
    fn stacking_contexts_blitz_lacks_are_reported() {
        for (style, property) in [
            ("will-change: transform", "will-change: transform"),
            ("will-change: top, opacity", "will-change: opacity"),
            ("contain: paint", "contain: paint"),
            ("contain: strict", "contain: strict"),
            ("container-type: inline-size", "container-type: inline-size"),
            ("backdrop-filter: blur(2px)", "backdrop-filter: blur(2px)"),
            ("perspective: 100px", "perspective: 100px"),
            (
                "transform-style: preserve-3d",
                "transform-style: preserve-3d",
            ),
        ] {
            assert_eq!(
                deviations(inside(style)),
                [format!(
                    "<div#b> with mix-blend-mode: its ancestor <div> is a stacking context in Chromium ({property}), which isolates the blend, but not in Blitz"
                )],
                "{style}"
            );
        }
        assert!(deviations(inside("will-change: top")).is_empty());
        assert!(deviations(inside("contain: size")).is_empty());
    }

    #[test]
    fn backdrop_filter_svg_content_and_inline_boxes_are_reported() {
        let tree = vec![N(
            "div",
            "b",
            "mix-blend-mode: screen; backdrop-filter: blur(2px)",
            vec![],
        )];
        assert_eq!(
            deviations(tree),
            [
                "<div#b> with mix-blend-mode: it also has backdrop-filter (the renderers do not blend a filtered backdrop)"
            ]
        );
        let tree = vec![N(
            "svg",
            "s",
            "width: 40px; height: 40px",
            vec![N("rect", "r", "mix-blend-mode: multiply", vec![])],
        )];
        assert_eq!(
            deviations(tree),
            [
                "<rect#r> with mix-blend-mode: it is SVG content (Blitz hands the <svg> to usvg without mix-blend-mode)"
            ]
        );
        let tree = vec![N(
            "div",
            "a",
            "",
            vec![N(
                "span",
                "s",
                "mix-blend-mode: difference",
                vec![N("b", "i", "", vec![])],
            )],
        )];
        assert_eq!(
            deviations(tree),
            [
                "<span#s> with mix-blend-mode: it is a non-atomic inline box (Blitz draws its text and backgrounds with its line's text, without the blend)"
            ]
        );
        // An inline-block has a box of its own.
        let tree = vec![N(
            "div",
            "a",
            "",
            vec![N(
                "span",
                "s",
                "display: inline-block; mix-blend-mode: difference",
                vec![],
            )],
        )];
        assert!(deviations(tree).is_empty());
        let tree = vec![N(
            "div",
            "a",
            "display: none",
            vec![N("span", "s", "mix-blend-mode: difference", vec![])],
        )];
        assert!(deviations(tree).is_empty());
    }
}
