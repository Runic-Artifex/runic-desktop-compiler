//! Opaque element handles (DOM refs): compared by identity, otherwise inert.
//! The native runtime stores Blitz node ids; the interpreter stable ids of
//! rendered elements.

use crate::{
    ArrayElement, JsString, MapKey, StrictEq, ToJsString, ToMapKey, ToNumber, Truthy, TypeOf,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Element(pub u64);

impl Element {
    /// The document and the window as event targets (`currentTarget` of
    /// their listeners).
    pub const DOCUMENT: Element = Element(u64::MAX - 1);
    pub const WINDOW: Element = Element(u64::MAX);
    /// The body element where the interpreter has no node for it
    /// (`document.body`, where imperative mounts append; M6). The native
    /// runtime uses Blitz's node.
    pub const BODY: Element = Element(u64::MAX - 2);
    /// The window's visual viewport (M6 overlays: its `resize` listeners).
    pub const VISUAL_VIEWPORT: Element = Element(u64::MAX - 3);
    /// The document element where the interpreter has no node for it
    /// (M6: `getComputedStyle(document.documentElement)`). The native
    /// runtime uses Blitz's node.
    pub const HTML: Element = Element(u64::MAX - 4);

    /// Whether this is an element: not the document, the window or the
    /// visual viewport, which are event targets of the same handle type.
    pub fn is_element(self) -> bool {
        !matches!(
            self,
            Element::DOCUMENT | Element::WINDOW | Element::VISUAL_VIEWPORT
        )
    }
}

/// An opaque host object compared by identity (M6 overlays: imperatively
/// mounted component instances and context maps). Generated apps keep
/// their own state behind it.
#[derive(Clone)]
pub struct Handle(pub std::rc::Rc<dyn std::any::Any>);

impl Handle {
    pub fn new<T: 'static>(v: T) -> Self {
        Handle(std::rc::Rc::new(v))
    }
    pub fn downcast<T: 'static>(&self) -> Option<&T> {
        self.0.downcast_ref::<T>()
    }
    /// A key identifying the object (identity).
    pub fn id(&self) -> usize {
        std::rc::Rc::as_ptr(&self.0) as *const () as usize
    }
}

impl std::fmt::Debug for Handle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Handle({:#x})", self.id())
    }
}
impl PartialEq for Handle {
    fn eq(&self, other: &Self) -> bool {
        self.id() == other.id()
    }
}
impl Truthy for Handle {
    fn truthy(&self) -> bool {
        true
    }
}
impl ToJsString for Handle {
    fn to_js_string(&self) -> JsString {
        JsString::from("[object Object]")
    }
}
impl ArrayElement for Handle {
    fn join_string(&self) -> JsString {
        self.to_js_string()
    }
}
impl ToNumber for Handle {
    fn to_number(&self) -> f64 {
        f64::NAN
    }
}
impl TypeOf for Handle {
    fn type_of(&self) -> &'static str {
        "object"
    }
}
impl StrictEq for Handle {
    fn strict_eq(&self, other: &Self) -> bool {
        self == other
    }
}
impl ToMapKey for Handle {
    fn map_key(&self) -> MapKey {
        MapKey::Ref(self.id())
    }
}
impl crate::Own for Handle {}

impl Truthy for Element {
    fn truthy(&self) -> bool {
        true
    }
}
impl ToJsString for Element {
    fn to_js_string(&self) -> JsString {
        JsString::from("[object HTMLElement]")
    }
}
impl ArrayElement for Element {
    fn join_string(&self) -> JsString {
        self.to_js_string()
    }
}
impl ToNumber for Element {
    fn to_number(&self) -> f64 {
        f64::NAN
    }
}
impl TypeOf for Element {
    fn type_of(&self) -> &'static str {
        "object"
    }
}
impl StrictEq for Element {
    fn strict_eq(&self, other: &Self) -> bool {
        self == other
    }
}
impl ToMapKey for Element {
    fn map_key(&self) -> MapKey {
        // Reference identity; element ids never collide with heap addresses
        // in one map because a map's key type is static.
        MapKey::Ref(self.0 as usize)
    }
}

/// `navigator.userAgent` (M6): the runtime's own, naming the desktop
/// platform it runs on (no browser engine; programs test it for platforms,
/// as bits-ui's `isIOS` does).
pub fn user_agent() -> &'static str {
    if cfg!(target_os = "windows") {
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Runic"
    } else if cfg!(target_os = "macos") {
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Runic"
    } else {
        "Mozilla/5.0 (X11; Linux x86_64) Runic"
    }
}
