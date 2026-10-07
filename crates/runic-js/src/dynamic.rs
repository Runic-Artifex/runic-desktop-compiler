//! Dynamic values (M6 spike, docs/design/M6-DYNAMIC-VALUES.md): JavaScript
//! values whose type is known only at run time, for code the frontend
//! cannot type statically.
//!
//! The semantics are written once, generic over [`DynValue`]: generated
//! applications use [`Dyn`], the reference interpreter its own `Val`. A
//! static value boxed into a dynamic one keeps its identity: it is a view
//! ([`DynView`]) of the original, never a copy. Behaviour outside the
//! covered domain throws `RunicUnsupportedError`; it is never approximated.

use crate::{JsArray, JsRef, JsResult, JsString, Throw, array, number_to_string, string_to_number};
use std::any::Any;
use std::rc::Rc;

/// What a dynamic value is, for the generic operations.
pub enum Kind<'a> {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(&'a JsString),
    /// A plain object (or a boxed record): string-keyed properties in order.
    Object,
    /// A dense array (or a boxed static array).
    Array,
    Function,
    /// A boxed static value that has no dynamic members (an element, an
    /// event, a map, a class instance, ...), with a name for messages.
    Opaque(&'static str),
}

/// A representation of dynamic values. Object and array operations apply
/// only to values of that [`Kind`]; the generic operations check first.
pub trait DynValue: Clone + Sized {
    fn kind(&self) -> Kind<'_>;
    fn undefined() -> Self;
    fn null() -> Self;
    fn boolean(b: bool) -> Self;
    fn number(n: f64) -> Self;
    fn string(s: JsString) -> Self;
    fn new_object(entries: Vec<(JsString, Self)>) -> Self;
    fn new_array(items: Vec<Self>) -> Self;
    /// An own property of an object (`None`: absent).
    fn obj_get(&self, key: &JsString) -> JsResult<Option<Self>>;
    fn obj_set(&self, key: JsString, v: Self) -> JsResult<()>;
    fn obj_keys(&self) -> Vec<JsString>;
    fn arr_len(&self) -> usize;
    /// An item of an array (`i` below its length).
    fn arr_get(&self, i: usize) -> JsResult<Self>;
    /// Set item `i` (below the length) or append (`i` equal to it).
    fn arr_set(&self, i: usize, v: Self) -> JsResult<()>;
    fn arr_items(&self) -> JsResult<Vec<Self>>;
    /// Replace all items (in-place `sort`, `reverse`, `splice`).
    fn arr_replace(&self, items: Vec<Self>) -> JsResult<()>;
    /// Identity of objects, arrays, functions and boxed values.
    fn same_ref(&self, other: &Self) -> bool;
}

fn unsupported(what: impl Into<String>) -> Throw {
    Throw::new("RunicUnsupportedError", what)
}

fn type_error(what: impl Into<String>) -> Throw {
    Throw::new("TypeError", what)
}

/// `Object.prototype` members: reading one that an object does not have
/// would give the prototype's function, which dynamic values do not model.
const OBJECT_PROTOTYPE: &[&str] = &[
    "constructor",
    "hasOwnProperty",
    "isPrototypeOf",
    "propertyIsEnumerable",
    "toLocaleString",
    "toString",
    "valueOf",
    "__proto__",
];

/// A property key: ToString of the key value (ToPropertyKey without symbols).
pub fn property_key<V: DynValue>(key: &V) -> JsResult<JsString> {
    to_string(key)
}

/// An array index from a property key (a canonical non-negative integer).
fn array_index(key: &JsString) -> Option<usize> {
    let s = key.to_rust();
    if s.is_empty() || (s.len() > 1 && s.starts_with('0')) || !s.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    s.parse::<usize>().ok().filter(|i| *i < u32::MAX as usize)
}

/// How messages describe a dynamic value.
pub fn describe_of<V: DynValue>(v: &V) -> &'static str {
    describe(v)
}

fn describe<V: DynValue>(v: &V) -> &'static str {
    match v.kind() {
        Kind::Undefined => "undefined",
        Kind::Null => "null",
        Kind::Bool(_) => "a boolean",
        Kind::Num(_) => "a number",
        Kind::Str(_) => "a string",
        Kind::Object => "an object",
        Kind::Array => "an array",
        Kind::Function => "a function",
        Kind::Opaque(name) => name,
    }
}

/// `o[key]` (GetValue of a property reference).
pub fn get<V: DynValue>(o: &V, key: &V) -> JsResult<V> {
    let k = property_key(key)?;
    get_key(o, &k)
}

/// `o.name`.
pub fn get_key<V: DynValue>(o: &V, k: &JsString) -> JsResult<V> {
    match o.kind() {
        Kind::Undefined | Kind::Null => Err(type_error(format!(
            "Cannot read properties of {} (reading '{}')",
            describe(o),
            k.to_rust()
        ))),
        Kind::Object => match o.obj_get(k)? {
            Some(v) => Ok(v),
            None if OBJECT_PROTOTYPE.contains(&k.to_rust().as_str()) => Err(unsupported(format!(
                "reading Object.prototype's {} of a dynamic object",
                k.to_rust()
            ))),
            None => Ok(V::undefined()),
        },
        Kind::Array => {
            if k.to_rust() == "length" {
                return Ok(V::number(o.arr_len() as f64));
            }
            match array_index(k) {
                Some(i) if i < o.arr_len() => o.arr_get(i),
                Some(_) => Ok(V::undefined()),
                None => Err(unsupported(format!(
                    "reading {} of a dynamic array other than an index or length (methods are called)",
                    k.to_rust()
                ))),
            }
        }
        Kind::Str(s) => {
            if k.to_rust() == "length" {
                return Ok(V::number(s.len() as f64));
            }
            match array_index(k) {
                Some(i) if i < s.len() => Ok(V::string(s.slice_units(i, i + 1))),
                Some(_) => Ok(V::undefined()),
                None => Err(unsupported(format!(
                    "reading {} of a dynamic string (methods are called)",
                    k.to_rust()
                ))),
            }
        }
        Kind::Bool(_) | Kind::Num(_) | Kind::Function | Kind::Opaque(_) => Err(unsupported(
            format!("reading {} of {}", k.to_rust(), describe(o)),
        )),
    }
}

/// `o[key] = v` (strict mode: module code).
pub fn set<V: DynValue>(o: &V, key: &V, v: V) -> JsResult<()> {
    let k = property_key(key)?;
    set_key(o, k, v)
}

pub fn set_key<V: DynValue>(o: &V, k: JsString, v: V) -> JsResult<()> {
    match o.kind() {
        Kind::Undefined | Kind::Null => Err(type_error(format!(
            "Cannot set properties of {} (setting '{}')",
            describe(o),
            k.to_rust()
        ))),
        Kind::Object => {
            if k.to_rust() == "__proto__" {
                return Err(unsupported("setting __proto__ of a dynamic object"));
            }
            o.obj_set(k, v)
        }
        Kind::Array => match array_index(&k) {
            Some(i) if i <= o.arr_len() => o.arr_set(i, v),
            _ => Err(unsupported(format!(
                "setting {} of a dynamic array (holes, length and other properties are not covered)",
                k.to_rust()
            ))),
        },
        // Strict mode: assigning to a primitive's property throws.
        Kind::Bool(_) | Kind::Num(_) | Kind::Str(_) => Err(type_error(format!(
            "Cannot create property '{}' on {}",
            k.to_rust(),
            describe(o)
        ))),
        Kind::Function | Kind::Opaque(_) => Err(unsupported(format!(
            "setting {} of {}",
            k.to_rust(),
            describe(o)
        ))),
    }
}

/// ToPrimitive with the default hint, for the values dynamic objects can be.
fn to_primitive<V: DynValue>(v: &V) -> JsResult<V> {
    match v.kind() {
        Kind::Object => Ok(V::string(JsString::from("[object Object]"))),
        Kind::Array => Ok(V::string(join(v, &JsString::from(","))?)),
        Kind::Function => Err(unsupported(
            "converting a function to a primitive (its source text)",
        )),
        Kind::Opaque(name) => Err(unsupported(format!("converting {name} to a primitive"))),
        _ => Ok(v.clone()),
    }
}

/// `Object.keys`: own enumerable string keys (array and string indices first).
pub fn keys<V: DynValue>(v: &V) -> JsResult<Vec<JsString>> {
    let indices = |n: usize| (0..n).map(|i| JsString::from(i.to_string())).collect();
    Ok(match v.kind() {
        Kind::Undefined | Kind::Null => {
            return Err(type_error("Cannot convert undefined or null to object"));
        }
        Kind::Object => v.obj_keys(),
        Kind::Array => indices(v.arr_len()),
        Kind::Str(s) => indices(s.units().len()),
        Kind::Opaque(what) => return Err(unsupported(format!("Object.keys of {what}"))),
        Kind::Bool(_) | Kind::Num(_) | Kind::Function => vec![],
    })
}

/// ToString.
pub fn to_string<V: DynValue>(v: &V) -> JsResult<JsString> {
    Ok(match v.kind() {
        Kind::Undefined => JsString::from("undefined"),
        Kind::Null => JsString::from("null"),
        Kind::Bool(b) => JsString::from(if b { "true" } else { "false" }),
        Kind::Num(n) => JsString::from(number_to_string(n)),
        Kind::Str(s) => s.clone(),
        _ => return to_string(&to_primitive(v)?),
    })
}

/// ToNumber.
pub fn to_number<V: DynValue>(v: &V) -> JsResult<f64> {
    Ok(match v.kind() {
        Kind::Undefined => f64::NAN,
        Kind::Null => 0.0,
        Kind::Bool(b) => {
            if b {
                1.0
            } else {
                0.0
            }
        }
        Kind::Num(n) => n,
        Kind::Str(s) => string_to_number(s),
        _ => return to_number(&to_primitive(v)?),
    })
}

/// ToBoolean.
pub fn truthy<V: DynValue>(v: &V) -> bool {
    match v.kind() {
        Kind::Undefined | Kind::Null => false,
        Kind::Bool(b) => b,
        Kind::Num(n) => !(n == 0.0 || n.is_nan()),
        Kind::Str(s) => !s.is_empty(),
        _ => true,
    }
}

/// `typeof`.
pub fn type_of<V: DynValue>(v: &V) -> &'static str {
    match v.kind() {
        Kind::Undefined => "undefined",
        Kind::Null | Kind::Object | Kind::Array | Kind::Opaque(_) => "object",
        Kind::Bool(_) => "boolean",
        Kind::Num(_) => "number",
        Kind::Str(_) => "string",
        Kind::Function => "function",
    }
}

/// IsStrictlyEqual.
pub fn strict_eq<V: DynValue>(a: &V, b: &V) -> bool {
    match (a.kind(), b.kind()) {
        (Kind::Undefined, Kind::Undefined) | (Kind::Null, Kind::Null) => true,
        (Kind::Bool(x), Kind::Bool(y)) => x == y,
        (Kind::Num(x), Kind::Num(y)) => x == y,
        (Kind::Str(x), Kind::Str(y)) => x == y,
        (Kind::Object, Kind::Object)
        | (Kind::Array, Kind::Array)
        | (Kind::Function, Kind::Function)
        | (Kind::Opaque(_), Kind::Opaque(_)) => a.same_ref(b),
        _ => false,
    }
}

/// IsLooselyEqual (without symbols and bigints).
pub fn loose_eq<V: DynValue>(a: &V, b: &V) -> JsResult<bool> {
    let primitive = |v: &V| matches!(v.kind(), Kind::Bool(_) | Kind::Num(_) | Kind::Str(_));
    match (a.kind(), b.kind()) {
        (Kind::Undefined | Kind::Null, Kind::Undefined | Kind::Null) => Ok(true),
        (Kind::Undefined | Kind::Null, _) | (_, Kind::Undefined | Kind::Null) => Ok(false),
        (Kind::Num(x), Kind::Str(s)) => Ok(x == string_to_number(s)),
        (Kind::Str(s), Kind::Num(y)) => Ok(string_to_number(s) == y),
        (Kind::Bool(x), _) => loose_eq(&V::number(if x { 1.0 } else { 0.0 }), b),
        (_, Kind::Bool(y)) => loose_eq(a, &V::number(if y { 1.0 } else { 0.0 })),
        _ if primitive(a) && !primitive(b) => loose_eq(a, &to_primitive(b)?),
        _ if !primitive(a) && primitive(b) => loose_eq(&to_primitive(a)?, b),
        _ => Ok(strict_eq(a, b)),
    }
}

/// Binary arithmetic and `+` (ApplyStringOrNumericBinaryOperator).
pub fn binary<V: DynValue>(op: &str, a: &V, b: &V) -> JsResult<V> {
    if op == "+" {
        let (pa, pb) = (to_primitive(a)?, to_primitive(b)?);
        if matches!(pa.kind(), Kind::Str(_)) || matches!(pb.kind(), Kind::Str(_)) {
            return Ok(V::string(to_string(&pa)?.concat(&to_string(&pb)?)));
        }
        return Ok(V::number(to_number(&pa)? + to_number(&pb)?));
    }
    let (x, y) = (to_number(a)?, to_number(b)?);
    Ok(V::number(match op {
        "-" => x - y,
        "*" => x * y,
        "/" => x / y,
        "%" => {
            if y == 0.0 || x.is_infinite() || x.is_nan() || y.is_nan() {
                f64::NAN
            } else if y.is_infinite() {
                x
            } else {
                // The sign of the dividend, as `%` gives it.
                let r = x % y;
                if r == 0.0 { 0.0f64.copysign(x) } else { r }
            }
        }
        "**" => crate::pow(x, y),
        _ => return Err(unsupported(format!("the {op} operator on dynamic values"))),
    }))
}

/// `<`, `<=`, `>`, `>=` (IsLessThan).
pub fn compare<V: DynValue>(op: &str, a: &V, b: &V) -> JsResult<bool> {
    let (pa, pb) = (to_primitive(a)?, to_primitive(b)?);
    // Undefined: NaN compared.
    let less = |l: &V, r: &V| -> JsResult<Option<bool>> {
        if let (Kind::Str(x), Kind::Str(y)) = (l.kind(), r.kind()) {
            return Ok(Some(x.units() < y.units()));
        }
        let (x, y) = (to_number(l)?, to_number(r)?);
        Ok(if x.is_nan() || y.is_nan() {
            None
        } else {
            Some(x < y)
        })
    };
    Ok(match op {
        "<" => less(&pa, &pb)? == Some(true),
        ">" => less(&pb, &pa)? == Some(true),
        "<=" => less(&pb, &pa)? == Some(false),
        ">=" => less(&pa, &pb)? == Some(false),
        _ => {
            return Err(unsupported(format!(
                "the {op} comparison on dynamic values"
            )));
        }
    })
}

/// Unary `-` and `+`.
pub fn unary<V: DynValue>(op: &str, v: &V) -> JsResult<V> {
    let x = to_number(v)?;
    match op {
        "-" => Ok(V::number(-x)),
        "+" => Ok(V::number(x)),
        _ => Err(unsupported(format!(
            "the unary {op} operator on dynamic values"
        ))),
    }
}

/// `Array.prototype.join` of a dynamic array.
fn join<V: DynValue>(a: &V, sep: &JsString) -> JsResult<JsString> {
    let mut out = JsString::new();
    for (i, item) in a.arr_items()?.iter().enumerate() {
        if i > 0 {
            out = out.concat(sep);
        }
        if !matches!(item.kind(), Kind::Undefined | Kind::Null) {
            out = out.concat(&to_string(item)?);
        }
    }
    Ok(out)
}

/// Calls a function value: `call(f, this, args)`.
pub type Caller<'c, V> = dyn FnMut(&V, V, Vec<V>) -> JsResult<V> + 'c;

fn arg<V: DynValue>(args: &[V], i: usize) -> V {
    args.get(i).cloned().unwrap_or_else(V::undefined)
}

/// A relative index argument (`slice`, `indexOf`, `includes` from-index).
fn relative<V: DynValue>(v: &V, len: usize, default: usize) -> JsResult<usize> {
    if matches!(v.kind(), Kind::Undefined) {
        return Ok(default);
    }
    let n = to_number(v)?;
    let n = if n.is_nan() { 0.0 } else { n.trunc() };
    let len = len as f64;
    Ok(if n < 0.0 {
        (len + n).max(0.0)
    } else {
        n.min(len)
    } as usize)
}

/// `o.name(...args)`: a built-in method of a dynamic array or string, or a
/// function-valued property of an object called with `this` = `o`.
pub fn method<V: DynValue>(
    o: &V,
    name: &str,
    args: Vec<V>,
    call: &mut Caller<'_, V>,
) -> JsResult<V> {
    match o.kind() {
        Kind::Array => array_method(o, name, args, call),
        Kind::Str(s) => string_method(s, name, args),
        Kind::Object => {
            let f = get_key(o, &JsString::from(name))?;
            match f.kind() {
                Kind::Function => call(&f, o.clone(), args),
                _ => Err(type_error(format!("o.{name} is not a function"))),
            }
        }
        Kind::Undefined | Kind::Null => Err(type_error(format!(
            "Cannot read properties of {} (reading '{name}')",
            describe(o)
        ))),
        _ => Err(unsupported(format!(
            "calling {name} on {} (a dynamic value)",
            describe(o)
        ))),
    }
}

fn callback<V: DynValue>(args: &[V], name: &str) -> JsResult<V> {
    let f = arg(args, 0);
    if matches!(f.kind(), Kind::Function) {
        Ok(f)
    } else {
        Err(type_error(format!(
            "{} is not a function ({name})",
            describe(&f)
        )))
    }
}

fn array_method<V: DynValue>(
    a: &V,
    name: &str,
    args: Vec<V>,
    call: &mut Caller<'_, V>,
) -> JsResult<V> {
    let items = || a.arr_items();
    match name {
        "push" => {
            for v in args {
                a.arr_set(a.arr_len(), v)?;
            }
            Ok(V::number(a.arr_len() as f64))
        }
        "pop" => {
            let mut all = items()?;
            let last = all.pop();
            a.arr_replace(all)?;
            Ok(last.unwrap_or_else(V::undefined))
        }
        "shift" => {
            let mut all = items()?;
            if all.is_empty() {
                return Ok(V::undefined());
            }
            let first = all.remove(0);
            a.arr_replace(all)?;
            Ok(first)
        }
        "join" => {
            let sep = match arg(&args, 0).kind() {
                Kind::Undefined => JsString::from(","),
                _ => to_string(&args[0])?,
            };
            Ok(V::string(join(a, &sep)?))
        }
        "slice" => {
            let all = items()?;
            let start = relative(&arg(&args, 0), all.len(), 0)?;
            let end = relative(&arg(&args, 1), all.len(), all.len())?;
            Ok(V::new_array(if start < end {
                all[start..end].to_vec()
            } else {
                vec![]
            }))
        }
        "indexOf" | "includes" | "lastIndexOf" => {
            let all = items()?;
            let x = arg(&args, 0);
            let found = if name == "lastIndexOf" {
                all.iter().rposition(|v| strict_eq(v, &x))
            } else {
                let from = relative(&arg(&args, 1), all.len(), 0)?;
                all.iter().skip(from).position(|v| {
                    if name == "includes" {
                        // SameValueZero: NaN finds NaN.
                        strict_eq(v, &x)
                            || matches!((v.kind(), x.kind()), (Kind::Num(p), Kind::Num(q)) if p.is_nan() && q.is_nan())
                    } else {
                        strict_eq(v, &x)
                    }
                })
                .map(|i| i + from)
            };
            Ok(if name == "includes" {
                V::boolean(found.is_some())
            } else {
                V::number(found.map_or(-1.0, |i| i as f64))
            })
        }
        "forEach" | "map" | "filter" | "find" | "findIndex" | "some" | "every" => {
            let f = callback(&args, name)?;
            let this = arg(&args, 1);
            let all = items()?;
            let mut out = vec![];
            for (i, v) in all.into_iter().enumerate() {
                let r = call(
                    &f,
                    this.clone(),
                    vec![v.clone(), V::number(i as f64), a.clone()],
                )?;
                match name {
                    "map" => out.push(r),
                    "filter" if truthy(&r) => out.push(v),
                    "find" if truthy(&r) => return Ok(v),
                    "findIndex" if truthy(&r) => return Ok(V::number(i as f64)),
                    "some" if truthy(&r) => return Ok(V::boolean(true)),
                    "every" if !truthy(&r) => return Ok(V::boolean(false)),
                    _ => {}
                }
            }
            Ok(match name {
                "forEach" => V::undefined(),
                "map" | "filter" => V::new_array(out),
                "find" => V::undefined(),
                "findIndex" => V::number(-1.0),
                "some" => V::boolean(false),
                _ => V::boolean(true),
            })
        }
        "reduce" => {
            let f = callback(&args, name)?;
            let all = items()?;
            let mut it = all.into_iter().enumerate();
            let mut acc = if args.len() > 1 {
                args[1].clone()
            } else {
                match it.next() {
                    Some((_, v)) => v,
                    None => return Err(type_error("Reduce of empty array with no initial value")),
                }
            };
            for (i, v) in it {
                acc = call(
                    &f,
                    V::undefined(),
                    vec![acc, v, V::number(i as f64), a.clone()],
                )?;
            }
            Ok(acc)
        }
        "sort" => {
            let mut all = items()?;
            let f = arg(&args, 0);
            // Undefined items last, as the specification sorts them.
            let (mut defined, undefined): (Vec<V>, Vec<V>) = all
                .drain(..)
                .partition(|v| !matches!(v.kind(), Kind::Undefined));
            let mut error = None;
            // A stable merge sort (V8's TimSort is stable) with a fallible comparator.
            let mut cmp = |x: &V, y: &V| -> std::cmp::Ordering {
                if error.is_some() {
                    return std::cmp::Ordering::Equal;
                }
                let r = if matches!(f.kind(), Kind::Undefined) {
                    match (to_string(x), to_string(y)) {
                        (Ok(p), Ok(q)) => Ok(p.units().cmp(q.units())),
                        (Err(e), _) | (_, Err(e)) => Err(e),
                    }
                } else {
                    call(&f, V::undefined(), vec![x.clone(), y.clone()])
                        .and_then(|r| to_number(&r))
                        .map(|n| {
                            if n < 0.0 {
                                std::cmp::Ordering::Less
                            } else if n > 0.0 {
                                std::cmp::Ordering::Greater
                            } else {
                                std::cmp::Ordering::Equal
                            }
                        })
                };
                r.unwrap_or_else(|e| {
                    error = Some(e);
                    std::cmp::Ordering::Equal
                })
            };
            merge_sort(&mut defined, &mut cmp);
            if let Some(e) = error {
                return Err(e);
            }
            defined.extend(undefined);
            a.arr_replace(defined)?;
            Ok(a.clone())
        }
        "reverse" => {
            let mut all = items()?;
            all.reverse();
            a.arr_replace(all)?;
            Ok(a.clone())
        }
        "concat" => {
            let mut all = items()?;
            for v in args {
                match v.kind() {
                    Kind::Array => all.extend(v.arr_items()?),
                    _ => all.push(v),
                }
            }
            Ok(V::new_array(all))
        }
        _ => Err(unsupported(format!(
            "the array method {name} on a dynamic array"
        ))),
    }
}

fn merge_sort<T: Clone>(v: &mut [T], cmp: &mut dyn FnMut(&T, &T) -> std::cmp::Ordering) {
    if v.len() < 2 {
        return;
    }
    let mid = v.len() / 2;
    merge_sort(&mut v[..mid], cmp);
    merge_sort(&mut v[mid..], cmp);
    let (left, right) = (v[..mid].to_vec(), v[mid..].to_vec());
    let (mut i, mut j) = (0, 0);
    for slot in v.iter_mut() {
        let take_left = j >= right.len()
            || (i < left.len() && cmp(&left[i], &right[j]) != std::cmp::Ordering::Greater);
        if take_left {
            *slot = left[i].clone();
            i += 1;
        } else {
            *slot = right[j].clone();
            j += 1;
        }
    }
}

fn string_method<V: DynValue>(s: &JsString, name: &str, args: Vec<V>) -> JsResult<V> {
    let text = |i: usize| -> JsResult<JsString> { to_string(&arg(&args, i)) };
    match name {
        "toLowerCase" => Ok(V::string(crate::string_ops::to_lower_case(s))),
        "toUpperCase" => Ok(V::string(crate::string_ops::to_upper_case(s))),
        "trim" => Ok(V::string(crate::string_ops::trim(s))),
        "trimStart" => Ok(V::string(crate::string_ops::trim_start(s))),
        "trimEnd" => Ok(V::string(crate::string_ops::trim_end(s))),
        "slice" => {
            let start = relative(&arg(&args, 0), s.len(), 0)?;
            let end = relative(&arg(&args, 1), s.len(), s.len())?;
            Ok(V::string(if start < end {
                s.slice_units(start, end)
            } else {
                JsString::new()
            }))
        }
        "includes" | "startsWith" | "endsWith" | "indexOf" => {
            let needle = text(0)?;
            let (h, n) = (s.units(), needle.units());
            Ok(match name {
                "includes" => V::boolean(n.is_empty() || h.windows(n.len()).any(|w| w == n)),
                "startsWith" => V::boolean(h.starts_with(n)),
                "endsWith" => V::boolean(h.ends_with(n)),
                _ => V::number(if n.is_empty() {
                    0.0
                } else {
                    h.windows(n.len())
                        .position(|w| w == n)
                        .map_or(-1.0, |i| i as f64)
                }),
            })
        }
        "toString" | "valueOf" => Ok(V::string(s.clone())),
        _ => Err(unsupported(format!(
            "the string method {name} on a dynamic string"
        ))),
    }
}

/// An object literal: keys in order, a later duplicate replacing the value
/// in the first key's position (as defineProperty does).
pub fn object<V: DynValue>(entries: Vec<(JsString, V)>) -> V {
    let mut out: Vec<(JsString, V)> = vec![];
    for (k, v) in entries {
        match out.iter_mut().find(|(x, _)| *x == k) {
            Some(slot) => slot.1 = v,
            None => out.push((k, v)),
        }
    }
    V::new_object(out)
}

// --- The representation of generated applications ---------------------------

/// A function value: `f(cx, this, args)`, `cx` the application's context.
pub type DynFn = Rc<dyn Fn(&mut dyn Any, Dyn, Vec<Dyn>) -> JsResult<Dyn>>;

/// A dynamic value of a generated application.
#[derive(Clone)]
pub enum Dyn {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(JsString),
    Object(JsRef<Vec<(JsString, Dyn)>>),
    /// The same representation as a static `array<dyn>`: boxing one keeps it.
    Array(JsArray<Dyn>),
    /// A function and its identity (the address of the static function it
    /// boxes: boxing one function twice gives `===` values).
    Fn(DynFn, usize),
    Boxed(Rc<dyn DynView>),
}

impl Default for Dyn {
    fn default() -> Self {
        Dyn::Undefined
    }
}

impl std::fmt::Debug for Dyn {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Dyn::Undefined => f.write_str("undefined"),
            Dyn::Null => f.write_str("null"),
            Dyn::Bool(b) => write!(f, "{b}"),
            Dyn::Num(n) => write!(f, "{n}"),
            Dyn::Str(s) => write!(f, "{:?}", s.to_rust()),
            Dyn::Object(_) => f.write_str("[object]"),
            Dyn::Array(_) => f.write_str("[array]"),
            Dyn::Fn(..) => f.write_str("[function]"),
            Dyn::Boxed(b) => write!(f, "[boxed {}]", b.kind_name()),
        }
    }
}

/// A static value boxed into a dynamic one: the generated application
/// implements it per static type (records answer by field name, arrays by
/// index; other values are opaque).
pub trait DynView {
    /// `"record"`, `"array"`, or an opaque kind's description.
    fn kind_name(&self) -> &'static str;
    fn as_any(&self) -> &dyn Any;
    /// The identity of the boxed value (its heap address).
    fn addr(&self) -> usize;
    fn is_object(&self) -> bool {
        false
    }
    fn is_array(&self) -> bool {
        false
    }
    fn get(&self, key: &JsString) -> JsResult<Option<Dyn>> {
        let _ = key;
        Ok(None)
    }
    fn set(&self, key: JsString, v: Dyn) -> JsResult<()> {
        let _ = v;
        Err(unsupported(format!(
            "setting {} of a boxed {}",
            key.to_rust(),
            self.kind_name()
        )))
    }
    fn keys(&self) -> Vec<JsString> {
        vec![]
    }
    fn len(&self) -> usize {
        0
    }
    fn item(&self, i: usize) -> JsResult<Dyn> {
        let _ = i;
        Err(unsupported(format!(
            "indexing a boxed {}",
            self.kind_name()
        )))
    }
    fn set_item(&self, i: usize, v: Dyn) -> JsResult<()> {
        let _ = (i, v);
        Err(unsupported(format!(
            "writing items of a boxed {}",
            self.kind_name()
        )))
    }
    fn replace(&self, items: Vec<Dyn>) -> JsResult<()> {
        let _ = items;
        Err(unsupported(format!(
            "reordering a boxed {}",
            self.kind_name()
        )))
    }
}

impl DynValue for Dyn {
    fn kind(&self) -> Kind<'_> {
        match self {
            Dyn::Undefined => Kind::Undefined,
            Dyn::Null => Kind::Null,
            Dyn::Bool(b) => Kind::Bool(*b),
            Dyn::Num(n) => Kind::Num(*n),
            Dyn::Str(s) => Kind::Str(s),
            Dyn::Object(_) => Kind::Object,
            Dyn::Array(_) => Kind::Array,
            Dyn::Fn(..) => Kind::Function,
            Dyn::Boxed(b) if b.is_object() => Kind::Object,
            Dyn::Boxed(b) if b.is_array() => Kind::Array,
            Dyn::Boxed(b) => Kind::Opaque(b.kind_name()),
        }
    }
    fn undefined() -> Self {
        Dyn::Undefined
    }
    fn null() -> Self {
        Dyn::Null
    }
    fn boolean(b: bool) -> Self {
        Dyn::Bool(b)
    }
    fn number(n: f64) -> Self {
        Dyn::Num(n)
    }
    fn string(s: JsString) -> Self {
        Dyn::Str(s)
    }
    fn new_object(entries: Vec<(JsString, Self)>) -> Self {
        Dyn::Object(JsRef::new(entries))
    }
    fn new_array(items: Vec<Self>) -> Self {
        Dyn::Array(array(items))
    }
    fn obj_get(&self, key: &JsString) -> JsResult<Option<Self>> {
        match self {
            Dyn::Object(o) => Ok(o
                .borrow()
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())),
            Dyn::Boxed(b) => b.get(key),
            _ => Ok(None),
        }
    }
    fn obj_set(&self, key: JsString, v: Self) -> JsResult<()> {
        match self {
            Dyn::Object(o) => {
                let mut o = o.borrow_mut();
                match o.iter_mut().find(|(k, _)| *k == key) {
                    Some(slot) => slot.1 = v,
                    None => o.push((key, v)),
                }
                Ok(())
            }
            Dyn::Boxed(b) => b.set(key, v),
            _ => Err(unsupported("setting a property of a non-object")),
        }
    }
    fn obj_keys(&self) -> Vec<JsString> {
        match self {
            Dyn::Object(o) => o.borrow().iter().map(|(k, _)| k.clone()).collect(),
            Dyn::Boxed(b) => b.keys(),
            _ => vec![],
        }
    }
    fn arr_len(&self) -> usize {
        match self {
            Dyn::Array(a) => a.borrow().len(),
            Dyn::Boxed(b) => b.len(),
            _ => 0,
        }
    }
    fn arr_get(&self, i: usize) -> JsResult<Self> {
        match self {
            Dyn::Array(a) => Ok(a.borrow()[i].clone()),
            Dyn::Boxed(b) => b.item(i),
            _ => Ok(Dyn::Undefined),
        }
    }
    fn arr_set(&self, i: usize, v: Self) -> JsResult<()> {
        match self {
            Dyn::Array(a) => {
                let mut a = a.borrow_mut();
                if i < a.len() {
                    a[i] = v;
                } else {
                    a.push(v);
                }
                Ok(())
            }
            Dyn::Boxed(b) => b.set_item(i, v),
            _ => Err(unsupported("writing an item of a non-array")),
        }
    }
    fn arr_items(&self) -> JsResult<Vec<Self>> {
        match self {
            Dyn::Array(a) => Ok(a.borrow().clone()),
            Dyn::Boxed(b) => (0..b.len()).map(|i| b.item(i)).collect(),
            _ => Ok(vec![]),
        }
    }
    fn arr_replace(&self, items: Vec<Self>) -> JsResult<()> {
        match self {
            Dyn::Array(a) => {
                *a.borrow_mut() = items;
                Ok(())
            }
            Dyn::Boxed(b) => b.replace(items),
            _ => Err(unsupported("reordering a non-array")),
        }
    }
    fn same_ref(&self, other: &Self) -> bool {
        match (self, other) {
            (Dyn::Object(a), Dyn::Object(b)) => JsRef::ptr_eq(a, b),
            (Dyn::Array(a), Dyn::Array(b)) => JsRef::ptr_eq(a, b),
            (Dyn::Fn(_, a), Dyn::Fn(_, b)) => a == b,
            (Dyn::Boxed(a), Dyn::Boxed(b)) => a.addr() == b.addr(),
            _ => false,
        }
    }
}

/// Calls `f` (a function value) for generated code.
pub fn call(cx: &mut dyn Any, f: &Dyn, this: Dyn, args: Vec<Dyn>) -> JsResult<Dyn> {
    match f {
        Dyn::Fn(g, _) => g(cx, this, args),
        other => Err(type_error(format!("{} is not a function", describe(other)))),
    }
}

/// `o.name(...args)` for generated code.
pub fn call_method(cx: &mut dyn Any, o: &Dyn, name: &str, args: Vec<Dyn>) -> JsResult<Dyn> {
    method(o, name, args, &mut |f, this, args| call(cx, f, this, args))
}

/// The value of a dynamic number for a static `number` slot.
pub fn expect_number(v: &Dyn) -> JsResult<f64> {
    match v {
        Dyn::Num(n) => Ok(*n),
        other => Err(mismatch("a number", other)),
    }
}

pub fn expect_string(v: &Dyn) -> JsResult<JsString> {
    match v {
        Dyn::Str(s) => Ok(s.clone()),
        other => Err(mismatch("a string", other)),
    }
}

pub fn expect_boolean(v: &Dyn) -> JsResult<bool> {
    match v {
        Dyn::Bool(b) => Ok(*b),
        other => Err(mismatch("a boolean", other)),
    }
}

pub fn expect_array(v: &Dyn) -> JsResult<JsArray<Dyn>> {
    match v {
        Dyn::Array(a) => Ok(a.clone()),
        other => Err(mismatch("an array of dynamic values", other)),
    }
}

/// A boxed value of the static type whose view is `T`.
pub fn expect_boxed<T: Any + Clone>(v: &Dyn, what: &str) -> JsResult<T> {
    if let Dyn::Boxed(b) = v {
        if let Some(t) = b.as_any().downcast_ref::<T>() {
            return Ok(t.clone());
        }
    }
    Err(mismatch(what, v))
}

/// A dynamic value that does not fit the static slot it reaches: the
/// program would carry on in JavaScript with a value the static code cannot
/// hold (docs/design/M6-DYNAMIC-VALUES.md, boundaries).
pub fn mismatch(want: &str, got: &Dyn) -> Throw {
    mismatch_of(want, got)
}

/// [`mismatch`] for any representation (the interpreter's).
pub fn mismatch_of<V: DynValue>(want: &str, got: &V) -> Throw {
    unsupported(format!(
        "a dynamic value ({}) where the program's static code holds {want}",
        describe(got)
    ))
}

/// A dynamic value in reactive state is held by identity, as `$state.raw`
/// holds values (docs/design/M6-DYNAMIC-VALUES.md, reactivity).
impl crate::Own for Dyn {}

impl crate::StrictEq for Dyn {
    fn strict_eq(&self, other: &Self) -> bool {
        strict_eq(self, other)
    }
}
impl crate::Truthy for Dyn {
    fn truthy(&self) -> bool {
        truthy(self)
    }
}
impl crate::TypeOf for Dyn {
    fn type_of(&self) -> &'static str {
        type_of(self)
    }
}
impl crate::ToMapKey for Dyn {
    fn map_key(&self) -> crate::MapKey {
        use crate::MapKey;
        match self {
            Dyn::Undefined => MapKey::Undefined,
            Dyn::Null => MapKey::Null,
            Dyn::Bool(b) => MapKey::Bool(*b),
            Dyn::Num(n) => n.map_key(),
            Dyn::Str(s) => MapKey::Str(s.clone()),
            Dyn::Object(o) => MapKey::Ref(o.addr()),
            Dyn::Array(a) => MapKey::Ref(a.addr()),
            Dyn::Fn(_, addr) => MapKey::Ref(*addr),
            Dyn::Boxed(b) => MapKey::Ref(b.addr()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> Dyn {
        Dyn::Str(JsString::from(x))
    }

    #[test]
    fn conversions_and_operators_follow_ecmascript() {
        assert_eq!(to_string(&Dyn::Num(1.5)).unwrap().to_rust(), "1.5");
        assert_eq!(
            to_string(&Dyn::new_array(vec![Dyn::Num(1.0), Dyn::Null, s("a")]))
                .unwrap()
                .to_rust(),
            "1,,a"
        );
        assert_eq!(
            to_string(&object::<Dyn>(vec![])).unwrap().to_rust(),
            "[object Object]"
        );
        assert!(
            matches!(binary("+", &Dyn::Num(1.0), &s("2")).unwrap(), Dyn::Str(x) if x.to_rust() == "12")
        );
        assert!(
            matches!(binary("+", &Dyn::Bool(true), &Dyn::Null).unwrap(), Dyn::Num(n) if n == 1.0)
        );
        assert!(matches!(binary("-", &s("5"), &Dyn::Num(2.0)).unwrap(), Dyn::Num(n) if n == 3.0));
        assert!(
            matches!(binary("%", &Dyn::Num(-5.0), &Dyn::Num(5.0)).unwrap(), Dyn::Num(n) if n == 0.0 && n.is_sign_negative())
        );
        assert!(compare("<", &s("10"), &s("9")).unwrap());
        assert!(!compare("<", &Dyn::Num(10.0), &s("9")).unwrap());
        assert!(!compare("<=", &Dyn::Undefined, &Dyn::Num(1.0)).unwrap());
        assert!(loose_eq(&Dyn::Null, &Dyn::Undefined).unwrap());
        assert!(loose_eq(&s("1"), &Dyn::Num(1.0)).unwrap());
        assert!(!strict_eq(&s("1"), &Dyn::Num(1.0)));
        assert!(!strict_eq(&Dyn::Num(f64::NAN), &Dyn::Num(f64::NAN)));
        assert_eq!(type_of(&Dyn::Null), "object");
        assert!(!truthy(&s("")) && truthy(&s("0")));
    }

    #[test]
    fn objects_and_arrays() {
        let o = object(vec![
            (JsString::from("a"), Dyn::Num(1.0)),
            (JsString::from("b"), Dyn::Num(2.0)),
            (JsString::from("a"), Dyn::Num(3.0)),
        ]);
        assert_eq!(
            o.obj_keys().iter().map(|k| k.to_rust()).collect::<Vec<_>>(),
            ["a", "b"]
        );
        assert!(matches!(get(&o, &s("a")).unwrap(), Dyn::Num(n) if n == 3.0));
        assert!(matches!(get(&o, &s("zz")).unwrap(), Dyn::Undefined));
        assert!(get(&o, &s("hasOwnProperty")).is_err());
        assert!(get(&Dyn::Undefined, &s("x")).unwrap_err().name.to_rust() == "TypeError");
        let a = Dyn::new_array(vec![Dyn::Num(3.0), Dyn::Num(1.0), Dyn::Num(2.0)]);
        let mut cmp =
            |_: &Dyn, _: Dyn, args: Vec<Dyn>| -> JsResult<Dyn> { binary("-", &args[0], &args[1]) };
        call_sorted(&a, &mut cmp);
        assert_eq!(to_string(&a).unwrap().to_rust(), "1,2,3");
        method(&a, "push", vec![Dyn::Num(4.0)], &mut cmp).unwrap();
        assert!(matches!(get(&a, &s("length")).unwrap(), Dyn::Num(n) if n == 4.0));
        assert!(set(&a, &Dyn::Num(9.0), Dyn::Null).is_err());
        let sorted = method(
            &Dyn::new_array(vec![s("b"), Dyn::Undefined, s("a")]),
            "sort",
            vec![],
            &mut cmp,
        )
        .unwrap();
        assert_eq!(to_string(&sorted).unwrap().to_rust(), "a,b,");
    }

    fn call_sorted(a: &Dyn, cmp: &mut Caller<'_, Dyn>) {
        let f = Dyn::Fn(
            Rc::new(|_: &mut dyn Any, _: Dyn, _: Vec<Dyn>| Ok(Dyn::Undefined)),
            1,
        );
        method(a, "sort", vec![f], cmp).unwrap();
    }

    #[test]
    fn boundaries_do_not_coerce() {
        assert!(expect_number(&s("1")).is_err());
        assert_eq!(expect_number(&Dyn::Num(2.0)).unwrap(), 2.0);
        let e = expect_string(&Dyn::Num(1.0)).unwrap_err();
        assert_eq!(e.name.to_rust(), "RunicUnsupportedError");
    }

    #[test]
    fn object_keys() {
        let names = |v: &Dyn| {
            keys(v)
                .unwrap()
                .iter()
                .map(|k| k.to_rust())
                .collect::<Vec<_>>()
        };
        let o = object(vec![
            (JsString::from("b"), Dyn::Num(1.0)),
            (JsString::from("a"), Dyn::Num(2.0)),
        ]);
        assert_eq!(names(&o), ["b", "a"]);
        assert_eq!(
            names(&Dyn::new_array(vec![Dyn::Null, Dyn::Null])),
            ["0", "1"]
        );
        assert_eq!(names(&s("ab")), ["0", "1"]);
        assert!(names(&Dyn::Num(1.0)).is_empty());
        assert_eq!(
            keys(&Dyn::Undefined).unwrap_err().name.to_rust(),
            "TypeError"
        );
    }
}
