//! The document element (`document.documentElement`) as scripts change it:
//! attributes (`dataset`, `lang`, `dir`), the class list (DOMTokenList
//! semantics) and the inline style (CSSOM). The generated app and the
//! interpreter keep one; the runtime applies it to `<html>`.

use std::collections::BTreeMap;

const ASCII_WHITESPACE: [char; 5] = [' ', '\t', '\n', '\x0c', '\r'];

/// A DOMException for an invalid class token: (name, message).
pub type TokenError = (&'static str, &'static str);

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Root {
    attrs: BTreeMap<String, String>,
    /// Changed since the runtime last applied it.
    dirty: bool,
}

fn token(name: &str) -> Result<(), TokenError> {
    if name.is_empty() {
        return Err(("SyntaxError", "The token provided must not be empty."));
    }
    if name.contains(ASCII_WHITESPACE) {
        return Err((
            "InvalidCharacterError",
            "The token provided contains HTML space characters, which are not valid in tokens.",
        ));
    }
    Ok(())
}

impl Root {
    pub fn attrs(&self) -> &BTreeMap<String, String> {
        &self.attrs
    }
    pub fn get(&self, name: &str) -> Option<&str> {
        self.attrs.get(name).map(String::as_str)
    }
    pub fn set(&mut self, name: &str, value: &str) {
        if self.attrs.get(name).map(String::as_str) != Some(value) {
            self.attrs.insert(name.to_owned(), value.to_owned());
            self.dirty = true;
        }
    }
    pub fn remove(&mut self, name: &str) {
        if self.attrs.remove(name).is_some() {
            self.dirty = true;
        }
    }

    fn tokens(&self) -> Vec<&str> {
        let mut out: Vec<&str> = vec![];
        for t in self.get("class").unwrap_or("").split(ASCII_WHITESPACE) {
            if !t.is_empty() && !out.contains(&t) {
                out.push(t);
            }
        }
        out
    }

    /// `classList.contains(name)`.
    pub fn class_contains(&self, name: &str) -> bool {
        self.tokens().contains(&name)
    }

    /// `classList.toggle(name, force)`: whether the name is present after.
    pub fn class_toggle(&mut self, name: &str, force: Option<bool>) -> Result<bool, TokenError> {
        token(name)?;
        let present = self.class_contains(name);
        let want = force.unwrap_or(!present);
        if want != present {
            let mut tokens: Vec<String> = self.tokens().into_iter().map(str::to_owned).collect();
            if want {
                tokens.push(name.to_owned());
            } else {
                tokens.retain(|t| t != name);
            }
            self.set("class", &tokens.join(" "));
        }
        Ok(want)
    }

    /// `classList.add(name)` / `classList.remove(name)`: the attribute is
    /// rewritten (normalized) even when the set does not change.
    pub fn class_set(&mut self, name: &str, on: bool) -> Result<(), TokenError> {
        token(name)?;
        let mut tokens: Vec<String> = self.tokens().into_iter().map(str::to_owned).collect();
        let present = tokens.iter().any(|t| t == name);
        if on && !present {
            tokens.push(name.to_owned());
        } else if !on {
            tokens.retain(|t| t != name);
        }
        if self.get("class").is_some() || !tokens.is_empty() {
            self.set("class", &tokens.join(" "));
        }
        Ok(())
    }

    /// `style.setProperty(name, value)` (an empty value removes it; an
    /// invalid one changes nothing).
    pub fn style_set(&mut self, name: &str, value: &str) {
        if let Some(css) = crate::set_property(self.get("style").unwrap_or(""), name, value, false)
        {
            self.set("style", &css);
        }
    }

    /// `style.removeProperty(name)`: the removed value.
    pub fn style_remove(&mut self, name: &str) -> String {
        let current = self.get("style").unwrap_or("").to_owned();
        let old = crate::get_property(&current, name);
        if self.get("style").is_some() {
            let css = crate::remove_property(&current, name);
            self.set("style", &css);
        }
        old
    }

    /// `style.getPropertyValue(name)`.
    pub fn style_get(&self, name: &str) -> String {
        crate::get_property(self.get("style").unwrap_or(""), name)
    }

    /// Whether it changed since the last call.
    pub fn take_dirty(&mut self) -> bool {
        std::mem::take(&mut self.dirty)
    }
}
