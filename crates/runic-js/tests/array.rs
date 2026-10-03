//! Family C (Array.prototype, Map, Set) against Node-generated vectors
//! (tests/vectors/array.json, produced by tests/vectors/array.mjs), plus
//! mutation-epoch, re-entrancy and documented-deviation tests.
//!
//! Values are compared through the generator's lossless encoding, so numbers
//! compare by SameValue (NaN, -0) and strings by code units.

use runic_js::array_ops::{self as ops, ConcatArg};
use runic_js::{
    ArrayElement, JsArray, JsMap, JsRef, JsResult, JsSet, JsString, Maybe, StrictEq, Throw,
    ToJsString, ToMapKey, Truthy, array, mutation_epoch, number_to_string,
};
use serde_json::{Value, json};
use std::cell::RefCell;
use std::rc::Rc;

// Encoding ----------------------------------------------------------------------------

/// Arrays that are encoded by reference (`{"ref": i}`): the original
/// elements of a nested-array input, or the Map/Set key pool.
#[derive(Default)]
struct Ctx {
    orig: Vec<JsArray<f64>>,
}

fn enc_num(x: f64) -> Value {
    if x == 0.0 && x.is_sign_negative() {
        json!("-0")
    } else {
        json!(number_to_string(x))
    }
}
fn dec_num(v: &Value) -> f64 {
    match v.as_str().expect("encoded number") {
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        "-0" => -0.0,
        s => s.parse().expect("number"),
    }
}
fn enc_str(s: &JsString) -> Value {
    match String::from_utf16(s.units()) {
        Ok(text) => json!({ "s": text }),
        Err(_) => json!({ "su": s.units() }),
    }
}
fn dec_str(v: &Value) -> JsString {
    if let Some(s) = v.get("s") {
        JsString::from(s.as_str().expect("string"))
    } else {
        let units = v["su"].as_array().expect("code units");
        JsString::from_units(
            units
                .iter()
                .map(|u| u.as_u64().expect("unit") as u16)
                .collect(),
        )
    }
}
fn is_absent(v: &Value) -> bool {
    v.get("absent").is_some()
}
fn undefined() -> Value {
    json!({ "u": 1 })
}
fn enc_throw(t: &Throw) -> Value {
    json!({ "throw": [t.name.to_rust(), t.message.to_rust()] })
}
fn enc_res(r: JsResult<Value>) -> Value {
    r.unwrap_or_else(|t| enc_throw(&t))
}
/// An optional numeric argument: absent → `Undefined`, null → `Null`.
fn maybe_num(v: &Value) -> Maybe<f64> {
    if is_absent(v) {
        Maybe::Undefined
    } else if v.is_null() {
        Maybe::Null
    } else {
        Maybe::Some(dec_num(v))
    }
}
fn maybe_str(v: &Value) -> Maybe<JsString> {
    if is_absent(v) {
        Maybe::Undefined
    } else if v.is_null() {
        Maybe::Null
    } else {
        Maybe::Some(dec_str(v))
    }
}
fn dec_maybe<T>(v: &Value, f: impl FnOnce(&Value) -> T) -> Maybe<T> {
    if v.is_null() {
        Maybe::Null
    } else if v.get("u").is_some() {
        Maybe::Undefined
    } else {
        Maybe::Some(f(v))
    }
}
fn enc_maybe<T: Elem>(m: &Maybe<T>, cx: &Ctx) -> Value {
    match m {
        Maybe::Undefined => undefined(),
        Maybe::Null => Value::Null,
        Maybe::Some(x) => x.enc(cx),
    }
}
fn enc_vec<T: Elem>(items: &[T], cx: &Ctx) -> Value {
    Value::Array(items.iter().map(|x| x.enc(cx)).collect())
}
fn enc_arr<T: Elem>(a: &JsArray<T>, cx: &Ctx) -> Value {
    enc_vec(&a.borrow(), cx)
}
/// A returned array: the receiver itself or a new array.
fn enc_ret<T: Elem>(r: &JsArray<T>, receiver: &JsArray<T>, cx: &Ctx) -> Value {
    if JsRef::ptr_eq(r, receiver) {
        json!({ "receiver": 1 })
    } else {
        enc_arr(r, cx)
    }
}
fn units_cmp(a: &JsString, b: &JsString) -> f64 {
    match a.units().cmp(b.units()) {
        std::cmp::Ordering::Less => -1.0,
        std::cmp::Ordering::Equal => 0.0,
        std::cmp::Ordering::Greater => 1.0,
    }
}
fn boom() -> Throw {
    Throw::range_error("boom")
}

type Pred<T> = Box<dyn FnMut(&T, f64) -> JsResult<bool>>;
type Cmp<T> = Box<dyn FnMut(&T, &T) -> JsResult<f64>>;
type First<T> = Box<dyn FnMut(T, &T, f64) -> JsResult<T>>;

/// An element type of the vectors, with its named callbacks (array.mjs).
trait Elem: Clone + ArrayElement + StrictEq + ToMapKey + 'static {
    const TYPE: &'static str;
    fn dec(v: &Value, cx: &Ctx) -> Self;
    fn enc(&self, cx: &Ctx) -> Value;
    /// SAMPLE in array.mjs (pushed by the `push_at_0` predicate).
    fn sample() -> Self;
    fn originals(_items: &[Self]) -> Vec<JsArray<f64>> {
        Vec::new()
    }
    fn pred(name: &str) -> Pred<Self>;
    fn run_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value>;
    fn run_flat_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value>;
    fn run_reduce(name: &str, a: &JsArray<Self>, init: &Value, right: bool) -> JsResult<Value>;
    fn first_reducer(name: &str, a: &JsArray<Self>) -> First<Self>;
    fn comparator(name: &str, a: &JsArray<Self>) -> Cmp<Self>;
    fn run_special(op: &str, _a: &JsArray<Self>, _cx: &Ctx) -> Option<Value> {
        panic!("{op} is not defined for {}", Self::TYPE)
    }
}

fn reduce_with<T: Clone, U>(
    a: &JsArray<T>,
    right: bool,
    init: U,
    f: impl FnMut(U, &T, f64) -> JsResult<U>,
) -> JsResult<U> {
    if right {
        ops::reduce_right(a, f, init)
    } else {
        ops::reduce(a, f, init)
    }
}

impl Elem for f64 {
    const TYPE: &'static str = "num";
    fn dec(v: &Value, _: &Ctx) -> Self {
        dec_num(v)
    }
    fn enc(&self, _: &Ctx) -> Value {
        enc_num(*self)
    }
    fn sample() -> Self {
        7.0
    }
    fn pred(name: &str) -> Pred<Self> {
        match name {
            "gt2" => Box::new(|x: &f64, _| Ok(*x > 2.0)),
            "even" => Box::new(|x: &f64, _| Ok(*x % 2.0 == 0.0)),
            "is_nan" => Box::new(|x: &f64, _| Ok(x.is_nan())),
            "truthy" => Box::new(|x: &f64, _| Ok(x.truthy())),
            _ => panic!("unknown predicate {name}"),
        }
    }
    fn run_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        Ok(match name {
            "double" => enc_arr(&ops::map(a, |x, _| Ok(x * 2.0))?, cx),
            "neg" => enc_arr(&ops::map(a, |x, _| Ok(-x))?, cx),
            "plus_i" => enc_arr(&ops::map(a, |x, i| Ok(x + i))?, cx),
            "to_str" => enc_arr(&ops::map(a, |x, _| Ok(x.to_js_string()))?, cx),
            "throw_at_1" => enc_arr(
                &ops::map(a, |x, i| if i == 1.0 { Err(boom()) } else { Ok(*x) })?,
                cx,
            ),
            _ => panic!("unknown mapper {name}"),
        })
    }
    fn run_flat_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        let r = match name {
            "dup" => ops::flat_map(a, |x, _| Ok(array(vec![*x, *x])))?,
            "keep_even" => ops::flat_map(a, |x, _| {
                Ok(array(if x % 2.0 == 0.0 { vec![*x] } else { vec![] }))
            })?,
            "idx" => ops::flat_map(a, |_, i| Ok(array(vec![i])))?,
            _ => panic!("unknown flat mapper {name}"),
        };
        Ok(enc_arr(&r, cx))
    }
    fn run_reduce(name: &str, a: &JsArray<Self>, init: &Value, right: bool) -> JsResult<Value> {
        Ok(match name {
            "sum" => enc_num(reduce_with(a, right, dec_num(init), |acc, x, _| {
                Ok(acc + x)
            })?),
            "sub" => enc_num(reduce_with(a, right, dec_num(init), |acc, x, _| {
                Ok(acc - x)
            })?),
            "digits" => enc_num(reduce_with(a, right, dec_num(init), |acc, _, i| {
                Ok(acc * 10.0 + i)
            })?),
            "cat_str" => enc_str(&reduce_with(a, right, dec_str(init), |acc, x, _| {
                Ok(acc.concat(&x.to_js_string()).concat(&JsString::from(";")))
            })?),
            "throw_at_1" => enc_num(reduce_with(a, right, dec_num(init), |acc, _, i| {
                if i == 1.0 { Err(boom()) } else { Ok(acc) }
            })?),
            _ => panic!("unknown reducer {name}"),
        })
    }
    fn first_reducer(name: &str, a: &JsArray<Self>) -> First<Self> {
        let arr = a.clone();
        match name {
            "sum" => Box::new(|acc, x: &f64, _| Ok(acc + x)),
            "sub" => Box::new(|acc, x: &f64, _| Ok(acc - x)),
            "max" => Box::new(|acc, x: &f64, _| Ok(runic_js::max(acc, *x))),
            "throw_at_1" => {
                Box::new(|acc, _: &f64, i| if i == 1.0 { Err(boom()) } else { Ok(acc) })
            }
            "push_at_1" => Box::new(move |acc, x: &f64, i| {
                if i == 1.0 {
                    ops::push(&arr, vec![100.0]);
                }
                Ok(acc + x)
            }),
            _ => panic!("unknown first reducer {name}"),
        }
    }
    fn comparator(name: &str, a: &JsArray<Self>) -> Cmp<Self> {
        let arr = a.clone();
        match name {
            "asc" => Box::new(|a: &f64, b: &f64| Ok(a - b)),
            "desc" => Box::new(|a: &f64, b: &f64| Ok(b - a)),
            "nan" => Box::new(|_: &f64, _: &f64| Ok(f64::NAN)),
            "zero" => Box::new(|_: &f64, _: &f64| Ok(0.0)),
            "mod3" => Box::new(|a: &f64, b: &f64| Ok(a % 3.0 - b % 3.0)),
            "throws_on_3" => Box::new(|a: &f64, b: &f64| {
                if *a == 3.0 || *b == 3.0 {
                    Err(Throw::type_error("three"))
                } else {
                    Ok(a - b)
                }
            }),
            "clobber" => Box::new(move |a: &f64, b: &f64| {
                ops::set(&arr, 0.0, -999.0)?;
                Ok(a - b)
            }),
            "reads" => Box::new(move |a: &f64, b: &f64| {
                Ok((a - b) * if ops::length(&arr) > 0.0 { 1.0 } else { -1.0 })
            }),
            _ => panic!("unknown comparator {name}"),
        }
    }
}

impl Elem for JsString {
    const TYPE: &'static str = "str";
    fn dec(v: &Value, _: &Ctx) -> Self {
        dec_str(v)
    }
    fn enc(&self, _: &Ctx) -> Value {
        enc_str(self)
    }
    fn sample() -> Self {
        JsString::from("q")
    }
    fn pred(name: &str) -> Pred<Self> {
        match name {
            "long" => Box::new(|x: &JsString, _| Ok(x.len() > 1)),
            "empty" => Box::new(|x: &JsString, _| Ok(x.is_empty())),
            "truthy" => Box::new(|x: &JsString, _| Ok(x.truthy())),
            _ => panic!("unknown predicate {name}"),
        }
    }
    fn run_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        Ok(match name {
            "bang" => enc_arr(&ops::map(a, |x, _| Ok(x.concat(&JsString::from("!"))))?, cx),
            "len" => enc_arr(&ops::map(a, |x, _| Ok(x.len() as f64))?, cx),
            _ => panic!("unknown mapper {name}"),
        })
    }
    fn run_flat_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        match name {
            "dup" => Ok(enc_arr(
                &ops::flat_map(a, |x, _| Ok(array(vec![x.clone(), x.clone()])))?,
                cx,
            )),
            _ => panic!("unknown flat mapper {name}"),
        }
    }
    fn run_reduce(name: &str, a: &JsArray<Self>, init: &Value, right: bool) -> JsResult<Value> {
        Ok(match name {
            "cat" => enc_str(&reduce_with(a, right, dec_str(init), |acc, x, _| {
                Ok(acc.concat(x))
            })?),
            "lensum" => enc_num(reduce_with(
                a,
                right,
                dec_num(init),
                |acc, x: &JsString, _| Ok(acc + x.len() as f64),
            )?),
            _ => panic!("unknown reducer {name}"),
        })
    }
    fn first_reducer(name: &str, _: &JsArray<Self>) -> First<Self> {
        match name {
            "cat" => Box::new(|acc: JsString, x: &JsString, _| Ok(acc.concat(x))),
            _ => panic!("unknown first reducer {name}"),
        }
    }
    fn comparator(name: &str, _: &JsArray<Self>) -> Cmp<Self> {
        match name {
            "cu" => Box::new(|a: &JsString, b: &JsString| Ok(units_cmp(a, b))),
            "rev_cu" => Box::new(|a: &JsString, b: &JsString| Ok(units_cmp(b, a))),
            "by_len" => Box::new(|a: &JsString, b: &JsString| Ok(a.len() as f64 - b.len() as f64)),
            _ => panic!("unknown comparator {name}"),
        }
    }
}

/// Comparators must never see `undefined` (it sorts last without comparing).
fn defined<T>(m: &Maybe<T>) -> &Maybe<T> {
    assert!(!m.is_undefined(), "comparator received undefined");
    m
}

impl Elem for Maybe<f64> {
    const TYPE: &'static str = "mnum";
    fn dec(v: &Value, _: &Ctx) -> Self {
        dec_maybe(v, dec_num)
    }
    fn enc(&self, cx: &Ctx) -> Value {
        enc_maybe(self, cx)
    }
    fn sample() -> Self {
        Maybe::Null
    }
    fn pred(name: &str) -> Pred<Self> {
        match name {
            "nullish" => Box::new(|x: &Maybe<f64>, _| Ok(x.is_nullish())),
            "truthy" => Box::new(|x: &Maybe<f64>, _| Ok(x.truthy())),
            "is_null" => Box::new(|x: &Maybe<f64>, _| Ok(x.is_null())),
            _ => panic!("unknown predicate {name}"),
        }
    }
    fn run_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        Ok(match name {
            "or_zero" => enc_arr(&ops::map(a, |x, _| Ok(x.clone().or_else(|| 0.0)))?, cx),
            "is_null" => enc_arr(&ops::map(a, |x, _| Ok(x.is_null()))?, cx),
            _ => panic!("unknown mapper {name}"),
        })
    }
    fn run_flat_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        match name {
            "dup" => Ok(enc_arr(
                &ops::flat_map(a, |x, _| Ok(array(vec![x.clone(), x.clone()])))?,
                cx,
            )),
            _ => panic!("unknown flat mapper {name}"),
        }
    }
    fn run_reduce(name: &str, a: &JsArray<Self>, init: &Value, right: bool) -> JsResult<Value> {
        match name {
            "count_null" => Ok(enc_num(reduce_with(
                a,
                right,
                dec_num(init),
                |acc, x: &Maybe<f64>, _| Ok(acc + if x.is_null() { 1.0 } else { 0.0 }),
            )?)),
            _ => panic!("unknown reducer {name}"),
        }
    }
    fn first_reducer(name: &str, _: &JsArray<Self>) -> First<Self> {
        match name {
            "first_nonnull" => Box::new(|acc: Maybe<f64>, x: &Maybe<f64>, _| {
                Ok(if acc.is_nullish() { x.clone() } else { acc })
            }),
            _ => panic!("unknown first reducer {name}"),
        }
    }
    fn comparator(name: &str, _: &JsArray<Self>) -> Cmp<Self> {
        let key = |m: &Maybe<f64>| if defined(m).is_null() { 0.0 } else { 1.0 };
        match name {
            "nulls_first" => Box::new(move |a: &Maybe<f64>, b: &Maybe<f64>| Ok(key(a) - key(b))),
            "desc_null_low" => Box::new(|a: &Maybe<f64>, b: &Maybe<f64>| {
                Ok(defined(b).clone().or_else(|| -1.0) - defined(a).clone().or_else(|| -1.0))
            }),
            _ => panic!("unknown comparator {name}"),
        }
    }
}

impl Elem for Maybe<JsString> {
    const TYPE: &'static str = "mstr";
    fn dec(v: &Value, _: &Ctx) -> Self {
        dec_maybe(v, dec_str)
    }
    fn enc(&self, cx: &Ctx) -> Value {
        enc_maybe(self, cx)
    }
    fn sample() -> Self {
        Maybe::Undefined
    }
    fn pred(name: &str) -> Pred<Self> {
        match name {
            "nullish" => Box::new(|x: &Maybe<JsString>, _| Ok(x.is_nullish())),
            "truthy" => Box::new(|x: &Maybe<JsString>, _| Ok(x.truthy())),
            _ => panic!("unknown predicate {name}"),
        }
    }
    fn run_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        match name {
            "or_empty" => Ok(enc_arr(
                &ops::map(a, |x, _| Ok(x.clone().or_else(JsString::new)))?,
                cx,
            )),
            _ => panic!("unknown mapper {name}"),
        }
    }
    fn run_flat_map(name: &str, _: &JsArray<Self>, _: &Ctx) -> JsResult<Value> {
        panic!("unknown flat mapper {name}")
    }
    fn run_reduce(name: &str, a: &JsArray<Self>, init: &Value, right: bool) -> JsResult<Value> {
        match name {
            "cat_nullish" => Ok(enc_str(&reduce_with(
                a,
                right,
                dec_str(init),
                |acc, x: &Maybe<JsString>, _| {
                    Ok(acc.concat(&x.to_js_string()).concat(&JsString::from("|")))
                },
            )?)),
            _ => panic!("unknown reducer {name}"),
        }
    }
    fn first_reducer(name: &str, _: &JsArray<Self>) -> First<Self> {
        match name {
            "first_nonnull" => Box::new(|acc: Maybe<JsString>, x: &Maybe<JsString>, _| {
                Ok(if acc.is_nullish() { x.clone() } else { acc })
            }),
            _ => panic!("unknown first reducer {name}"),
        }
    }
    fn comparator(name: &str, _: &JsArray<Self>) -> Cmp<Self> {
        match name {
            "cu_string" => Box::new(|a: &Maybe<JsString>, b: &Maybe<JsString>| {
                Ok(units_cmp(
                    &defined(a).to_js_string(),
                    &defined(b).to_js_string(),
                ))
            }),
            _ => panic!("unknown comparator {name}"),
        }
    }
}

impl Elem for bool {
    const TYPE: &'static str = "bool";
    fn dec(v: &Value, _: &Ctx) -> Self {
        v.as_bool().expect("boolean")
    }
    fn enc(&self, _: &Ctx) -> Value {
        Value::Bool(*self)
    }
    fn sample() -> Self {
        false
    }
    fn pred(name: &str) -> Pred<Self> {
        match name {
            "id" => Box::new(|x: &bool, _| Ok(*x)),
            "not" => Box::new(|x: &bool, _| Ok(!*x)),
            _ => panic!("unknown predicate {name}"),
        }
    }
    fn run_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        match name {
            "not" => Ok(enc_arr(&ops::map(a, |x: &bool, _| Ok(!*x))?, cx)),
            _ => panic!("unknown mapper {name}"),
        }
    }
    fn run_flat_map(name: &str, _: &JsArray<Self>, _: &Ctx) -> JsResult<Value> {
        panic!("unknown flat mapper {name}")
    }
    fn run_reduce(name: &str, a: &JsArray<Self>, init: &Value, right: bool) -> JsResult<Value> {
        match name {
            "count_true" => Ok(enc_num(reduce_with(
                a,
                right,
                dec_num(init),
                |acc, x: &bool, _| Ok(acc + if *x { 1.0 } else { 0.0 }),
            )?)),
            _ => panic!("unknown reducer {name}"),
        }
    }
    fn first_reducer(name: &str, _: &JsArray<Self>) -> First<Self> {
        match name {
            "and" => Box::new(|acc: bool, x: &bool, _| Ok(acc && *x)),
            _ => panic!("unknown first reducer {name}"),
        }
    }
    fn comparator(name: &str, _: &JsArray<Self>) -> Cmp<Self> {
        match name {
            "false_first" => {
                Box::new(|a: &bool, b: &bool| Ok(f64::from(*a as u8) - f64::from(*b as u8)))
            }
            _ => panic!("unknown comparator {name}"),
        }
    }
}

impl Elem for JsArray<f64> {
    const TYPE: &'static str = "nested";
    fn dec(v: &Value, cx: &Ctx) -> Self {
        match v.get("ref") {
            Some(i) => cx.orig[i.as_u64().expect("ref") as usize].clone(),
            None => array(v.as_array().expect("array").iter().map(dec_num).collect()),
        }
    }
    fn enc(&self, cx: &Ctx) -> Value {
        match cx.orig.iter().position(|o| JsRef::ptr_eq(o, self)) {
            Some(i) => json!({ "ref": i }),
            None => enc_arr(self, cx),
        }
    }
    fn sample() -> Self {
        array(vec![7.0])
    }
    fn originals(items: &[Self]) -> Vec<JsArray<f64>> {
        items.to_vec()
    }
    fn pred(name: &str) -> Pred<Self> {
        match name {
            "nonempty" => Box::new(|x: &JsArray<f64>, _| Ok(ops::length(x) > 0.0)),
            "first_gt1" => {
                Box::new(|x: &JsArray<f64>, _| Ok(x.borrow().first().is_some_and(|v| *v > 1.0)))
            }
            _ => panic!("unknown predicate {name}"),
        }
    }
    fn run_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        Ok(match name {
            "len" => enc_arr(&ops::map(a, |x, _| Ok(ops::length(x)))?, cx),
            "first" => enc_arr(&ops::map(a, |x, _| Ok(ops::get(x, 0.0)))?, cx),
            "same" => enc_arr(&ops::map(a, |x, _| Ok(x.clone()))?, cx),
            _ => panic!("unknown mapper {name}"),
        })
    }
    fn run_flat_map(name: &str, a: &JsArray<Self>, cx: &Ctx) -> JsResult<Value> {
        Ok(match name {
            "same" => enc_arr(&ops::flat_map(a, |x, _| Ok(x.clone()))?, cx),
            "dup" => enc_arr(
                &ops::flat_map(a, |x, _| Ok(array(vec![x.clone(), x.clone()])))?,
                cx,
            ),
            _ => panic!("unknown flat mapper {name}"),
        })
    }
    fn run_reduce(name: &str, a: &JsArray<Self>, init: &Value, right: bool) -> JsResult<Value> {
        match name {
            "total" => Ok(enc_num(reduce_with(
                a,
                right,
                dec_num(init),
                |acc, x: &JsArray<f64>, _| Ok(acc + ops::length(x)),
            )?)),
            _ => panic!("unknown reducer {name}"),
        }
    }
    fn first_reducer(name: &str, _: &JsArray<Self>) -> First<Self> {
        match name {
            "longer" => Box::new(|acc: JsArray<f64>, x: &JsArray<f64>, _| {
                Ok(if ops::length(x) > ops::length(&acc) {
                    x.clone()
                } else {
                    acc
                })
            }),
            _ => panic!("unknown first reducer {name}"),
        }
    }
    fn comparator(name: &str, _: &JsArray<Self>) -> Cmp<Self> {
        let first = |x: &JsArray<f64>| ops::get(x, 0.0).or_else(|| 0.0);
        match name {
            "by_len" => {
                Box::new(|a: &JsArray<f64>, b: &JsArray<f64>| Ok(ops::length(a) - ops::length(b)))
            }
            "by_first" => {
                Box::new(move |a: &JsArray<f64>, b: &JsArray<f64>| Ok(first(a) - first(b)))
            }
            _ => panic!("unknown comparator {name}"),
        }
    }
    fn run_special(op: &str, a: &JsArray<Self>, cx: &Ctx) -> Option<Value> {
        match op {
            "flat" => Some(enc_arr(&ops::flat(a), cx)),
            _ => None,
        }
    }
}

// Array cases ---------------------------------------------------------------------------

/// Operations that never mutate the receiver (with non-mutating callbacks).
const READ_ONLY: &[&str] = &[
    "join",
    "get",
    "at",
    "slice",
    "concat",
    "index_of",
    "last_index_of",
    "includes",
    "to_reversed",
    "with",
    "flat",
    "find",
    "find_index",
    "find_last",
    "find_last_index",
    "some",
    "every",
    "filter",
    "map",
    "flat_map",
    "for_each",
    "reduce",
    "reduce_right",
    "reduce_first",
    "to_sorted",
];
const MUTATING_CALLBACKS: &[&str] = &["push_at_0", "pop_each", "push_at_1", "clobber"];

fn generic_pred<T: Elem>(name: &str, a: &JsArray<T>) -> Pred<T> {
    let arr = a.clone();
    match name {
        "idx_odd" => Box::new(|_: &T, i| Ok(i % 2.0 == 1.0)),
        "never" => Box::new(|_: &T, _| Ok(false)),
        "always" => Box::new(|_: &T, _| Ok(true)),
        "throw_at_1" => Box::new(|_: &T, i| if i == 1.0 { Err(boom()) } else { Ok(false) }),
        "push_at_0" => Box::new(move |_: &T, i| {
            if i == 0.0 {
                ops::push(&arr, vec![T::sample()]);
            }
            Ok(i % 2.0 == 0.0 && i > 0.0)
        }),
        "pop_each" => Box::new(move |_: &T, _| {
            ops::pop(&arr);
            Ok(true)
        }),
        _ => T::pred(name),
    }
}

/// Runs one array case; returns a description of every mismatch.
fn run_case<T: Elem>(case: &Value, inputs: &Value) -> Result<(), String> {
    let n = case["input"].as_u64().expect("input") as usize;
    let items: Vec<T> = inputs[T::TYPE][n]
        .as_array()
        .expect("input array")
        .iter()
        .map(|v| T::dec(v, &Ctx::default()))
        .collect();
    let cx = Ctx {
        orig: T::originals(&items),
    };
    let a = array(items);
    let before = enc_arr(&a, &cx);
    let op = case["op"].as_str().expect("op");
    let args = case["args"].as_array().expect("args");
    let cb = case["cb"].as_str();
    let elem = |i: usize| T::dec(&args[i], &cx);
    let items_from = |i: usize| args[i..].iter().map(|v| T::dec(v, &cx)).collect::<Vec<T>>();
    let mut expected_after = case["after"].clone();

    let epoch = mutation_epoch();
    let result: Value = match op {
        "join" => enc_str(&ops::join(&a, maybe_str(&args[0]))),
        "get" => {
            let i = dec_num(&args[0]);
            let got = ops::get(&a, i);
            // get_checked: the same value, or a RangeError where JS yields undefined.
            match (&got, ops::get_checked(&a, i)) {
                (Maybe::Undefined, Err(t)) if t.name.to_rust() == "RangeError" => {}
                (Maybe::Some(x), Ok(y)) if x.enc(&cx) == y.enc(&cx) => {}
                (_, other) => {
                    return Err(format!(
                        "get_checked mismatch: {:?}",
                        other.map(|y| y.enc(&cx))
                    ));
                }
            }
            enc_maybe(&got, &cx)
        }
        "at" => enc_maybe(&ops::at(&a, dec_num(&args[0])), &cx),
        "set" => {
            let i = dec_num(&args[0]);
            let len = ops::length(&a);
            let representable = i >= 0.0 && i.fract() == 0.0 && i <= len;
            match ops::set(&a, i, elem(1)) {
                Ok(()) if representable => undefined(),
                Err(t) if !representable && t.name.to_rust() == "RangeError" => {
                    // Documented deviation: holes and non-index properties.
                    expected_after = before.clone();
                    undefined()
                }
                other => {
                    return Err(format!(
                        "set({i}) gave {:?}",
                        other.map_err(|t| t.to_string())
                    ));
                }
            }
        }
        "push" => enc_num(ops::push(&a, items_from(0))),
        "unshift" => enc_num(ops::unshift(&a, items_from(0))),
        "pop" => enc_maybe(&ops::pop(&a), &cx),
        "shift" => enc_maybe(&ops::shift(&a), &cx),
        "reverse" => enc_ret(&ops::reverse(&a), &a, &cx),
        "to_reversed" => enc_ret(&ops::to_reversed(&a), &a, &cx),
        "slice" => enc_ret(
            &ops::slice(&a, maybe_num(&args[0]), maybe_num(&args[1])),
            &a,
            &cx,
        ),
        "splice" => {
            let r = ops::splice(&a, dec_num(&args[0]), maybe_num(&args[1]), items_from(2));
            enc_ret(&r, &a, &cx)
        }
        "concat" => {
            let concat_args = args
                .iter()
                .map(|v| {
                    if v.get("spread_receiver").is_some() {
                        ConcatArg::Array(a.clone())
                    } else if let Some(s) = v.get("spread") {
                        let s = s.as_array().expect("spread");
                        ConcatArg::Array(array(s.iter().map(|x| T::dec(x, &cx)).collect()))
                    } else {
                        ConcatArg::Item(T::dec(v, &cx))
                    }
                })
                .collect();
            enc_ret(&ops::concat(&a, concat_args), &a, &cx)
        }
        "index_of" => enc_num(ops::index_of(&a, &elem(0), maybe_num(&args[1]))),
        "last_index_of" => enc_num(ops::last_index_of(&a, &elem(0), maybe_num(&args[1]))),
        "includes" => Value::Bool(ops::includes(&a, &elem(0), maybe_num(&args[1]))),
        "fill" => enc_ret(
            &ops::fill(&a, elem(0), maybe_num(&args[1]), maybe_num(&args[2])),
            &a,
            &cx,
        ),
        "with" => enc_res(ops::with(&a, dec_num(&args[0]), elem(1)).map(|r| enc_ret(&r, &a, &cx))),
        "find" => enc_res(ops::find(&a, generic_pred(cb.unwrap(), &a)).map(|r| enc_maybe(&r, &cx))),
        "find_index" => enc_res(ops::find_index(&a, generic_pred(cb.unwrap(), &a)).map(enc_num)),
        "find_last" => {
            enc_res(ops::find_last(&a, generic_pred(cb.unwrap(), &a)).map(|r| enc_maybe(&r, &cx)))
        }
        "find_last_index" => {
            enc_res(ops::find_last_index(&a, generic_pred(cb.unwrap(), &a)).map(enc_num))
        }
        "some" => enc_res(ops::some(&a, generic_pred(cb.unwrap(), &a)).map(Value::Bool)),
        "every" => enc_res(ops::every(&a, generic_pred(cb.unwrap(), &a)).map(Value::Bool)),
        "filter" => {
            enc_res(ops::filter(&a, generic_pred(cb.unwrap(), &a)).map(|r| enc_ret(&r, &a, &cx)))
        }
        "map" => enc_res(T::run_map(cb.unwrap(), &a, &cx)),
        "flat_map" => enc_res(T::run_flat_map(cb.unwrap(), &a, &cx)),
        "for_each" => {
            let log = Rc::new(RefCell::new(Vec::new()));
            let throw = cb == Some("throw_at_1");
            let sink = Rc::clone(&log);
            let r = ops::for_each(&a, |x, i| {
                if throw && i == 1.0 {
                    return Err(boom());
                }
                sink.borrow_mut().push(json!([x.enc(&cx), enc_num(i)]));
                Ok(())
            });
            enc_res(r.map(|()| Value::Array(log.take())))
        }
        "reduce" => enc_res(T::run_reduce(cb.unwrap(), &a, &args[0], false)),
        "reduce_right" => enc_res(T::run_reduce(cb.unwrap(), &a, &args[0], true)),
        "reduce_first" => {
            enc_res(ops::reduce_first(&a, T::first_reducer(cb.unwrap(), &a)).map(|r| r.enc(&cx)))
        }
        "sort" | "to_sorted" => {
            let mut cmp = cb.map(|name| T::comparator(name, &a));
            let cmp = cmp
                .as_mut()
                .map(|c| &mut **c as &mut dyn FnMut(&T, &T) -> JsResult<f64>);
            let r = if op == "sort" {
                ops::sort(&a, cmp)
            } else {
                ops::to_sorted(&a, cmp)
            };
            enc_res(r.map(|r| enc_ret(&r, &a, &cx)))
        }
        other => T::run_special(other, &a, &cx).unwrap_or_else(|| panic!("unknown op {other}")),
    };
    let advanced = mutation_epoch() != epoch;
    let after = enc_arr(&a, &cx);

    let mut problems = Vec::new();
    if result != case["result"] {
        problems.push(format!("result {result} != expected {}", case["result"]));
    }
    if after != expected_after {
        problems.push(format!("receiver {after} != expected {expected_after}"));
    }
    let mutating_cb = cb.is_some_and(|c| MUTATING_CALLBACKS.contains(&c));
    if READ_ONLY.contains(&op) && !mutating_cb && advanced {
        problems.push("read-only operation advanced the mutation epoch".into());
    }
    if after != before && !advanced {
        problems.push("receiver changed without advancing the mutation epoch".into());
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(problems.join("; "))
    }
}

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/array.json")).expect("array.json")
}

#[test]
fn array_operations_match_node() {
    let data = vectors();
    let inputs = &data["inputs"];
    let cases = data["cases"].as_array().expect("cases");
    let mut failures = Vec::new();
    for case in cases {
        let outcome = match case["type"].as_str().expect("type") {
            "num" => run_case::<f64>(case, inputs),
            "str" => run_case::<JsString>(case, inputs),
            "mnum" => run_case::<Maybe<f64>>(case, inputs),
            "mstr" => run_case::<Maybe<JsString>>(case, inputs),
            "bool" => run_case::<bool>(case, inputs),
            "nested" => run_case::<JsArray<f64>>(case, inputs),
            other => panic!("unknown type {other}"),
        };
        if let Err(problem) = outcome {
            failures.push(format!(
                "#{} {} {}{} {} on input {}: {problem}",
                case["id"],
                case["type"].as_str().unwrap(),
                case["op"].as_str().unwrap(),
                case["cb"]
                    .as_str()
                    .map(|c| format!("[{c}]"))
                    .unwrap_or_default(),
                case["args"],
                case["input"]
            ));
        }
    }
    assert!(cases.len() > 5000, "vector file looks truncated");
    assert!(
        failures.is_empty(),
        "{} of {} cases failed:\n{}",
        failures.len(),
        cases.len(),
        failures
            .iter()
            .take(40)
            .cloned()
            .collect::<Vec<_>>()
            .join("\n")
    );
}

// Map and Set cases -----------------------------------------------------------------------

trait Key: ToMapKey + Clone + 'static {
    fn dec(v: &Value, pool: &Ctx) -> Self;
    fn enc(&self, pool: &Ctx) -> Value;
}
impl Key for f64 {
    fn dec(v: &Value, _: &Ctx) -> Self {
        dec_num(v)
    }
    fn enc(&self, _: &Ctx) -> Value {
        enc_num(*self)
    }
}
impl Key for JsString {
    fn dec(v: &Value, _: &Ctx) -> Self {
        dec_str(v)
    }
    fn enc(&self, _: &Ctx) -> Value {
        enc_str(self)
    }
}
impl Key for JsArray<f64> {
    fn dec(v: &Value, pool: &Ctx) -> Self {
        <JsArray<f64> as Elem>::dec(v, pool)
    }
    fn enc(&self, pool: &Ctx) -> Value {
        <JsArray<f64> as Elem>::enc(self, pool)
    }
}

fn enc_keys<K: Key>(a: &JsArray<K>, pool: &Ctx) -> Value {
    Value::Array(a.borrow().iter().map(|k| k.enc(pool)).collect())
}

/// Replays one Map/Set step sequence; returns the encoded step results and
/// whether each step advanced the mutation epoch.
fn replay<K: Key>(case: &Value, pool: &Ctx) -> Vec<(String, Value, bool)> {
    let steps = case["steps"].as_array().expect("steps");
    let init = case["init"].as_array().expect("init");
    let mut out = Vec::new();
    let mut record = |op: &str, f: &mut dyn FnMut() -> Value| {
        let epoch = mutation_epoch();
        let r = f();
        out.push((op.to_string(), r, mutation_epoch() != epoch));
    };
    if case["kind"] == "map" {
        let m: JsMap<K, f64> = ops::map_new(
            init.iter()
                .map(|e| (K::dec(&e[0], pool), dec_num(&e[1])))
                .collect(),
        );
        for step in steps {
            let op = step[0].as_str().expect("op");
            let key = || K::dec(&step[1], pool);
            record(op, &mut || match op {
                "set" => {
                    let r = ops::map_set(&m, key(), dec_num(&step[2]));
                    if JsRef::ptr_eq(&r, &m) {
                        json!({ "receiver": 1 })
                    } else {
                        json!("other map")
                    }
                }
                "get" => enc_maybe(&ops::map_get(&m, &key()), &Ctx::default()),
                "has" => Value::Bool(ops::map_has(&m, &key())),
                "delete" => Value::Bool(ops::map_delete(&m, &key())),
                "size" => enc_num(ops::map_size(&m)),
                "keys" => enc_keys(&ops::map_keys(&m), pool),
                "values" => enc_keys(&ops::map_values(&m), pool),
                "clear" => {
                    ops::map_clear(&m);
                    undefined()
                }
                other => panic!("unknown map op {other}"),
            });
        }
    } else {
        let s: JsSet<K> = ops::set_new(init.iter().map(|v| K::dec(v, pool)).collect());
        for step in steps {
            let op = step[0].as_str().expect("op");
            let key = || K::dec(&step[1], pool);
            record(op, &mut || match op {
                "add" => {
                    let r = ops::set_add(&s, key());
                    if JsRef::ptr_eq(&r, &s) {
                        json!({ "receiver": 1 })
                    } else {
                        json!("other set")
                    }
                }
                "has" => Value::Bool(ops::set_has(&s, &key())),
                "delete" => Value::Bool(ops::set_delete(&s, &key())),
                "size" => enc_num(ops::set_size(&s)),
                "values" => enc_keys(&ops::set_values(&s), pool),
                "clear" => {
                    ops::set_clear(&s);
                    undefined()
                }
                other => panic!("unknown set op {other}"),
            });
        }
    }
    out
}

/// Documented deviation: a `-0` key is not normalised to `+0` on insertion.
fn normalise_negative_zero(v: &Value) -> Value {
    match v {
        Value::String(s) if s == "-0" => json!("0"),
        Value::Array(items) => Value::Array(items.iter().map(normalise_negative_zero).collect()),
        other => other.clone(),
    }
}

#[test]
fn map_and_set_operations_match_node() {
    let data = vectors();
    let pool = Ctx {
        orig: data["pool"]
            .as_array()
            .expect("pool")
            .iter()
            .map(|v| array(v.as_array().unwrap().iter().map(dec_num).collect()))
            .collect(),
    };
    let cases = data["collections"].as_array().expect("collections");
    let mut failures = Vec::new();
    let mut steps = 0;
    for case in cases {
        let results = match case["ktype"].as_str().expect("ktype") {
            "num" => replay::<f64>(case, &pool),
            "str" => replay::<JsString>(case, &pool),
            "ref" => replay::<JsArray<f64>>(case, &pool),
            other => panic!("unknown key type {other}"),
        };
        let expected = case["results"].as_array().expect("results");
        assert_eq!(results.len(), expected.len());
        for (k, ((op, got, advanced), want)) in results.iter().zip(expected).enumerate() {
            steps += 1;
            let got = if case["deviation"] == "negzero-key" {
                normalise_negative_zero(got)
            } else {
                got.clone()
            };
            if &got != want {
                failures.push(format!(
                    "collection #{} step {k} {op}: {got} != {want}",
                    case["id"]
                ));
            }
            if ["get", "has", "size", "keys", "values"].contains(&op.as_str()) && *advanced {
                failures.push(format!(
                    "collection #{} step {k} {op} advanced the epoch",
                    case["id"]
                ));
            }
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {steps} steps failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

// Mutation epoch ------------------------------------------------------------------------

/// Discards a result (some are `Copy`).
fn ignore<T>(_: T) {}

fn nums(items: &[f64]) -> JsArray<f64> {
    array(items.to_vec())
}

/// Asserts whether running `f` advances the mutation epoch.
fn assert_epoch(label: &str, advances: bool, f: impl FnOnce()) {
    let before = mutation_epoch();
    f();
    assert_eq!(
        mutation_epoch() != before,
        advances,
        "{label}: epoch advanced = {}",
        !advances
    );
}

#[test]
fn read_only_operations_do_not_advance_the_epoch() {
    let a = nums(&[3.0, 1.0, 2.0]);
    let nested = array(vec![nums(&[1.0]), nums(&[2.0, 3.0])]);
    let m = ops::map_new(vec![(1.0, 10.0), (2.0, 20.0)]);
    let s = ops::set_new(vec![JsString::from("a"), JsString::from("b")]);
    let read = |label: &str, f: &dyn Fn()| assert_epoch(label, false, f);
    read("join", &|| ignore(ops::join(&a, Maybe::Undefined)));
    read("length", &|| ignore(ops::length(&a)));
    read("get", &|| ignore(ops::get(&a, 1.0)));
    read("get_checked", &|| ignore(ops::get_checked(&a, 7.0)));
    read("at", &|| ignore(ops::at(&a, -1.0)));
    read("slice", &|| {
        ignore(ops::slice(&a, Maybe::Some(1.0), Maybe::Undefined))
    });
    read("concat", &|| {
        ignore(ops::concat(
            &a,
            vec![ConcatArg::Array(a.clone()), ConcatArg::Item(4.0)],
        ))
    });
    read("index_of", &|| {
        ignore(ops::index_of(&a, &2.0, Maybe::Undefined))
    });
    read("last_index_of", &|| {
        ignore(ops::last_index_of(&a, &2.0, Maybe::Undefined))
    });
    read("includes", &|| {
        ignore(ops::includes(&a, &2.0, Maybe::Undefined))
    });
    read("find", &|| ignore(ops::find(&a, |x, _| Ok(*x > 1.0))));
    read("find_index", &|| {
        ignore(ops::find_index(&a, |x, _| Ok(*x > 1.0)))
    });
    read("find_last", &|| {
        ignore(ops::find_last(&a, |x, _| Ok(*x > 1.0)))
    });
    read("find_last_index", &|| {
        ignore(ops::find_last_index(&a, |x, _| Ok(*x > 1.0)))
    });
    read("some", &|| ignore(ops::some(&a, |x, _| Ok(*x > 1.0))));
    read("every", &|| ignore(ops::every(&a, |x, _| Ok(*x > 1.0))));
    read("filter", &|| ignore(ops::filter(&a, |x, _| Ok(*x > 1.0))));
    read("map", &|| ignore(ops::map(&a, |x, _| Ok(x * 2.0))));
    read("flat_map", &|| {
        ignore(ops::flat_map(&a, |x, _| Ok(nums(&[*x, *x]))))
    });
    read("for_each", &|| ignore(ops::for_each(&a, |_, _| Ok(()))));
    read("reduce", &|| {
        ignore(ops::reduce(&a, |acc, x, _| Ok(acc + x), 0.0))
    });
    read("reduce_first", &|| {
        ignore(ops::reduce_first(&a, |acc, x, _| Ok(acc + x)))
    });
    read("reduce_right", &|| {
        ignore(ops::reduce_right(&a, |acc, x, _| Ok(acc + x), 0.0))
    });
    read("to_sorted", &|| ignore(ops::to_sorted(&a, None)));
    read("to_sorted with comparator", &|| {
        ignore(ops::to_sorted(&a, Some(&mut |x: &f64, y: &f64| Ok(x - y))))
    });
    read("to_reversed", &|| ignore(ops::to_reversed(&a)));
    read("with", &|| ignore(ops::with(&a, 0.0, 9.0)));
    read("flat", &|| ignore(ops::flat(&nested)));
    read("map_get", &|| ignore(ops::map_get(&m, &1.0)));
    read("map_has", &|| ignore(ops::map_has(&m, &1.0)));
    read("map_size", &|| ignore(ops::map_size(&m)));
    read("map_keys", &|| ignore(ops::map_keys(&m)));
    read("map_values", &|| ignore(ops::map_values(&m)));
    read("set_has", &|| {
        ignore(ops::set_has(&s, &JsString::from("a")))
    });
    read("set_size", &|| ignore(ops::set_size(&s)));
    read("set_values", &|| ignore(ops::set_values(&s)));
    read("map_new/set_new", &|| {
        ignore(ops::map_new(vec![(1.0, 1.0)]));
        ignore(ops::set_new(vec![1.0]));
    });
    assert_eq!(ops::join(&a, Maybe::Undefined).to_rust(), "3,1,2");
}

#[test]
fn mutating_operations_advance_the_epoch() {
    let a = nums(&[3.0, 1.0, 2.0]);
    assert_epoch("set", true, || ops::set(&a, 0.0, 5.0).unwrap());
    assert_epoch("set append", true, || ops::set(&a, 3.0, 6.0).unwrap());
    assert_epoch("push", true, || ignore(ops::push(&a, vec![7.0])));
    assert_epoch("pop", true, || ignore(ops::pop(&a)));
    assert_epoch("shift", true, || ignore(ops::shift(&a)));
    assert_epoch("unshift", true, || ignore(ops::unshift(&a, vec![8.0])));
    assert_epoch("splice", true, || {
        ignore(ops::splice(&a, 1.0, Maybe::Some(1.0), vec![]))
    });
    assert_epoch("reverse", true, || ignore(ops::reverse(&a)));
    assert_epoch("sort", true, || ignore(ops::sort(&a, None)));
    assert_epoch("fill", true, || {
        ignore(ops::fill(&a, 0.0, Maybe::Some(1.0), Maybe::Undefined))
    });
    let m = ops::map_new(vec![(1.0, 10.0)]);
    assert_epoch("map_set new", true, || ignore(ops::map_set(&m, 2.0, 20.0)));
    assert_epoch("map_set existing", true, || {
        ignore(ops::map_set(&m, 2.0, 21.0))
    });
    assert_epoch("map_delete", true, || assert!(ops::map_delete(&m, &1.0)));
    assert_epoch("map_clear", true, || ops::map_clear(&m));
    let s = ops::set_new(vec![1.0]);
    assert_epoch("set_add new", true, || ignore(ops::set_add(&s, 2.0)));
    assert_epoch("set_delete", true, || assert!(ops::set_delete(&s, &1.0)));
    assert_epoch("set_clear", true, || ops::set_clear(&s));
}

#[test]
fn no_op_mutators_do_not_advance_the_epoch() {
    let empty = nums(&[]);
    let sorted = nums(&[1.0, 2.0, 3.0]);
    assert_epoch("push nothing", false, || {
        assert_eq!(ops::push(&sorted, vec![]), 3.0)
    });
    assert_epoch("unshift nothing", false, || {
        assert_eq!(ops::unshift(&sorted, vec![]), 3.0)
    });
    assert_epoch("pop empty", false, || {
        assert!(ops::pop(&empty).is_undefined())
    });
    assert_epoch("shift empty", false, || {
        assert!(ops::shift(&empty).is_undefined())
    });
    assert_epoch("splice nothing", false, || {
        ignore(ops::splice(&sorted, 1.0, Maybe::Some(0.0), vec![]))
    });
    assert_epoch("reverse one", false, || ignore(ops::reverse(&nums(&[1.0]))));
    assert_epoch("sort sorted", false, || ignore(ops::sort(&sorted, None)));
    assert_epoch("sort sorted with comparator", false, || {
        ignore(ops::sort(&sorted, Some(&mut |x: &f64, y: &f64| Ok(x - y))))
    });
    assert_epoch("sort throwing", false, || {
        let r = ops::sort(
            &nums(&[2.0, 1.0]),
            Some(&mut |_: &f64, _: &f64| Err(boom())),
        );
        assert_eq!(r.unwrap_err(), boom());
    });
    assert_epoch("fill empty range", false, || {
        ignore(ops::fill(&sorted, 0.0, Maybe::Some(2.0), Maybe::Some(1.0)))
    });
    assert_epoch("rejected set", false, || {
        assert!(ops::set(&sorted, 5.0, 0.0).is_err())
    });
    let m = ops::map_new(vec![(1.0, 10.0)]);
    assert_epoch("map_delete absent", false, || {
        assert!(!ops::map_delete(&m, &2.0))
    });
    let s = ops::set_new(vec![f64::NAN]);
    assert_epoch("set_add present", false, || {
        ignore(ops::set_add(&s, f64::NAN))
    });
    assert_epoch("set_delete absent", false, || {
        assert!(!ops::set_delete(&s, &1.0))
    });
    let empty_map: JsMap<f64, f64> = ops::map_new(vec![]);
    assert_epoch("map_clear empty", false, || ops::map_clear(&empty_map));
    let empty_set: JsSet<f64> = ops::set_new(vec![]);
    assert_epoch("set_clear empty", false, || ops::set_clear(&empty_set));
}

// Re-entrancy and documented deviations -----------------------------------------------------

#[test]
fn callbacks_may_read_the_receiver() {
    let a = nums(&[1.0, 2.0, 3.0]);
    let r = ops::map(&a, |x, i| {
        Ok(x + ops::length(&a) + ops::get_checked(&a, i)?)
    })
    .unwrap();
    assert_eq!(*r.borrow(), vec![5.0, 7.0, 9.0]);
    assert!(ops::some(&a, |_, _| Ok(ops::includes(&a, &3.0, Maybe::Undefined))).unwrap());
    let sum = ops::reduce(
        &a,
        |acc, x, _| Ok(acc + x + ops::at(&a, 0.0).or_else(|| 0.0)),
        0.0,
    );
    assert_eq!(sum.unwrap(), 9.0);
}

#[test]
fn copying_callbacks_may_mutate_the_receiver() {
    // filter/find/findLast/reduce (without initial value)/sort copy elements
    // out, so the callback may push, pop or assign.
    let a = nums(&[1.0, 2.0, 3.0]);
    let r = ops::filter(&a, |_, i| {
        if i == 0.0 {
            ops::push(&a, vec![4.0]);
        }
        Ok(true)
    });
    assert_eq!(*r.unwrap().borrow(), vec![1.0, 2.0, 3.0]);
    assert_eq!(*a.borrow(), vec![1.0, 2.0, 3.0, 4.0]);
    let total = ops::reduce_first(&a, |acc, x, _| {
        ops::pop(&a);
        Ok(acc + x)
    });
    // [1,2,3,4]: k=1 visits 2 (pop 4), k=2 visits 3 (pop 3), k=3 is gone.
    assert_eq!(total.unwrap(), 6.0);
    assert_eq!(*a.borrow(), vec![1.0, 2.0]);
}

#[test]
fn callbacks_may_mutate_the_receiver() {
    // JS: forEach visits the initial length; the pushes take effect.
    let a = nums(&[1.0, 2.0]);
    let mut seen = vec![];
    ops::for_each(&a, |x, _| {
        seen.push(*x);
        ops::push(&a, vec![3.0]);
        Ok(())
    })
    .unwrap();
    assert_eq!(seen, vec![1.0, 2.0]);
    assert_eq!(*a.borrow(), vec![1.0, 2.0, 3.0, 3.0]);
    // map/some/reduce copy elements too.
    let b = nums(&[1.0, 2.0, 3.0]);
    let doubled = ops::map(&b, |x, _| {
        ops::pop(&b);
        Ok(x * 2.0)
    })
    .unwrap();
    assert_eq!(*doubled.borrow(), vec![2.0, 4.0]);
}

#[test]
fn find_skips_indices_removed_by_the_callback() {
    // JavaScript would call the predicate with `undefined` for indices 2 and 3.
    let a = nums(&[1.0, 2.0, 3.0, 4.0]);
    let mut seen = Vec::new();
    let r = ops::find(&a, |x, i| {
        seen.push((*x, i));
        ops::pop(&a);
        Ok(false)
    });
    assert!(r.unwrap().is_undefined());
    assert_eq!(seen, vec![(1.0, 0.0), (2.0, 1.0)]);
    assert_eq!(*a.borrow(), vec![1.0, 2.0]);
}

#[test]
fn unrepresentable_reads_and_writes_throw_range_errors() {
    let a = nums(&[1.0, 2.0]);
    for i in [2.0, -1.0, 0.5, f64::NAN] {
        assert_eq!(
            ops::get_checked(&a, i).unwrap_err().name.to_rust(),
            "RangeError"
        );
    }
    assert_eq!(ops::get_checked(&a, -0.0).unwrap(), 1.0);
    for i in [3.0, -1.0, 0.5, f64::NAN, f64::INFINITY] {
        assert_eq!(
            ops::set(&a, i, 0.0).unwrap_err().name.to_rust(),
            "RangeError"
        );
    }
    assert_eq!(*a.borrow(), vec![1.0, 2.0]);
    ops::set(&a, -0.0, 9.0).unwrap();
    ops::set(&a, 2.0, 3.0).unwrap();
    assert_eq!(*a.borrow(), vec![9.0, 2.0, 3.0]);
}

#[test]
fn negative_zero_keys_keep_their_first_inserted_form() {
    // JavaScript stores -0 keys as +0; lookups agree either way.
    let m = ops::map_new(vec![(-0.0, 1.0)]);
    assert!(ops::map_has(&m, &0.0));
    let key = ops::map_keys(&m).borrow()[0];
    assert!(key == 0.0 && key.is_sign_negative());
}

#[test]
fn reduce_errors_and_default_sort_order() {
    let empty: JsArray<f64> = nums(&[]);
    let err = ops::reduce_first(&empty, |acc, x, _| Ok(acc + x)).unwrap_err();
    assert_eq!(
        err,
        Throw::type_error("Reduce of empty array with no initial value")
    );
    let mixed = array(vec![
        Maybe::Some(JsString::from("o")),
        Maybe::Undefined,
        Maybe::Null,
        Maybe::Some(JsString::from("nz")),
        Maybe::Some(JsString::from("nul")),
    ]);
    let sorted = ops::to_sorted(&mixed, None).unwrap();
    let joined = ops::join(&sorted, Maybe::Some(JsString::from("|")));
    assert_eq!(joined.to_rust(), "nul||nz|o|");
    assert!(sorted.borrow()[1].is_null());
}
