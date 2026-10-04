//! Date differential tests: `runic_js::date` against vectors Chromium
//! computed per time zone (tests/vectors/date.mjs → tests/vectors/date.json):
//! getters, string forms, construction from components, setters and
//! `Date.parse`. Every case must match exactly.

use runic_js::date::{self, Date};
use runic_js::{JsString, env};
use serde_json::Value;

fn vectors() -> Value {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors/date.json");
    serde_json::from_str(&std::fs::read_to_string(path).expect("date.json")).expect("json")
}

/// Numbers are strings, parsed exactly.
fn num(v: &Value) -> f64 {
    let s = v
        .as_str()
        .unwrap_or_else(|| panic!("number string expected, got {v}"));
    s.parse().unwrap_or_else(|_| panic!("number {s}"))
}

fn same(a: f64, b: f64) -> bool {
    (a.is_nan() && b.is_nan()) || a.to_bits() == b.to_bits()
}

const GETTERS: [&str; 17] = [
    "getFullYear",
    "getMonth",
    "getDate",
    "getDay",
    "getHours",
    "getMinutes",
    "getSeconds",
    "getMilliseconds",
    "getUTCFullYear",
    "getUTCMonth",
    "getUTCDate",
    "getUTCDay",
    "getUTCHours",
    "getUTCMinutes",
    "getUTCSeconds",
    "getUTCMilliseconds",
    "getTimezoneOffset",
];

#[test]
fn dates_match_chromium() {
    let v = vectors();
    let strings: Vec<JsString> = v["strings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| JsString::from(s.as_str().unwrap()))
        .collect();
    let mut failures: Vec<String> = vec![];
    let mut total = 0;
    env::set_locale("en-US").unwrap();
    for (zone, data) in v["zones"].as_object().unwrap() {
        env::set_time_zone(zone).unwrap();
        for row in data["time"].as_array().unwrap() {
            total += 1;
            let r = row.as_array().unwrap();
            let tv = Date::new(num(&r[0])).time();
            let mut got: Vec<String> = GETTERS
                .iter()
                .map(|g| runic_js::number_to_string(date::get(tv, g)))
                .collect();
            got.push(date::to_string(tv).to_rust());
            got.push(date::to_date_string_local(tv).to_rust());
            got.push(date::to_time_string(tv).to_rust());
            got.push(date::to_utc_string(tv).to_rust());
            got.push(date::to_iso_string(tv).map_or("null".into(), |s| s.to_rust()));
            got.push(date::to_json(tv).map_or("null".into(), |s| s.to_rust()));
            // Getter results are String(number), as number_to_string prints.
            let want: Vec<String> = r[1..]
                .iter()
                .map(|x| x.as_str().map_or("null".into(), str::to_string))
                .collect();
            if got != want {
                failures.push(format!("{zone} t={}: want {want:?}\n   got {got:?}", r[0]));
            }
        }
        for row in data["local"].as_array().unwrap() {
            total += 1;
            let a: Vec<f64> = row[0].as_array().unwrap().iter().map(num).collect();
            let local = date::local_time_value(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
            let utc = date::utc_time_value(a[0], a[1], a[2], a[3], a[4], a[5], a[6]);
            let (want_local, want_utc) = (num(&row[1]), num(&row[2]));
            if !same(local, want_local) || !same(utc, want_utc) {
                failures.push(format!(
                    "{zone} new Date({a:?}): want {want_local} / UTC {want_utc}, got {local} / {utc}"
                ));
            }
        }
        for row in data["set"].as_array().unwrap() {
            total += 1;
            let t = num(&row[0]);
            let name = row[1].as_str().unwrap();
            let args: Vec<f64> = row[2].as_array().unwrap().iter().map(num).collect();
            let d = Date::new(t);
            let got = d.set(name, &args);
            let want = num(&row[3]);
            if !same(got, want) || !same(d.time(), want) {
                failures.push(format!(
                    "{zone} new Date({t}).{name}({args:?}): want {want}, got {got}"
                ));
            }
        }
        for (s, want) in strings.iter().zip(data["parse"].as_array().unwrap()) {
            total += 1;
            let got = date::parse(s);
            let want = num(want);
            if !same(got, want) {
                failures.push(format!(
                    "{zone} Date.parse({:?}): want {want}, got {got}",
                    s.to_rust()
                ));
            }
        }
    }
    assert!(total > 25_000, "only {total} date vectors");
    if !failures.is_empty() {
        panic!(
            "{} of {total} date vectors differ:\n{}",
            failures.len(),
            failures[..failures.len().min(40)].join("\n")
        );
    }
}
