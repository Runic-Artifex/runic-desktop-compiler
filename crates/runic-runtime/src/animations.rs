//! CSS animations and transitions as Web Animations objects (M6,
//! `element.getAnimations()`, docs/design/M6-OVERLAYS.md "Presence").
//!
//! Stylo runs the animations; the Blitz fork lists an element's running
//! ones (`BaseDocument::animations_of`). After every style resolution the
//! runtime makes (`timeline::resolve`), the document's animations are
//! matched to the ones it tracks: a CSS animation by its element and
//! keyframes name while Stylo keeps it, a transition by its element,
//! property and start time. One that Stylo no longer has has ended:
//!
//! - **finished**: a CSS animation whose element still names it (Stylo
//!   drops an animation once it finished, at the element's next restyle,
//!   which is the same resolution: Blitz restyles every animating element),
//!   or a transition that reached its end and was not replaced;
//! - **cancelled**: otherwise (the style no longer names it, the element
//!   left the document or is not rendered, a transition was replaced).
//!
//! As in Chromium, a cancellation takes effect at the style resolution that
//! makes it (the app rejects `finished` right after the script's layout read
//! or at the next frame), while a finish takes effect at the next frame
//! (the animation step: `finished` resolves before the frame's rendering),
//! and an animation is `pending` until a frame has seen it. Ids are the
//! identities of the app's animation objects.

use blitz_dom::{AnimationPhase, BaseDocument};
use blitz_traits::node_id::NodeId;
use std::cell::RefCell;

#[derive(Clone, Debug, PartialEq)]
enum Kind {
    /// A CSS animation: its `@keyframes` name.
    Animation(String),
    /// A CSS transition: the property and its start time (bits).
    Transition(String, u64),
}

#[derive(Debug)]
struct Live {
    id: u64,
    node: u64,
    kind: Kind,
    phase: AnimationPhase,
    start: f64,
    duration: f64,
    /// The resolution that first saw it (a transition's generation).
    generation: u64,
    /// Seen by an animation step (a frame): no longer `pending`.
    committed: bool,
    /// The app holds an object for it.
    handled: bool,
}

/// How an animation ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ended {
    Finished,
    Canceled,
}

#[derive(Default)]
struct Registry {
    /// The program calls `getAnimations()` (otherwise nothing is tracked).
    enabled: bool,
    next: u64,
    resolutions: u64,
    live: Vec<Live>,
    /// Animations the app holds that ended and that it has not been given
    /// yet, in order. A finished one counts as running until a frame
    /// takes it.
    ended: Vec<(Live, Ended)>,
}

thread_local! {
    static REGISTRY: RefCell<Registry> = RefCell::new(Registry::default());
}

/// A new document: track its animations if the program reads them.
pub(crate) fn reset(enabled: bool) {
    REGISTRY.with(|r| {
        *r.borrow_mut() = Registry {
            enabled,
            next: 1,
            ..Registry::default()
        }
    });
}

/// Whether the document has animations to track at frames.
pub(crate) fn active() -> bool {
    REGISTRY.with(|r| {
        let r = r.borrow();
        r.enabled && (!r.live.is_empty() || !r.ended.is_empty())
    })
}

/// Whether `node` is rendered: in the document, and neither it nor an
/// ancestor is `display: none` (Chromium runs no animations there; Stylo
/// does not restyle such elements, so it keeps their animations).
fn rendered(doc: &BaseDocument, node: NodeId) -> bool {
    let mut current = doc.get_node(node);
    if !current.is_some_and(|n| n.flags.is_in_document()) {
        return false;
    }
    while let Some(n) = current {
        if n.primary_styles()
            .is_some_and(|s| s.clone_display().is_none())
        {
            return false;
        }
        current = n.parent.and_then(|p| doc.get_node(p));
    }
    true
}

/// Whether the computed style of `node` names CSS animation `name` with a
/// positive duration (Stylo keeps such an animation until it finishes).
fn names(doc: &BaseDocument, node: NodeId, name: &str) -> bool {
    doc.get_node(node)
        .and_then(|n| n.primary_styles())
        .is_some_and(|s| {
            let ui = s.get_ui();
            ui.animation_name_iter().enumerate().any(|(i, n)| {
                n.as_atom().is_some_and(|a| &**a == name)
                    && ui.animation_duration_mod(i).seconds() > 0.0
            })
        })
}

/// Match the document's animations after a style resolution at timeline
/// time `now` (seconds).
pub(crate) fn observe(doc: &BaseDocument, now: f64) {
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        if !r.enabled {
            return;
        }
        r.resolutions += 1;
        let mut current: Vec<(u64, Kind, AnimationPhase, f64, f64)> = Vec::new();
        for (id, n) in doc.tree().iter() {
            if n.element_data().is_none() {
                continue;
            }
            let snapshots = doc.animations_of(id);
            if snapshots.is_empty() || !rendered(doc, id) {
                continue;
            }
            for s in snapshots {
                if matches!(s.phase, AnimationPhase::Finished | AnimationPhase::Canceled) {
                    continue;
                }
                let kind = match (s.animation_name, s.transition_property) {
                    (Some(name), _) => Kind::Animation(name),
                    (None, Some(p)) => Kind::Transition(p, s.start_time.to_bits()),
                    (None, None) => continue,
                };
                current.push((id.as_u64(), kind, s.phase, s.start_time, s.duration));
            }
        }
        let mut taken = vec![false; current.len()];
        let live = std::mem::take(&mut r.live);
        for mut l in live {
            let found = current
                .iter()
                .enumerate()
                .position(|(i, c)| !taken[i] && c.0 == l.node && c.1 == l.kind);
            if let Some(i) = found {
                taken[i] = true;
                (l.phase, l.start, l.duration) = (current[i].2, current[i].3, current[i].4);
                r.live.push(l);
                continue;
            }
            let node = NodeId::from_u64(l.node);
            let how = if !rendered(doc, node) {
                Ended::Canceled
            } else {
                match &l.kind {
                    Kind::Animation(name) if names(doc, node, name) => Ended::Finished,
                    Kind::Animation(_) => Ended::Canceled,
                    Kind::Transition(property, _) => {
                        let replaced = current.iter().any(|c| {
                            c.0 == l.node && matches!(&c.1, Kind::Transition(p, _) if p == property)
                        });
                        if !replaced && now >= l.start + l.duration {
                            Ended::Finished
                        } else {
                            Ended::Canceled
                        }
                    }
                }
            };
            if l.handled {
                r.ended.push((l, how));
            }
        }
        let generation = r.resolutions;
        for (i, (node, kind, phase, start, duration)) in current.into_iter().enumerate() {
            if taken[i] {
                continue;
            }
            let id = r.next;
            r.next += 1;
            r.live.push(Live {
                id,
                node,
                kind,
                phase,
                start,
                duration,
                generation,
                committed: false,
                handled: false,
            });
        }
    });
}

/// An animation step (a frame) saw the document's animations: none of
/// them is `pending` any more.
pub(crate) fn commit() {
    REGISTRY.with(|r| {
        for l in r.borrow_mut().live.iter_mut() {
            l.committed = true;
        }
    });
}

/// The ids of the CSS animations and transitions of `node` that
/// `getAnimations()` returns, in Chromium's order: transitions by
/// generation, then property name, then CSS animations in the order of
/// `animation-name` (call after a resolution). A finished one the app
/// holds stays running until a frame takes it.
pub(crate) fn of(doc: &BaseDocument, node: NodeId) -> Vec<u64> {
    // Stylo drops a finished animation's fill when its element is next
    // restyled, where Chromium keeps it in effect (and listed). The
    // stylesheet's fills are rejected by the compiler; inline styles are not
    // checked.
    if let Some(s) = doc.get_node(node).and_then(|n| n.primary_styles()) {
        use style::properties::longhands::animation_fill_mode::computed_value::single_value::T as Fill;
        let ui = s.get_ui();
        let filled = ui.animation_name_iter().enumerate().any(|(i, n)| {
            n.as_atom().is_some()
                && matches!(ui.animation_fill_mode_mod(i), Fill::Forwards | Fill::Both)
        });
        if filled {
            crate::unsupported(
                "getAnimations() on an element whose animation-fill-mode is forwards or both (Stylo drops a finished animation's fill; Chromium keeps it listed)",
            );
        }
    }
    let order = |doc: &BaseDocument, l: &Live| -> (u8, u64, String, usize) {
        match &l.kind {
            Kind::Transition(p, _) => (0, l.generation, p.clone(), 0),
            Kind::Animation(name) => {
                let index = doc
                    .get_node(node)
                    .and_then(|n| n.primary_styles())
                    .and_then(|s| {
                        s.get_ui()
                            .animation_name_iter()
                            .position(|n| n.as_atom().is_some_and(|a| &**a == name.as_str()))
                    })
                    .unwrap_or(usize::MAX);
                (1, 0, String::new(), index)
            }
        }
    };
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        let key = node.as_u64();
        let mut found: Vec<((u8, u64, String, usize), u64)> = Vec::new();
        for l in r.live.iter_mut().filter(|l| l.node == key) {
            l.handled = true;
            found.push((order(doc, l), l.id));
        }
        for (l, how) in &r.ended {
            if l.node == key && *how == Ended::Finished {
                found.push((order(doc, l), l.id));
            }
        }
        found.sort_by(|a, b| a.0.cmp(&b.0));
        found.into_iter().map(|(_, id)| id).collect()
    })
}

/// `animation.playState` (after a resolution): `running` (also while
/// delayed, and finished but not yet taken by a frame), `paused`,
/// `finished` or `idle` (cancelled); None once the app took its end.
pub(crate) fn play_state(id: u64) -> Option<&'static str> {
    REGISTRY.with(|r| {
        let r = r.borrow();
        if let Some(l) = r.live.iter().find(|l| l.id == id) {
            return Some(match l.phase {
                AnimationPhase::Paused => "paused",
                _ => "running",
            });
        }
        r.ended.iter().find(|e| e.0.id == id).map(|e| match e.1 {
            Ended::Finished => "running",
            Ended::Canceled => "idle",
        })
    })
}

/// `animation.pending` (after a resolution): no frame has seen it yet.
pub(crate) fn pending(id: u64) -> bool {
    REGISTRY.with(|r| {
        let r = r.borrow();
        r.live.iter().any(|l| l.id == id && !l.committed)
            || r.ended
                .iter()
                .any(|e| e.0.id == id && e.1 == Ended::Finished && !e.0.committed)
    })
}

/// The ends the app takes now, in order: cancellations at once, finishes
/// only at a frame (`frame`).
pub(crate) fn take_ended(frame: bool) -> Vec<(u64, Ended)> {
    REGISTRY.with(|r| {
        let mut r = r.borrow_mut();
        let mut out = Vec::new();
        r.ended.retain(|(l, how)| {
            if frame || *how == Ended::Canceled {
                out.push((l.id, *how));
                false
            } else {
                true
            }
        });
        out
    })
}

/// Whether ends are waiting for the app (`frame`: finishes included).
pub(crate) fn has_ended(frame: bool) -> bool {
    REGISTRY.with(|r| {
        r.borrow()
            .ended
            .iter()
            .any(|e| frame || e.1 == Ended::Canceled)
    })
}
