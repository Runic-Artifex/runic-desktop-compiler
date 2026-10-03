//! Family B differential tests: `runic_js::string_ops` against vectors that
//! Node computed with real JavaScript (tests/vectors/string.mjs →
//! tests/vectors/string.json). Every case must match exactly.

use runic_js::string_ops as so;
use runic_js::{JsString, Maybe};
use serde_json::Value;
use std::collections::{BTreeMap, HashMap};
use std::sync::OnceLock;

/// A decoded JavaScript value (see the encoding in string.mjs).
#[derive(Debug, Clone)]
enum V {
    Undefined,
    Null,
    Bool(bool),
    Num(f64),
    Str(Vec<u16>),
    Arr(Vec<V>),
    Throw(String, String),
}

impl PartialEq for V {
    fn eq(&self, other: &V) -> bool {
        match (self, other) {
            (V::Undefined, V::Undefined) | (V::Null, V::Null) => true,
            (V::Bool(a), V::Bool(b)) => a == b,
            // Object.is: NaN equals NaN, +0 differs from -0.
            (V::Num(a), V::Num(b)) => (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits(),
            (V::Str(a), V::Str(b)) => a == b,
            (V::Arr(a), V::Arr(b)) => a == b,
            (V::Throw(a, m), V::Throw(b, n)) => a == b && m == n,
            _ => false,
        }
    }
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
fn maybe_n(v: &V) -> Maybe<f64> {
    match v {
        V::Undefined => Maybe::Undefined,
        V::Null => Maybe::Null,
        other => Maybe::Some(n(other)),
    }
}
fn maybe_s(v: &V) -> Maybe<JsString> {
    match v {
        V::Undefined => Maybe::Undefined,
        V::Null => Maybe::Null,
        other => Maybe::Some(s(other)),
    }
}
fn list(v: &V) -> &[V] {
    match v {
        V::Arr(a) => a,
        other => panic!("expected array, got {other:?}"),
    }
}

fn str_v(x: JsString) -> V {
    V::Str(x.units().to_vec())
}
fn maybe_str_v(x: Maybe<JsString>) -> V {
    match x {
        Maybe::Some(x) => str_v(x),
        Maybe::Undefined => V::Undefined,
        Maybe::Null => V::Null,
    }
}
fn strs_v(x: Vec<JsString>) -> V {
    V::Arr(x.into_iter().map(str_v).collect())
}
fn order_v(o: std::cmp::Ordering) -> V {
    V::Num(o as i8 as f64)
}

/// Calls the Rust implementation of `method` with decoded arguments.
fn run(method: &str, a: &[V]) -> V {
    match method {
        "at" => maybe_str_v(so::at(&s(&a[0]), n(&a[1]))),
        "index" => maybe_str_v(so::index(&s(&a[0]), n(&a[1]))),
        "charAt" => str_v(so::char_at(&s(&a[0]), n(&a[1]))),
        "charCodeAt" => V::Num(so::char_code_at(&s(&a[0]), n(&a[1]))),
        "codePointAt" => match so::code_point_at(&s(&a[0]), n(&a[1])) {
            Maybe::Some(x) => V::Num(x),
            Maybe::Undefined => V::Undefined,
            Maybe::Null => V::Null,
        },
        "slice" => str_v(so::slice(&s(&a[0]), n(&a[1]), maybe_n(&a[2]))),
        "substring" => str_v(so::substring(&s(&a[0]), n(&a[1]), maybe_n(&a[2]))),
        "indexOf" => V::Num(so::index_of(&s(&a[0]), &s(&a[1]), maybe_n(&a[2]))),
        "lastIndexOf" => V::Num(so::last_index_of(&s(&a[0]), &s(&a[1]), maybe_n(&a[2]))),
        "includes" => V::Bool(so::includes(&s(&a[0]), &s(&a[1]), maybe_n(&a[2]))),
        "startsWith" => V::Bool(so::starts_with(&s(&a[0]), &s(&a[1]), maybe_n(&a[2]))),
        "endsWith" => V::Bool(so::ends_with(&s(&a[0]), &s(&a[1]), maybe_n(&a[2]))),
        "trim" => str_v(so::trim(&s(&a[0]))),
        "trimStart" => str_v(so::trim_start(&s(&a[0]))),
        "trimEnd" => str_v(so::trim_end(&s(&a[0]))),
        "toUpperCase" => str_v(so::to_upper_case(&s(&a[0]))),
        "toLowerCase" => str_v(so::to_lower_case(&s(&a[0]))),
        "padStart" => str_v(so::pad_start(&s(&a[0]), n(&a[1]), maybe_s(&a[2]))),
        "padEnd" => str_v(so::pad_end(&s(&a[0]), n(&a[1]), maybe_s(&a[2]))),
        "repeat" => match so::repeat(&s(&a[0]), n(&a[1])) {
            Ok(x) => str_v(x),
            Err(t) => V::Throw(t.name.to_rust(), t.message.to_rust()),
        },
        "split" => strs_v(
            so::split(&s(&a[0]), maybe_s(&a[1]), maybe_n(&a[2]))
                .borrow()
                .clone(),
        ),
        "replace" => str_v(so::replace(&s(&a[0]), &s(&a[1]), &s(&a[2]))),
        "replaceAll" => str_v(so::replace_all(&s(&a[0]), &s(&a[1]), &s(&a[2]))),
        "concat" => {
            let others: Vec<JsString> = list(&a[1]).iter().map(s).collect();
            str_v(so::concat(&s(&a[0]), &others))
        }
        "compare" => order_v(so::compare(&s(&a[0]), &s(&a[1]))),
        // Code-unit order by design in M2 (the generator records the same).
        "localeCompare" => V::Num(so::locale_compare(&s(&a[0]), &s(&a[1]))),
        "fromCharCode" => {
            let units: Vec<f64> = list(&a[0]).iter().map(n).collect();
            str_v(so::from_char_code(&units))
        }
        "codePoints" => strs_v(so::code_points(&s(&a[0]))),
        other => panic!("unknown method {other}"),
    }
}

fn vectors() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/string.json");
        let text = std::fs::read_to_string(path)
            .expect("run tests/vectors/string.mjs to generate vectors");
        serde_json::from_str(&text).expect("valid vector JSON")
    })
}

/// The deduplicated strings that `{"s": k}` refers to, as UTF-16 code units.
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

fn show(v: &V) -> String {
    match v {
        V::Str(u) => format!("{:?} {:04x?}", String::from_utf16_lossy(u), u),
        V::Arr(a) => format!("[{}]", a.iter().map(show).collect::<Vec<_>>().join(", ")),
        other => format!("{other:?}"),
    }
}

#[test]
fn string_methods_match_node() {
    let data = vectors();
    let cases = data["cases"].as_array().unwrap();
    let mut per_method: BTreeMap<String, usize> = BTreeMap::new();
    let mut failures = Vec::new();
    for case in cases {
        let method = case["m"].as_str().unwrap();
        let args: Vec<V> = case["args"]
            .as_array()
            .unwrap()
            .iter()
            .map(decode)
            .collect();
        let expected = decode(&case["r"]);
        *per_method.entry(method.into()).or_default() += 1;
        let actual = run(method, &args);
        if actual != expected {
            failures.push(format!(
                "{method}({}): expected {}, got {}",
                args.iter().map(show).collect::<Vec<_>>().join(", "),
                show(&expected),
                show(&actual)
            ));
        }
    }
    // Every method of the frozen surface is covered by a substantial corpus.
    let expected_counts: BTreeMap<String, usize> = data["counts"]
        .as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| (k.clone(), v.as_u64().unwrap() as usize))
        .collect();
    assert_eq!(per_method, expected_counts);
    assert_eq!(per_method.len(), 28, "methods covered: {per_method:?}");
    for (method, count) in &per_method {
        assert!(*count >= 50, "{method} has only {count} cases");
    }
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        cases.len(),
        failures.join("\n")
    );
}

/// Every code unit: the engine trims exactly the units in `trimTable`.
#[test]
fn trim_whitespace_table_matches_node() {
    let table: Vec<u16> = vectors()["trimTable"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| u.as_u64().unwrap() as u16)
        .collect();
    let mut failures = Vec::new();
    for u in 0..=0xFFFFu16 {
        let space = table.contains(&u);
        let input = JsString::from_units(vec![u, u16::from(b'x'), u]);
        let (both, start, end) = if space {
            (vec![0x78], vec![0x78, u], vec![u, 0x78])
        } else {
            (vec![u, 0x78, u], vec![u, 0x78, u], vec![u, 0x78, u])
        };
        if so::trim(&input).units() != both
            || so::trim_start(&input).units() != start
            || so::trim_end(&input).units() != end
        {
            failures.push(format!("U+{u:04X} (Node trims: {space})"));
        }
    }
    assert!(
        failures.is_empty(),
        "trim differs for {}",
        failures.join(", ")
    );
}

/// Code points where Rust's Unicode tables (char::UNICODE_VERSION) and Node's
/// ICU differ for single-code-point case mapping. Each entry must be explained;
/// the test fails if an entry is listed but no longer differs.
const CASE_EXCLUSIONS: &[(char, u32)] = &[];

/// Exhaustive single-code-point case mapping against Node for every scalar
/// value. Code points absent from Node's table map to themselves.
#[test]
fn case_mapping_table_matches_node() {
    let data = vectors();
    for (direction, lower) in [("upper", false), ("lower", true)] {
        let table: HashMap<u32, Vec<u16>> = data["caseTable"][direction]
            .as_array()
            .unwrap()
            .iter()
            .map(|e| {
                let cp = e[0].as_u64().unwrap() as u32;
                let units = e[1]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|u| u.as_u64().unwrap() as u16)
                    .collect();
                (cp, units)
            })
            .collect();
        let excluded: Vec<u32> = CASE_EXCLUSIONS
            .iter()
            .filter(|(d, _)| (*d == 'l') == lower)
            .map(|(_, cp)| *cp)
            .collect();
        let mut differing = Vec::new();
        let mut unexpected = Vec::new();
        for c in (0..=0x10FFFFu32).filter_map(char::from_u32) {
            let cp = c as u32;
            let input: Vec<u16> = c.encode_utf16(&mut [0; 2]).to_vec();
            let expected = table.get(&cp).cloned().unwrap_or_else(|| input.clone());
            let js = JsString::from_units(input);
            let actual = if lower {
                so::to_lower_case(&js)
            } else {
                so::to_upper_case(&js)
            };
            if actual.units() != expected.as_slice() {
                differing.push(cp);
                if !excluded.contains(&cp) {
                    unexpected.push(format!(
                        "U+{cp:04X}: Node {expected:04x?}, Rust {:04x?}",
                        actual.units()
                    ));
                }
            }
        }
        assert!(
            unexpected.is_empty(),
            "to_{direction}_case differs from Node (Rust Unicode {:?}):\n{}",
            char::UNICODE_VERSION,
            unexpected.join("\n")
        );
        assert_eq!(
            differing, excluded,
            "stale case-mapping exclusions for {direction}"
        );
    }
}
