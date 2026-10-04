//! `Date` with V8's semantics (docs/IR.md, built-ins; M5).
//!
//! Time values, the day and time arithmetic (MakeDay, MakeTime, MakeDate,
//! TimeClip), local time, the getters and setters, the string forms
//! (`toString`, `toDateString`, `toTimeString`, `toUTCString`,
//! `toISOString`) and `Date.parse` follow V8 (src/date/date.cc,
//! src/date/dateparser*.{h,cc}, src/builtins/builtins-date.cc) rather than
//! re-deriving them from the specification, so V8's choices hold where the
//! specification leaves room: the legacy date formats `Date.parse` accepts
//! besides ISO strings, integer milliseconds in the local-time arithmetic,
//! and the zone name `toString` prints (V8 decides daylight saving time for
//! instants before 1970 and after 2038 in an "equivalent year").
//!
//! Local time uses the environment's zone (`crate::env`); zone names come
//! from the locale data generated from Chromium (`crate::intl`). Vectors
//! from Chromium pin all of it (tests/vectors/date.json).

use crate::tz::Zone;
use crate::{
    ArrayElement, JsResult, JsString, MapKey, StrictEq, Throw, ToJsString, ToMapKey, ToNumber,
    Truthy, TypeOf,
};
use std::cell::Cell;
use std::rc::Rc;

pub const MS_PER_DAY: i64 = 86_400_000;
const MS_PER_DAY_F: f64 = 86_400_000.0;
/// The largest time value (ECMA-262 TimeClip).
pub const MAX_TIME: f64 = 8.64e15;
/// V8's bound for local times before conversion (`kMaxTimeBeforeUTCInMs`).
const MAX_TIME_BEFORE_UTC: f64 = 8.64e15 + 30.0 * MS_PER_DAY_F;
/// V8's `kMaxEpochTimeInMs`: zone names outside [0, this] use an
/// equivalent year.
const MAX_EPOCH_TIME_MS: i64 = 2_147_483_647 * 1000;

const SHORT_WEEKDAYS: [&str; 7] = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SHORT_MONTHS: [&str; 12] = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

// ---------------------------------------------------------------------------
// Day arithmetic (V8 date.cc).

/// Days since the epoch of time `t` (floor division).
pub fn days_from_time(t: i64) -> i64 {
    t.div_euclid(MS_PER_DAY)
}

/// Milliseconds into the day.
pub fn time_in_day(t: i64) -> i64 {
    t.rem_euclid(MS_PER_DAY)
}

/// The weekday of a day number (0 = Sunday).
pub fn weekday(days: i64) -> i64 {
    (days + 4).rem_euclid(7)
}

fn is_leap(year: i64) -> bool {
    year % 4 == 0 && (year % 100 != 0 || year % 400 == 0)
}

const DAYS_IN_MONTHS: [i64; 12] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/// Year, month (0-based) and day of a day number (V8's
/// `YearMonthDayFromDays`).
pub fn year_month_day(days: i64) -> (i64, i64, i64) {
    const DAYS_IN_4_YEARS: i64 = 4 * 365 + 1;
    const DAYS_IN_100_YEARS: i64 = 25 * DAYS_IN_4_YEARS - 1;
    const DAYS_IN_400_YEARS: i64 = 4 * DAYS_IN_100_YEARS + 1;
    const DAYS_1970_TO_2000: i64 = 30 * 365 + 7;
    const DAYS_OFFSET: i64 = 1000 * DAYS_IN_400_YEARS + 5 * DAYS_IN_400_YEARS - DAYS_1970_TO_2000;
    const YEARS_OFFSET: i64 = 400_000;
    let mut days = days + DAYS_OFFSET;
    let mut year = 400 * (days / DAYS_IN_400_YEARS) - YEARS_OFFSET;
    days %= DAYS_IN_400_YEARS;
    days -= 1;
    let yd1 = days / DAYS_IN_100_YEARS;
    days %= DAYS_IN_100_YEARS;
    year += 100 * yd1;
    days += 1;
    let yd2 = days / DAYS_IN_4_YEARS;
    days %= DAYS_IN_4_YEARS;
    year += 4 * yd2;
    days -= 1;
    let yd3 = days / 365;
    days %= 365;
    year += yd3;
    let leap = (yd1 == 0 || yd2 != 0) && yd3 == 0;
    days += i64::from(leap);
    let feb_end = 31 + 28 + i64::from(leap);
    if days >= feb_end {
        days -= feb_end;
        for (i, &n) in DAYS_IN_MONTHS.iter().enumerate().skip(2) {
            if days < n {
                return (year, i as i64, days + 1);
            }
            days -= n;
        }
        unreachable!("day within the year")
    } else if days < 31 {
        (year, 0, days + 1)
    } else {
        (year, 1, days - 31 + 1)
    }
}

/// V8's `DaysFromYearMonth`.
fn days_from_year_month(year: i64, month: i64) -> i64 {
    const FROM_MONTH: [i64; 12] = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
    const FROM_MONTH_LEAP: [i64; 12] = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    let mut year = year + month / 12;
    let mut month = month % 12;
    if month < 0 {
        year -= 1;
        month += 12;
    }
    const YEAR_DELTA: i64 = 399_999;
    const BASE_DAY: i64 = 365 * (1970 + YEAR_DELTA) + (1970 + YEAR_DELTA) / 4
        - (1970 + YEAR_DELTA) / 100
        + (1970 + YEAR_DELTA) / 400;
    let y1 = year + YEAR_DELTA;
    let day_from_year = 365 * y1 + y1 / 4 - y1 / 100 + y1 / 400 - BASE_DAY;
    let table = if !is_leap(year) {
        &FROM_MONTH
    } else {
        &FROM_MONTH_LEAP
    };
    day_from_year + table[month as usize]
}

/// V8's `DoubleToInteger`: NaN is 0, infinities stay, others truncate.
pub fn double_to_integer(x: f64) -> f64 {
    if x.is_nan() {
        0.0
    } else if !x.is_finite() {
        x
    } else {
        x.trunc()
    }
}

/// MakeDay (V8: years within ±1,000,000 and months within ±10,000,000).
pub fn make_day(year: f64, month: f64, date: f64) -> f64 {
    let in_range = (-1_000_000.0..=1_000_000.0).contains(&year)
        && (-10_000_000.0..=10_000_000.0).contains(&month)
        && date.is_finite();
    if !in_range {
        return f64::NAN;
    }
    let mut y = year as i64;
    let mut m = month as i64;
    y += m / 12;
    m %= 12;
    if m < 0 {
        m += 12;
        y -= 1;
    }
    let day_from_year = days_from_year_month(y, m);
    (day_from_year - 1) as f64 + double_to_integer(date)
}

/// MakeTime.
pub fn make_time(hour: f64, min: f64, sec: f64, ms: f64) -> f64 {
    if hour.is_finite() && min.is_finite() && sec.is_finite() && ms.is_finite() {
        double_to_integer(hour) * 3_600_000.0
            + double_to_integer(min) * 60_000.0
            + double_to_integer(sec) * 1000.0
            + double_to_integer(ms)
    } else {
        f64::NAN
    }
}

/// MakeDate.
pub fn make_date(day: f64, time: f64) -> f64 {
    if day.is_finite() && time.is_finite() {
        time + day * MS_PER_DAY_F
    } else {
        f64::NAN
    }
}

/// TimeClip: NaN outside ±8.64e15, else truncated (without -0).
pub fn time_clip(t: f64) -> f64 {
    if (-MAX_TIME..=MAX_TIME).contains(&t) {
        t.trunc() + 0.0
    } else {
        f64::NAN
    }
}

// ---------------------------------------------------------------------------
// Local time.

fn to_local(zone: &Zone, t: i64) -> i64 {
    t + zone.offset_at_utc(t)
}

fn to_utc(zone: &Zone, t: i64) -> i64 {
    t - zone.offset_at_local(t)
}

/// A local time value converted to UTC and clipped (V8's
/// `SetLocalDateValue` and the constructor's conversion).
fn local_to_time_value(zone: &Zone, local: f64) -> f64 {
    if (-MAX_TIME_BEFORE_UTC..=MAX_TIME_BEFORE_UTC).contains(&local) {
        time_clip(to_utc(zone, local as i64) as f64)
    } else {
        f64::NAN
    }
}

/// The broken-down fields of a (local or UTC) time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Fields {
    pub year: i64,
    /// 0-based.
    pub month: i64,
    pub day: i64,
    pub weekday: i64,
    pub hour: i64,
    pub minute: i64,
    pub second: i64,
    pub ms: i64,
}

/// The fields of time `t` (ms, already local or UTC).
pub fn fields(t: i64) -> Fields {
    let days = days_from_time(t);
    let in_day = time_in_day(t);
    let (year, month, day) = year_month_day(days);
    Fields {
        year,
        month,
        day,
        weekday: weekday(days),
        hour: in_day / 3_600_000,
        minute: in_day / 60_000 % 60,
        second: in_day / 1000 % 60,
        ms: in_day % 1000,
    }
}

/// The local fields of time value `tv` in `zone` (None for NaN).
pub fn local_fields_in(zone: &Zone, tv: f64) -> Option<Fields> {
    (!tv.is_nan()).then(|| fields(to_local(zone, tv as i64)))
}

fn with_zone<R>(f: impl FnOnce(&Zone) -> R) -> R {
    crate::env::with_zone(f)
}

/// V8's `EquivalentYear`.
fn equivalent_year(year: i64) -> i64 {
    let week_day = weekday(days_from_year_month(year, 0));
    let recent_year = (if is_leap(year) { 1956 } else { 1967 }) + (week_day * 12) % 28;
    2008 + (recent_year + 3 * 28 - 2008) % 28
}

/// V8's `EquivalentTime`: the same date and time in an equivalent year.
fn equivalent_time(t: i64) -> i64 {
    let days = days_from_time(t);
    let in_day = t - days * MS_PER_DAY;
    let (year, month, day) = year_month_day(days);
    let new_days = days_from_year_month(equivalent_year(year), month) + day - 1;
    new_days * MS_PER_DAY + in_day
}

/// Whether `toString` names the daylight saving time of `zone` at instant
/// `t` (V8's `LocalTimezone`: outside 1970 to 2038 the equivalent year
/// decides).
pub fn names_dst(zone: &Zone, t: i64) -> bool {
    let t = if !(0..=MAX_EPOCH_TIME_MS).contains(&t) {
        equivalent_time(t)
    } else {
        t
    };
    // V8 asks for the DST offset at whole seconds.
    zone.is_dst(t / 1000 * 1000)
}

/// The zone name `toString` prints for instant `t`.
fn zone_name(zone: &Zone, t: i64) -> String {
    crate::intl::zone_display_name(zone, names_dst(zone, t), crate::env::locale())
}

// ---------------------------------------------------------------------------
// Construction.

/// `new Date(y, m, d, h, min, s, ms)` in local time (all arguments given;
/// the frontend supplies the defaults 1 and 0).
pub fn local_time_value(y: f64, m: f64, d: f64, h: f64, min: f64, s: f64, ms: f64) -> f64 {
    let local = components(y, m, d, h, min, s, ms);
    with_zone(|z| local_to_time_value(z, local))
}

/// `Date.UTC(y, m, d, h, min, s, ms)`.
pub fn utc_time_value(y: f64, m: f64, d: f64, h: f64, min: f64, s: f64, ms: f64) -> f64 {
    time_clip(components(y, m, d, h, min, s, ms))
}

fn components(y: f64, m: f64, d: f64, h: f64, min: f64, s: f64, ms: f64) -> f64 {
    let mut year = y;
    if !year.is_nan() {
        let yi = double_to_integer(year);
        if (0.0..=99.0).contains(&yi) {
            year = 1900.0 + yi;
        }
    }
    make_date(make_day(year, m, d), make_time(h, min, s, ms))
}

// ---------------------------------------------------------------------------
// Getters.

/// A getter by its JavaScript name (`getFullYear`, `getUTCHours`, …).
pub fn get(tv: f64, name: &str) -> f64 {
    if tv.is_nan() {
        return f64::NAN;
    }
    let t = tv as i64;
    if name == "getTimezoneOffset" {
        // Integer division truncates toward zero (seconds in LMT offsets).
        return with_zone(|z| ((t - to_local(z, t)) / 60_000) as f64);
    }
    let (utc, field) = match name.strip_prefix("getUTC") {
        Some(f) => (true, f),
        None => (false, name.strip_prefix("get").unwrap_or(name)),
    };
    let f = if utc {
        fields(t)
    } else {
        with_zone(|z| fields(to_local(z, t)))
    };
    (match field {
        "FullYear" => f.year,
        "Month" => f.month,
        "Date" => f.day,
        "Day" => f.weekday,
        "Hours" => f.hour,
        "Minutes" => f.minute,
        "Seconds" => f.second,
        "Milliseconds" => f.ms,
        other => panic!("unknown Date getter get{other}"),
    }) as f64
}

/// The getters `get` accepts.
pub const GETTERS: &[&str] = &[
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

/// Setters with their argument counts (minimum, maximum).
pub const SETTERS: &[(&str, usize, usize)] = &[
    ("setFullYear", 1, 3),
    ("setMonth", 1, 2),
    ("setDate", 1, 1),
    ("setHours", 1, 4),
    ("setMinutes", 1, 3),
    ("setSeconds", 1, 2),
    ("setMilliseconds", 1, 1),
    ("setUTCFullYear", 1, 3),
    ("setUTCMonth", 1, 2),
    ("setUTCDate", 1, 1),
    ("setUTCHours", 1, 4),
    ("setUTCMinutes", 1, 3),
    ("setUTCSeconds", 1, 2),
    ("setUTCMilliseconds", 1, 1),
    ("setTime", 1, 1),
];

// ---------------------------------------------------------------------------
// String forms (V8's ToDateString).

/// `%0Nd` as V8's StringStream prints it (the sign counts in the width).
fn pad(n: i64, width: usize) -> String {
    if n < 0 {
        format!("-{:0w$}", -n, w = width.saturating_sub(1))
    } else {
        format!("{n:0width$}")
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
    LocalDate,
    LocalTime,
    LocalDateAndTime,
    UtcDateAndTime,
    Iso,
}

fn to_date_string(tv: f64, mode: Mode) -> String {
    if tv.is_nan() {
        return "Invalid Date".into();
    }
    let t = tv as i64;
    with_zone(|zone| {
        let local = if matches!(mode, Mode::UtcDateAndTime | Mode::Iso) {
            t
        } else {
            to_local(zone, t)
        };
        let f = fields(local);
        let tz_offset = -((t - to_local(zone, t)) / 60_000);
        let tz_hour = tz_offset.abs() / 60;
        let tz_min = tz_offset.abs() % 60;
        let sign = if tz_offset < 0 { '-' } else { '+' };
        let wd = SHORT_WEEKDAYS[f.weekday as usize];
        let mon = SHORT_MONTHS[f.month as usize];
        let year = pad(f.year, if f.year < 0 { 5 } else { 4 });
        let time = format!("{:02}:{:02}:{:02}", f.hour, f.minute, f.second);
        match mode {
            Mode::LocalDate => format!("{wd} {mon} {:02} {year}", f.day),
            Mode::LocalTime => format!(
                "{time} GMT{sign}{tz_hour:02}{tz_min:02} ({})",
                zone_name(zone, t)
            ),
            Mode::LocalDateAndTime => format!(
                "{wd} {mon} {:02} {year} {time} GMT{sign}{tz_hour:02}{tz_min:02} ({})",
                f.day,
                zone_name(zone, t)
            ),
            Mode::UtcDateAndTime => format!("{wd}, {:02} {mon} {year} {time} GMT", f.day),
            Mode::Iso => {
                let year = if (0..=9999).contains(&f.year) {
                    format!("{:04}", f.year)
                } else if f.year < 0 {
                    format!("-{:06}", -f.year)
                } else {
                    format!("+{:06}", f.year)
                };
                format!("{year}-{:02}-{:02}T{time}.{:03}Z", f.month + 1, f.day, f.ms)
            }
        }
    })
}

/// `Date.prototype.toString`.
pub fn to_string(tv: f64) -> JsString {
    JsString::from(to_date_string(tv, Mode::LocalDateAndTime))
}

/// `Date.prototype.toDateString`.
pub fn to_date_string_local(tv: f64) -> JsString {
    JsString::from(to_date_string(tv, Mode::LocalDate))
}

/// `Date.prototype.toTimeString`.
pub fn to_time_string(tv: f64) -> JsString {
    JsString::from(to_date_string(tv, Mode::LocalTime))
}

/// `Date.prototype.toUTCString` (and `toGMTString`).
pub fn to_utc_string(tv: f64) -> JsString {
    JsString::from(to_date_string(tv, Mode::UtcDateAndTime))
}

/// `Date.prototype.toISOString`: RangeError for an invalid date.
pub fn to_iso_string(tv: f64) -> JsResult<JsString> {
    if tv.is_nan() {
        return Err(Throw::range_error("Invalid time value"));
    }
    Ok(JsString::from(to_date_string(tv, Mode::Iso)))
}

/// `Date.prototype.toJSON`: null for an invalid date.
pub fn to_json(tv: f64) -> Option<JsString> {
    (!tv.is_nan()).then(|| JsString::from(to_date_string(tv, Mode::Iso)))
}

// ---------------------------------------------------------------------------
// The Date object.

/// A `Date` object: a mutable time value with identity.
#[derive(Clone)]
pub struct Date(Rc<Cell<f64>>);

impl Date {
    /// `new Date(tv)`: the time value after TimeClip.
    pub fn new(tv: f64) -> Date {
        Date(Rc::new(Cell::new(time_clip(tv))))
    }
    /// The time value (`getTime`, `valueOf`).
    pub fn time(&self) -> f64 {
        self.0.get()
    }

    /// A setter by its JavaScript name; `args` are the given arguments.
    /// Returns the new time value.
    pub fn set(&self, name: &str, args: &[f64]) -> f64 {
        let v = setter(self.time(), name, args);
        self.0.set(v);
        v
    }
}

/// The time value a setter produces from `tv` (V8's builtins).
pub fn setter(tv: f64, name: &str, args: &[f64]) -> f64 {
    let arg = |i: usize| args.get(i).copied();
    let a0 = arg(0).unwrap_or(f64::NAN);
    if name == "setTime" {
        return time_clip(a0);
    }
    let utc = name.starts_with("setUTC");
    let field = name
        .strip_prefix(if utc { "setUTC" } else { "set" })
        .unwrap_or(name);
    let finish = |zone: &Zone, v: f64| {
        if utc {
            time_clip(v)
        } else {
            local_to_time_value(zone, v)
        }
    };
    with_zone(|zone| {
        let local = |t: i64| if utc { t } else { to_local(zone, t) };
        if field == "FullYear" {
            // An invalid date starts from local (or UTC) 1 January, midnight.
            let (mut month, mut day, mut in_day) = (0.0, 1.0, 0i64);
            if !tv.is_nan() {
                let l = local(tv as i64);
                let days = days_from_time(l);
                in_day = l - days * MS_PER_DAY;
                let (_, m, d) = year_month_day(days);
                month = m as f64;
                day = d as f64;
            }
            if let Some(m) = arg(1) {
                month = m;
                if let Some(d) = arg(2) {
                    day = d;
                }
            }
            return finish(zone, make_date(make_day(a0, month, day), in_day as f64));
        }
        if tv.is_nan() {
            return f64::NAN;
        }
        let l = local(tv as i64);
        let days = days_from_time(l);
        let in_day = l - days * MS_PER_DAY;
        let h = (in_day / 3_600_000) as f64;
        let m = (in_day / 60_000 % 60) as f64;
        let s = (in_day / 1000 % 60) as f64;
        let ms = (in_day % 1000) as f64;
        let (year, month, day) = year_month_day(days);
        let days = days as f64;
        let v = match field {
            "Date" => make_date(make_day(year as f64, month as f64, a0), in_day as f64),
            "Month" => make_date(
                make_day(year as f64, a0, arg(1).unwrap_or(day as f64)),
                in_day as f64,
            ),
            "Hours" => make_date(
                days,
                make_time(
                    a0,
                    arg(1).unwrap_or(m),
                    arg(2).unwrap_or(s),
                    arg(3).unwrap_or(ms),
                ),
            ),
            "Minutes" => make_date(
                days,
                make_time(h, a0, arg(1).unwrap_or(s), arg(2).unwrap_or(ms)),
            ),
            "Seconds" => make_date(days, make_time(h, m, a0, arg(1).unwrap_or(ms))),
            "Milliseconds" => make_date(days, make_time(h, m, s, a0)),
            other => panic!("unknown Date setter set{other}"),
        };
        finish(zone, v)
    })
}

impl std::fmt::Debug for Date {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Date({})", self.time())
    }
}

impl Default for Date {
    /// An invalid date (placeholders for unassigned locals).
    fn default() -> Self {
        Date::new(f64::NAN)
    }
}

impl PartialEq for Date {
    fn eq(&self, other: &Self) -> bool {
        Rc::ptr_eq(&self.0, &other.0)
    }
}
impl ToJsString for Date {
    fn to_js_string(&self) -> JsString {
        to_string(self.time())
    }
}
impl Truthy for Date {
    fn truthy(&self) -> bool {
        true
    }
}
impl ArrayElement for Date {
    fn join_string(&self) -> JsString {
        self.to_js_string()
    }
}
impl ToNumber for Date {
    fn to_number(&self) -> f64 {
        self.time()
    }
}
impl TypeOf for Date {
    fn type_of(&self) -> &'static str {
        "object"
    }
}
impl StrictEq for Date {
    fn strict_eq(&self, other: &Self) -> bool {
        self == other
    }
}
impl ToMapKey for Date {
    fn map_key(&self) -> MapKey {
        MapKey::Ref(Rc::as_ptr(&self.0) as *const u8 as usize)
    }
}
impl crate::Own for Date {}

// ---------------------------------------------------------------------------
// Date.parse (V8's DateParser).

/// `Date.parse(s)`.
pub fn parse(s: &JsString) -> f64 {
    let Some(out) = parser::parse(s.units()) else {
        return f64::NAN;
    };
    let day = make_day(out.year, out.month, out.day);
    let time = make_time(out.hour, out.minute, out.second, out.ms);
    let date = make_date(day, time);
    match out.offset {
        None => {
            if !(-MAX_TIME_BEFORE_UTC..=MAX_TIME_BEFORE_UTC).contains(&date) {
                return f64::NAN;
            }
            with_zone(|z| time_clip(to_utc(z, date as i64) as f64))
        }
        Some(offset) => time_clip(date - offset * 1000.0),
    }
}

/// Whether `s` is a string `Date.parse` reads in ISO form (an ES5 date
/// time string), for which the frontend accepts literals.
pub fn is_iso(s: &JsString) -> bool {
    parser::parse_iso_only(s.units())
}

mod parser {
    //! A port of V8's src/date/dateparser*.{h,cc} over UTF-16 code units.

    const NONE: i32 = i32::MAX;
    const MAX_SIGNIFICANT_DIGITS: usize = 9;
    /// V8's Smi range with pointer compression (31-bit Smis).
    const SMI_MAX: u32 = (1 << 30) - 1;

    pub struct Output {
        pub year: f64,
        pub month: f64,
        pub day: f64,
        pub hour: f64,
        pub minute: f64,
        pub second: f64,
        pub ms: f64,
        /// Seconds east of UTC, or None for local time.
        pub offset: Option<f64>,
    }

    fn between(x: i32, lo: i32, hi: i32) -> bool {
        (x.wrapping_sub(lo) as u32) <= (hi.wrapping_sub(lo) as u32)
    }

    /// ECMAScript WhiteSpace (V8's `IsWhiteSpace`).
    fn is_white_space(c: u32) -> bool {
        matches!(
            c,
            0x09 | 0x0B | 0x0C | 0x20 | 0xA0 | 0xFEFF | 0x1680 | 0x2000
                ..=0x200A | 0x202F | 0x205F | 0x3000
        )
    }

    fn is_line_terminator(c: u32) -> bool {
        matches!(c, 0x0A | 0x0D | 0x2028 | 0x2029)
    }

    struct Reader<'a> {
        index: usize,
        buffer: &'a [u16],
        ch: u32,
    }

    impl<'a> Reader<'a> {
        fn new(buffer: &'a [u16]) -> Self {
            let mut r = Reader {
                index: 0,
                buffer,
                ch: 0,
            };
            r.next();
            r
        }
        fn position(&self) -> usize {
            self.index
        }
        fn next(&mut self) {
            self.ch = self.buffer.get(self.index).map_or(0, |&u| u32::from(u));
            self.index += 1;
        }
        fn read_unsigned_numeral(&mut self) -> i32 {
            let mut n: i32 = 0;
            let mut i = 0;
            while self.ch == u32::from(b'0') {
                self.next();
            }
            while self.is_digit() {
                if i < MAX_SIGNIFICANT_DIGITS {
                    n = n * 10 + (self.ch - u32::from(b'0')) as i32;
                }
                i += 1;
                self.next();
            }
            n
        }
        fn read_word(&mut self, prefix: &mut [u32; 3]) -> i32 {
            let mut len = 0;
            while self.is_alpha_or_above() && !is_white_space(self.ch) {
                if len < 3 {
                    prefix[len] = self.ch | 0x20;
                }
                len += 1;
                self.next();
            }
            for p in prefix.iter_mut().skip(len) {
                *p = 0;
            }
            len as i32
        }
        fn skip(&mut self, c: u8) -> bool {
            if self.ch == u32::from(c) {
                self.next();
                true
            } else {
                false
            }
        }
        fn skip_white_space(&mut self) -> bool {
            if is_white_space(self.ch) || is_line_terminator(self.ch) {
                self.next();
                true
            } else {
                false
            }
        }
        fn skip_parentheses(&mut self) -> bool {
            if self.ch != u32::from(b'(') {
                return false;
            }
            let mut balance = 0;
            loop {
                if self.ch == u32::from(b')') {
                    balance -= 1;
                } else if self.ch == u32::from(b'(') {
                    balance += 1;
                }
                self.next();
                if !(balance > 0 && self.ch != 0) {
                    break;
                }
            }
            true
        }
        fn is_end(&self) -> bool {
            self.ch == 0
        }
        fn is_digit(&self) -> bool {
            (u32::from(b'0')..=u32::from(b'9')).contains(&self.ch)
        }
        fn is_alpha_or_above(&self) -> bool {
            self.ch >= u32::from(b'A')
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Keyword {
        Invalid,
        MonthName,
        TimeZoneName,
        TimeSeparator,
        AmPm,
    }

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum Token {
        Invalid,
        Unknown,
        WhiteSpace,
        Number {
            value: i32,
            length: i32,
        },
        Symbol(u8),
        End,
        Keyword {
            kind: Keyword,
            value: i32,
            length: i32,
        },
    }

    impl Token {
        fn is_number(self) -> bool {
            matches!(self, Token::Number { .. })
        }
        fn number(self) -> i32 {
            match self {
                Token::Number { value, .. } => value,
                _ => unreachable!("a number token"),
            }
        }
        fn is_fixed_length_number(self, n: i32) -> bool {
            matches!(self, Token::Number { length, .. } if length == n)
        }
        fn is_symbol(self, c: u8) -> bool {
            self == Token::Symbol(c)
        }
        fn is_sign(self) -> bool {
            matches!(self, Token::Symbol(b'-' | b'+'))
        }
        fn sign(self) -> i32 {
            match self {
                Token::Symbol(c) => 44 - i32::from(c),
                _ => unreachable!("a sign"),
            }
        }
        fn is_keyword_type(self, k: Keyword) -> bool {
            matches!(self, Token::Keyword { kind, .. } if kind == k)
        }
        fn is_keyword_z(self) -> bool {
            matches!(
                self,
                Token::Keyword {
                    kind: Keyword::TimeZoneName,
                    value: 0,
                    length: 1
                }
            )
        }
    }

    const KEYWORDS: &[([u8; 3], Keyword, i32)] = &[
        (*b"jan", Keyword::MonthName, 1),
        (*b"feb", Keyword::MonthName, 2),
        (*b"mar", Keyword::MonthName, 3),
        (*b"apr", Keyword::MonthName, 4),
        (*b"may", Keyword::MonthName, 5),
        (*b"jun", Keyword::MonthName, 6),
        (*b"jul", Keyword::MonthName, 7),
        (*b"aug", Keyword::MonthName, 8),
        (*b"sep", Keyword::MonthName, 9),
        (*b"oct", Keyword::MonthName, 10),
        (*b"nov", Keyword::MonthName, 11),
        (*b"dec", Keyword::MonthName, 12),
        (*b"am\0", Keyword::AmPm, 0),
        (*b"pm\0", Keyword::AmPm, 12),
        (*b"ut\0", Keyword::TimeZoneName, 0),
        (*b"utc", Keyword::TimeZoneName, 0),
        (*b"z\0\0", Keyword::TimeZoneName, 0),
        (*b"gmt", Keyword::TimeZoneName, 0),
        (*b"cdt", Keyword::TimeZoneName, -5),
        (*b"cst", Keyword::TimeZoneName, -6),
        (*b"edt", Keyword::TimeZoneName, -4),
        (*b"est", Keyword::TimeZoneName, -5),
        (*b"mdt", Keyword::TimeZoneName, -6),
        (*b"mst", Keyword::TimeZoneName, -7),
        (*b"pdt", Keyword::TimeZoneName, -7),
        (*b"pst", Keyword::TimeZoneName, -8),
        (*b"t\0\0", Keyword::TimeSeparator, 0),
    ];

    fn lookup(prefix: &[u32; 3], len: i32) -> (Keyword, i32) {
        for (word, kind, value) in KEYWORDS {
            let matched = (0..3).all(|j| prefix[j] == u32::from(word[j]));
            if matched && (len <= 3 || *kind == Keyword::MonthName) {
                return (*kind, *value);
            }
        }
        (Keyword::Invalid, 0)
    }

    struct Tokenizer<'a> {
        input: Reader<'a>,
        next: Token,
    }

    impl<'a> Tokenizer<'a> {
        fn new(input: Reader<'a>) -> Self {
            let mut t = Tokenizer {
                input,
                next: Token::End,
            };
            t.next = t.scan();
            t
        }
        fn next(&mut self) -> Token {
            let result = self.next;
            self.next = self.scan();
            result
        }
        fn peek(&self) -> Token {
            self.next
        }
        fn skip_symbol(&mut self, c: u8) -> bool {
            if self.next.is_symbol(c) {
                self.next = self.scan();
                true
            } else {
                false
            }
        }
        fn scan(&mut self) -> Token {
            let input = &mut self.input;
            let pre = input.position();
            if input.is_end() {
                return Token::End;
            }
            if input.is_digit() {
                let value = input.read_unsigned_numeral();
                let length = (input.position() - pre) as i32;
                return Token::Number { value, length };
            }
            for c in [b':', b'-', b'+', b'.', b')'] {
                if input.skip(c) {
                    return Token::Symbol(c);
                }
            }
            if input.is_alpha_or_above() && !is_white_space(input.ch) {
                let mut prefix = [0u32; 3];
                let length = input.read_word(&mut prefix);
                let (kind, value) = lookup(&prefix, length);
                return Token::Keyword {
                    kind,
                    value,
                    length,
                };
            }
            if input.skip_white_space() {
                return Token::WhiteSpace;
            }
            if input.skip_parentheses() {
                return Token::Unknown;
            }
            input.next();
            Token::Unknown
        }
    }

    struct TimeZoneComposer {
        sign: i32,
        hour: i32,
        minute: i32,
    }

    impl TimeZoneComposer {
        fn set(&mut self, offset_in_hours: i32) {
            self.sign = if offset_in_hours < 0 { -1 } else { 1 };
            self.hour = offset_in_hours * self.sign;
            self.minute = 0;
        }
        fn set_sign(&mut self, sign: i32) {
            self.sign = if sign < 0 { -1 } else { 1 };
        }
        fn is_expecting(&self, n: i32) -> bool {
            self.hour != NONE && self.minute == NONE && between(n, 0, 59)
        }
        fn is_utc(&self) -> bool {
            self.hour == 0 && self.minute == 0
        }
        fn is_empty(&self) -> bool {
            self.hour == NONE
        }
        fn write(&mut self) -> Option<Option<f64>> {
            if self.sign == NONE {
                return Some(None);
            }
            if self.hour == NONE {
                self.hour = 0;
            }
            if self.minute == NONE {
                self.minute = 0;
            }
            let total = (self.hour as u32)
                .wrapping_mul(3600)
                .wrapping_add((self.minute as u32).wrapping_mul(60));
            if total > SMI_MAX {
                return None;
            }
            let mut total = total as i32;
            if self.sign < 0 {
                total = -total;
            }
            Some(Some(f64::from(total)))
        }
    }

    struct TimeComposer {
        comp: [i32; 4],
        index: usize,
        hour_offset: i32,
    }

    impl TimeComposer {
        fn is_empty(&self) -> bool {
            self.index == 0
        }
        fn is_expecting(&self, n: i32) -> bool {
            (self.index == 1 && between(n, 0, 59))
                || (self.index == 2 && between(n, 0, 59))
                || (self.index == 3 && between(n, 0, 999))
        }
        fn add(&mut self, n: i32) -> bool {
            if self.index < 4 {
                self.comp[self.index] = n;
                self.index += 1;
                true
            } else {
                false
            }
        }
        fn add_final(&mut self, n: i32) -> bool {
            if !self.add(n) {
                return false;
            }
            while self.index < 4 {
                self.comp[self.index] = 0;
                self.index += 1;
            }
            true
        }
        fn write(&mut self, out: &mut Output) -> bool {
            while self.index < 4 {
                self.comp[self.index] = 0;
                self.index += 1;
            }
            let [mut hour, minute, second, ms] = self.comp;
            if self.hour_offset != NONE {
                if !between(hour, 0, 12) {
                    return false;
                }
                hour %= 12;
                hour += self.hour_offset;
            }
            if (!between(hour, 0, 23)
                || !between(minute, 0, 59)
                || !between(second, 0, 59)
                || !between(ms, 0, 999))
                && (hour != 24 || minute != 0 || second != 0 || ms != 0)
            {
                return false;
            }
            out.hour = f64::from(hour);
            out.minute = f64::from(minute);
            out.second = f64::from(second);
            out.ms = f64::from(ms);
            true
        }
    }

    struct DayComposer {
        comp: [i32; 3],
        index: usize,
        named_month: i32,
        is_iso_date: bool,
    }

    fn is_month(x: i32) -> bool {
        between(x, 1, 12)
    }
    fn is_day(x: i32) -> bool {
        between(x, 1, 31)
    }

    impl DayComposer {
        fn is_empty(&self) -> bool {
            self.index == 0
        }
        fn add(&mut self, n: i32) -> bool {
            if self.index < 3 {
                self.comp[self.index] = n;
                self.index += 1;
                true
            } else {
                false
            }
        }
        fn write(&mut self, out: &mut Output) -> bool {
            if self.index < 1 {
                return false;
            }
            while self.index < 3 {
                self.comp[self.index] = 1;
                self.index += 1;
            }
            let mut year = 0;
            let month;
            let day;
            if self.named_month == NONE {
                if self.is_iso_date || (self.index == 3 && !is_day(self.comp[0])) {
                    year = self.comp[0];
                    month = self.comp[1];
                    day = self.comp[2];
                } else {
                    month = self.comp[0];
                    day = self.comp[1];
                    if self.index == 3 {
                        year = self.comp[2];
                    }
                }
            } else {
                month = self.named_month;
                if self.index == 1 {
                    day = self.comp[0];
                } else if !is_day(self.comp[0]) {
                    year = self.comp[0];
                    day = self.comp[1];
                } else {
                    day = self.comp[0];
                    year = self.comp[1];
                }
            }
            if !self.is_iso_date {
                if between(year, 0, 49) {
                    year += 2000;
                } else if between(year, 50, 99) {
                    year += 1900;
                }
            }
            if !(-(1 << 30)..(1 << 30)).contains(&year) || !is_month(month) || !is_day(day) {
                return false;
            }
            out.year = f64::from(year);
            out.month = f64::from(month - 1);
            out.day = f64::from(day);
            true
        }
    }

    fn read_milliseconds(token: Token) -> i32 {
        let Token::Number { value, length } = token else {
            unreachable!("a number token")
        };
        let mut number = value;
        let mut length = length;
        if length < 3 {
            if length == 1 {
                number *= 100;
            } else if length == 2 {
                number *= 10;
            }
        } else if length > 3 {
            if length > MAX_SIGNIFICANT_DIGITS as i32 {
                length = MAX_SIGNIFICANT_DIGITS as i32;
            }
            let mut factor = 1;
            loop {
                factor *= 10;
                length -= 1;
                if length <= 3 {
                    break;
                }
            }
            number /= factor;
        }
        number
    }

    struct State<'a> {
        scanner: Tokenizer<'a>,
        day: DayComposer,
        time: TimeComposer,
        tz: TimeZoneComposer,
    }

    fn new_state(s: &[u16]) -> State<'_> {
        State {
            scanner: Tokenizer::new(Reader::new(s)),
            day: DayComposer {
                comp: [0; 3],
                index: 0,
                named_month: NONE,
                is_iso_date: false,
            },
            time: TimeComposer {
                comp: [0; 4],
                index: 0,
                hour_offset: NONE,
            },
            tz: TimeZoneComposer {
                sign: NONE,
                hour: NONE,
                minute: NONE,
            },
        }
    }

    /// V8's `ParseES5DateTime`.
    fn parse_es5(st: &mut State) -> Token {
        let scanner = &mut st.scanner;
        let (day, time, tz) = (&mut st.day, &mut st.time, &mut st.tz);
        if scanner.peek().is_sign() {
            let sign_token = scanner.next();
            if !scanner.peek().is_fixed_length_number(6) {
                return sign_token;
            }
            let sign = sign_token.sign();
            let year = scanner.next().number();
            if sign < 0 && year == 0 {
                return sign_token;
            }
            day.add(sign * year);
        } else if scanner.peek().is_fixed_length_number(4) {
            day.add(scanner.next().number());
        } else {
            return scanner.next();
        }
        if scanner.skip_symbol(b'-') {
            if !scanner.peek().is_fixed_length_number(2) || !is_month(scanner.peek().number()) {
                return scanner.next();
            }
            day.add(scanner.next().number());
            if scanner.skip_symbol(b'-') {
                if !scanner.peek().is_fixed_length_number(2) || !is_day(scanner.peek().number()) {
                    return scanner.next();
                }
                day.add(scanner.next().number());
            }
        }
        if !scanner.peek().is_keyword_type(Keyword::TimeSeparator) {
            if scanner.peek() != Token::End {
                return scanner.next();
            }
        } else {
            scanner.next();
            if !scanner.peek().is_fixed_length_number(2) || !between(scanner.peek().number(), 0, 24)
            {
                return Token::Invalid;
            }
            let hour_is_24 = scanner.peek().number() == 24;
            time.add(scanner.next().number());
            if !scanner.skip_symbol(b':') {
                return Token::Invalid;
            }
            if !scanner.peek().is_fixed_length_number(2)
                || !between(scanner.peek().number(), 0, 59)
                || (hour_is_24 && scanner.peek().number() > 0)
            {
                return Token::Invalid;
            }
            time.add(scanner.next().number());
            if scanner.skip_symbol(b':') {
                if !scanner.peek().is_fixed_length_number(2)
                    || !between(scanner.peek().number(), 0, 59)
                    || (hour_is_24 && scanner.peek().number() > 0)
                {
                    return Token::Invalid;
                }
                time.add(scanner.next().number());
                if scanner.skip_symbol(b'.') {
                    if !scanner.peek().is_number() || (hour_is_24 && scanner.peek().number() > 0) {
                        return Token::Invalid;
                    }
                    time.add(read_milliseconds(scanner.next()));
                }
            }
            if scanner.peek().is_keyword_z() {
                scanner.next();
                tz.set(0);
            } else if scanner.peek().is_symbol(b'+') || scanner.peek().is_symbol(b'-') {
                tz.set_sign(if scanner.next() == Token::Symbol(b'+') {
                    1
                } else {
                    -1
                });
                if scanner.peek().is_fixed_length_number(4) {
                    let hourmin = scanner.next().number();
                    let (hour, min) = (hourmin / 100, hourmin % 100);
                    if !between(hour, 0, 23) || !between(min, 0, 59) {
                        return Token::Invalid;
                    }
                    tz.hour = hour;
                    tz.minute = min;
                } else {
                    if !scanner.peek().is_fixed_length_number(2)
                        || !between(scanner.peek().number(), 0, 23)
                    {
                        return Token::Invalid;
                    }
                    tz.hour = scanner.next().number();
                    if !scanner.skip_symbol(b':') {
                        return Token::Invalid;
                    }
                    if !scanner.peek().is_fixed_length_number(2)
                        || !between(scanner.peek().number(), 0, 59)
                    {
                        return Token::Invalid;
                    }
                    tz.minute = scanner.next().number();
                }
            }
            if scanner.peek() != Token::End {
                return Token::Invalid;
            }
        }
        if tz.is_empty() && time.is_empty() {
            tz.set(0);
        }
        day.is_iso_date = true;
        Token::End
    }

    /// Whether `s` is a complete ES5 date time string.
    pub fn parse_iso_only(s: &[u16]) -> bool {
        let mut st = new_state(s);
        if parse_es5(&mut st) != Token::End {
            return false;
        }
        let mut out = empty();
        st.day.write(&mut out) && st.time.write(&mut out) && st.tz.write().is_some()
    }

    fn empty() -> Output {
        Output {
            year: 0.0,
            month: 0.0,
            day: 0.0,
            hour: 0.0,
            minute: 0.0,
            second: 0.0,
            ms: 0.0,
            offset: None,
        }
    }

    /// V8's `DateParser::Parse`.
    pub fn parse(s: &[u16]) -> Option<Output> {
        let mut st = new_state(s);
        let next_unhandled = parse_es5(&mut st);
        if next_unhandled == Token::Invalid {
            return None;
        }
        let State {
            scanner,
            day,
            time,
            tz,
        } = &mut st;
        let mut has_read_number = !day.is_empty();
        let mut token = next_unhandled;
        while token != Token::End {
            match token {
                Token::Number { value: n, .. } => {
                    has_read_number = true;
                    if scanner.skip_symbol(b':') {
                        if scanner.skip_symbol(b':') {
                            if !time.is_empty() {
                                return None;
                            }
                            time.add(n);
                            time.add(0);
                        } else {
                            if !time.add(n) {
                                return None;
                            }
                            if scanner.peek().is_symbol(b'.') {
                                scanner.next();
                            }
                        }
                    } else if scanner.skip_symbol(b'.') && time.is_expecting(n) {
                        time.add(n);
                        if !scanner.peek().is_number() {
                            return None;
                        }
                        let ms = read_milliseconds(scanner.next());
                        if ms < 0 {
                            return None;
                        }
                        time.add_final(ms);
                    } else if tz.is_expecting(n) {
                        tz.minute = n;
                    } else if time.is_expecting(n) {
                        time.add_final(n);
                        let peek = scanner.peek();
                        if peek != Token::End
                            && peek != Token::WhiteSpace
                            && !peek.is_keyword_z()
                            && !peek.is_sign()
                        {
                            return None;
                        }
                    } else {
                        if !day.add(n) {
                            return None;
                        }
                        scanner.skip_symbol(b'-');
                    }
                }
                Token::Keyword { kind, value, .. } => {
                    if kind == Keyword::AmPm && !time.is_empty() {
                        time.hour_offset = value;
                    } else if kind == Keyword::MonthName {
                        day.named_month = value;
                        scanner.skip_symbol(b'-');
                    } else if kind == Keyword::TimeZoneName && has_read_number {
                        tz.set(value);
                    } else {
                        if has_read_number {
                            return None;
                        }
                        if scanner.peek().is_number() {
                            return None;
                        }
                    }
                }
                t if t.is_sign() && (tz.is_utc() || !time.is_empty()) => {
                    tz.set_sign(t.sign());
                    let mut n = 0;
                    let mut length = 0;
                    if scanner.peek().is_number() {
                        let next = scanner.next();
                        if let Token::Number { value, length: l } = next {
                            n = value;
                            length = l;
                        }
                    }
                    has_read_number = true;
                    if scanner.peek().is_symbol(b':') {
                        tz.hour = n;
                        tz.minute = NONE;
                    } else if length == 2 || length == 1 {
                        tz.hour = n;
                        tz.minute = 0;
                    } else if length == 4 || length == 3 {
                        tz.hour = n / 100;
                        tz.minute = n % 100;
                    } else {
                        return None;
                    }
                }
                t if (t.is_sign() || t.is_symbol(b')')) && has_read_number => return None,
                _ => {}
            }
            token = scanner.next();
        }
        let mut out = empty();
        if !day.write(&mut out) || !time.write(&mut out) {
            return None;
        }
        out.offset = tz.write()?;
        Some(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn day_arithmetic_round_trips() {
        for days in (-1_000_000i64..1_000_000).step_by(997) {
            let (y, m, d) = year_month_day(days);
            assert_eq!(days_from_year_month(y, m) + d - 1, days);
        }
    }

    #[test]
    fn parses_iso_and_legacy_forms() {
        let p = |s: &str| parse(&JsString::from(s));
        assert_eq!(p("2026-01-02"), 1_767_312_000_000.0);
        assert_eq!(p("2026-01-02T10:00:00Z"), 1_767_348_000_000.0);
        assert_eq!(p("Fri, 02 Jan 2026 10:00:00 GMT"), 1_767_348_000_000.0);
        assert!(p("2026-13-01").is_nan());
        assert!(is_iso(&JsString::from("2026-01-02T10:00")));
        assert!(!is_iso(&JsString::from("2026/01/02")));
    }
}
