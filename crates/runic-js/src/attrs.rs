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

/// Two `class` values of a merging bag combined (`None`: absent): the earlier
/// value when both are equal, otherwise the non-empty trimmed values joined
/// by a space (Vue's `mergeProps`, whose `normalizeClass` trims each part).
pub fn class_merge(prev: Option<&JsString>, next: Option<&JsString>) -> Option<JsString> {
    if prev == next {
        return prev.cloned();
    }
    let mut units: Vec<u16> = vec![];
    for part in [prev, next].into_iter().flatten() {
        let t = crate::string_ops::trim(part);
        if !t.is_empty() {
            if !units.is_empty() {
                units.push(u16::from(b' '));
            }
            units.extend_from_slice(t.units());
        }
    }
    Some(JsString::from_units(units))
}

/// Adds an entry to a merging bag (`attrs` with `merge`): a name already
/// present combines with it in place (`class`: [`class_merge`]; other names:
/// the later value), a new name is appended.
pub fn attrs_merge<L>(v: &mut Vec<(JsString, AttrValue<L>)>, name: JsString, value: AttrValue<L>) {
    let text = |a: &AttrValue<L>| match a {
        AttrValue::Text(s) => Some(Some(s.clone())),
        AttrValue::Absent => Some(None),
        _ => None,
    };
    let slot = v.iter().position(|(n, _)| *n == name);
    // A missing `class` merges like an absent one.
    let prev = match slot {
        Some(i) => text(&v[i].1),
        None => Some(None),
    };
    let value = match (name == JsString::from("class"), prev, text(&value)) {
        (true, Some(a), Some(b)) => match class_merge(a.as_ref(), b.as_ref()) {
            Some(s) => AttrValue::Text(s),
            None => AttrValue::Absent,
        },
        _ => value,
    };
    match slot {
        Some(i) => v[i].1 = value,
        None => v.push((name, value)),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> JsString {
        JsString::from(x)
    }

    #[test]
    fn class_merge_like_vue_merge_props() {
        // normalizeClass([a, b]) unless a === b.
        assert_eq!(
            class_merge(Some(&s("btn x")), Some(&s("wide"))),
            Some(s("btn x wide"))
        );
        assert_eq!(class_merge(Some(&s("a")), Some(&s("a"))), Some(s("a")));
        assert_eq!(class_merge(None, Some(&s(" w "))), Some(s("w")));
        assert_eq!(class_merge(Some(&s(" a ")), Some(&s(""))), Some(s("a")));
        assert_eq!(class_merge(Some(&s("")), None), Some(s("")));
        assert_eq!(class_merge(None, None), None);
        assert_eq!(
            class_merge(Some(&s("a  b")), Some(&s("c"))),
            Some(s("a  b c"))
        );
    }

    #[test]
    fn merged_entries_combine_in_place() {
        let mut v: Vec<(JsString, AttrValue<()>)> = vec![];
        attrs_merge(&mut v, s("class"), AttrValue::Text(s("btn")));
        attrs_merge(&mut v, s("type"), AttrValue::Text(s("button")));
        attrs_merge(&mut v, s("class"), AttrValue::Text(s("wide")));
        attrs_merge(&mut v, s("type"), AttrValue::Text(s("submit")));
        attrs_merge(&mut v, s("hidden"), AttrValue::Flag(true));
        let names: Vec<String> = v.iter().map(|(n, _)| n.to_string()).collect();
        assert_eq!(names, ["class", "type", "hidden"]);
        assert!(matches!(&v[0].1, AttrValue::Text(t) if *t == s("btn wide")));
        assert!(matches!(&v[1].1, AttrValue::Text(t) if *t == s("submit")));
    }
}
