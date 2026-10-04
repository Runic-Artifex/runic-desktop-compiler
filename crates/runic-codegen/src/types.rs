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
