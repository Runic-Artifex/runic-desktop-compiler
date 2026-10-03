//! Native runtime for generated Runic applications.
//!
//! Generated code implements [`App`]; the runtime owns the Blitz document, the
//! window, event delivery with browser DOM semantics (activation, focus,
//! controlled text inputs) and, behind the `probe` feature, scripted input and
//! DOM snapshots for conformance runs.

mod controls;
mod dom;
mod events;
mod jobs;
#[cfg(feature = "probe")]
mod probe;
pub mod promises;
pub mod reorder;
mod shell;
mod storage;
mod timers;

pub use blitz_traits::node_id::NodeId;
pub use dom::{ClassState, Dom, Event, Spread};
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
    const IR_HASH: &'static str;

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
    /// Clock time of the next timer.
    fn next_timer(&self) -> Option<f64> {
        None
    }
    /// The current clock time (milliseconds).
    fn now(&self) -> f64 {
        0.0
    }
}

/// Entry point of a generated application binary.
pub fn launch<A: App>() {
    #[cfg(feature = "probe")]
    if std::env::args().nth(1).as_deref() == Some("--probe") {
        probe::run::<A>();
        return;
    }
    shell::run::<A>();
}
