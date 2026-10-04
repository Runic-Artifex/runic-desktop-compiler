//! `String.prototype.localeCompare` and `Intl.Collator`, through ICU4X
//! with V8's mapping of the ECMA-402 options onto collator attributes
//! (src/objects/js-collator.cc): `sensitivity` base → primary strength,
//! accent → secondary, case → primary with the case level, variant (the
//! default for sorting) → tertiary; `numeric`; `caseFirst`;
//! `ignorePunctuation` → shifted (or non-ignorable) alternate handling.

use super::{data, pairs, resolve_locale};
use crate::{JsResult, JsString};
use icu_collator::options::{AlternateHandling, CaseLevel, CollatorOptions, Strength};
use icu_collator::preferences::{CollationCaseFirst, CollationNumericOrdering};
use icu_collator::{Collator, CollatorPreferences};
use std::cell::RefCell;
use std::cmp::Ordering;
use std::collections::HashMap;

/// Parsed options of a collation.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Default)]
pub struct CollatorSpec {
    locale: Option<String>,
    /// 0 variant (default), 1 base, 2 accent, 3 case.
    sensitivity: u8,
    numeric: Option<bool>,
    /// 0 unset, 1 upper, 2 lower, 3 false.
    case_first: u8,
    ignore_punctuation: Option<bool>,
}

impl CollatorSpec {
    /// Parses `m=l|c;loc=…;sensitivity=…;numeric=…;caseFirst=…;ignorePunctuation=…`.
    pub fn parse(spec: &str) -> Result<CollatorSpec, String> {
        let mut s = CollatorSpec::default();
        let boolean = |k: &str, v: &str| match v {
            "true" => Ok(true),
            "false" => Ok(false),
            _ => Err(format!("{k} is true or false")),
        };
        for (k, v) in pairs(spec)? {
            match k {
                "m" => {
                    if v != "l" && v != "c" {
                        return Err(format!("unknown method {v}"));
                    }
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
                "usage" => {
                    if v != "sort" {
                        return Err("usage search is not supported".into());
                    }
                }
                "sensitivity" => {
                    s.sensitivity = match v {
                        "variant" => 0,
                        "base" => 1,
                        "accent" => 2,
                        "case" => 3,
                        _ => return Err(format!("sensitivity {v} is not valid")),
                    }
                }
                "numeric" => s.numeric = Some(boolean(k, v)?),
                "caseFirst" => {
                    s.case_first = match v {
                        "upper" => 1,
                        "lower" => 2,
                        "false" => 3,
                        _ => return Err(format!("caseFirst {v} is not valid")),
                    }
                }
                "ignorePunctuation" => s.ignore_punctuation = Some(boolean(k, v)?),
                other => return Err(format!("option {other} is not supported")),
            }
        }
        Ok(s)
    }
}

thread_local! {
    static COLLATORS: RefCell<HashMap<(usize, CollatorSpec), Collator>> = RefCell::new(HashMap::new());
}

fn collator_for(locale: usize, spec: &CollatorSpec) -> Collator {
    let tag: icu_locale_core::Locale = data::LOCALES[locale].tag.parse().expect("locale tag");
    let mut prefs = CollatorPreferences::from(&tag);
    if let Some(n) = spec.numeric {
        prefs.numeric_ordering = Some(if n {
            CollationNumericOrdering::True
        } else {
            CollationNumericOrdering::False
        });
    }
    prefs.case_first = match spec.case_first {
        1 => Some(CollationCaseFirst::Upper),
        2 => Some(CollationCaseFirst::Lower),
        3 => Some(CollationCaseFirst::False),
        _ => prefs.case_first,
    };
    let mut options = CollatorOptions::default();
    let (strength, case_level) = match spec.sensitivity {
        1 => (Strength::Primary, false),
        2 => (Strength::Secondary, false),
        3 => (Strength::Primary, true),
        _ => (Strength::Tertiary, false),
    };
    options.strength = Some(strength);
    if case_level {
        options.case_level = Some(CaseLevel::On);
    }
    if let Some(ignore) = spec.ignore_punctuation {
        options.alternate_handling = Some(if ignore {
            AlternateHandling::Shifted
        } else {
            AlternateHandling::NonIgnorable
        });
    }
    Collator::try_new(prefs, options)
        .expect("compiled collation data")
        .static_to_owned()
}

fn order(o: Ordering) -> f64 {
    match o {
        Ordering::Less => -1.0,
        Ordering::Equal => 0.0,
        Ordering::Greater => 1.0,
    }
}

/// Compares `a` and `b` with `spec`; `locale` is a runtime locale argument.
pub fn compare(
    a: &JsString,
    b: &JsString,
    spec: &CollatorSpec,
    locale: Option<&JsString>,
) -> JsResult<f64> {
    let l = resolve_locale(spec.locale.as_deref(), locale)?;
    Ok(COLLATORS.with(|c| {
        let mut c = c.borrow_mut();
        let collator = c
            .entry((l, spec.clone()))
            .or_insert_with(|| collator_for(l, spec));
        order(collator.as_borrowed().compare_utf16(a.units(), b.units()))
    }))
}

/// `a.localeCompare(b)`: the default locale and options.
pub fn compare_default(a: &JsString, b: &JsString) -> f64 {
    compare(a, b, &CollatorSpec::default(), None).expect("default locale")
}
