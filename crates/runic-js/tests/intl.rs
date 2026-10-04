//! Intl differential tests: `runic_js::intl` and `Date.prototype.toString`'s
//! zone names against vectors Chromium computed (tests/vectors/intl.mjs →
//! tests/vectors/intl.json). Every case must match exactly.

use runic_js::intl::{CollatorSpec, DateSpec, NumberSpec, compare, format_date, format_number};
use runic_js::{JsString, env};
use serde_json::Value;
use std::sync::OnceLock;

fn vectors() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/intl.json");
        serde_json::from_str(&std::fs::read_to_string(path).expect("intl.json")).expect("json")
    })
}

/// Numbers are strings (parsed exactly here) or JSON integers.
fn number(v: &Value) -> f64 {
    match v {
        Value::String(s) => s.parse().unwrap_or_else(|_| panic!("number {s}")),
        v => v.as_i64().expect("integer") as f64,
    }
}

/// Expected output: a string, or the name of the error thrown.
fn expected(v: &Value) -> Result<String, String> {
    match v {
        Value::String(s) => Ok(s.clone()),
        v => Err(v["throw"].as_str().expect("throw").to_string()),
    }
}

fn report(failures: &[String], total: usize, what: &str) {
    if !failures.is_empty() {
        panic!(
            "{} of {total} {what} vectors differ:\n{}",
            failures.len(),
            failures[..failures.len().min(40)].join("\n")
        );
    }
}

#[test]
fn date_formats_match_chromium() {
    let cases = vectors()["date"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let (locale, zone, spec) = (
            c[0].as_str().unwrap(),
            c[1].as_str().unwrap(),
            c[2].as_str().unwrap(),
        );
        env::set_locale(locale).unwrap();
        env::set_time_zone(zone).unwrap();
        let want = expected(&c[4]);
        let got = DateSpec::parse(spec)
            .map_err(|e| format!("rejected: {e}"))
            .and_then(|s| format_date(number(&c[3]), &s, None).map_err(|t| t.name.to_rust()))
            .map(|s| s.to_rust());
        if got != want {
            failures.push(format!(
                "{locale} {zone} {spec} t={}: want {want:?}, got {got:?}",
                c[3]
            ));
        }
    }
    report(&failures, cases.len(), "date");
}

#[test]
fn number_formats_match_chromium() {
    let cases = vectors()["number"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let (locale, spec) = (c[0].as_str().unwrap(), c[1].as_str().unwrap());
        env::set_locale(locale).unwrap();
        let want = expected(&c[3]);
        let got = match NumberSpec::parse(spec) {
            // A RangeError in JavaScript; the frontend rejects the literal.
            Err(e) if e.contains("RangeError") => Err("RangeError".to_string()),
            Err(e) => Err(format!("rejected: {e}")),
            Ok(s) => format_number(number(&c[2]), &s, None)
                .map(|s| s.to_rust())
                .map_err(|t| t.name.to_rust()),
        };
        if got != want {
            failures.push(format!(
                "{locale} {spec} x={}: want {want:?}, got {got:?}",
                c[2]
            ));
        }
    }
    report(&failures, cases.len(), "number");
}

#[test]
fn collation_matches_chromium() {
    let cases = vectors()["collate"].as_array().unwrap();
    let mut failures = vec![];
    for c in cases {
        let (locale, spec) = (c[0].as_str().unwrap(), c[1].as_str().unwrap());
        env::set_locale(locale).unwrap();
        let a = JsString::from(c[2].as_str().unwrap());
        let b = JsString::from(c[3].as_str().unwrap());
        let want = c[4].as_f64().unwrap();
        let got = compare(&a, &b, &CollatorSpec::parse(spec).unwrap(), None).unwrap();
        if got != want {
            failures.push(format!(
                "{locale} {spec} {a:?} {b:?}: want {want}, got {got}"
            ));
        }
    }
    report(&failures, cases.len(), "collation");
}

#[test]
fn zone_offsets_and_names_match_chromium() {
    let v = vectors();
    let cases = v["zones"].as_array().unwrap();
    let at = |key: &str, i: &Value| v[key][i.as_u64().unwrap() as usize].as_str().unwrap();
    let mut failures = vec![];
    let mut checked = 0;
    for c in cases {
        // [zone, locale, instant, offset, name] (indices into the tables).
        let name = at("zoneIds", &c[0]);
        if !runic_js::intl::is_verified_zone(name) {
            continue;
        }
        checked += 1;
        env::set_locale(at("locales", &c[1])).unwrap();
        env::set_time_zone(name).unwrap();
        let t = c[2].as_i64().unwrap() as f64;
        let zone = runic_js::tz::Zone::named(name).unwrap();
        let offset = zone.offset_at_utc(t as i64) as f64;
        let s = runic_js::date::to_string(t).to_rust();
        let shown = &s[s.find('(').unwrap() + 1..s.len() - 1];
        if offset != c[3].as_i64().unwrap() as f64 || shown != at("zoneNames", &c[4]) {
            failures.push(format!("{name} {c}: offset {offset}, name {shown}"));
        }
    }
    assert!(checked > 10_000, "only {checked} zone vectors are verified");
    report(&failures, checked, "zone");
}

#[test]
fn verified_zones_include_the_test_zones() {
    for z in [
        "UTC",
        "Europe/Berlin",
        "America/New_York",
        "Asia/Kolkata",
        "Australia/Lord_Howe",
        "Asia/Tokyo",
    ] {
        assert!(runic_js::intl::is_verified_zone(z), "{z}");
    }
}
