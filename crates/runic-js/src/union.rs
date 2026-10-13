//! Values of IR union types (`{"union": [...]}`, docs/IR.md): a number, a
//! string, a boolean, an element or a value of one record type, carrying
//! which one it is, as a JavaScript value does. Every operation is the
//! member's: `typeof`, truthiness, string and number conversion, `===`
//! (values of different members are never strictly equal) and map keys.
//! The IR type says which members a value can be; the record member is the
//! type parameter (`NoRecord` where the union has none).

use crate::{
    ArrayElement, Element, JsString, MapKey, Own, StrictEq, ToJsString, ToMapKey, ToNumber, Truthy,
    TypeOf,
};

/// A value of a union type.
#[derive(Clone, Debug)]
pub enum Union<R> {
    Number(f64),
    String(JsString),
    Boolean(bool),
    Element(Element),
    Record(R),
}

/// The TypeError message of a downcast of a union value of member `have`
/// (`number`, `string`, `boolean`, `element`, `object`) to members `want`
/// (only where the source's static types were unsound).
pub fn union_message(have: &str, want: &[String]) -> String {
    format!(
        "A {have} where the static type expects {}",
        want.join(" | ")
    )
}

/// The record member of a union without one: no value has it.
#[derive(Clone, Debug)]
pub enum NoRecord {}

impl<R: StrictEq> PartialEq for Union<R> {
    fn eq(&self, other: &Self) -> bool {
        self.strict_eq(other)
    }
}

impl<R: StrictEq> StrictEq for Union<R> {
    fn strict_eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Union::Number(a), Union::Number(b)) => a.strict_eq(b),
            (Union::String(a), Union::String(b)) => a.strict_eq(b),
            (Union::Boolean(a), Union::Boolean(b)) => a.strict_eq(b),
            (Union::Element(a), Union::Element(b)) => a.strict_eq(b),
            (Union::Record(a), Union::Record(b)) => a.strict_eq(b),
            _ => false,
        }
    }
}

macro_rules! delegate {
    ($trait:ident, $method:ident, $out:ty) => {
        impl<R: $trait> $trait for Union<R> {
            fn $method(&self) -> $out {
                match self {
                    Union::Number(v) => v.$method(),
                    Union::String(v) => v.$method(),
                    Union::Boolean(v) => v.$method(),
                    Union::Element(v) => v.$method(),
                    Union::Record(v) => v.$method(),
                }
            }
        }
        impl $trait for NoRecord {
            fn $method(&self) -> $out {
                match *self {}
            }
        }
    };
}

delegate!(Truthy, truthy, bool);
delegate!(TypeOf, type_of, &'static str);
delegate!(ToJsString, to_js_string, JsString);
delegate!(ToNumber, to_number, f64);
delegate!(ToMapKey, map_key, MapKey);

impl<R: ArrayElement> ArrayElement for Union<R> {
    fn join_string(&self) -> JsString {
        match self {
            Union::Number(v) => v.join_string(),
            Union::String(v) => v.join_string(),
            Union::Boolean(v) => v.join_string(),
            Union::Element(v) => v.join_string(),
            Union::Record(v) => v.join_string(),
        }
    }
}
impl ArrayElement for NoRecord {
    fn join_string(&self) -> JsString {
        match *self {}
    }
}

impl StrictEq for NoRecord {
    fn strict_eq(&self, _: &Self) -> bool {
        match *self {}
    }
}

/// Stored into deep state: the record member is proxied as a record is.
impl<R: Own> Own for Union<R> {
    fn own(self) -> Self {
        match self {
            Union::Record(r) => Union::Record(r.own()),
            other => other,
        }
    }
    fn mark(&self) {
        if let Union::Record(r) = self {
            r.mark();
        }
    }
}
impl Own for NoRecord {}

#[cfg(test)]
mod tests {
    use super::*;

    type U = Union<NoRecord>;

    #[test]
    fn members_keep_their_semantics() {
        let n: U = Union::Number(0.0);
        let s: U = Union::String(JsString::from("0"));
        assert_eq!(n.type_of(), "number");
        assert_eq!(s.type_of(), "string");
        assert!(!n.truthy());
        assert!(s.truthy());
        assert_eq!(n.to_js_string(), JsString::from("0"));
        assert_eq!(s.to_number(), 0.0);
        // `0 === "0"` is false; NaN is not NaN.
        assert!(!n.strict_eq(&s));
        let nan: U = Union::Number(f64::NAN);
        assert!(!nan.strict_eq(&nan.clone()));
        assert!(
            Union::<NoRecord>::String(JsString::from("a"))
                .strict_eq(&Union::String(JsString::from("a")))
        );
        assert_ne!(n.map_key(), s.map_key());
    }
}
