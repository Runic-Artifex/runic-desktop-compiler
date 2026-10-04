//! URI handling functions (ECMA-262 §19.2.6: `encodeURIComponent`,
//! `decodeURIComponent`, `decodeURI`) over UTF-16 strings, and the
//! `application/x-www-form-urlencoded` parsing of `URLSearchParams`.

use crate::{JsResult, JsString, Throw};

fn malformed() -> Throw {
    Throw::new("URIError", "URI malformed")
}

/// Characters `encodeURIComponent` leaves as they are.
fn unreserved_component(u: u16) -> bool {
    matches!(u, 0x41..=0x5A | 0x61..=0x7A | 0x30..=0x39)
        || b"-_.!~*'()".iter().any(|&c| u16::from(c) == u)
}

/// `encodeURIComponent(s)`: UTF-8 percent-encoding of everything outside
/// the unreserved set; a lone surrogate throws `URIError`.
pub fn encode_uri_component(s: &JsString) -> JsResult<JsString> {
    let units = s.units();
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        if unreserved_component(u) {
            out.push(u);
            i += 1;
            continue;
        }
        let cp = if (0xD800..0xDC00).contains(&u) {
            match units.get(i + 1) {
                Some(&l) if (0xDC00..0xE000).contains(&l) => {
                    i += 1;
                    0x10000 + ((u32::from(u) - 0xD800) << 10) + (u32::from(l) - 0xDC00)
                }
                _ => return Err(malformed()),
            }
        } else if (0xDC00..0xE000).contains(&u) {
            return Err(malformed());
        } else {
            u32::from(u)
        };
        let ch = char::from_u32(cp).ok_or_else(malformed)?;
        let mut buf = [0u8; 4];
        for b in ch.encode_utf8(&mut buf).bytes() {
            for c in format!("%{b:02X}").bytes() {
                out.push(u16::from(c));
            }
        }
        i += 1;
    }
    Ok(JsString::from_units(out))
}

fn hex(u: u16) -> Option<u8> {
    match u {
        0x30..=0x39 => Some((u - 0x30) as u8),
        0x41..=0x46 => Some((u - 0x41 + 10) as u8),
        0x61..=0x66 => Some((u - 0x61 + 10) as u8),
        _ => None,
    }
}

/// The spec's Decode(string, preserveEscapeSet): `%XX` sequences are UTF-8
/// decoded; an escape of a single-byte character in `reserved` stays as
/// written. Malformed escapes and invalid UTF-8 throw `URIError`.
fn decode(s: &JsString, reserved: &[u8]) -> JsResult<JsString> {
    let units = s.units();
    let mut out: Vec<u16> = Vec::with_capacity(units.len());
    let byte_at = |k: usize| -> JsResult<u8> {
        if units.get(k) != Some(&u16::from(b'%')) {
            return Err(malformed());
        }
        match (
            units.get(k + 1).and_then(|&u| hex(u)),
            units.get(k + 2).and_then(|&u| hex(u)),
        ) {
            (Some(h), Some(l)) => Ok(h * 16 + l),
            _ => Err(malformed()),
        }
    };
    let mut k = 0;
    while k < units.len() {
        if units[k] != u16::from(b'%') {
            out.push(units[k]);
            k += 1;
            continue;
        }
        let start = k;
        let b = byte_at(k)?;
        k += 3;
        if b < 0x80 {
            if reserved.contains(&b) {
                out.extend_from_slice(&units[start..k]);
            } else {
                out.push(u16::from(b));
            }
            continue;
        }
        let n = match b {
            0xC0..=0xDF => 2,
            0xE0..=0xEF => 3,
            0xF0..=0xF7 => 4,
            _ => return Err(malformed()),
        };
        let mut bytes = vec![b];
        for _ in 1..n {
            let c = byte_at(k)?;
            if c & 0xC0 != 0x80 {
                return Err(malformed());
            }
            bytes.push(c);
            k += 3;
        }
        let text = std::str::from_utf8(&bytes).map_err(|_| malformed())?;
        let mut buf = [0u16; 2];
        for ch in text.chars() {
            out.extend_from_slice(ch.encode_utf16(&mut buf));
        }
    }
    Ok(JsString::from_units(out))
}

/// `decodeURIComponent(s)`.
pub fn decode_uri_component(s: &JsString) -> JsResult<JsString> {
    decode(s, b"")
}

/// `decodeURI(s)`: escapes of `;/?:@&=+$,#` stay escaped.
pub fn decode_uri(s: &JsString) -> JsResult<JsString> {
    decode(s, b";/?:@&=+$,#")
}

/// The name-value pairs of a query (`location.search`, with or without its
/// `?`), as `new URLSearchParams(search)` parses them: split at `&`, at the
/// first `=`, `+` as a space, percent-decoded as UTF-8 with replacement.
pub fn query_pairs(search: &JsString) -> Vec<(JsString, JsString)> {
    let text = search.to_rust();
    let text = text.strip_prefix('?').unwrap_or(&text);
    url::form_urlencoded::parse(text.as_bytes())
        .map(|(k, v)| (JsString::from(k.as_ref()), JsString::from(v.as_ref())))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> JsString {
        JsString::from(x)
    }

    #[test]
    fn encoding_and_decoding() {
        assert_eq!(
            encode_uri_component(&s("a b/ä😀-_.!~*'()")).unwrap(),
            s("a%20b%2F%C3%A4%F0%9F%98%80-_.!~*'()")
        );
        assert!(encode_uri_component(&JsString::from_units(vec![0xD800])).is_err());
        assert_eq!(
            decode_uri_component(&s("a%20b%2F%C3%A4")).unwrap(),
            s("a b/ä")
        );
        assert_eq!(
            decode_uri(&s("a%20b%2F%23%C3%A4")).unwrap(),
            s("a b%2F%23ä")
        );
        assert!(decode_uri_component(&s("%E0%A4%A")).is_err());
        assert!(decode_uri_component(&s("%C3")).is_err());
        assert!(decode_uri_component(&s("%FF")).is_err());
    }

    #[test]
    fn query() {
        let pairs = query_pairs(&s("?a=1&b=x+y&a=%C3%A4&c&=d"));
        let text: Vec<(String, String)> = pairs
            .iter()
            .map(|(k, v)| (k.to_rust(), v.to_rust()))
            .collect();
        assert_eq!(
            text,
            [("a", "1"), ("b", "x y"), ("a", "ä"), ("c", ""), ("", "d")]
                .map(|(a, b)| (a.to_owned(), b.to_owned()))
        );
    }
}
