//! Event objects passed to handlers (docs/design/M5-PLATFORM.md, "Events"):
//! the event's data and its cancellation flags, shared by the listeners of
//! one dispatch and readable after it. Compared by identity.

use crate::{
    ArrayElement, Element, JsString, MapKey, StrictEq, ToJsString, ToMapKey, ToNumber, Truthy,
    TypeOf,
};
use std::cell::Cell;
use std::rc::Rc;

/// What an event carries (unused fields keep their defaults).
#[derive(Clone, Debug, Default)]
pub struct EventData {
    /// `event.type` (`click`, `keydown`, ...).
    pub kind: JsString,
    pub key: JsString,
    pub code: JsString,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    pub repeat: bool,
    pub client_x: f64,
    pub client_y: f64,
    pub button: f64,
    pub buttons: f64,
    pub delta_x: f64,
    pub delta_y: f64,
    /// The target control's value and checked state at dispatch.
    pub value: JsString,
    pub checked: bool,
    pub target: Element,
    /// `relatedTarget` (focus events: the element focus moved from or to).
    pub related: Option<Element>,
    /// Whether the event is cancelable (`preventDefault` has an effect).
    pub cancelable: bool,
}

#[derive(Debug)]
struct Inner {
    data: EventData,
    current: Cell<u64>,
    dispatching: Cell<bool>,
    prevented: Cell<bool>,
    stopped: Cell<bool>,
    stopped_immediately: Cell<bool>,
}

/// An event object.
#[derive(Clone, Debug)]
pub struct Event(Rc<Inner>);

impl Event {
    pub fn new(data: EventData) -> Self {
        Event(Rc::new(Inner {
            current: Cell::new(data.target.0),
            dispatching: Cell::new(true),
            data,
            prevented: Cell::new(false),
            stopped: Cell::new(false),
            stopped_immediately: Cell::new(false),
        }))
    }
    pub fn data(&self) -> &EventData {
        &self.0.data
    }
    /// `currentTarget`: the element whose listener is running (none
    /// after the dispatch).
    pub fn current_target(&self) -> Option<Element> {
        self.0
            .dispatching
            .get()
            .then(|| Element(self.0.current.get()))
    }
    /// Before a listener on `current` runs: whether it runs (propagation was
    /// not stopped at an earlier element, nor immediately), making
    /// `current` the current target.
    pub fn enter(&self, current: Element) -> bool {
        if self.0.stopped_immediately.get()
            || (self.0.stopped.get() && self.0.current.get() != current.0)
        {
            return false;
        }
        self.0.current.set(current.0);
        true
    }
    /// The dispatch ended.
    pub fn finish(&self) {
        self.0.dispatching.set(false);
    }
    pub fn prevent_default(&self) {
        if self.0.data.cancelable {
            self.0.prevented.set(true);
        }
    }
    pub fn default_prevented(&self) -> bool {
        self.0.prevented.get()
    }
    pub fn stop_propagation(&self) {
        self.0.stopped.set(true);
    }
    pub fn stop_immediate_propagation(&self) {
        self.0.stopped.set(true);
        self.0.stopped_immediately.set(true);
    }
    /// Whether listeners on further elements are skipped.
    pub fn propagation_stopped(&self) -> bool {
        self.0.stopped.get()
    }
    /// The handler `payload` shorthand: the value of `input`, the key of
    /// `keydown`, the checked state of `change` (`"true"`/`"false"`).
    pub fn payload(&self) -> Option<JsString> {
        let d = &self.0.data;
        match d.kind.to_rust().as_str() {
            "input" => Some(d.value.clone()),
            "keydown" => Some(d.key.clone()),
            "change" => Some(JsString::from(if d.checked { "true" } else { "false" })),
            _ => None,
        }
    }
    pub fn ptr_eq(a: &Self, b: &Self) -> bool {
        Rc::ptr_eq(&a.0, &b.0)
    }
}

impl PartialEq for Event {
    fn eq(&self, other: &Self) -> bool {
        Event::ptr_eq(self, other)
    }
}
impl Truthy for Event {
    fn truthy(&self) -> bool {
        true
    }
}
impl ToJsString for Event {
    fn to_js_string(&self) -> JsString {
        JsString::from("[object Event]")
    }
}
impl ArrayElement for Event {
    fn join_string(&self) -> JsString {
        self.to_js_string()
    }
}
impl ToNumber for Event {
    fn to_number(&self) -> f64 {
        f64::NAN
    }
}
impl TypeOf for Event {
    fn type_of(&self) -> &'static str {
        "object"
    }
}
impl StrictEq for Event {
    fn strict_eq(&self, other: &Self) -> bool {
        self == other
    }
}
impl ToMapKey for Event {
    fn map_key(&self) -> MapKey {
        MapKey::Ref(Rc::as_ptr(&self.0) as *const u8 as usize)
    }
}
impl crate::Own for Event {}
