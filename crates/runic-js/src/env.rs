//! The host environment JavaScript sees through `Date` and `Intl`: the
//! default time zone and the default locale (docs/design/M5-PLATFORM.md,
//! host services). Production takes them from the system, probes and the
//! interpreter from the case manifest (`timezone`, `locale`); both default
//! to UTC and en-US.

use crate::tz::Zone;
use std::cell::RefCell;

struct Env {
    zone: Zone,
    locale: usize,
}

thread_local! {
    static ENV: RefCell<Env> = RefCell::new(Env { zone: Zone::utc(), locale: 0 });
}

/// Sets the default time zone (an IANA name the bundled database knows).
pub fn set_time_zone(name: &str) -> Result<(), String> {
    let zone = Zone::named(name).ok_or_else(|| format!("unknown time zone {name}"))?;
    ENV.with(|e| e.borrow_mut().zone = zone);
    Ok(())
}

/// Sets the default locale (one of the verified locales,
/// `crate::intl::LOCALES`).
pub fn set_locale(tag: &str) -> Result<(), String> {
    let index = crate::intl::locale_index(tag).ok_or_else(|| {
        format!(
            "unsupported locale {tag} (verified: {})",
            crate::intl::LOCALES.join(", ")
        )
    })?;
    ENV.with(|e| e.borrow_mut().locale = index);
    Ok(())
}

/// Runs `f` with the default time zone.
pub fn with_zone<R>(f: impl FnOnce(&Zone) -> R) -> R {
    let zone = ENV.with(|e| e.borrow().zone.clone());
    f(&zone)
}

/// The index of the default locale in `crate::intl::LOCALES`.
pub fn locale() -> usize {
    ENV.with(|e| e.borrow().locale)
}

/// The name of the default time zone.
pub fn time_zone_name() -> String {
    ENV.with(|e| e.borrow().zone.name().to_string())
}

/// The platform's settings (production): the zone from `TZ` or the
/// `/etc/localtime` link, the locale from `LC_ALL`, `LC_TIME` or `LANG`.
/// Unknown zones fall back to UTC and unverified locales to en-US (with a
/// note on stderr), since no other data is verified.
pub fn init_from_system() {
    if let Some(name) = system_zone_name() {
        if set_time_zone(&name).is_err() {
            eprintln!("runic: time zone {name} is not in the bundled database; using UTC");
        }
    }
    if let Some(tag) = system_locale() {
        if set_locale(&tag).is_err() {
            eprintln!("runic: locale {tag} is not verified; using en-US");
        }
    }
}

fn system_zone_name() -> Option<String> {
    if let Ok(tz) = std::env::var("TZ") {
        let tz = tz.trim_start_matches(':');
        if !tz.is_empty() {
            let name = tz.rsplit_once("zoneinfo/").map_or(tz, |(_, n)| n);
            return Some(name.to_string());
        }
    }
    let target = std::fs::read_link("/etc/localtime").ok()?;
    let target = target.to_string_lossy().into_owned();
    target
        .rsplit_once("zoneinfo/")
        .map(|(_, name)| name.to_string())
}

fn system_locale() -> Option<String> {
    let raw = ["LC_ALL", "LC_TIME", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.is_empty())?;
    // de_DE.UTF-8@euro → de-DE
    let base = raw.split(['.', '@']).next().unwrap_or("");
    if base.is_empty() || base == "C" || base == "POSIX" {
        return None;
    }
    Some(base.replace('_', "-"))
}
