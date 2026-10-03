//! Family D (JSON) against Node-generated vectors (tests/vectors/json.mjs).

use runic_js::json::{FromJson, Indent, Json, ToJson, parse, quote, stringify};
use runic_js::{JsArray, JsString, Maybe, array};
use serde_json::Value;

fn vectors() -> Value {
    let text = include_str!("vectors/json.json");
    serde_json::from_str(text).expect("valid vector file")
}

/// `"text"` or `{"u16": [units]}`.
fn string(v: &Value) -> JsString {
    match v {
        Value::String(s) => JsString::from(s.as_str()),
        Value::Object(o) => JsString::from_units(
            o["u16"]
                .as_array()
                .unwrap()
                .iter()
                .map(|u| u.as_u64().unwrap() as u16)
                .collect(),
        ),
        other => panic!("bad string encoding {other}"),
    }
}

fn number(v: &Value) -> f64 {
    match v.as_str().unwrap() {
        "-0" => -0.0,
        "NaN" => f64::NAN,
        "Infinity" => f64::INFINITY,
        "-Infinity" => f64::NEG_INFINITY,
        s => s.parse().unwrap(),
    }
}

/// Decodes a flat preorder token list (see json.mjs).
fn value(v: &Value) -> Json {
    let tokens = v.as_array().unwrap();
    let mut pos = 0;
    let j = decode(tokens, &mut pos);
    assert_eq!(pos, tokens.len(), "trailing tokens");
    j
}

fn decode(tokens: &[Value], pos: &mut usize) -> Json {
    let a = tokens[*pos].as_array().unwrap();
    *pos += 1;
    let count = || a[1].as_u64().unwrap() as usize;
    match a[0].as_str().unwrap() {
        "null" => Json::Null,
        "bool" => Json::Bool(a[1].as_bool().unwrap()),
        "num" => Json::Num(number(&a[1])),
        "str" => Json::Str(string(&a[1])),
        "arr" => Json::Array((0..count()).map(|_| decode(tokens, pos)).collect()),
        "obj" => Json::Object(
            (0..count())
                .map(|_| {
                    let k = tokens[*pos].as_array().unwrap();
                    assert_eq!(k[0], "key");
                    *pos += 1;
                    (string(&k[1]), decode(tokens, pos))
                })
                .collect(),
        ),
        tag => panic!("bad value tag {tag}"),
    }
}

fn indent(v: &Value) -> Indent {
    let a = v.as_array().unwrap();
    match a[0].as_str().unwrap() {
        "none" => Indent::None,
        "spaces" => Indent::Spaces(number(&a[1])),
        "text" => Indent::Text(string(&a[1])),
        tag => panic!("bad indent tag {tag}"),
    }
}

/// Structural equality that distinguishes -0 from +0 and treats NaN as equal.
fn same(a: &Json, b: &Json) -> bool {
    match (a, b) {
        (Json::Num(x), Json::Num(y)) => runic_js::same_value(*x, *y),
        (Json::Array(x), Json::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(p, q)| same(p, q))
        }
        (Json::Object(x), Json::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .zip(y)
                    .all(|((kp, p), (kq, q))| kp == kq && same(p, q))
        }
        _ => a == b,
    }
}

fn short(s: &JsString) -> String {
    let s = format!("{s:?}");
    if s.len() > 120 {
        format!("{}...", &s[..s.floor_char_boundary(120)])
    } else {
        s
    }
}

#[test]
fn quote_matches_node() {
    let v = vectors();
    let cases = v["quote"].as_array().unwrap();
    assert!(cases.len() > 100);
    let mut failures = Vec::new();
    for case in cases {
        let input = string(&case["input"]);
        let expected = string(&case["output"]);
        let actual = quote(&input);
        if actual != expected {
            failures.push(format!(
                "quote({}) = {} expected {}",
                short(&input),
                short(&actual),
                short(&expected)
            ));
        }
        // stringify of a string value is the same operation.
        assert_eq!(stringify(&Json::Str(input), &Indent::None), expected);
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Deep vector values (600+ levels) recurse in the decoding helpers and in
/// `Json`'s drop glue; debug builds need more than the default test stack.
fn big_stack(f: fn()) {
    std::thread::Builder::new()
        .stack_size(256 << 20)
        .spawn(f)
        .unwrap()
        .join()
        .unwrap();
}

#[test]
fn stringify_matches_node() {
    big_stack(stringify_cases);
}

#[test]
fn parse_matches_node() {
    big_stack(parse_cases);
}

fn stringify_cases() {
    let v = vectors();
    let cases = v["stringify"].as_array().unwrap();
    assert!(cases.len() > 1000);
    let mut failures = Vec::new();
    for (i, case) in cases.iter().enumerate() {
        let input = value(&case["value"]);
        let ind = indent(&case["indent"]);
        let expected = string(&case["output"]);
        let actual = stringify(&input, &ind);
        if actual != expected {
            failures.push(format!(
                "#{i} indent {ind:?}: got {} expected {}",
                short(&actual),
                short(&expected)
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

fn parse_cases() {
    let v = vectors();
    let cases = v["parse"].as_array().unwrap();
    assert!(cases.len() > 1000);
    let mut failures = Vec::new();
    let mut errors = 0;
    for case in cases {
        let text = string(&case["text"]);
        let actual = parse(&text);
        match (case.get("result"), actual) {
            (Some(expected), Ok(actual)) => {
                let expected = value(expected);
                if !same(&actual, &expected) {
                    failures.push(format!(
                        "parse({}) = {actual:?}, expected {expected:?}",
                        short(&text)
                    ));
                }
            }
            (Some(_), Err(e)) => failures.push(format!("parse({}) threw {e}", short(&text))),
            (None, Ok(actual)) => failures.push(format!(
                "parse({}) = {actual:?}, expected SyntaxError",
                short(&text)
            )),
            (None, Err(e)) => {
                errors += 1;
                assert_eq!(case["error"], "SyntaxError");
                if e.name.to_rust() != "SyntaxError" || e.message.is_empty() {
                    failures.push(format!("parse({}) threw {e}", short(&text)));
                }
            }
        }
    }
    assert!(errors > 300, "only {errors} invalid texts");
    assert!(
        failures.is_empty(),
        "{} failures:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn parse_then_stringify_round_trips_member_order() {
    let parsed = parse(&JsString::from(r#"{"b":1,"2":2,"a":{"x":[]},"1":3,"b":4}"#)).unwrap();
    assert_eq!(
        stringify(&parsed, &Indent::None).to_rust(),
        r#"{"1":3,"2":2,"b":4,"a":{"x":[]}}"#
    );
}

#[test]
fn very_deep_nesting_parses() {
    let depth = 100_000;
    let text = format!("{}{}", "[".repeat(depth), "]".repeat(depth));
    let mut j = parse(&JsString::from(text)).unwrap();
    let mut seen = 0;
    // Unwind iteratively so dropping does not recurse deeply.
    while let Json::Array(mut items) = j {
        seen += 1;
        j = items.pop().unwrap_or(Json::Null);
    }
    assert_eq!(seen, depth);
    let unclosed = "[".repeat(depth);
    assert_eq!(
        parse(&JsString::from(unclosed)).unwrap_err().name.to_rust(),
        "SyntaxError"
    );
}

#[test]
fn to_json_conversions() {
    assert_eq!(1.5.to_json(), Some(Json::Num(1.5)));
    assert_eq!(f64::NAN.to_json(), Some(Json::Null));
    assert_eq!(f64::INFINITY.to_json(), Some(Json::Null));
    assert_eq!(true.to_json(), Some(Json::Bool(true)));
    assert_eq!(
        JsString::from("x").to_json(),
        Some(Json::Str(JsString::from("x")))
    );
    assert_eq!(Maybe::<f64>::Undefined.to_json(), None);
    assert_eq!(Maybe::<f64>::Null.to_json(), Some(Json::Null));
    assert_eq!(Maybe::Some(2.0).to_json(), Some(Json::Num(2.0)));
    let a: JsArray<Maybe<f64>> = array(vec![
        Maybe::Some(1.0),
        Maybe::Undefined,
        Maybe::Null,
        Maybe::Some(f64::NAN),
    ]);
    let j = a.to_json().unwrap();
    assert_eq!(
        j,
        Json::Array(vec![Json::Num(1.0), Json::Null, Json::Null, Json::Null])
    );
    assert_eq!(stringify(&j, &Indent::None).to_rust(), "[1,null,null,null]");
}

#[test]
fn from_json_checks_shapes() {
    let j = parse(&JsString::from(r#"[1, null, 2.5]"#)).unwrap();
    let a = JsArray::<Maybe<f64>>::from_json(&j).unwrap();
    assert_eq!(
        *a.borrow(),
        vec![Maybe::Some(1.0), Maybe::Null, Maybe::Some(2.5)]
    );
    assert_eq!(
        f64::from_json(&Json::Num(-0.0)).map(f64::is_sign_negative),
        Ok(true)
    );
    assert_eq!(bool::from_json(&Json::Bool(false)), Ok(false));
    assert_eq!(
        JsString::from_json(&Json::Str(JsString::from("s"))),
        Ok(JsString::from("s"))
    );
    assert_eq!(Maybe::<bool>::from_json(&Json::Null), Ok(Maybe::Null));
    let err = f64::from_json(&Json::Str(JsString::from("1"))).unwrap_err();
    assert_eq!(err.name.to_rust(), "SyntaxError");
    assert!(
        err.message
            .to_rust()
            .contains("expected number, found string"),
        "{err}"
    );
    assert!(
        JsArray::<f64>::from_json(&j).is_err(),
        "null element is not a number"
    );
    assert!(JsArray::<f64>::from_json(&Json::Object(vec![])).is_err());
    assert!(bool::from_json(&Json::Null).is_err());
    assert!(Maybe::<JsString>::from_json(&Json::Num(1.0)).is_err());
}
