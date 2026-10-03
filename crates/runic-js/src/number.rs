//! Number semantics (ECMA-262 Number type, Math).


/// `Number.prototype.toString()` with radix 10 (ECMA-262 Number::toString).
pub fn number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".into();
    }
    if x == 0.0 {
        return "0".into();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if x < 0.0 {
        return format!("-{}", number_to_string(-x));
    }
    // Rust's `{:e}` formatting yields the shortest round-tripping digits.
    let sci = format!("{x:e}");
    let (mantissa, exponent) = sci.split_once('e').expect("scientific notation");
    let digits: String = mantissa.chars().filter(|c| *c != '.').collect();
    let k = digits.len() as i32;
    let n = exponent.parse::<i32>().expect("exponent") + 1;
    if k <= n && n <= 21 {
        let mut s = digits;
        s.extend(std::iter::repeat_n('0', (n - k) as usize));
        s
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{}", "0".repeat((-n) as usize), digits)
    } else {
        let e = n - 1;
        let sign = if e < 0 { '-' } else { '+' };
        if k == 1 {
            format!("{digits}e{sign}{}", e.abs())
        } else {
            format!("{}.{}e{sign}{}", &digits[..1], &digits[1..], e.abs())
        }
    }
}

/// `String(boolean)`.
pub fn boolean_to_string(b: bool) -> String {
    if b { "true" } else { "false" }.into()
}

/// `Math.min(a, b)`: NaN propagates and -0 is smaller than +0.
pub fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() { a } else { b }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.max(a, b)`: NaN propagates and +0 is larger than -0.
pub fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_positive() { a } else { b }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Object.is` on numbers (SameValue): NaN equals NaN, +0 differs from -0.
pub fn same_value(a: f64, b: f64) -> bool {
    if a.is_nan() && b.is_nan() {
        true
    } else {
        a == b && a.is_sign_negative() == b.is_sign_negative()
    }
}

/// `string.length`: the number of UTF-16 code units.
pub fn utf16_len(s: &str) -> f64 {
    s.encode_utf16().count() as f64
}

/// Whether `s` is single-line text of at most `max_utf16` code units, without
/// control characters (the schema 3/4 text-input domain).
pub fn valid_single_line(s: &str, max_utf16: usize) -> bool {
    s.encode_utf16().count() <= max_utf16 && !s.chars().any(|c| c < ' ' || c == '\u{7f}')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_to_string_matches_ecmascript() {
        // Expected values produced by Node: String(x).
        let cases: &[(f64, &str)] = &[
            (0.0, "0"),
            (-0.0, "0"),
            (1.0, "1"),
            (-1.0, "-1"),
            (64.0, "64"),
            (0.1, "0.1"),
            (0.1 + 0.2, "0.30000000000000004"),
            (123.456, "123.456"),
            (1e21, "1e+21"),
            (1e20, "100000000000000000000"),
            (123456789012345680000.0, "123456789012345680000"),
            (1.5e21, "1.5e+21"),
            (0.000001, "0.000001"),
            (0.0000001, "1e-7"),
            (1.2345e-7, "1.2345e-7"),
            (5e-324, "5e-324"),
            (f64::MAX, "1.7976931348623157e+308"),
            (2f64.powi(53), "9007199254740992"),
            (f64::NAN, "NaN"),
            (f64::INFINITY, "Infinity"),
            (f64::NEG_INFINITY, "-Infinity"),
            (-2.5, "-2.5"),
            (100.0, "100"),
        ];
        for (x, expected) in cases {
            assert_eq!(number_to_string(*x), *expected, "String({x:?})");
        }
    }

    #[test]
    fn min_max_follow_math() {
        assert!(min(f64::NAN, 1.0).is_nan());
        assert!(max(1.0, f64::NAN).is_nan());
        assert!(min(0.0, -0.0).is_sign_negative());
        assert!(min(-0.0, 0.0).is_sign_negative());
        assert!(max(-0.0, 0.0).is_sign_positive());
        assert!(max(0.0, -0.0).is_sign_positive());
        assert_eq!(min(3.0, -2.0), -2.0);
        assert_eq!(max(3.0, -2.0), 3.0);
    }

    #[test]
    fn same_value_and_lengths() {
        assert!(same_value(f64::NAN, f64::NAN));
        assert!(!same_value(0.0, -0.0));
        assert!(same_value(2.0, 2.0));
        assert_eq!(utf16_len("a😀é"), 4.0);
        assert!(valid_single_line("héllo", 256));
        assert!(!valid_single_line("a\nb", 256));
        assert!(!valid_single_line(&"a".repeat(257), 256));
    }
}

// ---------------------------------------------------------------------------
// Family A (Number, Math, numeric operators). Signatures are frozen; see
// docs/design/M2-VALUES.md. Every function must match ECMAScript exactly and
// is tested against Node-generated vectors (tests/vectors/number.json).

use crate::{JsResult, JsString, Maybe};

/// StringToNumber (ECMA-262 7.1.4.1.1): `Number("  12e3 ")`, `+"0x1f"`, `Number("")`.
pub fn string_to_number(s: &JsString) -> f64 {
    let _ = s;
    todo!("family A")
}
/// `Number.prototype.toString(radix)`; RangeError unless 2 <= radix <= 36.
pub fn to_string_radix(x: f64, radix: f64) -> JsResult<JsString> {
    let _ = (x, radix);
    todo!("family A")
}
/// `Number.prototype.toFixed(digits)`; RangeError unless 0 <= digits <= 100.
pub fn to_fixed(x: f64, digits: f64) -> JsResult<JsString> {
    let _ = (x, digits);
    todo!("family A")
}
/// `Number.prototype.toPrecision(precision)`.
pub fn to_precision(x: f64, precision: Maybe<f64>) -> JsResult<JsString> {
    let _ = (x, precision);
    todo!("family A")
}
/// `Number.prototype.toExponential(digits)`.
pub fn to_exponential(x: f64, digits: Maybe<f64>) -> JsResult<JsString> {
    let _ = (x, digits);
    todo!("family A")
}
/// Global `parseInt(string, radix)`.
pub fn parse_int(s: &JsString, radix: Maybe<f64>) -> f64 {
    let _ = (s, radix);
    todo!("family A")
}
/// Global `parseFloat(string)`.
pub fn parse_float(s: &JsString) -> f64 {
    let _ = s;
    todo!("family A")
}
pub fn is_integer(x: f64) -> bool {
    let _ = x;
    todo!("family A")
}
pub fn is_safe_integer(x: f64) -> bool {
    let _ = x;
    todo!("family A")
}
/// ToInt32 / ToUint32.
pub fn to_int32(x: f64) -> i32 {
    let _ = x;
    todo!("family A")
}
pub fn to_uint32(x: f64) -> u32 {
    let _ = x;
    todo!("family A")
}
/// `a ** b` (Number::exponentiate; differs from `powf` for ±1 ** ±Infinity and NaN exponents).
pub fn pow(a: f64, b: f64) -> f64 {
    let _ = (a, b);
    todo!("family A")
}
/// `a % b` (Number::remainder).
pub fn rem(a: f64, b: f64) -> f64 {
    let _ = (a, b);
    todo!("family A")
}
pub fn bit_and(a: f64, b: f64) -> f64 { let _ = (a, b); todo!("family A") }
pub fn bit_or(a: f64, b: f64) -> f64 { let _ = (a, b); todo!("family A") }
pub fn bit_xor(a: f64, b: f64) -> f64 { let _ = (a, b); todo!("family A") }
pub fn bit_not(a: f64) -> f64 { let _ = a; todo!("family A") }
pub fn shl(a: f64, b: f64) -> f64 { let _ = (a, b); todo!("family A") }
pub fn shr(a: f64, b: f64) -> f64 { let _ = (a, b); todo!("family A") }
pub fn ushr(a: f64, b: f64) -> f64 { let _ = (a, b); todo!("family A") }

/// `Math.*` (all except `random`). Variadic functions take slices.
pub mod math {
    pub fn round(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn sign(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn trunc(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn floor(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn ceil(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn abs(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn sqrt(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn cbrt(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn exp(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn expm1(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn log(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn log1p(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn log2(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn log10(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn sin(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn cos(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn tan(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn asin(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn acos(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn atan(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn atan2(y: f64, x: f64) -> f64 { let _ = (y, x); todo!("family A") }
    pub fn sinh(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn cosh(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn tanh(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn asinh(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn acosh(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn atanh(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn hypot(xs: &[f64]) -> f64 { let _ = xs; todo!("family A") }
    pub fn min(xs: &[f64]) -> f64 { let _ = xs; todo!("family A") }
    pub fn max(xs: &[f64]) -> f64 { let _ = xs; todo!("family A") }
    pub fn pow(a: f64, b: f64) -> f64 { super::pow(a, b) }
    pub fn clz32(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn fround(x: f64) -> f64 { let _ = x; todo!("family A") }
    pub fn imul(a: f64, b: f64) -> f64 { let _ = (a, b); todo!("family A") }
}
