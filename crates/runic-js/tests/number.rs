//! Family A (Number, Math, numeric operators) against Node-generated vectors.
//! Regenerate the vectors with `node crates/runic-js/tests/vectors/number.mjs`;
//! the encoding is described there.

use runic_js::{self as js, JsResult, JsString, Maybe, math};
use serde_json::Value;
use std::collections::BTreeMap;

const VECTORS: &str = include_str!("vectors/number.json");

/// Functions that ECMA-262 leaves implementation-approximated: results may
/// differ from V8 by at most one ulp, except for cases marked "exact" and
/// for special results (NaN, ±0, ±Infinity), which must match bit for bit.
const APPROXIMATE: &[&str] = &[
    "math_cbrt",
    "math_exp",
    "math_expm1",
    "math_log",
    "math_log1p",
    "math_log2",
    "math_log10",
    "math_sin",
    "math_cos",
    "math_tan",
    "math_asin",
    "math_acos",
    "math_atan",
    "math_atan2",
    "math_sinh",
    "math_cosh",
    "math_tanh",
    "math_asinh",
    "math_acosh",
    "math_atanh",
];

#[derive(Debug)]
enum Got {
    Num(f64),
    Bool(bool),
    Str(String),
    Throws(String),
}

fn num(v: &Value) -> f64 {
    let s = v
        .as_str()
        .unwrap_or_else(|| panic!("number expected, got {v}"));
    s.parse::<f64>()
        .unwrap_or_else(|_| panic!("bad number {s:?}"))
}

fn string(v: &Value) -> JsString {
    match v {
        Value::String(s) => JsString::from(s.as_str()),
        Value::Object(o) => JsString::from_units(
            o["u"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u.as_u64().unwrap() as u16)
                .collect(),
        ),
        _ => panic!("string expected, got {v}"),
    }
}

fn maybe(v: &Value) -> Maybe<f64> {
    match v {
        Value::Null => Maybe::Null,
        Value::String(s) if s == "undefined" => Maybe::Undefined,
        _ => Maybe::Some(num(v)),
    }
}

fn text(r: JsResult<JsString>) -> Got {
    match r {
        Ok(s) => Got::Str(s.to_rust()),
        Err(e) => Got::Throws(e.name.to_rust()),
    }
}

fn eval(name: &str, a: &[Value]) -> Got {
    use Got::{Bool, Num};
    let n = |i: usize| num(&a[i]);
    let list = || a[0].as_array().unwrap().iter().map(num).collect::<Vec<_>>();
    match name {
        "number_to_string" => Got::Str(js::number_to_string(n(0))),
        "min2" => Num(js::min(n(0), n(1))),
        "max2" => Num(js::max(n(0), n(1))),
        "same_value" => Bool(js::same_value(n(0), n(1))),
        "string_to_number" => Num(js::string_to_number(&string(&a[0]))),
        "parse_float" => Num(js::parse_float(&string(&a[0]))),
        "parse_int" => Num(js::parse_int(&string(&a[0]), maybe(&a[1]))),
        "is_integer" => Bool(js::is_integer(n(0))),
        "is_safe_integer" => Bool(js::is_safe_integer(n(0))),
        "to_int32" => Num(f64::from(js::to_int32(n(0)))),
        "to_uint32" => Num(f64::from(js::to_uint32(n(0)))),
        "to_fixed" => text(js::to_fixed(n(0), n(1))),
        "to_exponential" => text(js::to_exponential(n(0), maybe(&a[1]))),
        "to_precision" => text(js::to_precision(n(0), maybe(&a[1]))),
        "to_string_radix" => text(js::to_string_radix(n(0), n(1))),
        "pow" => Num(js::pow(n(0), n(1))),
        "rem" => Num(js::rem(n(0), n(1))),
        "bit_and" => Num(js::bit_and(n(0), n(1))),
        "bit_or" => Num(js::bit_or(n(0), n(1))),
        "bit_xor" => Num(js::bit_xor(n(0), n(1))),
        "bit_not" => Num(js::bit_not(n(0))),
        "shl" => Num(js::shl(n(0), n(1))),
        "shr" => Num(js::shr(n(0), n(1))),
        "ushr" => Num(js::ushr(n(0), n(1))),
        "math_round" => Num(math::round(n(0))),
        "math_sign" => Num(math::sign(n(0))),
        "math_trunc" => Num(math::trunc(n(0))),
        "math_floor" => Num(math::floor(n(0))),
        "math_ceil" => Num(math::ceil(n(0))),
        "math_abs" => Num(math::abs(n(0))),
        "math_sqrt" => Num(math::sqrt(n(0))),
        "math_clz32" => Num(math::clz32(n(0))),
        "math_fround" => Num(math::fround(n(0))),
        "math_imul" => Num(math::imul(n(0), n(1))),
        "math_hypot" => Num(math::hypot(&list())),
        "math_min" => Num(math::min(&list())),
        "math_max" => Num(math::max(&list())),
        "math_cbrt" => Num(math::cbrt(n(0))),
        "math_exp" => Num(math::exp(n(0))),
        "math_expm1" => Num(math::expm1(n(0))),
        "math_log" => Num(math::log(n(0))),
        "math_log1p" => Num(math::log1p(n(0))),
        "math_log2" => Num(math::log2(n(0))),
        "math_log10" => Num(math::log10(n(0))),
        "math_sin" => Num(math::sin(n(0))),
        "math_cos" => Num(math::cos(n(0))),
        "math_tan" => Num(math::tan(n(0))),
        "math_asin" => Num(math::asin(n(0))),
        "math_acos" => Num(math::acos(n(0))),
        "math_atan" => Num(math::atan(n(0))),
        "math_atan2" => Num(math::atan2(n(0), n(1))),
        "math_sinh" => Num(math::sinh(n(0))),
        "math_cosh" => Num(math::cosh(n(0))),
        "math_tanh" => Num(math::tanh(n(0))),
        "math_asinh" => Num(math::asinh(n(0))),
        "math_acosh" => Num(math::acosh(n(0))),
        "math_atanh" => Num(math::atanh(n(0))),
        _ => panic!("no implementation mapped for vector function {name}"),
    }
}

/// Distance in units in the last place between two finite doubles of the same sign.
fn ulps(a: f64, b: f64) -> u64 {
    if a.is_sign_negative() != b.is_sign_negative() {
        return u64::MAX;
    }
    a.to_bits().abs_diff(b.to_bits())
}

enum Verdict {
    Exact,
    WithinUlp,
    Mismatch,
}

fn judge(got: &Got, expected: &Value, approximate: bool) -> Verdict {
    let ok = |b: bool| if b { Verdict::Exact } else { Verdict::Mismatch };
    match (got, expected) {
        (Got::Num(g), Value::String(_)) => {
            let e = num(expected);
            if js::same_value(*g, e) {
                Verdict::Exact
            } else if approximate
                && e.is_finite()
                && e != 0.0
                && g.is_finite()
                && *g != 0.0
                && ulps(*g, e) <= 1
            {
                Verdict::WithinUlp
            } else {
                Verdict::Mismatch
            }
        }
        (Got::Bool(g), Value::Bool(e)) => ok(g == e),
        (Got::Str(g), Value::String(e)) => ok(g == e),
        (Got::Throws(g), Value::Object(o)) => {
            ok(o.get("throws").and_then(Value::as_str) == Some(g))
        }
        _ => Verdict::Mismatch,
    }
}

#[test]
fn family_a_matches_node_vectors() {
    let vectors: Value = serde_json::from_str(VECTORS).expect("number.json");
    let cases = vectors["cases"].as_object().expect("cases");
    let mut failures: Vec<String> = Vec::new();
    let mut inexact: BTreeMap<&str, (usize, usize)> = BTreeMap::new();
    let mut total = 0;
    for (name, list) in cases {
        let approximate = APPROXIMATE.contains(&name.as_str());
        let list = list.as_array().unwrap();
        for case in list {
            let case = case.as_array().unwrap();
            let args = case[0].as_array().unwrap();
            let exact = case.get(2).and_then(Value::as_str) == Some("exact");
            let got = eval(name, args);
            total += 1;
            match judge(&got, &case[1], approximate && !exact) {
                Verdict::Exact => {}
                Verdict::WithinUlp => inexact.entry(name).or_default().0 += 1,
                Verdict::Mismatch => failures.push(format!(
                    "{name}({args:?}): got {got:?}, expected {}",
                    case[1]
                )),
            }
        }
        if approximate {
            inexact.entry(name).or_default().1 = list.len();
        }
    }
    for (name, (off, n)) in &inexact {
        if *off > 0 {
            eprintln!("{name}: {off} of {n} results differ from V8 by 1 ulp");
        }
    }
    for f in failures.iter().take(200) {
        eprintln!("{f}");
    }
    assert!(
        failures.is_empty(),
        "{} of {total} vector cases failed",
        failures.len()
    );
    assert!(total > 30_000, "vector file looks truncated: {total} cases");
}

#[test]
fn documented_examples() {
    let fixed = |x: f64, d: f64| js::to_fixed(x, d).unwrap().to_rust();
    assert_eq!(fixed(1.005, 2.0), "1.00");
    assert_eq!(fixed(1.45, 1.0), "1.4");
    assert_eq!(fixed(-0.0, 2.0), "0.00");
    assert_eq!(fixed(-0.0001, 2.0), "-0.00");
    assert_eq!(fixed(f64::NAN, 2.0), "NaN");
    assert_eq!(
        js::to_fixed(1.0, 101.0).unwrap_err().name.to_rust(),
        "RangeError"
    );
    assert_eq!(
        js::string_to_number(&JsString::from("\u{feff} 0x1F \u{3000}")),
        31.0
    );
    assert!(js::string_to_number(&JsString::from("-0x1F")).is_nan());
    assert_eq!(math::round(0.49999999999999994), 0.0);
    assert!(math::round(-0.5).is_sign_negative());
    assert_eq!(math::cbrt(-8.0), -2.0);
    assert!(js::pow(1.0, f64::INFINITY).is_nan());
    assert_eq!(js::shl(1.0, 33.0), 2.0);
}
