//! Filters that Blitz would draw differently from Chromium.
//!
//! Both renderers (CPU and GPU) draw `filter` and `backdrop-filter` with the
//! same semantics (docs/research/M6-CPU-RENDERER.md), but Blitz builds the filter layer
//! around part of the element only: its outline and outer box shadows are
//! painted outside the layer (unfiltered), the layer is clipped to the border
//! box (plus the filter's reach), and a backdrop is clipped to the border
//! box's bounding rectangle. These checks find the elements where that shows.

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
        if effects.box_shadow.0.iter().any(|s| !s.inset) {
            reasons.push(format!(
                "its box-shadow is drawn outside the {property} (Blitz paints outer shadows before the filter layer)"
            ));
        }
        let outline = style.get_outline();
        if !outline.outline_style.none_or_hidden() && outline.outline_width.0.to_f64_px() > 0.0 {
            reasons.push(format!(
                "its outline is drawn outside the {property} (Blitz paints outlines before the filter layer)"
            ));
        }
        if overflows_border_box(node) {
            reasons.push(
                "content overflowing its border box is clipped (Blitz clips a filter layer to the border box and the filter's reach)"
                    .to_owned(),
            );
        }
        if backdrop {
            if filter {
                reasons.push(
                    "it has both filter and backdrop-filter (Blitz clips the backdrop with the filter's reach)"
                        .to_owned(),
                );
            }
            if !rounded_corners_zero(&style) {
                reasons.push(
                    "its backdrop is not clipped to the rounded corners (Blitz clips it to the border box's bounding rectangle)"
                        .to_owned(),
                );
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
        let tag = &element.name.local;
        let id = element
            .attrs()
            .iter()
            .find(|a| &*a.name.local == "id")
            .map(|a| format!("#{}", a.value))
            .unwrap_or_default();
        out.push(format!(
            "<{tag}{id}> with {property}: {}",
            reasons.join("; ")
        ));
    }
    out
}

/// Whether the element's scrollable overflow reaches outside its border box.
fn overflows_border_box(node: &Node) -> bool {
    let layout = node.final_layout();
    let overflow = layout.scrollable_overflow_rect;
    const EPSILON: f32 = 0.01;
    overflow.left < -EPSILON
        || overflow.top < -EPSILON
        || overflow.right > layout.size.width + EPSILON
        || overflow.bottom > layout.size.height + EPSILON
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
