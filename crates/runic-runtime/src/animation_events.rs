//! CSS animation and transition events (CSS slice 3b): `animationstart`,
//! `animationiteration`, `animationend`, `animationcancel`, `transitionrun`,
//! `transitionstart`, `transitionend` and `transitioncancel`.
//!
//! The Blitz fork records the document's animations and samples them at
//! each frame with Chromium 153's rules (`BaseDocument::take_animation_events`):
//! phase changes since the last frame, cancellations queued at the style
//! update that made them, `elapsedTime`, and Chromium's order. A frame's
//! animation step (`Native::animation_step`) samples them right after its
//! style resolution and dispatches them after the `finished` promises the
//! frame settles, as Chromium does (measured: the promises' reactions run
//! first, then each event, each listener a callback with its microtask
//! checkpoint; tasks the listeners queue run after the frame). Each event
//! bubbles from its element (a pseudo-element's originating element) to the
//! document and the window, and is cancelable, as Chromium creates them.
//!
//! The runtime records animations from the document's start when the
//! program could listen to these events (`App::ANIMATION_EVENTS`): Chromium
//! tracks every animation's phase whether or not a listener exists, so a
//! listener added later sees only the changes after it.

use crate::App;
use crate::dom::Event;
use crate::events::Native;
use blitz_dom::{AnimationEvent, AnimationEventKind};
use runic_js::EventData;

fn kind(kind: AnimationEventKind) -> Event {
    match kind {
        AnimationEventKind::AnimationStart => Event::Animationstart,
        AnimationEventKind::AnimationIteration => Event::Animationiteration,
        AnimationEventKind::AnimationEnd => Event::Animationend,
        AnimationEventKind::AnimationCancel => Event::Animationcancel,
        AnimationEventKind::TransitionRun => Event::Transitionrun,
        AnimationEventKind::TransitionStart => Event::Transitionstart,
        AnimationEventKind::TransitionEnd => Event::Transitionend,
        AnimationEventKind::TransitionCancel => Event::Transitioncancel,
    }
}

fn is_transition(kind: AnimationEventKind) -> bool {
    matches!(
        kind,
        AnimationEventKind::TransitionRun
            | AnimationEventKind::TransitionStart
            | AnimationEventKind::TransitionEnd
            | AnimationEventKind::TransitionCancel
    )
}

impl<A: App> Native<A> {
    /// Whether frames have animation work: animation objects the app
    /// tracks, or animations whose events the document records.
    pub(crate) fn animations_active(&self) -> bool {
        crate::animations::active() || self.doc.has_animation_events_pending()
    }

    /// Dispatch the events a frame sampled, in order. Default-priority
    /// tasks their listeners queue (React's renders of their updates) run
    /// after the frame: at the end of the rendering step when the frame has
    /// one (`rendering`), otherwise after the last event.
    pub(crate) fn dispatch_animation_events(
        &mut self,
        events: Vec<AnimationEvent>,
        rendering: bool,
    ) {
        if events.is_empty() {
            return;
        }
        if !rendering {
            self.app.defer_tasks(true);
        }
        for event in events {
            if self.doc.get_node(event.node).is_none() {
                continue;
            }
            let kind = kind(event.kind);
            let chain = crate::events::element_chain(&self.doc, event.node);
            if event.unordered && self.listened(&chain, kind) {
                crate::unsupported(&format!(
                    "{} events of transitions an element started in the same style change: Chromium 153 orders them by an internal hash table",
                    kind.name()
                ));
            }
            let mut data = EventData {
                elapsed_time: event.elapsed_time,
                pseudo_element: event.pseudo_element.into(),
                ..Default::default()
            };
            if is_transition(event.kind) {
                data.property_name = event.name.as_str().into();
            } else {
                data.animation_name = event.name.as_str().into();
            }
            self.fire_event(&chain, kind, data);
        }
        if !rendering {
            self.app.defer_tasks(false);
            self.listeners.settle(&mut self.doc);
            let mut dom = crate::dom::Dom {
                doc: &mut self.doc,
                listeners: &mut self.listeners,
            };
            self.app.run_deferred(&mut dom, None);
        }
        self.fix_focus_after_update();
        self.host_tasks();
    }

    /// Animation event listeners on the path of an element with a
    /// scroll-driven animation (crate::scroll_driven) are reported: Chromium
    /// fires `animationstart`, `animationiteration`, `animationend` and
    /// `animationcancel` for scroll-driven animations by rules of their own
    /// (elapsed times in converted units, a start and an end again when
    /// scrolled back before the range), which the forks do not model.
    pub(crate) fn report_scroll_driven_listeners(&self) {
        for (node, animation) in crate::scroll_driven::elements(&self.doc) {
            if self.doc.get_node(node).is_none() {
                continue;
            }
            let chain = crate::events::element_chain(&self.doc, node);
            for kind in [
                Event::Animationstart,
                Event::Animationiteration,
                Event::Animationend,
                Event::Animationcancel,
            ] {
                if self.listened(&chain, kind) {
                    crate::scroll_driven::report_once(format!(
                        "{} listeners on the path of {animation}: Chromium fires them for scroll-driven animations by rules the runtime does not model",
                        kind.name()
                    ));
                }
            }
        }
    }

    /// Whether a listener of `kind` is registered on the event's path
    /// (elements, the document and the window).
    fn listened(&self, chain: &[blitz_traits::node_id::NodeId], kind: Event) -> bool {
        chain.iter().any(|&n| {
            self.listeners.all(n, kind).next().is_some()
                || self.listeners.all_capture(n, kind).next().is_some()
        }) || [false, true].into_iter().any(|window| {
            !self.app.host_listeners(window, kind).is_empty()
                || !self.app.capture_listeners(window, kind).is_empty()
        })
    }
}
