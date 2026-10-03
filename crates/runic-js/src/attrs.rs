//! Attribute bags (rest props and spread attributes, docs/design/M5-PLATFORM.md):
//! ordered entries, each an attribute value or a listener. Bags compare by
//! entries (listeners by the identity of their function value). `L` is the
//! generated app's listener type.

use crate::{JsString, MapKey, StrictEq, ToJsString, ToMapKey, Truthy, TypeOf};
use std::rc::Rc;

/// An entry's value.
#[derive(Clone, Debug)]
pub enum AttrValue<L> {
    Text(JsString),
    /// Removes the attribute.
    Absent,
    /// Present (empty) or removed.
    Flag(bool),
    /// An `on<event>` listener: the identity of its function value, and the listener.
    Listener(usize, L),
}

#[derive(Debug)]
pub struct Attrs<L>(Rc<Vec<(JsString, AttrValue<L>)>>);

impl<L> Clone for Attrs<L> {
    fn clone(&self) -> Self {
        Attrs(Rc::clone(&self.0))
    }
}

impl<L> Default for Attrs<L> {
    fn default() -> Self {
        Attrs(Rc::new(Vec::new()))
    }
}

impl<L> Attrs<L> {
    pub fn new(entries: Vec<(JsString, AttrValue<L>)>) -> Self {
        Attrs(Rc::new(entries))
    }
    pub fn entries(&self) -> &[(JsString, AttrValue<L>)] {
        &self.0
    }
    /// The entries that apply: the last of each name, in the order of the
    /// name's first occurrence.
    pub fn resolved(&self) -> Vec<(&JsString, &AttrValue<L>)> {
        let mut out: Vec<(&JsString, &AttrValue<L>)> = vec![];
        for (name, v) in self.0.iter() {
            match out.iter_mut().find(|(n, _)| *n == name) {
                Some(slot) => slot.1 = v,
                None => out.push((name, v)),
            }
        }
        out
    }
}

impl<L> StrictEq for Attrs<L> {
    fn strict_eq(&self, other: &Self) -> bool {
        self.0.len() == other.0.len()
            && self.0.iter().zip(other.0.iter()).all(|((n, a), (m, b))| {
                n == m
                    && match (a, b) {
                        (AttrValue::Text(x), AttrValue::Text(y)) => x == y,
                        (AttrValue::Absent, AttrValue::Absent) => true,
                        (AttrValue::Flag(x), AttrValue::Flag(y)) => x == y,
                        (AttrValue::Listener(x, _), AttrValue::Listener(y, _)) => x == y,
                        _ => false,
                    }
            })
    }
}
impl<L> Truthy for Attrs<L> {
    fn truthy(&self) -> bool {
        true
    }
}
impl<L> ToJsString for Attrs<L> {
    fn to_js_string(&self) -> JsString {
        JsString::from("[object Object]")
    }
}
impl<L> TypeOf for Attrs<L> {
    fn type_of(&self) -> &'static str {
        "object"
    }
}
impl<L> ToMapKey for Attrs<L> {
    fn map_key(&self) -> MapKey {
        MapKey::Ref(Rc::as_ptr(&self.0) as *const u8 as usize)
    }
}
impl<L> crate::Own for Attrs<L> {}
