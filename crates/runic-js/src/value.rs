//! Conversions and comparisons shared by generated code and the reference
//! interpreter: truthiness, `typeof`, ToString, ToNumber, strict equality and
//! `Maybe` (values that may be `undefined` or `null`).

use crate::{JsRef, JsString, Throw, number_to_string, string_to_number};

/// `T | null | undefined`, keeping null and undefined distinct.
#[derive(Clone, Debug, PartialEq, Default)]
pub enum Maybe<T> {
    #[default]
    Undefined,
    Null,
    Some(T),
}

impl<T> Maybe<T> {
    pub fn is_nullish(&self) -> bool {
        !matches!(self, Maybe::Some(_))
    }
    pub fn is_null(&self) -> bool {
        matches!(self, Maybe::Null)
    }
    pub fn is_undefined(&self) -> bool {
        matches!(self, Maybe::Undefined)
    }
    /// `x ?? fallback`
    pub fn or_else(self, fallback: impl FnOnce() -> T) -> T {
        match self {
            Maybe::Some(v) => v,
            _ => fallback(),
        }
    }
    /// Member access on a nullish value throws a TypeError.
    pub fn unwrap_js(self) -> Result<T, Throw> {
        match self {
            Maybe::Some(v) => Ok(v),
            Maybe::Undefined => Err(Throw::type_error("Cannot read properties of undefined")),
            Maybe::Null => Err(Throw::type_error("Cannot read properties of null")),
        }
    }
    pub fn as_option(&self) -> Option<&T> {
        match self {
            Maybe::Some(v) => Some(v),
            _ => None,
        }
    }
}

/// ToBoolean.
pub trait Truthy {
    fn truthy(&self) -> bool;
}
impl Truthy for f64 {
    fn truthy(&self) -> bool {
        *self != 0.0 && !self.is_nan()
    }
}
impl Truthy for bool {
    fn truthy(&self) -> bool {
        *self
    }
}
impl Truthy for JsString {
    fn truthy(&self) -> bool {
        !self.is_empty()
    }
}
impl<T> Truthy for JsRef<T> {
    fn truthy(&self) -> bool {
        true
    }
}
impl<T: Truthy> Truthy for Maybe<T> {
    fn truthy(&self) -> bool {
        match self {
            Maybe::Some(v) => v.truthy(),
            _ => false,
        }
    }
}

/// ToString as used by `String(x)`, template literals and `+` concatenation.
pub trait ToJsString {
    fn to_js_string(&self) -> JsString;
}
impl ToJsString for f64 {
    fn to_js_string(&self) -> JsString {
        JsString::from(number_to_string(*self))
    }
}
impl ToJsString for bool {
    fn to_js_string(&self) -> JsString {
        JsString::from(if *self { "true" } else { "false" })
    }
}
impl ToJsString for JsString {
    fn to_js_string(&self) -> JsString {
        self.clone()
    }
}
impl<T: ToJsString> ToJsString for Maybe<T> {
    fn to_js_string(&self) -> JsString {
        match self {
            Maybe::Some(v) => v.to_js_string(),
            Maybe::Null => JsString::from("null"),
            Maybe::Undefined => JsString::from("undefined"),
        }
    }
}
/// Heap values convert through their contents (arrays join, records
/// stringify as `[object Object]`).
pub trait HeapToString {
    fn heap_to_string(&self) -> JsString;
}
impl<T: HeapToString> ToJsString for JsRef<T> {
    fn to_js_string(&self) -> JsString {
        self.borrow().heap_to_string()
    }
}
impl<T: ArrayElement> HeapToString for Vec<T> {
    fn heap_to_string(&self) -> JsString {
        crate::join_elements(self, &JsString::from(","))
    }
}

/// How an element appears in `Array.prototype.join`/`toString` (nullish → "").
pub trait ArrayElement {
    fn join_string(&self) -> JsString;
}
impl ArrayElement for f64 {
    fn join_string(&self) -> JsString {
        self.to_js_string()
    }
}
impl ArrayElement for bool {
    fn join_string(&self) -> JsString {
        self.to_js_string()
    }
}
impl ArrayElement for JsString {
    fn join_string(&self) -> JsString {
        self.clone()
    }
}
impl<T: HeapToString> ArrayElement for JsRef<T> {
    fn join_string(&self) -> JsString {
        self.to_js_string()
    }
}
impl<T: ArrayElement> ArrayElement for Maybe<T> {
    fn join_string(&self) -> JsString {
        match self {
            Maybe::Some(v) => v.join_string(),
            _ => JsString::new(),
        }
    }
}

/// ToNumber.
pub trait ToNumber {
    fn to_number(&self) -> f64;
}
impl ToNumber for f64 {
    fn to_number(&self) -> f64 {
        *self
    }
}
impl ToNumber for bool {
    fn to_number(&self) -> f64 {
        if *self { 1.0 } else { 0.0 }
    }
}
impl ToNumber for JsString {
    fn to_number(&self) -> f64 {
        string_to_number(self)
    }
}
impl<T: ToNumber> ToNumber for Maybe<T> {
    fn to_number(&self) -> f64 {
        match self {
            Maybe::Some(v) => v.to_number(),
            Maybe::Null => 0.0,
            Maybe::Undefined => f64::NAN,
        }
    }
}

/// `typeof`.
pub trait TypeOf {
    fn type_of(&self) -> &'static str;
}
impl TypeOf for f64 {
    fn type_of(&self) -> &'static str {
        "number"
    }
}
impl TypeOf for bool {
    fn type_of(&self) -> &'static str {
        "boolean"
    }
}
impl TypeOf for JsString {
    fn type_of(&self) -> &'static str {
        "string"
    }
}
impl<T> TypeOf for JsRef<T> {
    fn type_of(&self) -> &'static str {
        "object"
    }
}
impl<T: TypeOf> TypeOf for Maybe<T> {
    fn type_of(&self) -> &'static str {
        match self {
            Maybe::Some(v) => v.type_of(),
            Maybe::Null => "object",
            Maybe::Undefined => "undefined",
        }
    }
}

/// `===` (IsStrictlyEqual) between values of one static type.
pub trait StrictEq {
    fn strict_eq(&self, other: &Self) -> bool;
}
impl StrictEq for f64 {
    fn strict_eq(&self, other: &Self) -> bool {
        self == other
    }
}
impl StrictEq for bool {
    fn strict_eq(&self, other: &Self) -> bool {
        self == other
    }
}
impl StrictEq for JsString {
    fn strict_eq(&self, other: &Self) -> bool {
        self == other
    }
}
impl<T> StrictEq for JsRef<T> {
    fn strict_eq(&self, other: &Self) -> bool {
        JsRef::ptr_eq(self, other)
    }
}
impl<T: StrictEq> StrictEq for Maybe<T> {
    fn strict_eq(&self, other: &Self) -> bool {
        match (self, other) {
            (Maybe::Some(a), Maybe::Some(b)) => a.strict_eq(b),
            (Maybe::Null, Maybe::Null) | (Maybe::Undefined, Maybe::Undefined) => true,
            _ => false,
        }
    }
}
