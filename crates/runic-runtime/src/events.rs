//! Event delivery with browser DOM semantics on top of Blitz's single event
//! hook: click bubbling with disabled-control suppression, keyboard
//! activation of buttons (Enter on key down, Space on key up) and checkboxes
//! (Space), keydown listeners that bubble from the focused element before any
//! default action, sequential Tab focus navigation, button focus on pointer
//! activation, and controlled text inputs and checkboxes.

use crate::dom::{Dom, Event, Listeners};
use crate::{App, controls};
use blitz_dom::{BaseDocument, DocGuard, DocGuardMut, Document, EventDriver, EventHandler};
use blitz_traits::events::{DomEvent, DomEventData, EventState, UiEvent};
use blitz_traits::node_id::NodeId;
use keyboard_types::{Key, Modifiers};

/// The native document: Blitz DOM plus the application and its listeners.
pub(crate) struct Native<A: App> {
    pub doc: BaseDocument,
    pub app: A,
    pub listeners: Listeners,
    /// Button that received Space key-down (activation happens on key-up).
    pub space_target: Option<NodeId>,
    /// Sequential focus navigation starting point while nothing is focused
    /// (set by clicks and by focus loss), as in Chromium.
    pub nav_start: Option<NodeId>,
    /// Handler outcomes since the last probe observation.
    pub log: Vec<String>,
    /// Real-time clock origin of the window (production timers).
    pub started: std::time::Instant,
    /// Clock time of the scheduled wake-up for the next timer.
    pub wake_at: Option<f64>,
}

impl<A: App> Document for Native<A> {
    fn inner(&self) -> DocGuard<'_> {
        DocGuard::Ref(&self.doc)
    }
    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        DocGuardMut::Ref(&mut self.doc)
    }
    /// Production timers: run what is due by real time, then wake again for
    /// the next timer.
    fn poll(&mut self, task_context: Option<std::task::Context>) -> bool {
        let now = crate::CLOCK_START + self.started.elapsed().as_secs_f64() * 1000.0;
        let ran = self.app.next_timer().is_some_and(|t| t <= now);
        if ran {
            self.advance(now);
            self.wake_at = None;
        }
        if let (Some(due), Some(cx)) = (self.app.next_timer(), task_context) {
            if self.wake_at.is_none_or(|w| due < w) {
                self.wake_at = Some(due);
                let waker = cx.waker().clone();
                let delay = (due - now).max(0.0);
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs_f64(delay / 1000.0));
                    waker.wake();
                });
            }
        }
        ran
    }

    fn handle_ui_event(&mut self, event: UiEvent) {
        self.listeners.settle(&mut self.doc);
        let handler = Handler {
            app: &mut self.app,
            listeners: &mut self.listeners,
            space_target: &mut self.space_target,
            nav_start: &mut self.nav_start,
            log: &mut self.log,
        };
        EventDriver::new(&mut self.doc, handler).handle_ui_event(event);
    }
}

impl<A: App> Native<A> {
    /// Run the timers due at or before clock time `to`, then apply the focus
    /// fixups that follow any update.
    pub(crate) fn advance(&mut self, to: f64) {
        self.listeners.settle(&mut self.doc);
        let mut dom = Dom {
            doc: &mut self.doc,
            listeners: &mut self.listeners,
        };
        self.app.advance(&mut dom, to);
        if let Some(b) = self.listeners.blurred.take() {
            self.nav_start = Some(b);
        }
        if let Some(f) = focused_element(&self.doc) {
            if is_disabled_control(&self.doc, f) {
                self.doc.clear_focus();
                self.nav_start = Some(f);
            }
        }
        self.doc.shell_provider.request_redraw();
    }

    /// Dispatch a synthetic DOM event (probe-only semantic input).
    #[cfg(feature = "probe")]
    pub(crate) fn dispatch_dom(&mut self, event: DomEvent) {
        let handler = Handler {
            app: &mut self.app,
            listeners: &mut self.listeners,
            space_target: &mut self.space_target,
            nav_start: &mut self.nav_start,
            log: &mut self.log,
        };
        EventDriver::new(&mut self.doc, handler).handle_dom_event(event);
    }
}

struct Handler<'a, A: App> {
    app: &'a mut A,
    listeners: &'a mut Listeners,
    space_target: &'a mut Option<NodeId>,
    nav_start: &'a mut Option<NodeId>,
    log: &'a mut Vec<String>,
}

fn tag(doc: &BaseDocument, id: NodeId) -> Option<&str> {
    Some(&doc.get_node(id)?.element_data()?.name.local)
}

fn is_checkbox(doc: &BaseDocument, id: NodeId) -> bool {
    tag(doc, id) == Some("input")
        && doc
            .get_node(id)
            .and_then(|n| n.attr("type".into()))
            .is_some_and(|t| t.eq_ignore_ascii_case("checkbox"))
}

fn is_disabled_control(doc: &BaseDocument, id: NodeId) -> bool {
    matches!(tag(doc, id), Some("button" | "input"))
        && doc
            .get_node(id)
            .is_some_and(|n| n.attr("disabled".into()).is_some())
}

/// The focused element; Blitz reports the root element when nothing is focused.
pub(crate) fn focused_element(doc: &BaseDocument) -> Option<NodeId> {
    doc.get_focussed_node_id()
        .filter(|&f| !matches!(tag(doc, f), None | Some("html" | "body")))
}

/// Element ancestors of `id`, starting with `id`.
fn chain_of(doc: &BaseDocument, id: NodeId) -> Vec<NodeId> {
    let mut out = vec![];
    let mut cur = Some(id);
    while let Some(n) = cur.and_then(|c| doc.get_node(c)) {
        if n.element_data().is_some() {
            out.push(n.id);
        }
        cur = n.parent;
    }
    out
}

fn is_focusable(doc: &BaseDocument, id: NodeId) -> bool {
    matches!(tag(doc, id), Some("button" | "input"))
        && !is_disabled_control(doc, id)
        && doc
            .get_client_bounding_rect(id)
            .is_some_and(|r| r.width > 0.0 && r.height > 0.0)
}

/// All nodes in tree order.
pub(crate) fn tree_order(doc: &BaseDocument) -> Vec<NodeId> {
    let mut out = vec![];
    let mut stack = vec![doc.root_node().id];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        out.push(id);
        stack.extend(node.children.iter().rev());
    }
    out
}

/// The next focusable element after (or before) `from` in tree order; from
/// the document edge when `from` is None or no longer in the document.
fn sequential(doc: &BaseDocument, from: Option<NodeId>, backwards: bool) -> Option<NodeId> {
    let order = tree_order(doc);
    let start = from.and_then(|f| order.iter().position(|n| *n == f));
    let candidates: Box<dyn Iterator<Item = &NodeId>> = match (start, backwards) {
        (Some(i), false) => Box::new(order[i + 1..].iter()),
        (Some(i), true) => Box::new(order[..i].iter().rev()),
        (None, false) => Box::new(order.iter()),
        (None, true) => Box::new(order.iter().rev()),
    };
    candidates.copied().find(|&n| is_focusable(doc, n))
}

impl<A: App> Handler<'_, A> {
    fn dispatch(&mut self, doc: &mut BaseDocument, handler: u32, payload: Option<&str>) {
        let mut dom = Dom {
            doc,
            listeners: self.listeners,
        };
        let outcome = match self.app.dispatch(&mut dom, handler, payload) {
            Ok(()) => format!("handler {handler}"),
            Err(reason) => format!("handler {handler} rejected: {reason}"),
        };
        // A focused element detached by a list move stays the navigation start.
        if let Some(b) = self.listeners.blurred.take() {
            *self.nav_start = Some(b);
        }
        self.log.push(outcome);
    }

    /// Browser click: no dispatch at all when the target is inside a disabled
    /// control; otherwise every click listener on the path runs, target first.
    /// Returns the activated button, if any.
    fn click(&mut self, doc: &mut BaseDocument, chain: &[NodeId]) -> Option<NodeId> {
        if chain.iter().any(|&n| is_disabled_control(doc, n)) {
            return None;
        }
        let button = chain
            .iter()
            .copied()
            .find(|&n| tag(doc, n) == Some("button"));
        let handlers: Vec<u32> = chain
            .iter()
            .filter_map(|&n| self.listeners.get(n, Event::Click))
            .collect();
        for h in handlers {
            self.dispatch(doc, h, None);
        }
        button
    }

    /// Keyboard activation of a checkbox: click listeners, then the toggle and
    /// its `change` event (pointer clicks toggle through Blitz's default action).
    fn activate_checkbox(&mut self, doc: &mut BaseDocument, id: NodeId) {
        let chain = chain_of(doc, id);
        if chain.iter().any(|&n| is_disabled_control(doc, n)) {
            return;
        }
        self.click(doc, &chain);
        let Some(now) = doc
            .get_node(id)
            .and_then(|n| n.element_data())
            .and_then(|e| e.checkbox_input_checked())
            .map(|c| !c)
        else {
            return;
        };
        Dom {
            doc,
            listeners: self.listeners,
        }
        .set_checked(id, now);
        if let Some(h) = self.listeners.get(id, Event::Change) {
            self.dispatch(doc, h, Some(if now { "true" } else { "false" }));
        }
    }

    /// A focused element that became disabled loses focus (browser focus
    /// fixup); it stays the sequential navigation starting point.
    fn fix_focus(&mut self, doc: &mut BaseDocument) {
        if let Some(f) = focused_element(doc) {
            if is_disabled_control(doc, f) {
                doc.clear_focus();
                *self.nav_start = Some(f);
            }
        }
    }
}

impl<A: App> EventHandler for Handler<'_, A> {
    fn handle_event(
        &mut self,
        chain: &[NodeId],
        event: &mut DomEvent,
        document: &mut dyn Document,
        state: &mut EventState,
    ) {
        let mut guard = document.inner_mut();
        let doc: &mut BaseDocument = &mut guard;
        // Keydown listeners (target first, bubbling) run before default actions.
        if let DomEventData::KeyDown(k) = &event.data {
            let key = k.key.to_string();
            let handlers: Vec<u32> = chain
                .iter()
                .filter_map(|&n| self.listeners.get(n, Event::Keydown))
                .collect();
            for h in handlers {
                self.dispatch(doc, h, Some(&key));
            }
        }
        if controls::blocks_edit(doc, &event.data) || controls::exceeds_maxlength(doc, &event.data)
        {
            state.prevent_default();
            return;
        }
        let focused = focused_element(doc);
        let focused_button = focused.filter(|&f| tag(doc, f) == Some("button"));
        let focused_checkbox = focused.filter(|&f| is_checkbox(doc, f));
        match &event.data {
            DomEventData::MouseDown(_) => {
                // Focus moves on mousedown: to the clicked button, nowhere for
                // non-focusable targets (including disabled controls). Text
                // inputs keep Blitz's default (focus and caret placement).
                *self.nav_start = chain.first().copied();
                let control = chain
                    .iter()
                    .copied()
                    .find(|&n| matches!(tag(doc, n), Some("button" | "input")));
                match control {
                    // Checkboxes are focused like buttons; text inputs keep
                    // Blitz's default (focus and caret placement).
                    Some(c) if is_checkbox(doc, c) && !is_disabled_control(doc, c) => {
                        doc.set_focus_to(c);
                    }
                    Some(c) if tag(doc, c) == Some("input") && !is_disabled_control(doc, c) => {}
                    Some(c) if !is_disabled_control(doc, c) => {
                        doc.set_focus_to(c);
                    }
                    _ => doc.clear_focus(),
                }
            }
            DomEventData::Input(input) => {
                // Blitz reports checkbox toggles as input events with "true"/"false".
                let target = chain.first().copied();
                let kind = match target {
                    Some(t) if is_checkbox(doc, t) => Event::Change,
                    _ => Event::Input,
                };
                if let Some(h) = target.and_then(|t| self.listeners.get(t, kind)) {
                    let value = input.value.clone();
                    self.dispatch(doc, h, Some(&value));
                }
            }
            DomEventData::Click(_) if chain.first().is_some_and(|&t| is_checkbox(doc, t)) => {
                // Checkbox activation is handled here rather than by Blitz's
                // default action, which would touch the checkbox after a
                // `change` handler may have removed it.
                state.prevent_default();
                self.activate_checkbox(doc, chain[0]);
            }
            DomEventData::Click(_) => {
                if self.click(doc, chain).is_some() {
                    // The button was focused on mousedown; Blitz's default
                    // click action would clear focus again.
                    state.prevent_default();
                }
            }
            DomEventData::KeyDown(k) if k.key == Key::Tab => {
                state.prevent_default();
                *self.space_target = None;
                let backwards = k.modifiers.contains(Modifiers::SHIFT);
                let next = sequential(doc, focused.or(*self.nav_start), backwards);
                *self.nav_start = None;
                match next {
                    Some(n) => {
                        doc.set_focus_to(n);
                        // Keyboard focus selects the content of text fields (Chromium).
                        if controls::has_editor(doc, n) {
                            doc.with_text_input(n, |mut editor| editor.select_all());
                        }
                    }
                    None => doc.clear_focus(),
                }
            }
            DomEventData::KeyDown(k) if focused_button.is_some() && k.key == Key::Enter => {
                state.prevent_default();
                let button = focused_button.unwrap();
                let chain = chain_of(doc, button);
                self.click(doc, &chain);
            }
            DomEventData::KeyDown(k)
                if focused_button.or(focused_checkbox).is_some()
                    && k.key == Key::Character(" ".into()) =>
            {
                state.prevent_default();
                if !k.is_auto_repeating {
                    *self.space_target = focused_button.or(focused_checkbox);
                }
            }
            DomEventData::KeyUp(k)
                if focused_button.or(focused_checkbox).is_some()
                    && k.key == Key::Character(" ".into()) =>
            {
                state.prevent_default();
                let target = focused_button.or(focused_checkbox);
                if self.space_target.take() == target {
                    let target = target.unwrap();
                    if is_checkbox(doc, target) {
                        self.activate_checkbox(doc, target);
                    } else {
                        let chain = chain_of(doc, target);
                        self.click(doc, &chain);
                    }
                }
            }
            DomEventData::KeyDown(_) => {}
            _ => return,
        }
        self.fix_focus(doc);
        doc.shell_provider.request_redraw();
    }
}
