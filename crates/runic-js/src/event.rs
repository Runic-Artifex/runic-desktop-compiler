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
    /// A `MediaQueryList` change event (its target is the list, not an
    /// element handle).
    pub media: bool,
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
    /// The interface script constructed the event with (M6 script DOM,
    /// slice 3: `new MouseEvent(type, init)`); its members are those of the
    /// interface, from the init dictionary or their defaults. None for an
    /// old-style `CustomEvent` without a detail and for native events.
    pub interface: Option<&'static str>,
    /// An event the user agent dispatches for a script call
    /// (`element.click()`): `isTrusted` is false, as for script's events.
    pub untrusted: bool,
    /// `timeStamp`: the clock (milliseconds since the time origin) when the
    /// event was created.
    pub time_stamp: f64,
}

thread_local! {
    /// The clock events are stamped with (`timeStamp`): the runtime and the
    /// interpreter set it when their clock moves.
    static CLOCK: Cell<f64> = const { Cell::new(0.0) };
}

/// Set the clock events created from now on are stamped with.
pub fn set_clock(now: f64) {
    CLOCK.with(|c| c.set(now));
}

/// The event clock (`timeStamp` of an event created now).
pub fn clock() -> f64 {
    CLOCK.with(Cell::get)
}

/// The event interfaces `instanceof` tests (M6 overlays), each with its
/// base interface.
pub const EVENT_INTERFACES: &[(&str, &str)] = &[
    ("Event", ""),
    ("SubmitEvent", "Event"),
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
        if let Some(i) = self.interface {
            return Some(i);
        }
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
            "submit" => "SubmitEvent",
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

    /// Set a number member of an init dictionary (`init_member`).
    pub fn init_number(&mut self, name: &str, v: f64) {
        match name {
            "detail" => self.detail = v,
            "clientX" => self.client_x = v,
            "clientY" => self.client_y = v,
            "button" => self.button = v,
            "buttons" => self.buttons = v,
            "deltaX" => self.delta_x = v,
            "deltaY" => self.delta_y = v,
            _ => unreachable!("validated init member {name}"),
        }
    }
    /// Set a string member of an init dictionary.
    pub fn init_string(&mut self, name: &str, v: JsString) {
        match name {
            "key" => self.key = v,
            "code" => self.code = v,
            _ => unreachable!("validated init member {name}"),
        }
    }
    /// Set a boolean member of an init dictionary.
    pub fn init_bool(&mut self, name: &str, v: bool) {
        match name {
            "ctrlKey" => self.ctrl = v,
            "shiftKey" => self.shift = v,
            "altKey" => self.alt = v,
            "metaKey" => self.meta = v,
            "repeat" => self.repeat = v,
            "isComposing" => self.composing = v,
            _ => unreachable!("validated init member {name}"),
        }
    }

    /// Why member `m` (an `event.*` built-in's name) is not covered for this
    /// event; None where it is. Every event has its type, cancellation,
    /// propagation, `isTrusted`, `timeStamp` and targets; an event script
    /// created has the members of the interface it was constructed with
    /// (from its init dictionary or their defaults; another interface's
    /// member is `undefined` in JavaScript, which the typed read cannot
    /// hold), and a keyboard copy its key members.
    pub fn member_unsupported(&self, m: &str) -> Option<String> {
        if matches!(
            m,
            "type"
                | "defaultPrevented"
                | "preventDefault"
                | "stopPropagation"
                | "stopImmediatePropagation"
                | "isTrusted"
                | "timeStamp"
                | "cancelable"
                | "currentTarget"
                | "path-target"
                | "target"
        ) {
            return None;
        }
        if !self.synthetic {
            return (m == "bubbles")
                .then(|| "bubbles of an event the user agent dispatches".into());
        }
        if m == "bubbles" {
            return None;
        }
        let keys = matches!(
            m,
            "key"
                | "code"
                | "ctrlKey"
                | "shiftKey"
                | "altKey"
                | "metaKey"
                | "repeat"
                | "isComposing"
        );
        if self.keyboard && self.interface.is_none() && keys {
            return None;
        }
        if self.interface.is_some() {
            let owners: &[&str] = match m {
                "detail" => &["UIEvent"],
                "clientX" | "clientY" | "button" | "buttons" => &["MouseEvent"],
                "relatedTarget" => &["MouseEvent", "FocusEvent"],
                "ctrlKey" | "shiftKey" | "altKey" | "metaKey" => &["MouseEvent", "KeyboardEvent"],
                "key" | "code" | "repeat" => &["KeyboardEvent"],
                "isComposing" => &["KeyboardEvent", "InputEvent"],
                "deltaX" | "deltaY" => &["WheelEvent"],
                _ => &[],
            };
            if owners.iter().any(|o| self.instance_of(o).unwrap_or(false)) {
                return None;
            }
            return Some(format!(
                "{m} of a{} {} created by script",
                if self
                    .interface()
                    .is_some_and(|i| i.starts_with(['A', 'E', 'I', 'O', 'U']))
                {
                    "n"
                } else {
                    ""
                },
                self.interface().unwrap_or("Event")
            ));
        }
        Some(format!("{m} of an event created by script"))
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

/// A `CustomEvent`'s detail (M6 script DOM, slice 3): the value and a tag
/// naming its static type, so that a read at another type throws (only an
/// unsound cast reaches one).
pub struct Detail {
    pub value: Rc<dyn std::any::Any>,
    pub tag: String,
}

impl std::fmt::Debug for Detail {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Detail({})", self.tag)
    }
}

/// The TypeError of reading a `CustomEvent`'s detail at a type it does not
/// have (an unsound cast in the source).
pub fn detail_type_error(have: &str, want: &str) -> crate::Throw {
    crate::Throw::type_error(format!("an event's detail of type {have} read as {want}"))
}

/// The event types the runtime and the interpreter dispatch themselves
/// (the IR's event kinds, `runic_ir::EventKind`).
pub const FIRED_TYPES: &[&str] = &[
    "click",
    "submit",
    "input",
    "change",
    "keydown",
    "keyup",
    "dblclick",
    "contextmenu",
    "pointerdown",
    "pointerup",
    "pointermove",
    "pointerenter",
    "pointerleave",
    "mousedown",
    "mouseup",
    "mousemove",
    "mouseenter",
    "mouseleave",
    "pointerover",
    "pointerout",
    "mouseover",
    "mouseout",
    "wheel",
    "focus",
    "blur",
    "focusin",
    "focusout",
    "scroll",
    "resize",
    "popstate",
    "hashchange",
    "load",
    "error",
];

/// Event types Chromium 153 dispatches itself (its `event_type_names`,
/// those reachable from a page): a listener of one of them is a listener of
/// native events, which the runtime must fire where Chromium does. Any other
/// type is a custom event's, which only script dispatches.
pub const NATIVE_TYPES: &[&str] = &[
    "abort",
    "activate",
    "addsourcebuffer",
    "addtrack",
    "afterprint",
    "animationcancel",
    "animationend",
    "animationiteration",
    "animationstart",
    "appinstalled",
    "audioend",
    "audioprocess",
    "audiostart",
    "auxclick",
    "beforecopy",
    "beforecut",
    "beforeinput",
    "beforeinstallprompt",
    "beforematch",
    "beforepaste",
    "beforeprint",
    "beforetoggle",
    "beforeunload",
    "beforexrselect",
    "blocked",
    "blur",
    "boundary",
    "bufferedamountlow",
    "cancel",
    "canplay",
    "canplaythrough",
    "change",
    "characterboundsupdate",
    "chargingchange",
    "chargingtimechange",
    "click",
    "close",
    "command",
    "complete",
    "compositionend",
    "compositionstart",
    "compositionupdate",
    "connect",
    "connectionstatechange",
    "contentvisibilityautostatechange",
    "contextlost",
    "contextmenu",
    "contextrestored",
    "controllerchange",
    "copy",
    "cuechange",
    "currententrychange",
    "currentscreenchange",
    "cut",
    "datachannel",
    "dblclick",
    "devicechange",
    "devicemotion",
    "deviceorientation",
    "deviceorientationabsolute",
    "dischargingtimechange",
    "disconnect",
    "dispose",
    "DOMContentLoaded",
    "drag",
    "dragend",
    "dragenter",
    "dragleave",
    "dragover",
    "dragstart",
    "drop",
    "durationchange",
    "emptied",
    "encrypted",
    "end",
    "ended",
    "enter",
    "error",
    "exit",
    "focus",
    "focusin",
    "focusout",
    "formdata",
    "fullscreenchange",
    "fullscreenerror",
    "gamepadconnected",
    "gamepaddisconnected",
    "gotpointercapture",
    "hashchange",
    "icecandidate",
    "icecandidateerror",
    "iceconnectionstatechange",
    "icegatheringstatechange",
    "inactive",
    "input",
    "inputsourceschange",
    "install",
    "invalid",
    "keydown",
    "keypress",
    "keyup",
    "keystatuseschange",
    "languagechange",
    "levelchange",
    "load",
    "loadeddata",
    "loadedmetadata",
    "loadend",
    "loading",
    "loadingdone",
    "loadingerror",
    "loadstart",
    "lostpointercapture",
    "mark",
    "message",
    "messageerror",
    "midimessage",
    "mousedown",
    "mouseenter",
    "mouseleave",
    "mousemove",
    "mouseout",
    "mouseover",
    "mouseup",
    "mousewheel",
    "mute",
    "navigate",
    "navigateerror",
    "navigatesuccess",
    "negotiationneeded",
    "nomatch",
    "offline",
    "online",
    "open",
    "orientationchange",
    "overscroll",
    "pagehide",
    "pagereveal",
    "pageshow",
    "pageswap",
    "paste",
    "pause",
    "play",
    "playing",
    "pointercancel",
    "pointerdown",
    "pointerenter",
    "pointerleave",
    "pointermove",
    "pointerout",
    "pointerover",
    "pointerrawupdate",
    "pointerup",
    "popstate",
    "prerenderingchange",
    "processorerror",
    "progress",
    "ratechange",
    "readystatechange",
    "rejectionhandled",
    "release",
    "removesourcebuffer",
    "removetrack",
    "reset",
    "resize",
    "resourcetimingbufferfull",
    "result",
    "resume",
    "screenschange",
    "scroll",
    "scrollend",
    "scrollsnapchange",
    "scrollsnapchanging",
    "search",
    "securitypolicyviolation",
    "seeked",
    "seeking",
    "select",
    "selectedcandidatechange",
    "selectionchange",
    "selectstart",
    "shippingaddresschange",
    "shippingoptionchange",
    "show",
    "signalingstatechange",
    "slotchange",
    "soundend",
    "soundstart",
    "sourceclose",
    "sourceended",
    "sourceopen",
    "speechend",
    "speechstart",
    "squeeze",
    "squeezeend",
    "squeezestart",
    "stalled",
    "start",
    "statechange",
    "storage",
    "submit",
    "success",
    "suspend",
    "textInput",
    "timeout",
    "timeupdate",
    "toggle",
    "tonechange",
    "touchcancel",
    "touchend",
    "touchmove",
    "touchstart",
    "track",
    "transitioncancel",
    "transitionend",
    "transitionrun",
    "transitionstart",
    "uncapturederror",
    "unhandledrejection",
    "unload",
    "unmute",
    "update",
    "updateend",
    "updatefound",
    "updatestart",
    "upgradeneeded",
    "versionchange",
    "visibilitychange",
    "voiceschanged",
    "volumechange",
    "waiting",
    "waitingforkey",
    "webglcontextcreationerror",
    "webglcontextlost",
    "webglcontextrestored",
    "webkitAnimationEnd",
    "webkitAnimationIteration",
    "webkitAnimationStart",
    "webkitTransitionEnd",
    "webkitfullscreenchange",
    "webkitfullscreenerror",
    "wheel",
    "zoomlevelchange",
];

/// Native event types Chromium never dispatches where the runtime and the
/// harness run: touch events (no touch device), drag and drop (no
/// draggable content is dragged: the runtime has no drag and drop, a gap
/// of its own), `beforematch` (no find-in-page), and `visibilitychange`
/// (the document stays visible while the window is shown). Their listeners
/// are kept and run when script dispatches such an event.
pub const NEVER_FIRED_TYPES: &[&str] = &[
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
    "dragstart",
    "drag",
    "dragend",
    "dragenter",
    "dragleave",
    "dragover",
    "drop",
    "beforematch",
    "visibilitychange",
];

/// Whether a listener registered without `passive` is passive: Chromium's
/// intervention makes `touchstart`, `touchmove`, `wheel` and `mousewheel`
/// listeners of the window, the document, the document element and the
/// body passive by default.
pub fn passive_by_default(name: &str, root_target: bool) -> bool {
    root_target && matches!(name, "touchstart" | "touchmove" | "wheel" | "mousewheel")
}

/// The interfaces script constructs events with (M6 script DOM, slice 3;
/// `CustomEvent` has its own built-in, `event.custom`).
pub const SCRIPT_INTERFACES: &[&str] = &[
    "Event",
    "UIEvent",
    "MouseEvent",
    "WheelEvent",
    "KeyboardEvent",
    "FocusEvent",
    "InputEvent",
];

/// The type of an init dictionary member script may give (`new
/// MouseEvent(type, { clientX })`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum InitType {
    Number,
    String,
    Boolean,
    /// `relatedTarget`: a node or null.
    Target,
}

/// The covered init member `name` of `interface` (or of an interface it
/// derives from), with its type.
pub fn init_member(interface: &str, name: &str) -> Option<InitType> {
    let derives = |base: &str| {
        EventData {
            interface: SCRIPT_INTERFACES.iter().copied().find(|i| *i == interface),
            synthetic: true,
            ..Default::default()
        }
        .instance_of(base)
        .unwrap_or(false)
    };
    let (owners, t): (&[&str], InitType) = match name {
        "detail" => (&["UIEvent"], InitType::Number),
        "clientX" | "clientY" | "button" | "buttons" => (&["MouseEvent"], InitType::Number),
        "deltaX" | "deltaY" => (&["WheelEvent"], InitType::Number),
        "ctrlKey" | "shiftKey" | "altKey" | "metaKey" => {
            (&["MouseEvent", "KeyboardEvent"], InitType::Boolean)
        }
        "key" | "code" => (&["KeyboardEvent"], InitType::String),
        "repeat" => (&["KeyboardEvent"], InitType::Boolean),
        "isComposing" => (&["KeyboardEvent", "InputEvent"], InitType::Boolean),
        "relatedTarget" => (&["MouseEvent", "FocusEvent"], InitType::Target),
        _ => return None,
    };
    owners.iter().any(|o| derives(o)).then_some(t)
}

/// The kind of an event target (M6 script DOM, slice 3).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TargetKind {
    Element,
    /// A text, comment or fragment node: native events never target it.
    Node,
    Document,
    Window,
}

/// What listening to an event type at a target means.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Listening {
    /// The runtime fires such events there (its event kinds).
    Fired,
    /// No native event of the type reaches the target where the runtime
    /// runs, or the type is a custom one: only script dispatches it.
    Script,
    /// Chromium fires such events there and the runtime does not: the
    /// listener is reported unsupported.
    Unsupported,
}

/// Whether events of type `name` reach a listener at a target of `kind`
/// natively (DOM standard event paths: an element's events bubble to the
/// document and the window, focus events reach their capture listeners).
pub fn listening(kind: TargetKind, name: &str) -> Listening {
    let native = NATIVE_TYPES.contains(&name);
    if !native {
        return Listening::Script;
    }
    if NEVER_FIRED_TYPES.contains(&name) {
        return Listening::Script;
    }
    if !FIRED_TYPES.contains(&name) {
        return Listening::Unsupported;
    }
    match (kind, name) {
        // Text, comment and fragment nodes are never an event's target or
        // on an element's path.
        (TargetKind::Node, _) => Listening::Script,
        // An image's outcome reaches only the image (and the window's
        // `error` is an uncaught exception's, `load` the page's).
        (_, "load" | "error") => Listening::Unsupported,
        // Window-only events never reach elements or the document.
        (TargetKind::Element | TargetKind::Document, "resize" | "popstate" | "hashchange") => {
            Listening::Script
        }
        _ => Listening::Fired,
    }
}

#[derive(Debug)]
struct Inner {
    data: EventData,
    current: Cell<u64>,
    /// The element a delegated template listener runs for (`enter_delegated`).
    delegated_current: Cell<Option<u64>>,
    dispatching: Cell<bool>,
    prevented: Cell<bool>,
    stopped: Cell<bool>,
    stopped_immediately: Cell<bool>,
    /// The invocation running (DOM standard, "invoke": one per node and
    /// phase): the node and whether it is the capturing one. The stop
    /// propagation flag lets only the rest of this invocation run.
    invocation: Cell<Option<(u64, bool)>>,
    /// A framework's own event object over this one stopped propagation
    /// (React's synthetic event: its handlers check their own flag, not the
    /// native one; reset as each root group starts, `enter_root`).
    synthetic_stopped: Cell<bool>,
    /// The native event a framework's event of another type stands on
    /// (React's `onChange` of a checkbox, from the click): stopping and
    /// cancelling it act on that event too (`Event::linked`).
    native: Option<Event>,
    /// The target (an event script created has none until dispatched).
    target: Cell<Option<u64>>,
    /// A passive listener is running: `preventDefault` does nothing.
    passive: Cell<bool>,
    detail: Option<Detail>,
}

/// An event object.
#[derive(Clone, Debug)]
pub struct Event(Rc<Inner>);

impl Event {
    /// An event the user agent dispatches (stamped with the event clock
    /// unless its data has a time), being dispatched at `data.target`.
    pub fn new(mut data: EventData) -> Self {
        if data.time_stamp == 0.0 {
            data.time_stamp = clock();
        }
        Event(Rc::new(Inner {
            current: Cell::new(data.target.0),
            delegated_current: Cell::new(None),
            dispatching: Cell::new(true),
            target: Cell::new(Some(data.target.0)),
            data,
            prevented: Cell::new(false),
            stopped: Cell::new(false),
            stopped_immediately: Cell::new(false),
            invocation: Cell::new(None),
            synthetic_stopped: Cell::new(false),
            native: None,
            passive: Cell::new(false),
            detail: None,
        }))
    }
    /// A framework's event of another type standing on the native event
    /// `native`, which the user agent is dispatching (React's `onChange` of
    /// a checkbox or radio button runs in the click's root group, with an
    /// event of its own): `stopPropagation` stops it and the native event,
    /// `preventDefault` cancels both (the toggle is reverted); its own
    /// propagation flag is its own (the click's handlers stopping does not
    /// skip it), and whether it can run at the root is the native event's.
    pub fn linked(data: EventData, native: &Event) -> Self {
        let mut e = Event::new(data);
        Rc::get_mut(&mut e.0).expect("a new event").native = Some(native.clone());
        e
    }
    /// Whether this is a framework's event standing on another
    /// (`Event::linked`).
    pub fn is_linked(&self) -> bool {
        self.0.native.is_some()
    }
    /// An event script created (`new Event(…)`, `new CustomEvent(…)`, M6
    /// script DOM slice 3): not being dispatched and without a target until
    /// it is; with a `CustomEvent`'s detail.
    pub fn script(mut data: EventData, detail: Option<Detail>) -> Self {
        data.synthetic = true;
        data.time_stamp = clock();
        Event(Rc::new(Inner {
            current: Cell::new(0),
            delegated_current: Cell::new(None),
            dispatching: Cell::new(false),
            target: Cell::new(None),
            data,
            prevented: Cell::new(false),
            stopped: Cell::new(false),
            stopped_immediately: Cell::new(false),
            invocation: Cell::new(None),
            synthetic_stopped: Cell::new(false),
            native: None,
            passive: Cell::new(false),
            detail,
        }))
    }
    pub fn data(&self) -> &EventData {
        &self.0.data
    }
    /// `target`: none for an event script created and never dispatched.
    pub fn target(&self) -> Option<Element> {
        self.0.target.get().map(Element)
    }
    /// Whether the event is being dispatched.
    pub fn dispatching(&self) -> bool {
        self.0.dispatching.get()
    }
    /// `dispatchEvent` starts (DOM standard, dispatch): the event is being
    /// dispatched at `target`. False where it already is (the caller
    /// throws `InvalidStateError`).
    pub fn begin_dispatch(&self, target: Element) -> bool {
        if self.0.dispatching.get() {
            return false;
        }
        self.0.dispatching.set(true);
        self.0.target.set(Some(target.0));
        self.0.current.set(target.0);
        self.0.invocation.set(None);
        true
    }
    /// `dispatchEvent` ends: no current target, and the propagation flags
    /// are cleared (cancellation stays), so that it can be dispatched again.
    pub fn end_dispatch(&self) {
        self.0.dispatching.set(false);
        self.0.passive.set(false);
        self.0.stopped.set(false);
        self.0.stopped_immediately.set(false);
        self.0.invocation.set(None);
    }
    /// A `CustomEvent`'s detail (none: null).
    pub fn detail(&self) -> Option<&Detail> {
        self.0.detail.as_ref()
    }
    /// Whether a passive listener is running (its `preventDefault` does
    /// nothing, as in Chromium); returns the previous state.
    pub fn set_passive(&self, on: bool) -> bool {
        self.0.passive.replace(on)
    }
    /// `isTrusted`: dispatched by the user agent for input, not for script.
    pub fn is_trusted(&self) -> bool {
        !self.0.data.synthetic && !self.0.data.untrusted
    }
    /// `currentTarget`: the element whose listener is running (none
    /// after the dispatch).
    pub fn current_target(&self) -> Option<Element> {
        self.0.dispatching.get().then(|| {
            Element(
                self.0
                    .delegated_current
                    .get()
                    .unwrap_or(self.0.current.get()),
            )
        })
    }
    /// Before a template listener a framework runs from its delegation root
    /// `root` for element `current` (Svelte's `handle_event_propagation`,
    /// IR `schedule.delegation`): the first of a root's group runs where the
    /// root's listener can (`first`), each further one while propagation
    /// was not stopped (Svelte checks `cancelBubble` after each); while it
    /// runs `currentTarget` is `current`, the native current target stays
    /// the root.
    pub fn enter_delegated(&self, root: Element, current: Element, first: bool) -> bool {
        if first {
            // (The root's own listener: its bubbling-phase invocation.)
            if !self.can_enter(root, false) {
                return false;
            }
            self.0.current.set(root.0);
            self.0.invocation.set(Some((root.0, false)));
        } else if self.0.stopped.get() {
            return false;
        }
        self.0.delegated_current.set(Some(current.0));
        true
    }
    /// Before a template listener a framework runs from its root's listener
    /// (React's root, IR `schedule.rootDispatch`) for element `current`, in
    /// the root's capturing (`capture`) or bubbling invocation: the first of
    /// the group runs where the root's listener can (the native event's,
    /// for a linked event), and starts the framework's event afresh (its
    /// stop flag is its own: a native listener that stopped propagation
    /// earlier in the root's invocation does not skip it); each further one
    /// while that framework event was not stopped. `currentTarget` is
    /// `current` while it runs.
    pub fn enter_root(&self, root: Element, current: Element, first: bool, capture: bool) -> bool {
        if first {
            let native = self.0.native.as_ref().unwrap_or(self);
            if !native.can_enter(root, capture) {
                return false;
            }
            native.0.current.set(root.0);
            native.0.invocation.set(Some((root.0, capture)));
            self.0.current.set(root.0);
            self.0.invocation.set(Some((root.0, capture)));
            self.0.synthetic_stopped.set(false);
        } else if self.0.synthetic_stopped.get() || self.0.stopped_immediately.get() {
            return false;
        }
        self.0.delegated_current.set(Some(current.0));
        true
    }
    /// `composedPath()[0]`: the first entry of the event's path, which is
    /// the target where there are no shadow roots (the runtime has none);
    /// none once the dispatch is over (the path is cleared, `[]`).
    pub fn path_target(&self) -> Option<Element> {
        if !self.0.dispatching.get() {
            return None;
        }
        self.target()
    }
    /// Whether a listener of `current` in the capturing (`capture`) or the
    /// bubbling phase can run, without changing the current target or
    /// starting a task/checkpoint for a suppressed callback. After
    /// `stopPropagation` only the rest of the running invocation runs (the
    /// DOM standard checks the flag at each invocation, one per node and
    /// phase: a capture listener's stop keeps its node's bubbling-phase
    /// listeners, and at the target its non-capture ones, from running).
    pub fn can_enter(&self, current: Element, capture: bool) -> bool {
        !self.0.stopped_immediately.get()
            && (!self.0.stopped.get() || self.0.invocation.get() == Some((current.0, capture)))
    }
    /// Before a listener on `current` runs in the capturing (`capture`) or
    /// the bubbling phase: whether it runs (propagation was not stopped in
    /// an earlier invocation, nor immediately), making `current` the
    /// current target.
    pub fn enter(&self, current: Element, capture: bool) -> bool {
        if !self.can_enter(current, capture) {
            return false;
        }
        self.0.current.set(current.0);
        self.0.invocation.set(Some((current.0, capture)));
        self.0.delegated_current.set(None);
        true
    }
    /// The dispatch ended.
    pub fn finish(&self) {
        self.0.dispatching.set(false);
    }
    pub fn prevent_default(&self) {
        if let Some(native) = &self.0.native {
            native.prevent_default();
            self.0.prevented.set(true);
            return;
        }
        if self.0.data.cancelable && !self.0.passive.get() {
            self.0.prevented.set(true);
        }
    }
    pub fn default_prevented(&self) -> bool {
        self.0.prevented.get()
    }
    pub fn stop_propagation(&self) {
        self.0.stopped.set(true);
        self.0.synthetic_stopped.set(true);
        if let Some(native) = &self.0.native {
            native.stop_propagation();
        }
    }
    pub fn stop_immediate_propagation(&self) {
        self.0.stopped.set(true);
        self.0.synthetic_stopped.set(true);
        self.0.stopped_immediately.set(true);
        if let Some(native) = &self.0.native {
            native.stop_immediate_propagation();
        }
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

#[cfg(test)]
mod submission_tests {
    use super::*;

    #[test]
    fn native_submit_has_submit_event_inheritance_and_retains_cancellation() {
        let event = Event::new(EventData {
            kind: JsString::from("submit"),
            cancelable: true,
            ..Default::default()
        });
        assert_eq!(event.data().instance_of("SubmitEvent"), Some(true));
        assert_eq!(event.data().instance_of("Event"), Some(true));
        assert_eq!(event.data().instance_of("MouseEvent"), Some(false));
        let held = event.clone();
        event.prevent_default();
        event.finish();
        assert!(held.default_prevented());
        assert_eq!(held.current_target(), None);
    }

    /// Listeners of types the runtime fires, never sees or does not fire
    /// (M6 script DOM, slice 3).
    #[test]
    fn listening_by_type_and_target() {
        assert_eq!(listening(TargetKind::Element, "click"), Listening::Fired);
        assert_eq!(listening(TargetKind::Window, "popstate"), Listening::Fired);
        assert_eq!(
            listening(TargetKind::Document, "popstate"),
            Listening::Script
        );
        assert_eq!(
            listening(TargetKind::Element, "touchstart"),
            Listening::Script
        );
        assert_eq!(
            listening(TargetKind::Element, "emblaInit"),
            Listening::Script
        );
        assert_eq!(listening(TargetKind::Node, "click"), Listening::Script);
        assert_eq!(
            listening(TargetKind::Element, "keypress"),
            Listening::Unsupported
        );
        assert_eq!(
            listening(TargetKind::Window, "load"),
            Listening::Unsupported
        );
        assert!(passive_by_default("wheel", true));
        assert!(!passive_by_default("wheel", false));
        assert!(!passive_by_default("click", true));
        assert_eq!(init_member("WheelEvent", "clientX"), Some(InitType::Number));
        assert_eq!(init_member("KeyboardEvent", "clientX"), None);
        assert_eq!(
            init_member("FocusEvent", "relatedTarget"),
            Some(InitType::Target)
        );
    }

    /// An event script creates: not dispatched until `begin_dispatch`, no
    /// target before; propagation flags cleared at the end, cancellation
    /// kept; a passive listener cannot cancel it.
    #[test]
    fn script_events_dispatch_once_at_a_time() {
        let event = Event::script(
            EventData {
                kind: JsString::from("tick"),
                cancelable: true,
                interface: Some("MouseEvent"),
                ..Default::default()
            },
            None,
        );
        assert!(!event.is_trusted());
        assert_eq!(event.target(), None);
        assert!(event.begin_dispatch(Element(4)));
        assert!(!event.begin_dispatch(Element(4)));
        let was = event.set_passive(true);
        event.prevent_default();
        event.set_passive(was);
        assert!(!event.default_prevented());
        event.stop_propagation();
        event.prevent_default();
        event.end_dispatch();
        assert!(event.default_prevented());
        assert!(!event.propagation_stopped());
        assert_eq!(event.target(), Some(Element(4)));
        assert_eq!(event.data().member_unsupported("clientX"), None);
        assert!(event.data().member_unsupported("key").is_some());
        assert!(event.begin_dispatch(Element(5)));
    }

    /// `composedPath()[0]`: the target during the dispatch, also while a
    /// listener on an ancestor runs; nothing once it is over.
    #[test]
    fn path_target_is_the_target_while_dispatching() {
        let event = Event::new(EventData {
            kind: JsString::from("pointerdown"),
            target: Element(7),
            ..Default::default()
        });
        assert_eq!(event.path_target(), Some(Element(7)));
        assert!(event.enter(Element(3), false));
        assert_eq!(event.path_target(), Some(Element(7)));
        event.finish();
        assert_eq!(event.path_target(), None);
    }

    /// `stopPropagation` lets only the rest of the running invocation (one
    /// per node and phase) run, as Chromium 153 does: a capture listener's
    /// stop keeps its node's bubbling-phase listeners from running, at the
    /// target too; `stopImmediatePropagation` stops the invocation itself;
    /// a stop before `dispatchEvent` lets nothing run.
    #[test]
    fn a_stop_ends_propagation_at_the_invocation() {
        let click = |target| {
            Event::new(EventData {
                kind: JsString::from("click"),
                target: Element(target),
                bubbles: true,
                ..Default::default()
            })
        };
        // A capture listener at an ancestor stops.
        let event = click(7);
        assert!(event.enter(Element(3), true));
        event.stop_propagation();
        assert!(event.enter(Element(3), true));
        assert!(!event.can_enter(Element(7), true));
        assert!(!event.can_enter(Element(7), false));
        assert!(!event.can_enter(Element(3), false));
        // At the target: its capture listeners finish, its others do not run.
        let event = click(7);
        assert!(event.enter(Element(7), true));
        event.stop_propagation();
        assert!(event.can_enter(Element(7), true));
        assert!(!event.can_enter(Element(7), false));
        // A bubbling listener's stop lets the rest of its node's run.
        let event = click(7);
        assert!(event.enter(Element(7), false));
        event.stop_propagation();
        assert!(event.enter(Element(7), false));
        assert!(!event.can_enter(Element(3), false));
        // stopImmediatePropagation.
        let event = click(7);
        assert!(event.enter(Element(3), true));
        event.stop_immediate_propagation();
        assert!(!event.can_enter(Element(3), true));
        // A delegation root's group is its bubbling-phase invocation.
        let event = click(7);
        assert!(event.enter(Element(1), true));
        event.stop_propagation();
        assert!(!event.enter_delegated(Element(1), Element(7), true));
        // Stopped before dispatchEvent: nothing runs.
        let event = Event::script(
            EventData {
                kind: JsString::from("click"),
                bubbles: true,
                ..Default::default()
            },
            None,
        );
        event.stop_propagation();
        assert!(event.begin_dispatch(Element(7)));
        assert!(!event.can_enter(Element(7), true));
        assert!(!event.can_enter(Element(7), false));
    }

    /// React's root groups (IR `schedule.rootDispatch`), as React 19 runs
    /// them in Chromium 153: a native stop earlier in the root's invocation
    /// does not skip the group; a stop in the group ends it and the event's
    /// propagation after the root's invocation; a linked event (a
    /// checkbox's `onChange` from the click) has a flag of its own and acts
    /// on the click when it stops or cancels.
    #[test]
    fn root_groups_have_their_own_stop() {
        let click = Event::new(EventData {
            kind: JsString::from("click"),
            target: Element(7),
            bubbles: true,
            cancelable: true,
            ..Default::default()
        });
        // A listener at the root, before the root's own, stops.
        assert!(click.enter(Element(1), false));
        click.stop_propagation();
        assert!(click.enter_root(Element(1), Element(7), true, false));
        assert!(click.enter_root(Element(1), Element(3), false, false));
        assert_eq!(click.current_target(), Some(Element(3)));
        // A handler of the group stops: the rest of the group is skipped,
        // the root's invocation finishes, later ones do not run.
        click.stop_propagation();
        assert!(!click.enter_root(Element(1), Element(2), false, false));
        assert!(click.can_enter(Element(1), false));
        assert!(!click.can_enter(Element::DOCUMENT, false));
        // The linked change event runs (its own flag), and its preventDefault
        // cancels the click.
        let change = Event::linked(
            EventData {
                kind: JsString::from("change"),
                target: Element(7),
                ..Default::default()
            },
            &click,
        );
        assert!(change.enter_root(Element(1), Element(7), true, false));
        change.prevent_default();
        assert!(click.default_prevented() && change.default_prevented());
        // In the capture phase: the group runs in the root's capturing
        // invocation; a stop there keeps the target's listeners from running.
        let down = Event::new(EventData {
            kind: JsString::from("mousedown"),
            target: Element(7),
            bubbles: true,
            ..Default::default()
        });
        assert!(down.enter_root(Element(1), Element(3), true, true));
        down.stop_propagation();
        assert!(down.can_enter(Element(1), true));
        assert!(!down.can_enter(Element(7), true));
        assert!(!down.enter_root(Element(1), Element(7), true, false));
    }
}
