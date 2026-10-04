//! Attribute bags (rest props and spread attributes, docs/design/M5-PLATFORM.md):
//! ordered entries, each an attribute value or a listener. Bags compare by
//! entries (listeners by the identity of their function value). `L` is the
//! generated app's listener type.

use crate::{JsString, MapKey, StrictEq, ToJsString, ToMapKey, Truthy, TypeOf};
use std::any::Any;
use std::rc::Rc;

/// An entry's value.
#[derive(Clone)]
pub enum AttrValue<L> {
    Text(JsString),
    /// Removes the attribute (`undefined`).
    Absent,
    /// Removes the attribute (`null`; merging tells it from `undefined`).
    Null,
    /// Present (empty) or removed.
    Flag(bool),
    /// An `on<event>` listener: the identity of its function value, and the listener.
    Listener(usize, L),
    /// A function under a name that is no event attribute (a callback for a
    /// component that declares it, M6): its identity and the function, in
    /// the generated app's type-erased calling convention.
    Callback(usize, Rc<dyn Any>),
    /// A style object: property names and values (`None`: undefined).
    Style(Vec<(String, Option<JsString>)>),
    /// An attachment (under an [`ATTACHMENT`] name): the function, in the
    /// generated app's representation.
    Attach(Rc<dyn Any>),
}

impl<L> std::fmt::Debug for AttrValue<L> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AttrValue::Text(s) => write!(f, "Text({s})"),
            AttrValue::Absent => write!(f, "Absent"),
            AttrValue::Null => write!(f, "Null"),
            AttrValue::Flag(b) => write!(f, "Flag({b})"),
            AttrValue::Listener(id, _) => write!(f, "Listener({id})"),
            AttrValue::Callback(id, _) => write!(f, "Callback({id})"),
            AttrValue::Style(s) => write!(f, "Style({s:?})"),
            AttrValue::Attach(a) => write!(f, "Attach({:p})", Rc::as_ptr(a)),
        }
    }
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
        AttrValue::Absent | AttrValue::Null => Some(None),
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

/// The name prefix of attachment entries in attribute bags (M6): each
/// attachment has a key of its own (a fresh symbol in JavaScript); no
/// attribute name starts with it.
pub const ATTACHMENT: &str = "\0attach:";

thread_local! {
    static ATTACHMENT_KEYS: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

/// A fresh attachment key (`createAttachmentKey()`): [`ATTACHMENT`] and a
/// counter, as the reference interpreter numbers them.
pub fn attachment_key() -> JsString {
    ATTACHMENT_KEYS.with(|k| {
        k.set(k.get() + 1);
        JsString::from(format!("{ATTACHMENT}{}", k.get()))
    })
}

/// Attributes a spread sets through the element's boolean property when
/// given a boolean (Svelte's `set_attributes` uses the element's setter);
/// with `spreadBooleanText`, other names get the text "true" or "false".
pub const BOOLEAN_PROPERTIES: &[&str] = &[
    "disabled",
    "readonly",
    "hidden",
    "required",
    "checked",
    "autofocus",
    "multiple",
    "open",
];

/// What a bag value is, for [`merge_props`].
pub enum MergeKind {
    Undefined,
    Null,
    Text(JsString),
    Flag(bool),
    /// A function (an event listener, possibly composed).
    Function,
    /// A style object: property names and values (`None`: undefined).
    Style(Vec<(String, Option<JsString>)>),
}

/// The value operations [`merge_props`] needs from a bag representation.
pub trait MergeOps<V> {
    fn kind(&self, v: &V) -> MergeKind;
    fn text(&self, s: JsString) -> V;
    /// A listener running `listeners` in turn, none once the event was
    /// cancelled (`composeHandlers`).
    fn compose(&self, listeners: Vec<V>) -> V;
    /// The listeners a function value runs (itself, or a composition's).
    fn listeners(&self, v: &V) -> Vec<V>;
}

/// The keys svelte-toolbelt 0.10.6 treats as event handlers
/// (dist/utils/event-list.js).
const EVENT_LIST: &[&str] = &[
    "onabort",
    "onanimationcancel",
    "onanimationend",
    "onanimationiteration",
    "onanimationstart",
    "onauxclick",
    "onbeforeinput",
    "onbeforetoggle",
    "onblur",
    "oncancel",
    "oncanplay",
    "oncanplaythrough",
    "onchange",
    "onclick",
    "onclose",
    "oncompositionend",
    "oncompositionstart",
    "oncompositionupdate",
    "oncontextlost",
    "oncontextmenu",
    "oncontextrestored",
    "oncopy",
    "oncuechange",
    "oncut",
    "ondblclick",
    "ondrag",
    "ondragend",
    "ondragenter",
    "ondragleave",
    "ondragover",
    "ondragstart",
    "ondrop",
    "ondurationchange",
    "onemptied",
    "onended",
    "onerror",
    "onfocus",
    "onfocusin",
    "onfocusout",
    "onformdata",
    "ongotpointercapture",
    "oninput",
    "oninvalid",
    "onkeydown",
    "onkeypress",
    "onkeyup",
    "onload",
    "onloadeddata",
    "onloadedmetadata",
    "onloadstart",
    "onlostpointercapture",
    "onmousedown",
    "onmouseenter",
    "onmouseleave",
    "onmousemove",
    "onmouseout",
    "onmouseover",
    "onmouseup",
    "onpaste",
    "onpause",
    "onplay",
    "onplaying",
    "onpointercancel",
    "onpointerdown",
    "onpointerenter",
    "onpointerleave",
    "onpointermove",
    "onpointerout",
    "onpointerover",
    "onpointerup",
    "onprogress",
    "onratechange",
    "onreset",
    "onresize",
    "onscroll",
    "onscrollend",
    "onsecuritypolicyviolation",
    "onseeked",
    "onseeking",
    "onselect",
    "onselectionchange",
    "onselectstart",
    "onslotchange",
    "onstalled",
    "onsubmit",
    "onsuspend",
    "ontimeupdate",
    "ontoggle",
    "ontouchcancel",
    "ontouchend",
    "ontouchmove",
    "ontouchstart",
    "ontransitioncancel",
    "ontransitionend",
    "ontransitionrun",
    "ontransitionstart",
    "onvolumechange",
    "onwaiting",
    "onwebkitanimationend",
    "onwebkitanimationiteration",
    "onwebkitanimationstart",
    "onwebkittransitionend",
    "onwheel",
];

/// A value of a merged entry: a bag value, or a style object being merged.
enum Slot<V> {
    Value(V),
    Style(Vec<(String, Option<JsString>)>),
}

/// The entries of `bag` that apply: the last of each name, in the order of
/// the name's first occurrence.
pub fn resolve_entries<V: Clone>(bag: &[(String, V)]) -> Vec<(String, V)> {
    let mut out: Vec<(String, V)> = vec![];
    for (name, v) in bag {
        match out.iter_mut().find(|(n, _)| n == name) {
            Some(slot) => slot.1 = v.clone(),
            None => out.push((name.clone(), v.clone())),
        }
    }
    out
}

/// svelte-toolbelt 0.10.6's `mergeProps(...bags)` (dist/utils/merge-props.js)
/// over the bags' entries (each list as written; a later entry of a name
/// wins within a bag):
///
/// - the result starts as the first bag;
/// - for each later bag's string keys, in order: a function under an event
///   key (`EVENT_LIST`) composes with the new value (`composeHandlers`);
///   `class` values join as clsx joins strings (falsy ones skipped); `style`
///   objects merge (later properties win) and become a style string at the
///   end (`name: value;` joined by spaces, `undefined` printed); otherwise the
///   new value wins unless it is undefined;
/// - attachment keys: the new value wins unless undefined;
/// - `hidden` and `disabled` that are `false` are removed.
///
/// Not covered (an error): two non-event functions under one key
/// (`executeCallbacks`), and a style string meeting another style value
/// (parsed by `style-to-object`).
pub fn merge_props<V: Clone>(
    bags: &[Vec<(String, V)>],
    ops: &impl MergeOps<V>,
) -> Result<Vec<(String, V)>, String> {
    let undefined = |s: &Option<&Slot<V>>| match s {
        None => true,
        Some(Slot::Value(v)) => matches!(ops.kind(v), MergeKind::Undefined),
        Some(Slot::Style(_)) => false,
    };
    let mut result: Vec<(String, Slot<V>)> = match bags.first() {
        Some(b) => resolve_entries(b)
            .into_iter()
            .map(|(k, v)| (k, Slot::Value(v)))
            .collect(),
        None => vec![],
    };
    let set = |result: &mut Vec<(String, Slot<V>)>, key: &str, v: Slot<V>| match result
        .iter_mut()
        .find(|(k, _)| k == key)
    {
        Some(slot) => slot.1 = v,
        None => result.push((key.to_string(), v)),
    };
    for bag in bags.iter().skip(1) {
        let entries = resolve_entries(bag);
        let (strings, symbols): (Vec<_>, Vec<_>) = entries
            .into_iter()
            .partition(|(k, _)| !k.starts_with(ATTACHMENT));
        for (key, b) in strings {
            let a = result.iter().find(|(k, _)| *k == key).map(|(_, s)| s);
            let kind_a = match a {
                Some(Slot::Value(v)) => Some(ops.kind(v)),
                Some(Slot::Style(s)) => Some(MergeKind::Style(s.clone())),
                None => None,
            };
            let kind_b = ops.kind(&b);
            let a_fn = matches!(kind_a, Some(MergeKind::Function));
            let b_fn = matches!(kind_b, MergeKind::Function);
            if a_fn && EVENT_LIST.contains(&key.as_str()) {
                let Some(Slot::Value(av)) = a else {
                    unreachable!()
                };
                let mut fs = ops.listeners(av);
                if b_fn {
                    fs.extend(ops.listeners(&b));
                }
                let composed = ops.compose(fs);
                set(&mut result, &key, Slot::Value(composed));
            } else if a_fn && b_fn {
                return Err(format!(
                    "merging two functions under {key} (svelte-toolbelt's executeCallbacks) is not covered"
                ));
            } else if key == "class" {
                // clsx over strings: truthy strings joined by a space.
                let class_value = |k: &Option<MergeKind>| {
                    !matches!(k, Some(MergeKind::Function) | Some(MergeKind::Style(_)))
                };
                let part = |k: &Option<MergeKind>| match k {
                    Some(MergeKind::Text(s)) if !s.is_empty() => Some(s.clone()),
                    _ => None,
                };
                let kb = Some(kind_b);
                let parts: Vec<JsString> = match (class_value(&kind_a), class_value(&kb)) {
                    (true, true) => [part(&kind_a), part(&kb)].into_iter().flatten().collect(),
                    (true, false) => part(&kind_a).into_iter().collect(),
                    (false, true) => part(&kb).into_iter().collect(),
                    (false, false) => continue,
                };
                let mut units: Vec<u16> = vec![];
                for (i, p) in parts.iter().enumerate() {
                    if i > 0 {
                        units.push(u16::from(b' '));
                    }
                    units.extend_from_slice(p.units());
                }
                set(
                    &mut result,
                    &key,
                    Slot::Value(ops.text(JsString::from_units(units))),
                );
            } else if key == "style" {
                // `typeof null` is "object": null merges as an empty object.
                let object = |k: &Option<MergeKind>| match k {
                    Some(MergeKind::Style(s)) => Some(s.clone()),
                    Some(MergeKind::Null) => Some(vec![]),
                    _ => None,
                };
                let string = |k: &Option<MergeKind>| matches!(k, Some(MergeKind::Text(_)));
                let kb = Some(kind_b);
                match (object(&kind_a), object(&kb), string(&kind_a), string(&kb)) {
                    (Some(mut x), Some(y), _, _) => {
                        for (name, v) in y {
                            match x.iter_mut().find(|(n, _)| *n == name) {
                                Some(slot) => slot.1 = v,
                                None => x.push((name, v)),
                            }
                        }
                        set(&mut result, &key, Slot::Style(x));
                    }
                    (Some(_), None, _, true)
                    | (None, Some(_), true, _)
                    | (None, None, true, true) => {
                        return Err(
                            "merging a style string with another style value (svelte-toolbelt's cssToStyleObj) is not covered"
                                .into(),
                        );
                    }
                    (Some(_), None, _, _) | (None, None, true, _) => {}
                    (None, Some(y), _, _) => set(&mut result, &key, Slot::Style(y)),
                    (None, None, false, true) => set(&mut result, &key, Slot::Value(b)),
                    (None, None, false, false) => {}
                }
            } else if !matches!(kind_b, MergeKind::Undefined) {
                set(&mut result, &key, Slot::Value(b));
            } else if a.is_none() {
                set(&mut result, &key, Slot::Value(b));
            }
        }
        for (key, b) in symbols {
            let a = result.iter().find(|(k, _)| *k == key).map(|(_, s)| s);
            if !matches!(ops.kind(&b), MergeKind::Undefined) || undefined(&a) && a.is_none() {
                set(&mut result, &key, Slot::Value(b));
            }
        }
    }
    let mut out = vec![];
    for (k, s) in result {
        let v = match s {
            Slot::Value(v) => {
                if k == "style" {
                    if let MergeKind::Style(entries) = ops.kind(&v) {
                        ops.text(style_text(&entries))
                    } else if matches!(ops.kind(&v), MergeKind::Null) {
                        return Err(
                            "a null style (styleToCSS throws a TypeError) is not covered".into(),
                        );
                    } else {
                        v
                    }
                } else {
                    v
                }
            }
            Slot::Style(entries) => ops.text(style_text(&entries)),
        };
        if (k == "hidden" || k == "disabled") && matches!(ops.kind(&v), MergeKind::Flag(false)) {
            continue;
        }
        out.push((k, v));
    }
    Ok(out)
}

/// svelte-toolbelt's `styleToString`: `name: value;` per property (camelCase
/// names in kebab case), joined by spaces; undefined values print as such.
fn style_text(entries: &[(String, Option<JsString>)]) -> JsString {
    let mut out = String::new();
    for (i, (name, v)) in entries.iter().enumerate() {
        if i > 0 {
            out.push(' ');
        }
        for c in name.chars() {
            if c.is_ascii_uppercase() {
                out.push('-');
                out.push(c.to_ascii_lowercase());
            } else {
                out.push(c);
            }
        }
        out.push_str(": ");
        match v {
            Some(s) => out.push_str(&s.to_rust()),
            None => out.push_str("undefined"),
        }
        out.push(';');
    }
    JsString::from(out)
}

impl<L> StrictEq for Attrs<L> {
    fn strict_eq(&self, other: &Self) -> bool {
        self.0.len() == other.0.len()
            && self.0.iter().zip(other.0.iter()).all(|((n, a), (m, b))| {
                n == m
                    && match (a, b) {
                        (AttrValue::Text(x), AttrValue::Text(y)) => x == y,
                        (AttrValue::Absent, AttrValue::Absent)
                        | (AttrValue::Null, AttrValue::Null) => true,
                        (AttrValue::Callback(x, _), AttrValue::Callback(y, _)) => x == y,
                        (AttrValue::Style(x), AttrValue::Style(y)) => x == y,
                        (AttrValue::Attach(x), AttrValue::Attach(y)) => Rc::ptr_eq(x, y),
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
