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

use crate::{JsResult, JsString, Maybe, Throw};

/// StrWhiteSpaceChar (ECMA-262 7.1.4.1): WhiteSpace and LineTerminator.
fn is_str_whitespace(u: u16) -> bool {
    matches!(
        u,
        0x09 | 0x0A | 0x0B | 0x0C | 0x0D | 0x20 | 0xA0 | 0x1680 | 0x2000
            ..=0x200A | 0x2028 | 0x2029 | 0x202F | 0x205F | 0x3000 | 0xFEFF
    )
}

fn trim_start(s: &[u16]) -> &[u16] {
    let start = s
        .iter()
        .position(|&u| !is_str_whitespace(u))
        .unwrap_or(s.len());
    &s[start..]
}

fn trim(s: &[u16]) -> &[u16] {
    let s = trim_start(s);
    let end = s
        .iter()
        .rposition(|&u| !is_str_whitespace(u))
        .map_or(0, |i| i + 1);
    &s[..end]
}

/// The value of an ASCII digit or letter in radix 36 (36 for anything else).
fn digit_value(u: u16) -> u32 {
    match u {
        0x30..=0x39 => u32::from(u - 0x30),
        0x61..=0x7A => u32::from(u - 0x61) + 10,
        0x41..=0x5A => u32::from(u - 0x41) + 10,
        _ => 36,
    }
}

fn starts_with_ascii(s: &[u16], prefix: &str) -> bool {
    s.len() >= prefix.len()
        && s.iter()
            .zip(prefix.bytes())
            .all(|(&u, b)| u == u16::from(b))
}

/// Splits an optional leading `+` or `-`; returns whether it was `-`.
fn split_sign(s: &[u16]) -> (bool, &[u16]) {
    match s.first() {
        Some(&0x2B) => (false, &s[1..]),
        Some(&0x2D) => (true, &s[1..]),
        _ => (false, s),
    }
}

/// Length of the longest prefix of `s` that is a StrUnsignedDecimalLiteral
/// other than `Infinity` (0 if there is none).
fn scan_unsigned_decimal(s: &[u16]) -> usize {
    let is_digit = |i: usize| i < s.len() && (0x30..=0x39).contains(&s[i]);
    let digits_end = |from: usize| {
        let mut i = from;
        while is_digit(i) {
            i += 1;
        }
        i
    };
    let mut end = digits_end(0);
    let mut has_digits = end > 0;
    if end < s.len() && s[end] == u16::from(b'.') {
        let frac_end = digits_end(end + 1);
        has_digits |= frac_end > end + 1;
        end = frac_end;
    }
    if !has_digits {
        return 0;
    }
    if end < s.len() && (s[end] == u16::from(b'e') || s[end] == u16::from(b'E')) {
        let mut i = end + 1;
        if i < s.len() && (s[i] == u16::from(b'+') || s[i] == u16::from(b'-')) {
            i += 1;
        }
        let exp_end = digits_end(i);
        if exp_end > i {
            end = exp_end;
        }
    }
    end
}

/// Correctly rounded value of a validated ASCII decimal literal (optionally
/// signed). Rust's float parser is correctly rounded for any length.
fn parse_ascii_decimal(s: &[u16]) -> f64 {
    let text: String = s.iter().map(|&u| char::from(u as u8)).collect();
    text.parse::<f64>().expect("validated decimal literal")
}

/// Correctly rounded (ties to even) value of digits in radix `2^bits`.
fn pow2_radix_to_f64(digits: &[u16], bits: u32) -> f64 {
    let mut significant: Vec<bool> = Vec::new();
    for &u in digits {
        let d = digit_value(u);
        for b in (0..bits).rev() {
            let bit = (d >> b) & 1 == 1;
            if bit || !significant.is_empty() {
                significant.push(bit);
            }
        }
    }
    let total = significant.len();
    let to_int = |bits: &[bool]| bits.iter().fold(0u64, |acc, &b| (acc << 1) | u64::from(b));
    if total <= 53 {
        return to_int(&significant) as f64;
    }
    let mut mantissa = to_int(&significant[..53]);
    let mut exponent = (total - 53) as i64;
    let round = significant[53];
    let sticky = significant[54..].iter().any(|&b| b);
    if round && (sticky || mantissa & 1 == 1) {
        mantissa += 1;
        if mantissa == 1 << 53 {
            mantissa >>= 1;
            exponent += 1;
        }
    }
    if exponent > 971 {
        return f64::INFINITY;
    }
    mantissa as f64 * f64::from_bits(((exponent + 1023) as u64) << 52)
}

/// StringToNumber (ECMA-262 7.1.4.1.1): `Number("  12e3 ")`, `+"0x1f"`, `Number("")`.
pub fn string_to_number(s: &JsString) -> f64 {
    let t = trim(s.units());
    if t.is_empty() {
        return 0.0;
    }
    if t.len() >= 2 && t[0] == u16::from(b'0') {
        let bits = match t[1] {
            0x78 | 0x58 => 4, // x X
            0x6F | 0x4F => 3, // o O
            0x62 | 0x42 => 1, // b B
            _ => 0,
        };
        if bits != 0 {
            let digits = &t[2..];
            if digits.is_empty() || digits.iter().any(|&u| digit_value(u) >= 1 << bits) {
                return f64::NAN;
            }
            return pow2_radix_to_f64(digits, bits);
        }
    }
    let (negative, body) = split_sign(t);
    if body.len() == 8 && starts_with_ascii(body, "Infinity") {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let n = scan_unsigned_decimal(body);
    if n == 0 || n != body.len() {
        return f64::NAN;
    }
    parse_ascii_decimal(t)
}

/// ToIntegerOrInfinity on a number (NaN and -0 become +0).
fn to_integer_or_infinity(x: f64) -> f64 {
    if x.is_nan() { 0.0 } else { x.trunc() + 0.0 }
}

/// The exact decimal expansion of a positive finite `x`: digits `d` (no
/// leading or trailing zeros) and `dp` with `x = 0.d1d2... × 10^dp`.
fn exact_decimal(x: f64) -> (Vec<u8>, i32) {
    debug_assert!(x > 0.0 && x.is_finite());
    let bits = x.to_bits();
    let biased = ((bits >> 52) & 0x7FF) as i32;
    let fraction = bits & ((1 << 52) - 1);
    let (mantissa, exponent) = if biased == 0 {
        (fraction, -1074)
    } else {
        (fraction | (1 << 52), biased - 1075)
    };
    // Little-endian base-2^32 limbs.
    let mut big: Vec<u32> = vec![mantissa as u32, (mantissa >> 32) as u32];
    let mul_small = |big: &mut Vec<u32>, m: u32| {
        let mut carry = 0u64;
        for limb in big.iter_mut() {
            let v = u64::from(*limb) * u64::from(m) + carry;
            *limb = v as u32;
            carry = v >> 32;
        }
        if carry != 0 {
            big.push(carry as u32);
        }
    };
    if exponent >= 0 {
        // mantissa × 2^exponent
        let mut e = exponent;
        while e > 0 {
            let step = e.min(31);
            mul_small(&mut big, 1 << step);
            e -= step;
        }
    } else {
        // mantissa × 2^exponent = mantissa × 5^-exponent × 10^exponent
        let mut e = -exponent;
        while e > 0 {
            let step = e.min(13);
            mul_small(&mut big, 5u32.pow(step as u32));
            e -= step;
        }
    }
    // Decimal digits of `big`, nine at a time.
    let mut chunks: Vec<u32> = Vec::new();
    while big.iter().any(|&l| l != 0) {
        let mut rem = 0u64;
        for limb in big.iter_mut().rev() {
            let v = (rem << 32) | u64::from(*limb);
            *limb = (v / 1_000_000_000) as u32;
            rem = v % 1_000_000_000;
        }
        chunks.push(rem as u32);
        while big.last() == Some(&0) {
            big.pop();
        }
    }
    let mut text = String::new();
    for (i, chunk) in chunks.iter().rev().enumerate() {
        if i == 0 {
            text.push_str(&chunk.to_string());
        } else {
            text.push_str(&format!("{chunk:09}"));
        }
    }
    let mut digits: Vec<u8> = text.bytes().map(|b| b - b'0').collect();
    let dp = digits.len() as i32 + exponent.min(0);
    while digits.last() == Some(&0) {
        digits.pop();
    }
    (digits, dp)
}

/// Rounds `0.d × 10^dp` to its first `keep` digits, ties away from zero (the
/// spec's "if there are two such n, pick the larger n").
fn round_digits(digits: &[u8], dp: i32, keep: i32) -> (Vec<u8>, i32) {
    if keep < 0 {
        return (Vec::new(), dp);
    }
    let keep = keep as usize;
    if keep >= digits.len() {
        return (digits.to_vec(), dp);
    }
    let mut kept = digits[..keep].to_vec();
    if digits[keep] >= 5 {
        loop {
            match kept.last_mut() {
                None => return (vec![1], dp + 1),
                Some(9) => {
                    kept.pop();
                }
                Some(d) => {
                    *d += 1;
                    break;
                }
            }
        }
    }
    (kept, dp)
}

/// The shortest round-tripping digits of a positive finite `x` and the
/// decimal exponent of the first digit (as used by Number::toString).
pub(crate) fn shortest_digits(x: f64) -> (Vec<u8>, i32) {
    let sci = format!("{x:e}");
    let (mantissa, exponent) = sci.split_once('e').expect("scientific notation");
    let digits = mantissa
        .bytes()
        .filter(|b| *b != b'.')
        .map(|b| b - b'0')
        .collect();
    (digits, exponent.parse().expect("exponent"))
}

fn digit_char(d: u8) -> char {
    char::from(b'0' + d)
}

/// `digits` padded with zeros to `len`.
fn padded(digits: &[u8], len: usize) -> String {
    (0..len)
        .map(|i| digit_char(digits.get(i).copied().unwrap_or(0)))
        .collect()
}

fn exponent_suffix(e: i32) -> String {
    format!("e{}{}", if e < 0 { '-' } else { '+' }, e.abs())
}

/// `Number.prototype.toString(radix)`; RangeError unless 2 <= radix <= 36.
pub fn to_string_radix(x: f64, radix: f64) -> JsResult<JsString> {
    let radix = to_integer_or_infinity(radix);
    if !(2.0..=36.0).contains(&radix) {
        return Err(Throw::range_error(
            "toString() radix must be between 2 and 36",
        ));
    }
    if radix == 10.0 || !x.is_finite() || x == 0.0 {
        return Ok(JsString::from(number_to_string(x)));
    }
    Ok(JsString::from(double_to_radix_string(x, radix as u32)))
}

/// V8's DoubleToRadixCString: fractional digits are produced only up to the
/// precision of the input (rounding half to even), and integer digits beyond
/// 2^53 are zero.
fn double_to_radix_string(value: f64, radix: u32) -> String {
    const CHARS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let negative = value < 0.0;
    let value = value.abs();
    let mut integer = value.floor();
    let mut fraction = value - integer;
    let mut delta = (0.5 * (value.next_up() - value)).max(0.0f64.next_up());
    let r = f64::from(radix);
    let mut frac_digits: Vec<u8> = Vec::new();
    let mut has_point = false;
    if fraction >= delta {
        has_point = true;
        loop {
            fraction *= r;
            delta *= r;
            let digit = fraction as u32;
            frac_digits.push(CHARS[digit as usize]);
            fraction -= f64::from(digit);
            if (fraction > 0.5 || (fraction == 0.5 && digit & 1 == 1)) && fraction + delta > 1.0 {
                // Round up, propagating the carry through written digits.
                loop {
                    match frac_digits.pop() {
                        None => {
                            integer += 1.0;
                            has_point = false;
                            break;
                        }
                        Some(c) => {
                            let d = digit_value(u16::from(c));
                            if d + 1 < radix {
                                frac_digits.push(CHARS[(d + 1) as usize]);
                                break;
                            }
                        }
                    }
                }
                break;
            }
            if fraction < delta {
                break;
            }
        }
    }
    let mut int_digits: Vec<u8> = Vec::new();
    // V8: `Double(integer / radix).Exponent() > 0`, i.e. integer / radix >= 2^53.
    while integer / r >= 9007199254740992.0 {
        integer /= r;
        int_digits.push(b'0');
    }
    loop {
        let remainder = integer % r;
        int_digits.push(CHARS[remainder as usize]);
        integer = (integer - remainder) / r;
        if integer <= 0.0 {
            break;
        }
    }
    let mut out = String::new();
    if negative {
        out.push('-');
    }
    out.extend(int_digits.iter().rev().map(|&b| char::from(b)));
    if has_point {
        out.push('.');
        out.extend(frac_digits.iter().map(|&b| char::from(b)));
    }
    out
}

/// `Number.prototype.toFixed(digits)`; RangeError unless 0 <= digits <= 100.
pub fn to_fixed(x: f64, digits: f64) -> JsResult<JsString> {
    let f = to_integer_or_infinity(digits);
    if !(0.0..=100.0).contains(&f) {
        return Err(Throw::range_error(
            "toFixed() digits argument must be between 0 and 100",
        ));
    }
    if !x.is_finite() {
        return Ok(JsString::from(number_to_string(x)));
    }
    let f = f as i32;
    let mut out = String::new();
    let mut x = x;
    if x < 0.0 {
        out.push('-');
        x = -x;
    }
    if x >= 1e21 {
        out.push_str(&number_to_string(x));
        return Ok(JsString::from(out));
    }
    let (digits, dp) = if x == 0.0 {
        (Vec::new(), 0)
    } else {
        exact_decimal(x)
    };
    let (digits, dp) = round_digits(&digits, dp, dp + f);
    let digit_at = |i: i32| {
        if i >= 0 {
            digit_char(digits.get(i as usize).copied().unwrap_or(0))
        } else {
            '0'
        }
    };
    if dp <= 0 {
        out.push('0');
    } else {
        out.extend((0..dp).map(digit_at));
    }
    if f > 0 {
        out.push('.');
        out.extend((1..=f).map(|j| digit_at(dp - 1 + j)));
    }
    Ok(JsString::from(out))
}

/// `Number.prototype.toPrecision(precision)`.
pub fn to_precision(x: f64, precision: Maybe<f64>) -> JsResult<JsString> {
    let p = match precision {
        Maybe::Undefined => return Ok(JsString::from(number_to_string(x))),
        Maybe::Null => 0.0,
        Maybe::Some(p) => to_integer_or_infinity(p),
    };
    if !x.is_finite() {
        return Ok(JsString::from(number_to_string(x)));
    }
    if !(1.0..=100.0).contains(&p) {
        return Err(Throw::range_error(
            "toPrecision() argument must be between 1 and 100",
        ));
    }
    let p = p as i32;
    let mut out = String::new();
    let mut x = x;
    if x < 0.0 {
        out.push('-');
        x = -x;
    }
    let (digits, e) = if x == 0.0 {
        (Vec::new(), 0)
    } else {
        let (digits, dp) = exact_decimal(x);
        let (digits, dp) = round_digits(&digits, dp, p);
        (digits, dp - 1)
    };
    let m = padded(&digits, p as usize);
    if e < -6 || e >= p {
        out.push_str(&m[..1]);
        if p != 1 {
            out.push('.');
            out.push_str(&m[1..]);
        }
        out.push_str(&exponent_suffix(e));
    } else if e == p - 1 {
        out.push_str(&m);
    } else if e >= 0 {
        let split = (e + 1) as usize;
        out.push_str(&m[..split]);
        out.push('.');
        out.push_str(&m[split..]);
    } else {
        out.push_str("0.");
        out.push_str(&"0".repeat((-(e + 1)) as usize));
        out.push_str(&m);
    }
    Ok(JsString::from(out))
}

/// `Number.prototype.toExponential(digits)`.
pub fn to_exponential(x: f64, digits: Maybe<f64>) -> JsResult<JsString> {
    let f = match digits {
        Maybe::Undefined => None,
        Maybe::Null => Some(0.0),
        Maybe::Some(d) => Some(to_integer_or_infinity(d)),
    };
    if !x.is_finite() {
        return Ok(JsString::from(number_to_string(x)));
    }
    if let Some(f) = f
        && !(0.0..=100.0).contains(&f)
    {
        return Err(Throw::range_error(
            "toExponential() argument must be between 0 and 100",
        ));
    }
    let mut out = String::new();
    let mut x = x;
    if x < 0.0 {
        out.push('-');
        x = -x;
    }
    let (m, e) = match f {
        _ if x == 0.0 => ("0".repeat(f.unwrap_or(0.0) as usize + 1), 0),
        None => {
            let (digits, e) = shortest_digits(x);
            (padded(&digits, digits.len()), e)
        }
        Some(f) => {
            let (digits, dp) = exact_decimal(x);
            let (digits, dp) = round_digits(&digits, dp, f as i32 + 1);
            (padded(&digits, f as usize + 1), dp - 1)
        }
    };
    out.push_str(&m[..1]);
    if m.len() > 1 {
        out.push('.');
        out.push_str(&m[1..]);
    }
    out.push_str(&exponent_suffix(e));
    Ok(JsString::from(out))
}

/// Global `parseInt(string, radix)`.
pub fn parse_int(s: &JsString, radix: Maybe<f64>) -> f64 {
    let (negative, mut s) = split_sign(trim_start(s.units()));
    let mut r = match radix {
        Maybe::Some(r) => to_int32(r),
        _ => 0,
    };
    let mut strip_prefix = true;
    if r != 0 {
        if !(2..=36).contains(&r) {
            return f64::NAN;
        }
        if r != 16 {
            strip_prefix = false;
        }
    } else {
        r = 10;
    }
    if strip_prefix && (starts_with_ascii(s, "0x") || starts_with_ascii(s, "0X")) {
        s = &s[2..];
        r = 16;
    }
    let r = r as u32;
    let end = s
        .iter()
        .position(|&u| digit_value(u) >= r)
        .unwrap_or(s.len());
    if end == 0 {
        return f64::NAN;
    }
    let value = integer_in_radix(&s[..end], r);
    if negative { -value } else { value }
}

/// The value of radix-`r` digits: correctly rounded for power-of-two radixes
/// and 10; otherwise V8's algorithm (ECMA-262 allows an approximation beyond
/// 20 significant digits for those radixes).
fn integer_in_radix(digits: &[u16], r: u32) -> f64 {
    let start = digits
        .iter()
        .position(|&u| u != u16::from(b'0'))
        .unwrap_or(digits.len());
    let digits = &digits[start..];
    if digits.is_empty() {
        return 0.0;
    }
    if r.is_power_of_two() {
        return pow2_radix_to_f64(digits, r.trailing_zeros());
    }
    if r == 10 {
        return parse_ascii_decimal(digits);
    }
    // V8 NumberParseIntHelper: 32-bit chunks combined in double arithmetic.
    const MAX_MULTIPLIER: u32 = 0xFFFF_FFFF / 36;
    let mut result = 0.0f64;
    let mut i = 0;
    while i < digits.len() {
        let (mut part, mut multiplier) = (0u32, 1u32);
        while i < digits.len() {
            let m = multiplier * r;
            if m > MAX_MULTIPLIER {
                break;
            }
            part = part * r + digit_value(digits[i]);
            multiplier = m;
            i += 1;
        }
        result = result * f64::from(multiplier) + f64::from(part);
    }
    result
}

/// Global `parseFloat(string)`.
pub fn parse_float(s: &JsString) -> f64 {
    let t = trim_start(s.units());
    let (negative, body) = split_sign(t);
    if starts_with_ascii(body, "Infinity") {
        return if negative {
            f64::NEG_INFINITY
        } else {
            f64::INFINITY
        };
    }
    let n = scan_unsigned_decimal(body);
    if n == 0 {
        return f64::NAN;
    }
    parse_ascii_decimal(&t[..t.len() - body.len() + n])
}

/// `Number.isInteger`.
pub fn is_integer(x: f64) -> bool {
    x.is_finite() && x.trunc() == x
}

/// `Number.isSafeInteger`.
pub fn is_safe_integer(x: f64) -> bool {
    is_integer(x) && x.abs() <= 9007199254740991.0
}

/// ToInt32 / ToUint32.
pub fn to_int32(x: f64) -> i32 {
    to_uint32(x) as i32
}

pub fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    // `%` is exact (fmod); the result lies in (-2^32, 2^32).
    let m = x.trunc() % 4294967296.0;
    (if m < 0.0 { m + 4294967296.0 } else { m }) as u32
}

/// `a ** b` (Number::exponentiate; differs from `powf` for ±1 ** ±Infinity and NaN exponents).
pub fn pow(a: f64, b: f64) -> f64 {
    if b.is_nan() || (a.abs() == 1.0 && b.is_infinite()) {
        return f64::NAN;
    }
    a.powf(b)
}

/// `a % b` (Number::remainder). Rust's `%` is C `fmod`: exact, with the sign
/// of the dividend, `x % ±Infinity == x` for finite `x`, and NaN for infinite
/// dividends or zero divisors.
pub fn rem(a: f64, b: f64) -> f64 {
    a % b
}

pub fn bit_and(a: f64, b: f64) -> f64 {
    f64::from(to_int32(a) & to_int32(b))
}
pub fn bit_or(a: f64, b: f64) -> f64 {
    f64::from(to_int32(a) | to_int32(b))
}
pub fn bit_xor(a: f64, b: f64) -> f64 {
    f64::from(to_int32(a) ^ to_int32(b))
}
pub fn bit_not(a: f64) -> f64 {
    f64::from(!to_int32(a))
}
pub fn shl(a: f64, b: f64) -> f64 {
    f64::from(to_int32(a).wrapping_shl(to_uint32(b) & 31))
}
pub fn shr(a: f64, b: f64) -> f64 {
    f64::from(to_int32(a) >> (to_uint32(b) & 31))
}
pub fn ushr(a: f64, b: f64) -> f64 {
    f64::from(to_uint32(a) >> (to_uint32(b) & 31))
}

/// `Math.*` (all except `random`). Variadic functions take slices.
///
/// Rounding, sign, `sqrt`, `hypot`, `min`/`max`, `clz32`, `fround` and `imul`
/// are exact. The transcendental functions are implementation-approximated in
/// ECMA-262; they use the platform libm with exact special values.
pub mod math {
    use super::{to_int32, to_uint32};

    /// Rounds half toward +Infinity; preserves -0 and maps [-0.5, -0) to -0.
    pub fn round(x: f64) -> f64 {
        if !x.is_finite() || x == 0.0 {
            return x;
        }
        if x > 0.0 && x < 0.5 {
            return 0.0;
        }
        if (-0.5..0.0).contains(&x) {
            return -0.0;
        }
        let r = x.floor();
        // Exact: the fractional part of a double is representable.
        if x - r >= 0.5 { r + 1.0 } else { r }
    }
    pub fn sign(x: f64) -> f64 {
        if x.is_nan() || x == 0.0 {
            x
        } else {
            x.signum()
        }
    }
    pub fn trunc(x: f64) -> f64 {
        x.trunc()
    }
    pub fn floor(x: f64) -> f64 {
        x.floor()
    }
    pub fn ceil(x: f64) -> f64 {
        x.ceil()
    }
    pub fn abs(x: f64) -> f64 {
        x.abs()
    }
    pub fn sqrt(x: f64) -> f64 {
        x.sqrt()
    }
    pub fn cbrt(x: f64) -> f64 {
        x.cbrt()
    }
    pub fn exp(x: f64) -> f64 {
        x.exp()
    }
    pub fn expm1(x: f64) -> f64 {
        x.exp_m1()
    }
    pub fn log(x: f64) -> f64 {
        x.ln()
    }
    pub fn log1p(x: f64) -> f64 {
        x.ln_1p()
    }
    pub fn log2(x: f64) -> f64 {
        x.log2()
    }
    pub fn log10(x: f64) -> f64 {
        x.log10()
    }
    pub fn sin(x: f64) -> f64 {
        x.sin()
    }
    pub fn cos(x: f64) -> f64 {
        x.cos()
    }
    pub fn tan(x: f64) -> f64 {
        x.tan()
    }
    pub fn asin(x: f64) -> f64 {
        x.asin()
    }
    pub fn acos(x: f64) -> f64 {
        x.acos()
    }
    pub fn atan(x: f64) -> f64 {
        x.atan()
    }
    pub fn atan2(y: f64, x: f64) -> f64 {
        y.atan2(x)
    }
    pub fn sinh(x: f64) -> f64 {
        x.sinh()
    }
    pub fn cosh(x: f64) -> f64 {
        x.cosh()
    }
    pub fn tanh(x: f64) -> f64 {
        x.tanh()
    }
    // The inverse hyperbolic functions follow fdlibm (as V8 does): Rust's std
    // versions lose precision (atanh) or overflow for large inputs (acosh).
    const LN2: f64 = std::f64::consts::LN_2;
    const TWO_POW_28: f64 = 268435456.0;

    pub fn asinh(x: f64) -> f64 {
        let a = x.abs();
        if !x.is_finite() || a < 1.0 / TWO_POW_28 {
            return x; // NaN, ±Infinity, ±0 and tiny values
        }
        let w = if a > TWO_POW_28 {
            a.ln() + LN2
        } else if a > 2.0 {
            (2.0 * a + 1.0 / ((x * x + 1.0).sqrt() + a)).ln()
        } else {
            let t = x * x;
            (a + t / (1.0 + (1.0 + t).sqrt())).ln_1p()
        };
        if x > 0.0 { w } else { -w }
    }
    pub fn acosh(x: f64) -> f64 {
        if x.is_nan() || x < 1.0 {
            f64::NAN
        } else if x >= TWO_POW_28 {
            if x.is_infinite() { x } else { x.ln() + LN2 }
        } else if x == 1.0 {
            0.0
        } else if x > 2.0 {
            (2.0 * x - 1.0 / (x + (x * x - 1.0).sqrt())).ln()
        } else {
            let t = x - 1.0;
            (t + (2.0 * t + t * t).sqrt()).ln_1p()
        }
    }
    pub fn atanh(x: f64) -> f64 {
        let a = x.abs();
        if x.is_nan() || a > 1.0 {
            return f64::NAN;
        }
        if a == 1.0 {
            return x / 0.0;
        }
        if a < 1.0 / TWO_POW_28 {
            return x;
        }
        let t = if a < 0.5 {
            let t = a + a;
            0.5 * (t + t * a / (1.0 - a)).ln_1p()
        } else {
            0.5 * ((a + a) / (1.0 - a)).ln_1p()
        };
        if x >= 0.0 { t } else { -t }
    }
    /// V8's algorithm: scale by the largest magnitude and sum the squares
    /// with Kahan compensation. Infinity wins over NaN.
    pub fn hypot(xs: &[f64]) -> f64 {
        let mut max = 0.0f64;
        let mut any_nan = false;
        for &x in xs {
            let a = x.abs();
            if a.is_nan() {
                any_nan = true;
            } else if a > max {
                max = a;
            }
        }
        if max == f64::INFINITY {
            return f64::INFINITY;
        }
        if any_nan {
            return f64::NAN;
        }
        if max == 0.0 {
            return 0.0;
        }
        let (mut sum, mut compensation) = (0.0f64, 0.0f64);
        for &x in xs {
            let n = x.abs() / max;
            let summand = n * n - compensation;
            let preliminary = sum + summand;
            compensation = (preliminary - sum) - summand;
            sum = preliminary;
        }
        sum.sqrt() * max
    }
    pub fn min(xs: &[f64]) -> f64 {
        xs.iter().fold(f64::INFINITY, |acc, &x| super::min(acc, x))
    }
    pub fn max(xs: &[f64]) -> f64 {
        xs.iter()
            .fold(f64::NEG_INFINITY, |acc, &x| super::max(acc, x))
    }
    /// The arguments of a call spreading an array (`Math.min(...xs)`):
    /// ToNumber of each element, in order. The elements are primitives or
    /// dates (the IR catalogue), whose conversion has no side effects, so
    /// converting all before comparing is the specification's order.
    fn arguments<T: crate::ToNumber>(xs: &crate::JsArray<T>) -> Vec<f64> {
        xs.borrow().iter().map(crate::ToNumber::to_number).collect()
    }
    /// `Math.min(...xs)`: +Infinity for an empty array.
    pub fn min_of<T: crate::ToNumber>(xs: &crate::JsArray<T>) -> f64 {
        min(&arguments(xs))
    }
    /// `Math.max(...xs)`: -Infinity for an empty array.
    pub fn max_of<T: crate::ToNumber>(xs: &crate::JsArray<T>) -> f64 {
        max(&arguments(xs))
    }
    /// `Math.hypot(...xs)`: +0 for an empty array.
    pub fn hypot_of<T: crate::ToNumber>(xs: &crate::JsArray<T>) -> f64 {
        hypot(&arguments(xs))
    }
    pub fn pow(a: f64, b: f64) -> f64 {
        super::pow(a, b)
    }
    pub fn clz32(x: f64) -> f64 {
        f64::from(to_uint32(x).leading_zeros())
    }
    pub fn fround(x: f64) -> f64 {
        f64::from(x as f32)
    }
    pub fn imul(a: f64, b: f64) -> f64 {
        f64::from(to_int32(a).wrapping_mul(to_int32(b)))
    }
}
