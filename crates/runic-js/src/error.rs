//! Exceptions. M2 supports throwing and catching Error-like values
//! (`{ name, message }`); see docs/design/M2-VALUES.md.

use crate::JsString;
use std::fmt;

#[derive(Clone, Debug, PartialEq)]
pub struct Throw {
    /// `Error`, `TypeError`, `RangeError`, `SyntaxError`, ...
    pub name: JsString,
    pub message: JsString,
}

pub type JsResult<T> = Result<T, Throw>;

impl Throw {
    pub fn new(name: &str, message: impl Into<String>) -> Self {
        Throw {
            name: JsString::from(name),
            message: JsString::from(message.into()),
        }
    }
    pub fn type_error(message: impl Into<String>) -> Self {
        Throw::new("TypeError", message)
    }
    pub fn range_error(message: impl Into<String>) -> Self {
        Throw::new("RangeError", message)
    }
    pub fn syntax_error(message: impl Into<String>) -> Self {
        Throw::new("SyntaxError", message)
    }
}

impl fmt::Display for Throw {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.message.is_empty() {
            write!(f, "{}", self.name)
        } else {
            write!(f, "{}: {}", self.name, self.message)
        }
    }
}
