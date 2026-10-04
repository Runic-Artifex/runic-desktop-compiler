//! Time zone samples for the locale data generator
//! (tests/vectors/intl.mjs): for every zone of the bundled database, the
//! instants Chromium is asked about and what `runic_js::tz` computes there.
//!
//!   cargo run -q -p runic-js --example zones > zones.json

use runic_js::tz::Zone;

const YEAR_MS: i64 = 31_556_952_000;

fn main() {
    // Mid-January and mid-July of sample years, 12:00 UTC.
    let mut fixed = vec![];
    for year in [
        1900, 1925, 1950, 1970, 1985, 2000, 2010, 2020, 2025, 2026, 2027, 2030, 2037, 2050, 2100,
    ] {
        for month in [0, 6] {
            let day = runic_js::date::make_day(year as f64, month as f64, 15.0);
            fixed.push(runic_js::date::make_date(day, 43_200_000.0) as i64);
        }
    }
    let mut zones = vec![];
    for name in Zone::names() {
        let Some(zone) = Zone::named(&name) else {
            continue;
        };
        let tz = jiff::tz::db().get(&name).expect("listed zone");
        // Transitions of 2025 to 2027: the instant before and at each.
        let start = jiff::Timestamp::from_millisecond(1_735_689_600_000).unwrap();
        let end = 1_830_297_600_000i64;
        let mut instants = fixed.clone();
        for t in tz.following(start) {
            let at = t.timestamp().as_millisecond();
            if at >= end {
                break;
            }
            instants.extend([at - 1, at]);
        }
        // Instants in standard and daylight saving time within V8's
        // equivalent-year range (zone names).
        let (mut std_at, mut dst_at) = (None, None);
        let mut t = 0i64;
        while t < 2_147_483_647_000 && (std_at.is_none() || dst_at.is_none()) {
            if zone.is_dst(t) {
                dst_at.get_or_insert(t);
            } else {
                std_at.get_or_insert(t);
            }
            t += YEAR_MS / 24;
        }
        for t in tz.following(jiff::Timestamp::from_millisecond(0).unwrap()) {
            let at = t.timestamp().as_millisecond();
            if at >= 2_147_483_647_000 || (std_at.is_some() && dst_at.is_some()) {
                break;
            }
            if zone.is_dst(at) {
                dst_at.get_or_insert(at);
            } else {
                std_at.get_or_insert(at);
            }
        }
        let samples: Vec<String> = instants
            .iter()
            .map(|&t| {
                let named_dst = runic_js::date::names_dst(&zone, t);
                format!("[{t},{},{}]", zone.offset_at_utc(t), u8::from(named_dst))
            })
            .collect();
        let opt = |v: Option<i64>| v.map_or("null".to_string(), |t| t.to_string());
        zones.push(format!(
            "{{\"name\":\"{name}\",\"std\":{},\"dst\":{},\"samples\":[{}]}}",
            opt(std_at),
            opt(dst_at),
            samples.join(",")
        ));
    }
    println!("[{}]", zones.join(",\n"));
}
