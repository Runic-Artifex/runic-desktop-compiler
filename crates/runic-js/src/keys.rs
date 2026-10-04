//! Key specifications as the conformance harness writes them (Playwright's
//! `Shift+Tab`, `Enter`, `a`), resolved on the US keyboard layout Playwright
//! uses: the `KeyboardEvent.key` and `code` values and the modifiers. As in
//! Playwright, modifiers do not change the key (`Shift+a` presses `a`) and
//! are pressed as keys of their own around it (see [`MODIFIER_KEYS`]).

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KeySpec {
    pub key: String,
    pub code: String,
    pub ctrl: bool,
    pub shift: bool,
    pub alt: bool,
    pub meta: bool,
    /// The modifier keys in the order written (pressed in this order,
    /// released in reverse): (key, code).
    pub modifiers: Vec<(&'static str, &'static str)>,
}

/// The modifier keys: (name, code).
pub const MODIFIER_KEYS: [(&str, &str); 4] = [
    ("Shift", "ShiftLeft"),
    ("Control", "ControlLeft"),
    ("Alt", "AltLeft"),
    ("Meta", "MetaLeft"),
];

const NAMED: &[&str] = &[
    "Enter",
    "Tab",
    "Escape",
    "Backspace",
    "Delete",
    "ArrowLeft",
    "ArrowRight",
    "ArrowUp",
    "ArrowDown",
    "Home",
    "End",
    "PageUp",
    "PageDown",
    "Insert",
];

/// US layout: (unshifted, shifted, code).
const PUNCTUATION: &[(char, char, &str)] = &[
    ('1', '!', "Digit1"),
    ('2', '@', "Digit2"),
    ('3', '#', "Digit3"),
    ('4', '$', "Digit4"),
    ('5', '%', "Digit5"),
    ('6', '^', "Digit6"),
    ('7', '&', "Digit7"),
    ('8', '*', "Digit8"),
    ('9', '(', "Digit9"),
    ('0', ')', "Digit0"),
    ('-', '_', "Minus"),
    ('=', '+', "Equal"),
    ('[', '{', "BracketLeft"),
    (']', '}', "BracketRight"),
    ('\\', '|', "Backslash"),
    (';', ':', "Semicolon"),
    ('\'', '"', "Quote"),
    (',', '<', "Comma"),
    ('.', '>', "Period"),
    ('/', '?', "Slash"),
    ('`', '~', "Backquote"),
];

/// Resolve a key specification; `None` for a key the US layout lacks.
pub fn parse_key_spec(spec: &str) -> Option<KeySpec> {
    let mut out = KeySpec::default();
    let mut name = spec;
    while let Some((m, rest)) = name.split_once('+').filter(|(_, r)| !r.is_empty()) {
        match m {
            "Shift" => out.shift = true,
            "Control" => out.ctrl = true,
            "Alt" => out.alt = true,
            "Meta" => out.meta = true,
            _ => return None,
        }
        let key = MODIFIER_KEYS
            .iter()
            .find(|(k, _)| *k == m)
            .expect("modifier");
        if !out.modifiers.contains(key) {
            out.modifiers.push(*key);
        }
        name = rest;
    }
    // A modifier pressed on its own (`Shift`): its key and left code.
    if let Some(&(key, code)) = MODIFIER_KEYS.iter().find(|(k, _)| *k == name) {
        out.key = key.into();
        out.code = code.into();
        return Some(out);
    }
    if NAMED.contains(&name) {
        out.key = name.into();
        out.code = name.into();
        return Some(out);
    }
    // Playwright types line breaks with the Enter key.
    if matches!(name, "\n" | "\r") {
        out.key = "Enter".into();
        out.code = "Enter".into();
        return Some(out);
    }
    let name = if name == "Space" { " " } else { name };
    let mut chars = name.chars();
    let (Some(c), None) = (chars.next(), chars.next()) else {
        return None;
    };
    let code = if c == ' ' {
        "Space".to_owned()
    } else if c.is_ascii_alphabetic() {
        format!("Key{}", c.to_ascii_uppercase())
    } else {
        let &(_, _, code) = PUNCTUATION.iter().find(|(p, s, _)| *p == c || *s == c)?;
        code.to_owned()
    };
    out.key = c.to_string();
    out.code = code;
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn specs() {
        let k = parse_key_spec("Shift+Tab").unwrap();
        assert_eq!(
            (k.key.as_str(), k.code.as_str(), k.shift),
            ("Tab", "Tab", true)
        );
        let k = parse_key_spec("a").unwrap();
        assert_eq!((k.key.as_str(), k.code.as_str()), ("a", "KeyA"));
        let k = parse_key_spec("Shift+a").unwrap();
        assert_eq!((k.key.as_str(), k.code.as_str()), ("a", "KeyA"));
        let k = parse_key_spec("Control+1").unwrap();
        assert_eq!(
            (k.key.as_str(), k.code.as_str(), k.ctrl),
            ("1", "Digit1", true)
        );
        assert_eq!(parse_key_spec("Space").unwrap().code, "Space");
        assert_eq!(parse_key_spec("?").unwrap().code, "Slash");
        assert!(parse_key_spec("é").is_none());
    }
}
