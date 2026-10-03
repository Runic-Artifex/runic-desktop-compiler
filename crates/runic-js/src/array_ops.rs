//! Family C: `Array.prototype`, `Map` and `Set` operations. Signatures are
//! frozen (docs/design/M2-VALUES.md); behaviour must match ECMAScript exactly
//! and is tested against Node-generated vectors (tests/vectors/array.json).
//! Callbacks receive (element, index) and may throw; predicates return the
//! callback result's truthiness.
#![allow(unused_variables)]

use crate::{
    ArrayElement, JsArray, JsMap, JsResult, JsSet, JsString, MapKey, Maybe, StrictEq, ToMapKey,
};

/// `Array.prototype.join` over a slice (nullish elements → "").
pub fn join_elements<T: ArrayElement>(items: &[T], separator: &JsString) -> JsString {
    let mut out: Vec<u16> = Vec::new();
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.extend_from_slice(separator.units());
        }
        out.extend_from_slice(item.join_string().units());
    }
    JsString::from_units(out)
}

pub fn join<T: ArrayElement>(a: &JsArray<T>, separator: Maybe<JsString>) -> JsString { todo!("family C") }
pub fn length<T>(a: &JsArray<T>) -> f64 { a.borrow().len() as f64 }
/// `a[i]` when the static type admits undefined.
pub fn get<T: Clone>(a: &JsArray<T>, i: f64) -> Maybe<T> { todo!("family C") }
/// `a[i]` when TypeScript types it as `T`: out-of-range reads would produce
/// `undefined` in JavaScript, which the static value model cannot represent;
/// they throw a RangeError instead (documented deviation).
pub fn get_checked<T: Clone>(a: &JsArray<T>, i: f64) -> JsResult<T> { todo!("family C") }
/// `a[i] = v`; i == length appends; larger indices (holes) throw a RangeError.
pub fn set<T>(a: &JsArray<T>, i: f64, v: T) -> JsResult<()> { todo!("family C") }
pub fn at<T: Clone>(a: &JsArray<T>, i: f64) -> Maybe<T> { todo!("family C") }
pub fn push<T>(a: &JsArray<T>, items: Vec<T>) -> f64 { todo!("family C") }
pub fn pop<T>(a: &JsArray<T>) -> Maybe<T> { todo!("family C") }
pub fn shift<T>(a: &JsArray<T>) -> Maybe<T> { todo!("family C") }
pub fn unshift<T>(a: &JsArray<T>, items: Vec<T>) -> f64 { todo!("family C") }
pub fn slice<T: Clone>(a: &JsArray<T>, start: Maybe<f64>, end: Maybe<f64>) -> JsArray<T> { todo!("family C") }
pub fn splice<T: Clone>(a: &JsArray<T>, start: f64, delete_count: Maybe<f64>, items: Vec<T>) -> JsArray<T> { todo!("family C") }
pub enum ConcatArg<T> { Array(JsArray<T>), Item(T) }
pub fn concat<T: Clone>(a: &JsArray<T>, args: Vec<ConcatArg<T>>) -> JsArray<T> { todo!("family C") }
pub fn index_of<T: StrictEq>(a: &JsArray<T>, v: &T, from: Maybe<f64>) -> f64 { todo!("family C") }
pub fn last_index_of<T: StrictEq>(a: &JsArray<T>, v: &T, from: Maybe<f64>) -> f64 { todo!("family C") }
/// SameValueZero.
pub fn includes<T: ToMapKey>(a: &JsArray<T>, v: &T, from: Maybe<f64>) -> bool { todo!("family C") }
pub fn find<T: Clone>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<bool>) -> JsResult<Maybe<T>> { todo!("family C") }
pub fn find_index<T>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<bool>) -> JsResult<f64> { todo!("family C") }
pub fn find_last<T: Clone>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<bool>) -> JsResult<Maybe<T>> { todo!("family C") }
pub fn find_last_index<T>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<bool>) -> JsResult<f64> { todo!("family C") }
pub fn some<T>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<bool>) -> JsResult<bool> { todo!("family C") }
pub fn every<T>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<bool>) -> JsResult<bool> { todo!("family C") }
pub fn filter<T: Clone>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<bool>) -> JsResult<JsArray<T>> { todo!("family C") }
pub fn map<T, U>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<U>) -> JsResult<JsArray<U>> { todo!("family C") }
pub fn flat_map<T, U: Clone>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<JsArray<U>>) -> JsResult<JsArray<U>> { todo!("family C") }
pub fn for_each<T>(a: &JsArray<T>, f: impl FnMut(&T, f64) -> JsResult<()>) -> JsResult<()> { todo!("family C") }
pub fn reduce<T, U>(a: &JsArray<T>, f: impl FnMut(U, &T, f64) -> JsResult<U>, init: U) -> JsResult<U> { todo!("family C") }
/// Without an initial value; TypeError on an empty array.
pub fn reduce_first<T: Clone>(a: &JsArray<T>, f: impl FnMut(T, &T, f64) -> JsResult<T>) -> JsResult<T> { todo!("family C") }
pub fn reduce_right<T, U>(a: &JsArray<T>, f: impl FnMut(U, &T, f64) -> JsResult<U>, init: U) -> JsResult<U> { todo!("family C") }
/// In place; returns the same array.
pub fn reverse<T>(a: &JsArray<T>) -> JsArray<T> { todo!("family C") }
/// In place, stable. Without a comparator elements compare by their string
/// form (code-unit order) with undefined last.
pub fn sort<T: Clone + ArrayElement>(a: &JsArray<T>, compare: Option<&mut dyn FnMut(&T, &T) -> JsResult<f64>>) -> JsResult<JsArray<T>> { todo!("family C") }
pub fn to_sorted<T: Clone + ArrayElement>(a: &JsArray<T>, compare: Option<&mut dyn FnMut(&T, &T) -> JsResult<f64>>) -> JsResult<JsArray<T>> { todo!("family C") }
pub fn to_reversed<T: Clone>(a: &JsArray<T>) -> JsArray<T> { todo!("family C") }
/// RangeError when the index is out of range.
pub fn with<T: Clone>(a: &JsArray<T>, i: f64, v: T) -> JsResult<JsArray<T>> { todo!("family C") }
pub fn fill<T: Clone>(a: &JsArray<T>, v: T, start: Maybe<f64>, end: Maybe<f64>) -> JsArray<T> { todo!("family C") }
/// `flat()` with depth 1.
pub fn flat<T: Clone>(a: &JsArray<JsArray<T>>) -> JsArray<T> { todo!("family C") }

// Map and Set -----------------------------------------------------------------
pub fn map_new<K: ToMapKey, V>(entries: Vec<(K, V)>) -> JsMap<K, V> { todo!("family C") }
pub fn map_get<K: ToMapKey, V: Clone>(m: &JsMap<K, V>, k: &K) -> Maybe<V> { todo!("family C") }
/// Returns the map (for chaining).
pub fn map_set<K: ToMapKey, V>(m: &JsMap<K, V>, k: K, v: V) -> JsMap<K, V> { todo!("family C") }
pub fn map_has<K: ToMapKey, V>(m: &JsMap<K, V>, k: &K) -> bool { todo!("family C") }
pub fn map_delete<K: ToMapKey, V>(m: &JsMap<K, V>, k: &K) -> bool { todo!("family C") }
pub fn map_clear<K, V>(m: &JsMap<K, V>) { todo!("family C") }
pub fn map_size<K, V>(m: &JsMap<K, V>) -> f64 { todo!("family C") }
pub fn map_keys<K: Clone, V>(m: &JsMap<K, V>) -> JsArray<K> { todo!("family C") }
pub fn map_values<K, V: Clone>(m: &JsMap<K, V>) -> JsArray<V> { todo!("family C") }
pub fn set_new<T: ToMapKey>(items: Vec<T>) -> JsSet<T> { todo!("family C") }
pub fn set_add<T: ToMapKey>(s: &JsSet<T>, v: T) -> JsSet<T> { todo!("family C") }
pub fn set_has<T: ToMapKey>(s: &JsSet<T>, v: &T) -> bool { todo!("family C") }
pub fn set_delete<T: ToMapKey>(s: &JsSet<T>, v: &T) -> bool { todo!("family C") }
pub fn set_clear<T>(s: &JsSet<T>) { todo!("family C") }
pub fn set_size<T>(s: &JsSet<T>) -> f64 { todo!("family C") }
pub fn set_values<T: Clone>(s: &JsSet<T>) -> JsArray<T> { todo!("family C") }
#[doc(hidden)]
pub fn _key(k: MapKey) -> MapKey { k }
