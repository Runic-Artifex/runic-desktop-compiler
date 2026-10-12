//! Image objects' reflected attributes (M6 images, `new Image()`): the
//! values `crossOrigin` and `referrerPolicy` read back after a write, as
//! HTML reflects enumerated attributes (Chromium 153 measured the same).

/// The `crossOrigin` an image reads after `value` was written: `None`
/// (null) for null, `use-credentials` for that keyword in any ASCII case,
/// and `anonymous` for any other string (the attribute's invalid value
/// default; JavaScript's `undefined` is written as the string "undefined").
pub fn cross_origin(value: Option<&str>) -> Option<&'static str> {
    match value {
        None => None,
        Some(v) if v.eq_ignore_ascii_case("use-credentials") => Some("use-credentials"),
        Some(_) => Some("anonymous"),
    }
}

/// The referrer policies `referrerPolicy` reflects (lowercase).
const REFERRER_POLICIES: &[&str] = &[
    "no-referrer",
    "no-referrer-when-downgrade",
    "same-origin",
    "origin",
    "strict-origin",
    "origin-when-cross-origin",
    "strict-origin-when-cross-origin",
    "unsafe-url",
];

/// The `referrerPolicy` an image reads after `value` was written: a known
/// policy in any ASCII case as its lowercase keyword, anything else empty.
pub fn referrer_policy(value: &str) -> &'static str {
    REFERRER_POLICIES
        .iter()
        .find(|p| p.eq_ignore_ascii_case(value))
        .copied()
        .unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflects_as_chromium() {
        assert_eq!(cross_origin(None), None);
        assert_eq!(cross_origin(Some("anonymous")), Some("anonymous"));
        assert_eq!(cross_origin(Some("foo")), Some("anonymous"));
        assert_eq!(cross_origin(Some("")), Some("anonymous"));
        assert_eq!(
            cross_origin(Some("USE-Credentials")),
            Some("use-credentials")
        );
        assert_eq!(referrer_policy("bogus"), "");
        assert_eq!(referrer_policy("No-Referrer"), "no-referrer");
        assert_eq!(referrer_policy(""), "");
    }
}
