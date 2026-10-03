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
    let _ = p;
    match t {
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

/// Whether values of `t` compare by SameValue for change detection.
pub fn same_expr(t: &Type, a: &str, b: &str) -> String {
    match t {
        Type::Number => format!("js::same_value({a}, {b})"),
        Type::Fn(_) => format!("Rc::ptr_eq(&{a}, &{b})"),
        Type::Void => "true".into(),
        _ => format!("js::StrictEq::strict_eq(&{a}, &{b})"),
    }
}
