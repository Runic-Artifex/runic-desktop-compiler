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
    /// The old and new targets of the move (Blitz's `pointerout` and
    /// `pointerover`), for the bubbling boundary events (M6).
    out: Option<NodeId>,
    over: Option<NodeId>,
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

impl Pointer {
    /// The drawn list of an open select popup (runtime content, not the page's).
    #[cfg(feature = "probe")]
    pub(crate) fn popup_list(&self) -> Option<NodeId> {
        self.popup.as_ref().and_then(|p| p.list)
    }
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
    /// A focus fixup the rendering step found due: the element, and the
    /// default-priority tasks queued before it (they run first).
    pub fixup: Option<(NodeId, usize)>,
}

impl<A: App> Document for Native<A> {
    fn inner(&self) -> DocGuard<'_> {
        DocGuard::Ref(&self.doc)
    }
    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        // The shell's first access precedes its animation clock's start:
        // the runtime's timeline starts with it.
        crate::timeline::start();
        // The shell resizes the viewport or changes its color scheme and
        // then redraws: the next poll runs the rendering step for it.
        if self.environ_changed().is_some() {
            if let Some(w) = &self.waker {
                w.wake_by_ref();
            }
        }
        DocGuardMut::Ref(&mut self.doc)
    }
    /// The window's frame: the shell redraws (resolves styles and layout,
    /// paints) right after this. The steps of HTML's "update the rendering"
    /// that precede rendering run first, in Chromium 153's order: the
    /// animation step (the `finished` promises of animations that ended,
    /// then the animation and transition events), then the animation frame
    /// callbacks requested before them (also those the events' listeners
    /// and the promises' reactions request), each a task. Callbacks they
    /// request run at the next frame (`fix_focus_after_update` asks for it).
    fn update_rendering(&mut self) {
        crate::timeline::start();
        let now = crate::CLOCK_START + self.started.elapsed().as_secs_f64() * 1000.0;
        // Callbacks requested by the animation step's listeners and
        // reactions are due in this frame.
        self.app.frame_starts(now);
        if self.animations_active() {
            self.animation_step(false);
        } else {
            self.report_scroll_driven_listeners();
        }
        let due = self.app.frames_due(now);
        self.listeners.settle(&mut self.doc);
        let mut dom = Dom {
            doc: &mut self.doc,
            listeners: &mut self.listeners,
        };
        self.app.frame_callbacks(&mut dom, now);
        if due {
            self.fix_focus_after_update();
            self.host_tasks();
        }
        self.request_frame_if_needed(true);
    }
    /// Production timers: run what is due by real time, then wake again for
    /// the next timer.
    fn poll(&mut self, task_context: Option<std::task::Context>) -> bool {
        let now = crate::CLOCK_START + self.started.elapsed().as_secs_f64() * 1000.0;
        if let Some(cx) = &task_context {
            self.waker = Some(cx.waker().clone());
            crate::desktop::register_waker(cx.waker());
        }
        let mut ran = self.app.next_timer().is_some_and(|t| t <= now);
        if ran {
            self.advance(now);
            self.wake_at = None;
        }
        // The tasks the last frame queued (IntersectionObserver notifications).
        self.host_tasks();
        // The rendering step: resize, scroll and media query events due.
        let environ = self.environ_changed();
        if environ.is_some() || !self.listeners.pending_scroll.is_empty() || self.focus_fixup_due()
        {
            let resized = environ.is_some_and(|(_, resized)| resized);
            if let Some((env, _)) = environ {
                // (Blitz restyles only if the preferences changed.)
                self.doc
                    .set_media_preferences(crate::media_preferences(&env));
                crate::set_media_env(env);
            }
            self.rendering_step(resized);
            ran = true;
        }
        // The frame's layout, before the shell paints it.
        if self.layout_frame() {
            ran = true;
        }
        if !self.listeners.pending_scroll.is_empty() {
            // Clamped scrollers: their scroll events are due in the next frame.
            if let Some(cx) = &task_context {
                cx.waker().wake_by_ref();
            }
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
        // (A frame due later wakes this poll at its time, above.)
        self.request_frame_if_needed(false);
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
        // Apps: the host's work queued by the event follows it. Probes run
        // it after the whole action (a key press is a key down and a key
        // up; Chromium's clipboard and history replies may come after both).
        if !crate::probe_mode() {
            self.host_tasks();
            // A scroller the update left past the end of its range is
            // clamped before the shell paints (probes lay out in frames).
            if crate::layout::any_scrolled(&self.doc) {
                crate::layout::resolve(&mut self.doc);
            }
        }
        if !self.listeners.pending_scroll.is_empty()
            || crate::layout::any_clamped()
            || self.focus_fixup_due()
        {
            if let Some(w) = &self.waker {
                w.wake_by_ref();
            }
        }
        self.request_frame_if_needed(true);
    }
}

impl<A: App> Native<A> {
    /// Animation frame callbacks wait for the window's frame (apps): one is
    /// requested when any is due (at its 16 ms boundary; `poll` wakes then
    /// for one due later), so a loop of them keeps the window drawing at the
    /// frame rate, and without them (or animations) it goes idle.
    /// `wake`: outside `poll`, wake it so that it schedules its wake-up
    /// for a frame due later (from `poll` itself that would loop).
    fn request_frame_if_needed(&self, wake: bool) {
        let now = crate::CLOCK_START + self.started.elapsed().as_secs_f64() * 1000.0;
        if self.app.frames_due(now) {
            self.doc.shell_provider.request_redraw();
        } else if wake && self.app.has_frame_callbacks() {
            if let Some(w) = &self.waker {
                w.wake_by_ref();
            }
        }
    }

    /// Run the timers due at or before clock time `to`, then apply the focus
    /// fixups that follow any update.
    pub(crate) fn advance(&mut self, to: f64) {
        self.run_timers(to);
        self.fix_focus_after_update();
        // The host's work queued by the timers runs after them.
        self.host_tasks();
    }

    /// Run the timers and animation frames due at or before clock time `to`.
    fn run_timers(&mut self, to: f64) {
        self.listeners.settle(&mut self.doc);
        let mut dom = Dom {
            doc: &mut self.doc,
            listeners: &mut self.listeners,
        };
        self.app.advance(&mut dom, to);
        if crate::probe_mode() {
            crate::timeline::set_virtual(self.app.now());
        }
    }

    /// A probe's `wait` up to virtual time `to`: the timers due run in
    /// order and, at every frame (each multiple of 16 ms, where the timers
    /// place animation frames), the frame's animation step runs before its
    /// animation frame callbacks, as in Chromium's "update the rendering"
    /// (CSS slice 3b): the timers due before the frame (the clock stands at
    /// the millisecond before it, as Playwright's whole-millisecond clock
    /// does in the browser harness), then styles resolved at the frame and
    /// its animation step (the `finished` promises, then the animation and
    /// transition events), then the timers due at the frame (its animation
    /// frame callbacks among them, also those the events' listeners
    /// requested), then styles resolved again with another step, so that
    /// animations and transitions the callbacks start begin at the frame,
    /// as the browser harness samples Chromium's
    /// (docs/design/M6-LIBRARIES.md#animations).
    #[cfg(feature = "probe")]
    pub(crate) fn wait(&mut self, to: f64) {
        loop {
            let frame = (self.app.now() / 16.0).floor() * 16.0 + 16.0;
            if frame > to {
                break;
            }
            self.run_timers(frame - 1.0);
            crate::timeline::set_virtual(frame);
            crate::timeline::resolve(&mut self.doc);
            self.animation_step(false);
            self.run_timers(frame);
            crate::timeline::resolve(&mut self.doc);
            self.animation_step(false);
        }
        self.advance(to);
    }

    /// A frame's animation step (M6, Chromium's "update animations"): the
    /// animations the app holds that ended settle their `finished`
    /// promises (a task with its microtask checkpoint), and every running
    /// animation stops being `pending`; then the animation and transition
    /// events the frame sampled are dispatched (CSS slice 3b,
    /// `animation_events`). `rendering`: inside a rendering step.
    pub(crate) fn animation_step(&mut self, rendering: bool) {
        self.report_scroll_driven_listeners();
        if !self.animations_active() {
            return;
        }
        crate::timeline::resolve(&mut self.doc);
        // Chromium samples every animation, then runs the microtask
        // checkpoint that settles the promises, then dispatches the events.
        let events = self.doc.take_animation_events(crate::timeline::now());
        crate::animations::commit();
        if crate::animations::active() && crate::animations::has_ended(true) {
            self.listeners.settle(&mut self.doc);
            let mut dom = Dom {
                doc: &mut self.doc,
                listeners: &mut self.listeners,
            };
            self.app.animation_step(&mut dom);
            self.fix_focus_after_update();
            self.host_tasks();
        }
        self.dispatch_animation_events(events, rendering);
    }

    /// Focus fixups that follow any update outside an event dispatch.
    pub(crate) fn fix_focus_after_update(&mut self) {
        if let Some(b) = self.listeners.blurred.take() {
            self.nav_start = Some(b);
        }
        if let Some(start) = self.listeners.set_navigation.take() {
            self.nav_start = start;
        }
        self.doc.shell_provider.request_redraw();
    }

    /// Dispatch an event of `kind` at the first element of `chain` (the
    /// target and its ancestors), as `Handler::fire` (CSS slice 3b).
    pub(crate) fn fire_event(&mut self, chain: &[NodeId], kind: Event, data: EventData) {
        self.listeners.settle(&mut self.doc);
        let mut handler = Handler {
            app: &mut self.app,
            listeners: &mut self.listeners,
            space_target: &mut self.space_target,
            nav_start: &mut self.nav_start,
            log: &mut self.log,
            pointer: &mut self.pointer,
        };
        handler.fire(&mut self.doc, chain, kind, data);
    }

    /// Run the host's work the app queued (clipboard replies, history
    /// traversals), each a task of its own, with the window events it
    /// brings (`popstate`, `hashchange`).
    pub(crate) fn host_tasks(&mut self) {
        loop {
            // The image outcomes the last task determined come first.
            self.image_tasks();
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

    /// The `load` and `error` events of `<img>` elements (M6 images). The net
    /// provider answers every request synchronously; Blitz determines each
    /// outcome when it processes the response (`handle_messages`), or, for
    /// an image it already holds, when `src` is set or the element inserted,
    /// and records them in that order. Each event is then a task of its own
    /// after the task that determined it (not bubbling, not cancelable): its
    /// listeners, their microtask checkpoints and the updates they queue.
    /// Outcomes the listeners determine follow, until none is left. An
    /// element whose `src` changed after its outcome was taken has a newer
    /// request: the older outcome is dropped, as Chromium cancels its event.
    ///
    /// Image objects (`new Image()`) determine their outcome when their
    /// `src` is set; each round runs the outcomes queued so far first, in
    /// the order their sources were set, then the elements' (Chromium 153
    /// orders a cached URL so for an object set before an element; for an
    /// uncached URL its order varies between runs, docs/gaps/PLATFORM.md).
    pub(crate) fn image_tasks(&mut self) {
        loop {
            let objects = self.app.image_queued();
            for _ in 0..objects {
                self.listeners.settle(&mut self.doc);
                let mut dom = Dom {
                    doc: &mut self.doc,
                    listeners: &mut self.listeners,
                };
                self.app.image_task(&mut dom);
                self.fix_focus_after_update();
            }
            self.doc.handle_messages();
            let events = self.doc.take_image_load_events();
            if events.is_empty() {
                if objects == 0 {
                    return;
                }
                continue;
            }
            let srcs: Vec<Option<String>> = events
                .iter()
                .map(|e| image_src(&self.doc, e.node_id))
                .collect();
            for (e, src) in events.into_iter().zip(srcs) {
                if image_src(&self.doc, e.node_id) != src {
                    continue;
                }
                let kind = match e.kind {
                    blitz_dom::ImageLoadEventKind::Load => Event::Load,
                    blitz_dom::ImageLoadEventKind::Error => Event::Error,
                };
                self.listeners.settle(&mut self.doc);
                let mut handler = Handler {
                    app: &mut self.app,
                    listeners: &mut self.listeners,
                    space_target: &mut self.space_target,
                    nav_start: &mut self.nav_start,
                    log: &mut self.log,
                    pointer: &mut self.pointer,
                };
                handler.fire(&mut self.doc, &[e.node_id], kind, EventData::default());
                self.fix_focus_after_update();
            }
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

    /// Whether the focused element became disabled (the next rendering step
    /// blurs it).
    fn focus_fixup_due(&self) -> bool {
        focused_element(&self.doc).is_some_and(|f| is_disabled_control(&self.doc, f))
    }

    /// The media environment of the shell's viewport when it differs from
    /// what queries see, and whether the size changed.
    fn environ_changed(&self) -> Option<(crate::css::MediaEnv, bool)> {
        let v = self.doc.viewport();
        let scale = v.scale() as f64;
        let current = crate::media_env();
        let mut env = crate::css::MediaEnv {
            width: v.window_size.0 as f64 / scale,
            height: v.window_size.1 as f64 / scale,
            dark: v.color_scheme == blitz_traits::shell::ColorScheme::Dark,
            ..current
        };
        // Natively the desktop preferences as last read (probes set them
        // through their actions).
        if !crate::probe_mode() {
            env = crate::with_desktop_preferences(env);
        }
        let resized = env.width != current.width || env.height != current.height;
        (env != current).then_some((env, resized))
    }

    /// A rendering step: the window's `resize` event when the viewport size
    /// changed, the scroll steps, then the `change` events of media query
    /// lists whose state changed (Chromium's order).
    pub(crate) fn rendering_step(&mut self, resized: bool) {
        // No task runs inside the frame: default-priority tasks its events
        // queue (React's scroll updates) run after its layout.
        self.app.defer_tasks(true);
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
            handler.capture(&mut self.doc, Event::Resize, &event, false);
            handler.host(&mut self.doc, Event::Resize, &event);
            event.finish();
            // Then the visual viewport's (it resizes with the window).
            let event = runic_js::Event::new(EventData {
                kind: Event::Resize.name().into(),
                target: Element::VISUAL_VIEWPORT,
                ..Default::default()
            });
            for listener in handler.app.viewport_listeners(Event::Resize) {
                let delivery = Delivery {
                    listener,
                    event: event.clone(),
                    current: Element::VISUAL_VIEWPORT.0,
                    delegated: None,
                    joined: false,
                };
                handler.dispatch(&mut self.doc, &[delivery]);
            }
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
                    delegated: None,
                    joined: false,
                };
                handler.dispatch(&mut self.doc, &[delivery]);
            }
            event.finish();
        }
        // Update animations (after media queries in Chromium's rendering
        // steps): the ends of animations the app holds settle (M6), then
        // animation and transition events (CSS slice 3b).
        self.animation_step(true);
        // Focus fixup: a focused element that became disabled or lost its
        // box is blurred, with `blur` and `focusout` as events of their own,
        // in a task after the frame (Chromium's style update starts a 0 ms
        // timer: after animation frames, and after the tasks the frame's
        // events queued before it, such as React's render of a scroll).
        crate::timeline::resolve(&mut self.doc);
        if let Some(f) = self.fixup_target() {
            self.fixup = Some((f, self.app.deferred_len()));
        }
        self.doc.shell_provider.request_redraw();
    }

    /// The focused element when it must lose focus (disabled, or without a
    /// box).
    fn fixup_target(&self) -> Option<NodeId> {
        let f = focused_element(&self.doc)?;
        let boxless = !crate::layout::client_rect(&self.doc, f).is_some()
            || !self.doc.get_node(f).is_some_and(|n| n.has_boxes());
        (is_disabled_control(&self.doc, f) || boxless).then_some(f)
    }

    /// A frame's layout after its rendering step. Scroll offsets that layout
    /// (or a layout read since the last frame) clamped get their `scroll`
    /// events queued, for the next frame's rendering step: Chromium queues
    /// them in the frame's lifecycle after its scroll steps. Returns whether
    /// any were queued.
    pub(crate) fn layout_frame(&mut self) -> bool {
        crate::layout::resolve(&mut self.doc);
        // ResizeObserver notifications, after layout and before paint (M6).
        self.listeners.settle(&mut self.doc);
        let mut dom = Dom {
            doc: &mut self.doc,
            listeners: &mut self.listeners,
        };
        if self.app.resize_step(&mut dom) {
            self.fix_focus_after_update();
            self.host_tasks();
        }
        // IntersectionObserver updates (M6 overlays), after ResizeObserver's:
        // their notifications are a task after the frame.
        let mut dom = Dom {
            doc: &mut self.doc,
            listeners: &mut self.listeners,
        };
        let intersections = self.app.intersection_step(&mut dom);
        if intersections && let Some(w) = &self.waker {
            w.wake_by_ref();
        }
        // Text that no loaded font draws would silently be missing (Chromium
        // falls back to a system font): a probe fails, an app reports it once.
        for text in crate::layout::unfonted_text(&self.doc) {
            #[cfg(feature = "probe")]
            panic!(
                "E_FONT: {text} is not drawn: no font of its font-family is embedded in the app"
            );
            #[cfg(not(feature = "probe"))]
            crate::layout::report_once(format!(
                "runic: E_FONT: {text} is not drawn: no font of its font-family is embedded in the app"
            ));
        }
        crate::effects::report_filter_deviations(&self.doc);
        crate::effects::report_blend_deviations(&self.doc);
        self.listeners.settle(&mut self.doc);
        let clamped = crate::layout::take_clamped();
        for &node in &clamped {
            self.listeners.scrolled(Some(node));
        }
        // The default-priority tasks the frame deferred (React renders
        // updates from scroll events in a scheduler task after the frame),
        // and the focus fixup's task after those queued before it.
        self.app.defer_tasks(false);
        if let Some((f, before)) = self.fixup.take() {
            let mut dom = Dom {
                doc: &mut self.doc,
                listeners: &mut self.listeners,
            };
            self.app.run_deferred(&mut dom, Some(before));
            self.fix_focus_after_update();
            crate::timeline::resolve(&mut self.doc);
            if self.fixup_target() == Some(f) {
                let mut handler = Handler {
                    app: &mut self.app,
                    listeners: &mut self.listeners,
                    space_target: &mut self.space_target,
                    nav_start: &mut self.nav_start,
                    log: &mut self.log,
                    pointer: &mut self.pointer,
                };
                handler.move_focus(&mut self.doc, None);
                self.nav_start = Some(f);
            }
        }
        let mut dom = Dom {
            doc: &mut self.doc,
            listeners: &mut self.listeners,
        };
        self.app.run_deferred(&mut dom, None);
        self.fix_focus_after_update();
        !clamped.is_empty()
    }

    /// One frame (probes): the rendering step, then layout.
    #[cfg(feature = "probe")]
    pub(crate) fn frame(&mut self) {
        // The tasks the last frame queued (IntersectionObserver notifications).
        self.host_tasks();
        self.rendering_step(false);
        self.layout_frame();
    }

    /// The viewport or the user preferences change (probe actions): what
    /// queries see and Blitz's viewport, then a rendering step.
    #[cfg(feature = "probe")]
    pub(crate) fn environ(&mut self, env: crate::css::MediaEnv) {
        let resized = env != crate::media_env()
            && (env.width != crate::media_env().width || env.height != crate::media_env().height);
        crate::set_media_env(env);
        self.doc
            .set_media_preferences(crate::media_preferences(&env));
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
        crate::timeline::resolve(&mut self.doc);
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

/// The `src` of image element `id` (`None` once the node is gone).
fn image_src(doc: &BaseDocument, id: NodeId) -> Option<String> {
    let node = doc.get_node(id)?;
    Some(node.attr("src".into()).unwrap_or_default().to_owned())
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

pub(crate) fn is_radio(doc: &BaseDocument, id: NodeId) -> bool {
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
pub(crate) fn radio_group(doc: &BaseDocument, radio: NodeId) -> Vec<NodeId> {
    let name = doc
        .get_node(radio)
        .and_then(|n| n.attr("name".into()))
        .filter(|n| !n.is_empty())
        .map(str::to_owned);
    let Some(name) = name else {
        return vec![radio];
    };
    // The same tree: the document, or the detached subtree a template is
    // being built in.
    let mut root = radio;
    while let Some(p) = doc.get_node(root).and_then(|n| n.parent) {
        root = p;
    }
    subtree_order(doc, root)
        .into_iter()
        .filter(|&n| {
            is_radio(doc, n)
                && doc
                    .get_node(n)
                    .is_some_and(|x| x.attr("name".into()) == Some(name.as_str()))
        })
        .collect()
}

/// The nodes of the subtree at `root`, in tree order.
pub(crate) fn subtree_order(doc: &BaseDocument, root: NodeId) -> Vec<NodeId> {
    let mut out = vec![];
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        out.push(id);
        stack.extend(node.children.iter().rev());
    }
    out
}

/// Set a checkbox's or radio button's checkedness (no events).
pub(crate) fn set_checked_state(doc: &mut BaseDocument, node: NodeId, on: bool) {
    doc.snapshot_node_and(node, style_dom::ElementState::CHECKED, |n| {
        if let Some(el) = n.element_data_mut() {
            el.set_checkbox_input_checked(on);
        }
        n.mark_ancestors_dirty();
    });
}

fn is_disabled_control(doc: &BaseDocument, id: NodeId) -> bool {
    matches!(
        tag(doc, id),
        Some("button" | "input" | "textarea" | "select")
    ) && crate::forms::disabled(doc, id)
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

/// Boundary events target an element, even when hit testing returns its text.
fn boundary_target(doc: &BaseDocument, id: Option<NodeId>) -> Option<NodeId> {
    let id = doc.nearest_non_anonymous_ancestor(id?)?;
    let id = Some(id).filter(|&id| doc.get_node(id).is_some_and(|n| n.flags.is_in_document()))?;
    chain_of(doc, id).first().copied()
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

/// A URL fragment percent-decoded as UTF-8 (lossy), as the HTML standard
/// decodes it to find the element a fragment names.
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(h), Some(l)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push((h * 16 + l) as u8);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether an `<a name>` element has the name `name` (a fragment target).
fn named_anchor(doc: &BaseDocument, name: &str) -> bool {
    tree_order(doc).into_iter().any(|n| {
        tag(doc, n) == Some("a")
            && doc.get_node(n).and_then(|e| e.attr("name".into())) == Some(name)
    })
}

/// A link: an `<a>` with an `href`.
fn is_link(doc: &BaseDocument, id: NodeId) -> bool {
    tag(doc, id) == Some("a")
        && doc
            .get_node(id)
            .is_some_and(|n| n.attr("href".into()).is_some())
}

/// The link a click on `chain` (target first) follows: the innermost one.
fn link_of(doc: &BaseDocument, chain: &[NodeId]) -> Option<NodeId> {
    chain.iter().copied().find(|&n| is_link(doc, n))
}

/// Focusable by the mouse and by script: an enabled control, a link or an
/// element with a `tabindex`.
pub(crate) fn is_focusable_element(doc: &BaseDocument, id: NodeId) -> bool {
    (is_control(doc, id) || is_link(doc, id) || tab_index(doc, id).is_some())
        && !is_disabled_control(doc, id)
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

pub(crate) fn inside_disabled(doc: &BaseDocument, chain: &[NodeId]) -> bool {
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

/// A mouse button event's data with its `detail`: the click count of
/// main button presses (one for a press of another button).
fn counted(p: &BlitzPointerEvent, clicks: u32) -> EventData {
    let mut d = pointer_data(p);
    d.detail = if p.button == MouseEventButton::Main {
        clicks as f64
    } else {
        1.0
    };
    d
}

/// A key event's data at `target` (`isComposing`: the target is a text
/// control composing; Blitz's own flag is never set).
fn key_data(k: &BlitzKeyEvent, doc: &BaseDocument, target: Option<NodeId>) -> EventData {
    let mut d = EventData {
        key: k.key.to_string().as_str().into(),
        code: k.code.to_string().as_str().into(),
        repeat: k.is_auto_repeating,
        composing: target.is_some_and(|t| controls::composing(doc, t)),
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
        // (A bubbling event reaches every ancestor of its target, also where
        // the caller passed the target alone: a typed character's `input`.)
        let full = element_chain(doc, target);
        let path = if kind.bubbles() {
            &full[..]
        } else {
            &full[..1]
        };
        // The elements' capture listeners first, from the root to the
        // target (M6 overlays: along the target's ancestors also for events
        // that do not bubble, such as focus), then the target's and the
        // ancestors'.
        let chain = element_chain(doc, elements[0]);
        if let Some(why) = self.listeners.order_conflict(&chain, kind) {
            crate::unsupported(&why);
        }
        let mut deliveries: Vec<Delivery> = self.listeners.capture_deliveries(&chain, kind, &event);
        // (The bubbling phase in the framework's order where it declares its
        // delegation: `Listeners::bubble_stage`.)
        let mut from = 0;
        for i in 0..path.len() {
            let (stage, next) = self
                .listeners
                .bubble_stage(doc, path, i, from, kind, &event);
            deliveries.extend(stage);
            from = next;
        }
        // The capture listeners of the window, then the document, first.
        self.capture(doc, kind, &event, true);
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
            self.capture(doc, Event::Scroll, &event, true);
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
    /// The capture listeners of the window, then (`document`) the
    /// document's, each a callback of its own (M6 overlays).
    fn capture(
        &mut self,
        doc: &mut BaseDocument,
        kind: Event,
        event: &runic_js::Event,
        document: bool,
    ) {
        for window in [true, false] {
            if !window && !document {
                continue;
            }
            // A new target/phase invocation is skipped after propagation was
            // stopped. Remaining listeners within the current invocation still
            // run unless stopImmediatePropagation was used.
            if kind == Event::Submit && event.propagation_stopped() {
                break;
            }
            let current = if window {
                Element::WINDOW
            } else {
                Element::DOCUMENT
            };
            let listeners: Vec<_> = self
                .app
                .capture_listeners(window, kind)
                .into_iter()
                .map(|listener| (listener, self.app.listener_generation(listener)))
                .collect();
            for (listener, generation) in listeners {
                if self.app.listener_generation(listener) != generation
                    || !self.app.capture_listeners(window, kind).contains(&listener)
                    || !event.can_enter(current)
                {
                    continue;
                }
                let delivery = Delivery {
                    listener,
                    event: event.clone(),
                    current: current.0,
                    delegated: None,
                    joined: false,
                };
                self.dispatch(doc, &[delivery]);
            }
        }
    }

    fn host(&mut self, doc: &mut BaseDocument, kind: Event, event: &runic_js::Event) {
        for window in [false, true] {
            if kind == Event::Submit && event.propagation_stopped() {
                break;
            }
            let current = if window {
                Element::WINDOW
            } else {
                Element::DOCUMENT
            };
            let listeners: Vec<_> = self
                .app
                .host_listeners(window, kind)
                .into_iter()
                .map(|listener| (listener, self.app.listener_generation(listener)))
                .collect();
            for (listener, generation) in listeners {
                if self.app.listener_generation(listener) != generation
                    || !self.app.host_listeners(window, kind).contains(&listener)
                    || !event.can_enter(current)
                {
                    continue;
                }
                let delivery = Delivery {
                    listener,
                    event: event.clone(),
                    current: current.0,
                    delegated: None,
                    joined: false,
                };
                self.dispatch(doc, &[delivery]);
            }
        }
    }

    /// Follow a link after its click (the click's default action): a
    /// fragment navigation (`popstate` at once, `hashchange` as a task when
    /// the fragment changed), scrolling to the element the fragment names
    /// or to the top of the document. Named anchors (`<a name>`) and links
    /// to other documents are unsupported.
    fn follow_link(&mut self, doc: &mut BaseDocument, link: NodeId) {
        let Some(href) = doc
            .get_node(link)
            .and_then(|n| n.attr("href".into()))
            .map(str::to_owned)
        else {
            return;
        };
        if let Some(name) = href.strip_prefix('#') {
            let decoded = percent_decode(name);
            // The HTML standard's "find a potential indicated element": an
            // empty fragment is the top of the document; otherwise the
            // element of that id, else an `<a>` of that name, else, for
            // "top" (ASCII case-insensitive), the top of the document.
            let top = decoded.is_empty()
                || (decoded.eq_ignore_ascii_case("top")
                    && doc.get_element_by_id(&decoded).is_none()
                    && !named_anchor(doc, &decoded));
            if top {
                // Chromium's ElementFragmentAnchor with the document as its
                // anchor: the document element scrolled into view (block
                // start, inline nearest), and no focus change (`needs_focus_`
                // is false for the document node).
                match crate::history::follow_fragment(&href.as_str().into()) {
                    Ok(changed) => {
                        self.window(doc, Event::Popstate);
                        if let Some(root) = doc.try_root_element().map(|r| r.id) {
                            for moved in
                                crate::layout::scroll_into_view(doc, root, "start", "nearest")
                            {
                                self.listeners.scrolled(Some(moved));
                            }
                        }
                        if changed {
                            self.app.hashchange();
                        }
                    }
                    Err(e) => crate::unsupported(&e.message.to_rust()),
                }
                return;
            }
            if named_anchor(doc, &decoded) && doc.get_element_by_id(&decoded).is_none() {
                crate::unsupported(&format!(
                    "following the link {href:?} to a named anchor (<a name>)"
                ));
                return;
            }
            // A fragment naming an element (M6, SvelteKit's table of contents):
            // the history entry and popstate, then the HTML standard's "scroll
            // to the fragment" (scrollIntoView with block start and inline
            // nearest; the element becomes the sequential focus navigation
            // starting point), then hashchange as a task.
            if let Some(target) = doc.get_element_by_id(&decoded) {
                match crate::history::follow_fragment(&href.as_str().into()) {
                    Ok(changed) => {
                        self.window(doc, Event::Popstate);
                        for moved in
                            crate::layout::scroll_into_view(doc, target, "start", "nearest")
                        {
                            self.listeners.scrolled(Some(moved));
                        }
                        // Chromium's ElementFragmentAnchor: a focusable target is
                        // focused; otherwise focus is cleared and the target
                        // becomes the navigation starting point.
                        if is_focusable_element(doc, target) {
                            self.move_focus(doc, Some(target));
                        } else {
                            self.move_focus(doc, None);
                            *self.nav_start = Some(target);
                        }
                        if changed {
                            self.app.hashchange();
                        }
                    }
                    Err(e) => crate::unsupported(&e.message.to_rust()),
                }
                return;
            }
        }
        match crate::history::follow_fragment(&href.as_str().into()) {
            Ok(changed) => {
                self.window(doc, Event::Popstate);
                if changed {
                    self.app.hashchange();
                }
            }
            Err(e) => crate::unsupported(&e.message.to_rust()),
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
        self.capture(doc, kind, &event, false);
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
        // A focus reset (the router) starts the navigation at the document start.
        if let Some(start) = self.listeners.set_navigation.take() {
            *self.nav_start = start;
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
        self.listeners.sync_focus_visible(doc);
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

    /// Submit with the same owned session and guard as requestSubmit. Host
    /// capture and bubble listeners use the existing event dispatch machinery.
    fn submit(&mut self, doc: &mut BaseDocument, form: NodeId, submitter: Option<NodeId>) {
        let Some(submission) = crate::forms::begin(doc, self.listeners, form, submitter) else {
            return;
        };
        let path: Vec<_> = element_chain(doc, form)
            .into_iter()
            .map(NodeId::as_u64)
            .collect();
        self.capture(doc, Event::Submit, &submission.event, true);
        let outcome = if submission.event.propagation_stopped() {
            "submit propagation stopped during capture".to_owned()
        } else {
            let mut dom = Dom {
                doc,
                listeners: self.listeners,
            };
            match self
                .app
                .dispatch_element_path(&mut dom, &path, Event::Submit, &submission.event)
            {
                Ok(()) => "submit element path".to_owned(),
                Err(reason) => format!("submit element path rejected: {reason}"),
            }
        };
        if let Some(blurred) = self.listeners.blurred.take() {
            *self.nav_start = Some(blurred);
        }
        if let Some(start) = self.listeners.set_navigation.take() {
            *self.nav_start = start;
        }
        self.log.push(outcome);
        self.host(doc, Event::Submit, &submission.event);
        submission.event.finish();
        crate::forms::complete(doc, self.listeners, form, &submission.event);
    }

    /// Re-resolve the clicked control's live type, disabled state and owner
    /// after its listeners. Invalid explicit owners never fall back to ancestry.
    fn activate_form_control(&mut self, doc: &mut BaseDocument, id: Option<NodeId>) -> bool {
        let Some(id) = id.filter(|&id| {
            doc.get_node(id)
                .is_some_and(|node| node.flags.is_in_document())
        }) else {
            return false;
        };
        let Some(control) = crate::forms::control(doc, id) else {
            return false;
        };
        use runic_js::forms::Activation;
        let activation = control.activation();
        if activation == Activation::None {
            return false;
        }
        if control.disabled {
            return true;
        }
        if activation == Activation::UnsupportedCommand {
            crate::unsupported("Auto button command or customizable-select activation");
            return true;
        }
        let Some(form) = crate::forms::owner(doc, id) else {
            return false;
        };
        match activation {
            Activation::Submit => self.submit(doc, form, Some(id)),
            Activation::Reset => crate::unsupported("form reset (a control's default action)"),
            Activation::None | Activation::UnsupportedCommand => unreachable!(),
        }
        true
    }

    /// The default button receives a real synthesized click (detail zero);
    /// only its uncanceled, current activation can begin submission.
    fn implicit_submit(&mut self, doc: &mut BaseDocument, form: NodeId) {
        use runic_js::forms::Implicit;
        match runic_js::forms::implicit_submission(&crate::forms::controls(doc, form)) {
            Implicit::Nothing => {}
            Implicit::Click(id) => {
                let id = NodeId::from_u64(id);
                let chain = chain_of(doc, id);
                let event = self.click(doc, &chain, EventData::default());
                if event.is_some() && !Self::cancelled(&event) {
                    self.activate_form_control(doc, Some(id));
                }
            }
            Implicit::Submit => self.submit(doc, form, None),
        }
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
                        delegated: None,
                        joined: false,
                    });
                }
            }
            for listener in self.listeners.all(id, Event::Change) {
                deliveries.push(Delivery {
                    listener,
                    event: change.clone(),
                    current: id.as_u64(),
                    delegated: None,
                    joined: false,
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
    /// events (`out` at the old target, leaving innermost first, `over` at
    /// the new target, entering outermost first), then mouse events.
    /// Elements no longer in the document get none.
    fn boundary(&mut self, doc: &mut BaseDocument, p: &BlitzPointerEvent, button_changed: bool) {
        let mut left = std::mem::take(&mut self.pointer.left);
        left.reverse();
        let entered = std::mem::take(&mut self.pointer.entered);
        let out = boundary_target(doc, self.pointer.out.take());
        let over = boundary_target(doc, self.pointer.over.take());
        let moved = out != over;
        let live = |doc: &BaseDocument, n: NodeId| {
            is_element(doc, n) && doc.get_node(n).is_some_and(|n| n.flags.is_in_document())
        };
        let data = |related: Option<NodeId>, pointer: bool| EventData {
            related: related.map(|n| Element(n.as_u64())),
            button: if pointer && !button_changed {
                -1.
            } else {
                p.button as u8 as f64
            },
            ..pointer_data(p)
        };
        let mouse = p.is_mouse();
        for (out_kind, leave, over_kind, enter) in [
            (
                Event::Pointerout,
                Event::Pointerleave,
                Event::Pointerover,
                Event::Pointerenter,
            ),
            (
                Event::Mouseout,
                Event::Mouseleave,
                Event::Mouseover,
                Event::Mouseenter,
            ),
        ] {
            if leave == Event::Mouseleave && !mouse {
                break;
            }
            let pointer = leave == Event::Pointerleave;
            if let Some(n) = out.filter(|&n| moved && live(doc, n)) {
                let chain = chain_of(doc, n);
                self.fire(doc, &chain, out_kind, data(over, pointer));
            }
            for &n in &left {
                if live(doc, n) {
                    self.fire(doc, &[n], leave, data(over, pointer));
                }
            }
            if let Some(n) = over.filter(|&n| moved && live(doc, n)) {
                let chain = chain_of(doc, n);
                self.fire(doc, &chain, over_kind, data(out, pointer));
            }
            for &n in &entered {
                if live(doc, n) {
                    self.fire(doc, &[n], enter, data(out, pointer));
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
    /// A focused element that became disabled keeps focus until the
    /// rendering step's focus fixup (`Native::rendering_step`).
    fn fix_focus(&mut self, doc: &mut BaseDocument) {
        let _ = doc;
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
        // A key confirming IME composition must keep the editor's default,
        // even if a keydown callback changes focus or composition state.
        let composing_key = matches!(&event.data, DomEventData::KeyDown(k)
            if k.is_composing || focused_element(doc).is_some_and(|id| controls::composing(doc, id)));
        match &event.data {
            // Boundary events wait for the move that caused them; Blitz's
            // mouse boundary events are not delivered (Chromium's order is
            // rebuilt from the pointer's).
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
            DomEventData::PointerOut(_) => {
                self.pointer.out = Some(event.target);
                return;
            }
            DomEventData::PointerOver(_) => {
                self.pointer.over = Some(event.target);
                return;
            }
            DomEventData::MouseOver(_)
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
        // Input modality for `:focus-visible`: a key down sets it before its
        // listeners run, also when they cancel it (Blink's keyboard event
        // manager; bits-ui cancels Space and Enter on its buttons).
        if let DomEventData::KeyDown(_) = &event.data {
            self.listeners.had_keyboard_event = true;
            self.listeners.sync_focus_visible(doc);
        }
        // Keydown listeners (target first, bubbling) run before default
        // actions; a cancelled keydown has none (no text insertion,
        // activation or focus navigation).
        if let DomEventData::KeyDown(k) = &event.data {
            let e = self.fire(
                doc,
                chain,
                Event::Keydown,
                key_data(k, doc, chain.first().copied()),
            );
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
        // Supported single-line inputs use the shared implicit-submission
        // decision after keydown listeners. Broader editor domains stay explicit.
        if let DomEventData::KeyDown(k) = &event.data {
            if k.key == Key::Enter
                && !composing_key
                && let Some(input) =
                    focused_element(doc).filter(|&id| tag(doc, id) == Some("input"))
                && let Some(form) = crate::forms::owner(doc, input)
                && let Some(control) = crate::forms::control(doc, input)
            {
                if control.enter_trigger() {
                    state.prevent_default();
                    if !control.disabled {
                        self.implicit_submit(doc, form);
                    }
                    self.fix_focus(doc);
                    doc.shell_provider.request_redraw();
                    return;
                }
                if control.blocks_implicit() || controls::has_editor(doc, input) {
                    state.prevent_default();
                    crate::unsupported("form submission (Enter in an unsupported input domain)");
                    self.fix_focus(doc);
                    doc.shell_provider.request_redraw();
                    return;
                }
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
        // Input modality for `:focus-visible` (Blink: any key down sets it,
        // above; a mouse press clears it).
        match &event.data {
            DomEventData::MouseDown(_) => {
                self.listeners.had_keyboard_event = false;
                self.listeners.sync_focus_visible(doc);
            }
            _ => {}
        }
        let focused_button = focused.filter(|&f| crate::forms::button_like(doc, f));
        let focused_link = focused.filter(|&f| is_link(doc, f));
        let focused_checkbox = focused.filter(|&f| is_checkbox(doc, f));
        match &event.data {
            DomEventData::PointerMove(p) => {
                self.boundary(doc, p, false);
                let data = EventData {
                    button: -1.,
                    ..pointer_data(p)
                };
                self.fire(doc, chain, Event::Pointermove, data);
            }
            DomEventData::PointerDown(p) => {
                self.boundary(doc, p, true);
                self.pointer.suppress_mouse = false;
                // Cancelling pointerdown suppresses the mouse events up to
                // mouseup and mousedown's default actions (focus stays:
                // Chromium 153, bits-ui's Select items).
                let e = self.fire(doc, chain, Event::Pointerdown, pointer_data(p));
                self.pointer.suppress_mouse = Self::cancelled(&e);
            }
            DomEventData::PointerUp(p) => {
                self.pointer.closed_popup = false;
                self.boundary(doc, p, true);
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
                    self.fire(doc, chain, Event::Mouseup, counted(p, self.pointer.clicks));
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
                    self.fire(
                        doc,
                        chain,
                        Event::Mousedown,
                        counted(p, self.pointer.clicks),
                    )
                };
                if Self::cancelled(&e) || self.pointer.suppress_mouse {
                    // Focus stays where it is (the menu and popover pattern).
                    state.prevent_default();
                } else {
                    // Focus moves on mousedown: to the clicked button, nowhere
                    // for non-focusable targets (including disabled
                    // controls). Text inputs keep Blitz's default (focus and
                    // caret placement).
                    *self.nav_start = chain.first().copied();
                    let candidate = chain.iter().copied().find(|&n| {
                        is_control(doc, n) || is_link(doc, n) || tab_index(doc, n).is_some()
                    });
                    let next = candidate.filter(|&c| !is_disabled_control(doc, c));
                    // Text controls then get Blitz's caret placement.
                    if next != focused {
                        self.listeners.mouse_focus = true;
                    }
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
                self.activate_checkbox(doc, chain[0], counted(p, count));
                if count == 2 && !inside_disabled(doc, chain) {
                    self.fire(doc, chain, Event::Dblclick, counted(p, 2));
                }
            }
            DomEventData::Click(p) => {
                let count = self.pointer.clicks;
                // Activation belongs to the original innermost control,
                // even if its listeners remove it or change its ownership.
                let form_control = chain.iter().copied().find(|&id| {
                    crate::forms::control(doc, id)
                        .is_some_and(|control| matches!(control.tag.as_str(), "button" | "input"))
                });
                let e = self.click(doc, chain, counted(p, count));
                // Focus moved on mousedown; Blitz's default click action would
                // clear it again without focus events. The click's default
                // actions of the supported elements are done here (checkboxes
                // and labels).
                state.prevent_default();
                if e.is_some()
                    && !Self::cancelled(&e)
                    && !self.activate_form_control(doc, form_control)
                {
                    if let Some(link) = link_of(doc, chain) {
                        self.follow_link(doc, link);
                    } else if let Some(control) = labelled_control(doc, chain) {
                        // Label activation is done here, as Chromium does it: a
                        // simulated click on checkboxes and buttons, then focus.
                        state.prevent_default();
                        if !is_disabled_control(doc, control) {
                            if is_checkbox(doc, control) {
                                self.activate_checkbox(doc, control, EventData::default());
                            } else if crate::forms::button_like(doc, control) {
                                let chain = chain_of(doc, control);
                                let e = self.click(doc, &chain, EventData::default());
                                if e.is_some() && !Self::cancelled(&e) {
                                    self.activate_form_control(doc, Some(control));
                                }
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
                    self.fire(doc, chain, Event::Dblclick, counted(p, 2));
                }
            }
            DomEventData::KeyDown(k) if k.key == Key::Tab => {
                state.prevent_default();
                *self.space_target = None;
                let backwards = k.modifiers.contains(Modifiers::SHIFT);
                let next = sequential(doc, focused.or(*self.nav_start), backwards);
                *self.nav_start = None;
                self.listeners.mouse_focus = false;
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
                let e = self.click(doc, &chain, EventData::default());
                if e.is_some() && !Self::cancelled(&e) {
                    self.activate_form_control(doc, Some(button));
                }
            }
            DomEventData::KeyDown(k) if focused_link.is_some() && k.key == Key::Enter => {
                // Enter on a focused link: a simulated click, whose default
                // action follows the link.
                state.prevent_default();
                let link = focused_link.unwrap();
                let chain = chain_of(doc, link);
                let e = self.click(doc, &chain, EventData::default());
                if e.is_some() && !Self::cancelled(&e) {
                    self.follow_link(doc, link);
                }
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
                let e = self.fire(
                    doc,
                    chain,
                    Event::Keyup,
                    key_data(k, doc, chain.first().copied()),
                );
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
                            let e = self.click(doc, &chain, EventData::default());
                            if e.is_some() && !Self::cancelled(&e) {
                                self.activate_form_control(doc, Some(target));
                            }
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

#[cfg(test)]
mod boundary_tests {
    use super::*;
    use blitz_dom::DocumentConfig;

    #[test]
    fn text_and_padding_share_live_element_boundary_targets() {
        let mut doc = BaseDocument::new(DocumentConfig::default());
        let mut listeners = Listeners::default();
        let mut dom = Dom {
            doc: &mut doc,
            listeners: &mut listeners,
        };
        let root = dom.doc.root_node().id;
        let html = dom.element("html");
        let body = dom.element("body");
        dom.append(root, html);
        dom.append(html, body);
        let a = dom.element("div");
        let b = dom.element("div");
        dom.append(body, a);
        dom.append(body, b);
        let first = dom.text("Alpha");
        let second = dom.text("Omega");
        dom.append(a, first);
        dom.append(a, second);
        let detached = dom.element("div");
        assert_eq!(boundary_target(dom.doc, Some(first)), Some(a));
        assert_eq!(boundary_target(dom.doc, Some(second)), Some(a));
        assert_eq!(boundary_target(dom.doc, Some(a)), Some(a));
        assert_eq!(boundary_target(dom.doc, Some(b)), Some(b));
        assert_eq!(boundary_target(dom.doc, None), None);
        assert_eq!(boundary_target(dom.doc, Some(detached)), None);
        dom.remove(a);
        assert_eq!(boundary_target(dom.doc, Some(first)), None);
        assert_eq!(boundary_target(dom.doc, Some(a)), None);
        assert_eq!(boundary_target(dom.doc, Some(b)), Some(b));
    }
}
