//! Native runtime for generated Runic applications.
//!
//! Generated code implements [`App`]; the runtime owns the Blitz document, the
//! window, event delivery with browser DOM semantics (activation, focus,
//! controlled text inputs) and, behind the `probe` feature, scripted input and
//! DOM snapshots for conformance runs.

mod animations;
pub mod clipboard;
pub mod console;
mod controls;
mod dom;
mod effects;
mod events;
pub mod floating;
pub mod history;
mod jobs;
mod layout;
#[cfg(feature = "probe")]
mod probe;
pub mod promises;
mod random;
pub use runic_js::reorder;
mod select;
mod shell;
mod storage;
mod tabbable;
mod timeline;
mod timers;

pub use blitz_traits::node_id::NodeId;
pub use dom::{ClassState, Dom, Event, FragmentNode, Host, HtmlFragment, Spread};
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

/// What media queries see: the viewport and the user preferences (light,
/// no contrast or motion preference, as the probe emulates them).
pub fn media_env() -> css::MediaEnv {
    MEDIA.with(|m| m.get())
}
pub use jobs::{CellVersions, Dep, Derived, Fx, Job, Jobs, Phase, Versions};
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
    /// target inside one is scrolled where the padding would move it.
    const STYLE_GUARDS: &'static [(&'static str, &'static str, &'static str, &'static str)] = &[];
    const IR_HASH: &'static str;
    /// Attributes of `<body>` (from the app's HTML template, M6).
    const BODY_ATTRS: &'static [(&'static str, &'static str)] = &[];
    /// Attributes of the element the app mounts in (the HTML template's
    /// container, M6); `None` for `<div id="root">`.
    const CONTAINER_ATTRS: Option<&'static [(&'static str, &'static str)]> = None;

    fn new() -> Self;
    /// Build the initial DOM under `parent` and register listeners.
    fn mount(&mut self, dom: &mut Dom, parent: NodeId);
    /// A checkbox's `change` listener runs in the `click` dispatch.
    const CHANGE_WITH_CLICK: bool = false;
    /// Dispatch one event: run its listeners in order (each unless the event's
    /// propagation was stopped) with the framework's microtask checkpoints,
    /// then the jobs they queued (which update the DOM). On a text-domain
    /// error the task's writes are rolled back and controlled inputs are
    /// re-synchronised.
    fn dispatch(&mut self, dom: &mut Dom, deliveries: &[Delivery]) -> Result<(), String>;
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
    // Date and Intl see the system's time zone and locale.
    runic_js::env::init_from_system();
    shell::run::<A>();
}
