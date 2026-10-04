//! The built-in catalogue: names and type signatures. The interpreter
//! (`interp.rs`) and the code generator implement each name with the shared
//! `runic-js` semantics. Optional arguments may be omitted by the frontend.

use crate::{RecordType, Type};

type R = std::result::Result<Type, String>;

const MATH_UNARY: &[&str] = &[
    "abs", "acos", "acosh", "asin", "asinh", "atan", "atanh", "cbrt", "ceil", "clz32", "cos",
    "cosh", "exp", "expm1", "floor", "fround", "log", "log10", "log1p", "log2", "round", "sign",
    "sin", "sinh", "sqrt", "tan", "tanh", "trunc",
];
const MATH_BINARY: &[&str] = &["atan2", "imul", "pow"];
const MATH_VARIADIC: &[&str] = &["min", "max", "hypot"];
const MATH_CONSTANTS: &[&str] = &[
    "PI", "E", "LN2", "LN10", "LOG2E", "LOG10E", "SQRT1_2", "SQRT2",
];
const NUMBER_CONSTANTS: &[&str] = &[
    "MAX_SAFE_INTEGER",
    "MIN_SAFE_INTEGER",
    "EPSILON",
    "MAX_VALUE",
    "MIN_VALUE",
    "POSITIVE_INFINITY",
    "NEGATIVE_INFINITY",
    "NaN",
];
/// The fields of `getBoundingClientRect()`'s record, in order.
pub const DOM_RECT: [&str; 8] = [
    "x", "y", "width", "height", "top", "right", "bottom", "left",
];
/// Element metrics read from the native layout (CSSOM View).
pub const ELEMENT_METRICS: &[&str] = &[
    "offsetWidth",
    "offsetHeight",
    "offsetLeft",
    "offsetTop",
    "clientWidth",
    "clientHeight",
    "clientLeft",
    "clientTop",
    "scrollWidth",
    "scrollHeight",
    "scrollTop",
    "scrollLeft",
];
/// Window metrics: the viewport size and its scroll position.
pub const WINDOW_METRICS: &[&str] = &["innerWidth", "innerHeight", "scrollX", "scrollY"];

/// Whether built-in `name` reads or changes the native layout (the
/// interpreter has none: programs using them are compared against the
/// browser only).
pub fn needs_layout(name: &str) -> bool {
    match name.split_once('.') {
        Some(("element", m)) => {
            m == "getBoundingClientRect"
                || ELEMENT_METRICS.contains(&m)
                || matches!(
                    m,
                    "set-scrollTop" | "set-scrollLeft" | "scrollTo" | "scrollBy" | "scrollIntoView"
                )
        }
        Some(("window", m)) => WINDOW_METRICS.contains(&m) || matches!(m, "scrollTo" | "scrollBy"),
        _ => false,
    }
}

fn arity(args: &[Type], min: usize, max: usize) -> std::result::Result<(), std::string::String> {
    if args.len() < min || args.len() > max {
        Err(format!(
            "expects {min}..={max} arguments, got {}",
            args.len()
        ))
    } else {
        Ok(())
    }
}

fn expect(t: &Type, want: &Type, what: &str) -> std::result::Result<(), std::string::String> {
    if t == want {
        Ok(())
    } else {
        Err(format!(
            "{what} must be {}, found {}",
            want.name(),
            t.name()
        ))
    }
}

fn all(args: &[Type], want: &Type) -> std::result::Result<(), std::string::String> {
    args.iter().try_for_each(|a| expect(a, want, "argument"))
}

/// Primitive (or nullable primitive) values that convert with ToString/ToNumber.
fn primitive(t: &Type) -> bool {
    match t {
        Type::Number | Type::String | Type::Boolean => true,
        Type::Maybe(inner) => primitive(inner),
        _ => false,
    }
}

fn stringable(t: &Type) -> bool {
    match t {
        Type::Number
        | Type::String
        | Type::Boolean
        | Type::Array(_)
        | Type::Record(_)
        | Type::Regexp
        | Type::Date => true,
        Type::Maybe(inner) => stringable(inner),
        _ => false,
    }
}

/// A callback `(params ⊆ allowed) => result`.
fn callback<'a>(
    t: &'a Type,
    allowed: &[Type],
    what: &str,
) -> std::result::Result<&'a Type, String> {
    let Type::Fn(f) = t else {
        return Err(format!("{what} must be a function"));
    };
    if f.params.len() > allowed.len() {
        return Err(format!("{what} takes too many parameters"));
    }
    for (p, a) in f.params.iter().zip(allowed) {
        if p != a {
            return Err(format!(
                "{what} parameter must be {}, found {}",
                a.name(),
                p.name()
            ));
        }
    }
    Ok(&f.result)
}

fn element(t: &Type) -> std::result::Result<&Type, String> {
    match t {
        Type::Array(e) => Ok(e),
        other => Err(format!("receiver must be an array, found {}", other.name())),
    }
}

/// JSON-serialisable types.
pub fn json_compatible(t: &Type, records: &[RecordType], depth: usize) -> bool {
    if depth > 32 {
        return true;
    }
    match t {
        Type::Number | Type::String | Type::Boolean => true,
        Type::Maybe(inner) | Type::Array(inner) => json_compatible(inner, records, depth + 1),
        Type::Record(r) => records.get(*r).is_some_and(|rec| {
            rec.fields
                .iter()
                .all(|f| json_compatible(&f.ty, records, depth + 1))
        }),
        _ => false,
    }
}

fn error_type(t: &Type, records: &[RecordType]) -> bool {
    matches!(t, Type::Record(r) if records.get(*r).is_some_and(crate::validate::is_error_record))
}

/// The type a handler's result settles to (`U` for `U` or `Promise<U>`).
fn settles_to(t: &Type) -> Type {
    match t {
        Type::Promise(u) => (**u).clone(),
        other => other.clone(),
    }
}

fn promise_type(method: &str, args: &[Type], declared: &Type, records: &[RecordType]) -> R {
    use Type::*;
    let promise_of = |t: &Type| -> std::result::Result<Type, std::string::String> {
        match t {
            Promise(v) => Ok((**v).clone()),
            other => Err(format!("expected a promise, found {}", other.name())),
        }
    };
    let handler = |f: &Type,
                   param: Option<&Type>,
                   what: &str|
     -> std::result::Result<Type, std::string::String> {
        match f {
            Fn(f)
                if f.params.is_empty() || (f.params.len() == 1 && Some(&f.params[0]) == param) =>
            {
                Ok(settles_to(&f.result))
            }
            other => Err(format!(
                "{what} handler has the wrong type {}",
                other.name()
            )),
        }
    };
    let error = Record(
        records
            .iter()
            .position(crate::validate::is_error_record)
            .unwrap_or(usize::MAX),
    );
    match method {
        // new Promise(executor): executor(resolve, reject?) runs synchronously.
        "new" => {
            arity(args, 1, 1)?;
            let Fn(exec) = &args[0] else {
                return Err("the executor must be a function".into());
            };
            let Some(Fn(resolve)) = exec.params.first() else {
                return Err("the executor takes a resolve function".into());
            };
            let [value] = resolve.params.as_slice() else {
                return Err("resolve takes one value".into());
            };
            if let Some(reject) = exec.params.get(1) {
                if !matches!(reject, Fn(r) if r.params.len() == 1 && error_type(&r.params[0], records))
                {
                    return Err("reject takes an Error".into());
                }
            }
            Ok(Promise(Box::new(value.clone())))
        }
        "resolve" => {
            arity(args, 1, 1)?;
            Ok(Promise(Box::new(settles_to(&args[0]))))
        }
        "reject" => {
            arity(args, 1, 1)?;
            if !error_type(&args[0], records) {
                return Err("promises reject with Error values".into());
            }
            match declared {
                Promise(_) => Ok(declared.clone()),
                _ => Err("Promise.reject needs a declared promise type".into()),
            }
        }
        // then(p, onFulfilled) and then(p, onFulfilled, onRejected): both
        // handlers settle to the same type.
        "then" => {
            arity(args, 2, 3)?;
            let t = promise_of(&args[0])?;
            let u = handler(&args[1], Some(&t), "fulfilment")?;
            if let Some(r) = args.get(2) {
                if handler(r, Some(&error), "rejection")? != u {
                    return Err("both handlers must settle to the same type".into());
                }
            }
            Ok(Promise(Box::new(u)))
        }
        // A promise that never fulfils (Promise<void> from Promise.reject)
        // settles to the handler's type.
        "catch" => {
            arity(args, 2, 2)?;
            let t = promise_of(&args[0])?;
            let u = handler(&args[1], Some(&error), "rejection")?;
            if u == t {
                return Ok(args[0].clone());
            }
            // Promise<void>: a fulfilment passes on as undefined (Maybe<U>), or
            // never happens (Promise.reject, U).
            match declared {
                Promise(x) if t == Void && (**x == u || **x == Maybe(Box::new(u.clone()))) => {
                    Ok(declared.clone())
                }
                _ => Err("a catch handler settles to the promise's type".into()),
            }
        }
        "finally" => {
            arity(args, 2, 2)?;
            promise_of(&args[0])?;
            match &args[1] {
                Fn(f) if f.params.is_empty() => Ok(args[0].clone()),
                other => Err(format!(
                    "finally takes a function without parameters, found {}",
                    other.name()
                )),
            }
        }
        // Promise.all over an array of promises of one type.
        "all" => {
            arity(args, 1, 1)?;
            match &args[0] {
                Array(p) => Ok(Promise(Box::new(Array(Box::new(promise_of(p)?))))),
                other => Err(format!(
                    "Promise.all takes an array of promises, found {}",
                    other.name()
                )),
            }
        }
        // The promise of an async function (frontend/async.ts): created
        // pending, then fulfilled, adopting another promise or rejected.
        "pending" => {
            arity(args, 0, 0)?;
            match declared {
                Promise(_) => Ok(declared.clone()),
                _ => Err("a pending promise needs a declared type".into()),
            }
        }
        "fulfil" => {
            arity(args, 2, 2)?;
            let t = promise_of(&args[0])?;
            expect(&args[1], &t, "value").map(|_| Void)
        }
        "adopt" => {
            arity(args, 2, 2)?;
            promise_of(&args[0])?;
            expect(&args[1], &args[0], "promise").map(|_| Void)
        }
        "fail" => {
            arity(args, 2, 2)?;
            promise_of(&args[0])?;
            if !error_type(&args[1], records) {
                return Err("promises reject with Error values".into());
            }
            Ok(Void)
        }
        other => Err(format!("unknown promise operation {other}")),
    }
}

/// The result type of builtin `name` applied to `args`, given the frontend's
/// declared result type `declared` (used where the result is not determined
/// by the arguments, e.g. `JSON.parse`).
pub fn result_type(name: &str, args: &[Type], declared: &Type, records: &[RecordType]) -> R {
    use Type::*;
    let n = Number;
    let s = String;
    let b = Boolean;
    let (ns, method) = name.split_once('.').unwrap_or(("", name));
    match (ns, method) {
        ("Math", m) if MATH_CONSTANTS.contains(&m) => arity(args, 0, 0).map(|_| n),
        // Timers and clocks (M4): callbacks are function values; ids are numbers.
        // Callback results are ignored; frame callbacks may omit the time.
        ("timer", "timeout" | "interval") => {
            arity(args, 2, 2)?;
            match &args[0] {
                Fn(f) if f.params.is_empty() => {}
                other => {
                    return Err(format!(
                        "callback must take no arguments, found {}",
                        other.name()
                    ));
                }
            }
            expect(&args[1], &n, "delay").map(|_| n)
        }
        ("timer", "frame") => {
            arity(args, 1, 1)?;
            match &args[0] {
                Fn(f) if f.params.is_empty() || f.params == [Number] => Ok(n),
                other => Err(format!(
                    "callback must take the frame time, found {}",
                    other.name()
                )),
            }
        }
        ("timer", "clear") => {
            arity(args, 1, 1)?;
            expect(&args[0], &n, "id").map(|_| Void)
        }
        ("clock", "now" | "date") => arity(args, 0, 0).map(|_| n),
        // Dates and Intl (M5): Date objects, time values and formatting.
        ("date", m) => date_type(m, args),
        ("intl", m) => intl_type(m, args),
        // Promises (docs/design/M4-EFFECTS.md): handlers return a value or a
        // promise of it; rejections are Error records.
        ("promise", _) => promise_type(method, args, declared, records),
        // localStorage: string keys and values; a missing key reads null.
        ("storage", "get") => {
            arity(args, 1, 1)?;
            expect(&args[0], &s, "key").map(|_| Maybe(Box::new(s)))
        }
        ("storage", "set") => {
            arity(args, 2, 2)?;
            all(args, &s).map(|_| Void)
        }
        ("storage", "remove") => {
            arity(args, 1, 1)?;
            expect(&args[0], &s, "key").map(|_| Void)
        }
        ("storage", "clear") => arity(args, 0, 0).map(|_| Void),
        // Host services (M5, docs/design/M5-PLATFORM.md). Console lines join
        // their arguments' ToString with spaces, as Chromium's message text.
        ("console", "log" | "info" | "warn" | "error" | "debug") => {
            if args.is_empty() {
                return Err("console calls take at least one argument".into());
            }
            if args.iter().all(primitive) {
                Ok(Void)
            } else {
                Err(
                    "console arguments must be strings, numbers, booleans, null or undefined"
                        .into(),
                )
            }
        }
        // navigator.clipboard: the promise settles in a later task.
        ("clipboard", "write") => {
            arity(args, 1, 1)?;
            expect(&args[0], &s, "text").map(|_| Promise(Box::new(Void)))
        }
        ("clipboard", "read") => arity(args, 0, 0).map(|_| Promise(Box::new(s))),
        // Session history: pushState/replaceState with an optional URL (the
        // state is null), traversals by a literal delta, the entry count.
        ("history", "push" | "replace") => {
            arity(args, 0, 1)?;
            match args.first() {
                None | Some(String) => Ok(Void),
                Some(Maybe(t)) if **t == String => Ok(Void),
                Some(other) => Err(format!("the URL must be a string, found {}", other.name())),
            }
        }
        ("history", "back" | "forward") => arity(args, 0, 0).map(|_| Void),
        ("history", "go") => {
            arity(args, 1, 1)?;
            expect(&args[0], &n, "delta").map(|_| Void)
        }
        ("history", "length") => arity(args, 0, 0).map(|_| n),
        ("location", "pathname" | "search" | "hash") => arity(args, 0, 0).map(|_| s),
        ("location", "set-hash") => {
            arity(args, 1, 1)?;
            expect(&args[0], &s, "hash").map(|_| Void)
        }
        // Math.random() and crypto.randomUUID().
        ("random", "number") => arity(args, 0, 0).map(|_| n),
        ("random", "uuid") => arity(args, 0, 0).map(|_| s),
        // Framework flush timing: `tick` is a microtask that runs any
        // pending flush, then fulfils; `after` fulfils when the pending (or
        // running) flush ends, or is fulfilled already.
        ("flush", "tick" | "after") => arity(args, 0, 0).map(|_| Promise(Box::new(Void))),
        // The document element (docs/design/M5-PLATFORM.md): attributes,
        // class list and inline style.
        ("root", m) => {
            let strings = |k: usize| -> std::result::Result<(), std::string::String> {
                arity(args, k, k)?;
                args.iter().try_for_each(|a| expect(a, &s, "argument"))
            };
            match m {
                "get-attr" => strings(1).map(|_| Maybe(Box::new(s))),
                "set-attr" | "style-set" => strings(2).map(|_| Void),
                "remove-attr" | "class-add" | "class-remove" => strings(1).map(|_| Void),
                "class-contains" => strings(1).map(|_| b),
                "style-remove" | "style-get" => strings(1).map(|_| s),
                "class-toggle" => {
                    arity(args, 1, 2)?;
                    expect(&args[0], &s, "token")?;
                    if let Some(f) = args.get(1) {
                        expect(f, &b, "force")?;
                    }
                    Ok(b)
                }
                other => Err(format!("unknown document element operation {other}")),
            }
        }
        // matchMedia(query).matches (the query is a literal, checked by the validator).
        ("media", "matches") => {
            arity(args, 1, 1)?;
            expect(&args[0], &s, "query").map(|_| b)
        }
        // MediaQueryList objects: matches (evaluated now) and change listeners.
        ("media", "query") => {
            arity(args, 1, 1)?;
            expect(&args[0], &s, "query").map(|_| MediaQuery)
        }
        ("media-query", "matches") => {
            arity(args, 1, 1)?;
            expect(&args[0], &MediaQuery, "receiver").map(|_| b)
        }
        ("media-query", "listen" | "unlisten") => {
            arity(args, 2, 2)?;
            expect(&args[0], &MediaQuery, "receiver")?;
            match &args[1] {
                Fn(f) if f.params.is_empty() || f.params == [Event] => Ok(Void),
                other => Err(format!(
                    "listener must take the event or nothing, found {}",
                    other.name()
                )),
            }
        }
        // Window and document listeners: the event kind (a literal, checked by
        // the validator) and a listener taking the event or nothing.
        ("window" | "document", "listen" | "unlisten") => {
            arity(args, 2, 2)?;
            expect(&args[0], &s, "event kind")?;
            match &args[1] {
                Fn(f) if f.params.is_empty() || f.params == [Event] => Ok(Void),
                other => Err(format!(
                    "listener must take the event or nothing, found {}",
                    other.name()
                )),
            }
        }
        // Event objects (docs/design/M5-PLATFORM.md).
        ("event", m) => {
            arity(args, 1, 1)?;
            expect(&args[0], &Event, "event")?;
            match m {
                "type" | "key" | "code" | "value" => Ok(s),
                "ctrlKey" | "shiftKey" | "altKey" | "metaKey" | "repeat" | "checked"
                | "defaultPrevented" | "matches" => Ok(b),
                "clientX" | "clientY" | "button" | "buttons" | "deltaX" | "deltaY" => Ok(n),
                "target" => Ok(Element),
                "relatedTarget" => Ok(Maybe(Box::new(Element))),
                // Null once the dispatch is over.
                "currentTarget" => Ok(Maybe(Box::new(Element))),
                "preventDefault" | "stopPropagation" | "stopImmediatePropagation" => Ok(Void),
                other => Err(format!("unknown event member {other}")),
            }
        }
        ("microtask", "queue") => {
            arity(args, 1, 1)?;
            match &args[0] {
                Fn(f) if f.params.is_empty() => Ok(Void),
                other => Err(format!(
                    "callback must take no arguments, found {}",
                    other.name()
                )),
            }
        }
        ("element", "focus" | "blur") => {
            arity(args, 1, 1)?;
            expect(&args[0], &Element, "receiver").map(|_| Void)
        }
        // Layout reads and scrolling (CSSOM View): they read the native
        // layout, which the interpreter does not have.
        ("element", "getBoundingClientRect") => {
            arity(args, 1, 1)?;
            expect(&args[0], &Element, "receiver")?;
            match declared {
                Record(r)
                    if records.get(*r).is_some_and(|r| {
                        r.fields.len() == DOM_RECT.len()
                            && r.fields
                                .iter()
                                .zip(DOM_RECT)
                                .all(|(f, name)| f.name == name && f.ty == Number)
                    }) =>
                {
                    Ok(declared.clone())
                }
                other => Err(format!(
                    "getBoundingClientRect returns a record of {}, found {}",
                    DOM_RECT.join(", "),
                    other.name()
                )),
            }
        }
        ("element", m) if ELEMENT_METRICS.contains(&m) => {
            arity(args, 1, 1)?;
            expect(&args[0], &Element, "receiver").map(|_| n)
        }
        ("element", "set-scrollTop" | "set-scrollLeft") => {
            arity(args, 2, 2)?;
            expect(&args[0], &Element, "receiver")?;
            expect(&args[1], &n, "scroll offset").map(|_| Void)
        }
        // Coordinates left and top; an absent one keeps (scrollTo) or does not
        // move (scrollBy) that axis.
        ("element", "scrollTo" | "scrollBy") => {
            arity(args, 3, 3)?;
            expect(&args[0], &Element, "receiver")?;
            for a in &args[1..] {
                expect(a, &Maybe(Box::new(n.clone())), "coordinate")?;
            }
            Ok(Void)
        }
        // Block and inline alignment (literals, checked by the validator).
        ("element", "scrollIntoView") => {
            arity(args, 3, 3)?;
            expect(&args[0], &Element, "receiver")?;
            all(&args[1..], &s).map(|_| Void)
        }
        ("window", m) if WINDOW_METRICS.contains(&m) => arity(args, 0, 0).map(|_| n),
        ("window", "scrollTo" | "scrollBy") => {
            arity(args, 2, 2)?;
            for a in args {
                expect(a, &Maybe(Box::new(n.clone())), "coordinate")?;
            }
            Ok(Void)
        }
        ("Math", m) if MATH_UNARY.contains(&m) => {
            arity(args, 1, 1)?;
            all(args, &n).map(|_| n)
        }
        ("Math", m) if MATH_BINARY.contains(&m) => {
            arity(args, 2, 2)?;
            all(args, &n).map(|_| n)
        }
        ("Math", m) if MATH_VARIADIC.contains(&m) => all(args, &n).map(|_| n),
        ("Number", m) if NUMBER_CONSTANTS.contains(&m) => arity(args, 0, 0).map(|_| n),
        ("Number", "isNaN" | "isFinite" | "isInteger" | "isSafeInteger") => {
            arity(args, 1, 1)?;
            all(args, &n).map(|_| b)
        }
        ("Number", "parseFloat") | ("", "parseFloat") => {
            arity(args, 1, 1)?;
            expect(&args[0], &s, "argument").map(|_| n)
        }
        ("Number", "parseInt") | ("", "parseInt") => {
            arity(args, 1, 2)?;
            expect(&args[0], &s, "argument")?;
            if let Some(r) = args.get(1) {
                expect(r, &n, "radix")?;
            }
            Ok(n)
        }
        ("", "isNaN" | "isFinite") => {
            arity(args, 1, 1)?;
            if primitive(&args[0]) {
                Ok(b)
            } else {
                Err("argument must be primitive".into())
            }
        }
        ("", "String") => {
            arity(args, 0, 1)?;
            if args.first().is_none_or(stringable) {
                Ok(s)
            } else {
                Err("argument cannot be converted".into())
            }
        }
        ("", "Number") => {
            arity(args, 0, 1)?;
            // A Date converts through valueOf.
            if args
                .first()
                .is_none_or(|t| primitive(t) || *t == Type::Date)
            {
                Ok(n)
            } else {
                Err("argument must be primitive".into())
            }
        }
        ("", "Boolean") => arity(args, 0, 1).map(|_| b),
        ("", "structuredClone") => {
            arity(args, 1, 1)?;
            if json_compatible(&args[0], records, 0) || matches!(args[0], Map(..) | Set(_)) {
                Ok(args[0].clone())
            } else {
                Err("structuredClone supports plain data".into())
            }
        }
        ("number", m) => {
            let recv = args.first().ok_or("missing receiver")?;
            expect(recv, &n, "receiver")?;
            all(&args[1..], &n)?;
            match m {
                "toFixed" | "toString" | "toPrecision" | "toExponential" => {
                    arity(args, 1, 2).map(|_| s)
                }
                _ => Err(format!("unknown number method {m}")),
            }
        }
        // Regular expressions: RegExp objects, the String methods taking
        // one, and the extra properties of match arrays.
        ("regexp", m) => regexp_type(m, args, declared),
        ("string", m) if m.starts_with("regexp-") => string_regexp_type(m, args, declared),
        ("match", m) => {
            let a = args.first().ok_or("missing match array")?;
            if !match_array(a) {
                return Err(format!("{} is not a match array", a.name()));
            }
            match m {
                "index" => arity(args, 1, 1).map(|_| Type::maybe(n)),
                "input" => arity(args, 1, 1).map(|_| Type::maybe(s)),
                "has-groups" => arity(args, 1, 1).map(|_| b),
                "group" => {
                    arity(args, 2, 2)?;
                    expect(&args[1], &s, "group name").map(|_| Type::maybe(s))
                }
                other => Err(format!("unknown match array member {other}")),
            }
        }
        ("string", m) => string_method(m, args),
        ("array", m) => array_method(m, args, declared),
        ("Array", "from") => {
            arity(args, 1, 2)?;
            let items = match &args[0] {
                Array(t) | Set(t) => (**t).clone(),
                String => String,
                other => return Err(format!("Array.from over {} is unsupported", other.name())),
            };
            match args.get(1) {
                None => Ok(Type::array(items)),
                Some(f) => Ok(Type::array(
                    callback(f, &[items, n], "mapping function")?.clone(),
                )),
            }
        }
        ("Array", "isArray") => arity(args, 1, 1).map(|_| b),
        ("Array", "of") => match declared {
            Array(t) => all(args, t).map(|_| declared.clone()),
            _ => Err("Array.of needs an array type".into()),
        },
        ("Map", "new") => match declared {
            Map(..) => arity(args, 0, 0).map(|_| declared.clone()),
            _ => Err("Map constructor needs a Map type".into()),
        },
        ("Set", "new") => match declared {
            Set(t) => {
                arity(args, 0, 1)?;
                if let Some(a) = args.first() {
                    expect(a, &Type::array((**t).clone()), "initial items")?;
                }
                Ok(declared.clone())
            }
            _ => Err("Set constructor needs a Set type".into()),
        },
        ("map", m) => {
            let Some(Map(k, v)) = args.first() else {
                return Err("receiver must be a Map".into());
            };
            let (k, v) = ((**k).clone(), (**v).clone());
            match m {
                "get" => arity(args, 2, 2)
                    .and(expect(&args[1], &k, "key"))
                    .map(|_| Type::maybe(v)),
                "set" => {
                    arity(args, 3, 3)?;
                    expect(&args[1], &k, "key")?;
                    expect(&args[2], &v, "value")?;
                    Ok(args[0].clone())
                }
                "has" | "delete" => arity(args, 2, 2)
                    .and(expect(&args[1], &k, "key"))
                    .map(|_| b),
                "clear" => arity(args, 1, 1).map(|_| Void),
                "size" => arity(args, 1, 1).map(|_| n),
                "keys" => arity(args, 1, 1).map(|_| Type::array(k)),
                "values" => arity(args, 1, 1).map(|_| Type::array(v)),
                _ => Err(format!("unknown Map method {m}")),
            }
        }
        ("set", m) => {
            let Some(Set(t)) = args.first() else {
                return Err("receiver must be a Set".into());
            };
            let t = (**t).clone();
            match m {
                "add" => arity(args, 2, 2)
                    .and(expect(&args[1], &t, "value"))
                    .map(|_| args[0].clone()),
                "has" | "delete" => arity(args, 2, 2)
                    .and(expect(&args[1], &t, "value"))
                    .map(|_| b),
                "clear" => arity(args, 1, 1).map(|_| Void),
                "size" => arity(args, 1, 1).map(|_| n),
                "values" | "keys" => arity(args, 1, 1).map(|_| Type::array(t)),
                _ => Err(format!("unknown Set method {m}")),
            }
        }
        ("maybe", "is-null" | "is-undefined" | "is-nullish") => {
            arity(args, 1, 1)?;
            match &args[0] {
                Maybe(_) | Void => Ok(b),
                // TypeScript narrowing can make the operand non-nullable.
                _ => Ok(b),
            }
        }
        ("JSON", "stringify") => {
            arity(args, 1, 3)?;
            if !json_compatible(&args[0], records, 0) {
                return Err(format!("{} is not JSON-serialisable", args[0].name()));
            }
            if let Some(r) = args.get(1) {
                if !matches!(r, Maybe(_) | Void) {
                    return Err("replacer functions are unsupported".into());
                }
            }
            if let Some(space) = args.get(2) {
                if !matches!(space, Number | String) {
                    return Err("space must be a number or string".into());
                }
            }
            Ok(s)
        }
        ("JSON", "parse") => {
            arity(args, 1, 1)?;
            expect(&args[0], &s, "text")?;
            if json_compatible(declared, records, 0) {
                Ok(declared.clone())
            } else {
                Err("JSON.parse needs a declared JSON-compatible type".into())
            }
        }
        ("Object", "keys") => match args {
            [Record(_)] => Ok(Type::array(s)),
            _ => Err("Object.keys takes one record".into()),
        },
        ("Object", "values") => match args {
            [Record(r)] => {
                let rec = records.get(*r).ok_or("unknown record")?;
                let first = rec.fields.first().map(|f| f.ty.clone()).unwrap_or(Number);
                if rec.fields.iter().all(|f| f.ty == first) {
                    Ok(Type::array(first))
                } else {
                    Err("Object.values needs fields of one type".into())
                }
            }
            _ => Err("Object.values takes one record".into()),
        },
        _ => Err(format!("unknown builtin {name}")),
    }
}

/// A match array: captures are `maybe<string>`, or `string` where the
/// frontend proved that every capture participates in every match (a
/// capture that does not throws `TypeError`).
pub fn match_array(t: &Type) -> bool {
    matches!(t, Type::Array(e) if **e == Type::String || **e == Type::maybe(Type::String))
}

/// `exec`/`match` results: null or a match array (the declared form).
fn match_result(declared: &Type) -> R {
    match declared {
        Type::Maybe(a) if match_array(a) => Ok(declared.clone()),
        _ => Err("a match result is maybe<array<maybe<string>>> or maybe<array<string>>".into()),
    }
}

fn regexp_type(m: &str, args: &[Type], declared: &Type) -> R {
    use Type::*;
    if m == "new" {
        arity(args, 2, 2)?;
        return all(args, &String).map(|_| Regexp);
    }
    let recv = args.first().ok_or("missing receiver")?;
    expect(recv, &Regexp, "receiver")?;
    match m {
        "source" | "flags" | "toString" => arity(args, 1, 1).map(|_| String),
        "global" | "ignoreCase" | "multiline" | "dotAll" | "unicode" | "unicodeSets" | "sticky"
        | "hasIndices" => arity(args, 1, 1).map(|_| Boolean),
        "lastIndex" => arity(args, 1, 1).map(|_| Number),
        "set-lastIndex" => {
            arity(args, 2, 2)?;
            expect(&args[1], &Number, "lastIndex").map(|_| Void)
        }
        "test" => {
            arity(args, 2, 2)?;
            expect(&args[1], &String, "argument").map(|_| Boolean)
        }
        "exec" => {
            arity(args, 2, 2)?;
            expect(&args[1], &String, "argument")?;
            match_result(declared)
        }
        other => Err(format!("unknown RegExp member {other}")),
    }
}

/// `string.regexp-*`: String methods with a RegExp argument.
fn string_regexp_type(m: &str, args: &[Type], declared: &Type) -> R {
    use Type::*;
    let [recv, re, rest @ ..] = args else {
        return Err(format!("{m} takes a string and a RegExp"));
    };
    expect(recv, &String, "receiver")?;
    expect(re, &Regexp, "pattern")?;
    match m {
        // A replacement function takes the match, the captures, the position
        // and the string, in that order; the capture count (a literal) lets
        // the validator check their types.
        "regexp-replace" | "regexp-replaceAll" => match rest {
            [String] => Ok(String),
            [Fn(f), Number] => {
                if *f.result != String {
                    return Err("a replacement function returns a string".into());
                }
                if f.params.is_empty() || f.params[0] != String {
                    return Err("a replacement function takes the matched string first".into());
                }
                Ok(String)
            }
            _ => Err("the replacement is a string, or a function with the capture count".into()),
        },
        "regexp-match" => arity(rest, 0, 0).and(match_result(declared)),
        "regexp-matchAll" => {
            arity(rest, 0, 0)?;
            match declared {
                Array(a) if match_array(a) => Ok(declared.clone()),
                _ => Err("matchAll yields match arrays".into()),
            }
        }
        "regexp-search" => arity(rest, 0, 0).map(|_| Number),
        "regexp-split" => {
            arity(rest, 0, 1)?;
            if let Some(l) = rest.first() {
                expect(l, &Number, "limit")?;
            }
            if match_array(declared) {
                Ok(declared.clone())
            } else {
                Err("split with a RegExp returns string[] or (string | undefined)[]".into())
            }
        }
        other => Err(format!("unknown string method {other}")),
    }
}

/// `date.*`: Date objects (`new`, getters, setters, string forms) and time
/// value functions (`local`, `utc`, `parse`).
fn date_type(m: &str, args: &[Type]) -> R {
    use Type::*;
    match m {
        "new" => {
            arity(args, 1, 1)?;
            expect(&args[0], &Number, "time value").map(|_| Date)
        }
        "local" | "utc" => {
            arity(args, 7, 7)?;
            all(args, &Number).map(|_| Number)
        }
        "parse" => {
            arity(args, 1, 1)?;
            expect(&args[0], &String, "argument").map(|_| Number)
        }
        _ => {
            let recv = args.first().ok_or("missing receiver")?;
            expect(recv, &Date, "receiver")?;
            if m == "getTime" || runic_js::date::GETTERS.contains(&m) {
                return arity(args, 1, 1).map(|_| Number);
            }
            if let Some(&(_, min, max)) = runic_js::date::SETTERS.iter().find(|s| s.0 == m) {
                arity(&args[1..], min, max)?;
                return all(&args[1..], &Number).map(|_| Number);
            }
            match m {
                "toString" | "toDateString" | "toTimeString" | "toUTCString" | "toISOString" => {
                    arity(args, 1, 1).map(|_| String)
                }
                "toJSON" => arity(args, 1, 1).map(|_| Type::maybe(String)),
                other => Err(format!("unknown Date member {other}")),
            }
        }
    }
}

/// `intl.*`: formatting and collation with a literal option string and an
/// optional runtime locale.
fn intl_type(m: &str, args: &[Type]) -> R {
    use Type::*;
    let (operands, result) = match m {
        "format-date" | "format-number" => (1, String),
        "compare" => (2, Number),
        other => return Err(format!("unknown intl member {other}")),
    };
    arity(args, operands + 1, operands + 2)?;
    let operand = if m == "compare" { String } else { Number };
    all(&args[..operands], &operand)?;
    expect(&args[operands], &String, "options")?;
    if let Some(l) = args.get(operands + 1) {
        expect(l, &String, "locale")?;
    }
    Ok(result)
}

fn string_method(m: &str, args: &[Type]) -> R {
    use Type::*;
    let s = String;
    let n = Number;
    let recv = args.first().ok_or("missing receiver")?;
    expect(recv, &s, "receiver")?;
    let rest = &args[1..];
    let typed = |want: &[Type], min: usize| -> std::result::Result<(), std::string::String> {
        if rest.len() < min || rest.len() > want.len() {
            return Err(format!("{m} expects {min}..={} arguments", want.len()));
        }
        rest.iter()
            .zip(want)
            .try_for_each(|(a, w)| expect(a, w, "argument"))
    };
    match m {
        "at" | "index" => typed(&[n.clone()], 1).map(|_| Type::maybe(s)),
        "charAt" => typed(&[n.clone()], 0).map(|_| s),
        "charCodeAt" => typed(&[n.clone()], 0).map(|_| n),
        "codePointAt" => typed(&[n.clone()], 0).map(|_| Type::maybe(n)),
        "slice" | "substring" => typed(&[n.clone(), n.clone()], 0).map(|_| s),
        "indexOf" | "lastIndexOf" => typed(&[s.clone(), n.clone()], 1).map(|_| n),
        "includes" | "startsWith" | "endsWith" => {
            typed(&[s.clone(), n.clone()], 1).map(|_| Boolean)
        }
        "trim" | "trimStart" | "trimEnd" | "toUpperCase" | "toLowerCase" | "toString" => {
            typed(&[], 0).map(|_| s)
        }
        "padStart" | "padEnd" => typed(&[n.clone(), s.clone()], 1).map(|_| s),
        "repeat" => typed(&[n.clone()], 1).map(|_| s),
        "split" => typed(&[s.clone(), n.clone()], 0).map(|_| Type::array(s)),
        "replace" | "replaceAll" => typed(&[s.clone(), s.clone()], 2).map(|_| s),
        "concat" => rest
            .iter()
            .try_for_each(|a| expect(a, &s, "argument"))
            .map(|_| s),
        "localeCompare" => typed(&[s.clone()], 1).map(|_| n),
        "lt" | "le" | "gt" | "ge" => typed(&[s.clone()], 1).map(|_| Boolean),
        _ => Err(format!("unknown string method {m}")),
    }
}

fn array_method(m: &str, args: &[Type], declared: &Type) -> R {
    use Type::*;
    let n = Number;
    let recv = args.first().ok_or("missing receiver")?.clone();
    let t = element(&recv)?.clone();
    let rest = &args[1..];
    let opt_numbers = |from: usize, max: usize| -> std::result::Result<(), std::string::String> {
        if rest.len() > max {
            return Err(format!("{m} takes at most {max} arguments"));
        }
        rest.iter()
            .skip(from)
            .try_for_each(|a| expect(a, &n, "argument"))
    };
    let predicate = || -> std::result::Result<(), std::string::String> {
        let [f] = rest else {
            return Err(format!("{m} takes one callback"));
        };
        callback(f, &[t.clone(), n.clone(), recv.clone()], "callback").map(|_| ())
    };
    match m {
        "length" => arity(args, 1, 1).map(|_| n),
        "get" | "at" => arity(args, 2, 2)
            .and(expect(&args[1], &n, "index"))
            .map(|_| Type::maybe(t)),
        "push" | "unshift" => rest
            .iter()
            .try_for_each(|a| expect(a, &t, "item"))
            .map(|_| n),
        "pop" | "shift" => arity(args, 1, 1).map(|_| Type::maybe(t)),
        "slice" => opt_numbers(0, 2).map(|_| recv.clone()),
        "splice" => {
            if rest.is_empty() {
                return Err("splice needs a start".into());
            }
            expect(&rest[0], &n, "start")?;
            if let Some(d) = rest.get(1) {
                expect(d, &n, "delete count")?;
            }
            rest.iter()
                .skip(2)
                .try_for_each(|a| expect(a, &t, "item"))
                .map(|_| recv.clone())
        }
        "concat" => rest
            .iter()
            .try_for_each(|a| {
                if *a == recv || *a == t {
                    Ok(())
                } else {
                    Err("concat argument type".to_string())
                }
            })
            .map(|_| recv.clone()),
        "indexOf" | "lastIndexOf" | "includes" => {
            if rest.is_empty() || rest.len() > 2 {
                return Err(format!("{m} takes a value and an optional position"));
            }
            expect(&rest[0], &t, "value")?;
            if let Some(p) = rest.get(1) {
                expect(p, &n, "position")?;
            }
            Ok(if m == "includes" { Boolean } else { n })
        }
        "find" | "findLast" => predicate().map(|_| Type::maybe(t)),
        "findIndex" | "findLastIndex" => predicate().map(|_| n),
        "some" | "every" => predicate().map(|_| Boolean),
        "filter" => predicate().map(|_| recv.clone()),
        "forEach" => predicate().map(|_| Void),
        "map" => {
            let [f] = rest else {
                return Err("map takes one callback".into());
            };
            Ok(Type::array(
                callback(f, &[t.clone(), n.clone(), recv.clone()], "callback")?.clone(),
            ))
        }
        "flatMap" => {
            let [f] = rest else {
                return Err("flatMap takes one callback".into());
            };
            match callback(f, &[t.clone(), n.clone(), recv.clone()], "callback")? {
                Array(u) => Ok(Type::array((**u).clone())),
                other => Err(format!(
                    "flatMap callback must return an array, found {}",
                    other.name()
                )),
            }
        }
        "reduce" | "reduceRight" => match rest {
            [f] => {
                let r = callback(
                    f,
                    &[t.clone(), t.clone(), n.clone(), recv.clone()],
                    "reducer",
                )?;
                expect(r, &t, "reducer result").map(|_| t)
            }
            [f, init] => {
                let r = callback(
                    f,
                    &[init.clone(), t.clone(), n.clone(), recv.clone()],
                    "reducer",
                )?;
                expect(r, init, "reducer result").map(|_| init.clone())
            }
            _ => Err("reduce takes a reducer and an optional initial value".into()),
        },
        "join" => {
            arity(args, 1, 2)?;
            if let Some(sep) = rest.first() {
                expect(sep, &String, "separator")?;
            }
            Ok(String)
        }
        "reverse" | "toReversed" => arity(args, 1, 1).map(|_| recv.clone()),
        "sort" | "toSorted" => {
            if let Some(f) = rest.first() {
                expect(
                    callback(f, &[t.clone(), t.clone()], "comparator")?,
                    &n,
                    "comparator result",
                )?;
            }
            arity(args, 1, 2).map(|_| recv.clone())
        }
        "with" => {
            arity(args, 3, 3)?;
            expect(&rest[0], &n, "index")?;
            expect(&rest[1], &t, "value").map(|_| recv.clone())
        }
        "fill" => {
            if rest.is_empty() || rest.len() > 3 {
                return Err("fill takes a value and optional bounds".into());
            }
            expect(&rest[0], &t, "value")?;
            rest.iter()
                .skip(1)
                .try_for_each(|a| expect(a, &n, "bound"))
                .map(|_| recv.clone())
        }
        "flat" => match &t {
            Array(inner) => arity(args, 1, 1).map(|_| Type::array((**inner).clone())),
            _ => Err("flat needs an array of arrays".into()),
        },
        _ => {
            let _ = declared;
            Err(format!("unknown array method {m}"))
        }
    }
}
