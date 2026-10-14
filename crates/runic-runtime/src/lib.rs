//! Native runtime for generated Runic applications.
//!
//! Generated code implements [`App`]; the runtime owns the Blitz document, the
//! window, event delivery with browser DOM semantics (activation, focus,
//! controlled text inputs) and, behind the `probe` feature, scripted input and
//! DOM snapshots for conformance runs.

mod animation_events;
mod animations;
pub mod clipboard;
pub mod console;
mod controls;
pub mod desktop;
mod dom;
mod effects;
mod events;
pub mod floating;
mod forms;
pub mod history;
pub mod images;
mod jobs;
mod layout;
#[cfg(feature = "probe")]
mod probe;
pub mod promises;
mod random;
pub use runic_js::reorder;
mod scroll_driven;
mod select;
mod shell;
mod storage;
mod tabbable;
mod timeline;
mod timers;

pub use blitz_traits::node_id::NodeId;
pub use dom::{ClassState, Dom, Event, FragmentNode, Host, HtmlFragment, Spread};
pub use forms::Submission;
pub use random::Random;

/// Whether this process runs as a conformance probe (host services keep
/// their state in memory, seeded by the case).
pub(crate) fn probe_mode() -> bool {
    #[cfg(feature = "probe")]
    {
        probe::active()
    }
    #[cfg(not(feature = "probe"))]
    {
        false
    }
}

/// A runtime shape the host-service model does not cover (a history
/// traversal to a document before a reload): probes stop, so that
/// conformance cannot pass on it; apps report it.
pub fn unsupported(what: &str) {
    if probe_mode() {
        panic!("unsupported: {what}");
    }
    eprintln!("runic: unsupported: {what}");
}

/// What the heap could not reproduce: an array stored in `$state` changed in
/// place other than through its proxy (docs/design/REACTIVITY-ALIASING.md, R3).
pub fn heap_reports() {
    if let Some(what) = runic_js::take_heap_unsupported() {
        unsupported(&what);
    }
}

/// A reaction added to a promise whose rejection the console already
/// reported as unhandled: Chromium revokes the report, which console lines
/// do not model.
pub fn late_rejection_handlers() {
    if let Some(t) = runic_js::take_late_handled() {
        unsupported(&format!(
            "a handler added to a promise after its rejection ({t}) was reported as unhandled"
        ));
    }
}

/// Reports a `RunicUnsupportedError` a runic-js built-in returns (a value
/// outside its verified data, such as an Intl locale) before it is thrown.
pub fn reported<T>(r: runic_js::JsResult<T>) -> runic_js::JsResult<T> {
    if let Err(t) = &r {
        if t.name.to_rust() == "RunicUnsupportedError" {
            unsupported(&t.message.to_rust());
        }
    }
    r
}
thread_local! {
    static RENDER_ERRORS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// A throw while rendering (a duplicate key in a keyed list): reported, and
/// in probes kept for the next snapshot, as the reference interpreter's
/// snapshot is then the error (the differential compares the two).
pub fn render_error(e: &runic_js::Throw) {
    eprintln!("runic: render error: {e}");
    if probe_mode() {
        RENDER_ERRORS.with(|r| r.borrow_mut().push(e.to_string()));
    }
}

#[cfg(feature = "probe")]
pub(crate) fn take_render_errors() -> Vec<String> {
    RENDER_ERRORS.with(|r| std::mem::take(&mut *r.borrow_mut()))
}

/// CSSOM inline styles, media queries and the document element.
pub use runic_css as css;

thread_local! {
    static MEDIA: std::cell::Cell<css::MediaEnv> = std::cell::Cell::new(css::MediaEnv::default());
}

/// The viewport media queries see (set by the shell before the app starts).
pub(crate) fn set_media_viewport(width: f64, height: f64) {
    MEDIA.with(|m| {
        m.set(css::MediaEnv {
            width,
            height,
            ..m.get()
        })
    });
}

/// The viewport and user preferences changed (the shell or probe actions).
pub(crate) fn set_media_env(env: css::MediaEnv) {
    MEDIA.with(|m| m.set(env));
}

thread_local! {
    static DESKTOP_QUERIES_REPORTED: std::cell::RefCell<Vec<String>> =
        const { std::cell::RefCell::new(Vec::new()) };
}

/// `matchMedia(query).matches` (generated code). Chromium 153 on Linux takes
/// `prefers-reduced-motion` and `prefers-contrast` from the desktop
/// ([`desktop`]): natively a query testing one the runtime cannot read there
/// is reported once; probes answer it as their actions emulate the
/// preference.
pub fn media_matches(query: &str, env: &css::MediaEnv) -> Option<bool> {
    if !probe_mode() {
        let lower = query.to_ascii_lowercase();
        let prefs = desktop::current();
        let unread = ["prefers-reduced-motion", "prefers-contrast"]
            .into_iter()
            .filter(|f| lower.contains(f))
            .find_map(|f| prefs.feature(f).and_then(Result::err));
        if let Some(reason) = unread
            && DESKTOP_QUERIES_REPORTED.with(|r| {
                let mut r = r.borrow_mut();
                let first = !r.contains(&lower);
                if first {
                    r.push(lower.clone());
                }
                first
            })
        {
            unsupported(&format!(
                "matchMedia({query:?}) tests a desktop preference the runtime cannot read: {reason}"
            ));
        }
    }
    css::media_matches(query, env)
}

/// The media environment natively with the desktop preferences as last read
/// (no preference where unknown).
pub(crate) fn with_desktop_preferences(env: css::MediaEnv) -> css::MediaEnv {
    let prefs = desktop::current();
    css::MediaEnv {
        reduced_motion: prefs.reduced_motion.unwrap_or(false),
        contrast_more: prefs.contrast_more.unwrap_or(false),
        ..env
    }
}

/// The user preferences of `env` as Blitz's media queries see them
/// (`prefers-reduced-motion`, `prefers-contrast`; the color scheme is part
/// of the viewport).
pub(crate) fn media_preferences(env: &css::MediaEnv) -> blitz_dom::MediaPreferences {
    blitz_dom::MediaPreferences {
        reduced_motion: if env.reduced_motion {
            blitz_dom::PrefersReducedMotion::Reduce
        } else {
            blitz_dom::PrefersReducedMotion::NoPreference
        },
        contrast: if env.contrast_more {
            blitz_dom::PrefersContrast::More
        } else {
            blitz_dom::PrefersContrast::NoPreference
        },
    }
}

/// What media queries see: the viewport and the user preferences (light,
/// no contrast or motion preference, as the probe emulates them).
pub fn media_env() -> css::MediaEnv {
    MEDIA.with(|m| m.get())
}
pub use jobs::{CellVersions, Dep, Derived, Fx, Job, Jobs, Phase, Versions, self_invalidated};
pub use promises::Microtasks;
pub use serde_json::Value as Json;
pub use storage::{Storage, seed as seed_storage};
pub use timers::{CLOCK_ORIGIN, CLOCK_START, TimerKind, Timers, clock_origin};

/// JavaScript value semantics shared with the reference interpreter.
pub mod js {
    pub use runic_js::*;

    /// JSON view of a cell value for probes (non-finite numbers as strings).
    pub trait ToJson {
        fn to_json(&self) -> serde_json::Value;
    }
    impl ToJson for f64 {
        fn to_json(&self) -> serde_json::Value {
            if self.is_finite() {
                serde_json::json!(self)
            } else {
                serde_json::json!(number_to_string(*self))
            }
        }
    }
    impl ToJson for bool {
        fn to_json(&self) -> serde_json::Value {
            serde_json::json!(self)
        }
    }
    impl ToJson for String {
        fn to_json(&self) -> serde_json::Value {
            serde_json::json!(self)
        }
    }
    pub fn json<T: ToJson>(v: &T) -> serde_json::Value {
        v.to_json()
    }
}

/// Probe JSON of a dynamic value (M6 spike; matches the interpreter's
/// `cell_json`): primitives as themselves, objects as `{"object": [[key,
/// value], ...]}` in property order, arrays as arrays, functions and boxed
/// static values by kind.
pub fn probe_dyn(v: &js::Dyn) -> Json {
    use js::Dyn;
    // (A value that contains itself shows as "[Circular]", as cell probes do.)
    match v {
        Dyn::Undefined | Dyn::Null => Json::Null,
        Dyn::Bool(b) => Json::Bool(*b),
        Dyn::Num(n) => js::json(n),
        Dyn::Str(s) => Json::String(s.to_rust()),
        Dyn::Object(o) => match o.visit() {
            None => Json::String("[Circular]".into()),
            Some(_v) => serde_json::json!({ "object": o
                .borrow()
                .iter()
                .map(|(k, x)| serde_json::json!([k.to_rust(), probe_dyn(x)]))
                .collect::<Vec<_>>() }),
        },
        Dyn::Array(a) => match a.visit() {
            None => Json::String("[Circular]".into()),
            Some(_v) => Json::Array(a.borrow().iter().map(probe_dyn).collect()),
        },
        Dyn::Fn(..) => Json::String("function".into()),
        Dyn::Boxed(b) => Json::String(format!("boxed {}", b.kind_name())),
    }
}

/// One listener call of an event dispatch: the listener key, the event and
/// the element whose listener it is (`currentTarget`, a node id).
pub struct Delivery {
    pub listener: u32,
    pub event: runic_js::Event,
    pub current: u64,
    /// A template listener the framework runs from a delegation root
    /// (IR `schedule.delegation`): the root and whether it is the first of
    /// the root's group (`Event::enter_delegated`).
    pub delegated: Option<(u64, bool)>,
    /// Part of the previous delivery's callback (a delegation root's
    /// group, a framework listener starting the delegated propagation).
    pub joined: bool,
}

/// A generated application.
pub trait App: 'static {
    const TITLE: &'static str;
    /// Stylesheet; embedded assets are referenced as `runic-asset:N`.
    const CSS: &'static str;
    /// `(mime, bytes)` of each embedded asset.
    const ASSETS: &'static [(&'static str, &'static [u8])];
    /// `(selector, unless, when, message)` of declarations the style engine
    /// drops: each is reported as unsupported once its selector matches an
    /// element that `unless` (where not empty: the rules overriding the
    /// declaration) does not match; with `when` `"scroll-target"`, once such
    /// an element is scrolled into view; with `"scroll-container:…"`, once a
    /// target inside one is scrolled where the padding would move it; with
    /// `"desktop:<features>"`, natively where the desktop preference a rule
    /// tests cannot be read (`desktop`).
    const STYLE_GUARDS: &'static [(&'static str, &'static str, &'static str, &'static str)] = &[];
    const IR_HASH: &'static str;
    /// Attributes of `<body>` (from the app's HTML template, M6).
    const BODY_ATTRS: &'static [(&'static str, &'static str)] = &[];
    /// Attributes of the element the app mounts in (the HTML template's
    /// container, M6); `None` for `<div id="root">`.
    const CONTAINER_ATTRS: Option<&'static [(&'static str, &'static str)]> = None;
    /// The pinned image URLs, sorted by URL (`images::find`; M6).
    const IMAGES: &'static [images::PinnedImage] = &[];

    fn new() -> Self;
    /// Build the initial DOM under `parent` and register listeners.
    fn mount(&mut self, dom: &mut Dom, parent: NodeId);
    /// A checkbox's `change` listener runs in the `click` dispatch.
    const CHANGE_WITH_CLICK: bool = false;
    /// The kinds whose template listeners the framework runs from a
    /// delegation root (IR `schedule.delegation`; None: not declared).
    const DELEGATION: Option<&'static [Event]> = None;
    /// The framework's template listeners are native listeners of their
    /// elements in registration order (IR `schedule.elementListeners`).
    const ELEMENT_LISTENERS: bool = false;
    /// Dispatch one event: run its listeners in order (each unless the event's
    /// propagation was stopped) with the framework's microtask checkpoints,
    /// then the jobs they queued (which update the DOM). On a text-domain
    /// error the task's writes are rolled back and controlled inputs are
    /// re-synchronised.
    fn dispatch(&mut self, dom: &mut Dom, deliveries: &[Delivery]) -> Result<(), String>;
    /// Identity of a listener registration occupying a reusable slot. Physical
    /// host dispatch snapshots this before callbacks can remove/reuse the slot.
    fn listener_generation(&self, listener: u32) -> u64 {
        let _ = listener;
        0
    }
    /// Deliver one physical event over its frozen element path, consulting
    /// registrations when each target/phase is reached. Generated apps retain
    /// their schedule's event-versus-listener checkpoints here.
    fn dispatch_element_path(
        &mut self,
        dom: &mut Dom,
        path: &[u64],
        kind: Event,
        event: &runic_js::Event,
    ) -> Result<(), String> {
        let _ = (dom, path, kind, event);
        unsupported("physical element-path dispatch in an app without a generated dispatcher");
        Err("physical element-path dispatch requires a generated dispatcher".into())
    }
    /// Listener keys of the document (`window: false`) or the window for
    /// `event`, in registration order.
    fn host_listeners(&self, window: bool, event: Event) -> Vec<u32> {
        let _ = (window, event);
        Vec::new()
    }
    /// Capture listener keys of the document (`window: false`) or the
    /// window for `event` (M6 overlays), in registration order.
    fn capture_listeners(&self, window: bool, event: Event) -> Vec<u32> {
        let _ = (window, event);
        Vec::new()
    }
    /// Listener keys of the visual viewport for `event` (M6 overlays), in
    /// registration order.
    fn viewport_listeners(&self, event: Event) -> Vec<u32> {
        let _ = event;
        Vec::new()
    }
    fn cells_json(&self) -> Json;
    /// Cells of every other live component instance in tree order, as
    /// `{ "component": name, "cells": [...] }`.
    fn instances_json(&self) -> Vec<Json> {
        Vec::new()
    }
    /// Run every timer and animation frame due at or before clock time `to`
    /// (milliseconds), each as a task followed by a DOM update; the clock then
    /// stands at `to`.
    fn advance(&mut self, dom: &mut Dom, to: f64) {
        let _ = (dom, to);
    }
    /// The media environment changed (viewport size or user preferences):
    /// refresh what queries see, and give the `change` events due, oldest
    /// media query list first, each with its listener keys.
    fn media_changed(&mut self) -> Vec<(runic_js::Event, Vec<u32>)> {
        Vec::new()
    }
    /// Whether animation frame callbacks wait for the window's next frame
    /// (apps; probes run them as timers on the virtual clock).
    fn has_frame_callbacks(&self) -> bool {
        false
    }
    /// Whether animation frame callbacks are due by clock time `now` (apps).
    fn frames_due(&self, now: f64) -> bool {
        let _ = now;
        false
    }
    /// The window's frame starts at clock time `now` (apps): callbacks
    /// requested before its callbacks run (by its animation events) are due
    /// in it.
    fn frame_starts(&mut self, now: f64) {
        let _ = now;
    }
    /// The window's frame (apps): run the animation frame callbacks due,
    /// each a task, with the frame's clock time `now` as argument.
    fn frame_callbacks(&mut self, dom: &mut Dom, now: f64) {
        let _ = (dom, now);
    }
    /// Clock time of the next timer.
    fn next_timer(&self) -> Option<f64> {
        None
    }
    /// The current clock time (milliseconds).
    fn now(&self) -> f64 {
        0.0
    }
    /// Run the next piece of host work the app queued (a clipboard reply,
    /// a history traversal) as a task of its own (docs/design/M5-PLATFORM.md):
    /// `None` when there is none, `Some(Some(kind))` when the window must
    /// receive event `kind` next (`popstate`, `hashchange`).
    fn host_task(&mut self, dom: &mut Dom) -> Option<Option<Event>> {
        let _ = dom;
        None
    }
    /// The number of image objects' outcomes queued (M6 images, `new
    /// Image()`): `load` or `error` of a `src` the program set.
    fn image_queued(&self) -> usize {
        0
    }
    /// Run the next queued image object outcome: its `load` or `error`
    /// listeners in order, each a task with its microtask checkpoint;
    /// nothing for an outcome a later `src` abandoned.
    fn image_task(&mut self, dom: &mut Dom) {
        let _ = dom;
    }
    /// Queue a traversal of the session history by the user (back, forward).
    fn traverse(&mut self, delta: i64) {
        let _ = delta;
    }
    /// Queue the `hashchange` of a fragment navigation (a followed link) as a task.
    fn hashchange(&mut self) {}
    /// A rendering step starts (`true`) or its frame's layout ended
    /// (`false`): no task runs inside a frame, so default-priority tasks
    /// queued meanwhile (React's scheduler, rejection reports) wait for its
    /// end (M6).
    fn defer_tasks(&mut self, on: bool) {
        let _ = on;
    }
    /// The number of default-priority tasks queued.
    fn deferred_len(&self) -> usize {
        0
    }
    /// Run the default-priority tasks the frame deferred, the first `limit`
    /// of them or all.
    fn run_deferred(&mut self, dom: &mut Dom, limit: Option<usize>) {
        let _ = (dom, limit);
    }
    /// Deliver the ResizeObserver notifications due after a layout (M6):
    /// observations whose size changed since last reported, deepest first
    /// across rounds, each observer's callback a task, with a layout after
    /// each round. Returns whether any callback ran.
    fn resize_step(&mut self, dom: &mut Dom) -> bool {
        let _ = dom;
        false
    }
    /// Update the IntersectionObserver observations after a frame's layout
    /// (M6 overlays): each observer's entries whose threshold index or
    /// intersection changed are queued, with one host task to deliver them.
    /// Returns whether any were queued.
    fn intersection_step(&mut self, dom: &mut Dom) -> bool {
        let _ = dom;
        false
    }
    /// The program reads CSS animations and transitions as objects
    /// (`element.getAnimations()`, M6): the runtime tracks them.
    const TRACKS_ANIMATIONS: bool = false;
    /// The program may listen to CSS animation and transition events (CSS
    /// slice 3b): the document records its animations from the start.
    const ANIMATION_EVENTS: bool = false;
    /// A frame's animation step (M6): the ends of animations the app holds
    /// (`Host::animation_ends`) settle their `finished` promises, as a task.
    fn animation_step(&mut self, dom: &mut Dom) {
        let _ = dom;
    }
}

/// Entry point of a generated application binary.
pub fn launch<A: App>() {
    #[cfg(feature = "probe")]
    if std::env::args().nth(1).as_deref() == Some("--probe") {
        probe::run::<A>();
        return;
    }
    // The desktop preferences are read on a thread of their own meanwhile.
    desktop::start();
    // Date and Intl see the system's time zone and locale.
    runic_js::env::init_from_system();
    shell::run::<A>();
}
