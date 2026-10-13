//! Dynamic values in generated code (M6 spike,
//! docs/design/M6-DYNAMIC-VALUES.md): the `dyn.*` built-ins, boxing static
//! values into `js::Dyn` and checked unboxing. A boxed value that is not a
//! primitive is a view of the original (`DynV<n>`, generated per static
//! type at the end of the app), so boxing keeps identity.

use crate::types::rust_type;
use runic_ir::{Program, Type};
use std::cell::RefCell;

thread_local! {
    /// Static types boxed as views, in registration order (`DynV<index>`).
    static VIEWS: RefCell<Vec<Type>> = const { RefCell::new(Vec::new()) };
}

/// Forget the views of a previous program (one generation per call).
pub fn reset() {
    VIEWS.with(|v| v.borrow_mut().clear());
}

fn view(t: &Type) -> usize {
    VIEWS.with(|v| {
        let mut v = v.borrow_mut();
        match v.iter().position(|x| x == t) {
            Some(i) => i,
            None => {
                v.push(t.clone());
                v.len() - 1
            }
        }
    })
}

/// A static value `v` of type `t`, boxed: an expression of type `js::Dyn`.
pub fn box_expr(t: &Type, v: &str, p: &Program) -> String {
    match t {
        Type::Number => format!("js::Dyn::Num({v})"),
        Type::String => format!("js::Dyn::Str({v})"),
        Type::Boolean => format!("js::Dyn::Bool({v})"),
        Type::Void => format!("{{ let _ = {v}; js::Dyn::Undefined }}"),
        Type::Dyn => v.to_string(),
        Type::Maybe(i) => format!(
            "(match {v} {{ Maybe::Some(x) => {}, Maybe::Null => js::Dyn::Null, Maybe::Undefined => js::Dyn::Undefined }})",
            box_expr(i, "x", p)
        ),
        Type::Array(i) if **i == Type::Dyn => format!("js::Dyn::Array({v})"),
        // A union boxes its member (M6 unions).
        Type::Union(ms) => {
            let arms: String = ms
                .iter()
                .map(|m| {
                    format!(
                        "js::Union::{}(x) => {}, ",
                        crate::types::union_variant(m),
                        box_expr(m, "x", p)
                    )
                })
                .collect();
            format!(
                "{{ #[allow(unreachable_patterns)] let d = match {v} {{ {arms}_ => unreachable!(\"validated union\") }}; d }}"
            )
        }
        Type::Fn(f) => {
            let params: String = f
                .params
                .iter()
                .enumerate()
                .map(|(i, pt)| {
                    format!(
                        ", {}",
                        crate::dynamic::try_unbox(
                            pt,
                            &format!("args.get({i}).cloned().unwrap_or_default()"),
                            p
                        )
                    )
                })
                .collect();
            format!(
                "{{ let f = {v}; let addr = Rc::as_ptr(&f) as *const u8 as usize; js::Dyn::Fn(Rc::new(move |cx: &mut dyn std::any::Any, _this: js::Dyn, args: Vec<js::Dyn>| -> JsResult<js::Dyn> {{ let cx = cx.downcast_mut::<Cx>().expect(\"the application context\"); let r = f(cx{params})?; Ok({}) }}), addr) }}",
                box_expr(&f.result, "r", p)
            )
        }
        other => format!("js::Dyn::Boxed(Rc::new(DynV{}({v})))", view(other)),
    }
}

/// `v` (an expression of type `js::Dyn`) unboxed to `t`, propagating a
/// mismatch with `?`: an expression of type `t`.
fn try_unbox(t: &Type, v: &str, p: &Program) -> String {
    format!("({})?", unbox_expr(t, v, p))
}

/// `v` (of type `js::Dyn`) unboxed to `t`: an expression of type
/// `JsResult<t>`.
pub fn unbox_expr(t: &Type, v: &str, p: &Program) -> String {
    match t {
        Type::Number => format!("js::dynamic::expect_number(&{v})"),
        Type::String => format!("js::dynamic::expect_string(&{v})"),
        Type::Boolean => format!("js::dynamic::expect_boolean(&{v})"),
        // A value no static code reads (a function result where none is expected).
        Type::Void => format!("{{ let _ = {v}; Ok(()) }}"),
        Type::Dyn => format!("Ok::<js::Dyn, js::Throw>({v}.clone())"),
        Type::Maybe(i) => format!(
            "(match {v} {{ js::Dyn::Undefined => Ok(Maybe::Undefined), js::Dyn::Null => Ok(Maybe::Null), x => ({}).map(Maybe::Some) }})",
            unbox_expr(i, "x", p)
        ),
        Type::Array(i) if **i == Type::Dyn => format!("js::dynamic::expect_array(&{v})"),
        // A union takes a value of one of its members: a primitive, or an
        // element or record boxed with its own type (never a copy).
        Type::Union(ms) => {
            let mut arms = String::new();
            let ctor = crate::types::union_new(ms);
            for m in ms {
                let n = crate::types::union_variant(m);
                let arm = match m {
                    Type::Number => format!("js::Dyn::Num(x) => Ok({ctor}::{n}(*x)), "),
                    Type::String => format!("js::Dyn::Str(x) => Ok({ctor}::{n}(x.clone())), "),
                    Type::Boolean => format!("js::Dyn::Bool(x) => Ok({ctor}::{n}(*x)), "),
                    other => format!(
                        "js::Dyn::Boxed(b) if b.as_any().downcast_ref::<DynV{}>().is_some() => Ok({ctor}::{n}(b.as_any().downcast_ref::<DynV{}>().expect(\"checked\").0.clone())), ",
                        view(other),
                        view(other)
                    ),
                };
                arms.push_str(&arm);
            }
            format!(
                "(match &{v} {{ {arms}other => Err(js::dynamic::mismatch({:?}, other)) }})",
                describe(t, p)
            )
        }
        Type::Fn(f) => {
            let n = view(t);
            let params: String = f
                .params
                .iter()
                .enumerate()
                .map(|(i, pt)| format!(", p{i}: {}", rust_type(pt)))
                .collect();
            let boxed: String = f
                .params
                .iter()
                .enumerate()
                .map(|(i, pt)| format!("{}, ", box_expr(pt, &format!("p{i}"), p)))
                .collect();
            format!(
                "(match {v} {{ js::Dyn::Fn(g, _) => {{ let g = g.clone(); let f: {ty} = Rc::new(move |cx: &mut Cx{params}| -> JsResult<{res}> {{ let r = g(cx, js::Dyn::Undefined, vec![{boxed}])?; {unbox} }}); Ok(f) }}, other => js::dynamic::expect_boxed::<DynV{n}>(&other, \"a function\").map(|b| b.0) }})",
                ty = rust_type(t),
                res = rust_type(&f.result),
                unbox = unbox_expr(&f.result, "r", p),
            )
        }
        // A dynamic object into a plain record: a copy of its properties
        // (the validator's `dyn_copies` proves no code can tell them apart).
        Type::Record(r) if !p.records[*r].class => {
            let fields: String = p.records[*r]
                .fields
                .iter()
                .enumerate()
                .map(|(i, f)| {
                    format!(
                        "f{i}: {{ let x = js::dynamic::get_key(&o, &JsString::from({:?}))?; ({})? }}, ",
                        f.name,
                        unbox_expr(&f.ty, "x", p)
                    )
                })
                .collect();
            format!(
                "(match &{v} {{ js::Dyn::Boxed(b) if b.as_any().downcast_ref::<DynV{n}>().is_some() => js::dynamic::expect_boxed::<DynV{n}>(&{v}, {what:?}).map(|b| b.0), js::Dyn::Object(_) | js::Dyn::Boxed(_) if matches!(js::dynamic::DynValue::kind(&{v}), js::dynamic::Kind::Object) => (|| -> JsResult<{ty}> {{ let o = {v}.clone(); Ok(JsRef::new(R{r} {{ {fields}}})) }})(), other => Err(js::dynamic::mismatch({what:?}, other)) }})",
                ty = rust_type(t),
                n = view(t),
                what = describe(t, p),
            )
        }
        other => format!(
            "js::dynamic::expect_boxed::<DynV{}>(&{v}, {:?}).map(|b| b.0)",
            view(other),
            describe(other, p)
        ),
    }
}

fn describe(t: &Type, p: &Program) -> String {
    match t {
        Type::Record(r) => format!("a {} object", p.records[*r].name),
        other => format!("a static {}", other.name()),
    }
}

/// The `dyn.*` built-ins: `t` are the argument variables, `types` their
/// types, `ty` the declared result type; `q` wraps a fallible expression.
pub fn emit(
    m: &str,
    t: &[String],
    types: &[Type],
    ty: &Type,
    p: &Program,
    q: &dyn Fn(String) -> String,
) -> String {
    // A key argument: a string or number is boxed (ToPropertyKey).
    let key = |i: usize| -> String {
        match &types[i] {
            Type::Dyn => format!("&{}", t[i]),
            other => format!("&{}", box_expr(other, &t[i], p)),
        }
    };
    let rest = |from: usize| t[from..].join(", ");
    match m {
        "from" => format!("{{ let _ = &{}; {} }}", t[1], box_expr(&types[0], &t[0], p)),
        "to" => q(unbox_expr(ty, &t[0], p)),
        "get" => q(format!("js::dynamic::get(&{}, {})", t[0], key(1))),
        "set" => q(format!("js::dynamic::set(&{}, {}, {})", t[0], key(1), t[2])),
        "call" => q(format!(
            "js::dynamic::call(cx, &{}, js::Dyn::Undefined, vec![{}])",
            t[0],
            rest(1)
        )),
        "method" => q(format!(
            "js::dynamic::call_method(cx, &{}, &{}.to_rust(), vec![{}])",
            t[0],
            t[1],
            rest(2)
        )),
        "object" => format!(
            "js::dynamic::object::<js::Dyn>(vec![{}])",
            t.chunks(2)
                .map(|c| format!("({}, {}), ", c[0], c[1]))
                .collect::<String>()
        ),
        "array" => format!("js::dynamic::DynValue::new_array(vec![{}])", t.join(", ")),
        "binary" => q(format!(
            "js::dynamic::binary(&{}.to_rust(), &{}, &{})",
            t[0], t[1], t[2]
        )),
        "unary" => q(format!(
            "js::dynamic::unary(&{}.to_rust(), &{})",
            t[0], t[1]
        )),
        "compare" => q(format!(
            "js::dynamic::compare(&{}.to_rust(), &{}, &{})",
            t[0], t[1], t[2]
        )),
        "loose-eq" => q(format!("js::dynamic::loose_eq(&{}, &{})", t[0], t[1])),
        "to-string" => q(format!("js::dynamic::to_string(&{})", t[0])),
        "to-number" => q(format!("js::dynamic::to_number(&{})", t[0])),
        "keys" => format!("js::array({})", q(format!("js::dynamic::keys(&{})", t[0]))),
        other => unreachable!("validated dyn.{other}"),
    }
}

/// The view structs of the boxed static types (registered while the app was
/// generated, and by the views themselves).
pub fn views(p: &Program) -> String {
    let mut out = String::new();
    let mut done = 0;
    loop {
        let todo: Vec<(usize, Type)> = VIEWS.with(|v| {
            v.borrow()
                .iter()
                .enumerate()
                .skip(done)
                .map(|(i, t)| (i, t.clone()))
                .collect()
        });
        if todo.is_empty() {
            break;
        }
        done += todo.len();
        for (i, t) in todo {
            out.push_str(&view_struct(i, &t, p));
        }
    }
    out
}

fn view_struct(i: usize, t: &Type, p: &Program) -> String {
    let rt = rust_type(t);
    let (kind, addr, members) = match t {
        Type::Record(r) if !p.records[*r].class => {
            let rec = &p.records[*r];
            let fields: Vec<(usize, &runic_ir::Field)> = rec
                .fields
                .iter()
                .enumerate()
                .filter(|(_, f)| !f.is_derived())
                .collect();
            let gets: String = fields
                .iter()
                .map(|(j, f)| {
                    format!(
                        "{:?} => Ok(Some({{ let x = self.0.borrow().f{j}.clone(); {} }})), ",
                        f.name,
                        box_expr(&f.ty, "x", p)
                    )
                })
                .collect();
            let sets: String = fields
                .iter()
                .map(|(j, f)| {
                    format!(
                        "{:?} => {{ let x = ({})?; self.0.borrow_mut().f{j} = x; Ok(()) }}, ",
                        f.name,
                        unbox_expr(&f.ty, "v", p)
                    )
                })
                .collect();
            let keys: String = fields
                .iter()
                .map(|(_, f)| format!("JsString::from({:?}), ", f.name))
                .collect();
            (
                "\"an object\"".to_string(),
                "self.0.addr()".to_string(),
                format!(
                    "fn is_object(&self) -> bool {{ true }}\n\
                     fn get(&self, key: &JsString) -> JsResult<Option<js::Dyn>> {{ match key.to_rust().as_str() {{ {gets}_ => Ok(None) }} }}\n\
                     fn set(&self, key: JsString, v: js::Dyn) -> JsResult<()> {{ match key.to_rust().as_str() {{ {sets}k => Err(js::Throw::new(\"RunicUnsupportedError\", format!(\"adding property {{k}} to a {} object (its fields are fixed)\"))) }} }}\n\
                     fn keys(&self) -> Vec<JsString> {{ vec![{keys}] }}\n",
                    rec.name
                ),
            )
        }
        Type::Array(e) => (
            "\"an array\"".to_string(),
            "self.0.addr()".to_string(),
            format!(
                "fn is_array(&self) -> bool {{ true }}\n\
                 fn len(&self) -> usize {{ self.0.borrow().len() }}\n\
                 fn item(&self, i: usize) -> JsResult<js::Dyn> {{ let x = self.0.borrow()[i].clone(); Ok({}) }}\n\
                 fn set_item(&self, i: usize, v: js::Dyn) -> JsResult<()> {{ let x = ({})?; let mut a = self.0.borrow_mut(); if i < a.len() {{ a[i] = x; }} else {{ a.push(x); }} Ok(()) }}\n\
                 fn replace(&self, items: Vec<js::Dyn>) -> JsResult<()> {{ let mut out = Vec::with_capacity(items.len()); for v in items {{ out.push(({})?); }} *self.0.borrow_mut() = out; Ok(()) }}\n",
                box_expr(e, "x", p),
                unbox_expr(e, "v", p),
                unbox_expr(e, "v", p),
            ),
        ),
        Type::Element => (
            "\"an element\"".to_string(),
            "(self.0.0 as usize) | (1usize << (usize::BITS - 1))".to_string(),
            String::new(),
        ),
        Type::Fn(_) => (
            "\"a function\"".to_string(),
            "Rc::as_ptr(&self.0) as *const u8 as usize".to_string(),
            String::new(),
        ),
        Type::Record(_) | Type::Map(..) | Type::Set(_) => (
            format!("{:?}", describe(t, p)),
            "self.0.addr()".to_string(),
            String::new(),
        ),
        other => (
            format!("{:?}", describe(other, p)),
            // (No identity of their own: each boxing is a new value.)
            "self as *const Self as *const u8 as usize".to_string(),
            String::new(),
        ),
    };
    format!(
        "#[derive(Clone)]\n#[allow(dead_code)]\nstruct DynV{i}({rt});\n\
         #[allow(unused_variables, unused_parens)]\nimpl js::DynView for DynV{i} {{\n\
         fn kind_name(&self) -> &'static str {{ {kind} }}\n\
         fn as_any(&self) -> &dyn std::any::Any {{ self }}\n\
         fn addr(&self) -> usize {{ {addr} }}\n{members}}}\n"
    )
}
