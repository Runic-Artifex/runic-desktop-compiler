//! `JsString`: an immutable sequence of UTF-16 code units (ECMA-262 String
//! type). Conversion to UTF-8 happens only at the DOM boundary.

use std::fmt;
use std::rc::Rc;

#[derive(Clone, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct JsString(Rc<[u16]>);

impl JsString {
    pub fn new() -> Self {
        thread_local!(static EMPTY: JsString = JsString(Rc::from(&[][..])));
        EMPTY.with(Clone::clone)
    }
    pub fn from_units(units: Vec<u16>) -> Self {
        JsString(Rc::from(units))
    }
    pub fn units(&self) -> &[u16] {
        &self.0
    }
    /// `length` in UTF-16 code units.
    pub fn len(&self) -> usize {
        self.0.len()
    }
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
    /// UTF-8 rendering; lone surrogates become U+FFFD (as when browsers render text).
    pub fn to_rust(&self) -> String {
        String::from_utf16_lossy(&self.0)
    }
    pub fn concat(&self, other: &JsString) -> JsString {
        if other.is_empty() {
            return self.clone();
        }
        if self.is_empty() {
            return other.clone();
        }
        let mut v = Vec::with_capacity(self.len() + other.len());
        v.extend_from_slice(&self.0);
        v.extend_from_slice(&other.0);
        JsString::from_units(v)
    }
    /// Code units `start..end` (clamped).
    pub fn slice_units(&self, start: usize, end: usize) -> JsString {
        let end = end.min(self.len());
        let start = start.min(end);
        JsString::from_units(self.0[start..end].to_vec())
    }
}

impl Default for JsString {
    fn default() -> Self {
        JsString::new()
    }
}

impl From<&str> for JsString {
    fn from(s: &str) -> Self {
        JsString::from_units(s.encode_utf16().collect())
    }
}

impl From<String> for JsString {
    fn from(s: String) -> Self {
        JsString::from(s.as_str())
    }
}

impl fmt::Display for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.to_rust())
    }
}

impl fmt::Debug for JsString {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?}", self.to_rust())
    }
}
