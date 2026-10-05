//! `Intl.DisplayNames#of` for the types `region`, `script`, `currency` and
//! `language`, with `fallback` `code` or `none` and (languages)
//! `languageDisplay` `dialect` or `standard`, in the verified display
//! locales, from names read from Chromium (`locale_data.rs`).
//!
//! As V8 and ICU: regions and scripts are looked up as written (`us` has no
//! name); currencies in upper case; language tags are canonicalized, then
//! named by ICU's LocaleDisplayNames: with dialect names, a language with
//! only a script or only a region may have a name of its own (`en-US`
//! "American English"; with both, ICU's lookup never finds one), else the
//! language's name followed by the script and region names in the locale's
//! pattern, their parentheses turned into brackets. A missing name is the
//! code itself with fallback `code` and makes the result undefined with
//! `none`.

use super::locale_data::{
    COMPOSE, CURRENCIES, DIALECTS, DISPLAY_LOCALES, LANGUAGES, REGIONS, SCRIPTS, STRINGS,
};
use super::pairs;
use super::tag::{self, Kind, TagError, unsupported};
use crate::{JsResult, JsString, Throw};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Type {
    Region,
    Script,
    Currency,
    Language,
}

/// Parsed options of a display names object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NamesSpec {
    /// A literal display locale: its data column.
    locale: Option<usize>,
    kind: Type,
    /// Fallback `code` (the default) substitutes missing names.
    substitute: bool,
    dialect: bool,
}

impl NamesSpec {
    /// Parses `m=n;loc=…;type=…;fallback=…;languageDisplay=…;style=long`.
    pub fn parse(spec: &str) -> Result<NamesSpec, String> {
        let mut locale = None;
        let mut kind = None;
        let mut substitute = true;
        let mut dialect = true;
        let mut display = false;
        for (k, v) in pairs(spec)? {
            match k {
                "m" if v == "n" => {}
                "loc" => {
                    locale = Some(display_locale(v).map_err(|e| match e {
                        TagError::Invalid => {
                            format!("RangeError: {v} is not a well-formed language tag")
                        }
                        TagError::Unsupported(why) => why,
                    })?)
                }
                "type" => {
                    kind = Some(match v {
                        "region" => Type::Region,
                        "script" => Type::Script,
                        "currency" => Type::Currency,
                        "language" => Type::Language,
                        _ => {
                            return Err(format!(
                                "type {v:?} is not verified (region, script, currency and language are)"
                            ));
                        }
                    })
                }
                "fallback" => {
                    substitute = match v {
                        "code" => true,
                        "none" => false,
                        _ => return Err(format!("fallback: {v:?} is not code or none")),
                    }
                }
                "languageDisplay" => {
                    display = true;
                    dialect = match v {
                        "dialect" => true,
                        "standard" => false,
                        _ => {
                            return Err(format!(
                                "languageDisplay: {v:?} is not dialect or standard"
                            ));
                        }
                    }
                }
                "style" if v == "long" => {}
                "style" => return Err(format!("style {v:?} is not verified (long is)")),
                _ => return Err(format!("unsupported display names option {k}={v}")),
            }
        }
        let kind = kind.ok_or("TypeError: Intl.DisplayNames requires a type")?;
        if display && kind != Type::Language {
            return Err("languageDisplay applies to type language only".into());
        }
        Ok(NamesSpec {
            locale,
            kind,
            substitute,
            dialect,
        })
    }
}

/// The data column of a display locale tag.
fn display_locale(tag: &str) -> Result<usize, TagError> {
    let t = tag::parse(tag, Kind::List)?.bcp47();
    DISPLAY_LOCALES
        .iter()
        .find(|(l, _)| *l == t)
        .map(|&(_, c)| c)
        .ok_or_else(|| {
            TagError::Unsupported(format!(
                "Intl.DisplayNames for the locale {tag}: verified display locales are {}",
                DISPLAY_LOCALES
                    .iter()
                    .map(|(l, _)| *l)
                    .collect::<Vec<_>>()
                    .join(", ")
            ))
        })
}

/// Validates the locale argument of `new Intl.DisplayNames(tag, …)`.
pub fn check_display_locale(tag: &JsString) -> JsResult<()> {
    let tag = tag.to_rust();
    display_locale(&tag).map(|_| ()).map_err(|e| e.throw(&tag))
}

fn name(table: &[(&str, [u16; 5])], key: &str, column: usize) -> Option<&'static str> {
    let i = table.binary_search_by(|(k, _)| (*k).cmp(key)).ok()?;
    let s = table[i].1[column];
    (s != u16::MAX).then(|| STRINGS[usize::from(s)])
}

fn invalid_code() -> Throw {
    Throw::range_error("invalid_argument")
}

/// `Intl.DisplayNames.prototype.of`: the name, or None (undefined).
pub fn display_name(
    code: &JsString,
    spec: &NamesSpec,
    locale: Option<&JsString>,
) -> JsResult<Option<JsString>> {
    let column = match locale {
        Some(tag) => {
            let tag = tag.to_rust();
            display_locale(&tag).map_err(|e| e.throw(&tag))?
        }
        None => spec.locale.unwrap_or_else(crate::env::locale),
    };
    let code = code.to_rust();
    let all = |p: fn(u8) -> bool| code.bytes().all(p);
    let single = |table: &[(&str, [u16; 5])], key: &str| {
        Ok(match name(table, key, column) {
            Some(n) => Some(JsString::from(n)),
            None => spec.substitute.then(|| JsString::from(code.as_str())),
        })
    };
    match spec.kind {
        Type::Region => {
            if !tag::is_region(&code) {
                return Err(invalid_code());
            }
            single(REGIONS, &code)
        }
        Type::Script => {
            // V8 accepts the empty string (it has no name).
            if !code.is_empty() && (code.len() != 4 || !all(|b| b.is_ascii_alphabetic())) {
                return Err(invalid_code());
            }
            single(SCRIPTS, &code)
        }
        Type::Currency => {
            if code.len() != 3 || !all(|b| b.is_ascii_alphabetic()) {
                return Err(invalid_code());
            }
            single(CURRENCIES, &code.to_ascii_uppercase())
        }
        Type::Language => {
            let t = match tag::parse(&code, Kind::Name) {
                Ok(t) => t,
                Err(TagError::Invalid) => return Err(invalid_code()),
                Err(TagError::Unsupported(why)) => return Err(unsupported(&why)),
            };
            Ok(language_name(&t, spec, column).map(JsString::from))
        }
    }
}

/// ICU's LocaleDisplayNamesImpl::localeDisplayName.
fn language_name(t: &tag::Tag, spec: &NamesSpec, column: usize) -> Option<String> {
    // ICU names the undetermined language "root".
    let language = if t.language == "und" {
        "root"
    } else {
        t.language.as_str()
    };
    let mut script = t.script.as_deref();
    let mut region = t.region.as_deref();
    let mut base = None;
    if spec.dialect {
        // With both a script and a region ICU's lookup of the two-part keys
        // runs on a buffer that still holds the three-part key, so only
        // single qualifiers find a dialect name.
        match (script, region) {
            (Some(s), None) => {
                base = name(DIALECTS, &format!("{language}-{s}"), column);
                if base.is_some() {
                    script = None;
                }
            }
            (None, Some(r)) => {
                base = name(DIALECTS, &format!("{language}-{r}"), column);
                if base.is_some() {
                    region = None;
                }
            }
            _ => {}
        }
    }
    let lookup = |table: &[(&str, [u16; 5])], key: &str| -> Option<String> {
        match name(table, key, column) {
            Some(n) => Some(n.to_string()),
            None => spec.substitute.then(|| key.to_string()),
        }
    };
    let base = match base {
        Some(b) => b.to_string(),
        None => lookup(LANGUAGES, language)?,
    };
    let mut parts = vec![];
    if let Some(s) = script {
        parts.push(lookup(SCRIPTS, s)?);
    }
    if let Some(r) = region {
        parts.push(lookup(REGIONS, r)?);
    }
    if parts.is_empty() {
        return Some(base);
    }
    let (open, separator, close) = COMPOSE[column];
    let mut rest = parts.join(separator);
    // Parentheses inside the qualifiers become brackets (full-width ones
    // where the pattern uses full-width parentheses).
    rest = if open.contains('\u{FF08}') {
        rest.replace('\u{FF08}', "\u{FF3B}")
            .replace('\u{FF09}', "\u{FF3D}")
    } else {
        rest.replace('(', "[").replace(')', "]")
    };
    Some(format!("{base}{open}{rest}{close}"))
}
