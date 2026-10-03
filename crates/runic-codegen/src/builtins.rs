//! Rust spellings of the built-in catalogue (`runic_ir::builtins`). Every
//! argument is evaluated into a temporary first (in order); the result uses
//! the shared `runic-js` implementations.

use crate::expr::{FnCtx, js_str};
use crate::types::rust_type;
use runic_ir::{Expr, Program, Type};

fn opt_num(t: Option<&String>) -> String {
    t.map_or("Maybe::Undefined".into(), |v| format!("Maybe::Some({v})"))
}

/// A Rust closure adapting callback value `f` (IR type `fty`) to the
/// `(&T, f64[, ...]) -> JsResult<_>` shape of `runic_js::array_ops`.
fn adapter(fty: &Type, f: &str, recv: &str, predicate: bool) -> String {
    let Type::Fn(sig) = fty else {
        unreachable!("validated callback")
    };
    let n = sig.params.len();
    let mut args = String::new();
    if n >= 1 {
        args.push_str(", x.clone()");
    }
    if n >= 2 {
        args.push_str(", i");
    }
    if n >= 3 {
        args.push_str(&format!(", {recv}.clone()"));
    }
    let call = format!("({f})(cx{args})?");
    let result = if predicate {
        if *sig.result == Type::Boolean {
            call
        } else {
            format!("js::Truthy::truthy(&{call})")
        }
    } else {
        call
    };
    format!("|x, i| -> JsResult<_> {{ let _ = &i; Ok({result}) }}")
}

fn reducer(fty: &Type, f: &str, recv: &str) -> String {
    let Type::Fn(sig) = fty else {
        unreachable!("validated reducer")
    };
    let n = sig.params.len();
    let mut args = String::new();
    if n >= 1 {
        args.push_str(", acc");
    }
    if n >= 2 {
        args.push_str(", x.clone()");
    }
    if n >= 3 {
        args.push_str(", i");
    }
    if n >= 4 {
        args.push_str(&format!(", {recv}.clone()"));
    }
    format!("|acc, x, i| -> JsResult<_> {{ let _ = (&acc, &x, &i); Ok(({f})(cx{args})?) }}")
}

pub fn emit(cx: &mut FnCtx, name: &str, args: &[Expr], ty: &Type) -> String {
    let types: Vec<Type> = args.iter().map(|a| cx.ty(a)).collect();
    let mut code = String::new();
    let mut t = vec![];
    for (i, a) in args.iter().enumerate() {
        let v = cx.expr(a);
        code.push_str(&format!("let a{i} = {v}; "));
        t.push(format!("a{i}"));
    }
    let q = |cx: &FnCtx, s: String| cx.q(&s);
    let (ns, method) = name.split_once('.').unwrap_or(("", name));
    let body: String = match (ns, method) {
        ("Math", "PI") => "std::f64::consts::PI".into(),
        ("Math", "E") => "std::f64::consts::E".into(),
        ("Math", "LN2") => "std::f64::consts::LN_2".into(),
        ("Math", "LN10") => "std::f64::consts::LN_10".into(),
        ("Math", "LOG2E") => "std::f64::consts::LOG2_E".into(),
        ("Math", "LOG10E") => "std::f64::consts::LOG10_E".into(),
        ("Math", "SQRT1_2") => "std::f64::consts::FRAC_1_SQRT_2".into(),
        ("Math", "SQRT2") => "std::f64::consts::SQRT_2".into(),
        ("Math", m @ ("min" | "max" | "hypot")) => format!("js::math::{m}(&[{}])", t.join(", ")),
        ("Math", m) => format!("js::math::{m}({})", t.join(", ")),
        ("Number", "MAX_SAFE_INTEGER") => "9007199254740991.0f64".into(),
        ("Number", "MIN_SAFE_INTEGER") => "(-9007199254740991.0f64)".into(),
        ("Number", "EPSILON") => "f64::EPSILON".into(),
        ("Number", "MAX_VALUE") => "f64::MAX".into(),
        ("Number", "MIN_VALUE") => "5e-324f64".into(),
        ("Number", "POSITIVE_INFINITY") => "f64::INFINITY".into(),
        ("Number", "NEGATIVE_INFINITY") => "f64::NEG_INFINITY".into(),
        ("Number", "NaN") => "f64::NAN".into(),
        ("Number", "isNaN") => format!("{}.is_nan()", t[0]),
        ("Number", "isFinite") => format!("{}.is_finite()", t[0]),
        ("Number", "isInteger") => format!("js::is_integer({})", t[0]),
        ("Number", "isSafeInteger") => format!("js::is_safe_integer({})", t[0]),
        ("Number" | "", "parseFloat") => format!("js::parse_float(&{})", t[0]),
        ("Number" | "", "parseInt") => format!("js::parse_int(&{}, {})", t[0], opt_num(t.get(1))),
        ("", "isNaN") => format!("js::ToNumber::to_number(&{}).is_nan()", t[0]),
        ("", "isFinite") => format!("js::ToNumber::to_number(&{}).is_finite()", t[0]),
        ("", "String") => match t.first() {
            Some(v) => format!("js::ToJsString::to_js_string(&{v})"),
            None => "JsString::new()".into(),
        },
        ("", "Number") => match t.first() {
            Some(v) => format!("js::ToNumber::to_number(&{v})"),
            None => "0.0f64".into(),
        },
        ("", "Boolean") => match t.first() {
            Some(v) => format!("js::Truthy::truthy(&{v})"),
            None => "false".into(),
        },
        ("", "structuredClone") => deep_clone(&types[0], &t[0], cx.p),
        ("number", "toFixed") => q(
            cx,
            format!(
                "js::to_fixed({}, {})",
                t[0],
                t.get(1).map_or("0.0".into(), Clone::clone)
            ),
        ),
        ("number", "toString") => match t.get(1) {
            Some(r) => q(cx, format!("js::to_string_radix({}, {r})", t[0])),
            None => format!("js::ToJsString::to_js_string(&{})", t[0]),
        },
        ("number", "toPrecision") => q(
            cx,
            format!("js::to_precision({}, {})", t[0], opt_num(t.get(1))),
        ),
        ("number", "toExponential") => q(
            cx,
            format!("js::to_exponential({}, {})", t[0], opt_num(t.get(1))),
        ),
        ("string", m) => string(cx, m, &t),
        ("array", m) => array(cx, m, &t, &types),
        ("Array", "from") => {
            let items = match &types[0] {
                Type::Array(_) => format!("js::array({}.borrow().clone())", t[0]),
                Type::Set(_) => format!("js::array_ops::set_values(&{})", t[0]),
                _ => format!("js::array(js::string_ops::code_points(&{}))", t[0]),
            };
            match (t.get(1), types.get(1)) {
                (Some(f), Some(fty)) => {
                    let ad = adapter(fty, f, "items", false);
                    q(
                        cx,
                        format!("{{ let items = {items}; js::array_ops::map(&items, {ad}) }}"),
                    )
                }
                _ => items,
            }
        }
        ("Array", "isArray") => format!(
            "{{ let _ = &{}; {} }}",
            t[0],
            matches!(types[0], Type::Array(_))
        ),
        ("Array", "of") => format!("js::array(vec![{}])", t.join(", ")),
        ("Map", "new") => "js::array_ops::map_new(Vec::new())".into(),
        ("Set", "new") => match t.first() {
            Some(items) => format!("js::array_ops::set_new({items}.borrow().clone())"),
            None => "js::array_ops::set_new(Vec::new())".into(),
        },
        ("map", m) => match m {
            "get" => format!("js::array_ops::map_get(&{}, &{})", t[0], t[1]),
            "set" => format!("js::array_ops::map_set(&{}, {}, {})", t[0], t[1], t[2]),
            "has" => format!("js::array_ops::map_has(&{}, &{})", t[0], t[1]),
            "delete" => format!("js::array_ops::map_delete(&{}, &{})", t[0], t[1]),
            "clear" => format!("js::array_ops::map_clear(&{})", t[0]),
            "size" => format!("js::array_ops::map_size(&{})", t[0]),
            "keys" => format!("js::array_ops::map_keys(&{})", t[0]),
            "values" => format!("js::array_ops::map_values(&{})", t[0]),
            other => unreachable!("validated map method {other}"),
        },
        ("set", m) => match m {
            "add" => format!("js::array_ops::set_add(&{}, {})", t[0], t[1]),
            "has" => format!("js::array_ops::set_has(&{}, &{})", t[0], t[1]),
            "delete" => format!("js::array_ops::set_delete(&{}, &{})", t[0], t[1]),
            "clear" => format!("js::array_ops::set_clear(&{})", t[0]),
            "size" => format!("js::array_ops::set_size(&{})", t[0]),
            "values" | "keys" => format!("js::array_ops::set_values(&{})", t[0]),
            other => unreachable!("validated set method {other}"),
        },
        ("timer", "timeout" | "interval") => {
            let kind = if method == "timeout" {
                "Timeout"
            } else {
                "Interval"
            };
            format!(
                "{{ let f = {}; let g: Rc<dyn Fn(&mut Cx) -> JsResult<()>> = Rc::new(move |cx: &mut Cx| {{ let _ = f(cx)?; Ok(()) }}); cx.timers.add(runic_runtime::TimerKind::{kind}, TimerCb::Plain(g), {}) }}",
                t[0], t[1]
            )
        }
        ("timer", "frame") => {
            let call = match &types[0] {
                Type::Fn(f) if f.params.is_empty() => "f(cx)",
                _ => "f(cx, time)",
            };
            format!(
                "{{ let f = {}; let g: Rc<dyn Fn(&mut Cx, f64) -> JsResult<()>> = Rc::new(move |cx: &mut Cx, time: f64| {{ let _ = {call}?; Ok(()) }}); cx.timers.frame(TimerCb::Frame(g)) }}",
                t[0]
            )
        }
        ("timer", "clear") => format!("{{ cx.timers.clear({}); }}", t[0]),
        ("microtask", "queue") => format!(
            "{{ let f = {}; let g: Lst = Rc::new(move |cx: &mut Cx| {{ let _ = f(cx)?; Ok(()) }}); cx.jobs.queue(g); }}",
            t[0]
        ),
        ("clock", "now") => "cx.timers.now".into(),
        ("clock", "date") => "(cx.timers.origin + cx.timers.now)".into(),
        // Focus requests are applied by the runtime after the update.
        ("element", "focus") => format!("{{ cx.focus = Some(({}.0, true)); }}", t[0]),
        ("element", "blur") => format!("{{ cx.focus = Some(({}.0, false)); }}", t[0]),
        ("maybe", m) => {
            let is_maybe = matches!(types[0], Type::Maybe(_));
            match (m, is_maybe) {
                ("is-null", true) => format!("{}.is_null()", t[0]),
                ("is-undefined", true) => format!("{}.is_undefined()", t[0]),
                ("is-nullish", true) => format!("{}.is_nullish()", t[0]),
                (_, false) => format!("{{ let _ = &{}; {} }}", t[0], types[0] == Type::Void),
                _ => unreachable!(),
            }
        }
        ("JSON", "stringify") => {
            let indent = match (t.get(2), types.get(2)) {
                (Some(v), Some(Type::Number)) => format!("js::json::Indent::Spaces({v})"),
                (Some(v), Some(Type::String)) => format!("js::json::Indent::Text({v}.clone())"),
                _ => "js::json::Indent::None".into(),
            };
            let j = to_json(&types[0], &t[0], cx.p);
            format!(
                "match {j} {{ Some(j) => js::json::stringify(&j, &{indent}), None => JsString::new() }}"
            )
        }
        ("JSON", "parse") => {
            let from = from_json(ty, "j", cx.p);
            q(
                cx,
                format!(
                    "(|| -> JsResult<{}> {{ let j = js::json::parse(&{})?; {from} }})()",
                    rust_type(ty),
                    t[0]
                ),
            )
        }
        ("Object", "keys") => {
            let Type::Record(r) = &types[0] else {
                unreachable!()
            };
            let names: Vec<String> = cx.p.records[*r]
                .fields
                .iter()
                .map(|f| js_str(&f.name))
                .collect();
            format!(
                "{{ let _ = &{}; js::array(vec![{}]) }}",
                t[0],
                names.join(", ")
            )
        }
        ("Object", "values") => {
            let Type::Record(r) = &types[0] else {
                unreachable!()
            };
            let fields: Vec<String> = (0..cx.p.records[*r].fields.len())
                .map(|i| format!("b.f{i}.clone()"))
                .collect();
            format!(
                "{{ let b = {}.borrow(); js::array(vec![{}]) }}",
                t[0],
                fields.join(", ")
            )
        }
        _ => unreachable!("validated builtin {name}"),
    };
    format!("{{ {code}{body} }}")
}

fn string(cx: &FnCtx, m: &str, t: &[String]) -> String {
    let s = &t[0];
    let arg = |i: usize| t.get(i).cloned().unwrap_or_else(|| "0.0".into());
    let opt = |i: usize| opt_num(t.get(i));
    let opt_s = |i: usize| {
        t.get(i).map_or("Maybe::Undefined".into(), |v| {
            format!("Maybe::Some({v}.clone())")
        })
    };
    let st = "js::string_ops";
    match m {
        "at" => format!("{st}::at(&{s}, {})", arg(1)),
        "index" => format!("{st}::index(&{s}, {})", arg(1)),
        "charAt" => format!("{st}::char_at(&{s}, {})", arg(1)),
        "charCodeAt" => format!("{st}::char_code_at(&{s}, {})", arg(1)),
        "codePointAt" => format!("{st}::code_point_at(&{s}, {})", arg(1)),
        "slice" => format!("{st}::slice(&{s}, {}, {})", arg(1), opt(2)),
        "substring" => format!("{st}::substring(&{s}, {}, {})", arg(1), opt(2)),
        "indexOf" => format!("{st}::index_of(&{s}, &{}, {})", t[1], opt(2)),
        "lastIndexOf" => format!("{st}::last_index_of(&{s}, &{}, {})", t[1], opt(2)),
        "includes" => format!("{st}::includes(&{s}, &{}, {})", t[1], opt(2)),
        "startsWith" => format!("{st}::starts_with(&{s}, &{}, {})", t[1], opt(2)),
        "endsWith" => format!("{st}::ends_with(&{s}, &{}, {})", t[1], opt(2)),
        "trim" => format!("{st}::trim(&{s})"),
        "trimStart" => format!("{st}::trim_start(&{s})"),
        "trimEnd" => format!("{st}::trim_end(&{s})"),
        "toUpperCase" => format!("{st}::to_upper_case(&{s})"),
        "toLowerCase" => format!("{st}::to_lower_case(&{s})"),
        "toString" => s.clone(),
        "padStart" => format!("{st}::pad_start(&{s}, {}, {})", t[1], opt_s(2)),
        "padEnd" => format!("{st}::pad_end(&{s}, {}, {})", t[1], opt_s(2)),
        "repeat" => cx.q(&format!("{st}::repeat(&{s}, {})", t[1])),
        "split" => format!("{st}::split(&{s}, {}, {})", opt_s(1), opt(2)),
        "replace" => format!("{st}::replace(&{s}, &{}, &{})", t[1], t[2]),
        "replaceAll" => format!("{st}::replace_all(&{s}, &{}, &{})", t[1], t[2]),
        "concat" => format!("{st}::concat(&{s}, &[{}])", t[1..].join(", ")),
        "localeCompare" => format!("{st}::locale_compare(&{s}, &{})", t[1]),
        "lt" => format!("{st}::compare(&{s}, &{}).is_lt()", t[1]),
        "le" => format!("{st}::compare(&{s}, &{}).is_le()", t[1]),
        "gt" => format!("{st}::compare(&{s}, &{}).is_gt()", t[1]),
        "ge" => format!("{st}::compare(&{s}, &{}).is_ge()", t[1]),
        other => unreachable!("validated string method {other}"),
    }
}

fn array(cx: &FnCtx, m: &str, t: &[String], types: &[Type]) -> String {
    let a = &t[0];
    let ar = "js::array_ops";
    let opt = |i: usize| opt_num(t.get(i));
    // Items inserted into a proxied array become proxies.
    let owned_rest = |from: usize| {
        format!(
            "vec![{}]",
            t.get(from..)
                .unwrap_or(&[])
                .iter()
                .map(|x| format!("js::own_into(&{a}, {x})"))
                .collect::<Vec<_>>()
                .join(", ")
        )
    };
    match m {
        "length" => format!("{ar}::length(&{a})"),
        "get" => format!("{ar}::get(&{a}, {})", t[1]),
        "at" => format!("{ar}::at(&{a}, {})", t[1]),
        "push" => format!("{ar}::push(&{a}, {})", owned_rest(1)),
        "unshift" => format!("{ar}::unshift(&{a}, {})", owned_rest(1)),
        "pop" => format!("{ar}::pop(&{a})"),
        "shift" => format!("{ar}::shift(&{a})"),
        "slice" => format!("{ar}::slice(&{a}, {}, {})", opt(1), opt(2)),
        "splice" => format!(
            "{ar}::splice(&{a}, {}, {}, {})",
            t[1],
            opt(2),
            owned_rest(3)
        ),
        "concat" => {
            let args: Vec<String> = t[1..]
                .iter()
                .zip(&types[1..])
                .map(|(v, ty)| {
                    if *ty == types[0] {
                        format!("{ar}::ConcatArg::Array({v})")
                    } else {
                        format!("{ar}::ConcatArg::Item({v})")
                    }
                })
                .collect();
            format!("{ar}::concat(&{a}, vec![{}])", args.join(", "))
        }
        "indexOf" => format!("{ar}::index_of(&{a}, &{}, {})", t[1], opt(2)),
        "lastIndexOf" => format!("{ar}::last_index_of(&{a}, &{}, {})", t[1], opt(2)),
        "includes" => format!("{ar}::includes(&{a}, &{}, {})", t[1], opt(2)),
        "find" | "findLast" | "findIndex" | "findLastIndex" | "some" | "every" | "filter" => {
            let f = adapter(&types[1], &t[1], a, true);
            let func = match m {
                "findLast" => "find_last",
                "findIndex" => "find_index",
                "findLastIndex" => "find_last_index",
                other => other,
            };
            cx.q(&format!("{ar}::{func}(&{a}, {f})"))
        }
        "forEach" => {
            let f = adapter(&types[1], &t[1], a, false);
            cx.q(&format!(
                "{ar}::for_each(&{a}, |x, i| {{ ({f})(x, i).map(|_| ()) }})"
            ))
        }
        "map" => cx.q(&format!(
            "{ar}::map(&{a}, {})",
            adapter(&types[1], &t[1], a, false)
        )),
        "flatMap" => cx.q(&format!(
            "{ar}::flat_map(&{a}, {})",
            adapter(&types[1], &t[1], a, false)
        )),
        "reduce" | "reduceRight" => {
            let f = reducer(&types[1], &t[1], a);
            match (t.get(2), m) {
                (Some(init), "reduce") => cx.q(&format!("{ar}::reduce(&{a}, {f}, {init})")),
                (Some(init), _) => cx.q(&format!("{ar}::reduce_right(&{a}, {f}, {init})")),
                (None, "reduce") => cx.q(&format!("{ar}::reduce_first(&{a}, {f})")),
                (None, _) => cx.q(&format!(
                    "{ar}::reduce_first(&{ar}::to_reversed(&{a}), {f})"
                )),
            }
        }
        "join" => format!(
            "{ar}::join(&{a}, {})",
            t.get(1).map_or("Maybe::Undefined".into(), |s| format!(
                "Maybe::Some({s}.clone())"
            ))
        ),
        "reverse" => format!("{ar}::reverse(&{a})"),
        "toReversed" => format!("{ar}::to_reversed(&{a})"),
        "sort" | "toSorted" => {
            let func = if m == "sort" { "sort" } else { "to_sorted" };
            match t.get(1) {
                Some(f) => cx.q(&format!(
                    "{{ let mut cmp = |x: &_, y: &_| -> JsResult<f64> {{ Ok(({f})(cx, Clone::clone(x), Clone::clone(y))?) }}; {ar}::{func}(&{a}, Some(&mut cmp)) }}"
                )),
                None => cx.q(&format!("{ar}::{func}(&{a}, None)")),
            }
        }
        "with" => cx.q(&format!("{ar}::with(&{a}, {}, {})", t[1], t[2])),
        "fill" => format!(
            "{ar}::fill(&{a}, js::own_into(&{a}, {}), {}, {})",
            t[1],
            opt(2),
            opt(3)
        ),
        "flat" => format!("{ar}::flat(&{a})"),
        other => unreachable!("validated array method {other}"),
    }
}

/// Rust expression of type `Option<Json>` for value `v` of type `t`.
pub fn to_json(t: &Type, v: &str, p: &Program) -> String {
    match t {
        Type::Number => format!(
            "Some(if {v}.is_finite() {{ js::json::Json::Num({v}) }} else {{ js::json::Json::Null }})"
        ),
        Type::String => format!("Some(js::json::Json::Str({v}.clone()))"),
        Type::Boolean => format!("Some(js::json::Json::Bool({v}))"),
        Type::Maybe(i) => format!(
            "(match &{v} {{ Maybe::Some(x) => {}, Maybe::Null => Some(js::json::Json::Null), Maybe::Undefined => None }})",
            to_json(i, "(*x)", p)
        ),
        Type::Array(i) => format!(
            "Some(js::json::Json::Array({v}.borrow().iter().map(|x| {}.unwrap_or(js::json::Json::Null)).collect()))",
            to_json(i, "(*x)", p)
        ),
        Type::Record(r) => format!("Some(json_to_r{r}(&{v}))"),
        _ => "None".into(),
    }
}

/// Rust expression of type `JsResult<T>` reading JSON value `j` as `t`.
pub fn from_json(t: &Type, j: &str, p: &Program) -> String {
    let bad = |want: &str| {
        format!(
            "Err(js::Throw::syntax_error(\"JSON value does not match the expected type: expected {want}\"))"
        )
    };
    match t {
        Type::Number => format!(
            "match {j} {{ js::json::Json::Num(n) => Ok(*n), _ => {} }}",
            bad("number")
        ),
        Type::String => format!(
            "match {j} {{ js::json::Json::Str(s) => Ok(s.clone()), _ => {} }}",
            bad("string")
        ),
        Type::Boolean => format!(
            "match {j} {{ js::json::Json::Bool(b) => Ok(*b), _ => {} }}",
            bad("boolean")
        ),
        Type::Maybe(i) => format!(
            "match {j} {{ js::json::Json::Null => Ok(Maybe::Null), other => Ok(Maybe::Some({}?)) }}",
            from_json(i, "other", p)
        ),
        Type::Array(i) => format!(
            "match {j} {{ js::json::Json::Array(items) => Ok(js::array(items.iter().map(|x| {}).collect::<JsResult<Vec<_>>>()?)), _ => {} }}",
            from_json(i, "x", p),
            bad("array")
        ),
        Type::Record(r) => format!("json_from_r{r}({j})"),
        _ => bad("value"),
    }
}

/// Rust expression deep-copying `v` of type `t` (structuredClone).
pub fn deep_clone(t: &Type, v: &str, p: &Program) -> String {
    match t {
        Type::Maybe(i) => format!(
            "(match &{v} {{ Maybe::Some(x) => Maybe::Some({}), Maybe::Null => Maybe::Null, Maybe::Undefined => Maybe::Undefined }})",
            deep_clone(i, "(*x)", p)
        ),
        Type::Array(i) => format!(
            "js::array({v}.borrow().iter().map(|x| {}).collect())",
            deep_clone(i, "(*x)", p)
        ),
        Type::Record(r) => format!("clone_r{r}(&{v})"),
        Type::Map(k, x) => format!(
            "js::array_ops::map_new({v}.borrow().entries.values().map(|(k, x)| ({}, {})).collect())",
            deep_clone(k, "(*k)", p),
            deep_clone(x, "(*x)", p)
        ),
        Type::Set(i) => format!(
            "js::array_ops::set_new({v}.borrow().entries.values().map(|x| {}).collect())",
            deep_clone(i, "(*x)", p)
        ),
        _ => format!("{v}.clone()"),
    }
}
