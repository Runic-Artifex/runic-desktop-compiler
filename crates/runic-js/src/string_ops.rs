//! Family B: `String.prototype` methods on UTF-16 `JsString`. Signatures are
//! frozen (docs/design/M2-VALUES.md); behaviour must match ECMAScript exactly
//! and is tested against Node-generated vectors (tests/vectors/string.json).
//! Positions and lengths are UTF-16 code units; numeric arguments go through
//! ToIntegerOrInfinity as the specification requires.

use crate::{JsArray, JsResult, JsString, Maybe, Throw, array, number_to_string};
use std::cmp::Ordering;

// ---------------------------------------------------------------------------
// Abstract operations (ECMA-262) used by this family.

/// ToIntegerOrInfinity (7.1.5): NaN → 0, ±Infinity kept, truncation, -0 → +0.
fn to_integer_or_infinity(x: f64) -> f64 {
    if x.is_nan() {
        0.0
    } else {
        // `trunc` keeps infinities; adding +0 turns -0 into +0.
        x.trunc() + 0.0
    }
}

/// ToNumber of an optional numeric argument: `undefined` → NaN, `null` → +0.
fn maybe_number(x: &Maybe<f64>) -> f64 {
    match x {
        Maybe::Some(v) => *v,
        Maybe::Undefined => f64::NAN,
        Maybe::Null => 0.0,
    }
}

/// ToIntegerOrInfinity clamped to `0..=len`, as a code-unit index.
fn clamp_position(pos: f64, len: usize) -> usize {
    let pos = to_integer_or_infinity(pos);
    if pos <= 0.0 {
        0
    } else if pos >= len as f64 {
        len
    } else {
        pos as usize
    }
}

/// Relative index (`slice`): negative values count from the end; clamped to `0..=len`.
fn relative_position(pos: f64, len: usize) -> usize {
    let pos = to_integer_or_infinity(pos);
    if pos < 0.0 {
        let p = len as f64 + pos;
        if p <= 0.0 { 0 } else { p as usize }
    } else if pos >= len as f64 {
        len
    } else {
        pos as usize
    }
}

/// ToUint32 (7.1.7).
fn to_uint32(x: f64) -> u32 {
    if !x.is_finite() {
        return 0;
    }
    x.trunc().rem_euclid(4294967296.0) as u32
}

/// ToUint16 (7.1.9).
fn to_uint16(x: f64) -> u16 {
    if !x.is_finite() {
        return 0;
    }
    x.trunc().rem_euclid(65536.0) as u16
}

/// ToLength (7.1.20).
fn to_length(x: f64) -> f64 {
    let len = to_integer_or_infinity(x);
    if len <= 0.0 {
        0.0
    } else {
        len.min(9007199254740991.0)
    }
}

/// StringIndexOf (6.1.4.1): `None` stands for -1.
fn string_index_of(s: &[u16], search: &[u16], from: usize) -> Option<usize> {
    let len = s.len();
    if search.is_empty() {
        return if from <= len { Some(from) } else { None };
    }
    if search.len() > len {
        return None;
    }
    (from..=len - search.len()).find(|&i| &s[i..i + search.len()] == search)
}

fn is_lead(u: u16) -> bool {
    (0xD800..0xDC00).contains(&u)
}

fn is_trail(u: u16) -> bool {
    (0xDC00..0xE000).contains(&u)
}

/// CodePointAt (11.1.4): the code point at `i` and its length in code units.
/// Lone surrogates are returned as themselves.
fn code_point_at_index(units: &[u16], i: usize) -> (u32, usize) {
    let first = units[i];
    if is_lead(first) && i + 1 < units.len() && is_trail(units[i + 1]) {
        let cp = 0x10000 + ((u32::from(first) - 0xD800) << 10) + (u32::from(units[i + 1]) - 0xDC00);
        (cp, 2)
    } else {
        (u32::from(first), 1)
    }
}

/// WhiteSpace or LineTerminator (12.2, 12.3). Every such code point is in the
/// BMP, so testing code units is exact. USP is general category Zs.
fn is_trim_space(u: u16) -> bool {
    matches!(
        u,
        0x0009 | 0x000B | 0x000C | 0xFEFF // TAB, VT, FF, ZWNBSP
            | 0x0020 | 0x00A0 | 0x1680 | 0x2000
            ..=0x200A | 0x202F | 0x205F | 0x3000 // Zs
            | 0x000A | 0x000D | 0x2028 | 0x2029 // LF, CR, LS, PS
    )
}

fn unit_string(u: u16) -> JsString {
    JsString::from_units(vec![u])
}

fn units_string(units: &[u16]) -> JsString {
    JsString::from_units(units.to_vec())
}

// ---------------------------------------------------------------------------
// Character access.

/// `s.at(i)`
pub fn at(s: &JsString, i: f64) -> Maybe<JsString> {
    let len = s.len() as f64;
    let rel = to_integer_or_infinity(i);
    let k = if rel >= 0.0 { rel } else { len + rel };
    if k < 0.0 || k >= len {
        Maybe::Undefined
    } else {
        Maybe::Some(unit_string(s.units()[k as usize]))
    }
}

/// `s[i]` (property access; undefined out of range or for non-integral i)
pub fn index(s: &JsString, i: f64) -> Maybe<JsString> {
    // The key is ToString(i): "-0" never arises because ToString(-0) is "0".
    if i.is_finite() && i.trunc() == i && i >= 0.0 && i < s.len() as f64 {
        Maybe::Some(unit_string(s.units()[i as usize]))
    } else {
        Maybe::Undefined
    }
}

/// Index for `charAt`/`charCodeAt`/`codePointAt`: `None` when out of range.
fn char_position(s: &JsString, i: f64) -> Option<usize> {
    let pos = to_integer_or_infinity(i);
    if pos < 0.0 || pos >= s.len() as f64 {
        None
    } else {
        Some(pos as usize)
    }
}

pub fn char_at(s: &JsString, i: f64) -> JsString {
    match char_position(s, i) {
        Some(p) => unit_string(s.units()[p]),
        None => JsString::new(),
    }
}

pub fn char_code_at(s: &JsString, i: f64) -> f64 {
    match char_position(s, i) {
        Some(p) => f64::from(s.units()[p]),
        None => f64::NAN,
    }
}

pub fn code_point_at(s: &JsString, i: f64) -> Maybe<f64> {
    match char_position(s, i) {
        Some(p) => Maybe::Some(f64::from(code_point_at_index(s.units(), p).0)),
        None => Maybe::Undefined,
    }
}

// ---------------------------------------------------------------------------
// Substrings.

pub fn slice(s: &JsString, start: f64, end: Maybe<f64>) -> JsString {
    let len = s.len();
    let from = relative_position(start, len);
    let to = match end {
        Maybe::Undefined => len,
        other => relative_position(maybe_number(&other), len),
    };
    if from >= to {
        JsString::new()
    } else if from == 0 && to == len {
        s.clone()
    } else {
        s.slice_units(from, to)
    }
}

pub fn substring(s: &JsString, start: f64, end: Maybe<f64>) -> JsString {
    let len = s.len();
    let a = clamp_position(start, len);
    let b = match end {
        Maybe::Undefined => len,
        other => clamp_position(maybe_number(&other), len),
    };
    let (from, to) = if a <= b { (a, b) } else { (b, a) };
    if from == 0 && to == len {
        s.clone()
    } else {
        s.slice_units(from, to)
    }
}

// ---------------------------------------------------------------------------
// Searching.

pub fn index_of(s: &JsString, search: &JsString, from: Maybe<f64>) -> f64 {
    let start = clamp_position(maybe_number(&from), s.len());
    match string_index_of(s.units(), search.units(), start) {
        Some(i) => i as f64,
        None => -1.0,
    }
}

pub fn last_index_of(s: &JsString, search: &JsString, from: Maybe<f64>) -> f64 {
    let len = s.len();
    let num = maybe_number(&from);
    let start = if num.is_nan() {
        len
    } else {
        clamp_position(num, len)
    };
    let search = search.units();
    if search.len() > len {
        return -1.0;
    }
    let units = s.units();
    (0..=start.min(len - search.len()))
        .rev()
        .find(|&i| &units[i..i + search.len()] == search)
        .map_or(-1.0, |i| i as f64)
}

pub fn includes(s: &JsString, search: &JsString, from: Maybe<f64>) -> bool {
    index_of(s, search, from) >= 0.0
}

pub fn starts_with(s: &JsString, search: &JsString, from: Maybe<f64>) -> bool {
    let start = clamp_position(maybe_number(&from), s.len());
    let search = search.units();
    let end = start + search.len();
    end <= s.len() && &s.units()[start..end] == search
}

pub fn ends_with(s: &JsString, search: &JsString, end: Maybe<f64>) -> bool {
    let len = s.len();
    let end = match end {
        Maybe::Undefined => len,
        other => clamp_position(maybe_number(&other), len),
    };
    let search = search.units();
    match end.checked_sub(search.len()) {
        Some(start) => &s.units()[start..end] == search,
        None => false,
    }
}

// ---------------------------------------------------------------------------
// Trimming.

/// White space and line terminators per ECMA-262 (incl. U+FEFF, U+00A0, Zs).
pub fn trim(s: &JsString) -> JsString {
    trim_units(s, true, true)
}

pub fn trim_start(s: &JsString) -> JsString {
    trim_units(s, true, false)
}

pub fn trim_end(s: &JsString) -> JsString {
    trim_units(s, false, true)
}

fn trim_units(s: &JsString, start: bool, end: bool) -> JsString {
    let units = s.units();
    let mut from = 0;
    let mut to = units.len();
    if start {
        while from < to && is_trim_space(units[from]) {
            from += 1;
        }
    }
    if end {
        while to > from && is_trim_space(units[to - 1]) {
            to -= 1;
        }
    }
    if from == 0 && to == units.len() {
        s.clone()
    } else {
        s.slice_units(from, to)
    }
}

// ---------------------------------------------------------------------------
// Case conversion.

/// Unicode default case conversion (incl. special casing such as ß → SS).
pub fn to_upper_case(s: &JsString) -> JsString {
    convert_case(s, false)
}

pub fn to_lower_case(s: &JsString) -> JsString {
    convert_case(s, true)
}

/// Applies a full Unicode case mapping to each maximal run of well-formed
/// UTF-16 and keeps lone surrogates unchanged (String.prototype.toLowerCase
/// interprets the string as code points, 6.1.4). Splitting at lone surrogates
/// does not change the Final_Sigma context because a surrogate code point is
/// neither Cased nor Case_Ignorable. Rust's `str` mappings implement the
/// unconditional SpecialCasing entries and Final_Sigma.
fn convert_case(s: &JsString, lower: bool) -> JsString {
    let map: fn(&str) -> String = if lower {
        str::to_lowercase
    } else {
        str::to_uppercase
    };
    let units = s.units();
    // Fast path for ASCII.
    if units.iter().all(|&u| u < 0x80) {
        let mut out: Vec<u16> = Vec::with_capacity(units.len());
        let mut changed = false;
        for &u in units {
            let c = u as u8;
            let m = if lower {
                c.to_ascii_lowercase()
            } else {
                c.to_ascii_uppercase()
            };
            changed |= m != c;
            out.push(u16::from(m));
        }
        return if changed {
            JsString::from_units(out)
        } else {
            s.clone()
        };
    }
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut run = String::new();
    let mut i = 0;
    while i < units.len() {
        let (cp, n) = code_point_at_index(units, i);
        match char::from_u32(cp) {
            Some(c) => run.push(c),
            None => {
                out.extend(map(&run).encode_utf16());
                run.clear();
                out.push(units[i]);
            }
        }
        i += n;
    }
    out.extend(map(&run).encode_utf16());
    if out.as_slice() == units {
        s.clone()
    } else {
        JsString::from_units(out)
    }
}

// ---------------------------------------------------------------------------
// Padding and repetition.

pub fn pad_start(s: &JsString, length: f64, fill: Maybe<JsString>) -> JsString {
    pad(s, length, fill, true)
}

pub fn pad_end(s: &JsString, length: f64, fill: Maybe<JsString>) -> JsString {
    pad(s, length, fill, false)
}

/// StringPad (22.1.3.17.2). Lengths beyond the engine's maximum string length
/// throw a RangeError in V8; the frozen signature cannot, so such calls fail
/// on allocation instead.
fn pad(s: &JsString, max_length: f64, fill: Maybe<JsString>, at_start: bool) -> JsString {
    let int_max = to_length(max_length);
    let len = s.len();
    if int_max <= len as f64 {
        return s.clone();
    }
    let filler = match fill {
        Maybe::Undefined => JsString::from(" "),
        Maybe::Null => JsString::from("null"),
        Maybe::Some(f) => f,
    };
    if filler.is_empty() {
        return s.clone();
    }
    let fill_len = int_max as usize - len;
    let mut out: Vec<u16> = Vec::with_capacity(int_max as usize);
    if !at_start {
        out.extend_from_slice(s.units());
    }
    out.extend(filler.units().iter().copied().cycle().take(fill_len));
    if at_start {
        out.extend_from_slice(s.units());
    }
    JsString::from_units(out)
}

/// V8's maximum string length on 64-bit targets (`String::kMaxLength`).
const MAX_STRING_LENGTH: usize = (1 << 29) - 24;

/// RangeError for negative or infinite counts.
pub fn repeat(s: &JsString, count: f64) -> JsResult<JsString> {
    let n = to_integer_or_infinity(count);
    if n < 0.0 || n == f64::INFINITY {
        return Err(Throw::range_error(format!(
            "Invalid count value: {}",
            number_to_string(count)
        )));
    }
    if n == 0.0 || s.is_empty() {
        return Ok(JsString::new());
    }
    if n == 1.0 {
        return Ok(s.clone());
    }
    if n * s.len() as f64 > MAX_STRING_LENGTH as f64 {
        return Err(Throw::range_error("Invalid string length"));
    }
    Ok(JsString::from_units(s.units().repeat(n as usize)))
}

// ---------------------------------------------------------------------------
// Splitting and replacing.

/// String separators only (RegExp separators are M5); `undefined` separator → [s].
pub fn split(s: &JsString, separator: Maybe<JsString>, limit: Maybe<f64>) -> JsArray<JsString> {
    let lim = match limit {
        Maybe::Undefined => u32::MAX as usize,
        other => to_uint32(maybe_number(&other)) as usize,
    };
    let sep = match separator {
        Maybe::Undefined => {
            return array(if lim == 0 {
                Vec::new()
            } else {
                vec![s.clone()]
            });
        }
        Maybe::Null => JsString::from("null"),
        Maybe::Some(sep) => sep,
    };
    if lim == 0 {
        return array(Vec::new());
    }
    let units = s.units();
    if sep.is_empty() {
        return array(units.iter().take(lim).map(|&u| unit_string(u)).collect());
    }
    if units.is_empty() {
        return array(vec![s.clone()]);
    }
    let sep = sep.units();
    let mut parts = Vec::new();
    let mut i = 0;
    let mut j = string_index_of(units, sep, 0);
    while let Some(found) = j {
        parts.push(units_string(&units[i..found]));
        if parts.len() == lim {
            return array(parts);
        }
        i = found + sep.len();
        j = string_index_of(units, sep, i);
    }
    parts.push(units_string(&units[i..]));
    array(parts)
}

/// GetSubstitution (22.1.3.19.1) for a string pattern: there are no captures,
/// so `$n`, `$nn` and `$<` remain literal.
fn get_substitution(
    out: &mut Vec<u16>,
    matched_len: usize,
    s: &[u16],
    position: usize,
    template: &[u16],
) {
    const DOLLAR: u16 = b'$' as u16;
    let mut k = 0;
    while k < template.len() {
        let u = template[k];
        if u == DOLLAR && k + 1 < template.len() {
            match template[k + 1] {
                0x24 /* $ */ => {
                    out.push(DOLLAR);
                    k += 2;
                    continue;
                }
                0x60 /* ` */ => {
                    out.extend_from_slice(&s[..position]);
                    k += 2;
                    continue;
                }
                0x26 /* & */ => {
                    out.extend_from_slice(&s[position..position + matched_len]);
                    k += 2;
                    continue;
                }
                0x27 /* ' */ => {
                    let tail = (position + matched_len).min(s.len());
                    out.extend_from_slice(&s[tail..]);
                    k += 2;
                    continue;
                }
                _ => {}
            }
        }
        out.push(u);
        k += 1;
    }
}

/// String patterns with GetSubstitution (`$$`, `$&`, `` $` ``, `$'`).
pub fn replace(s: &JsString, pattern: &JsString, replacement: &JsString) -> JsString {
    let units = s.units();
    let Some(pos) = string_index_of(units, pattern.units(), 0) else {
        return s.clone();
    };
    let end = pos + pattern.len();
    let mut out = Vec::with_capacity(units.len() + replacement.len());
    out.extend_from_slice(&units[..pos]);
    get_substitution(&mut out, pattern.len(), units, pos, replacement.units());
    out.extend_from_slice(&units[end..]);
    JsString::from_units(out)
}

pub fn replace_all(s: &JsString, pattern: &JsString, replacement: &JsString) -> JsString {
    let units = s.units();
    let search = pattern.units();
    let advance = search.len().max(1);
    let mut positions = Vec::new();
    let mut p = string_index_of(units, search, 0);
    while let Some(found) = p {
        positions.push(found);
        p = string_index_of(units, search, found + advance);
    }
    if positions.is_empty() {
        return s.clone();
    }
    let mut out = Vec::with_capacity(units.len());
    let mut end_of_last = 0;
    for p in positions {
        out.extend_from_slice(&units[end_of_last..p]);
        get_substitution(&mut out, search.len(), units, p, replacement.units());
        end_of_last = p + search.len();
    }
    if end_of_last < units.len() {
        out.extend_from_slice(&units[end_of_last..]);
    }
    JsString::from_units(out)
}

pub fn concat(s: &JsString, others: &[JsString]) -> JsString {
    if others.is_empty() {
        return s.clone();
    }
    let total = s.len() + others.iter().map(JsString::len).sum::<usize>();
    let mut out = Vec::with_capacity(total);
    out.extend_from_slice(s.units());
    for o in others {
        out.extend_from_slice(o.units());
    }
    JsString::from_units(out)
}

// ---------------------------------------------------------------------------
// Comparison and construction.

/// Relational comparison of strings (`<`): code-unit order.
pub fn compare(a: &JsString, b: &JsString) -> Ordering {
    a.units().cmp(b.units())
}

/// `a.localeCompare(b)` without locales or options: ICU collation for the
/// default locale (`crate::intl`), returning -1, 0 or 1.
pub fn locale_compare(a: &JsString, b: &JsString) -> f64 {
    crate::intl::compare_default(a, b)
}

/// `String.fromCharCode(...units)`: ToUint16 of each argument.
pub fn from_char_code(units: &[f64]) -> JsString {
    JsString::from_units(units.iter().map(|&u| to_uint16(u)).collect())
}

/// Code points of a string (string iterator / `Array.from(s)` / `for-of`).
/// Lone surrogates are yielded individually.
pub fn code_points(s: &JsString) -> Vec<JsString> {
    let units = s.units();
    let mut out = Vec::new();
    let mut i = 0;
    while i < units.len() {
        let (_, n) = code_point_at_index(units, i);
        out.push(units_string(&units[i..i + n]));
        i += n;
    }
    out
}
