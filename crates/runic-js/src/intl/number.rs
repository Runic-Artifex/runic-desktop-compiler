//! `Intl.NumberFormat` and `Number.prototype.toLocaleString`.
//!
//! Options: `style` (`decimal`, `percent`, `currency` with a verified
//! `currency` and `currencyDisplay` `symbol`, `narrowSymbol` or `code`),
//! `minimumIntegerDigits`, `minimum`/`maximumFractionDigits`,
//! `minimum`/`maximumSignificantDigits` and `useGrouping`. Digit options
//! resolve as ECMA-402's SetNumberFormatDigitOptions (2023: significant
//! digits win, `roundingPriority` auto). Numbers format as ICU does: the
//! shortest round-trip decimal digits of the double (shifted by two for
//! percent), rounded half away from zero, grouped by threes.

use super::{Affixes, data, pairs, resolve_locale};
use crate::number::shortest_digits;
use crate::{JsResult, JsString};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Style {
    Decimal,
    Percent,
    /// Index into the currencies, display (0 symbol, 1 narrow, 2 code).
    Currency(usize, u8),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Rounding {
    Fraction { min: u32, max: u32 },
    Significant { min: u32, max: u32 },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Grouping {
    /// The locale's minimum grouping digits (1 for every verified locale).
    Auto,
    Always,
    Min2,
    Off,
}

/// Parsed and resolved options of a number format.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NumberSpec {
    locale: Option<String>,
    style: Style,
    min_integer: u32,
    rounding: Rounding,
    grouping: Grouping,
}

fn integer_option(v: &str, key: &str, lo: u32, hi: u32) -> Result<u32, String> {
    match v.parse::<f64>() {
        Ok(n) if n.is_finite() && n.floor() >= f64::from(lo) && n.floor() <= f64::from(hi) => {
            Ok(n.floor() as u32)
        }
        _ => Err(format!("{key} must be between {lo} and {hi} (RangeError)")),
    }
}

impl NumberSpec {
    /// Parses `m=n|f;loc=…;<option>=<value>…`.
    pub fn parse(spec: &str) -> Result<NumberSpec, String> {
        let mut locale = None;
        let mut style = "decimal";
        let mut currency = None;
        let mut display = "symbol";
        let mut min_integer = 1;
        let (mut mnfd, mut mxfd, mut mnsd, mut mxsd) = (None, None, None, None);
        let mut grouping = Grouping::Auto;
        for (k, v) in pairs(spec)? {
            match k {
                "m" => {
                    if v != "n" && v != "f" {
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
                    locale = Some(v.to_string());
                }
                "style" => {
                    if !["decimal", "percent", "currency"].contains(&v) {
                        return Err(format!(
                            "style {v} is not supported (decimal, percent and currency are)"
                        ));
                    }
                    style = v;
                }
                "currency" => currency = Some(v),
                "currencyDisplay" => {
                    if !["symbol", "narrowSymbol", "code"].contains(&v) {
                        return Err(format!(
                            "currencyDisplay {v} is not supported (symbol, narrowSymbol and code are)"
                        ));
                    }
                    display = v;
                }
                "minimumIntegerDigits" => min_integer = integer_option(v, k, 1, 21)?,
                "minimumFractionDigits" => mnfd = Some(integer_option(v, k, 0, 100)?),
                "maximumFractionDigits" => mxfd = Some(integer_option(v, k, 0, 100)?),
                "minimumSignificantDigits" => mnsd = Some(integer_option(v, k, 1, 21)?),
                "maximumSignificantDigits" => mxsd = Some(integer_option(v, k, 1, 21)?),
                "useGrouping" => {
                    grouping = match v {
                        "true" | "always" => Grouping::Always,
                        "auto" => Grouping::Auto,
                        "min2" => Grouping::Min2,
                        "false" => Grouping::Off,
                        _ => return Err(format!("useGrouping {v} is not supported")),
                    }
                }
                other => return Err(format!("option {other} is not supported")),
            }
        }
        let style = match style {
            "decimal" => Style::Decimal,
            "percent" => Style::Percent,
            _ => {
                let code = currency.ok_or("style currency needs a currency (TypeError)")?;
                let i = data::LOCALES[0]
                    .currencies
                    .iter()
                    .position(|c| c.code.eq_ignore_ascii_case(code))
                    .ok_or_else(|| format!("currency {code} is not verified"))?;
                let d = match display {
                    "symbol" => 0,
                    "narrowSymbol" => 1,
                    _ => 2,
                };
                Style::Currency(i, d)
            }
        };
        let (mnfd_default, mxfd_default) = match style {
            Style::Decimal => (0, 3),
            Style::Percent => (0, 0),
            Style::Currency(i, _) => {
                let d = u32::from(data::LOCALES[0].currencies[i].digits);
                (d, d)
            }
        };
        // SetNumberFormatDigitOptions, roundingPriority "auto".
        let rounding = if mnsd.is_some() || mxsd.is_some() {
            let min = mnsd.unwrap_or(1);
            let max = mxsd.unwrap_or(21);
            if max < min {
                return Err(
                    "maximumSignificantDigits is below minimumSignificantDigits (RangeError)"
                        .into(),
                );
            }
            Rounding::Significant { min, max }
        } else if mnfd.is_some() || mxfd.is_some() {
            let (min, max) = match (mnfd, mxfd) {
                (None, Some(max)) => (mnfd_default.min(max), max),
                (Some(min), None) => (min, mxfd_default.max(min)),
                (Some(min), Some(max)) if min > max => {
                    return Err(
                        "minimumFractionDigits is above maximumFractionDigits (RangeError)".into(),
                    );
                }
                (Some(min), Some(max)) => (min, max),
                (None, None) => unreachable!(),
            };
            Rounding::Fraction { min, max }
        } else {
            Rounding::Fraction {
                min: mnfd_default,
                max: mxfd_default,
            }
        };
        Ok(NumberSpec {
            locale,
            style,
            min_integer,
            rounding,
            grouping,
        })
    }
}

/// Rounds the decimal `digits` × 10^(`exp` + 1 − len) (first digit at
/// 10^exp) to keep `keep` digits from the first, half away from zero.
/// Returns the digits without trailing zeros and the new exponent.
fn round(mut digits: Vec<u8>, mut exp: i32, keep: i32) -> (Vec<u8>, i32) {
    if keep < 0 {
        return (vec![], exp);
    }
    let keep = keep as usize;
    if keep < digits.len() {
        let up = digits[keep] >= 5;
        digits.truncate(keep);
        if up {
            let mut i = digits.len();
            loop {
                if i == 0 {
                    digits.insert(0, 1);
                    exp += 1;
                    break;
                }
                i -= 1;
                if digits[i] == 9 {
                    digits[i] = 0;
                } else {
                    digits[i] += 1;
                    break;
                }
            }
        }
    }
    while digits.last() == Some(&0) {
        digits.pop();
    }
    (digits, exp)
}

/// Formats `x` with `spec`; `locale` is a runtime locale argument.
pub fn format_number(x: f64, spec: &NumberSpec, locale: Option<&JsString>) -> JsResult<JsString> {
    let l = resolve_locale(spec.locale.as_deref(), locale)?;
    let ld = &data::LOCALES[l];
    let affixes: &Affixes = match spec.style {
        Style::Decimal => &ld.decimal_affixes,
        Style::Percent => &ld.percent,
        Style::Currency(i, d) => {
            let c = &ld.currencies[i];
            match d {
                0 => &c.symbol,
                1 => &c.narrow,
                _ => &c.iso,
            }
        }
    };
    let negative = x.is_sign_negative() && !x.is_nan();
    let (prefix, suffix) = match (x.is_finite(), negative) {
        (true, false) => (affixes.pp, affixes.ps),
        (true, true) => (affixes.np, affixes.ns),
        (false, false) => (affixes.sp, affixes.ss),
        (false, true) => (affixes.snp, affixes.sns),
    };
    let body = if x.is_nan() {
        ld.nan.to_string()
    } else if x.is_infinite() {
        ld.infinity.to_string()
    } else {
        number_body(x.abs(), spec, ld)
    };
    Ok(JsString::from(format!("{prefix}{body}{suffix}")))
}

fn number_body(x: f64, spec: &NumberSpec, ld: &super::LocaleData) -> String {
    // Digits d0.d1… × 10^exp.
    let (digits, mut exp) = if x == 0.0 {
        (vec![], 0)
    } else {
        shortest_digits(x)
    };
    if spec.style == Style::Percent && !digits.is_empty() {
        exp += 2;
    }
    let (digits, exp, min_fraction) = match spec.rounding {
        Rounding::Fraction { min, max } => {
            let (d, e) = round(digits, exp, exp + 1 + max as i32);
            (d, e, min as i32)
        }
        Rounding::Significant { min, max } => {
            let (d, e) = round(digits, exp, max as i32);
            // Minimum significant digits: the fraction digits they need.
            let needed = if d.is_empty() {
                min as i32 - 1
            } else {
                min as i32 - 1 - e
            };
            (d, e, needed.max(0))
        }
    };
    // Integer and fraction digits.
    let mut int = String::new();
    let mut frac = String::new();
    if digits.is_empty() {
        int.push('0');
    } else {
        for i in 0..=exp.max(-1) {
            let d = digits.get(i as usize).copied().unwrap_or(0);
            int.push(char::from(b'0' + d));
        }
        if exp < 0 {
            int = "0".into();
        }
        let first_fraction = exp + 1;
        for (i, d) in digits.iter().enumerate() {
            let pos = i as i32;
            if pos >= first_fraction {
                let lead = (pos - first_fraction) as usize;
                while frac.len() < lead {
                    frac.push('0');
                }
                frac.push(char::from(b'0' + d));
            }
        }
    }
    while (frac.len() as i32) < min_fraction {
        frac.push('0');
    }
    while (int.len() as u32) < spec.min_integer {
        int.insert(0, '0');
    }
    let group = match spec.grouping {
        Grouping::Off => false,
        Grouping::Always | Grouping::Auto => int.len() >= 4,
        Grouping::Min2 => int.len() >= 5,
    };
    let mut out = String::new();
    if group {
        let n = int.len();
        for (i, c) in int.chars().enumerate() {
            if i > 0 && (n - i) % 3 == 0 {
                out.push_str(ld.group);
            }
            out.push(c);
        }
    } else {
        out = int;
    }
    if !frac.is_empty() {
        out.push_str(ld.decimal);
        out.push_str(&frac);
    }
    out
}
