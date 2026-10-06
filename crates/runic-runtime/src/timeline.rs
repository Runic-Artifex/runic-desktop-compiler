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
    doc.resolve(now);
    crate::animations::observe(doc, now);
    check_style_guards(doc);
}

thread_local! {
    /// The style guards of the document not yet reported (`App::STYLE_GUARDS`).
    static STYLE_GUARDS: std::cell::RefCell<Vec<(&'static str, &'static str)>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

pub(crate) fn set_style_guards(guards: &'static [(&'static str, &'static str)]) {
    STYLE_GUARDS.with(|g| *g.borrow_mut() = guards.to_vec());
}

/// A declaration the style engine drops applies once its rule's selector
/// matches an element: it is reported as unsupported (once).
fn check_style_guards(doc: &BaseDocument) {
    let matched: Vec<&'static str> = STYLE_GUARDS.with(|g| {
        let mut g = g.borrow_mut();
        let mut matched = vec![];
        g.retain(|(selector, message)| {
            let hit = !matches!(doc.query_selector(selector), Ok(None));
            if hit {
                matched.push(*message);
            }
            !hit
        });
        matched
    });
    for message in matched {
        crate::unsupported(message);
    }
}
