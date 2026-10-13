//! The document timeline that drives CSS animations and transitions
//! (docs/design/M6-LIBRARIES.md#animations). Blitz runs Stylo's animations
//! at the time each style resolution is given, in seconds; every resolution
//! the runtime starts reads it here, so animations see one timeline:
//!
//! - natively, real time since the shell first touched the document, which
//!   is where blitz-shell starts its own animation clock (`View::init`
//!   borrows the document, then `View::resume` starts the clock and
//!   resolves), so the shell's redraws and the runtime's resolutions agree;
//!   before the window exists the timeline stands at 0;
//! - in probes, the virtual clock: time moves only through `wait` actions,
//!   and the timeline follows the timers' clock.

use blitz_dom::BaseDocument;
use blitz_traits::node_id::NodeId;
use std::cell::Cell;
use std::time::Instant;

thread_local! {
    static ORIGIN: Cell<Option<Instant>> = const { Cell::new(None) };
    /// The virtual clock in milliseconds (probes).
    static VIRTUAL: Cell<Option<f64>> = const { Cell::new(None) };
}

/// Start the real-time timeline (the shell's first access to the document).
pub(crate) fn start() {
    ORIGIN.with(|o| {
        if o.get().is_none() {
            o.set(Some(Instant::now()));
        }
    });
}

/// Probes: the timeline stands at virtual clock time `ms`.
pub(crate) fn set_virtual(ms: f64) {
    VIRTUAL.with(|v| v.set(Some(ms)));
}

/// The timeline's current time in seconds.
pub(crate) fn now() -> f64 {
    if let Some(ms) = VIRTUAL.with(Cell::get) {
        return ms / 1000.0;
    }
    ORIGIN
        .with(Cell::get)
        .map_or(0.0, |o| o.elapsed().as_secs_f64())
}

/// Resolve styles and layout at the timeline's current time, then match
/// the document's animations to the app's animation objects.
pub(crate) fn resolve(doc: &mut BaseDocument) {
    let now = now();
    let scroll_offsets = crate::layout::capture_scroll_offsets(doc);
    doc.resolve(now);
    crate::layout::record_layout_scroll_changes(doc, scroll_offsets);
    crate::animations::observe(doc, now);
    check_style_guards(doc);
    report_unsupported_layout(doc);
}

thread_local! {
    /// Layout inputs already reported as unsupported (once each).
    static LAYOUT_REPORTED: std::cell::RefCell<Vec<&'static str>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// Inputs layout laid out without their unsupported part (for example
/// percentage or negative horizontal edges of an ordinary inline box) are
/// reported once each.
fn report_unsupported_layout(doc: &mut BaseDocument) {
    for what in doc.take_unsupported_layout_reports() {
        let first = LAYOUT_REPORTED.with(|reported| {
            let mut reported = reported.borrow_mut();
            let first = !reported.contains(&what);
            if first {
                reported.push(what);
            }
            first
        });
        if first {
            crate::unsupported(what);
        }
    }
}

type Guard = (&'static str, &'static str, &'static str, &'static str);

thread_local! {
    /// The style guards of the document not yet reported (`App::STYLE_GUARDS`).
    static STYLE_GUARDS: std::cell::RefCell<Vec<Guard>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

pub(crate) fn set_style_guards(guards: &'static [Guard]) {
    STYLE_GUARDS.with(|g| *g.borrow_mut() = guards.to_vec());
}

/// The elements a guard applies to: those matching its selector that its
/// `unless` selector (the rules overriding the declaration) does not match.
fn guarded(doc: &BaseDocument, (selector, unless, _, _): &Guard) -> Vec<NodeId> {
    let matched = doc.query_selector_all(selector).unwrap_or_default();
    if unless.is_empty() || matched.is_empty() {
        return matched.into_vec();
    }
    let overridden = doc.query_selector_all(unless).unwrap_or_default();
    matched
        .into_iter()
        .filter(|n| !overridden.contains(n))
        .collect()
}

/// A declaration the style engine drops applies once its rule's selector
/// matches an element (and the declaration is not overridden there): it is
/// reported as unsupported (once). Guards of scroll targets wait for one
/// (`check_scroll_target`).
fn check_style_guards(doc: &BaseDocument) {
    // Rules of media queries on a desktop preference (`when` `"native"`):
    // probes set the preference as their actions emulate it; a native app
    // cannot read the desktop's.
    let native = !crate::probe_mode();
    report(
        doc,
        |g| g.2.is_empty() || (native && g.2 == "native"),
        |_| true,
    );
}

/// A declaration that only affects an element scrolled into view (its
/// scroll margins), checked when `target` is.
pub(crate) fn check_scroll_target(doc: &BaseDocument, target: NodeId) {
    report(
        doc,
        |g| g.2 == "scroll-target",
        |nodes| nodes.contains(&target),
    );
}

fn report(doc: &BaseDocument, kind: impl Fn(&Guard) -> bool, hit: impl Fn(&[NodeId]) -> bool) {
    let matched: Vec<&'static str> = STYLE_GUARDS.with(|g| {
        let mut g = g.borrow_mut();
        let mut matched = vec![];
        g.retain(|guard| {
            let fired = kind(guard) && {
                let nodes = guarded(doc, guard);
                !nodes.is_empty() && hit(&nodes)
            };
            if fired {
                matched.push(guard.3);
            }
            !fired
        });
        matched
    });
    for message in matched {
        crate::unsupported(message);
    }
}
