//! `Intl` subsets and locale-sensitive methods (docs/IR.md, `intl.*`
//! built-ins; M5): date and time formatting, number formatting and
//! collation for the verified locales.
//!
//! Formatting reproduces Chromium exactly from locale data generated from
//! Chromium itself (`data.rs`, tests/vectors/intl.mjs): ECMA-402's
//! component options select a pattern that the generator read from
//! formatToParts and checked; numbers use ICU's model (shortest round-trip
//! digits, half-expand rounding) with Chromium's symbols and affixes.
//! Collation uses ICU4X (`icu_collator`, CLDR root and tailorings), pinned
//! by vectors. Options are literal strings (`key=value;…`) that the
//! frontend builds and the validator checks with the parsers here.

mod collate;
// Generated (tests/vectors/intl.mjs); kept as written.
#[rustfmt::skip]
mod data;
mod datetime;
mod number;

pub use collate::{CollatorSpec, compare, compare_default};
pub use datetime::{DateSpec, format_date};
pub use number::{NumberSpec, format_number};

use crate::{JsResult, JsString, Throw};

/// A pattern token: kind 0 is literal text; other kinds are field letters
/// (`y` year, `Y` two-digit year, `M` month, `L` month name, `d` day, `E`
/// weekday name, `H`/`h`/`K`/`k` hour, `m` minute, `s` second, `a` day
/// period) with `aux` the name table (text fields) or 1 for two digits.
#[derive(Clone, Copy, Debug)]
pub struct T(pub u8, pub u16, pub &'static str);

/// Prefix and suffix of positive and negative numbers, with digits and
/// with NaN or infinity (ICU's currency spacing applies only next to a
/// digit).
#[derive(Clone, Copy, Debug)]
pub struct Affixes {
    pub pp: &'static str,
    pub ps: &'static str,
    pub np: &'static str,
    pub ns: &'static str,
    pub sp: &'static str,
    pub ss: &'static str,
    pub snp: &'static str,
    pub sns: &'static str,
}

#[derive(Debug)]
pub struct Currency {
    pub code: &'static str,
    pub digits: u8,
    pub symbol: Affixes,
    pub narrow: Affixes,
    pub iso: Affixes,
}

/// One locale's data.
#[derive(Debug)]
pub struct LocaleData {
    pub tag: &'static str,
    /// Date patterns by component combination (`datetime::date_index`).
    pub date: &'static [u16],
    /// Time patterns by component combination (`datetime::time_index`).
    pub time: &'static [u16],
    /// Glue between date and time, by date combination, without and with
    /// an hour.
    pub glue: &'static [[u16; 2]],
    /// Combined patterns that are not date + glue + time, by combination.
    pub overrides: &'static [(u32, u16)],
    /// (dateStyle, timeStyle, hour12, pattern).
    pub styles: &'static [(u8, u8, u8, u16)],
    pub decimal: &'static str,
    pub group: &'static str,
    pub nan: &'static str,
    pub infinity: &'static str,
    pub decimal_affixes: Affixes,
    pub percent: Affixes,
    pub currencies: &'static [Currency],
}

/// The verified locales, in data order (the default locale is index 0).
pub const LOCALES: &[&str] = &["en-US", "en-GB", "de-DE", "fr-FR", "ja-JP"];

/// The version of Chromium the locale data was read from.
pub fn data_source() -> &'static str {
    data::BROWSER
}

/// The index of a verified locale or alias (ASCII case-insensitive, `_`
/// not accepted, as BCP 47).
pub fn locale_index(tag: &str) -> Option<usize> {
    let lower = tag.to_ascii_lowercase();
    data::LOCALES
        .iter()
        .position(|l| l.tag.to_ascii_lowercase() == lower)
        .or_else(|| {
            data::ALIASES
                .iter()
                .find(|(a, _)| a.to_ascii_lowercase() == lower)
                .map(|&(_, i)| i)
        })
}

/// Whether `tag` is a verified locale or alias.
pub fn is_supported_locale(tag: &str) -> bool {
    locale_index(tag).is_some()
}

/// The locale of an operation: its literal or runtime locale argument, else
/// the default locale. A runtime tag without verified data throws (no
/// engine output is approximated).
fn resolve_locale(literal: Option<&str>, runtime: Option<&JsString>) -> JsResult<usize> {
    if let Some(tag) = runtime {
        let tag = tag.to_rust();
        return locale_index(&tag).ok_or_else(|| {
            Throw::range_error(format!(
                "Unsupported locale {tag}: runic formats only the verified locales {}",
                LOCALES.join(", ")
            ))
        });
    }
    match literal {
        Some(tag) => Ok(locale_index(tag).expect("validated locale")),
        None => Ok(crate::env::locale()),
    }
}

/// Splits an option string `key=value;…` into pairs.
pub(crate) fn pairs(spec: &str) -> Result<Vec<(&str, &str)>, String> {
    spec.split(';')
        .filter(|p| !p.is_empty())
        .map(|p| {
            p.split_once('=')
                .ok_or_else(|| format!("malformed option {p:?}"))
        })
        .collect()
}

/// The display name of `zone` in locale `locale` for `Date.prototype.toString`.
/// Zones Chromium does not know show their offset (`GMT+hh:mm`).
pub fn zone_display_name(zone: &crate::tz::Zone, dst: bool, locale: usize) -> String {
    match zone_row(zone.name()) {
        Some(row) => data::ZONE_STRINGS[row.2[locale * 2 + usize::from(dst)] as usize].to_string(),
        None => zone.name().to_string(),
    }
}

fn zone_row(name: &str) -> Option<&'static (&'static str, bool, [u16; 10])> {
    data::ZONES
        .binary_search_by(|r| r.0.cmp(name))
        .ok()
        .map(|i| &data::ZONES[i])
}

/// Whether `name` is a time zone verified against Chromium (a manifest's
/// `timezone`, an `Intl.DateTimeFormat` `timeZone` literal).
pub fn is_verified_zone(name: &str) -> bool {
    zone_row(name).is_some_and(|r| r.1)
}
