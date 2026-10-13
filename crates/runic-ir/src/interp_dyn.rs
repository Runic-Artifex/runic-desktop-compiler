//! Dynamic values in the reference interpreter (M6 spike,
//! docs/design/M6-DYNAMIC-VALUES.md). The semantics are `runic_js::dynamic`'s,
//! over [`Val`]; boxing and unboxing mirror the generated code
//! (`runic_codegen::dynamic`): primitives and `array<dyn>` are themselves,
//! other static values are views ([`Val::Boxed`]) of the original.

use super::{Machine, Res, Val};
use crate::{FnType, RecordType, Type};
use runic_js::dynamic::{self as d, DynValue, Kind};
use runic_js::{JsRef, JsString, Throw};
use std::rc::Rc;

/// What a boxed static value exposes to dynamic code.
#[derive(Clone, Debug)]
pub enum BoxKind {
    /// A plain record: its fields by name (field index, type).
    Object(Vec<(String, usize, Type)>),
    /// A static array of items of this type.
    Array(Type),
    Function(FnType),
    /// No dynamic members; the description used in messages and probes.
    Opaque(&'static str),
}

/// A boxed static value: its type, what it exposes, and the record table
/// (to box what it gives).
#[derive(Debug)]
pub struct Boxed {
    pub ty: Type,
    pub kind: BoxKind,
    pub value: Val,
    pub records: Rc<Vec<RecordType>>,
}

/// The description of a static type in messages (as generated code gives it).
pub fn describe(t: &Type, records: &[RecordType]) -> String {
    match t {
        Type::Record(r) => format!("a {} object", records[*r].name),
        other => format!("a static {}", other.name()),
    }
}

fn leak(s: String) -> &'static str {
    // (Descriptions are few per program; probes and messages need &'static.)
    Box::leak(s.into_boxed_str())
}

/// Box static value `v` of type `t` (`dyn.from`).
pub fn box_val(t: &Type, v: Val, records: &Rc<Vec<RecordType>>) -> Val {
    match t {
        Type::Number | Type::String | Type::Boolean | Type::Dyn => v,
        Type::Void => Val::Undefined,
        Type::Maybe(i) => match v {
            Val::Undefined | Val::Null => v,
            other => box_val(i, other, records),
        },
        Type::Array(i) if **i == Type::Dyn => v,
        // A union boxes its member (M6 unions).
        Type::Union(ms) => match ms.iter().find(|m| super::val_is(&v, m)) {
            Some(m) => box_val(m, v, records),
            None => unreachable!("validated union value"),
        },
        _ => {
            let kind = match t {
                Type::Record(r) if !records[*r].class => BoxKind::Object(
                    records[*r]
                        .fields
                        .iter()
                        .enumerate()
                        .filter(|(_, f)| !f.is_derived())
                        .map(|(i, f)| (f.name.clone(), i, f.ty.clone()))
                        .collect(),
                ),
                Type::Array(e) => BoxKind::Array((**e).clone()),
                Type::Fn(f) => BoxKind::Function(f.clone()),
                Type::Element => BoxKind::Opaque("an element"),
                other => BoxKind::Opaque(leak(describe(other, records))),
            };
            Val::Boxed(Rc::new(Boxed {
                ty: t.clone(),
                kind,
                value: v,
                records: Rc::clone(records),
            }))
        }
    }
}

/// Unbox dynamic value `v` to static type `t` (`dyn.to`): never coerced.
pub fn unbox_val(t: &Type, v: &Val, records: &Rc<Vec<RecordType>>) -> Res<Val> {
    let fail = |want: &str| Err(d::mismatch_of::<Val>(want, v));
    match t {
        Type::Number => match v {
            Val::Num(_) => Ok(v.clone()),
            _ => fail("a number"),
        },
        Type::String => match v {
            Val::Str(_) => Ok(v.clone()),
            _ => fail("a string"),
        },
        Type::Boolean => match v {
            Val::Bool(_) => Ok(v.clone()),
            _ => fail("a boolean"),
        },
        Type::Void => Ok(Val::Undefined),
        Type::Dyn => Ok(v.clone()),
        Type::Maybe(i) => match v {
            Val::Undefined | Val::Null => Ok(v.clone()),
            other => unbox_val(i, other, records),
        },
        Type::Array(i) if **i == Type::Dyn => match v {
            Val::Array(_) => Ok(v.clone()),
            _ => fail("an array of dynamic values"),
        },
        // A union takes a value of one of its members: a primitive, or an
        // element or record boxed with its own type (never a copy).
        Type::Union(ms) => match v {
            Val::Num(_) if ms.contains(&Type::Number) => Ok(v.clone()),
            Val::Str(_) if ms.contains(&Type::String) => Ok(v.clone()),
            Val::Bool(_) if ms.contains(&Type::Boolean) => Ok(v.clone()),
            Val::Boxed(b) if ms.contains(&b.ty) => Ok(b.value.clone()),
            _ => fail(&describe(t, records)),
        },
        Type::Fn(f) => match v {
            // The function boxed from this very static type: itself (the
            // generated code keeps the original too).
            Val::Boxed(b) if b.ty == *t => Ok(b.value.clone()),
            Val::Boxed(b) if matches!(b.kind, BoxKind::Function(_)) => {
                Ok(Val::DynFn(Rc::new((f.clone(), v.clone()))))
            }
            _ => fail("a function"),
        },
        // A dynamic object into a plain record: a copy of its properties
        // (the validator's `dyn_copies` proves no code can tell them apart).
        Type::Record(r)
            if !records[*r].class
                && !matches!(v, Val::Boxed(b) if b.ty == *t)
                && matches!(v.kind(), Kind::Object) =>
        {
            let mut fields = vec![];
            for f in &records[*r].fields {
                let x = d::get_key(v, &JsString::from(f.name.as_str()))?;
                fields.push(unbox_val(&f.ty, &x, records)?);
            }
            Ok(Val::Record(JsRef::new(super::RecordData::new(
                *r, fields, false,
            ))))
        }
        other => match v {
            Val::Boxed(b) if b.ty == *other => Ok(b.value.clone()),
            _ => fail(&describe(other, records)),
        },
    }
}

impl DynValue for Val {
    fn kind(&self) -> Kind<'_> {
        match self {
            Val::Undefined => Kind::Undefined,
            Val::Null => Kind::Null,
            Val::Bool(b) => Kind::Bool(*b),
            Val::Num(n) => Kind::Num(*n),
            Val::Str(s) => Kind::Str(s),
            Val::DynObject(_) => Kind::Object,
            Val::Array(_) => Kind::Array,
            Val::DynFn(_) => Kind::Function,
            Val::Boxed(b) => match &b.kind {
                BoxKind::Object(_) => Kind::Object,
                BoxKind::Array(_) => Kind::Array,
                BoxKind::Function(_) => Kind::Function,
                BoxKind::Opaque(name) => Kind::Opaque(name),
            },
            _ => Kind::Opaque("a static value"),
        }
    }
    fn undefined() -> Self {
        Val::Undefined
    }
    fn null() -> Self {
        Val::Null
    }
    fn boolean(b: bool) -> Self {
        Val::Bool(b)
    }
    fn number(n: f64) -> Self {
        Val::Num(n)
    }
    fn string(s: JsString) -> Self {
        Val::Str(s)
    }
    fn new_object(entries: Vec<(JsString, Self)>) -> Self {
        Val::DynObject(JsRef::new(entries))
    }
    fn new_array(items: Vec<Self>) -> Self {
        Val::Array(runic_js::array(items))
    }
    fn obj_get(&self, key: &JsString) -> Res<Option<Self>> {
        match self {
            Val::DynObject(o) => Ok(o
                .borrow()
                .iter()
                .find(|(k, _)| k == key)
                .map(|(_, v)| v.clone())),
            Val::Boxed(b) => {
                let BoxKind::Object(fields) = &b.kind else {
                    return Ok(None);
                };
                let Val::Record(r) = &b.value else {
                    return Ok(None);
                };
                Ok(fields
                    .iter()
                    .find(|(n, _, _)| *n == key.to_rust())
                    .map(|(_, i, t)| box_val(t, r.borrow().fields[*i].clone(), &b.records)))
            }
            _ => Ok(None),
        }
    }
    fn obj_set(&self, key: JsString, v: Self) -> Res<()> {
        match self {
            Val::DynObject(o) => {
                let mut o = o.borrow_mut();
                match o.iter_mut().find(|(k, _)| *k == key) {
                    Some(slot) => slot.1 = v,
                    None => o.push((key, v)),
                }
                Ok(())
            }
            Val::Boxed(b) => {
                let (BoxKind::Object(fields), Val::Record(r)) = (&b.kind, &b.value) else {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        "setting a property of a boxed value",
                    ));
                };
                match fields.iter().find(|(n, _, _)| *n == key.to_rust()) {
                    Some((_, i, t)) => {
                        let x = unbox_val(t, &v, &b.records)?;
                        r.borrow_mut().fields[*i] = x;
                        Ok(())
                    }
                    None => Err(Throw::new(
                        "RunicUnsupportedError",
                        format!(
                            "adding property {} to a {} object (its fields are fixed)",
                            key.to_rust(),
                            match &b.ty {
                                Type::Record(r) => b.records[*r].name.clone(),
                                other => other.name(),
                            }
                        ),
                    )),
                }
            }
            _ => Err(Throw::new(
                "RunicUnsupportedError",
                "setting a property of a non-object",
            )),
        }
    }
    fn obj_keys(&self) -> Vec<JsString> {
        match self {
            Val::DynObject(o) => o.borrow().iter().map(|(k, _)| k.clone()).collect(),
            Val::Boxed(b) => match &b.kind {
                BoxKind::Object(fields) => fields
                    .iter()
                    .map(|(n, _, _)| JsString::from(n.as_str()))
                    .collect(),
                _ => vec![],
            },
            _ => vec![],
        }
    }
    fn arr_len(&self) -> usize {
        match self {
            Val::Array(a) => a.borrow().len(),
            Val::Boxed(b) => match &b.value {
                Val::Array(a) => a.borrow().len(),
                _ => 0,
            },
            _ => 0,
        }
    }
    fn arr_get(&self, i: usize) -> Res<Self> {
        match self {
            Val::Array(a) => Ok(a.borrow()[i].clone()),
            Val::Boxed(b) => match (&b.kind, &b.value) {
                (BoxKind::Array(t), Val::Array(a)) => {
                    Ok(box_val(t, a.borrow()[i].clone(), &b.records))
                }
                _ => Ok(Val::Undefined),
            },
            _ => Ok(Val::Undefined),
        }
    }
    fn arr_set(&self, i: usize, v: Self) -> Res<()> {
        let (a, x) = match self {
            Val::Array(a) => (a, v),
            Val::Boxed(b) => match (&b.kind, &b.value) {
                (BoxKind::Array(t), Val::Array(a)) => (a, unbox_val(t, &v, &b.records)?),
                _ => {
                    return Err(Throw::new(
                        "RunicUnsupportedError",
                        "writing items of a boxed value",
                    ));
                }
            },
            _ => {
                return Err(Throw::new(
                    "RunicUnsupportedError",
                    "writing an item of a non-array",
                ));
            }
        };
        let mut a = a.borrow_mut();
        if i < a.len() {
            a[i] = x;
        } else {
            a.push(x);
        }
        Ok(())
    }
    fn arr_items(&self) -> Res<Vec<Self>> {
        (0..self.arr_len()).map(|i| self.arr_get(i)).collect()
    }
    fn arr_replace(&self, items: Vec<Self>) -> Res<()> {
        match self {
            Val::Array(a) => {
                *a.borrow_mut() = items;
                Ok(())
            }
            Val::Boxed(b) => match (&b.kind, &b.value) {
                (BoxKind::Array(t), Val::Array(a)) => {
                    let out = items
                        .iter()
                        .map(|v| unbox_val(t, v, &b.records))
                        .collect::<Res<Vec<_>>>()?;
                    *a.borrow_mut() = out;
                    Ok(())
                }
                _ => Err(Throw::new(
                    "RunicUnsupportedError",
                    "reordering a boxed value",
                )),
            },
            _ => Err(Throw::new(
                "RunicUnsupportedError",
                "reordering a non-array",
            )),
        }
    }
    fn same_ref(&self, other: &Self) -> bool {
        match (self, other) {
            (Val::DynObject(a), Val::DynObject(b)) => JsRef::ptr_eq(a, b),
            (Val::Array(a), Val::Array(b)) => JsRef::ptr_eq(a, b),
            (Val::DynFn(a), Val::DynFn(b)) => Rc::ptr_eq(a, b),
            (Val::Boxed(a), Val::Boxed(b)) => runic_js::StrictEq::strict_eq(&a.value, &b.value),
            _ => false,
        }
    }
}

/// Probe JSON of a dynamic value (matches `runic_runtime::probe_dyn`).
pub fn cell_json(v: &Val) -> Option<serde_json::Value> {
    use serde_json::json;
    Some(match v {
        Val::DynObject(o) => match o.visit() {
            None => json!("[Circular]"),
            Some(_v) => json!({ "object": o
                .borrow()
                .iter()
                .map(|(k, x)| json!([k.to_rust(), super::cell_json(x)]))
                .collect::<Vec<_>>() }),
        },
        Val::DynFn(_) => json!("function"),
        Val::Boxed(b) => match b.kind {
            BoxKind::Function(_) => json!("function"),
            BoxKind::Object(_) => json!("boxed an object"),
            BoxKind::Array(_) => json!("boxed an array"),
            BoxKind::Opaque(name) => json!(format!("boxed {name}")),
        },
        _ => return None,
    })
}

impl<'p> Machine<'p> {
    fn records(&mut self) -> Rc<Vec<RecordType>> {
        if self.dyn_records.is_none() {
            self.dyn_records = Some(Rc::new(self.program.records.clone()));
        }
        Rc::clone(self.dyn_records.as_ref().unwrap())
    }

    /// Calls dynamic function `f` (`this`, then the arguments).
    pub(super) fn call_dyn(&mut self, f: &Val, _this: Val, args: Vec<Val>) -> Res<Val> {
        let records = self.records();
        match f {
            Val::Boxed(b) => match &b.kind {
                BoxKind::Function(fty) => {
                    let mut stat = vec![];
                    for (i, pt) in fty.params.iter().enumerate() {
                        let a = args.get(i).cloned().unwrap_or(Val::Undefined);
                        stat.push(unbox_val(pt, &a, &records)?);
                    }
                    let r = self.call_value(&b.value, stat)?;
                    Ok(box_val(&fty.result, r, &records))
                }
                _ => Err(Throw::type_error("a dynamic value is not a function")),
            },
            // A static function made from a dynamic one, boxed again.
            Val::DynFn(adapter) => {
                let (fty, _) = &**adapter;
                let mut stat = vec![];
                for (i, pt) in fty.params.iter().enumerate() {
                    let a = args.get(i).cloned().unwrap_or(Val::Undefined);
                    stat.push(unbox_val(pt, &a, &records)?);
                }
                let r = self.call_value(f, stat)?;
                Ok(box_val(&fty.result, r, &records))
            }
            other => Err(Throw::type_error(format!(
                "{} is not a function",
                runic_js::dynamic::describe_of(other)
            ))),
        }
    }

    /// Calls a static function made from a dynamic one (`Val::DynFn`):
    /// the arguments are boxed, the result unboxed.
    pub(super) fn call_adapter(&mut self, adapter: &(FnType, Val), args: Vec<Val>) -> Res<Val> {
        let records = self.records();
        let (fty, inner) = adapter;
        let boxed = fty
            .params
            .iter()
            .zip(args)
            .map(|(t, v)| box_val(t, v, &records))
            .collect();
        let r = self.call_dyn(inner, Val::Undefined, boxed)?;
        unbox_val(&fty.result, &r, &records)
    }

    /// The `dyn.*` built-ins.
    pub(super) fn dyn_builtin(
        &mut self,
        m: &str,
        a: Vec<Val>,
        _types: &[Type],
        ty: &Type,
    ) -> Res<Val> {
        let records = self.records();
        // (A key is a string, a number or a dynamic value: as it is.)
        let key = |i: usize| -> Val { a[i].clone() };
        let s = |v: &Val| match v {
            Val::Str(s) => s.to_rust(),
            _ => unreachable!("validated string"),
        };
        Ok(match m {
            "from" => {
                let Val::Str(named) = &a[1] else {
                    unreachable!("validated static type")
                };
                let t: Type =
                    serde_json::from_str(&named.to_rust()).expect("validated static type");
                box_val(&t, a[0].clone(), &records)
            }
            "to" => unbox_val(ty, &a[0], &records)?,
            "get" => d::get(&a[0], &key(1))?,
            "set" => {
                d::set(&a[0], &key(1), a[2].clone())?;
                Val::Undefined
            }
            "call" => self.call_dyn(&a[0], Val::Undefined, a[1..].to_vec())?,
            "method" => {
                let name = s(&a[1]);
                let recv = a[0].clone();
                let args = a[2..].to_vec();
                d::method(&recv, &name, args, &mut |f, this, args| {
                    self.call_dyn(f, this, args)
                })?
            }
            "object" => d::object(
                a.chunks(2)
                    .map(|c| (JsString::from(s(&c[0]).as_str()), c[1].clone()))
                    .collect(),
            ),
            "array" => Val::new_array(a),
            "binary" => d::binary(&s(&a[0]), &a[1], &a[2])?,
            "unary" => d::unary(&s(&a[0]), &a[1])?,
            "compare" => Val::Bool(d::compare(&s(&a[0]), &a[1], &a[2])?),
            "loose-eq" => Val::Bool(d::loose_eq(&a[0], &a[1])?),
            "to-string" => Val::Str(d::to_string(&a[0])?),
            "to-number" => Val::Num(d::to_number(&a[0])?),
            "keys" => Val::Array(runic_js::array(
                d::keys(&a[0])?.into_iter().map(Val::Str).collect(),
            )),
            other => unreachable!("validated dyn.{other}"),
        })
    }
}
