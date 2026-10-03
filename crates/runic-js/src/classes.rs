//! Class toggles (Svelte's `class:` directive, docs/IR.md "Class toggles"):
//! the composed class attribute when the class value changes, and
//! `classList.toggle` (DOMTokenList) when only a toggle changes. Strings
//! are UTF-16, as in JavaScript.

use crate::JsString;

/// Whitespace for removing a toggled-off name from the class value.
const COMPOSE_WHITESPACE: [u16; 8] = [0x20, 0x09, 0x0a, 0x0d, 0x0c, 0xa0, 0x0b, 0xfeff];
/// ASCII whitespace (DOMTokenList).
const ASCII_WHITESPACE: [u16; 5] = [0x20, 0x09, 0x0a, 0x0c, 0x0d];

fn find(hay: &[u16], needle: &[u16], from: usize) -> Option<usize> {
    if needle.is_empty() {
        return (from <= hay.len()).then_some(from);
    }
    (from..=hay.len().saturating_sub(needle.len())).find(|&i| hay[i..].starts_with(needle))
}

/// The class attribute for `value` and the toggles: names switched on are
/// appended, names switched off removed where they stand as whole words.
/// `None` when the result is empty (the attribute is removed).
pub fn class_compose(value: &JsString, toggles: &[(&str, bool)]) -> Option<JsString> {
    let mut class: Vec<u16> = value.units().to_vec();
    for &(name, on) in toggles {
        let key: Vec<u16> = name.encode_utf16().collect();
        if on {
            if !class.is_empty() {
                class.push(0x20);
            }
            class.extend(&key);
        } else if !class.is_empty() {
            let mut a = 0;
            while let Some(found) = find(&class, &key, a) {
                a = found;
                let b = a + key.len();
                let before = a == 0 || COMPOSE_WHITESPACE.contains(&class[a - 1]);
                let after = b == class.len() || COMPOSE_WHITESPACE.contains(&class[b]);
                if before && after {
                    // The name and the character after it.
                    let end = (b + 1).min(class.len());
                    class.drain(a..end);
                } else {
                    a = b;
                }
            }
        }
    }
    (!class.is_empty()).then(|| JsString::from_units(class))
}

/// `classList.toggle(name, on)` on the attribute `current` (`None`: absent):
/// the new attribute, or `None` when the token set does not change (the
/// attribute is then left as it is).
pub fn class_toggle(current: Option<&JsString>, name: &str, on: bool) -> Option<JsString> {
    let units: &[u16] = current.map_or(&[], |c| c.units());
    let mut tokens: Vec<&[u16]> = vec![];
    for t in units.split(|u| ASCII_WHITESPACE.contains(u)) {
        if !t.is_empty() && !tokens.contains(&t) {
            tokens.push(t);
        }
    }
    let key: Vec<u16> = name.encode_utf16().collect();
    let present = tokens.contains(&key.as_slice());
    if present == on {
        return None;
    }
    if on {
        tokens.push(&key);
    } else {
        tokens.retain(|t| *t != key.as_slice());
    }
    Some(JsString::from_units(tokens.join(&0x20)))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(x: &str) -> JsString {
        JsString::from(x)
    }

    #[test]
    fn compose_like_svelte() {
        assert_eq!(class_compose(&s(""), &[("a", true)]), Some(s("a")));
        assert_eq!(class_compose(&s(""), &[("a", false)]), None);
        assert_eq!(class_compose(&s("x a y"), &[("a", false)]), Some(s("x y")));
        // The character after the name goes with it: a trailing space stays.
        assert_eq!(class_compose(&s("x a"), &[("a", false)]), Some(s("x ")));
        assert_eq!(class_compose(&s("ab a"), &[("a", false)]), Some(s("ab ")));
        assert_eq!(class_compose(&s("a"), &[("a", true)]), Some(s("a a")));
    }

    #[test]
    fn toggle_like_dom_token_list() {
        assert_eq!(class_toggle(None, "a", true), Some(s("a")));
        assert_eq!(class_toggle(None, "a", false), None);
        assert_eq!(
            class_toggle(Some(&s("x  x y")), "a", true),
            Some(s("x y a"))
        );
        assert_eq!(class_toggle(Some(&s("x  y")), "x", true), None);
        assert_eq!(class_toggle(Some(&s("a")), "a", false), Some(s("")));
    }
}
