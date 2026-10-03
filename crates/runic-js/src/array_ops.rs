//! Family C: `Array.prototype`, `Map` and `Set` operations. Signatures are
//! frozen (docs/design/M2-VALUES.md); behaviour must match ECMAScript exactly
//! and is tested against Node-generated vectors (tests/vectors/array.json).
//! Callbacks receive (element, index) and may throw; predicates return the
//! callback result's truthiness.
//!
//! Arrays are dense. Iterating methods follow the specification's loops: the
//! length is read once before the loop, and an index that is no longer within
//! the array when it is reached (because a callback removed elements) is
//! skipped as a hole would be. Elements appended by a callback are not
//! visited. Only operations that change a heap value call
//! [`JsRef::borrow_mut`], because that advances the mutation epoch.
//!
//! Documented deviations from JavaScript:
//! - `find`, `findIndex`, `findLast` and `findLastIndex` call the predicate
//!   with `undefined` for an index that a callback removed; that value cannot
//!   be represented for every element type, so such indices are skipped.
//! - `map` creates holes for removed indices; the dense result omits them.
//! - `get_checked` and `set` reject indices the dense value model cannot
//!   represent with a RangeError (see their documentation).
//! - `Map.prototype.set`/`Set.prototype.add` store a `-0` key as `+0`; the
//!   generic key type cannot be normalised here, so `keys()`/`values()`
//!   return the key as first inserted (`-0` stays `-0`). Lookup is unaffected.

use crate::{
    ArrayElement, JsArray, JsMap, JsRef, JsResult, JsSet, JsString, MapData, MapKey, Maybe,
    SetData, StrictEq, Throw, ToMapKey, array, mutation_epoch, number_to_string,
};
use indexmap::map::Entry;

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

// Argument conversions ----------------------------------------------------------

/// ToIntegerOrInfinity of a number: NaN → 0, truncation toward zero, -0 → +0.
fn to_integer_or_infinity(x: f64) -> f64 {
    if x.is_nan() {
        return 0.0;
    }
    let t = x.trunc();
    if t == 0.0 { 0.0 } else { t }
}

/// ToNumber of an optional numeric argument (`undefined` → NaN, `null` → 0).
fn arg_number(x: &Maybe<f64>) -> f64 {
    match x {
        Maybe::Undefined => f64::NAN,
        Maybe::Null => 0.0,
        Maybe::Some(v) => *v,
    }
}

/// A relative start/end argument resolved against `len` (negative counts from
/// the end) and clamped to `0..=len`.
fn relative_index(x: f64, len: usize) -> usize {
    let rel = to_integer_or_infinity(x);
    let len_f = len as f64;
    if rel < 0.0 {
        (len_f + rel).max(0.0) as usize
    } else {
        rel.min(len_f) as usize
    }
}

/// An optional end argument: absent means `len`.
fn relative_end(x: &Maybe<f64>, len: usize) -> usize {
    match x {
        Maybe::Undefined => len,
        other => relative_index(arg_number(other), len),
    }
}

/// The array index named by the property key `i` (CanonicalNumericIndexString),
/// if `i` is an integer index (`-0` names index 0).
fn array_index(i: f64) -> Option<usize> {
    if (0.0..4_294_967_295.0).contains(&i) && i.fract() == 0.0 {
        Some(i as usize)
    } else {
        None
    }
}

/// HasProperty + Get of index `k` on a dense array, copying the element so no
/// borrow is held while a callback runs.
fn element<T: Clone>(a: &JsArray<T>, k: usize) -> Option<T> {
    a.borrow().get(k).cloned()
}

// Element access ------------------------------------------------------------------

pub fn join<T: ArrayElement>(a: &JsArray<T>, separator: Maybe<JsString>) -> JsString {
    let separator = match separator {
        Maybe::Undefined => JsString::from(","),
        Maybe::Null => JsString::from("null"),
        Maybe::Some(s) => s,
    };
    join_elements(&a.borrow(), &separator)
}
pub fn length<T>(a: &JsArray<T>) -> f64 {
    a.borrow().len() as f64
}
/// `a[i]` when the static type admits undefined.
pub fn get<T: Clone>(a: &JsArray<T>, i: f64) -> Maybe<T> {
    match array_index(i).and_then(|k| element(a, k)) {
        Some(v) => Maybe::Some(v),
        None => Maybe::Undefined,
    }
}
/// `a[i]` when TypeScript types it as `T`: out-of-range reads would produce
/// `undefined` in JavaScript, which the static value model cannot represent;
/// they throw a RangeError instead (documented deviation).
pub fn get_checked<T: Clone>(a: &JsArray<T>, i: f64) -> JsResult<T> {
    match array_index(i).and_then(|k| element(a, k)) {
        Some(v) => Ok(v),
        None => Err(Throw::range_error(format!(
            "Array index {} is out of range (undefined is not representable here)",
            number_to_string(i)
        ))),
    }
}
/// `a[i] = v`; i == length appends; larger indices (holes) throw a RangeError.
/// Negative or non-integral indices would create a plain (non-element)
/// property in JavaScript; they are unsupported and throw a RangeError too.
pub fn set<T>(a: &JsArray<T>, i: f64, v: T) -> JsResult<()> {
    let len = a.borrow().len();
    match array_index(i) {
        Some(k) if k < len => a.borrow_mut()[k] = v,
        Some(k) if k == len => a.borrow_mut().push(v),
        _ => {
            return Err(Throw::range_error(format!(
                "Cannot assign array index {} (length {len}): holes and non-index properties are unsupported",
                number_to_string(i)
            )));
        }
    }
    Ok(())
}
pub fn at<T: Clone>(a: &JsArray<T>, i: f64) -> Maybe<T> {
    let len = a.borrow().len() as f64;
    let rel = to_integer_or_infinity(i);
    let k = if rel >= 0.0 { rel } else { len + rel };
    if k < 0.0 || k >= len {
        return Maybe::Undefined;
    }
    match element(a, k as usize) {
        Some(v) => Maybe::Some(v),
        None => Maybe::Undefined,
    }
}

// Mutators ------------------------------------------------------------------------

pub fn push<T>(a: &JsArray<T>, items: Vec<T>) -> f64 {
    if items.is_empty() {
        return length(a);
    }
    let mut v = a.borrow_mut();
    v.extend(items);
    v.len() as f64
}
pub fn pop<T>(a: &JsArray<T>) -> Maybe<T> {
    if a.borrow().is_empty() {
        return Maybe::Undefined;
    }
    match a.borrow_mut().pop() {
        Some(v) => Maybe::Some(v),
        None => Maybe::Undefined,
    }
}
pub fn shift<T>(a: &JsArray<T>) -> Maybe<T> {
    if a.borrow().is_empty() {
        return Maybe::Undefined;
    }
    Maybe::Some(a.borrow_mut().remove(0))
}
pub fn unshift<T>(a: &JsArray<T>, items: Vec<T>) -> f64 {
    if items.is_empty() {
        return length(a);
    }
    let mut v = a.borrow_mut();
    v.splice(0..0, items);
    v.len() as f64
}
pub fn slice<T: Clone>(a: &JsArray<T>, start: Maybe<f64>, end: Maybe<f64>) -> JsArray<T> {
    let items = a.borrow();
    let len = items.len();
    let k = relative_index(arg_number(&start), len);
    let fin = relative_end(&end, len);
    array(if k < fin {
        items[k..fin].to_vec()
    } else {
        Vec::new()
    })
}
/// `delete_count` absent (`Maybe::Undefined`) removes everything from `start`;
/// an explicit `undefined` argument must be passed as `Maybe::Null` (both
/// convert to 0).
pub fn splice<T: Clone>(
    a: &JsArray<T>,
    start: f64,
    delete_count: Maybe<f64>,
    items: Vec<T>,
) -> JsArray<T> {
    let len = a.borrow().len();
    let actual_start = relative_index(start, len);
    let count = match delete_count {
        Maybe::Undefined => len - actual_start,
        other => to_integer_or_infinity(arg_number(&other)).clamp(0.0, (len - actual_start) as f64)
            as usize,
    };
    if count == 0 && items.is_empty() {
        return array(Vec::new());
    }
    let removed: Vec<T> = a
        .borrow_mut()
        .splice(actual_start..actual_start + count, items)
        .collect();
    array(removed)
}
pub enum ConcatArg<T> {
    Array(JsArray<T>),
    Item(T),
}
pub fn concat<T: Clone>(a: &JsArray<T>, args: Vec<ConcatArg<T>>) -> JsArray<T> {
    let mut out: Vec<T> = a.borrow().clone();
    for arg in args {
        match arg {
            ConcatArg::Array(items) => out.extend(items.borrow().iter().cloned()),
            ConcatArg::Item(v) => out.push(v),
        }
    }
    array(out)
}

// Searching -----------------------------------------------------------------------

/// The start index of `indexOf`/`includes`, or `None` when nothing is searched.
fn search_start(len: usize, from: &Maybe<f64>) -> Option<usize> {
    if len == 0 {
        return None;
    }
    let n = to_integer_or_infinity(arg_number(from));
    if n == f64::INFINITY {
        return None;
    }
    Some(if n >= 0.0 {
        n.min(len as f64) as usize
    } else {
        (len as f64 + n).max(0.0) as usize
    })
}
pub fn index_of<T: StrictEq>(a: &JsArray<T>, v: &T, from: Maybe<f64>) -> f64 {
    let items = a.borrow();
    let Some(k) = search_start(items.len(), &from) else {
        return -1.0;
    };
    items[k..]
        .iter()
        .position(|x| x.strict_eq(v))
        .map_or(-1.0, |i| (k + i) as f64)
}
/// `from` absent (`Maybe::Undefined`) searches from the last element; an
/// explicit `undefined` argument must be passed as `Maybe::Null` (both convert
/// to 0).
pub fn last_index_of<T: StrictEq>(a: &JsArray<T>, v: &T, from: Maybe<f64>) -> f64 {
    let items = a.borrow();
    let len = items.len();
    if len == 0 {
        return -1.0;
    }
    let n = match from {
        Maybe::Undefined => len as f64 - 1.0,
        other => to_integer_or_infinity(arg_number(&other)),
    };
    let k = if n >= 0.0 {
        n.min(len as f64 - 1.0)
    } else {
        len as f64 + n
    };
    if k < 0.0 {
        return -1.0;
    }
    items[..=k as usize]
        .iter()
        .rposition(|x| x.strict_eq(v))
        .map_or(-1.0, |i| i as f64)
}
/// SameValueZero.
pub fn includes<T: ToMapKey>(a: &JsArray<T>, v: &T, from: Maybe<f64>) -> bool {
    let items = a.borrow();
    let Some(k) = search_start(items.len(), &from) else {
        return false;
    };
    let key = v.map_key();
    items[k..].iter().any(|x| x.map_key() == key)
}

// Callback iteration ----------------------------------------------------------------

pub fn find<T: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<bool>,
) -> JsResult<Maybe<T>> {
    let len = a.borrow().len();
    for k in 0..len {
        if let Some(x) = element(a, k)
            && f(&x, k as f64)?
        {
            return Ok(Maybe::Some(x));
        }
    }
    Ok(Maybe::Undefined)
}
pub fn find_index<T: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<bool>,
) -> JsResult<f64> {
    let len = a.borrow().len();
    for k in 0..len {
        if let Some(x) = element(a, k)
            && f(&x, k as f64)?
        {
            return Ok(k as f64);
        }
    }
    Ok(-1.0)
}
pub fn find_last<T: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<bool>,
) -> JsResult<Maybe<T>> {
    let len = a.borrow().len();
    for k in (0..len).rev() {
        if let Some(x) = element(a, k)
            && f(&x, k as f64)?
        {
            return Ok(Maybe::Some(x));
        }
    }
    Ok(Maybe::Undefined)
}
pub fn find_last_index<T: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<bool>,
) -> JsResult<f64> {
    let len = a.borrow().len();
    for k in (0..len).rev() {
        if let Some(x) = element(a, k)
            && f(&x, k as f64)?
        {
            return Ok(k as f64);
        }
    }
    Ok(-1.0)
}
pub fn some<T: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<bool>,
) -> JsResult<bool> {
    let len = a.borrow().len();
    for k in 0..len {
        if let Some(x) = element(a, k)
            && f(&x, k as f64)?
        {
            return Ok(true);
        }
    }
    Ok(false)
}
pub fn every<T: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<bool>,
) -> JsResult<bool> {
    let len = a.borrow().len();
    for k in 0..len {
        if let Some(x) = element(a, k)
            && !f(&x, k as f64)?
        {
            return Ok(false);
        }
    }
    Ok(true)
}
pub fn filter<T: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<bool>,
) -> JsResult<JsArray<T>> {
    let len = a.borrow().len();
    let mut out = Vec::new();
    for k in 0..len {
        if let Some(x) = element(a, k)
            && f(&x, k as f64)?
        {
            out.push(x);
        }
    }
    Ok(array(out))
}
pub fn map<T: Clone, U>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<U>,
) -> JsResult<JsArray<U>> {
    let len = a.borrow().len();
    let mut out = Vec::with_capacity(len);
    for k in 0..len {
        if let Some(x) = element(a, k) {
            out.push(f(&x, k as f64)?);
        }
    }
    Ok(array(out))
}
pub fn flat_map<T: Clone, U: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<JsArray<U>>,
) -> JsResult<JsArray<U>> {
    let len = a.borrow().len();
    let mut out = Vec::new();
    for k in 0..len {
        if let Some(x) = element(a, k) {
            let mapped = f(&x, k as f64)?;
            out.extend(mapped.borrow().iter().cloned());
        }
    }
    Ok(array(out))
}
pub fn for_each<T: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(&T, f64) -> JsResult<()>,
) -> JsResult<()> {
    let len = a.borrow().len();
    for k in 0..len {
        if let Some(x) = element(a, k) {
            f(&x, k as f64)?;
        }
    }
    Ok(())
}
pub fn reduce<T: Clone, U>(
    a: &JsArray<T>,
    mut f: impl FnMut(U, &T, f64) -> JsResult<U>,
    init: U,
) -> JsResult<U> {
    let len = a.borrow().len();
    let mut acc = init;
    for k in 0..len {
        if let Some(x) = element(a, k) {
            acc = f(acc, &x, k as f64)?;
        }
    }
    Ok(acc)
}
/// Without an initial value; TypeError on an empty array.
pub fn reduce_first<T: Clone>(
    a: &JsArray<T>,
    mut f: impl FnMut(T, &T, f64) -> JsResult<T>,
) -> JsResult<T> {
    let len = a.borrow().len();
    let Some(mut acc) = element(a, 0) else {
        return Err(Throw::type_error(
            "Reduce of empty array with no initial value",
        ));
    };
    for k in 1..len {
        if let Some(x) = element(a, k) {
            acc = f(acc, &x, k as f64)?;
        }
    }
    Ok(acc)
}
pub fn reduce_right<T: Clone, U>(
    a: &JsArray<T>,
    mut f: impl FnMut(U, &T, f64) -> JsResult<U>,
    init: U,
) -> JsResult<U> {
    let len = a.borrow().len();
    let mut acc = init;
    for k in (0..len).rev() {
        if let Some(x) = element(a, k) {
            acc = f(acc, &x, k as f64)?;
        }
    }
    Ok(acc)
}

// Ordering --------------------------------------------------------------------------

/// In place; returns the same array.
pub fn reverse<T>(a: &JsArray<T>) -> JsArray<T> {
    if a.borrow().len() > 1 {
        a.borrow_mut().reverse();
    }
    a.clone()
}

/// Stable merge sort of `order` where `after(x, y)` tells whether `x` must be
/// placed after `y` (comparator result > 0). Errors propagate immediately.
fn merge_sort(
    mut order: Vec<usize>,
    after: &mut dyn FnMut(usize, usize) -> JsResult<bool>,
) -> JsResult<Vec<usize>> {
    if order.len() <= 1 {
        return Ok(order);
    }
    let right = order.split_off(order.len() / 2);
    let left = merge_sort(order, after)?;
    let right = merge_sort(right, after)?;
    let mut out = Vec::with_capacity(left.len() + right.len());
    let (mut i, mut j) = (0, 0);
    while i < left.len() && j < right.len() {
        if after(left[i], right[j])? {
            out.push(right[j]);
            j += 1;
        } else {
            out.push(left[i]);
            i += 1;
        }
    }
    out.extend_from_slice(&left[i..]);
    out.extend_from_slice(&right[j..]);
    Ok(out)
}

/// SortIndexedProperties + SortCompare: the sorted order of `items` as source
/// indices. `undefined` sorts last without consulting the comparator; a
/// comparator result of NaN counts as 0. Without a comparator, values compare
/// by ToString in code-unit order (`null` is "null").
fn sort_order<T: ArrayElement>(
    items: &[T],
    compare: Option<&mut dyn FnMut(&T, &T) -> JsResult<f64>>,
) -> JsResult<Vec<usize>> {
    let (defined, undefined): (Vec<usize>, Vec<usize>) =
        (0..items.len()).partition(|&i| !items[i].is_undefined());
    let mut order = match compare {
        Some(cmp) => merge_sort(defined, &mut |x, y| Ok(cmp(&items[x], &items[y])? > 0.0))?,
        None => {
            let keys: Vec<Option<JsString>> = items
                .iter()
                .map(|x| {
                    (!x.is_undefined()).then(|| {
                        if x.is_null() {
                            JsString::from("null")
                        } else {
                            x.join_string()
                        }
                    })
                })
                .collect();
            let mut order = defined;
            // `sort_by` is a stable merge sort.
            order.sort_by(|&x, &y| keys[x].cmp(&keys[y]));
            order
        }
    };
    order.extend(undefined);
    Ok(order)
}

/// In place, stable. Without a comparator elements compare by their string
/// form (code-unit order) with undefined last. As in the specification, the
/// elements are copied before sorting and written back afterwards, so a
/// throwing comparator leaves the array unchanged. The write-back is skipped
/// (no mutation is recorded) when the order is unchanged and nothing was
/// mutated while sorting.
pub fn sort<T: Clone + ArrayElement>(
    a: &JsArray<T>,
    compare: Option<&mut dyn FnMut(&T, &T) -> JsResult<f64>>,
) -> JsResult<JsArray<T>> {
    let items: Vec<T> = a.borrow().clone();
    let epoch = mutation_epoch();
    let order = sort_order(&items, compare)?;
    let unchanged = mutation_epoch() == epoch && order.iter().enumerate().all(|(i, &j)| i == j);
    if !unchanged {
        let mut items: Vec<Option<T>> = items.into_iter().map(Some).collect();
        let mut target = a.borrow_mut();
        for (j, &src) in order.iter().enumerate() {
            let item = items[src].take().expect("permutation");
            if j < target.len() {
                target[j] = item;
            } else {
                target.push(item);
            }
        }
    }
    Ok(a.clone())
}
pub fn to_sorted<T: Clone + ArrayElement>(
    a: &JsArray<T>,
    compare: Option<&mut dyn FnMut(&T, &T) -> JsResult<f64>>,
) -> JsResult<JsArray<T>> {
    let items: Vec<T> = a.borrow().clone();
    let order = sort_order(&items, compare)?;
    Ok(array(order.into_iter().map(|i| items[i].clone()).collect()))
}
pub fn to_reversed<T: Clone>(a: &JsArray<T>) -> JsArray<T> {
    array(a.borrow().iter().rev().cloned().collect())
}
/// RangeError when the index is out of range.
pub fn with<T: Clone>(a: &JsArray<T>, i: f64, v: T) -> JsResult<JsArray<T>> {
    let mut items: Vec<T> = a.borrow().clone();
    let len = items.len() as f64;
    let rel = to_integer_or_infinity(i);
    let k = if rel >= 0.0 { rel } else { len + rel };
    if k < 0.0 || k >= len {
        return Err(Throw::range_error(format!(
            "Invalid index : {}",
            number_to_string(i)
        )));
    }
    items[k as usize] = v;
    Ok(array(items))
}
pub fn fill<T: Clone>(a: &JsArray<T>, v: T, start: Maybe<f64>, end: Maybe<f64>) -> JsArray<T> {
    let len = a.borrow().len();
    let k = relative_index(arg_number(&start), len);
    let fin = relative_end(&end, len);
    if k < fin {
        for x in &mut a.borrow_mut()[k..fin] {
            *x = v.clone();
        }
    }
    a.clone()
}
/// `flat()` with depth 1.
pub fn flat<T: Clone>(a: &JsArray<JsArray<T>>) -> JsArray<T> {
    let mut out = Vec::new();
    for inner in a.borrow().iter() {
        out.extend(inner.borrow().iter().cloned());
    }
    array(out)
}

// Map and Set -----------------------------------------------------------------

/// Map.prototype.set on the data: an existing key keeps its position (and
/// its original key value) and gets the new value.
fn map_insert<K: ToMapKey, V>(data: &mut MapData<K, V>, k: K, v: V) {
    match data.entries.entry(k.map_key()) {
        Entry::Occupied(mut e) => e.get_mut().1 = v,
        Entry::Vacant(e) => {
            e.insert((k, v));
        }
    }
}

pub fn map_new<K: ToMapKey, V>(entries: Vec<(K, V)>) -> JsMap<K, V> {
    let mut data = MapData::default();
    for (k, v) in entries {
        map_insert(&mut data, k, v);
    }
    JsRef::new(data)
}
pub fn map_get<K: ToMapKey, V: Clone>(m: &JsMap<K, V>, k: &K) -> Maybe<V> {
    match m.borrow().entries.get(&k.map_key()) {
        Some((_, v)) => Maybe::Some(v.clone()),
        None => Maybe::Undefined,
    }
}
/// Returns the map (for chaining).
pub fn map_set<K: ToMapKey, V>(m: &JsMap<K, V>, k: K, v: V) -> JsMap<K, V> {
    map_insert(&mut m.borrow_mut(), k, v);
    m.clone()
}
pub fn map_has<K: ToMapKey, V>(m: &JsMap<K, V>, k: &K) -> bool {
    m.borrow().entries.contains_key(&k.map_key())
}
pub fn map_delete<K: ToMapKey, V>(m: &JsMap<K, V>, k: &K) -> bool {
    let key = k.map_key();
    if !m.borrow().entries.contains_key(&key) {
        return false;
    }
    m.borrow_mut().entries.shift_remove(&key);
    true
}
pub fn map_clear<K, V>(m: &JsMap<K, V>) {
    if !m.borrow().entries.is_empty() {
        m.borrow_mut().entries.clear();
    }
}
pub fn map_size<K, V>(m: &JsMap<K, V>) -> f64 {
    m.borrow().entries.len() as f64
}
pub fn map_keys<K: Clone, V>(m: &JsMap<K, V>) -> JsArray<K> {
    array(
        m.borrow()
            .entries
            .values()
            .map(|(k, _)| k.clone())
            .collect(),
    )
}
pub fn map_values<K, V: Clone>(m: &JsMap<K, V>) -> JsArray<V> {
    array(
        m.borrow()
            .entries
            .values()
            .map(|(_, v)| v.clone())
            .collect(),
    )
}
pub fn set_new<T: ToMapKey>(items: Vec<T>) -> JsSet<T> {
    let mut data = SetData::default();
    for v in items {
        data.entries.entry(v.map_key()).or_insert(v);
    }
    JsRef::new(data)
}
/// Returns the set (for chaining); adding a present value changes nothing.
pub fn set_add<T: ToMapKey>(s: &JsSet<T>, v: T) -> JsSet<T> {
    let key = v.map_key();
    if !s.borrow().entries.contains_key(&key) {
        s.borrow_mut().entries.insert(key, v);
    }
    s.clone()
}
pub fn set_has<T: ToMapKey>(s: &JsSet<T>, v: &T) -> bool {
    s.borrow().entries.contains_key(&v.map_key())
}
pub fn set_delete<T: ToMapKey>(s: &JsSet<T>, v: &T) -> bool {
    let key = v.map_key();
    if !s.borrow().entries.contains_key(&key) {
        return false;
    }
    s.borrow_mut().entries.shift_remove(&key);
    true
}
pub fn set_clear<T>(s: &JsSet<T>) {
    if !s.borrow().entries.is_empty() {
        s.borrow_mut().entries.clear();
    }
}
pub fn set_size<T>(s: &JsSet<T>) -> f64 {
    s.borrow().entries.len() as f64
}
pub fn set_values<T: Clone>(s: &JsSet<T>) -> JsArray<T> {
    array(s.borrow().entries.values().cloned().collect())
}
#[doc(hidden)]
pub fn _key(k: MapKey) -> MapKey {
    k
}
