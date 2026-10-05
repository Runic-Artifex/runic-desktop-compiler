//! `Intl.PluralRules`: `select` and `resolvedOptions().pluralCategories`,
//! cardinal and ordinal, for every locale Chromium has plural rules for.
//!
//! The rules are Chromium's own (its ICU data, `locale_data.rs`) and are
//! evaluated as ICU evaluates them: the number is first formatted with the
//! default digits (at most three fraction digits, half-expand rounding on
//! the shortest round-trip digits), then its operands `n` (the absolute
//! value as a double), `i` (the integer digits, truncated to the lowest 18
//! as ICU's `toLong(true)`), `v`/`w` (visible fraction digits), `f`/`t`
//! (the fraction digits as an integer) and `e`/`c` (0) are tested by each
//! keyword's condition in ICU's order. `=` requires an integer operand
//! before the modulus. NaN and infinities select `other`.
//!
//! The locale resolves as V8 resolves it: the canonical tag, ECMA-402's
//! lookup among the locales with plural data, else the default locale.

use super::locale_data::{PLURAL_LOCALES, PLURAL_SETS};
use super::number::round;
use super::pairs;
use super::tag::{self, Kind, TagError};
use crate::number::shortest_digits;
use crate::{JsResult, JsString};

/// A relation of a plural rule: `op [% m] = r` (or `!=` when `neg`), with
/// `r` a list of inclusive ranges.
#[derive(Debug)]
pub struct R {
    pub op: u8,
    pub m: u32,
    pub neg: bool,
    pub r: &'static [(u32, u32)],
}

/// The plural keywords in CLDR order (`pluralCategories` lists them so).
pub const KEYWORDS: [&str; 6] = ["zero", "one", "two", "few", "many", "other"];

/// Parsed options of a plural rules object.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PluralSpec {
    /// A literal locale: its index in PLURAL_LOCALES, or None for a tag
    /// without plural data of its own (the default locale's then).
    locale: Option<Option<usize>>,
    ordinal: bool,
}

impl PluralSpec {
    /// Parses `m=p;loc=…;type=cardinal|ordinal`.
    pub fn parse(spec: &str) -> Result<PluralSpec, String> {
        let mut s = PluralSpec {
            locale: None,
            ordinal: false,
        };
        for (k, v) in pairs(spec)? {
            match k {
                "m" if v == "p" => {}
                "loc" => {
                    s.locale = Some(match lookup(v) {
                        Ok(l) => l,
                        Err(TagError::Invalid) => {
                            return Err(format!(
                                "RangeError: {v} is not a well-formed language tag"
                            ));
                        }
                        Err(TagError::Unsupported(why)) => return Err(why),
                    })
                }
                "type" => {
                    s.ordinal = match v {
                        "cardinal" => false,
                        "ordinal" => true,
                        _ => return Err(format!("type: {v:?} is not cardinal or ordinal")),
                    }
                }
                _ => return Err(format!("unsupported plural rules option {k}={v}")),
            }
        }
        Ok(s)
    }
}

/// The available plural locale `tag` resolves to (None: none, so the
/// default locale).
fn lookup(tag: &str) -> Result<Option<usize>, TagError> {
    let t = tag::parse(tag, Kind::List)?;
    let mut candidate = t.bcp47();
    loop {
        if let Ok(i) = PLURAL_LOCALES.binary_search_by(|(l, _, _)| (*l).cmp(&candidate)) {
            return Ok(Some(i));
        }
        let Some(cut) = candidate.rfind('-') else {
            return Ok(None);
        };
        candidate.truncate(cut);
        if cut >= 2 && candidate.as_bytes()[cut - 2] == b'-' {
            candidate.truncate(cut - 2);
        }
    }
}

/// Validates the locale argument of `new Intl.PluralRules(tag)`.
pub fn check_plural_locale(tag: &JsString) -> JsResult<()> {
    let tag = tag.to_rust();
    lookup(&tag).map(|_| ()).map_err(|e| e.throw(&tag))
}

/// The rule set of `spec` with an optional runtime locale.
fn rule_set(spec: &PluralSpec, runtime: Option<&JsString>) -> JsResult<usize> {
    let locale = match runtime {
        Some(tag) => {
            let tag = tag.to_rust();
            lookup(&tag).map_err(|e| e.throw(&tag))?
        }
        None => spec.locale.flatten(),
    };
    let locale = match locale {
        Some(i) => i,
        None => {
            // The default locale (always one with plural data).
            let default = super::LOCALES[crate::env::locale()];
            lookup(default)
                .ok()
                .flatten()
                .expect("verified locales have plural data")
        }
    };
    let (_, cardinal, ordinal) = PLURAL_LOCALES[locale];
    Ok(usize::from(if spec.ordinal { ordinal } else { cardinal }))
}

/// ICU's plural operands of a number formatted with the default digits.
struct Operands {
    n: f64,
    i: f64,
    v: f64,
    f: f64,
}

fn operands(x: f64) -> Operands {
    let a = x.abs();
    let (digits, exp) = if a == 0.0 {
        (vec![], 0)
    } else {
        let (d, e) = shortest_digits(a);
        round(d, e, e + 1 + 3)
    };
    if digits.is_empty() {
        return Operands {
            n: 0.0,
            i: 0.0,
            v: 0.0,
            f: 0.0,
        };
    }
    // Digit k sits at 10^(exp - k); the digits have no trailing zeros.
    let at = |magnitude: i32| -> u64 {
        let k = exp - magnitude;
        if k >= 0 && (k as usize) < digits.len() {
            u64::from(digits[k as usize])
        } else {
            0
        }
    };
    let mut i: u64 = 0;
    for m in (0..=exp.min(17)).rev() {
        i = i * 10 + at(m);
    }
    let lowest = exp - (digits.len() as i32 - 1);
    let mut f: u64 = 0;
    let mut v = 0;
    for m in (lowest..=-1).rev() {
        f = f * 10 + at(m);
        v += 1;
    }
    let text: String = digits.iter().map(|d| char::from(b'0' + d)).collect();
    let n: f64 = format!("0.{text}e{}", exp + 1)
        .parse()
        .expect("decimal digits");
    Operands {
        n,
        i: i as f64,
        v: f64::from(v),
        f: f as f64,
    }
}

fn holds(r: &R, o: &Operands) -> bool {
    let value = match r.op {
        b'n' => o.n,
        b'i' => o.i,
        b'v' | b'w' => o.v,
        b'f' | b't' => o.f,
        _ => 0.0, // e, c: the exponent of compact notation
    };
    // `=` and `!=` test integers: a fraction fails the relation (before
    // the modulus), and `!=` then holds.
    let result = if value != value.floor() {
        false
    } else {
        let value = if r.m > 0 {
            value % f64::from(r.m)
        } else {
            value
        };
        r.r.iter()
            .any(|&(lo, hi)| f64::from(lo) <= value && value <= f64::from(hi))
    };
    result != r.neg
}

/// The keyword (index into KEYWORDS) rule set `set` selects for `x`.
fn select_in(set: usize, x: f64) -> usize {
    if !x.is_finite() {
        return 5;
    }
    let o = operands(x);
    for (keyword, condition) in PLURAL_SETS[set] {
        if condition.is_empty() || condition.iter().any(|and| and.iter().all(|r| holds(r, &o))) {
            return usize::from(*keyword);
        }
    }
    5
}

/// `Intl.PluralRules.prototype.select`.
pub fn plural_select(x: f64, spec: &PluralSpec, locale: Option<&JsString>) -> JsResult<JsString> {
    let set = rule_set(spec, locale)?;
    Ok(JsString::from(KEYWORDS[select_in(set, x)]))
}

/// `resolvedOptions().pluralCategories`: the keywords of the rule set in
/// CLDR order.
pub fn plural_categories(spec: &PluralSpec, locale: Option<&JsString>) -> JsResult<Vec<JsString>> {
    let set = rule_set(spec, locale)?;
    let mut present = [false; 6];
    for (keyword, _) in PLURAL_SETS[set] {
        present[usize::from(*keyword)] = true;
    }
    Ok(KEYWORDS
        .iter()
        .zip(present)
        .filter(|(_, p)| *p)
        .map(|(k, _)| JsString::from(*k))
        .collect())
}
