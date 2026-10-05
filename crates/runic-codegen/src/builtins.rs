//! Rust spellings of the built-in catalogue (`runic_ir::builtins`). Every
//! argument is evaluated into a temporary first (in order); the result uses
//! the shared `runic-js` implementations.

use crate::expr::{FnCtx, js_str};
use crate::types::rust_type;
use runic_ir::{Expr, Program, Type};

/// An IR function `f` of type `fty` as a promise handler: it receives the
/// value (or, for rejections, the Error record of the exception) and its
/// result settles the derived promise (a returned promise is adopted).
fn promise_handler(fty: &Type, f: &str, error: Option<usize>, settles: Option<&Type>) -> String {
    let Type::Fn(sig) = fty else {
        unreachable!("validated handler")
    };
    let arg = match error {
        Some(e) => format!("JsRef::new(R{e} {{ f0: v.name.clone(), f1: v.message.clone() }})"),
        None => "v".into(),
    };
    let mut call = if sig.params.is_empty() {
        "{ let _ = v; f(cx)? }".to_string()
    } else {
        format!("f(cx, {arg})?")
    };
    // A value settling a promise of `U | undefined`.
    if let Some(Type::Promise(x)) = settles {
        if matches!(**x, Type::Maybe(_))
            && !matches!(*sig.result, Type::Maybe(_) | Type::Promise(_))
        {
            call = format!("Maybe::Some({call})");
        }
    }
    let wrap = match &*sig.result {
        Type::Promise(_) => "Promise",
        _ => "Value",
    };
    let v = if error.is_some() { "v: js::Throw" } else { "v" };
    format!(
        "{{ let f = {f}; let h: runic_runtime::promises::Handler<_, _, Cx> = Rc::new(move |cx: &mut Cx, {v}| Ok(runic_runtime::promises::Settles::{wrap}({call}))); h }}"
    )
}

/// The exception an Error record stands for.
fn throw_of(e: &str) -> String {
    format!("js::Throw {{ name: {e}.borrow().f0.clone(), message: {e}.borrow().f1.clone() }}")
}

fn opt_num(t: Option<&String>) -> String {
    t.map_or("Maybe::Undefined".into(), |v| format!("Maybe::Some({v})"))
}

/// The call of callback value `f` (IR type `fty`) on element `x` at index
/// `i` of `recv`, as `runic_js::array_ops` passes them.
fn callback_call(fty: &Type, f: &str, recv: &str, predicate: bool) -> String {
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
    if predicate && *sig.result != Type::Boolean {
        format!("js::Truthy::truthy(&{call})")
    } else {
        call
    }
}

/// A Rust closure adapting callback value `f` (IR type `fty`) to the
/// `(&T, f64[, ...]) -> JsResult<_>` shape of `runic_js::array_ops`.
fn adapter(fty: &Type, f: &str, recv: &str, predicate: bool) -> String {
    let result = callback_call(fty, f, recv, predicate);
    format!("|x, i| -> JsResult<_> {{ let _ = &i; Ok({result}) }}")
}

/// A `forEach` callback: the call with its result discarded, passed straight
/// to `for_each` so that the closure's parameter types are inferred (a
/// closure called in place inside another one has none to infer from).
fn effect_adapter(fty: &Type, f: &str, recv: &str) -> String {
    let call = callback_call(fty, f, recv, false);
    format!("|x, i| -> JsResult<()> {{ let _ = &i; let _ = {call}; Ok(()) }}")
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
        ("date", m) => date(cx, m, &t),
        ("intl", m) => intl(cx, m, &t, args),
        ("regexp", m) => regexp(cx, m, &t, ty),
        ("string", m) if m.starts_with("regexp-") => string_regexp(cx, m, &t, &types, ty, args),
        ("match", m) => match m {
            "index" => format!("js::regexp::match_index(&{})", t[0]),
            "input" => format!("js::regexp::match_input(&{})", t[0]),
            "has-groups" => format!("js::regexp::match_has_groups(&{})", t[0]),
            "group" => q(cx, format!("js::regexp::match_group(&{}, &{})", t[0], t[1])),
            other => unreachable!("validated match member {other}"),
        },
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
        ("storage", "get") => format!(
            "(match cx.storage.get(&{}) {{ Some(v) => Maybe::Some(v), None => Maybe::Null }})",
            t[0]
        ),
        ("storage", "set") => format!("{{ cx.storage.set({}, {}); }}", t[0], t[1]),
        ("storage", "remove") => format!("{{ cx.storage.remove(&{}); }}", t[0]),
        ("storage", "clear") => "{ cx.storage.clear(); }".into(),
        // Host services (docs/design/M5-PLATFORM.md).
        ("console", level) => {
            let level = match level {
                "log" | "info" | "warn" | "error" => level,
                _ => "debug",
            };
            let parts: Vec<String> = t
                .iter()
                .zip(&types)
                .map(|(v, ty)| match ty {
                    Type::String => format!("{v}.clone()"),
                    // Typed: a null or undefined literal has no other use.
                    _ => format!(
                        "{{ let x: {} = {v}.clone(); js::ToJsString::to_js_string(&x) }}",
                        rust_type(ty)
                    ),
                })
                .collect();
            format!(
                "runic_runtime::console::write({level:?}, &[{}])",
                parts.join(", ")
            )
        }
        ("clipboard", "write") => format!("cx.clipboard_write({})?", t[0]),
        ("clipboard", "read") => "cx.clipboard_read()?".into(),
        ("history", "back") => "cx.traverse(-1)?".into(),
        ("history", "forward") => "cx.traverse(1)?".into(),
        ("history", "go") => format!("cx.traverse({} as i64)?", t[0]),
        ("history", m @ ("push" | "replace")) => {
            let url = match (t.first(), types.first()) {
                (Some(u), Some(Type::String)) => format!("Some(&{u})"),
                (Some(u), Some(_)) => format!("match &{u} {{ Maybe::Some(u) => Some(u), _ => None }}"),
                _ => "None".into(),
            };
            let state = match t.get(1) {
                Some(s) => format!("match &{s} {{ Maybe::Some(s) => Some(s), _ => None }}"),
                None => "None".into(),
            };
            format!("runic_runtime::history::{m}({url}, {state})?")
        }
        ("history", "state") => "(match runic_runtime::history::state() { Some(s) => Maybe::Some(s), None => Maybe::Null })".into(),
        // The document (M6).
        ("document", "title") => "runic_runtime::history::title()".into(),
        ("document", "set-title") => format!("{{ runic_runtime::history::set_title(&{}); }}", t[0]),
        ("document", "getElementById") => format!(
            "(match cx.dom.element_by_id(&{}.to_rust()) {{ Some(e) => Maybe::Some(js::Element(e)), None => Maybe::Null }})",
            t[0]
        ),
        ("focus", "current") => "(match cx.dom.focused() { Some(e) => Maybe::Some(js::Element(e)), None => Maybe::Null })".into(),
        ("focus", "start") => format!("{{ cx.dom.focus_start({}.0); }}", t[0]),
        ("focus", "reset") => "{ let events = cx.dom.reset_focus(); run_nested(cx, events); }".into(),
        ("url", "resolve") => format!(
            "(match js::history::Session::resolve_against(&{}, &{}) {{ Some(u) => Maybe::Some(JsString::from(u)), None => Maybe::Undefined }})",
            t[0], t[1]
        ),
        ("url", "query-pairs") => format!(
            "js::array(js::uri::query_pairs(&{}).into_iter().map(|(k, v)| js::array(vec![k, v])).collect())",
            t[0]
        ),
        ("host", "reply") => "cx.host_reply()".into(),
        ("host", "unsupported") => q(
            cx,
            format!(
                "{{ let what = {}.to_rust(); runic_runtime::unsupported(&what); Err::<(), _>(js::Throw::new(\"RunicUnsupportedError\", what)) }}",
                t[0]
            ),
        ),
        ("", "encodeURIComponent") => q(cx, format!("js::uri::encode_uri_component(&{})", t[0])),
        ("", "decodeURIComponent") => q(cx, format!("js::uri::decode_uri_component(&{})", t[0])),
        ("", "decodeURI") => q(cx, format!("js::uri::decode_uri(&{})", t[0])),
        ("history", "length") => "runic_runtime::history::length()".into(),
        ("location", m @ ("pathname" | "search" | "hash")) => {
            format!("runic_runtime::history::{m}()")
        }
        ("location", "set-hash") => format!("cx.set_hash(&{})?", t[0]),
        ("random", "number") => "cx.random.number()".into(),
        ("random", "uuid") => "cx.random.uuid()".into(),
        ("promise", "new") => {
            let Type::Fn(exec) = &types[0] else {
                unreachable!("validated executor")
            };
            let rej = if exec.params.len() > 1 {
                let e = cx.error_record();
                format!(
                    "let rej: Rc<dyn Fn(&mut Cx, JsRef<R{e}>) -> JsResult<()>> = Rc::new(move |cx: &mut Cx, e: JsRef<R{e}>| rej(cx, {})); ",
                    throw_of("e")
                )
            } else {
                "let _ = rej; ".into()
            };
            let pass = if exec.params.len() > 1 {
                ", res, rej"
            } else {
                ", res"
            };
            format!(
                "runic_runtime::promises::new(cx, |cx: &mut Cx, res, rej| {{ {rej}({})(cx{pass})?; Ok(()) }})",
                t[0]
            )
        }
        ("promise", "resolve") => match &types[0] {
            Type::Promise(_) => t[0].clone(),
            _ => format!("js::JsPromise::fulfilled({})", t[0]),
        },
        ("promise", "reject") => format!("<{}>::rejected({})", rust_type(ty), throw_of(&t[0])),
        ("promise", "then") => {
            let on_rejected = match (args.get(2), types.get(2)) {
                (Some(_), Some(rt)) => format!(
                    "Some({})",
                    promise_handler(rt, &t[2], Some(cx.error_record()), None)
                ),
                _ => "None".into(),
            };
            format!(
                "runic_runtime::promises::then(cx, &{}, {}, {on_rejected})",
                t[0],
                promise_handler(&types[1], &t[1], None, None)
            )
        }
        ("promise", "catch") => {
            // A promise that never fulfils (Promise<void> from Promise.reject) may settle to another type.
            let map = match (&types[0], ty) {
                (a, b) if a == b => "|v| v",
                (_, Type::Promise(x)) if matches!(**x, Type::Maybe(_)) => "|_| Maybe::Undefined",
                _ => "|_| unreachable!(\"a promise that never fulfils\")",
            };
            format!(
                "runic_runtime::promises::catch(cx, &{}, {map}, {})",
                t[0],
                promise_handler(&types[1], &t[1], Some(cx.error_record()), Some(ty))
            )
        }
        ("promise", "finally") => {
            let Type::Fn(sig) = &types[1] else {
                unreachable!("validated callback")
            };
            let wrap = match &*sig.result {
                Type::Promise(_) => "Promise",
                _ => "Value",
            };
            format!(
                "{{ let f = {}; runic_runtime::promises::finally(cx, &{}, Rc::new(move |cx: &mut Cx| Ok(runic_runtime::promises::Settles::{wrap}(f(cx)?)))) }}",
                t[1], t[0]
            )
        }
        ("promise", "pending") => format!("<{}>::pending()", rust_type(ty)),
        ("promise", "fulfil") => format!(
            "{{ runic_runtime::promises::settle(cx, &{}, Ok({})); }}",
            t[0], t[1]
        ),
        ("promise", "adopt") => format!(
            "{{ runic_runtime::promises::resolve(cx, &{}, runic_runtime::promises::Settles::Promise({})); }}",
            t[0], t[1]
        ),
        ("promise", "fail") => format!(
            "{{ runic_runtime::promises::settle(cx, &{}, Err({})); }}",
            t[0],
            throw_of(&t[1])
        ),
        ("promise", "all") => format!(
            "{{ let items = {}.borrow().clone(); runic_runtime::promises::all(cx, &items) }}",
            t[0]
        ),
        ("flush", "tick") => "{ let p = <js::JsPromise<(), Lst>>::pending(); let q = p.clone(); cx.jobs.queue_flush_then(Rc::new(move |cx: &mut Cx| { runic_runtime::promises::settle(cx, &q, Ok(())); Ok(()) })); p }".into(),
        ("flush", "after") => "(if cx.jobs.flushing() { cx.flush_promise.get_or_insert_with(js::JsPromise::pending).clone() } else { js::JsPromise::fulfilled(()) })".into(),
        ("microtask", "queue") => format!(
            "{{ let f = {}; let g: Lst = Rc::new(move |cx: &mut Cx| {{ let _ = f(cx)?; Ok(()) }}); cx.jobs.queue(g); }}",
            t[0]
        ),
        ("clock", "now") => "cx.timers.now".into(),
        ("clock", "date") => "(cx.timers.origin + cx.timers.now)".into(),
        // Focus requests are applied in order when the running callback returns,
        // before any update (the DOM does not change while it runs).
        // focus() and blur() move focus at once; the focus listeners run
        // nested, before the call returns.
        ("element", m @ ("focus" | "blur")) => format!(
            "{{ let events = cx.dom.focus({}.0, {}); run_nested(cx, events); }}",
            t[0],
            m == "focus"
        ),
        // Layout reads and scrolling resolve the native layout first.
        ("element", "getBoundingClientRect") => {
            let Type::Record(r) = ty else {
                panic!("validated DOMRect record")
            };
            let fields: String = (0..8).map(|i| format!("f{i}: v[{i}], ")).collect();
            format!(
                "{{ let v = cx.dom.rect({}.0); JsRef::new(R{r} {{ {fields}}}) }}",
                t[0]
            )
        }
        ("element", m) if runic_ir::builtins::ELEMENT_METRICS.contains(&m) => {
            format!("cx.dom.metric({}.0, {m:?})", t[0])
        }
        ("element", m @ ("set-scrollTop" | "set-scrollLeft")) => format!(
            "cx.dom.set_scroll({}.0, {}, {})",
            t[0],
            m == "set-scrollTop",
            t[1]
        ),
        ("element", m @ ("scrollTo" | "scrollBy")) => format!(
            "cx.dom.scroll(Some({}.0), {}, {}, {})",
            t[0],
            m == "scrollBy",
            opt_number(&t[1]),
            opt_number(&t[2])
        ),
        // Libraries compiled from source (M6).
        ("element", "isConnected") => format!("cx.dom.is_connected({}.0)", t[0]),
        ("element", "isHTML") => format!("cx.dom.is_html({}.0)", t[0]),
        ("element", "computed-style") => format!(
            "JsString::from(cx.dom.computed_style({}.0, &{}.to_rust()))",
            t[0], t[1]
        ),
        ("element", "querySelectorAll") => format!(
            "js::array(cx.dom.query_selector_all({}.0, &{}.to_rust()).into_iter().map(js::Element).collect())",
            t[0], t[1]
        ),
        ("element", "querySelector") => format!(
            "cx.dom.query_selector_all({}.0, &{}.to_rust()).first().map_or(Maybe::Null, |&n| Maybe::Some(js::Element(n)))",
            t[0], t[1]
        ),
        ("element", "closest") => format!(
            "cx.dom.closest({}.0, &{}.to_rust()).map_or(Maybe::Null, |n| Maybe::Some(js::Element(n)))",
            t[0], t[1]
        ),
        ("element", "requestSubmit") => {
            "{ runic_runtime::unsupported(\"requestSubmit (form submission)\"); }".to_string()
        }
        ("element", "hasAttribute") => {
            format!("cx.dom.has_attribute({}.0, &{}.to_rust())", t[0], t[1])
        }
        ("element", "getAttribute") => format!(
            "(match cx.dom.get_attribute({}.0, &{}.to_rust()) {{ Some(v) => Maybe::Some(JsString::from(v)), None => Maybe::Null }})",
            t[0], t[1]
        ),
        ("element", "localName") => format!("JsString::from(cx.dom.local_name({}.0))", t[0]),
        ("element", "parent") => format!(
            "(match cx.dom.parent_element({}.0) {{ Some(e) => Maybe::Some(js::Element(e)), None => Maybe::Null }})",
            t[0]
        ),
        ("element", "style-get") => format!(
            "JsString::from(cx.dom.style_get({}.0, &{}.to_rust()))",
            t[0], t[1]
        ),
        ("element", "style-set") => format!(
            "{{ cx.dom.style_set({}.0, &{}.to_rust(), &{}.to_rust()); }}",
            t[0], t[1], t[2]
        ),
        // No animation or transition can run: none (otherwise unsupported).
        ("element", "getAnimations") => format!(
            "{{ if !cx.dom.animations_none({}.0) {{ runic_runtime::unsupported(\"getAnimations() on an element whose style declares CSS animations or transitions (Blitz exposes no animation objects)\"); }} js::array(Vec::new()) }}",
            t[0]
        ),
        // `beforematch` listeners: the runtime never fires the event.
        ("element", "listen" | "unlisten") => format!("{{ let _ = (&{}, &{}); }}", t[0], t[2]),
        ("mutation", "observe") => format!(
            "{{ let _ = (&{}, &{}, &{}); runic_runtime::unsupported(\"MutationObserver.observe\"); }}",
            t[0], t[1], t[2]
        ),
        // An observer that never observed has nothing to disconnect.
        ("mutation", "disconnect") => format!("{{ let _ = &{}; }}", t[0]),
        ("effect", phase @ ("pre" | "post")) => {
            let Type::Fn(f) = &types[0] else {
                unreachable!("validated effect function")
            };
            let cleanup = match &*f.result {
                Type::Void => "{ f(cx)?; Ok(None) }",
                Type::Maybe(_) => "match f(cx)? { Maybe::Some(c) => Ok(Some(c)), _ => Ok(None) }",
                _ => "Ok(Some(f(cx)?))",
            };
            q(
                cx,
                format!(
                    "{{ let f = {}; let d: Dfx = Rc::new(move |cx: &mut Cx| -> JsResult<Option<Lst>> {{ {cleanup} }}); cx.create_effect({}, d) }}",
                    t[0],
                    phase == "pre"
                ),
            )
        }
        ("reactive", "untrack-call") => {
            let args: String = t[1..].iter().map(|a| format!(", {a}")).collect();
            q(
                cx,
                format!(
                    "{{ let outer = cx.tracking.take(); let heap_outer = js::begin_heap_reads(None); let r = ({})(cx{args}); js::end_heap_reads(heap_outer); cx.tracking = outer; r }}",
                    t[0]
                ),
            )
        }
        ("context", "set") => format!(
            "{{ let v = {}; {}; v }}",
            t[1],
            q(
                cx,
                format!("cx.context_set({}, Rc::new(v.clone()) as Rc<dyn std::any::Any>)", t[0])
            )
        ),
        ("context", "get") => {
            let Type::Maybe(inner) = ty else {
                unreachable!("validated context type")
            };
            let found = q(cx, format!("cx.context_get(&{})", t[0]));
            let mismatch = q(
                cx,
                "Err::<(), _>(js::Throw::type_error(\"RunicContextError: a context of another type under the key\"))".into(),
            );
            format!(
                "match {found} {{ Some(v) => match v.downcast_ref::<{}>() {{ Some(x) => Maybe::Some(x.clone()), None => {{ {mismatch}; unreachable!() }} }}, None => Maybe::Undefined }}",
                rust_type(inner)
            )
        }
        ("uid", "next") => format!(
            "{{ cx.uids += 1; JsString::from(format!(\"{{}}{{}}\", {}.to_rust(), cx.uids)) }}",
            t[0]
        ),
        ("attrs", m) => attrs_builtin(cx, m, &t, ty),
        ("element", "scrollIntoView") => format!(
            "cx.dom.scroll_into_view({}.0, &{}.to_rust(), &{}.to_rust())",
            t[0], t[1], t[2]
        ),
        ("window", m) if runic_ir::builtins::WINDOW_METRICS.contains(&m) => {
            format!("cx.dom.window_metric({m:?})")
        }
        ("window", m @ ("scrollTo" | "scrollBy")) => format!(
            "cx.dom.scroll(None, {}, {}, {})",
            m == "scrollBy",
            opt_number(&t[0]),
            opt_number(&t[1])
        ),
        // The document element and media queries (runic_css, applied to
        // <html> by the runtime).
        ("root", m) => {
            let arg = |i: usize| format!("&{}.to_rust()", t[i]);
            let dom_error = "map_err(|(n, m)| js::Throw::new(n, m))";
            match m {
                "get-attr" => format!(
                    "(match cx.root.get({}) {{ Some(v) => Maybe::Some(JsString::from(v)), None => Maybe::Null }})",
                    arg(0)
                ),
                "set-attr" => format!("{{ cx.root.set({}, {}); }}", arg(0), arg(1)),
                "remove-attr" => format!("{{ cx.root.remove({}); }}", arg(0)),
                "class-contains" => format!("cx.root.class_contains({})", arg(0)),
                "class-toggle" => {
                    let force = t.get(1).map_or("None".to_string(), |f| format!("Some({f})"));
                    q(cx, format!("cx.root.class_toggle({}, {force}).{dom_error}", arg(0)))
                }
                "class-add" | "class-remove" => {
                    let on = m == "class-add";
                    format!("{{ {}; }}", q(cx, format!("cx.root.class_set({}, {on}).{dom_error}", arg(0))))
                }
                "style-set" => format!("{{ cx.root.style_set({}, {}); }}", arg(0), arg(1)),
                "style-remove" => format!("JsString::from(cx.root.style_remove({}))", arg(0)),
                "style-get" => format!("JsString::from(cx.root.style_get({}))", arg(0)),
                other => unreachable!("validated document element operation {other}"),
            }
        }
        ("media", "matches") => format!(
            "runic_runtime::css::media_matches(&{}.to_rust(), &cx.media).unwrap_or(false)",
            t[0]
        ),
        ("media", "query") => format!(
            "{{ let q = {}.to_rust(); let m = runic_runtime::css::media_matches(&q, &cx.media).unwrap_or(false); js::MediaQueryList::new(&q, m) }}",
            t[0]
        ),
        ("media-query", "matches") => format!(
            "runic_runtime::css::media_matches({}.query(), &cx.media).unwrap_or(false)",
            t[0]
        ),
        // Change listeners, identified by their function value.
        ("media-query", m @ ("listen" | "unlisten")) => {
            let find = "cx.media_host.iter().position(|h| h.0 == list && h.1 == id)";
            if m == "unlisten" {
                format!(
                    "{{ let list = {}; let f = {}; let id = Rc::as_ptr(&f) as *const () as usize; if let Some(i) = {find} {{ let key = cx.media_host.remove(i).2; cx.listeners[key as usize] = None; cx.free.push(key); }} }}",
                    t[0], t[1]
                )
            } else {
                let call = match &types[1] {
                    Type::Fn(f) if f.params.is_empty() => "f(cx)",
                    _ => "f(cx, cx.event.clone().expect(\"event context\"))",
                };
                format!(
                    "{{ let list = {}; let f = {}; let id = Rc::as_ptr(&f) as *const () as usize; if {find}.is_none() {{ let g: Lst = Rc::new(move |cx: &mut Cx| {{ let _ = {call}?; Ok(()) }}); let key = cx.listen(g); cx.media_host.push((list, id, key)); }} }}",
                    t[0], t[1]
                )
            }
        }
        // Window and document listeners, identified by their function value.
        (target @ ("window" | "document"), m @ ("listen" | "unlisten")) => {
            let Some(Expr::Lit {
                value: runic_ir::Value::String(name),
            }) = args.first()
            else {
                unreachable!("validated event kind")
            };
            let kind = format!("Event::{:?}", runic_ir::EventKind::parse(name).expect("validated kind"));
            let window = target == "window";
            let find = format!(
                "cx.host.iter().position(|h| h.0 == {window} && h.1 == {kind} && h.2 == id)"
            );
            if m == "unlisten" {
                format!(
                    "{{ let f = {}; let id = Rc::as_ptr(&f) as *const () as usize; if let Some(i) = {find} {{ let key = cx.host.remove(i).3; cx.listeners[key as usize] = None; cx.free.push(key); }} }}",
                    t[1]
                )
            } else {
                let call = match &types[1] {
                    Type::Fn(f) if f.params.is_empty() => "f(cx)",
                    _ => "f(cx, cx.event.clone().expect(\"event context\"))",
                };
                format!(
                    "{{ let f = {}; let id = Rc::as_ptr(&f) as *const () as usize; if {find}.is_none() {{ let g: Lst = Rc::new(move |cx: &mut Cx| {{ let _ = {call}?; Ok(()) }}); let key = cx.listen(g); cx.host.push(({window}, {kind}, id, key)); }} }}",
                    t[1]
                )
            }
        }
        ("event", m) => {
            let e = &t[0];
            match m {
                "type" => format!("{e}.data().kind.clone()"),
                "key" => format!("{e}.data().key.clone()"),
                "code" => format!("{e}.data().code.clone()"),
                "value" => format!("{e}.data().value.clone()"),
                "ctrlKey" => format!("{e}.data().ctrl"),
                "shiftKey" => format!("{e}.data().shift"),
                "altKey" => format!("{e}.data().alt"),
                "metaKey" => format!("{e}.data().meta"),
                "matches" => format!("{e}.data().matches"),
                "repeat" => format!("{e}.data().repeat"),
                "checked" => format!("{e}.data().checked"),
                "clientX" => format!("{e}.data().client_x"),
                "clientY" => format!("{e}.data().client_y"),
                "button" => format!("{e}.data().button"),
                "buttons" => format!("{e}.data().buttons"),
                "deltaX" => format!("{e}.data().delta_x"),
                "deltaY" => format!("{e}.data().delta_y"),
                "detail" => format!("{e}.data().detail"),
                "target" => format!("{e}.data().target"),
                "relatedTarget" => format!("{e}.data().related.map_or(Maybe::Null, Maybe::Some)"),
                "currentTarget" => {
                    format!("{e}.current_target().map_or(Maybe::Null, Maybe::Some)")
                }
                "defaultPrevented" => format!("{e}.default_prevented()"),
                "preventDefault" => format!("{{ {e}.prevent_default(); }}"),
                "stopPropagation" => format!("{{ {e}.stop_propagation(); }}"),
                "stopImmediatePropagation" => format!("{{ {e}.stop_immediate_propagation(); }}"),
                other => unreachable!("validated event member {other}"),
            }
        }
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

/// Attribute bag built-ins (M6, docs/IR.md "Attribute bags").
fn attrs_builtin(cx: &mut FnCtx, m: &str, t: &[String], ty: &Type) -> String {
    let mismatch = |cx: &FnCtx, what: &str| {
        cx.q(&format!(
            "Err::<(), _>(js::Throw::type_error(\"RunicAttrsError: the spread passes {what} a value of another type than the prop's\"))"
        ))
    };
    match m {
        "has" => format!("{}.entries().iter().any(|(n, _)| *n == {})", t[0], t[1]),
        "without" => {
            let names = t[1..].join(", ");
            format!(
                "{{ let names = [{names}]; js::Attrs::new({}.entries().iter().filter(|(n, _)| !names.contains(n)).cloned().collect()) }}",
                t[0]
            )
        }
        "merge-props" => {
            let bags: String = t
                .iter()
                .map(|b| {
                    format!(
                        "{b}.entries().iter().map(|(n, v)| (n.to_rust(), v.clone())).collect::<Vec<_>>(), "
                    )
                })
                .collect();
            let failed = cx.q("Err::<(), _>(js::Throw::new(\"RunicUnsupportedError\", m))");
            format!(
                "match js::merge_props(&[{bags}], &MergeBags) {{ Ok(v) => js::Attrs::new(v.into_iter().map(|(n, v)| (JsString::from(n), v)).collect()), Err(m) => {{ runic_runtime::unsupported(&m); {failed}; unreachable!() }} }}"
            )
        }
        "get" => {
            let Type::Maybe(inner) = ty else {
                unreachable!("validated attrs.get type")
            };
            let bad = mismatch(cx, "a prop");
            let convert = match &**inner {
                Type::String => "js::AttrValue::Text(s) => Maybe::Some(s.clone()),".to_string(),
                Type::Boolean => "js::AttrValue::Flag(b) => Maybe::Some(*b),".to_string(),
                Type::Fn(f) => {
                    let target = rust_type(inner);
                    let params: String = f
                        .params
                        .iter()
                        .enumerate()
                        .map(|(i, p)| format!(", x{i}: {}", rust_type(p)))
                        .collect();
                    let args: String = (0..f.params.len())
                        .map(|i| format!("Rc::new(x{i}) as Rc<dyn std::any::Any>, "))
                        .collect();
                    let result = match &*f.result {
                        Type::Void => "{ let _ = r; Ok(()) }".to_string(),
                        Type::Maybe(i) => format!(
                            "match (r.downcast_ref::<{}>(), r.downcast_ref::<{}>(), r.downcast_ref::<()>()) {{ (Some(v), _, _) => Ok(v.clone()), (_, Some(v), _) => Ok(Maybe::Some(v.clone())), (_, _, Some(_)) => Ok(Maybe::Undefined), _ => Err(erased_mismatch()) }}",
                            rust_type(&f.result),
                            rust_type(i)
                        ),
                        other => format!("erased_result::<{}>(r)", rust_type(other)),
                    };
                    let rt = rust_type(&f.result);
                    let callback = format!(
                        "js::AttrValue::Callback(_, g) => {{ let g = g.downcast_ref::<Erased>().expect(\"erased callback\").clone(); let h: {target} = Rc::new(move |cx: &mut Cx{params}| -> JsResult<{rt}> {{ let r = g(cx, vec![{args}])?; {result} }}); Maybe::Some(h) }}"
                    );
                    // An event listener becomes a function of the event.
                    let listener = if f.params == [Type::Event] && *f.result == Type::Void {
                        format!(
                            "js::AttrValue::Listener(_, b) => {{ let b = b.clone(); let h: {target} = Rc::new(move |cx: &mut Cx, e: js::Event| -> JsResult<()> {{ b(cx, e) }}); Maybe::Some(h) }}"
                        )
                    } else {
                        String::new()
                    };
                    format!("{callback}\n{listener}")
                }
                other => unreachable!("validated attrs.get type {other:?}"),
            };
            format!(
                "{{ let name = {}; let b = {}; let found = b.resolved().into_iter().find(|(n, _)| **n == name).map(|(_, v)| v.clone()); match &found {{ None | Some(js::AttrValue::Absent) => Maybe::Undefined, Some(js::AttrValue::Null) => Maybe::Null, Some(v) => match v {{ {convert} _ => {{ {bad}; unreachable!() }} }} }} }}",
                t[1], t[0]
            )
        }
        other => unreachable!("validated attrs built-in {other}"),
    }
}

/// Whether a declared match result has `string` elements (every capture
/// declared present): captures convert with `js::regexp::present`.
fn present_strings(ty: &Type) -> bool {
    match ty {
        Type::Maybe(a) | Type::Array(a) => match &**a {
            Type::Array(e) => **e == Type::String,
            Type::String => true,
            _ => false,
        },
        _ => false,
    }
}

/// Date objects and time values (`js::date`).
fn date(cx: &FnCtx, m: &str, t: &[String]) -> String {
    let d = "js::date";
    match m {
        "new" => format!("js::Date::new({})", t[0]),
        "local" => format!("{d}::local_time_value({})", t.join(", ")),
        "utc" => format!("{d}::utc_time_value({})", t.join(", ")),
        "parse" => format!("{d}::parse(&{})", t[0]),
        "getTime" => format!("{}.time()", t[0]),
        "toString" => format!("{d}::to_string({}.time())", t[0]),
        "toDateString" => format!("{d}::to_date_string_local({}.time())", t[0]),
        "toTimeString" => format!("{d}::to_time_string({}.time())", t[0]),
        "toUTCString" => format!("{d}::to_utc_string({}.time())", t[0]),
        "toISOString" => cx.q(&format!("{d}::to_iso_string({}.time())", t[0])),
        "toJSON" => format!(
            "{d}::to_json({}.time()).map_or(Maybe::Null, Maybe::Some)",
            t[0]
        ),
        m if m.starts_with("set") => format!("{}.set({m:?}, &[{}])", t[0], t[1..].join(", ")),
        m => format!("{d}::get({}.time(), {m:?})", t[0]),
    }
}

/// Formatting and collation (`js::intl`): the option string is parsed once.
fn intl(cx: &FnCtx, m: &str, t: &[String], args: &[Expr]) -> String {
    let operands = if m == "compare" { 2 } else { 1 };
    let Some(Expr::Lit {
        value: runic_ir::Value::String(spec),
    }) = args.get(operands)
    else {
        unreachable!("validated intl options")
    };
    let kind = match m {
        "format-date" => "DateSpec",
        "format-number" => "NumberSpec",
        _ => "CollatorSpec",
    };
    let spec = format!(
        "{{ static SPEC: std::sync::LazyLock<js::intl::{kind}> = std::sync::LazyLock::new(|| js::intl::{kind}::parse({spec:?}).expect(\"validated options\")); &*SPEC }}"
    );
    let locale = t
        .get(operands + 1)
        .map_or("None".to_string(), |l| format!("Some(&{l})"));
    let call = match m {
        "format-date" => format!("js::intl::format_date({}, {spec}, {locale})", t[0]),
        "format-number" => format!("js::intl::format_number({}, {spec}, {locale})", t[0]),
        _ => format!("js::intl::compare(&{}, &{}, {spec}, {locale})", t[0], t[1]),
    };
    format!("{{ let _ = &{}; {} }}", t[operands], cx.q(&call))
}

fn regexp(cx: &FnCtx, m: &str, t: &[String], ty: &Type) -> String {
    let r = &t[0];
    match m {
        "new" => cx.q(&format!("js::RegExp::new(&{}, &{})", t[0], t[1])),
        "source" => format!("{r}.source()"),
        "flags" => format!("{r}.flags_string()"),
        "toString" => format!("js::ToJsString::to_js_string(&{r})"),
        "global" => format!("{r}.flags().global"),
        "ignoreCase" => format!("{r}.flags().ignore_case"),
        "multiline" => format!("{r}.flags().multiline"),
        "dotAll" => format!("{r}.flags().dot_all"),
        "unicode" => format!("{r}.flags().unicode"),
        "unicodeSets" => format!("{r}.flags().unicode_sets"),
        "sticky" => format!("{r}.flags().sticky"),
        "hasIndices" => format!("{r}.flags().has_indices"),
        "lastIndex" => format!("{r}.last_index()"),
        "set-lastIndex" => format!("{{ {r}.set_last_index({}); }}", t[1]),
        "test" => format!("{r}.test(&{})", t[1]),
        "exec" if present_strings(ty) => {
            cx.q(&format!("{r}.exec_with(&{}, js::regexp::present)", t[1]))
        }
        "exec" => format!("{r}.exec(&{})", t[1]),
        other => unreachable!("validated RegExp member {other}"),
    }
}

/// String methods with a RegExp argument (`js::regexp`).
fn string_regexp(
    cx: &FnCtx,
    m: &str,
    t: &[String],
    types: &[Type],
    ty: &Type,
    args: &[Expr],
) -> String {
    let (s, re) = (&t[0], &t[1]);
    let rx = "js::regexp";
    let conv = if present_strings(ty) {
        "js::regexp::present"
    } else {
        "Ok"
    };
    match m {
        "regexp-replace" | "regexp-replaceAll" => {
            let all = m == "regexp-replaceAll";
            match (&types[2], args.get(3)) {
                (Type::String, _) if all => {
                    cx.q(&format!("{rx}::replace_all(&{s}, &{re}, &{})", t[2]))
                }
                (Type::String, _) => format!("{rx}::replace(&{s}, &{re}, &{})", t[2]),
                (
                    Type::Fn(sig),
                    Some(Expr::Lit {
                        value: runic_ir::Value::Number(n),
                    }),
                ) => {
                    let n = *n as usize;
                    let call_args: String = sig
                        .params
                        .iter()
                        .enumerate()
                        .map(|(i, p)| {
                            let arg = if i == n + 1 {
                                "pos".to_string()
                            } else if i == n + 2 {
                                "input.clone()".to_string()
                            } else if *p == Type::String {
                                format!("js::regexp::present(caps[{i}].clone())?")
                            } else {
                                format!("caps[{i}].clone()")
                            };
                            format!(", {arg}")
                        })
                        .collect();
                    let which = if all {
                        "replace_all_with"
                    } else {
                        "replace_with"
                    };
                    format!(
                        "{{ let f = {}; {} }}",
                        t[2],
                        cx.q(&format!(
                            "{rx}::{which}(&{s}, &{re}, |caps: &[Maybe<JsString>], pos: f64, input: &JsString| -> JsResult<JsString> {{ let _ = (&caps, &pos, &input); f(cx{call_args}) }})"
                        ))
                    )
                }
                _ => unreachable!("validated replacement"),
            }
        }
        "regexp-match" if conv == "Ok" => format!("{rx}::match_(&{s}, &{re})"),
        "regexp-match" => cx.q(&format!("{rx}::match_with(&{s}, &{re}, {conv})")),
        "regexp-matchAll" => cx.q(&format!("{rx}::match_all_with(&{s}, &{re}, {conv})")),
        "regexp-search" => format!("{rx}::search(&{s}, &{re})"),
        "regexp-split" => cx.q(&format!(
            "{rx}::split_with(&{s}, &{re}, {}, {conv})",
            opt_num(t.get(2))
        )),
        other => unreachable!("validated string method {other}"),
    }
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
            let f = effect_adapter(&types[1], &t[1], a);
            cx.q(&format!("{ar}::for_each(&{a}, {f})"))
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

/// A `maybe<number>` value as an `Option<f64>`.
fn opt_number(v: &str) -> String {
    format!("(match {v} {{ Maybe::Some(n) => Some(n), _ => None }})")
}
