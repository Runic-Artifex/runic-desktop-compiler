//! Opaque element handles (DOM refs): compared by identity, otherwise inert.
//! The native runtime stores Blitz node ids; the interpreter stable ids of
//! rendered elements.

use crate::{
    ArrayElement, JsString, MapKey, StrictEq, ToJsString, ToMapKey, ToNumber, Truthy, TypeOf,
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash)]
pub struct Element(pub u64);

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
