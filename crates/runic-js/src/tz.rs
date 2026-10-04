//! Time zones for `Date` local time and `Intl.DateTimeFormat` (M5).
//!
//! Offsets come from the IANA database bundled with `jiff` (rearguard data,
//! like ICU's: Europe/Dublin observes daylight saving time in summer), so
//! they never depend on the host's zoneinfo files. The conversions follow
//! V8 with ICU time zone data:
//!
//! - UTC to local: the zone's offset at the instant (ICU `getOffset`);
//! - local to UTC: ICU `getOffsetFromLocal` with `UCAL_TZ_LOCAL_FORMER` for
//!   skipped and repeated local times, i.e. the offset before the
//!   transition (a skipped time moves forward, a repeated time takes its
//!   first occurrence);
//! - daylight saving time: a non-zero DST part of the offset.
//!
//! The database covers years -9999 to 9999; instants outside are moved by
//! whole 400-year Gregorian cycles (which repeat weekdays exactly), so the
//! zone's final rule (or its first offset) continues as in ICU.

use jiff::civil::DateTime;
use jiff::tz::{AmbiguousOffset, TimeZone};

const MS_PER_DAY: i64 = 86_400_000;
/// A 400-year Gregorian cycle in milliseconds.
const CYCLE_MS: i64 = 146_097 * MS_PER_DAY;
/// The range moved into (about years -8960 to 9000).
const LOW_MS: i64 = -345_000_000_000_000;
const HIGH_MS: i64 = 222_000_000_000_000;

/// A time zone: the IANA name it was opened with and its rules.
#[derive(Clone, Debug)]
pub struct Zone {
    name: String,
    tz: TimeZone,
}

impl PartialEq for Zone {
    fn eq(&self, other: &Zone) -> bool {
        self.name == other.name
    }
}

/// Moves `t` (ms) into the database's range by whole 400-year cycles.
fn in_range(t: i64) -> i64 {
    // Both differences are positive here.
    let cycles = |d: i64| (d + CYCLE_MS - 1) / CYCLE_MS;
    if t < LOW_MS {
        t + cycles(LOW_MS - t) * CYCLE_MS
    } else if t > HIGH_MS {
        t - cycles(t - HIGH_MS) * CYCLE_MS
    } else {
        t
    }
}

impl Zone {
    /// UTC.
    pub fn utc() -> Zone {
        Zone {
            name: "UTC".into(),
            tz: TimeZone::UTC,
        }
    }

    /// The zone with IANA name `name` (case-sensitive, as in the database),
    /// or `None` when the bundled database does not know it.
    pub fn named(name: &str) -> Option<Zone> {
        if name == "UTC" {
            return Some(Zone::utc());
        }
        let tz = jiff::tz::db().get(name).ok()?;
        Some(Zone {
            name: name.into(),
            tz,
        })
    }

    /// The IANA name the zone was opened with.
    pub fn name(&self) -> &str {
        &self.name
    }

    /// Every zone name of the bundled database.
    pub fn names() -> Vec<String> {
        jiff::tz::db()
            .available()
            .map(|n| n.as_str().to_string())
            .collect()
    }

    fn info(&self, t_ms: i64) -> (i64, bool) {
        let t = in_range(t_ms);
        let ts = jiff::Timestamp::from_millisecond(t).expect("instant in range");
        let info = self.tz.to_offset_info(ts);
        (
            i64::from(info.offset().seconds()) * 1000,
            info.dst().is_dst(),
        )
    }

    /// The offset (ms) at UTC instant `t_ms` (V8's `LocalOffsetInMs(t, true)`).
    pub fn offset_at_utc(&self, t_ms: i64) -> i64 {
        self.info(t_ms).0
    }

    /// Whether daylight saving time is in effect at UTC instant `t_ms`.
    pub fn is_dst(&self, t_ms: i64) -> bool {
        self.info(t_ms).1
    }

    /// The offset (ms) for local time `local_ms` (V8's
    /// `LocalOffsetInMs(t, false)`: ICU's former offset in gaps and folds).
    pub fn offset_at_local(&self, local_ms: i64) -> i64 {
        let t = in_range(local_ms);
        let days = t.div_euclid(MS_PER_DAY);
        let in_day = t.rem_euclid(MS_PER_DAY);
        let (y, m, d) = crate::date::year_month_day(days);
        let dt = DateTime::new(
            y as i16,
            (m + 1) as i8,
            d as i8,
            (in_day / 3_600_000) as i8,
            (in_day / 60_000 % 60) as i8,
            (in_day / 1000 % 60) as i8,
            (in_day % 1000) as i32 * 1_000_000,
        )
        .expect("civil time in range");
        let offset = match self.tz.to_ambiguous_timestamp(dt).offset() {
            AmbiguousOffset::Unambiguous { offset } => offset,
            AmbiguousOffset::Gap { before, .. } | AmbiguousOffset::Fold { before, .. } => before,
        };
        i64::from(offset.seconds()) * 1000
    }
}
