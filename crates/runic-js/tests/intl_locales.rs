//! Intl.PluralRules and Intl.DisplayNames against vectors Chromium computed
//! (tests/vectors/intl-locales.mjs → tests/vectors/intl-locales.json).
//! Every case must match exactly; tags outside the modelled shapes
//! (variants, extensions, regions that alias several regions) must be
//! reported unsupported, never answered.

use runic_js::intl::{NamesSpec, PluralSpec, display_name, plural_categories, plural_select};
use runic_js::{JsString, Throw, env};
use serde_json::Value;
use std::sync::OnceLock;

fn vectors() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/tests/vectors/intl-locales.json"
        );
        serde_json::from_str(&std::fs::read_to_string(path).expect("intl-locales.json"))
            .expect("json")
    })
}

/// The expected value: Ok(JSON value) or Err(error name).
fn expected(v: &Value) -> Result<Value, String> {
    match v.get("throw") {
        Some(name) => Err(name.as_str().unwrap().to_string()),
        None => Ok(v.clone()),
    }
}

/// Outcomes of one family of vectors.
#[derive(Default)]
struct Tally {
    total: usize,
    unsupported: Vec<String>,
    failures: Vec<String>,
}

impl Tally {
    /// Records a result: an unsupported report counts apart.
    fn check(&mut self, what: String, got: Result<Value, Throw>, want: Result<Value, String>) {
        self.total += 1;
        let got = got.map_err(|t| t.name.to_rust());
        if got.as_ref().err().map(String::as_str) == Some("RunicUnsupportedError") {
            self.unsupported.push(what);
        } else if got != want {
            self.failures
                .push(format!("{what}: want {want:?}, got {got:?}"));
        }
    }

    fn report(&self, family: &str, max_unsupported: usize) {
        eprintln!(
            "{family}: {} vectors, {} unsupported: {:?}",
            self.total,
            self.unsupported.len(),
            &self.unsupported[..self.unsupported.len().min(12)]
        );
        if !self.failures.is_empty() {
            panic!(
                "{} of {} {family} vectors differ:\n{}",
                self.failures.len(),
                self.total,
                self.failures[..self.failures.len().min(40)].join("\n")
            );
        }
        assert!(
            self.unsupported.len() <= max_unsupported,
            "{} of {} {family} vectors are unsupported:\n{}",
            self.unsupported.len(),
            self.total,
            self.unsupported[..self.unsupported.len().min(40)].join("\n")
        );
    }
}

fn runtime(v: &Value) -> Option<JsString> {
    v.as_str().map(JsString::from)
}

fn string(s: JsString) -> Value {
    Value::String(s.to_rust())
}

#[test]
fn plural_rules_select_as_chromium() {
    let mut tally = Tally::default();
    for g in vectors()["plural"].as_array().unwrap() {
        let (env_locale, spec) = (g[0].as_str().unwrap(), g[1].as_str().unwrap());
        env::set_locale(env_locale).unwrap();
        let spec = PluralSpec::parse(spec).unwrap_or_else(|e| panic!("{spec}: {e}"));
        let tag = runtime(&g[2]);
        let cases = g[3].as_array().unwrap();
        for c in cases.chunks(2) {
            let x: f64 = c[0].as_str().unwrap().parse().unwrap();
            tally.check(
                format!("{env_locale} {} {:?} x={}", g[1], g[2], c[0]),
                plural_select(x, &spec, tag.as_ref()).map(string),
                expected(&c[1]),
            );
        }
    }
    tally.report("plural", 400);
}

#[test]
fn plural_categories_as_chromium() {
    let mut tally = Tally::default();
    for c in vectors()["categories"].as_array().unwrap() {
        let (env_locale, spec) = (c[0].as_str().unwrap(), c[1].as_str().unwrap());
        env::set_locale(env_locale).unwrap();
        let parsed = PluralSpec::parse(spec).unwrap_or_else(|e| panic!("{spec}: {e}"));
        let got = plural_categories(&parsed, runtime(&c[2]).as_ref())
            .map(|v| Value::Array(v.into_iter().map(string).collect()));
        tally.check(
            format!("{env_locale} {spec} {:?}", c[2]),
            got,
            expected(&c[3]),
        );
    }
    tally.report("plural category", 40);
}

#[test]
fn display_names_as_chromium() {
    let mut tally = Tally::default();
    for c in vectors()["display"].as_array().unwrap() {
        let (env_locale, spec) = (c[0].as_str().unwrap(), c[1].as_str().unwrap());
        env::set_locale(env_locale).unwrap();
        let parsed = NamesSpec::parse(spec).unwrap_or_else(|e| panic!("{spec}: {e}"));
        let code = JsString::from(c[3].as_str().unwrap());
        let got = display_name(&code, &parsed, runtime(&c[2]).as_ref())
            .map(|v| v.map_or(Value::Null, string));
        tally.check(
            format!("{env_locale} {spec} {:?} {:?}", c[2], c[3]),
            got,
            expected(&c[4]),
        );
    }
    tally.report("display name", 200);
}

#[test]
fn literal_options_are_checked() {
    assert!(PluralSpec::parse("m=p;loc=pt-PT;type=ordinal").is_ok());
    assert!(
        PluralSpec::parse("m=p;loc=en_US")
            .unwrap_err()
            .contains("RangeError")
    );
    assert!(PluralSpec::parse("m=p;loc=en-u-nu-arab").is_err());
    assert!(PluralSpec::parse("m=p;minimumFractionDigits=1").is_err());
    assert!(NamesSpec::parse("m=n;loc=de;type=language;languageDisplay=standard").is_ok());
    assert!(NamesSpec::parse("m=n;loc=de-AT;type=region").is_err());
    assert!(NamesSpec::parse("m=n;type=calendar").is_err());
    assert!(NamesSpec::parse("m=n;type=region;style=short").is_err());
    assert!(
        NamesSpec::parse("m=n;fallback=none")
            .unwrap_err()
            .contains("TypeError")
    );
}
