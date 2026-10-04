//! Event delivery with Chromium's DOM semantics on top of Blitz's single
//! event hook (docs/design/M5-PLATFORM.md): event objects with propagation
//! and cancellation, pointer and mouse events (boundary events in Chromium's
//! order, mouse events suppressed by a cancelled `pointerdown` or a disabled
//! control), click counting, the context menu on press, keyboard activation
//! of buttons (Enter on key down, Space on key up) and checkboxes (Space),
//! sequential Tab focus navigation, button focus on pointer activation, and
//! controlled text inputs and checkboxes. Cancelling an event skips its
//! default actions.

use crate::dom::{Dom, Event, Listeners};
use crate::{App, Delivery, controls};
use blitz_dom::{BaseDocument, DocGuard, DocGuardMut, Document, EventDriver, EventHandler};
use blitz_traits::events::{
    BlitzKeyEvent, BlitzPointerEvent, BlitzWheelDelta, DomEvent, DomEventData, EventState,
    MouseEventButton, UiEvent,
};
use blitz_traits::node_id::NodeId;
use keyboard_types::{Key, Modifiers};
use runic_js::{Element, EventData};

/// The context menu opens on button press (Linux, macOS) or release (Windows).
const CONTEXT_MENU_ON_PRESS: bool = !cfg!(windows);

/// Pointer state across Blitz events.
#[derive(Default)]
pub(crate) struct Pointer {
    /// Elements the pointer left and entered (Blitz's boundary events),
    /// dispatched in Chromium's order before the move that caused them.
    left: Vec<NodeId>,
    entered: Vec<NodeId>,
    /// A cancelled `pointerdown` suppresses mouse events until `mouseup`.
    suppress_mouse: bool,
    /// Click count of the last primary press, and when and where it was.
    clicks: u32,
    last_press: Option<(std::time::Instant, f32, f32)>,
    /// The click count of the next press (probes; otherwise by time and distance).
    pub(crate) next_count: Option<u32>,
    /// An open select popup.
    popup: Option<crate::select::Popup>,
    /// The current press closed a popup (it does not open one again).
    closed_popup: bool,
}

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
    pub pointer: Pointer,
    /// Real-time clock origin of the window (production timers).
    pub started: std::time::Instant,
    /// Clock time of the scheduled wake-up for the next timer.
    pub wake_at: Option<f64>,
    /// Wakes the shell to poll: the next rendering step runs pending
    /// `scroll` events.
    pub waker: Option<std::task::Waker>,
}

impl<A: App> Document for Native<A> {
    fn inner(&self) -> DocGuard<'_> {
        DocGuard::Ref(&self.doc)
    }
    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        // The shell resizes the viewport or changes its color scheme and
        // then redraws: the next poll runs the rendering step for it.
        if self.environ_changed().is_some() {
            if let Some(w) = &self.waker {
                w.wake_by_ref();
            }
        }
        DocGuardMut::Ref(&mut self.doc)
    }
    /// Production timers: run what is due by real time, then wake again for
    /// the next timer.
    fn poll(&mut self, task_context: Option<std::task::Context>) -> bool {
        let now = crate::CLOCK_START + self.started.elapsed().as_secs_f64() * 1000.0;
        if let Some(cx) = &task_context {
            self.waker = Some(cx.waker().clone());
        }
        let mut ran = self.app.next_timer().is_some_and(|t| t <= now);
        if ran {
            self.advance(now);
            self.wake_at = None;
        }
        // The rendering step: resize, scroll and media query events due.
        let environ = self.environ_changed();
        if environ.is_some() || !self.listeners.pending_scroll.is_empty() {
            let resized = environ.is_some_and(|(_, resized)| resized);
            if let Some((env, _)) = environ {
                crate::set_media_env(env);
            }
            self.rendering_step(resized);
            ran = true;
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
            pointer: &mut self.pointer,
        };
        EventDriver::new(&mut self.doc, handler).handle_ui_event(event);
        if !self.listeners.pending_scroll.is_empty() {
            if let Some(w) = &self.waker {
                w.wake_by_ref();
            }
        }
        // Apps: the host's work queued by the event follows it. Probes run
        // it after the whole action (a key press is a key down and a key
        // up; Chromium's clipboard and history replies may come after both).
        if !crate::probe_mode() {
            self.host_tasks();
        }
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
        self.fix_focus_after_update();
        // The host's work queued by the timers runs after them.
        self.host_tasks();
    }

    /// Focus fixups that follow any update outside an event dispatch.
    fn fix_focus_after_update(&mut self) {
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

    /// Run the host's work the app queued (clipboard replies, history
    /// traversals), each a task of its own, with the window events it
    /// brings (`popstate`, `hashchange`).
    pub(crate) fn host_tasks(&mut self) {
        loop {
            self.listeners.settle(&mut self.doc);
            let mut dom = Dom {
                doc: &mut self.doc,
                listeners: &mut self.listeners,
            };
            match self.app.host_task(&mut dom) {
                None => break,
                Some(None) => {}
                Some(Some(kind)) => {
                    let mut handler = Handler {
                        app: &mut self.app,
                        listeners: &mut self.listeners,
                        space_target: &mut self.space_target,
                        nav_start: &mut self.nav_start,
                        log: &mut self.log,
                        pointer: &mut self.pointer,
                    };
                    handler.window(&mut self.doc, kind);
                }
            }
            self.fix_focus_after_update();
        }
    }

    /// The user traverses the session history (`back`: -1, `forward`: 1).
    #[cfg(feature = "probe")]
    pub(crate) fn traverse(&mut self, delta: i64) {
        self.app.traverse(delta);
        self.host_tasks();
    }

    /// Pick an option of a select as the user does (probe `choose`): the
    /// option is shown, then `input` and `change` are dispatched.
    #[cfg(feature = "probe")]
    pub(crate) fn choose(&mut self, select: NodeId, value: &str) {
        self.listeners.settle(&mut self.doc);
        // A value no enabled option has cannot be picked.
        if !crate::select::has_enabled_value(&self.doc, select, value) {
            self.log.push(format!("no option {value}"));
            return;
        }
        let mut dom = Dom {
            doc: &mut self.doc,
            listeners: &mut self.listeners,
        };
        dom.choose_option(select, value);
        let mut handler = Handler {
            app: &mut self.app,
            listeners: &mut self.listeners,
            space_target: &mut self.space_target,
            nav_start: &mut self.nav_start,
            log: &mut self.log,
            pointer: &mut self.pointer,
        };
        let chain = chain_of(&self.doc, select);
        let data = EventData {
            value: value.into(),
            ..Default::default()
        };
        handler.fire(&mut self.doc, &chain, Event::Input, data.clone());
        handler.fire(&mut self.doc, &chain, Event::Change, data);
        self.doc.shell_provider.request_redraw();
    }

    /// Move focus as a user action would (probe focus actions), with the
    /// focus events.
    #[cfg(feature = "probe")]
    pub(crate) fn focus_to(&mut self, next: Option<NodeId>) {
        self.listeners.settle(&mut self.doc);
        let mut handler = Handler {
            app: &mut self.app,
            listeners: &mut self.listeners,
            space_target: &mut self.space_target,
            nav_start: &mut self.nav_start,
            log: &mut self.log,
            pointer: &mut self.pointer,
        };
        handler.move_focus(&mut self.doc, next);
        self.doc.shell_provider.request_redraw();
    }

    /// The media environment of the shell's viewport when it differs from
    /// what queries see, and whether the size changed.
    fn environ_changed(&self) -> Option<(crate::css::MediaEnv, bool)> {
        let v = self.doc.viewport();
        let scale = v.scale() as f64;
        let current = crate::media_env();
        let env = crate::css::MediaEnv {
            width: v.window_size.0 as f64 / scale,
            height: v.window_size.1 as f64 / scale,
            dark: v.color_scheme == blitz_traits::shell::ColorScheme::Dark,
            ..current
        };
        let resized = env.width != current.width || env.height != current.height;
        (env != current).then_some((env, resized))
    }

    /// A rendering step: the window's `resize` event when the viewport size
    /// changed, the scroll steps, then the `change` events of media query
    /// lists whose state changed (Chromium's order).
    pub(crate) fn rendering_step(&mut self, resized: bool) {
        if resized {
            let event = runic_js::Event::new(EventData {
                kind: Event::Resize.name().into(),
                target: Element::WINDOW,
                ..Default::default()
            });
            let mut handler = Handler {
                app: &mut self.app,
                listeners: &mut self.listeners,
                space_target: &mut self.space_target,
                nav_start: &mut self.nav_start,
                log: &mut self.log,
                pointer: &mut self.pointer,
            };
            handler.host(&mut self.doc, Event::Resize, &event);
            event.finish();
        }
        self.run_scroll_steps();
        let changes = self.app.media_changed();
        for (event, keys) in changes {
            let mut handler = Handler {
                app: &mut self.app,
                listeners: &mut self.listeners,
                space_target: &mut self.space_target,
                nav_start: &mut self.nav_start,
                log: &mut self.log,
                pointer: &mut self.pointer,
            };
            for listener in keys {
                let delivery = Delivery {
                    listener,
                    event: event.clone(),
                    current: 0,
                };
                handler.dispatch(&mut self.doc, &[delivery]);
            }
            event.finish();
        }
        self.doc.shell_provider.request_redraw();
    }

    /// The viewport or the user preferences change (probe actions): what
    /// queries see and Blitz's viewport, then a rendering step.
    #[cfg(feature = "probe")]
    pub(crate) fn environ(&mut self, env: crate::css::MediaEnv) {
        let resized = env != crate::media_env()
            && (env.width != crate::media_env().width || env.height != crate::media_env().height);
        crate::set_media_env(env);
        let scheme = if env.dark {
            blitz_traits::shell::ColorScheme::Dark
        } else {
            blitz_traits::shell::ColorScheme::Light
        };
        self.doc.set_viewport(blitz_traits::shell::Viewport::new(
            env.width as u32,
            env.height as u32,
            1.0,
            scheme,
        ));
        self.doc.resolve(0.0);
        self.listeners.settle(&mut self.doc);
        self.rendering_step(resized);
    }

    /// The scroll steps of a rendering step: a `scroll` event for each
    /// scroller that moved since the last one, in order. An element's does
    /// not bubble; the viewport's goes to the document, then the window.
    pub(crate) fn run_scroll_steps(&mut self) {
        let pending = std::mem::take(&mut self.listeners.pending_scroll);
        if pending.is_empty() {
            return;
        }
        let mut handler = Handler {
            app: &mut self.app,
            listeners: &mut self.listeners,
            space_target: &mut self.space_target,
            nav_start: &mut self.nav_start,
            log: &mut self.log,
            pointer: &mut self.pointer,
        };
        for target in pending {
            handler.scroll_event(&mut self.doc, target);
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
            pointer: &mut self.pointer,
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
    pointer: &'a mut Pointer,
}

fn tag(doc: &BaseDocument, id: NodeId) -> Option<&str> {
    Some(&doc.get_node(id)?.element_data()?.name.local)
}

fn input_type(doc: &BaseDocument, id: NodeId, kind: &str) -> bool {
    tag(doc, id) == Some("input")
        && doc
            .get_node(id)
            .and_then(|n| n.attr("type".into()))
            .is_some_and(|t| t.eq_ignore_ascii_case(kind))
}

fn is_radio(doc: &BaseDocument, id: NodeId) -> bool {
    input_type(doc, id, "radio")
}

/// A checkbox or a radio button (a control with a live checked state).
fn is_checkbox(doc: &BaseDocument, id: NodeId) -> bool {
    input_type(doc, id, "checkbox") || is_radio(doc, id)
}

fn checked(doc: &BaseDocument, id: NodeId) -> bool {
    doc.get_node(id)
        .and_then(|n| n.element_data())
        .and_then(|e| e.checkbox_input_checked())
        .unwrap_or(false)
}

/// The radio buttons of `radio`'s group (the same non-empty name; itself
/// alone without one), in tree order.
fn radio_group(doc: &BaseDocument, radio: NodeId) -> Vec<NodeId> {
    let name = doc
        .get_node(radio)
        .and_then(|n| n.attr("name".into()))
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    let Some(name) = name else {
        return vec![radio];
    };
    tree_order(doc)
        .into_iter()
        .filter(|&n| {
            is_radio(doc, n)
                && doc.get_node(n).is_some_and(|x| {
                    x.flags.is_in_document() && x.attr("name".into()) == Some(name.as_str())
                })
        })
        .collect()
}

fn is_disabled_control(doc: &BaseDocument, id: NodeId) -> bool {
    matches!(
        tag(doc, id),
        Some("button" | "input" | "textarea" | "select")
    ) && doc
        .get_node(id)
        .is_some_and(|n| n.attr("disabled".into()).is_some())
}

/// The focused element; Blitz reports the root element when nothing is focused.
pub(crate) fn focused_element(doc: &BaseDocument) -> Option<NodeId> {
    doc.get_focussed_node_id()
        .filter(|&f| !matches!(tag(doc, f), None | Some("html" | "body")))
}

fn is_labelable(doc: &BaseDocument, id: NodeId) -> bool {
    matches!(
        tag(doc, id),
        Some("button" | "input" | "textarea" | "select")
    )
}

/// The control a click on a label activates: none when the click is on
/// interactive content inside the label (the control itself, a button);
/// otherwise the label's `for` element if labelable, or else its first
/// labelable descendant.
fn labelled_control(doc: &BaseDocument, chain: &[NodeId]) -> Option<NodeId> {
    let mut label = None;
    for &n in chain {
        if is_labelable(doc, n) {
            return None;
        }
        if tag(doc, n) == Some("label") {
            label = Some(n);
            break;
        }
    }
    let label = label?;
    if let Some(id) = doc.get_node(label)?.attr("for".into()) {
        return doc.get_element_by_id(id).filter(|&c| is_labelable(doc, c));
    }
    tree_order(doc)
        .into_iter()
        .skip_while(|&n| n != label)
        .skip(1)
        .take_while(|&n| chain_of(doc, n).contains(&label))
        .find(|&n| is_labelable(doc, n))
}

/// The element and its element ancestors, starting with it.
pub(crate) fn element_chain(doc: &BaseDocument, id: NodeId) -> Vec<NodeId> {
    chain_of(doc, id)
        .into_iter()
        .filter(|&n| is_element(doc, n))
        .collect()
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

/// The parsed `tabindex` attribute.
fn tab_index(doc: &BaseDocument, id: NodeId) -> Option<i32> {
    doc.get_node(id)?
        .attr("tabindex".into())?
        .trim()
        .parse()
        .ok()
}

fn is_control(doc: &BaseDocument, id: NodeId) -> bool {
    matches!(
        tag(doc, id),
        Some("button" | "input" | "textarea" | "select")
    )
}

/// Focusable by the mouse and by script: an enabled control or an element
/// with a `tabindex`.
pub(crate) fn is_focusable_element(doc: &BaseDocument, id: NodeId) -> bool {
    (is_control(doc, id) || tab_index(doc, id).is_some()) && !is_disabled_control(doc, id)
}

/// The element's place in the sequential focus navigation order: positive
/// `tabindex` values first, then 0 (and controls without one); none for
/// negative values, disabled controls and elements without a box.
fn tab_order(doc: &BaseDocument, id: NodeId) -> Option<i32> {
    if !is_focusable_element(doc, id)
        || !crate::layout::client_rect(doc, id).is_some_and(|r| r.width > 0.0 && r.height > 0.0)
    {
        return None;
    }
    // A radio group is reached at its checked button (the first without one).
    if is_radio(doc, id) {
        let group = radio_group(doc, id);
        let entry = group
            .iter()
            .copied()
            .find(|&r| checked(doc, r))
            .or_else(|| group.first().copied());
        if entry != Some(id) {
            return None;
        }
    }
    match tab_index(doc, id) {
        Some(t) if t < 0 => None,
        Some(t) => Some(t),
        None => Some(0),
    }
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

/// The next element in sequential focus navigation order after (or before)
/// `from`: positive `tabindex` values ascending, then the rest in tree
/// order. From an element outside the order, the next (previous) one of the
/// tree-order part after (before) it; from the document edge when `from` is
/// None or no longer in the document. None past the end.
fn sequential(doc: &BaseDocument, from: Option<NodeId>, backwards: bool) -> Option<NodeId> {
    let tree = tree_order(doc);
    let mut order: Vec<(i32, usize, NodeId)> = tree
        .iter()
        .enumerate()
        .filter_map(|(i, &n)| tab_order(doc, n).map(|t| (if t == 0 { i32::MAX } else { t }, i, n)))
        .collect();
    order.sort();
    let list: Vec<NodeId> = order.iter().map(|o| o.2).collect();
    let tree_pos = |n: NodeId| tree.iter().position(|&x| x == n);
    match from.and_then(|f| tree_pos(f).map(|p| (f, p))) {
        None => {
            if backwards {
                list.last().copied()
            } else {
                list.first().copied()
            }
        }
        Some((f, p)) => match list.iter().position(|&n| n == f) {
            Some(i) if backwards => i.checked_sub(1).map(|j| list[j]),
            Some(i) => list.get(i + 1).copied(),
            None => {
                let zero = order.iter().filter(|o| o.0 == i32::MAX);
                if backwards {
                    zero.filter(|o| o.1 < p).last().map(|o| o.2)
                } else {
                    zero.clone().find(|o| o.1 > p).map(|o| o.2)
                }
            }
        },
    }
}

fn is_element(doc: &BaseDocument, id: NodeId) -> bool {
    doc.get_node(id).is_some_and(|n| n.element_data().is_some())
}

fn inside_disabled(doc: &BaseDocument, chain: &[NodeId]) -> bool {
    chain.iter().any(|&n| is_disabled_control(doc, n))
}

fn modifiers(data: &mut EventData, mods: Modifiers) {
    data.ctrl = mods.contains(Modifiers::CONTROL);
    data.shift = mods.contains(Modifiers::SHIFT);
    data.alt = mods.contains(Modifiers::ALT);
    data.meta = mods.contains(Modifiers::META);
}

fn pointer_data(p: &BlitzPointerEvent) -> EventData {
    let mut d = EventData {
        client_x: p.coords.client_x as f64,
        client_y: p.coords.client_y as f64,
        button: p.button as u8 as f64,
        buttons: p.buttons.bits() as f64,
        ..Default::default()
    };
    modifiers(&mut d, p.mods);
    d
}

fn key_data(k: &BlitzKeyEvent) -> EventData {
    let mut d = EventData {
        key: k.key.to_string().as_str().into(),
        code: k.code.to_string().as_str().into(),
        repeat: k.is_auto_repeating,
        ..Default::default()
    };
    modifiers(&mut d, k.modifiers);
    d
}

impl<A: App> Handler<'_, A> {
    /// Dispatch `kind` at the first element of `chain` (the target and its
    /// ancestors): the listeners on its path, target first (only the
    /// target's where the event does not bubble). Returns the event.
    fn fire(
        &mut self,
        doc: &mut BaseDocument,
        chain: &[NodeId],
        kind: Event,
        mut data: EventData,
    ) -> Option<runic_js::Event> {
        let elements: Vec<NodeId> = chain
            .iter()
            .copied()
            .filter(|&n| is_element(doc, n))
            .collect();
        let target = *elements.first()?;
        data.kind = kind.name().into();
        data.target = Element(target.as_u64());
        data.cancelable = kind.cancelable();
        if kind != Event::Input {
            if let Some(v) =
                controls::value(doc, target).or_else(|| crate::select::value(doc, target))
            {
                data.value = v.as_str().into();
            }
        }
        if !matches!(kind, Event::Click | Event::Change) {
            data.checked = doc
                .get_node(target)
                .and_then(|n| n.element_data())
                .and_then(|e| e.checkbox_input_checked())
                .unwrap_or_default();
        }
        let event = runic_js::Event::new(data);
        let path = if kind.bubbles() {
            &elements[..]
        } else {
            &elements[..1]
        };
        let deliveries: Vec<Delivery> = path
            .iter()
            .flat_map(|&n| {
                let event = &event;
                self.listeners.all(n, kind).map(move |listener| Delivery {
                    listener,
                    event: event.clone(),
                    current: n.as_u64(),
                })
            })
            .collect();
        self.dispatch(doc, &deliveries);
        if kind.bubbles() {
            self.host(doc, kind, &event);
        }
        event.finish();
        Some(event)
    }

    /// The `scroll` event of `target` (the root element: the document's).
    fn scroll_event(&mut self, doc: &mut BaseDocument, target: NodeId) {
        if doc.try_root_element().is_some_and(|r| r.id == target) {
            let event = runic_js::Event::new(EventData {
                kind: Event::Scroll.name().into(),
                target: Element::DOCUMENT,
                ..Default::default()
            });
            self.host(doc, Event::Scroll, &event);
            event.finish();
        } else if doc
            .get_node(target)
            .is_some_and(|n| n.flags.is_in_document())
        {
            self.fire(doc, &[target], Event::Scroll, EventData::default());
        }
    }

    /// After the element path: the document's listeners, then the window's,
    /// each a callback of its own (a microtask checkpoint follows it). A
    /// target's listeners are those registered when the event reaches it;
    /// one removed meanwhile is not called.
    fn host(&mut self, doc: &mut BaseDocument, kind: Event, event: &runic_js::Event) {
        for window in [false, true] {
            let current = if window {
                Element::WINDOW
            } else {
                Element::DOCUMENT
            };
            for listener in self.app.host_listeners(window, kind) {
                let delivery = Delivery {
                    listener,
                    event: event.clone(),
                    current: current.0,
                };
                self.dispatch(doc, &[delivery]);
            }
        }
    }

    /// Fire `kind` at the window (`popstate`, `hashchange`): its listeners,
    /// each a callback of its own.
    fn window(&mut self, doc: &mut BaseDocument, kind: Event) {
        let event = runic_js::Event::new(EventData {
            kind: kind.name().into(),
            target: Element::WINDOW,
            ..Default::default()
        });
        self.host(doc, kind, &event);
        event.finish();
    }

    /// Run one dispatch of listeners.
    fn dispatch(&mut self, doc: &mut BaseDocument, deliveries: &[Delivery]) {
        if deliveries.is_empty() {
            return;
        }
        let mut dom = Dom {
            doc,
            listeners: self.listeners,
        };
        let ids: Vec<String> = deliveries.iter().map(|d| d.listener.to_string()).collect();
        let outcome = match self.app.dispatch(&mut dom, deliveries) {
            Ok(()) => format!("handler {}", ids.join(",")),
            Err(reason) => format!("handler {} rejected: {reason}", ids.join(",")),
        };
        // A focused element detached by a list move stays the navigation start.
        if let Some(b) = self.listeners.blurred.take() {
            *self.nav_start = Some(b);
        }
        self.log.push(outcome);
    }

    /// Move focus and dispatch the focus events in Chromium's order: `blur`
    /// and `focusout` on the element losing focus, then `focus` and
    /// `focusin` on the one gaining it, each naming the other as
    /// `relatedTarget`.
    pub(crate) fn move_focus(&mut self, doc: &mut BaseDocument, next: Option<NodeId>) {
        let old = focused_element(doc);
        if old == next {
            return;
        }
        match next {
            Some(n) => {
                doc.set_focus_to(n);
            }
            None => doc.clear_focus(),
        }
        let related = |n: Option<NodeId>| EventData {
            related: n.map(|n| Element(n.as_u64())),
            ..Default::default()
        };
        if let Some(o) = old.filter(|&o| doc.get_node(o).is_some_and(|n| n.flags.is_in_document()))
        {
            crate::controls::reset_scroll_on_blur(doc, o);
            self.fire(doc, &[o], Event::Blur, related(next));
            let chain = chain_of(doc, o);
            self.fire(doc, &chain, Event::Focusout, related(next));
        }
        if let Some(n) = next.filter(|&n| doc.get_node(n).is_some_and(|n| n.flags.is_in_document()))
        {
            self.fire(doc, &[n], Event::Focus, related(old));
            let chain = chain_of(doc, n);
            self.fire(doc, &chain, Event::Focusin, related(old));
        }
    }

    /// Open the popup of `select` (drawn in windowed runs; Chromium's popup
    /// is not page content, so probes do not draw it).
    fn open_popup(&mut self, doc: &mut BaseDocument, select: NodeId) {
        let highlighted = crate::select::shown_index(doc, select);
        let mut dom = Dom {
            doc,
            listeners: self.listeners,
        };
        // Headless Chromium draws its popup into the page, so probes draw it too.
        let list = crate::select::draw_popup(&mut dom, select, highlighted);
        self.pointer.popup = Some(crate::select::Popup {
            select,
            highlighted,
            list,
        });
    }

    /// Move the popup's highlight.
    fn highlight(&mut self, doc: &mut BaseDocument, to: usize) {
        let Some(popup) = self.pointer.popup.as_mut() else {
            return;
        };
        popup.highlighted = Some(to);
        let select = popup.select;
        crate::select::show_index(
            &mut Dom {
                doc,
                listeners: self.listeners,
            },
            select,
            Some(to),
        );
        if let Some(list) = self.pointer.popup.as_mut().and_then(|p| p.list.take()) {
            let mut dom = Dom {
                doc,
                listeners: self.listeners,
            };
            dom.remove(list);
            let _ = dom.take_freed();
            let list = crate::select::draw_popup(&mut dom, select, Some(to));
            if let Some(p) = self.pointer.popup.as_mut() {
                p.list = list;
            }
        }
    }

    /// Close the popup: the highlighted option becomes the select's
    /// (`input`, `change` when it changes), then for Enter a `click`.
    fn close_popup(&mut self, doc: &mut BaseDocument, click: bool) {
        let Some(popup) = self.pointer.popup.take() else {
            return;
        };
        let select = popup.select;
        if let Some(list) = popup.list {
            let mut dom = Dom {
                doc,
                listeners: self.listeners,
            };
            dom.remove(list);
            let _ = dom.take_freed();
        }
        if doc.get_node(select).is_none() {
            return;
        }
        let chain = chain_of(doc, select);
        if let Some(i) = popup.highlighted {
            if crate::select::shown_index(doc, select) != Some(i) {
                if let Some(value) = crate::select::value_at(doc, select, i) {
                    Dom {
                        doc,
                        listeners: self.listeners,
                    }
                    .choose_option(select, &value);
                    let data = EventData {
                        value: value.as_str().into(),
                        ..Default::default()
                    };
                    self.fire(doc, &chain, Event::Input, data.clone());
                    self.fire(doc, &chain, Event::Change, data);
                }
            }
        }
        if click {
            self.click(doc, &chain, EventData::default());
        }
    }

    /// Whether `event` was cancelled.
    fn cancelled(event: &Option<runic_js::Event>) -> bool {
        event.as_ref().is_some_and(|e| e.default_prevented())
    }

    /// Browser click: no dispatch at all when the target is inside a disabled
    /// control; otherwise every click listener on the path runs, target
    /// first. Returns the event (none when suppressed).
    fn click(
        &mut self,
        doc: &mut BaseDocument,
        chain: &[NodeId],
        data: EventData,
    ) -> Option<runic_js::Event> {
        if inside_disabled(doc, chain) {
            return None;
        }
        self.fire(doc, chain, Event::Click, data)
    }

    /// Checkbox activation: the toggle, click listeners, then its `change`
    /// event unless the click was cancelled (the toggle is then reverted).
    fn activate_checkbox(&mut self, doc: &mut BaseDocument, id: NodeId, data: EventData) {
        let chain = chain_of(doc, id);
        if inside_disabled(doc, &chain) {
            return;
        }
        // The toggle precedes the click listeners, as in the browser: a
        // checkbox flips; a radio button is checked and its group's other
        // one unchecked (a checked radio button only gets the click).
        let was = checked(doc, id);
        let radio = is_radio(doc, id);
        if radio && was {
            let data = EventData {
                checked: true,
                ..data
            };
            self.click(doc, &chain, data);
            return;
        }
        let now = radio || !was;
        let previous: Vec<NodeId> = if radio {
            radio_group(doc, id)
                .into_iter()
                .filter(|&r| r != id && checked(doc, r))
                .collect()
        } else {
            vec![]
        };
        {
            let mut dom = Dom {
                doc,
                listeners: self.listeners,
            };
            dom.set_checked(id, now);
            for &r in &previous {
                dom.set_checked(r, false);
            }
        }
        let click_data = EventData {
            checked: now,
            ..data
        };
        let change_data = |target: NodeId| EventData {
            kind: Event::Change.name().into(),
            target: Element(target.as_u64()),
            checked: now,
            ..Default::default()
        };
        let click = if A::CHANGE_WITH_CLICK {
            // One dispatch: the click listeners, then `change` (delivered
            // with the click, whatever its listeners do).
            let mut data = click_data;
            data.kind = Event::Click.name().into();
            data.target = Element(id.as_u64());
            data.cancelable = true;
            let event = runic_js::Event::new(data);
            let change = runic_js::Event::new(change_data(id));
            let mut deliveries: Vec<Delivery> = vec![];
            for &n in &chain {
                for listener in self.listeners.all(n, Event::Click) {
                    deliveries.push(Delivery {
                        listener,
                        event: event.clone(),
                        current: n.as_u64(),
                    });
                }
            }
            for listener in self.listeners.all(id, Event::Change) {
                deliveries.push(Delivery {
                    listener,
                    event: change.clone(),
                    current: id.as_u64(),
                });
            }
            self.dispatch(doc, &deliveries);
            self.host(doc, Event::Click, &event);
            self.host(doc, Event::Change, &change);
            event.finish();
            change.finish();
            Some(event)
        } else {
            self.fire(doc, &chain, Event::Click, click_data)
        };
        if Self::cancelled(&click) {
            let mut dom = Dom {
                doc,
                listeners: self.listeners,
            };
            if dom.doc.get_node(id).is_some() {
                dom.set_checked(id, was);
            }
            for &r in &previous {
                if dom.doc.get_node(r).is_some() {
                    dom.set_checked(r, true);
                }
            }
            return;
        }
        if !A::CHANGE_WITH_CLICK {
            self.fire(doc, &[id], Event::Change, change_data(id));
        }
    }

    /// The boundary events of a pointer move, in Chromium's order: pointer
    /// events (leaving innermost first, entering outermost first), then
    /// mouse events. Elements no longer in the document get none.
    fn boundary(&mut self, doc: &mut BaseDocument, p: &BlitzPointerEvent) {
        let mut left = std::mem::take(&mut self.pointer.left);
        left.reverse();
        let entered = std::mem::take(&mut self.pointer.entered);
        let live = |doc: &BaseDocument, n: NodeId| {
            is_element(doc, n) && doc.get_node(n).is_some_and(|n| n.flags.is_in_document())
        };
        let mouse = p.is_mouse();
        for (leave, enter) in [
            (Event::Pointerleave, Event::Pointerenter),
            (Event::Mouseleave, Event::Mouseenter),
        ] {
            if leave == Event::Mouseleave && !mouse {
                break;
            }
            for &n in &left {
                if live(doc, n) {
                    self.fire(doc, &[n], leave, pointer_data(p));
                }
            }
            for &n in &entered {
                if live(doc, n) {
                    self.fire(doc, &[n], enter, pointer_data(p));
                }
            }
        }
    }

    /// The click count of a primary press at `(x, y)`.
    fn count_click(&mut self, x: f32, y: f32) -> u32 {
        let now = std::time::Instant::now();
        let count = match self.pointer.next_count.take() {
            Some(n) => n,
            None => match self.pointer.last_press {
                Some((t, px, py))
                    if now.duration_since(t) < std::time::Duration::from_millis(500)
                        && (px - x).abs() <= 2.0
                        && (py - y).abs() <= 2.0 =>
                {
                    self.pointer.clicks + 1
                }
                _ => 1,
            },
        };
        self.pointer.clicks = count;
        self.pointer.last_press = Some((now, x, y));
        count
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
        match &event.data {
            // Boundary events wait for the move that caused them; the
            // pointer's own `over`/`out` events and Blitz's mouse boundary
            // events are not delivered (Chromium's order is rebuilt).
            DomEventData::PointerLeave(_) => {
                self.pointer.left.push(event.target);
                return;
            }
            // A user scroll moved a scroller (the root element: the
            // viewport): its `scroll` event waits for the rendering step.
            DomEventData::Scroll(_) => {
                self.listeners.scrolled(Some(event.target));
                return;
            }
            DomEventData::PointerEnter(_) => {
                self.pointer.entered.push(event.target);
                return;
            }
            DomEventData::PointerOver(_)
            | DomEventData::PointerOut(_)
            | DomEventData::MouseOver(_)
            | DomEventData::MouseOut(_)
            | DomEventData::MouseEnter(_)
            | DomEventData::MouseLeave(_)
            // Generated here instead: double clicks by the runtime's click
            // count, the context menu on press where the platform opens it then.
            | DomEventData::DoubleClick(_)
            | DomEventData::Focus(_)
            | DomEventData::Blur(_)
            | DomEventData::FocusIn(_)
            | DomEventData::FocusOut(_) => return,
            DomEventData::ContextMenu(_) if CONTEXT_MENU_ON_PRESS => return,
            _ => {}
        }
        // An open select popup takes the keyboard (key downs do not reach the
        // page) and closes, committing its highlight, on any press.
        if let Some(popup) = self.pointer.popup.as_ref() {
            let (select, from) = (popup.select, popup.highlighted);
            match &event.data {
                // Tab closes the popup, then moves focus as usual.
                DomEventData::KeyDown(k) if k.key == Key::Tab => self.close_popup(doc, false),
                DomEventData::KeyDown(k) => {
                    state.prevent_default();
                    let key = k.key.to_string();
                    match key.as_str() {
                        "Enter" => self.close_popup(doc, true),
                        "Escape" => self.close_popup(doc, false),
                        _ => {
                            if let Some(i) = crate::select::popup_key(doc, select, from, &key) {
                                self.highlight(doc, i);
                            }
                        }
                    }
                    doc.shell_provider.request_redraw();
                    return;
                }
                // Presses on the popup choose an item (highlighted on press,
                // committed on release); the page sees none of them.
                DomEventData::PointerDown(_)
                | DomEventData::PointerUp(_)
                | DomEventData::MouseDown(_)
                | DomEventData::MouseUp(_)
                | DomEventData::Click(_)
                | DomEventData::PointerMove(_)
                | DomEventData::MouseMove(_)
                    if popup.list.is_some_and(|l| chain.contains(&l)) =>
                {
                    state.prevent_default();
                    let item = popup.list.and_then(|l| {
                        let items = doc
                            .get_node(l)
                            .map(|n| n.children.clone())
                            .unwrap_or_default();
                        items.iter().position(|i| chain.contains(i))
                    });
                    let enabled = |doc: &BaseDocument, i: usize| {
                        crate::select::option_enabled(doc, select, i)
                    };
                    match (&event.data, item) {
                        (DomEventData::PointerDown(_) | DomEventData::PointerMove(_), Some(i))
                            if enabled(doc, i) && from != Some(i) =>
                        {
                            self.highlight(doc, i);
                        }
                        (DomEventData::PointerUp(_), Some(i)) if enabled(doc, i) => {
                            self.highlight(doc, i);
                            self.close_popup(doc, false);
                        }
                        _ => {}
                    }
                    doc.shell_provider.request_redraw();
                    return;
                }
                DomEventData::PointerDown(_) => {
                    self.close_popup(doc, false);
                    self.pointer.closed_popup = true;
                    // The press may have hit what the popup covered.
                    if doc.get_node(event.target).is_none() {
                        state.prevent_default();
                        return;
                    }
                }
                _ => {}
            }
        }
        // Keydown listeners (target first, bubbling) run before default
        // actions; a cancelled keydown has none (no text insertion,
        // activation or focus navigation).
        if let DomEventData::KeyDown(k) = &event.data {
            let e = self.fire(doc, chain, Event::Keydown, key_data(k));
            if Self::cancelled(&e) {
                state.prevent_default();
                *self.space_target = None;
                self.fix_focus(doc);
                doc.shell_provider.request_redraw();
                return;
            }
        }
        // Keys Chromium (Linux) does nothing with in a text control.
        if let DomEventData::KeyDown(k) = &event.data {
            if focused_element(doc).is_some_and(|f| controls::inert_key(doc, f, k)) {
                state.prevent_default();
                self.fix_focus(doc);
                doc.shell_provider.request_redraw();
                return;
            }
        }
        // A focused closed select changes its option with the keyboard.
        if let DomEventData::KeyDown(k) = &event.data {
            if let Some(select) = focused_element(doc).filter(|&f| crate::select::is_select(doc, f))
            {
                if is_disabled_control(doc, select) {
                } else if let Some(value) =
                    crate::select::key_target(doc, select, &k.key.to_string())
                {
                    state.prevent_default();
                    Dom {
                        doc,
                        listeners: self.listeners,
                    }
                    .choose_option(select, &value);
                    let chain = chain_of(doc, select);
                    let data = EventData {
                        value: value.as_str().into(),
                        ..Default::default()
                    };
                    self.fire(doc, &chain, Event::Input, data.clone());
                    self.fire(doc, &chain, Event::Change, data);
                    self.fix_focus(doc);
                    doc.shell_provider.request_redraw();
                    return;
                }
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
            DomEventData::PointerMove(p) => {
                self.boundary(doc, p);
                self.fire(doc, chain, Event::Pointermove, pointer_data(p));
            }
            DomEventData::PointerDown(p) => {
                self.boundary(doc, p);
                self.pointer.suppress_mouse = false;
                // Cancelling pointerdown suppresses the mouse events up to
                // mouseup but not the default actions (focus).
                let e = self.fire(doc, chain, Event::Pointerdown, pointer_data(p));
                self.pointer.suppress_mouse = Self::cancelled(&e);
            }
            DomEventData::PointerUp(p) => {
                self.pointer.closed_popup = false;
                self.boundary(doc, p);
                self.fire(doc, chain, Event::Pointerup, pointer_data(p));
            }
            DomEventData::MouseMove(p) => {
                if !self.pointer.suppress_mouse {
                    self.fire(doc, chain, Event::Mousemove, pointer_data(p));
                }
            }
            DomEventData::MouseUp(p) => {
                // Disabled controls get no mouse button events.
                if !self.pointer.suppress_mouse && !inside_disabled(doc, chain) {
                    self.fire(doc, chain, Event::Mouseup, pointer_data(p));
                }
                self.pointer.suppress_mouse = false;
            }
            DomEventData::MouseDown(p) => {
                if p.button == MouseEventButton::Main {
                    self.count_click(p.coords.client_x, p.coords.client_y);
                }
                let blocked = inside_disabled(doc, chain);
                let e = if self.pointer.suppress_mouse || blocked {
                    None
                } else {
                    self.fire(doc, chain, Event::Mousedown, pointer_data(p))
                };
                if Self::cancelled(&e) {
                    // Focus stays where it is (the menu and popover pattern).
                    state.prevent_default();
                } else {
                    // Focus moves on mousedown: to the clicked button, nowhere
                    // for non-focusable targets (including disabled
                    // controls). Text inputs keep Blitz's default (focus and
                    // caret placement).
                    *self.nav_start = chain.first().copied();
                    let candidate = chain
                        .iter()
                        .copied()
                        .find(|&n| is_control(doc, n) || tab_index(doc, n).is_some());
                    let next = candidate.filter(|&c| !is_disabled_control(doc, c));
                    // Text controls then get Blitz's caret placement.
                    self.move_focus(doc, next);
                    // A press on a closed select opens its popup.
                    let select = chain
                        .iter()
                        .copied()
                        .find(|&n| crate::select::is_select(doc, n));
                    if let Some(select) = select {
                        if p.button == MouseEventButton::Main
                            && !self.pointer.closed_popup
                            && !is_disabled_control(doc, select)
                        {
                            self.open_popup(doc, select);
                        }
                    }
                }
                if CONTEXT_MENU_ON_PRESS && p.button == MouseEventButton::Secondary && !blocked {
                    self.fire(doc, chain, Event::Contextmenu, pointer_data(p));
                }
            }
            DomEventData::ContextMenu(p) => {
                if !inside_disabled(doc, chain) {
                    self.fire(doc, chain, Event::Contextmenu, pointer_data(p));
                }
            }
            DomEventData::Wheel(w) => {
                // DOM deltas are positive downwards; Blitz scrolls a line by 20 px.
                let (dx, dy) = match w.delta {
                    BlitzWheelDelta::Pixels(x, y) => (-x, -y),
                    BlitzWheelDelta::Lines(x, y) => (-x * 20.0, -y * 20.0),
                };
                let mut data = EventData {
                    client_x: w.coords.client_x as f64,
                    client_y: w.coords.client_y as f64,
                    buttons: w.buttons.bits() as f64,
                    delta_x: dx,
                    delta_y: dy,
                    ..Default::default()
                };
                modifiers(&mut data, w.mods);
                let e = self.fire(doc, chain, Event::Wheel, data);
                if Self::cancelled(&e) {
                    state.prevent_default();
                }
            }
            DomEventData::Input(input) => {
                // Blitz reports checkbox toggles as input events with "true"/"false".
                let target = chain.first().copied();
                match target {
                    Some(t) if is_checkbox(doc, t) => {
                        let data = EventData {
                            checked: input.value == "true",
                            ..Default::default()
                        };
                        self.fire(doc, &[t], Event::Change, data);
                    }
                    Some(t) => {
                        let data = EventData {
                            value: input.value.as_str().into(),
                            ..Default::default()
                        };
                        self.fire(doc, &[t], Event::Input, data);
                    }
                    None => {}
                }
            }
            DomEventData::Click(p) if chain.first().is_some_and(|&t| is_checkbox(doc, t)) => {
                // Checkbox activation is handled here rather than by Blitz's
                // default action, which would touch the checkbox after a
                // `change` handler may have removed it.
                state.prevent_default();
                let count = self.pointer.clicks;
                self.activate_checkbox(doc, chain[0], pointer_data(p));
                if count == 2 && !inside_disabled(doc, chain) {
                    self.fire(doc, chain, Event::Dblclick, pointer_data(p));
                }
            }
            DomEventData::Click(p) => {
                let count = self.pointer.clicks;
                let e = self.click(doc, chain, pointer_data(p));
                // Focus moved on mousedown; Blitz's default click action would
                // clear it again without focus events. The click's default
                // actions of the supported elements are done here (checkboxes
                // and labels).
                state.prevent_default();
                if e.is_some() && !Self::cancelled(&e) {
                    if let Some(control) = labelled_control(doc, chain) {
                        // Label activation is done here, as Chromium does it: a
                        // simulated click on checkboxes and buttons, then focus.
                        state.prevent_default();
                        if !is_disabled_control(doc, control) {
                            if is_checkbox(doc, control) {
                                self.activate_checkbox(doc, control, EventData::default());
                            } else if tag(doc, control) == Some("button") {
                                let chain = chain_of(doc, control);
                                self.click(doc, &chain, EventData::default());
                            }
                            if doc
                                .get_node(control)
                                .is_some_and(|n| n.flags.is_in_document())
                            {
                                self.move_focus(doc, Some(control));
                                *self.nav_start = None;
                            }
                        }
                    }
                }
                if count == 2 && !inside_disabled(doc, chain) {
                    self.fire(doc, chain, Event::Dblclick, pointer_data(p));
                }
            }
            DomEventData::KeyDown(k) if k.key == Key::Tab => {
                state.prevent_default();
                *self.space_target = None;
                let backwards = k.modifiers.contains(Modifiers::SHIFT);
                let next = sequential(doc, focused.or(*self.nav_start), backwards);
                *self.nav_start = None;
                self.move_focus(doc, next);
                // Keyboard focus selects the content of text fields (Chromium).
                if let Some(n) = next.filter(|&n| controls::has_editor(doc, n)) {
                    doc.with_text_input(n, |mut editor| editor.select_all());
                }
            }
            DomEventData::KeyDown(k)
                if focused.is_some_and(|f| is_radio(doc, f))
                    && matches!(
                        k.key,
                        Key::ArrowDown | Key::ArrowRight | Key::ArrowUp | Key::ArrowLeft
                    ) =>
            {
                // Arrows move to the next (previous) enabled radio button of
                // the group, wrapping, and check it.
                state.prevent_default();
                let from = focused.unwrap();
                let group: Vec<NodeId> = radio_group(doc, from)
                    .into_iter()
                    .filter(|&r| r == from || !is_disabled_control(doc, r))
                    .collect();
                let i = group.iter().position(|&r| r == from).unwrap_or(0);
                let n = group.len();
                let forward = matches!(k.key, Key::ArrowDown | Key::ArrowRight);
                let next = if forward {
                    group[(i + 1) % n]
                } else {
                    group[(i + n - 1) % n]
                };
                if next != from {
                    self.move_focus(doc, Some(next));
                    self.activate_checkbox(doc, next, EventData::default());
                }
            }
            DomEventData::KeyDown(k) if focused_button.is_some() && k.key == Key::Enter => {
                state.prevent_default();
                let button = focused_button.unwrap();
                let chain = chain_of(doc, button);
                self.click(doc, &chain, EventData::default());
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
            DomEventData::KeyDown(_) => {}
            DomEventData::KeyUp(k) => {
                let e = self.fire(doc, chain, Event::Keyup, key_data(k));
                let space = k.key == Key::Character(" ".into());
                let target = focused_button.or(focused_checkbox);
                if space && target.is_some() {
                    state.prevent_default();
                    if self.space_target.take() == target && !Self::cancelled(&e) {
                        let target = target.unwrap();
                        if is_checkbox(doc, target) {
                            self.activate_checkbox(doc, target, EventData::default());
                        } else {
                            let chain = chain_of(doc, target);
                            self.click(doc, &chain, EventData::default());
                        }
                    }
                }
            }
            _ => return,
        }
        // A target the listeners removed has no default action (Chromium);
        // Blitz's would use the removed node.
        if !doc
            .get_node(event.target)
            .is_some_and(|n| n.flags.is_in_document())
        {
            state.prevent_default();
        }
        self.fix_focus(doc);
        doc.shell_provider.request_redraw();
    }
}
