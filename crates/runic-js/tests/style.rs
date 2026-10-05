//! svelte-toolbelt's cssToStyleObj and mergeProps of style strings against
//! Node-generated vectors (tests/vectors/style.mjs).

use runic_js::style_parse::css_to_style_obj;
use runic_js::{JsString, MergeKind, MergeOps, merge_props};
use serde_json::Value;

fn vectors() -> Value {
    serde_json::from_str(include_str!("vectors/style.json")).expect("valid vector file")
}

#[test]
fn css_to_style_obj_matches_the_package() {
    let v = vectors();
    for case in v["parse"].as_array().unwrap() {
        let css = case["css"].as_str().unwrap();
        let got = css_to_style_obj(css);
        match case.get("error") {
            Some(e) => {
                let err = got.expect_err(css);
                assert_eq!(err, e.as_str().unwrap(), "error of {css:?}");
            }
            None => {
                let want: Vec<(String, String)> = case["entries"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|p| {
                        (
                            p[0].as_str().unwrap().to_string(),
                            p[1].as_str().unwrap().to_string(),
                        )
                    })
                    .collect();
                assert_eq!(got.expect(css), want, "entries of {css:?}");
            }
        }
    }
}

#[derive(Clone, Debug)]
enum V {
    Text(String),
    Style(Vec<(String, Option<JsString>)>),
}

struct Ops;
impl MergeOps<V> for Ops {
    fn kind(&self, v: &V) -> MergeKind {
        match v {
            V::Text(s) => MergeKind::Text(JsString::from(s.as_str())),
            V::Style(s) => MergeKind::Style(s.clone()),
        }
    }
    fn text(&self, s: JsString) -> V {
        V::Text(s.to_rust())
    }
    fn compose(&self, _: Vec<V>) -> V {
        unreachable!("no listeners")
    }
    fn listeners(&self, _: &V) -> Vec<V> {
        unreachable!("no listeners")
    }
}

fn style(v: &Value) -> V {
    match v {
        Value::String(s) => V::Text(s.clone()),
        other => V::Style(
            other["object"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| {
                    (
                        p[0].as_str().unwrap().to_string(),
                        Some(JsString::from(p[1].as_str().unwrap())),
                    )
                })
                .collect(),
        ),
    }
}

#[test]
fn merge_props_of_style_strings_matches_the_package() {
    let v = vectors();
    for case in v["merge"].as_array().unwrap() {
        let a = vec![("style".to_string(), style(&case["a"]))];
        let b = vec![("style".to_string(), style(&case["b"]))];
        let out = merge_props(&[a, b], &Ops).expect("merged");
        let got = out
            .iter()
            .find(|(k, _)| k == "style")
            .map(|(_, v)| v.clone());
        match got {
            Some(V::Text(s)) => assert_eq!(s, case["result"].as_str().unwrap(), "{case}"),
            other => panic!("{case}: {other:?}"),
        }
    }
}
