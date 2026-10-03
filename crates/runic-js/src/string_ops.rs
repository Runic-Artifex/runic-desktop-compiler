//! Family B: `String.prototype` methods on UTF-16 `JsString`. Signatures are
//! frozen (docs/design/M2-VALUES.md); behaviour must match ECMAScript exactly
//! and is tested against Node-generated vectors (tests/vectors/string.json).
//! Positions and lengths are UTF-16 code units; numeric arguments go through
//! ToIntegerOrInfinity as the specification requires.
#![allow(unused_variables)]

use crate::{JsArray, JsResult, JsString, Maybe};
use std::cmp::Ordering;

/// `s.at(i)`
pub fn at(s: &JsString, i: f64) -> Maybe<JsString> { todo!("family B") }
/// `s[i]` (property access; undefined out of range or for non-integral i)
pub fn index(s: &JsString, i: f64) -> Maybe<JsString> { todo!("family B") }
pub fn char_at(s: &JsString, i: f64) -> JsString { todo!("family B") }
pub fn char_code_at(s: &JsString, i: f64) -> f64 { todo!("family B") }
pub fn code_point_at(s: &JsString, i: f64) -> Maybe<f64> { todo!("family B") }
pub fn slice(s: &JsString, start: f64, end: Maybe<f64>) -> JsString { todo!("family B") }
pub fn substring(s: &JsString, start: f64, end: Maybe<f64>) -> JsString { todo!("family B") }
pub fn index_of(s: &JsString, search: &JsString, from: Maybe<f64>) -> f64 { todo!("family B") }
pub fn last_index_of(s: &JsString, search: &JsString, from: Maybe<f64>) -> f64 { todo!("family B") }
pub fn includes(s: &JsString, search: &JsString, from: Maybe<f64>) -> bool { todo!("family B") }
pub fn starts_with(s: &JsString, search: &JsString, from: Maybe<f64>) -> bool { todo!("family B") }
pub fn ends_with(s: &JsString, search: &JsString, end: Maybe<f64>) -> bool { todo!("family B") }
/// White space and line terminators per ECMA-262 (incl. U+FEFF, U+00A0, Zs).
pub fn trim(s: &JsString) -> JsString { todo!("family B") }
pub fn trim_start(s: &JsString) -> JsString { todo!("family B") }
pub fn trim_end(s: &JsString) -> JsString { todo!("family B") }
/// Unicode default case conversion (incl. special casing such as ß → SS).
pub fn to_upper_case(s: &JsString) -> JsString { todo!("family B") }
pub fn to_lower_case(s: &JsString) -> JsString { todo!("family B") }
pub fn pad_start(s: &JsString, length: f64, fill: Maybe<JsString>) -> JsString { todo!("family B") }
pub fn pad_end(s: &JsString, length: f64, fill: Maybe<JsString>) -> JsString { todo!("family B") }
/// RangeError for negative or infinite counts.
pub fn repeat(s: &JsString, count: f64) -> JsResult<JsString> { todo!("family B") }
/// String separators only (RegExp separators are M5); `undefined` separator → [s].
pub fn split(s: &JsString, separator: Maybe<JsString>, limit: Maybe<f64>) -> JsArray<JsString> { todo!("family B") }
/// String patterns with GetSubstitution (`$$`, `$&`, `` $` ``, `$'`).
pub fn replace(s: &JsString, pattern: &JsString, replacement: &JsString) -> JsString { todo!("family B") }
pub fn replace_all(s: &JsString, pattern: &JsString, replacement: &JsString) -> JsString { todo!("family B") }
pub fn concat(s: &JsString, others: &[JsString]) -> JsString { todo!("family B") }
/// Relational comparison of strings (`<`): code-unit order.
pub fn compare(a: &JsString, b: &JsString) -> Ordering { todo!("family B") }
/// `localeCompare` without locales: M2 uses code-unit order, returning -1/0/1.
pub fn locale_compare(a: &JsString, b: &JsString) -> f64 { todo!("family B") }
pub fn from_char_code(units: &[f64]) -> JsString { todo!("family B") }
/// Code points of a string (string iterator / `Array.from(s)` / `for-of`).
pub fn code_points(s: &JsString) -> Vec<JsString> { todo!("family B") }
