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
    ArrayElement, JsArray, JsMap, JsRef, JsResult, JsSet, JsString, MapData, MapKey, Maybe, Own,
    SetData, StrictEq, Throw, ToMapKey, array, mutation_epoch, number_to_string, own_into,
};
use indexmap::map::Entry;
use std::ops::Range;

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

/// The array index a number names, if it is one (see [`set`]).
pub fn element_index(i: f64) -> Option<usize> {
    array_index(i)
}

/// HasProperty + Get of index `k` on a dense array, copying the element so no
/// borrow is held while a callback runs.
fn element<T: Clone>(a: &JsArray<T>, k: usize) -> Option<T> {
    a.read_slot(k as u32 + 1).get(k).cloned()
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
    a.read_slot(0).len() as f64
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
    let len = a.read_slot(0).len();
    match array_index(i) {
        Some(k) if k < len => a.write_slots(&[k as u32 + 1])[k] = v,
        Some(k) if k == len => a.write_slots(&[0, k as u32 + 1]).push(v),
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
    let len = a.read_slot(0).len() as f64;
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
    // The length and the new elements change.
    let len = a.read_slot(0).len() as u32;
    let slots: Vec<u32> = std::iter::once(0)
        .chain((len + 1)..=(len + items.len() as u32))
        .collect();
    let mut v = a.write_slots(&slots);
    v.extend(items);
    v.len() as f64
}
/// The elements `a` holds after a mutator whose spec steps, run through a
/// proxy's traps, set the indices `set` once each (docs/design/REACTIVITY-ALIASING.md,
/// R4): such an index is written only where its value changes
/// (`element_changes`, as Svelte's sources and Vue's set trap ignore equal
/// sets; new indices always), indices past the new length (deleted) are
/// written, and so is the length where it changes. The caller has read what
/// the steps get. Elements the steps neither read nor set keep their place,
/// so a proxy's untaken ones stay untaken.
fn replace_elements<T: Clone + StrictEq>(a: &JsArray<T>, next: Vec<T>, set: Range<usize>) {
    let old_len = a.peek().len();
    let new_len = next.len();
    let mut slots: Vec<u32> = (old_len != new_len).then_some(0).into_iter().collect();
    {
        let old = a.peek();
        slots.extend(
            set.filter(|&i| i >= old_len || element_changes(a, i, &old[i], &next[i]))
                .map(|i| i as u32 + 1),
        );
    }
    slots.extend((new_len..old_len).map(|i| i as u32 + 1));
    if !slots.is_empty() {
        *a.write_slots(&slots) = next;
    }
}

/// As Array.prototype.pop through a proxy: it reads the length and the last
/// element, deletes it and sets the length.
pub fn pop<T: Clone + StrictEq>(a: &JsArray<T>) -> Maybe<T> {
    let len = a.read_slot(0).len();
    if len == 0 {
        return Maybe::Undefined;
    }
    let last = element(a, len - 1);
    let mut next = a.peek().clone();
    next.pop();
    replace_elements(a, next, 0..0);
    match last {
        Some(v) => Maybe::Some(v),
        None => Maybe::Undefined,
    }
}
/// As Array.prototype.shift through a proxy: it reads every element, sets
/// each to the next one, deletes the last and sets the length.
pub fn shift<T: Clone + StrictEq>(a: &JsArray<T>) -> Maybe<T> {
    let len = a.read_slot(0).len();
    if len == 0 {
        return Maybe::Undefined;
    }
    let values: Vec<T> = (0..len).filter_map(|i| element(a, i)).collect();
    let first = values[0].clone();
    replace_elements(a, values[1..].to_vec(), 0..len - 1);
    Maybe::Some(first)
}
/// As Array.prototype.unshift through a proxy: it reads every element, sets
/// each `items.len()` places later, then the items, then the length.
pub fn unshift<T: Clone + StrictEq>(a: &JsArray<T>, items: Vec<T>) -> f64 {
    if items.is_empty() {
        return length(a);
    }
    let len = a.read_slot(0).len();
    let mut next = items;
    next.extend((0..len).filter_map(|i| element(a, i)));
    let n = next.len();
    replace_elements(a, next, 0..n);
    n as f64
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
///
/// As Array.prototype.splice through a proxy: it reads the length and the
/// removed elements, and where the count of items differs from the count
/// removed, reads and moves every element after them; it sets the moved
/// elements and the items, deletes indices past the new length and sets the
/// length (`replace_elements`), so elements before `start`, and after the
/// removed ones where nothing moves, are not written.
pub fn splice<T: Clone + StrictEq>(
    a: &JsArray<T>,
    start: f64,
    delete_count: Maybe<f64>,
    items: Vec<T>,
) -> JsArray<T> {
    let len = a.read_slot(0).len();
    let actual_start = relative_index(start, len);
    let count = match delete_count {
        Maybe::Undefined => len - actual_start,
        other => to_integer_or_infinity(arg_number(&other)).clamp(0.0, (len - actual_start) as f64)
            as usize,
    };
    let removed: Vec<T> = (actual_start..actual_start + count)
        .filter_map(|i| element(a, i))
        .collect();
    let moved = if items.len() != count {
        actual_start + count..len
    } else {
        len..len
    };
    let tail: Vec<T> = moved.clone().filter_map(|i| element(a, i)).collect();
    // Elements after the removed ones that nothing moves keep their place.
    let mut next: Vec<T> = a.peek()[..actual_start].to_vec();
    let set_end = actual_start + items.len();
    next.extend(items);
    let set = if moved.is_empty() {
        next.extend_from_slice(&a.peek()[actual_start + count..]);
        actual_start..set_end
    } else {
        next.extend(tail);
        actual_start..next.len()
    };
    replace_elements(a, next, set);
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

/// Whether writing `new` over `old` in element `i` of `a` changes it
/// (docs/design/REACTIVITY-ALIASING.md, R4): a proxy's element `===` the
/// value and a reactive array's SameValue one stay as they are, as Svelte's
/// sources and Vue's set trap ignore such sets; a raw array's elements are
/// always written.
fn element_changes<T: StrictEq>(a: &JsArray<T>, i: usize, old: &T, new: &T) -> bool {
    match a.equal_write(i as u32 + 1) {
        None => true,
        Some(true) => !old.same_value(new),
        Some(false) => !old.strict_eq(new),
    }
}

/// Write `values[j]` to element `start + j` where it changes (`element_changes`).
fn write_changed<T: Clone + StrictEq>(
    a: &JsArray<T>,
    start: usize,
    values: &[T],
    skip: Option<usize>,
) {
    let changed: Vec<u32> = {
        let old = a.peek();
        (0..values.len())
            .filter(|&j| {
                Some(start + j) != skip
                    && element_changes(a, start + j, &old[start + j], &values[j])
            })
            .map(|j| (start + j) as u32 + 1)
            .collect()
    };
    if !changed.is_empty() {
        let mut v = a.write_slots(&changed);
        for &s in &changed {
            let i = s as usize - 1;
            v[i] = values[i - start].clone();
        }
    }
}

/// In place; returns the same array. As Array.prototype.reverse through a
/// proxy: it reads the length and every element but the middle one, then
/// sets each swapped pair, which writes the elements that change.
pub fn reverse<T: Clone + StrictEq>(a: &JsArray<T>) -> JsArray<T> {
    let len = a.read_slot(0).len();
    if len < 2 {
        return a.clone();
    }
    let middle = (len % 2 == 1).then_some(len / 2);
    for i in (0..len).filter(|&i| Some(i) != middle) {
        drop(a.read_slot(i as u32 + 1));
    }
    let reversed: Vec<T> = a.peek().iter().rev().cloned().collect();
    write_changed(a, 0, &reversed, middle);
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
/// elements (and the length) are read and copied before sorting and set
/// back afterwards index by index, so a throwing comparator leaves the array
/// unchanged and only the elements that change are written
/// (`element_changes`); nothing is written when the order is unchanged and
/// nothing was mutated while sorting.
pub fn sort<T: Clone + ArrayElement + StrictEq>(
    a: &JsArray<T>,
    compare: Option<&mut dyn FnMut(&T, &T) -> JsResult<f64>>,
) -> JsResult<JsArray<T>> {
    let items: Vec<T> = a.borrow().clone();
    let epoch = mutation_epoch();
    let order = sort_order(&items, compare)?;
    if mutation_epoch() == epoch && order.iter().enumerate().all(|(i, &j)| i == j) {
        return Ok(a.clone());
    }
    let sorted: Vec<T> = order.iter().map(|&i| items[i].clone()).collect();
    // A comparator that shortened or grew the array: the sorted items are
    // set from index 0, past the current end too.
    let len = a.peek().len();
    let within = sorted.len().min(len);
    write_changed(a, 0, &sorted[..within], None);
    if sorted.len() > len {
        let slots: Vec<u32> = std::iter::once(0)
            .chain((len + 1) as u32..=sorted.len() as u32)
            .collect();
        a.write_slots(&slots).extend(sorted[len..].iter().cloned());
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
/// As Array.prototype.fill through a proxy: it reads the length and sets
/// each index of the range, storing the value as each set does (a proxy
/// array takes a new proxy of a plain value at each index), which writes the
/// elements that change (`element_changes`).
pub fn fill<T: Clone + StrictEq + Own>(
    a: &JsArray<T>,
    v: T,
    start: Maybe<f64>,
    end: Maybe<f64>,
) -> JsArray<T> {
    let len = a.read_slot(0).len();
    let k = relative_index(arg_number(&start), len);
    let fin = relative_end(&end, len);
    if k < fin {
        let values: Vec<T> = (k..fin).map(|_| own_into(a, v.clone())).collect();
        write_changed(a, k, &values, None);
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
/// The array index a property key names (a canonical numeric string of an
/// integer below 2^32 - 1), which an object's own keys list first.
fn index_key(k: &str) -> Option<u32> {
    if k == "0" {
        return Some(0);
    }
    if k.is_empty() || k.len() > 10 || k.starts_with('0') || !k.bytes().all(|c| c.is_ascii_digit())
    {
        return None;
    }
    let n: u64 = k.parse().ok()?;
    (n < 4_294_967_295).then_some(n as u32)
}

/// The entries of a map standing for a dictionary object (M6 overlays: a
/// string-keyed object literal written by computed keys), in the order of
/// the object's own keys (OrdinaryOwnPropertyKeys): array indices
/// ascending, then the other keys in insertion order. `key` gives a key's
/// string.
pub fn dictionary_entries<K: Clone, V: Clone>(
    m: &JsMap<K, V>,
    key: impl Fn(&K) -> String,
) -> Vec<(K, V)> {
    let all: Vec<(K, V)> = m.borrow().entries.values().cloned().collect();
    let mut indices: Vec<(u32, (K, V))> = vec![];
    let mut others = vec![];
    for e in all {
        match index_key(&key(&e.0)) {
            Some(i) => indices.push((i, e)),
            None => others.push(e),
        }
    }
    indices.sort_by_key(|(i, _)| *i);
    indices.into_iter().map(|(_, e)| e).chain(others).collect()
}
pub fn dictionary_keys<K: Clone, V: Clone>(
    m: &JsMap<K, V>,
    key: impl Fn(&K) -> String,
) -> JsArray<K> {
    array(
        dictionary_entries(m, key)
            .into_iter()
            .map(|(k, _)| k)
            .collect(),
    )
}
pub fn dictionary_values<K: Clone, V: Clone>(
    m: &JsMap<K, V>,
    key: impl Fn(&K) -> String,
) -> JsArray<V> {
    array(
        dictionary_entries(m, key)
            .into_iter()
            .map(|(_, v)| v)
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
