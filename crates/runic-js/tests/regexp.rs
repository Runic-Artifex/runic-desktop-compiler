//! RegExp differential tests: `runic_js::regexp` against vectors that Node
//! computed (tests/vectors/regexp.mjs → tests/vectors/regexp.json). Every
//! case must match exactly, including `lastIndex` afterwards and the
//! arguments passed to replacement functions.

use runic_js::regexp::{self as rx, RegExp};
use runic_js::{JsArray, JsString, Maybe, Throw};
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, Clone)]
enum V {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Arr(Vec<V>),
    Match {
        items: Vec<V>,
        index: f64,
        input: Vec<u16>,
        groups: Option<Vec<(String, V)>>,
    },
    Throw(String, String),
}

impl PartialEq for V {
    fn eq(&self, other: &V) -> bool {
        match (self, other) {
            (V::Undefined, V::Undefined) | (V::Null, V::Null) => true,
            (V::Bool(a), V::Bool(b)) => a == b,
            (V::Num(a), V::Num(b)) => (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits(),
            (V::Str(a), V::Str(b)) => a == b,
            (V::Arr(a), V::Arr(b)) => a == b,
            (
                V::Match {
                    items: a,
                    index: i,
                    input: s,
                    groups: g,
                },
                V::Match {
                    items: b,
                    index: j,
                    input: t,
                    groups: h,
                },
            ) => a == b && i == j && s == t && g == h,
            (V::Throw(a, m), V::Throw(b, n)) => a == b && m == n,
            _ => false,
        }
    }
}

fn vectors() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/regexp.json");
        let text = std::fs::read_to_string(path)
            .expect("run tests/vectors/regexp.mjs to generate vectors");
        serde_json::from_str(&text).expect("valid vector JSON")
    })
}

fn string_table() -> &'static [Vec<u16>] {
    static TABLE: OnceLock<Vec<Vec<u16>>> = OnceLock::new();
    TABLE.get_or_init(|| {
        vectors()["strings"]
            .as_array()
            .unwrap()
            .iter()
            .map(|s| {
                s.as_array()
                    .unwrap()
                    .iter()
                    .map(|u| u.as_u64().unwrap() as u16)
                    .collect()
            })
            .collect()
    })
}

fn decode(v: &Value) -> V {
    let o = v.as_object().unwrap_or_else(|| panic!("bad value {v}"));
    if o.contains_key("u") {
        V::Undefined
    } else if o.contains_key("null") {
        V::Null
    } else if let Some(b) = o.get("b") {
        V::Bool(b.as_bool().unwrap())
    } else if let Some(n) = o.get("n") {
        V::Num(match n {
            Value::String(s) => match s.as_str() {
                "NaN" => f64::NAN,
                "Infinity" => f64::INFINITY,
                "-Infinity" => f64::NEG_INFINITY,
                "-0" => -0.0,
                other => panic!("bad number {other}"),
            },
            n => n.as_f64().unwrap(),
        })
    } else if let Some(k) = o.get("s") {
        V::Str(string_table()[k.as_u64().unwrap() as usize].clone())
    } else if let Some(a) = o.get("a") {
        V::Arr(a.as_array().unwrap().iter().map(decode).collect())
    } else if let Some(m) = o.get("m") {
        let V::Str(input) = decode(&o["input"]) else {
            panic!("match input")
        };
        V::Match {
            items: m.as_array().unwrap().iter().map(decode).collect(),
            index: o["index"].as_f64().unwrap(),
            input,
            groups: o["groups"].as_array().map(|g| {
                g.iter()
                    .map(|e| (e[0].as_str().unwrap().to_string(), decode(&e[1])))
                    .collect()
            }),
        }
    } else if let Some(name) = o.get("throw") {
        V::Throw(
            name.as_str().unwrap().into(),
            o["message"].as_str().unwrap().into(),
        )
    } else {
        panic!("bad value {v}")
    }
}

fn s(v: &V) -> JsString {
    match v {
        V::Str(u) => JsString::from_units(u.clone()),
        other => panic!("expected string, got {other:?}"),
    }
}
fn n(v: &V) -> f64 {
    match v {
        V::Num(x) => *x,
        other => panic!("expected number, got {other:?}"),
    }
}
fn str_v(x: &JsString) -> V {
    V::Str(x.units().to_vec())
}
fn maybe_v(x: &Maybe<JsString>) -> V {
    match x {
        Maybe::Some(x) => str_v(x),
        Maybe::Undefined => V::Undefined,
        Maybe::Null => V::Null,
    }
}
fn throw_v(t: Throw) -> V {
    V::Throw(t.name.to_rust(), t.message.to_rust())
}

/// A match array (with its extra properties) or a plain array.
fn array_v(a: &JsArray<Maybe<JsString>>) -> V {
    let items: Vec<V> = a.borrow().iter().map(maybe_v).collect();
    match rx::match_props(a) {
        Some(p) => V::Match {
            items,
            index: p.index,
            input: p.input.units().to_vec(),
            groups: p
                .groups
                .map(|g| g.iter().map(|(k, v)| (k.to_rust(), maybe_v(v))).collect()),
        },
        None => V::Arr(items),
    }
}
fn maybe_array_v(a: &Maybe<JsArray<Maybe<JsString>>>) -> V {
    match a {
        Maybe::Some(a) => array_v(a),
        Maybe::Null => V::Null,
        Maybe::Undefined => V::Undefined,
    }
}

/// Runs one case; returns the result and `lastIndex` afterwards.
fn run(op: &str, a: &[V]) -> (V, Option<V>) {
    let re = match RegExp::new(&s(&a[0]), &s(&a[1])) {
        Ok(re) => re,
        Err(t) => return (throw_v(t), None),
    };
    let li = |re: &RegExp| Some(V::Num(re.last_index()));
    match op {
        "new" => {
            let f = re.flags();
            let r = V::Arr(vec![
                str_v(&re.source()),
                str_v(&re.flags_string()),
                str_v(&runic_js::ToJsString::to_js_string(&re)),
                V::Bool(f.global),
                V::Bool(f.ignore_case),
                V::Bool(f.multiline),
                V::Bool(f.dot_all),
                V::Bool(f.unicode),
                V::Bool(f.unicode_sets),
                V::Bool(f.sticky),
                V::Bool(f.has_indices),
            ]);
            (r, None)
        }
        "exec" => {
            re.set_last_index(n(&a[3]));
            let r = maybe_array_v(&re.exec(&s(&a[2])));
            (r, li(&re))
        }
        "test" => {
            re.set_last_index(n(&a[3]));
            let r = V::Bool(re.test(&s(&a[2])));
            (r, li(&re))
        }
        "match" => {
            re.set_last_index(n(&a[3]));
            let r = maybe_array_v(&rx::match_(&s(&a[2]), &re));
            (r, li(&re))
        }
        "matchAll" => {
            re.set_last_index(n(&a[3]));
            let r = match rx::match_all(&s(&a[2]), &re) {
                Ok(all) => V::Arr(all.borrow().iter().map(array_v).collect()),
                Err(t) => return (throw_v(t), None),
            };
            (r, li(&re))
        }
        "search" => {
            re.set_last_index(n(&a[3]));
            let r = V::Num(rx::search(&s(&a[2]), &re));
            (r, li(&re))
        }
        "split" => {
            re.set_last_index(1.0);
            let limit = match &a[3] {
                V::Undefined => Maybe::Undefined,
                other => Maybe::Some(n(other)),
            };
            let r = V::Arr(
                rx::split(&s(&a[2]), &re, limit)
                    .borrow()
                    .iter()
                    .map(maybe_v)
                    .collect(),
            );
            (r, li(&re))
        }
        "replace" | "replaceAll" => {
            re.set_last_index(n(&a[4]));
            let r = if op == "replace" {
                Ok(rx::replace(&s(&a[2]), &re, &s(&a[3])))
            } else {
                rx::replace_all(&s(&a[2]), &re, &s(&a[3]))
            };
            match r {
                Ok(x) => (str_v(&x), li(&re)),
                Err(t) => (throw_v(t), None),
            }
        }
        "replaceFn" | "replaceAllFn" => {
            re.set_last_index(n(&a[3]));
            let mut calls = vec![];
            let f = |caps: &[Maybe<JsString>], pos: f64, _: &JsString| {
                let mut call: Vec<V> = caps.iter().map(maybe_v).collect();
                call.push(V::Num(pos));
                calls.push(V::Arr(call));
                let mut text: Vec<u16> = format!("<{}:", calls.len()).encode_utf16().collect();
                if let Maybe::Some(m) = &caps[0] {
                    text.extend_from_slice(m.units());
                }
                text.extend(format!("@{pos}>").encode_utf16());
                Ok(JsString::from_units(text))
            };
            let r = if op == "replaceFn" {
                rx::replace_with(&s(&a[2]), &re, f)
            } else {
                rx::replace_all_with(&s(&a[2]), &re, f)
            };
            match r {
                Ok(x) => (V::Arr(vec![str_v(&x), V::Arr(calls)]), li(&re)),
                Err(t) => (throw_v(t), None),
            }
        }
        other => panic!("unknown op {other}"),
    }
}

fn show(v: &V) -> String {
    match v {
        V::Str(u) => format!("{:?}", String::from_utf16_lossy(u)),
        V::Arr(a) => format!("[{}]", a.iter().map(show).collect::<Vec<_>>().join(", ")),
        V::Match {
            items,
            index,
            groups,
            ..
        } => format!(
            "match[{}] index {index} groups {:?}",
            items.iter().map(show).collect::<Vec<_>>().join(", "),
            groups
        ),
        other => format!("{other:?}"),
    }
}

#[test]
fn regexp_vectors() {
    let cases = vectors()["cases"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let op = c["op"].as_str().unwrap();
        let args: Vec<V> = c["args"].as_array().unwrap().iter().map(decode).collect();
        let want = decode(&c["r"]);
        let want_li = c.get("li").map(decode);
        let (got, got_li) = std::panic::catch_unwind(|| run(op, &args))
            .unwrap_or_else(|_| (V::Throw("panic".into(), String::new()), None));
        let li_ok = match (&want_li, &got_li) {
            (Some(w), Some(g)) => w == g,
            (None, _) => true,
            (Some(_), None) => false,
        };
        if got != want || !li_ok {
            failures.push(format!(
                "{op}({}):\n  want {} li {:?}\n  got  {} li {:?}",
                args.iter().map(show).collect::<Vec<_>>().join(", "),
                show(&want),
                want_li,
                show(&got),
                got_li
            ));
        }
    }
    if !failures.is_empty() {
        for f in failures.iter().take(400) {
            eprintln!("{f}");
        }
        panic!(
            "{} of {} RegExp vectors differ",
            failures.len(),
            cases.len()
        );
    }
    assert!(cases.len() > 10_000);
}

/// Case-insensitive matching of every character with a case mapping, as a
/// literal and in a class, with and without `u`.
#[test]
fn regexp_case_insensitive_table() {
    let v = vectors();
    let chars: Vec<u32> = v["icaseUniverse"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_u64().unwrap() as u32)
        .collect();
    let mut want: std::collections::HashMap<(String, String, u32), Vec<u32>> = Default::default();
    for e in v["icase"].as_array().unwrap() {
        want.insert(
            (
                e[0].as_str().unwrap().into(),
                e[1].as_str().unwrap().into(),
                e[2].as_u64().unwrap() as u32,
            ),
            e[3].as_array()
                .unwrap()
                .iter()
                .map(|c| c.as_u64().unwrap() as u32)
                .collect(),
        );
    }
    let mut hay: Vec<u16> = vec![];
    for (i, &cp) in chars.iter().enumerate() {
        if i > 0 {
            hay.push(10);
        }
        let mut buf = [0u16; 2];
        hay.extend_from_slice(char::from_u32(cp).unwrap().encode_utf16(&mut buf));
    }
    let hay = JsString::from_units(hay);
    let mut failures = vec![];
    for flags in ["gi", "giu"] {
        for &cp in &chars {
            if flags == "gi" && cp > 0xFFFF {
                continue;
            }
            for kind in ["char", "class"] {
                let esc = if cp > 0xFFFF {
                    format!("\\u{{{cp:x}}}")
                } else {
                    format!("\\u{cp:04x}")
                };
                let source = if kind == "char" {
                    esc
                } else {
                    format!("[{esc}]")
                };
                let re =
                    RegExp::new(&JsString::from(source.as_str()), &JsString::from(flags)).unwrap();
                let mut found: Vec<u32> = vec![];
                if let Maybe::Some(a) = rx::match_(&hay, &re) {
                    for m in a.borrow().iter() {
                        if let Maybe::Some(m) = m {
                            let c = char::decode_utf16(m.units().iter().copied())
                                .next()
                                .and_then(|r| r.ok())
                                .map_or(0, u32::from);
                            if c != cp {
                                found.push(c);
                            }
                        }
                    }
                }
                let expected = want
                    .get(&(flags.to_string(), kind.to_string(), cp))
                    .cloned()
                    .unwrap_or_default();
                if found != expected {
                    failures.push(format!(
                        "/{source}/{flags}: want {expected:x?} got {found:x?}"
                    ));
                }
            }
        }
    }
    if !failures.is_empty() {
        for f in failures.iter().take(200) {
            eprintln!("{f}");
        }
        panic!("{} case-insensitive matches differ", failures.len());
    }
}

/// Class escapes, negated classes and ranges over the same characters, in
/// every case and Unicode mode.
#[test]
fn regexp_class_table() {
    let v = vectors();
    let chars: Vec<u32> = v["classUniverse"]
        .as_array()
        .unwrap()
        .iter()
        .map(|c| c.as_u64().unwrap() as u32)
        .collect();
    let mut hay: Vec<u16> = vec![];
    let mut starts = std::collections::HashMap::new();
    for (i, &cp) in chars.iter().enumerate() {
        if i > 0 {
            hay.push(10);
        }
        starts.insert(hay.len(), i);
        let mut buf = [0u16; 2];
        hay.extend_from_slice(char::from_u32(cp).unwrap().encode_utf16(&mut buf));
    }
    let hay = JsString::from_units(hay);
    let mut failures = vec![];
    for e in v["classes"].as_array().unwrap() {
        let (p, flags) = (e[0].as_str().unwrap(), e[1].as_str().unwrap());
        let mut want = vec![];
        for run in e[2].as_array().unwrap() {
            let (s0, n) = (run[0].as_u64().unwrap(), run[1].as_u64().unwrap());
            want.extend((s0..s0 + n).map(|i| chars[i as usize]));
        }
        let re = RegExp::new(&JsString::from(p), &JsString::from(flags)).unwrap();
        // As the generator: the first code point of each non-empty match.
        let mut hits = std::collections::HashSet::new();
        for m in rx::match_all(&hay, &re).unwrap().borrow().iter() {
            let first = m.borrow()[0].clone();
            let Maybe::Some(text) = first else { continue };
            if text.is_empty() || text.units() == [10] {
                continue;
            }
            let cp = char::decode_utf16(text.units().iter().copied())
                .next()
                .unwrap()
                .map_or_else(|e| u32::from(e.unpaired_surrogate()), u32::from);
            hits.insert(cp);
        }
        let _ = &starts;
        let got: Vec<u32> = chars.iter().copied().filter(|c| hits.contains(c)).collect();
        if got != want {
            let extra: Vec<_> = got.iter().filter(|c| !want.contains(c)).collect();
            let missing: Vec<_> = want.iter().filter(|c| !got.contains(c)).collect();
            failures.push(format!(
                "/{p}/{flags}: extra {extra:x?} missing {missing:x?}"
            ));
        }
    }
    if !failures.is_empty() {
        for f in &failures {
            eprintln!("{f}");
        }
        panic!("{} class patterns differ", failures.len());
    }
}
