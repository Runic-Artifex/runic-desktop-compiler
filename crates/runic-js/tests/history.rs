//! Session history against Chromium (tests/vectors/history.mjs →
//! tests/vectors/history.json): pushState URL resolution, the location.hash
//! setter, and hashchange on traversal. Chromium's SecurityError cases are
//! unsupported URLs here (they throw RunicHistoryError).

use runic_js::JsString;
use runic_js::history::Session;
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/history.json")).expect("history vectors")
}

fn units(v: &Value) -> JsString {
    JsString::from_units(
        v.as_array()
            .expect("code units")
            .iter()
            .map(|u| u.as_u64().expect("code unit") as u16)
            .collect(),
    )
}

fn at(base: &str) -> Session {
    let mut s = Session::new(base).expect("base");
    s.loaded();
    s
}

fn location(s: &Session) -> Value {
    serde_json::json!({
        "pathname": s.pathname(), "search": s.search(), "hash": s.hash(), "href": s.href(),
    })
}

#[test]
fn push_state_urls() {
    let v = vectors();
    let mut failures = vec![];
    for case in v["push"].as_array().unwrap() {
        let mut s = at(case["base"].as_str().unwrap());
        let input = units(&case["input"]);
        let got = match s.push(Some(&input), None) {
            Ok(()) => location(&s),
            Err(e) => {
                assert_eq!(e.name.to_rust(), "RunicHistoryError");
                serde_json::json!({"error": "SecurityError"})
            }
        };
        let mut want = case.clone();
        let want = want.as_object_mut().unwrap();
        want.remove("base");
        want.remove("input");
        if got != Value::Object(want.clone()) {
            failures.push(format!("{case}: got {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn hash_setter() {
    let v = vectors();
    let mut failures = vec![];
    for case in v["hash"].as_array().unwrap() {
        let mut s = at(case["base"].as_str().unwrap());
        let before = s.length();
        let navigated = s.set_hash(&units(&case["input"])).expect("hash");
        assert_eq!(s.length(), before + usize::from(navigated));
        let mut got = location(&s);
        got["navigated"] = navigated.into();
        let mut want = case.clone();
        let want = want.as_object_mut().unwrap();
        want.remove("base");
        want.remove("input");
        if got != Value::Object(want.clone()) {
            failures.push(format!("{case}: got {got}"));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

#[test]
fn traversal_hashchange() {
    let v = vectors();
    for case in v["traverse"].as_array().unwrap() {
        let mut s = at("/");
        s.push(Some(&JsString::from(case["from"].as_str().unwrap())), None)
            .unwrap();
        s.push(Some(&JsString::from(case["to"].as_str().unwrap())), None)
            .unwrap();
        let t = s.traverse(-1).unwrap().expect("traversed");
        assert_eq!(case["popstate"], 1);
        assert_eq!(
            Value::from(u8::from(t.hashchange)),
            case["hashchange"],
            "{case}"
        );
    }
}
