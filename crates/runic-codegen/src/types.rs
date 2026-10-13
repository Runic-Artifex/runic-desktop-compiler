//! Rust spellings of IR types and their default values.

use runic_ir::{Program, Type};

pub fn rust_type(t: &Type) -> String {
    match t {
        Type::Number => "f64".into(),
        Type::String => "JsString".into(),
        Type::Boolean => "bool".into(),
        Type::Void => "()".into(),
        Type::Maybe(i) => format!("Maybe<{}>", rust_type(i)),
        Type::Array(i) => format!("JsArray<{}>", rust_type(i)),
        Type::Record(r) => format!("JsRef<R{r}>"),
        Type::Map(k, v) => format!("JsMap<{}, {}>", rust_type(k), rust_type(v)),
        Type::Set(i) => format!("JsSet<{}>", rust_type(i)),
        Type::Element => "js::Element".into(),
        Type::Event => "js::Event".into(),
        Type::Attrs => "js::Attrs<Bag>".into(),
        Type::Regexp => "js::RegExp".into(),
        Type::MediaQuery => "js::MediaQueryList".into(),
        Type::Date => "js::Date".into(),
        // Opaque host objects (M6): the generated app keeps their state.
        Type::Mounted | Type::Contexts | Type::Animation | Type::Image => "js::Handle".into(),
        Type::Dyn => "js::Dyn".into(),
        // A union (M6): the member it holds, the record member as the
        // type parameter.
        Type::Union(ms) => format!(
            "js::Union<{}>",
            ms.iter()
                .find_map(|m| match m {
                    Type::Record(r) => Some(format!("JsRef<R{r}>")),
                    _ => None,
                })
                .unwrap_or_else(|| "js::NoRecord".into())
        ),
        // Every class reference is the program's enum of instances by class.
        Type::Class(_) | Type::Classes(_) => "Obj".into(),
        // Reactions are microtask jobs of the generated app.
        Type::Promise(i) => format!("js::JsPromise<{}, Lst>", rust_type(i)),
        Type::Fn(f) => format!(
            "Rc<dyn Fn(&mut Cx{}) -> JsResult<{}>>",
            f.params
                .iter()
                .map(|p| format!(", {}", rust_type(p)))
                .collect::<String>(),
            rust_type(&f.result)
        ),
    }
}

/// A value of type `t` used for not-yet-assigned locals and default cells.
/// Programs never observe it (TypeScript's definite assignment holds).
pub fn default_value(t: &Type, p: &Program) -> String {
    match t {
        Type::Class(_) | Type::Classes(_) => {
            match p.concrete_members(t).unwrap_or_default().first() {
                Some(r) => format!("Obj::R{r}(JsRef::new(R{r}::default()))"),
                None => "unreachable!(\"a class without instances\")".into(),
            }
        }
        Type::Number => "0.0f64".into(),
        Type::String => "JsString::new()".into(),
        Type::Boolean => "false".into(),
        Type::Void => "()".into(),
        Type::Maybe(_) => "Maybe::Undefined".into(),
        Type::Array(_) => "js::array(Vec::new())".into(),
        Type::Record(r) => format!("JsRef::new(R{r}::default())"),
        Type::Map(..) => "JsRef::new(js::MapData::default())".into(),
        Type::Set(_) => "JsRef::new(js::SetData::default())".into(),
        Type::Element => "js::Element(0)".into(),
        Type::Event => "js::Event::new(Default::default())".into(),
        Type::Attrs => "js::Attrs::default()".into(),
        Type::Regexp => "js::RegExp::default()".into(),
        Type::MediaQuery => "js::MediaQueryList::new(\"\", false)".into(),
        Type::Date => "js::Date::default()".into(),
        Type::Mounted | Type::Contexts | Type::Animation | Type::Image => {
            "js::Handle::new(())".into()
        }
        Type::Dyn => "js::Dyn::Undefined".into(),
        Type::Union(ms) => format!(
            "{}::{}({})",
            union_new(ms),
            union_variant(&ms[0]),
            default_value(&ms[0], p)
        ),
        Type::Promise(_) => "js::JsPromise::pending()".into(),
        Type::Fn(f) => format!(
            "{{ let f: {} = Rc::new(|_: &mut Cx{}| -> JsResult<{}> {{ unreachable!(\"uninitialised function\") }}); f }}",
            rust_type(t),
            f.params
                .iter()
                .map(|p| format!(", _: {}", rust_type(p)))
                .collect::<String>(),
            rust_type(&f.result)
        ),
    }
}

/// The path of the variants of union type `ms` as constructors (with
/// the union's type parameter, which a variant alone does not infer).
pub fn union_new(ms: &[Type]) -> String {
    format!("<{}>", rust_type(&Type::Union(ms.to_vec())))
}

/// The `js::Union` variant of union member `t` (M6 unions).
pub fn union_variant(t: &Type) -> &'static str {
    match t {
        Type::Number => "Number",
        Type::String => "String",
        Type::Boolean => "Boolean",
        Type::Element => "Element",
        Type::Record(_) => "Record",
        other => unreachable!("validated union member {other:?}"),
    }
}

/// `v` (a value of union type `from`, or of one of its members) as a
/// value of union type `to` whose members include its own: each member
/// keeps its variant (M6 unions).
pub fn union_widen(from: &Type, to: &[Type], v: &str) -> String {
    match from.union_members() {
        None => format!("{}::{}({v})", union_new(to), union_variant(from)),
        // (A union without a record member has the type parameter
        // `NoRecord`: rebuilt variant by variant.)
        Some(have) => {
            let same_record = have.iter().any(|m| matches!(m, Type::Record(_)))
                == to.iter().any(|m| matches!(m, Type::Record(_)));
            if same_record {
                return v.to_string();
            }
            let ctor = union_new(to);
            let arms: String = have
                .iter()
                .map(|m| {
                    let n = union_variant(m);
                    format!("js::Union::{n}(x) => {ctor}::{n}(x), ")
                })
                .collect();
            format!(
                "{{ #[allow(unreachable_patterns)] let u = match {v} {{ {arms}_ => unreachable!(\"validated union\") }}; u }}"
            )
        }
    }
}

/// `v` (a value of union type `from`) as a value of `to`, one of its
/// members or a narrower union: a `JsResult` whose error is the
/// TypeError of a value of another member (M6 unions).
pub fn union_narrow(from: &[Type], to: &Type, v: &str) -> String {
    let want: Vec<Type> = to
        .union_members()
        .map_or_else(|| vec![to.clone()], <[Type]>::to_vec);
    let names: Vec<String> = want.iter().map(Type::name).collect();
    let arms: String = from
        .iter()
        .map(|m| {
            let n = union_variant(m);
            if !want.contains(m) {
                let have = match m {
                    Type::Record(_) => "object".to_string(),
                    other => other.name(),
                };
                format!(
                    "js::Union::{n}(_) => Err(js::Throw::type_error(js::union_message({have:?}, &{names:?}.map(String::from)))), "
                )
            } else if let Some(ms) = to.union_members() {
                format!("js::Union::{n}(x) => Ok({}::{n}(x)), ", union_new(ms))
            } else {
                format!("js::Union::{n}(x) => Ok(x), ")
            }
        })
        .collect();
    format!(
        "{{ #[allow(unreachable_patterns)] let r = match {v} {{ {arms}_ => unreachable!(\"validated union\") }}; r }}"
    )
}

/// The classes a class reference can hold: the variants of the generated
/// `Obj` enum (every concrete class record, as a union may name classes
/// without a hierarchy). None in programs without class references.
pub fn obj_variants(p: &Program) -> Vec<usize> {
    p.records
        .iter()
        .enumerate()
        .filter(|(_, rec)| rec.class && !rec.is_abstract)
        .map(|(r, _)| r)
        .collect()
}

/// Whether the program has class references (class types with subclasses,
/// or unions of classes).
pub fn has_class_refs(p: &Program) -> bool {
    p.has_subclasses() || serde_json::to_string(p).is_ok_and(|s| s.contains("\"classes\":["))
}

/// The catch-all arm of a `match` over `Obj` (classes a value's type
/// excludes; unreachable patterns are allowed in generated code).
pub fn obj_rest(_p: &Program, _covered: &[usize]) -> &'static str {
    "_ => unreachable!(\"validated class\"), "
}

/// Whether values of `t` compare by SameValue for change detection.
pub fn same_expr(t: &Type, a: &str, b: &str) -> String {
    match t {
        Type::Number => format!("js::same_value({a}, {b})"),
        Type::Fn(_) => format!("Rc::ptr_eq(&{a}, &{b})"),
        Type::Void => "true".into(),
        // Functions compare by identity.
        Type::Maybe(inner) if matches!(**inner, Type::Fn(_)) => format!(
            "(match (&{a}, &{b}) {{ (Maybe::Some(x), Maybe::Some(y)) => Rc::ptr_eq(x, y), (Maybe::Undefined, Maybe::Undefined) | (Maybe::Null, Maybe::Null) => true, _ => false }})"
        ),
        _ => format!("js::StrictEq::strict_eq(&{a}, &{b})"),
    }
}
