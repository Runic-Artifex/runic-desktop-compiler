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
    /// `isComposing`: a key event at a text control while an IME
    /// composition is in progress there.
    pub composing: bool,
    pub client_x: f64,
    pub client_y: f64,
    pub button: f64,
    pub buttons: f64,
    pub delta_x: f64,
    pub delta_y: f64,
    /// `detail`: a mouse button event's click count (0 for keyboard and
    /// simulated clicks and other events).
    pub detail: f64,
    /// The target control's value and checked state at dispatch.
    pub value: JsString,
    pub checked: bool,
    pub target: Element,
    /// `relatedTarget` (focus events: the element focus moved from or to).
    pub related: Option<Element>,
    /// Whether the event is cancelable (`preventDefault` has an effect).
    pub cancelable: bool,
    /// A `MediaQueryList` change event: whether the query matches now.
    pub matches: bool,
    /// Created by script (`new CustomEvent(type, { cancelable })`, M6
    /// overlays): only its type, cancellation and propagation are covered
    /// (dispatched by script with `dispatchEvent` where its type is not a
    /// native event's).
    pub synthetic: bool,
    /// Whether an event created by script bubbles when dispatched.
    pub bubbles: bool,
    /// A synthetic `KeyboardEvent` initialised from another event (bits-ui's
    /// `new KeyboardEvent(e.type, e)`): its key members are covered too.
    pub keyboard: bool,
}

/// The event interfaces `instanceof` tests (M6 overlays), each with its
/// base interface.
pub const EVENT_INTERFACES: &[(&str, &str)] = &[
    ("Event", ""),
    ("UIEvent", "Event"),
    ("MouseEvent", "UIEvent"),
    ("PointerEvent", "MouseEvent"),
    ("WheelEvent", "MouseEvent"),
    ("KeyboardEvent", "UIEvent"),
    ("FocusEvent", "UIEvent"),
    ("InputEvent", "UIEvent"),
    ("CustomEvent", "Event"),
];

impl EventData {
    /// The interface of the event, as Chromium creates it for its type (a
    /// script's `CustomEvent`, a keyboard copy a `KeyboardEvent`); None
    /// for types whose interface the runtime does not know.
    pub fn interface(&self) -> Option<&'static str> {
        if self.synthetic {
            return Some(if self.keyboard {
                "KeyboardEvent"
            } else {
                "CustomEvent"
            });
        }
        let kind = self.kind.to_rust();
        Some(match kind.as_str() {
            "pointerdown" | "pointerup" | "pointermove" | "pointerover" | "pointerout"
            | "pointerenter" | "pointerleave" | "pointercancel" | "gotpointercapture"
            | "lostpointercapture" | "click" | "auxclick" | "contextmenu" => "PointerEvent",
            "mousedown" | "mouseup" | "mousemove" | "mouseover" | "mouseout" | "mouseenter"
            | "mouseleave" | "dblclick" => "MouseEvent",
            "wheel" => "WheelEvent",
            "keydown" | "keyup" | "keypress" => "KeyboardEvent",
            "focus" | "blur" | "focusin" | "focusout" => "FocusEvent",
            "input" | "beforeinput" => "InputEvent",
            "change" | "scroll" | "scrollend" | "load" | "error" | "select" => "Event",
            _ => return None,
        })
    }

    /// `event instanceof class` for an interface of `EVENT_INTERFACES`;
    /// None where the event's interface is unknown (and `class` is not
    /// `Event`).
    pub fn instance_of(&self, class: &str) -> Option<bool> {
        if class == "Event" {
            return Some(true);
        }
        let mut at = self.interface()?;
        while !at.is_empty() {
            if at == class {
                return Some(true);
            }
            at = EVENT_INTERFACES
                .iter()
                .find(|(name, _)| *name == at)
                .map_or("", |(_, base)| base);
        }
        Some(false)
    }

    /// `pointerType` (M6, bits-ui's `isTouch`): pointer events, and the
    /// `click`, `auxclick` and `contextmenu` events Chromium dispatches as
    /// pointer events, come from the mouse (the only pointer device the
    /// runtime has), except a `click` with no click count (the activation
    /// of a focused control by a key, or a simulated click), whose pointer
    /// type is empty. Other events have none (`undefined` in JavaScript).
    pub fn pointer_type(&self) -> Option<&'static str> {
        let kind = self.kind.to_rust();
        match kind.as_str() {
            "pointerdown" | "pointerup" | "pointermove" | "pointerover" | "pointerout"
            | "pointerenter" | "pointerleave" | "pointercancel" | "contextmenu" | "auxclick" => {
                Some("mouse")
            }
            "click" => Some(if self.detail > 0.0 { "mouse" } else { "" }),
            _ => None,
        }
    }

    /// `pointerId` of a pointer event: 1, the mouse's (Chromium's id for
    /// it; the runtime has no other pointer). Other events: none (clicks
    /// and context menus carry ids that depend on their source).
    pub fn pointer_id(&self) -> Option<f64> {
        self.kind.to_rust().starts_with("pointer").then_some(1.0)
    }
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
