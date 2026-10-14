//! Scroll-driven CSS animations (`animation-timeline: scroll()`, CSS slice
//! 3b part 2, conformance/results/scroll-timelines.md).
//!
//! The Stylo and Blitz forks run them with Chromium 153's semantics: Blitz
//! samples each timeline from its scroller after layout and Stylo computes
//! the animation's value from the sample, so they follow every scroll
//! (wheel, programmatic) and layout change at the next style resolution.
//! What they do not run, the runtime reports after each style resolution it
//! makes (`timeline::resolve`), once each:
//!
//! - what Blitz lists as unsupported (`ScrollDrivenAnimation::unsupported`:
//!   named and view timelines, named ranges, timings that do not convert to
//!   the range, play state and timeline changes, vertical writing modes,
//!   `scroll(nearest)` without a box, other pseudo-elements), which has no
//!   effect;
//! - a paused scroll-driven animation (not measured against Chromium);
//! - animation event listeners on the path of an element with a
//!   scroll-driven animation: Chromium fires `animationstart`,
//!   `animationiteration`, `animationend` and `animationcancel` for them by
//!   rules of its own, the forks fire none (`Native::report_scroll_driven_listeners`);
//! - `element.getAnimations()` on an element with one: Chromium lists it
//!   with a scroll timeline and progress in percentages, which the runtime
//!   does not model (crate::animations leaves such animations untracked).
//!
//! The list is read only from the animations Stylo keeps, so a document
//! without scroll-driven animations pays one pass over its animation sets.

use blitz_dom::{BaseDocument, ScrollDrivenAnimation, UnsupportedScrollDriven};
use blitz_traits::node_id::NodeId;
use std::cell::RefCell;
use std::collections::HashSet;
use style::animation::UnsupportedTimeline;

thread_local! {
    /// The document's scroll-driven animations after the last resolution.
    static CURRENT: RefCell<Vec<ScrollDrivenAnimation>> = const { RefCell::new(Vec::new()) };
    /// Reports already made (once each).
    static REPORTED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
}

/// Report `what` once.
pub(crate) fn report_once(what: String) {
    if REPORTED.with(|r| r.borrow_mut().insert(what.clone())) {
        crate::unsupported(&what);
    }
}

/// `<tag#id>` of `node`.
pub(crate) fn describe(doc: &BaseDocument, node: NodeId) -> String {
    let Some(element) = doc.get_node(node).and_then(|n| n.element_data()) else {
        return format!("node {}", node.as_u64());
    };
    let id = element
        .attrs()
        .iter()
        .find(|a| &*a.name.local == "id")
        .map(|a| format!("#{}", a.value))
        .unwrap_or_default();
    format!("<{}{id}>", element.name.local)
}

fn reason(unsupported: UnsupportedScrollDriven) -> &'static str {
    match unsupported {
        UnsupportedScrollDriven::Timeline(t) => match t {
            UnsupportedTimeline::NamedTimeline => "a named timeline is not supported",
            UnsupportedTimeline::ViewTimeline => "a view() timeline is not supported",
            UnsupportedTimeline::NamedRange => {
                "a named timeline range (cover, contain, entry, exit, …) is not supported"
            }
            UnsupportedTimeline::Timing => {
                "its timing does not convert to its range (an infinite or zero iteration count, a zero duration or a negative delay)"
            }
            UnsupportedTimeline::PlayStateChange => {
                "its play state changed after it started, which is not modelled"
            }
            UnsupportedTimeline::TimelineChange => {
                "its timeline changed from a scroll timeline to the document timeline or none (or a time-based animation's to none), which is not modelled"
            }
        },
        UnsupportedScrollDriven::VerticalWritingMode => {
            "its scroller has a vertical writing mode, which Blitz's scrolling does not represent"
        }
        UnsupportedScrollDriven::NoBox => "scroll(nearest) on an element without a box",
        UnsupportedScrollDriven::PseudoElement => {
            "it animates a pseudo-element other than ::before and ::after"
        }
    }
}

fn name(doc: &BaseDocument, a: &ScrollDrivenAnimation) -> String {
    format!(
        "the scroll-driven animation {} of {}{}",
        a.name,
        describe(doc, a.node),
        a.pseudo_element
    )
}

/// After a style resolution: record the document's scroll-driven
/// animations and report what the forks do not run.
pub(crate) fn observe(doc: &BaseDocument) {
    let list = doc.scroll_driven_animations();
    if list.is_empty() && CURRENT.with(|c| c.borrow().is_empty()) {
        return;
    }
    for problem in problems(doc, &list) {
        report_once(problem);
    }
    CURRENT.with(|c| *c.borrow_mut() = list);
}

/// What the forks do not run among `list`.
fn problems(doc: &BaseDocument, list: &[ScrollDrivenAnimation]) -> Vec<String> {
    let mut out = vec![];
    for a in list {
        if let Some(unsupported) = a.unsupported {
            out.push(format!(
                "{} has no effect: {}",
                name(doc, a),
                reason(unsupported)
            ));
        } else if a.paused {
            out.push(format!(
                "{} is paused (animation-play-state: paused), which is not measured against Chromium",
                name(doc, a)
            ));
        }
    }
    out
}

/// Whether CSS animation `name` of element `node` (not of a pseudo-element)
/// is scroll-driven (after the last resolution).
pub(crate) fn is_scroll_driven(node: NodeId, name: &str) -> bool {
    CURRENT.with(|c| {
        c.borrow()
            .iter()
            .any(|a| a.node == node && a.pseudo_element.is_empty() && a.name == name)
    })
}

/// The names of the scroll-driven animations of element `node` (not of
/// its pseudo-elements).
pub(crate) fn names_of(node: NodeId) -> Vec<String> {
    CURRENT.with(|c| {
        c.borrow()
            .iter()
            .filter(|a| a.node == node && a.pseudo_element.is_empty())
            .map(|a| a.name.clone())
            .collect()
    })
}

/// The elements with scroll-driven animations (originating elements of
/// pseudo-elements included), with the animations' descriptions.
pub(crate) fn elements(doc: &BaseDocument) -> Vec<(NodeId, String)> {
    CURRENT.with(|c| c.borrow().iter().map(|a| (a.node, name(doc, a))).collect())
}

/// `element.getAnimations()` on `node`: a scroll-driven animation is
/// reported (Chromium lists it with a scroll timeline).
pub(crate) fn report_get_animations(doc: &BaseDocument, node: NodeId) {
    for animation in names_of(node) {
        report_once(format!(
            "element.getAnimations() on {}, which has the scroll-driven animation {animation}: Chromium lists it with a scroll timeline (progress in percentages), which the runtime does not model",
            describe(doc, node)
        ));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dom::{Dom, Listeners};
    use blitz_dom::DocumentConfig;
    use blitz_traits::shell::{ColorScheme, Viewport};

    /// The scroll-driven animations of a document with `css` and, in its
    /// body, a 100px scroller `#s` holding 400px of content, with `style`,
    /// after a resolution; and their problems.
    fn resolve(css: &str, style: &str) -> (Vec<ScrollDrivenAnimation>, Vec<String>) {
        let mut doc = BaseDocument::new(DocumentConfig {
            viewport: Some(Viewport::new(800, 600, 1.0, ColorScheme::Light)),
            ..Default::default()
        });
        doc.add_user_agent_stylesheet(css);
        let mut listeners = Listeners::default();
        let mut dom = Dom {
            doc: &mut doc,
            listeners: &mut listeners,
        };
        let root = dom.doc.root_node().id;
        let html = dom.element("html");
        let body = dom.element("body");
        let scroller = dom.element("div");
        let content = dom.element("div");
        dom.set_attr(scroller, "id", "s");
        dom.set_attr(
            scroller,
            "style",
            &format!("height: 100px; overflow: auto; {style}"),
        );
        dom.set_attr(content, "style", "height: 400px");
        dom.append(scroller, content);
        dom.append(body, scroller);
        dom.append(html, body);
        dom.append(root, html);
        crate::layout::resolve(dom.doc);
        let list = dom.doc.scroll_driven_animations();
        let problems = problems(dom.doc, &list);
        (list, problems)
    }

    const KEYFRAMES: &str = "@keyframes fade { from { opacity: 0 } to { opacity: 1 } }";

    #[test]
    fn scroll_timelines_run_and_the_rest_is_reported() {
        let (list, problems) = resolve(
            KEYFRAMES,
            "animation: fade 1ms linear both; animation-timeline: scroll(self y); animation-range: 0 96px",
        );
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "fade");
        assert!(problems.is_empty(), "{problems:?}");
        for (style, reason) in [
            (
                "animation-timeline: view()",
                "a view() timeline is not supported",
            ),
            (
                "animation-timeline: --t",
                "a named timeline is not supported",
            ),
            (
                "animation-timeline: scroll(); animation-range: entry",
                "a named timeline range",
            ),
            (
                "animation-timeline: scroll(); animation-iteration-count: infinite",
                "its timing does not convert to its range",
            ),
        ] {
            let (_, problems) = resolve(KEYFRAMES, &format!("animation: fade 1ms both; {style}"));
            assert_eq!(problems.len(), 1, "{style}: {problems:?}");
            assert!(
                problems[0]
                    .starts_with("the scroll-driven animation fade of <div#s> has no effect: ")
                    && problems[0].contains(reason),
                "{style}: {problems:?}"
            );
        }
        let (_, problems) = resolve(
            KEYFRAMES,
            "animation: fade 1ms both paused; animation-timeline: scroll()",
        );
        assert_eq!(
            problems,
            [
                "the scroll-driven animation fade of <div#s> is paused (animation-play-state: paused), which is not measured against Chromium"
            ]
        );
        // Time-based animations are not listed.
        let (list, _) = resolve(KEYFRAMES, "animation: fade 1s both");
        assert!(list.is_empty());
    }
}
