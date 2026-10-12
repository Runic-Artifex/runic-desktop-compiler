//! `Intl.DateTimeFormat` and `Date.prototype.toLocale{,Date,Time}String`.
//!
//! Options are the ECMA-402 component options (`weekday`, `year`, `month`,
//! `day`, `hour`, `minute`, `second`, `hour12`), or `dateStyle` with
//! `timeStyle` `medium`/`short` (and `hour12`), plus `timeZone`. The method
//! decides the defaults as ECMA-402's ToDateTimeOptions does; the pattern
//! comes from the generated data (date and time patterns joined by a glue
//! literal, or a stored combination).

use super::{T, data, pairs, resolve_locale};
use crate::date::{fields, time_clip};
use crate::tz::Zone;
use crate::{JsResult, JsString, Throw};

const WEEKDAY: &[&str] = &["long", "short", "narrow"];
const YEAR: &[&str] = &["numeric", "2-digit"];
const MONTH: &[&str] = &["numeric", "2-digit", "long", "short", "narrow"];
const NUMERIC: &[&str] = &["numeric", "2-digit"];
const DATE_STYLES: &[&str] = &["full", "long", "medium", "short"];
const NONE: u16 = u16::MAX;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Method {
    /// `toLocaleDateString`: required date, defaults date.
    Date,
    /// `toLocaleTimeString`: required time, defaults time.
    Time,
    /// `toLocaleString`: required any, defaults all.
    Any,
    /// `Intl.DateTimeFormat.prototype.format`: required any, defaults date.
    Format,
}

/// Parsed and resolved options of a date format.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DateSpec {
    method: Method,
    locale: Option<String>,
    time_zone: Option<String>,
    /// weekday, year, month, day, hour, minute, second: 0 absent, else the
    /// 1-based index into the option's values.
    comps: [u8; 7],
    /// 0 unset, 1 true, 2 false.
    hour12: u8,
    /// 0 none, 1 full … 4 short.
    date_style: u8,
    /// 0 none, 3 medium, 4 short.
    time_style: u8,
}

fn index_of(values: &[&str], v: &str, key: &str) -> Result<u8, String> {
    values
        .iter()
        .position(|x| *x == v)
        .map(|i| i as u8 + 1)
        .ok_or_else(|| format!("{key}: {v} is not one of {}", values.join(", ")))
}

impl DateSpec {
    /// Parses `m=d|t|a|f;loc=…;timeZone=…;<option>=<value>…` and resolves the
    /// defaults. Errors name what JavaScript would reject or what is not
    /// verified.
    pub fn parse(spec: &str) -> Result<DateSpec, String> {
        let mut s = DateSpec {
            method: Method::Format,
            locale: None,
            time_zone: None,
            comps: [0; 7],
            hour12: 0,
            date_style: 0,
            time_style: 0,
        };
        let mut method = None;
        for (k, v) in pairs(spec)? {
            match k {
                "m" => {
                    method = Some(match v {
                        "d" => Method::Date,
                        "t" => Method::Time,
                        "a" => Method::Any,
                        "f" => Method::Format,
                        _ => return Err(format!("unknown method {v}")),
                    })
                }
                "loc" => {
                    if !super::is_supported_locale(v) {
                        return Err(format!(
                            "locale {v} is not verified (verified: {})",
                            super::LOCALES.join(", ")
                        ));
                    }
                    s.locale = Some(v.to_string());
                }
                "timeZone" => {
                    if !super::is_verified_zone(v) {
                        return Err(format!(
                            "time zone {v} is not verified against Chromium (use an IANA name such as Europe/Berlin)"
                        ));
                    }
                    s.time_zone = Some(v.to_string());
                }
                "weekday" => s.comps[0] = index_of(WEEKDAY, v, k)?,
                "year" => s.comps[1] = index_of(YEAR, v, k)?,
                "month" => s.comps[2] = index_of(MONTH, v, k)?,
                "day" => s.comps[3] = index_of(NUMERIC, v, k)?,
                "hour" => s.comps[4] = index_of(NUMERIC, v, k)?,
                "minute" => s.comps[5] = index_of(NUMERIC, v, k)?,
                "second" => s.comps[6] = index_of(NUMERIC, v, k)?,
                "hour12" => {
                    s.hour12 = match v {
                        "true" => 1,
                        "false" => 2,
                        _ => return Err("hour12 is true or false".into()),
                    }
                }
                "dateStyle" => s.date_style = index_of(DATE_STYLES, v, k)?,
                "timeStyle" => {
                    s.time_style = match v {
                        "medium" => 3,
                        "short" => 4,
                        "full" | "long" => {
                            return Err(format!(
                                "timeStyle {v} shows a time zone name, which is not verified; use medium or short"
                            ));
                        }
                        _ => return Err(format!("timeStyle: {v} is not one of medium, short")),
                    }
                }
                other => return Err(format!("option {other} is not supported")),
            }
        }
        s.method = method.ok_or("missing method")?;
        let styled = s.date_style != 0 || s.time_style != 0;
        if styled && s.comps.iter().any(|&c| c != 0) {
            // TypeError in JavaScript.
            return Err("dateStyle and timeStyle cannot be combined with component options".into());
        }
        if s.method == Method::Date && s.time_style != 0 {
            return Err("toLocaleDateString does not accept timeStyle".into());
        }
        if s.method == Method::Time && s.date_style != 0 {
            return Err("toLocaleTimeString does not accept dateStyle".into());
        }
        // ToDateTimeOptions.
        let (req_date, req_time) = match s.method {
            Method::Date => (true, false),
            Method::Time => (false, true),
            Method::Any | Method::Format => (true, true),
        };
        let mut need_defaults = !styled;
        if req_date && s.comps[..4].iter().any(|&c| c != 0) {
            need_defaults = false;
        }
        if req_time && s.comps[4..].iter().any(|&c| c != 0) {
            need_defaults = false;
        }
        if need_defaults {
            let (def_date, def_time) = match s.method {
                Method::Date | Method::Format => (true, false),
                Method::Time => (false, true),
                Method::Any => (true, true),
            };
            if def_date {
                s.comps[1] = 1;
                s.comps[2] = 1;
                s.comps[3] = 1;
            }
            if def_time {
                s.comps[4] = 1;
                s.comps[5] = 1;
                s.comps[6] = 1;
            }
        }
        // Without an hour, hour12 changes nothing (checked by the generator).
        if !styled && s.comps[4] == 0 {
            s.hour12 = 0;
        }
        let locales: Vec<usize> = match &s.locale {
            Some(l) => vec![super::locale_index(l).expect("checked")],
            None => (0..data::LOCALES.len()).collect(),
        };
        for l in locales {
            if s.pattern(l).is_none() {
                return Err(format!(
                    "this option combination is not verified for {}",
                    data::LOCALES[l].tag
                ));
            }
        }
        Ok(s)
    }

    /// The method `toLocaleString`-like methods return "Invalid Date" for,
    /// where `format` throws.
    fn throws_on_invalid(&self) -> bool {
        self.method == Method::Format
    }

    /// The pattern of locale `l` as token slices (one or date, glue, time).
    fn pattern(&self, l: usize) -> Option<Vec<&'static [T]>> {
        let ld = &data::LOCALES[l];
        let id = |v: u16| (v != NONE).then(|| data::PATTERNS[v as usize]);
        if self.date_style != 0 || self.time_style != 0 {
            let p = ld.styles.iter().find(|&&(d, t, h, _)| {
                d == self.date_style && t == self.time_style && h == self.hour12
            })?;
            return Some(vec![data::PATTERNS[p.3 as usize]]);
        }
        let c = &self.comps;
        let d = ((c[0] as usize * 3 + c[1] as usize) * 6 + c[2] as usize) * 3 + c[3] as usize;
        let t =
            ((c[4] as usize * 3 + c[5] as usize) * 3 + c[6] as usize) * 3 + self.hour12 as usize;
        if d == 0 {
            return Some(vec![id(ld.time[t])?]);
        }
        if t == 0 {
            return Some(vec![id(ld.date[d])?]);
        }
        let combo = (d * 81 + t) as u32;
        if let Ok(i) = ld.overrides.binary_search_by(|o| o.0.cmp(&combo)) {
            return Some(vec![data::PATTERNS[ld.overrides[i].1 as usize]]);
        }
        let glue = ld.glue[d][usize::from(c[4] != 0)];
        if glue == NONE {
            return None;
        }
        Some(vec![
            id(ld.date[d])?,
            GLUE_TOKENS[glue as usize],
            id(ld.time[t])?,
        ])
    }
}

/// Each glue literal as a one-token pattern.
static GLUE_TOKENS: std::sync::LazyLock<Vec<&'static [T]>> = std::sync::LazyLock::new(|| {
    data::GLUES
        .iter()
        .map(|g| &*Box::leak(vec![T(0, 0, g)].into_boxed_slice()))
        .collect()
});

fn two(n: i64) -> String {
    format!("{n:02}")
}

fn render(out: &mut String, tokens: &[T], f: &crate::date::Fields) {
    let year = if f.year <= 0 { 1 - f.year } else { f.year };
    for &T(kind, aux, lit) in tokens {
        let num = |n: i64| if aux == 1 { two(n) } else { n.to_string() };
        match kind {
            0 => out.push_str(lit),
            b'y' => out.push_str(&year.to_string()),
            b'Y' => out.push_str(&two(year % 100)),
            b'M' => out.push_str(&num(f.month + 1)),
            b'L' => out.push_str(data::NAMES[aux as usize][f.month as usize]),
            b'd' => out.push_str(&num(f.day)),
            b'E' => out.push_str(data::NAMES[aux as usize][f.weekday as usize]),
            b'H' => out.push_str(&num(f.hour)),
            b'h' => out.push_str(&num(if f.hour % 12 == 0 { 12 } else { f.hour % 12 })),
            b'K' => out.push_str(&num(f.hour % 12)),
            b'k' => out.push_str(&num(if f.hour == 0 { 24 } else { f.hour })),
            b'm' => out.push_str(&num(f.minute)),
            b's' => out.push_str(&num(f.second)),
            b'a' => out.push_str(data::NAMES[aux as usize][usize::from(f.hour >= 12)]),
            other => unreachable!("pattern token {}", other as char),
        }
    }
}

/// Formats time value `tv` (a Date's, or `format`'s argument) with `spec`;
/// `locale` is a runtime locale argument.
pub fn format_date(tv: f64, spec: &DateSpec, locale: Option<&JsString>) -> JsResult<JsString> {
    let l = resolve_locale(spec.locale.as_deref(), locale)?;
    let tv = time_clip(tv);
    if tv.is_nan() {
        return if spec.throws_on_invalid() {
            Err(Throw::range_error("Invalid time value"))
        } else {
            Ok(JsString::from("Invalid Date"))
        };
    }
    let t = tv as i64;
    let offset = match &spec.time_zone {
        Some(name) => Zone::named(name).expect("verified zone").offset_at_utc(t),
        None => crate::env::with_zone(|z| z.offset_at_utc(t)),
    };
    let f = fields(t + offset);
    let mut out = String::new();
    for part in spec.pattern(l).expect("verified pattern") {
        render(&mut out, part, &f);
    }
    Ok(JsString::from(out))
}

/// `new Intl.DateTimeFormat(locale, options).format(tv)` with options known
/// only when the program runs (the `@internationalized/date` pack's
/// `DateFormatter`, frontend/packs): `spec` is an option string as
/// `DateSpec::parse` reads it. The locale is checked first, as the
/// constructor canonicalises it before it reads the options (a malformed
/// tag throws Chromium's `RangeError`); options outside the verified set
/// are unsupported (`RunicUnsupportedError`), never formatted otherwise.
pub fn format_date_runtime(tv: f64, spec: &JsString, locale: &JsString) -> JsResult<JsString> {
    resolve_locale(None, Some(locale))?;
    let spec = DateSpec::parse(&spec.to_rust())
        .map_err(|m| super::tag::unsupported(&format!("Intl.DateTimeFormat options: {m}")))?;
    format_date(tv, &spec, Some(locale))
}

/// `new Intl.DateTimeFormat().resolvedOptions().timeZone`: the default time
/// zone's name, when it is verified against Chromium (a probe's manifest
/// pins it in both); other zones are unsupported, since Chromium may
/// report another spelling of them.
pub fn default_time_zone() -> JsResult<JsString> {
    let name = crate::env::time_zone_name();
    if super::is_verified_zone(&name) {
        Ok(JsString::from(name))
    } else {
        Err(super::tag::unsupported(&format!(
            "the time zone {name} is not verified against Chromium"
        )))
    }
}
