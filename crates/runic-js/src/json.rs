//! Family D: JSON. Signatures are frozen (docs/design/M2-VALUES.md);
//! behaviour must match ECMAScript `JSON.stringify`/`JSON.parse` exactly
//! (output text; error type) and is tested against Node-generated vectors
//! (tests/vectors/json.json). Error message texts are V8-like but not
//! guaranteed identical.
#![allow(unused_variables)]

use crate::{JsArray, JsResult, JsString, Maybe};

/// A JSON value. Object members keep insertion order.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(JsString),
    Array(Vec<Json>),
    Object(Vec<(JsString, Json)>),
}

/// QuoteJSONString (escapes lone surrogates as \uXXXX).
pub fn quote(s: &JsString) -> JsString { todo!("family D") }
/// SerializeJSONProperty over an already converted value; `indent` is the
/// `space` argument (number clamped to 10, or the first 10 units of a string).
pub fn stringify(v: &Json, indent: &Indent) -> JsString { todo!("family D") }
#[derive(Clone, Debug, Default)]
pub enum Indent {
    #[default]
    None,
    Spaces(f64),
    Text(JsString),
}
/// JSON.parse; SyntaxError on invalid input. Duplicate keys: last wins (in
/// the first key's position, as in V8).
pub fn parse(text: &JsString) -> JsResult<Json> { todo!("family D") }

/// Conversion of typed values for stringify; `None` is `undefined`
/// (omitted from objects, `null` inside arrays).
pub trait ToJson {
    fn to_json(&self) -> Option<Json>;
}
impl ToJson for f64 {
    fn to_json(&self) -> Option<Json> { todo!("family D: non-finite numbers become null") }
}
impl ToJson for bool {
    fn to_json(&self) -> Option<Json> { todo!("family D") }
}
impl ToJson for JsString {
    fn to_json(&self) -> Option<Json> { todo!("family D") }
}
impl<T: ToJson> ToJson for Maybe<T> {
    fn to_json(&self) -> Option<Json> { todo!("family D") }
}
impl<T: ToJson> ToJson for JsArray<T> {
    fn to_json(&self) -> Option<Json> { todo!("family D") }
}

/// Typed reading of parsed JSON with shape checks; a mismatch throws a
/// SyntaxError naming the expected type (our addition to JSON.parse).
pub trait FromJson: Sized {
    fn from_json(j: &Json) -> JsResult<Self>;
}
impl FromJson for f64 {
    fn from_json(j: &Json) -> JsResult<Self> { todo!("family D") }
}
impl FromJson for bool {
    fn from_json(j: &Json) -> JsResult<Self> { todo!("family D") }
}
impl FromJson for JsString {
    fn from_json(j: &Json) -> JsResult<Self> { todo!("family D") }
}
impl<T: FromJson> FromJson for Maybe<T> {
    fn from_json(j: &Json) -> JsResult<Self> { todo!("family D: null → Null") }
}
impl<T: FromJson> FromJson for JsArray<T> {
    fn from_json(j: &Json) -> JsResult<Self> { todo!("family D") }
}
