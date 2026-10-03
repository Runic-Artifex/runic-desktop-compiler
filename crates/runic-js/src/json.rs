//! Family D: JSON. Signatures are frozen (docs/design/M2-VALUES.md);
//! behaviour must match ECMAScript `JSON.stringify`/`JSON.parse` exactly
//! (output text; error type) and is tested against Node-generated vectors
//! (tests/vectors/json.json). Error message texts are V8-like but not
//! guaranteed identical.

use std::collections::HashMap;

use crate::{JsArray, JsResult, JsString, Maybe, Throw, array, number_to_string};

/// A JSON value. Object members keep insertion order.
#[derive(Clone, Debug, PartialEq)]
pub enum Json {
    Null,
    Bool(bool),
    Num(f64),
    Str(JsString),
    Array(Vec<Json>),
    Object(Vec<(JsString, Json)>),
}

/// QuoteJSONString (escapes lone surrogates as \uXXXX).
pub fn quote(s: &JsString) -> JsString {
    let mut out = Vec::with_capacity(s.len() + 2);
    quote_into(s.units(), &mut out);
    JsString::from_units(out)
}

/// SerializeJSONProperty over an already converted value; `indent` is the
/// `space` argument (number clamped to 10, or the first 10 units of a string).
pub fn stringify(v: &Json, indent: &Indent) -> JsString {
    // `None` is the compact layout. V8 deviates from the specification for
    // a number `space` in (0, 1): the specification makes the gap empty and
    // the output compact, while V8 switches to the multi-line layout with an
    // empty indentation unit. We follow V8 (the reference engine).
    let gap: Option<Vec<u16>> = match indent {
        Indent::None => None,
        // `n > 0.0` is false for NaN; ToIntegerOrInfinity then clamp to 10.
        Indent::Spaces(n) if *n > 0.0 => Some(vec![u16::from(b' '); n.min(10.0) as usize]),
        Indent::Spaces(_) => None,
        Indent::Text(s) if s.is_empty() => None,
        Indent::Text(s) => Some(s.units()[..s.len().min(10)].to_vec()),
    };
    let mut out = Vec::new();
    let layout = Layout {
        pretty: gap.is_some(),
        gap: gap.as_deref().unwrap_or_default(),
    };
    serialize(v, &layout, &mut Vec::new(), &mut out);
    JsString::from_units(out)
}

#[derive(Clone, Debug, Default)]
pub enum Indent {
    #[default]
    None,
    Spaces(f64),
    Text(JsString),
}

/// JSON.parse; SyntaxError on invalid input. Duplicate keys: last wins (in
/// the first key's position, as in V8).
pub fn parse(text: &JsString) -> JsResult<Json> {
    Parser {
        src: text.units(),
        pos: 0,
    }
    .parse()
}

/// Conversion of typed values for stringify; `None` is `undefined`
/// (omitted from objects, `null` inside arrays).
pub trait ToJson {
    fn to_json(&self) -> Option<Json>;
}
impl ToJson for f64 {
    fn to_json(&self) -> Option<Json> {
        Some(if self.is_finite() {
            Json::Num(*self)
        } else {
            Json::Null
        })
    }
}
impl ToJson for bool {
    fn to_json(&self) -> Option<Json> {
        Some(Json::Bool(*self))
    }
}
impl ToJson for JsString {
    fn to_json(&self) -> Option<Json> {
        Some(Json::Str(self.clone()))
    }
}
impl<T: ToJson> ToJson for Maybe<T> {
    fn to_json(&self) -> Option<Json> {
        match self {
            Maybe::Undefined => None,
            Maybe::Null => Some(Json::Null),
            Maybe::Some(v) => v.to_json(),
        }
    }
}
impl<T: ToJson> ToJson for JsArray<T> {
    fn to_json(&self) -> Option<Json> {
        let items = self
            .borrow()
            .iter()
            .map(|v| v.to_json().unwrap_or(Json::Null))
            .collect();
        Some(Json::Array(items))
    }
}

/// Typed reading of parsed JSON with shape checks; a mismatch throws a
/// SyntaxError naming the expected type (our addition to JSON.parse).
pub trait FromJson: Sized {
    fn from_json(j: &Json) -> JsResult<Self>;
}
impl FromJson for f64 {
    fn from_json(j: &Json) -> JsResult<Self> {
        match j {
            Json::Num(x) => Ok(*x),
            other => Err(shape_error("number", other)),
        }
    }
}
impl FromJson for bool {
    fn from_json(j: &Json) -> JsResult<Self> {
        match j {
            Json::Bool(b) => Ok(*b),
            other => Err(shape_error("boolean", other)),
        }
    }
}
impl FromJson for JsString {
    fn from_json(j: &Json) -> JsResult<Self> {
        match j {
            Json::Str(s) => Ok(s.clone()),
            other => Err(shape_error("string", other)),
        }
    }
}
impl<T: FromJson> FromJson for Maybe<T> {
    fn from_json(j: &Json) -> JsResult<Self> {
        match j {
            Json::Null => Ok(Maybe::Null),
            other => T::from_json(other).map(Maybe::Some),
        }
    }
}
impl<T: FromJson> FromJson for JsArray<T> {
    fn from_json(j: &Json) -> JsResult<Self> {
        match j {
            Json::Array(items) => Ok(array(
                items
                    .iter()
                    .map(T::from_json)
                    .collect::<JsResult<Vec<T>>>()?,
            )),
            other => Err(shape_error("array", other)),
        }
    }
}

fn kind_name(j: &Json) -> &'static str {
    match j {
        Json::Null => "null",
        Json::Bool(_) => "boolean",
        Json::Num(_) => "number",
        Json::Str(_) => "string",
        Json::Array(_) => "array",
        Json::Object(_) => "object",
    }
}

fn shape_error(expected: &str, found: &Json) -> Throw {
    Throw::syntax_error(format!(
        "JSON value does not match the expected type: expected {expected}, found {}",
        kind_name(found)
    ))
}

// ---------------------------------------------------------------------------
// Serialization

fn push_ascii(out: &mut Vec<u16>, s: &str) {
    out.extend(s.bytes().map(u16::from));
}

fn push_unicode_escape(out: &mut Vec<u16>, unit: u16) {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    push_ascii(out, "\\u");
    for shift in [12, 8, 4, 0] {
        out.push(u16::from(HEX[usize::from((unit >> shift) & 0xf)]));
    }
}

fn is_high_surrogate(u: u16) -> bool {
    (0xd800..=0xdbff).contains(&u)
}

fn is_low_surrogate(u: u16) -> bool {
    (0xdc00..=0xdfff).contains(&u)
}

fn quote_into(units: &[u16], out: &mut Vec<u16>) {
    out.push(u16::from(b'"'));
    let mut i = 0;
    while i < units.len() {
        let u = units[i];
        match u {
            0x22 => push_ascii(out, "\\\""),
            0x5c => push_ascii(out, "\\\\"),
            0x08 => push_ascii(out, "\\b"),
            0x0c => push_ascii(out, "\\f"),
            0x0a => push_ascii(out, "\\n"),
            0x0d => push_ascii(out, "\\r"),
            0x09 => push_ascii(out, "\\t"),
            0x00..=0x1f => push_unicode_escape(out, u),
            _ if is_high_surrogate(u) => match units.get(i + 1) {
                Some(&next) if is_low_surrogate(next) => {
                    out.extend_from_slice(&[u, next]);
                    i += 1;
                }
                _ => push_unicode_escape(out, u),
            },
            _ if is_low_surrogate(u) => push_unicode_escape(out, u),
            _ => out.push(u),
        }
        i += 1;
    }
    out.push(u16::from(b'"'));
}

/// The `space` argument resolved: multi-line output (`pretty`) indents each
/// level by `gap` and puts a space after `:`.
struct Layout<'a> {
    pretty: bool,
    gap: &'a [u16],
}

fn serialize(v: &Json, layout: &Layout, indent: &mut Vec<u16>, out: &mut Vec<u16>) {
    match v {
        Json::Null => push_ascii(out, "null"),
        Json::Bool(b) => push_ascii(out, if *b { "true" } else { "false" }),
        Json::Num(x) if x.is_finite() => push_ascii(out, &number_to_string(*x)),
        Json::Num(_) => push_ascii(out, "null"),
        Json::Str(s) => quote_into(s.units(), out),
        Json::Array(items) => serialize_container(
            items,
            b'[',
            b']',
            layout,
            indent,
            out,
            |item, indent, out| serialize(item, layout, indent, out),
        ),
        Json::Object(members) => serialize_container(
            members,
            b'{',
            b'}',
            layout,
            indent,
            out,
            |(key, value), indent, out| {
                quote_into(key.units(), out);
                out.push(u16::from(b':'));
                if layout.pretty {
                    out.push(u16::from(b' '));
                }
                serialize(value, layout, indent, out);
            },
        ),
    }
}

/// SerializeJSONArray/SerializeJSONObject layout: compact, or one member per
/// line at `indent + gap`; `[]`/`{}` when empty.
fn serialize_container<T>(
    items: &[T],
    open: u8,
    close: u8,
    layout: &Layout,
    indent: &mut Vec<u16>,
    out: &mut Vec<u16>,
    mut member: impl FnMut(&T, &mut Vec<u16>, &mut Vec<u16>),
) {
    out.push(u16::from(open));
    if !items.is_empty() {
        let stepback = indent.len();
        indent.extend_from_slice(layout.gap);
        for (i, item) in items.iter().enumerate() {
            if i > 0 {
                out.push(u16::from(b','));
            }
            if layout.pretty {
                out.push(u16::from(b'\n'));
                out.extend_from_slice(indent);
            }
            member(item, indent, out);
        }
        indent.truncate(stepback);
        if layout.pretty {
            out.push(u16::from(b'\n'));
            out.extend_from_slice(indent);
        }
    }
    out.push(u16::from(close));
}

// ---------------------------------------------------------------------------
// Parsing (ECMA-404 grammar). Iterative, so nesting depth is bounded only by
// memory, as in V8.

enum Frame {
    Array(Vec<Json>),
    Object {
        members: Vec<(JsString, Json)>,
        index: HashMap<JsString, usize>,
        key: JsString,
    },
}

struct Parser<'a> {
    src: &'a [u16],
    pos: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u16> {
        self.src.get(self.pos).copied()
    }

    fn skip_whitespace(&mut self) {
        while matches!(self.peek(), Some(0x09 | 0x0a | 0x0d | 0x20)) {
            self.pos += 1;
        }
    }

    fn error(&self, message: &str) -> Throw {
        Throw::syntax_error(format!("{message} in JSON at position {}", self.pos))
    }

    /// The error for the code unit at the current position (or end of input).
    fn unexpected(&self) -> Throw {
        match self.peek() {
            None => Throw::syntax_error("Unexpected end of JSON input"),
            Some(u) => {
                let token = String::from_utf16_lossy(&[u]);
                Throw::syntax_error(format!(
                    "Unexpected token '{token}' in JSON at position {}",
                    self.pos
                ))
            }
        }
    }

    fn expect(&mut self, unit: u8) -> JsResult<()> {
        if self.peek() == Some(u16::from(unit)) {
            self.pos += 1;
            Ok(())
        } else {
            Err(self.unexpected())
        }
    }

    fn parse(mut self) -> JsResult<Json> {
        let mut stack: Vec<Frame> = Vec::new();
        'value: loop {
            self.skip_whitespace();
            let mut value = match self.peek() {
                Some(0x5b) => {
                    self.pos += 1;
                    self.skip_whitespace();
                    if self.peek() == Some(0x5d) {
                        self.pos += 1;
                        Json::Array(Vec::new())
                    } else {
                        stack.push(Frame::Array(Vec::new()));
                        continue 'value;
                    }
                }
                Some(0x7b) => {
                    self.pos += 1;
                    self.skip_whitespace();
                    if self.peek() == Some(0x7d) {
                        self.pos += 1;
                        Json::Object(Vec::new())
                    } else {
                        let key = self.parse_key()?;
                        stack.push(Frame::Object {
                            members: Vec::new(),
                            index: HashMap::new(),
                            key,
                        });
                        continue 'value;
                    }
                }
                Some(0x22) => Json::Str(self.parse_string()?),
                Some(0x2d | 0x30..=0x39) => Json::Num(self.parse_number()?),
                Some(0x74) => self.parse_literal("true", Json::Bool(true))?,
                Some(0x66) => self.parse_literal("false", Json::Bool(false))?,
                Some(0x6e) => self.parse_literal("null", Json::Null)?,
                _ => return Err(self.unexpected()),
            };
            // Attach the completed value to its container, closing every
            // container that ends here.
            loop {
                match stack.last_mut() {
                    None => {
                        self.skip_whitespace();
                        if self.pos < self.src.len() {
                            return Err(
                                self.error("Unexpected non-whitespace character after JSON")
                            );
                        }
                        return Ok(value);
                    }
                    Some(Frame::Array(items)) => {
                        items.push(value);
                        self.skip_whitespace();
                        match self.peek() {
                            Some(0x2c) => {
                                self.pos += 1;
                                continue 'value;
                            }
                            Some(0x5d) => {
                                self.pos += 1;
                                let Some(Frame::Array(items)) = stack.pop() else {
                                    unreachable!()
                                };
                                value = Json::Array(items);
                            }
                            _ => return Err(self.unexpected()),
                        }
                    }
                    Some(Frame::Object {
                        members,
                        index,
                        key,
                    }) => {
                        let key = std::mem::take(key);
                        match index.get(&key) {
                            Some(&i) => members[i].1 = value,
                            None => {
                                index.insert(key.clone(), members.len());
                                members.push((key, value));
                            }
                        }
                        self.skip_whitespace();
                        match self.peek() {
                            Some(0x2c) => {
                                self.pos += 1;
                                let next = self.parse_key()?;
                                if let Some(Frame::Object { key, .. }) = stack.last_mut() {
                                    *key = next;
                                }
                                continue 'value;
                            }
                            Some(0x7d) => {
                                self.pos += 1;
                                let Some(Frame::Object { members, .. }) = stack.pop() else {
                                    unreachable!()
                                };
                                value = Json::Object(order_members(members));
                            }
                            _ => return Err(self.unexpected()),
                        }
                    }
                }
            }
        }
    }

    /// A member name and the following `:`.
    fn parse_key(&mut self) -> JsResult<JsString> {
        self.skip_whitespace();
        if self.peek() != Some(0x22) {
            return Err(self.unexpected());
        }
        let key = self.parse_string()?;
        self.skip_whitespace();
        self.expect(b':')?;
        Ok(key)
    }

    fn parse_literal(&mut self, word: &str, value: Json) -> JsResult<Json> {
        for b in word.bytes() {
            self.expect(b)?;
        }
        Ok(value)
    }

    /// A string starting at the opening quote; escapes keep code units
    /// exactly (unpaired `\uD800` stays a lone surrogate).
    fn parse_string(&mut self) -> JsResult<JsString> {
        let start = self.pos;
        self.pos += 1;
        let mut units = Vec::new();
        loop {
            let run = self.pos;
            while matches!(self.peek(), Some(u) if u >= 0x20 && u != 0x22 && u != 0x5c) {
                self.pos += 1;
            }
            units.extend_from_slice(&self.src[run..self.pos]);
            match self.peek() {
                None => {
                    self.pos = start;
                    return Err(self.error("Unterminated string"));
                }
                Some(0x22) => {
                    self.pos += 1;
                    return Ok(JsString::from_units(units));
                }
                Some(0x5c) => {
                    self.pos += 1;
                    let unit = match self.peek() {
                        Some(0x22) => 0x22,
                        Some(0x5c) => 0x5c,
                        Some(0x2f) => 0x2f,
                        Some(0x62) => 0x08,
                        Some(0x66) => 0x0c,
                        Some(0x6e) => 0x0a,
                        Some(0x72) => 0x0d,
                        Some(0x74) => 0x09,
                        Some(0x75) => {
                            let mut code = 0u16;
                            for k in 1..=4 {
                                let digit = self
                                    .src
                                    .get(self.pos + k)
                                    .and_then(|&u| char::from_u32(u32::from(u)))
                                    .and_then(|c| c.to_digit(16));
                                match digit {
                                    Some(d) => code = code << 4 | d as u16,
                                    None => {
                                        self.pos += k;
                                        return Err(self.error("Bad Unicode escape"));
                                    }
                                }
                            }
                            self.pos += 4;
                            code
                        }
                        None => return Err(self.error("Unterminated string")),
                        Some(_) => return Err(self.error("Bad escaped character")),
                    };
                    self.pos += 1;
                    units.push(unit);
                }
                Some(_) => return Err(self.error("Bad control character in string literal")),
            }
        }
    }

    /// JSON number grammar: `-? (0 | [1-9][0-9]*) (. [0-9]+)? ([eE] [+-]? [0-9]+)?`,
    /// converted with round-to-nearest (Rust's `f64` parser is correctly rounded).
    fn parse_number(&mut self) -> JsResult<f64> {
        let start = self.pos;
        let is_digit = |u: Option<u16>| matches!(u, Some(0x30..=0x39));
        if self.peek() == Some(0x2d) {
            self.pos += 1;
            if !is_digit(self.peek()) {
                return Err(match self.peek() {
                    None => self.error("No number after minus sign"),
                    Some(_) => self.unexpected(),
                });
            }
        }
        if self.peek() == Some(0x30) {
            self.pos += 1;
        } else {
            while is_digit(self.peek()) {
                self.pos += 1;
            }
        }
        if self.peek() == Some(0x2e) {
            self.pos += 1;
            if !is_digit(self.peek()) {
                return Err(match self.peek() {
                    None => self.error("Unterminated fractional number"),
                    Some(_) => self.unexpected(),
                });
            }
            while is_digit(self.peek()) {
                self.pos += 1;
            }
        }
        if matches!(self.peek(), Some(0x65 | 0x45)) {
            self.pos += 1;
            if matches!(self.peek(), Some(0x2b | 0x2d)) {
                self.pos += 1;
            }
            if !is_digit(self.peek()) {
                return Err(match self.peek() {
                    None => self.error("Exponent part is missing a number"),
                    Some(_) => self.unexpected(),
                });
            }
            while is_digit(self.peek()) {
                self.pos += 1;
            }
        }
        let text: String = self.src[start..self.pos]
            .iter()
            .map(|&u| u as u8 as char)
            .collect();
        Ok(text.parse::<f64>().expect("validated JSON number"))
    }
}

/// Property order of an ordinary object (OrdinaryOwnPropertyKeys): array
/// indices ascending, then the other keys in creation order.
fn order_members(members: Vec<(JsString, Json)>) -> Vec<(JsString, Json)> {
    if !members.iter().any(|(k, _)| array_index(k).is_some()) {
        return members;
    }
    let mut indexed = Vec::new();
    let mut named = Vec::new();
    for (key, value) in members {
        match array_index(&key) {
            Some(i) => indexed.push((i, key, value)),
            None => named.push((key, value)),
        }
    }
    indexed.sort_by_key(|(i, _, _)| *i);
    indexed
        .into_iter()
        .map(|(_, k, v)| (k, v))
        .chain(named)
        .collect()
}

/// A canonical array index: decimal digits without leading zeros, below 2^32 - 1.
fn array_index(key: &JsString) -> Option<u32> {
    let units = key.units();
    if units.is_empty() || units.len() > 10 || (units.len() > 1 && units[0] == 0x30) {
        return None;
    }
    let mut n: u64 = 0;
    for &u in units {
        if !(0x30..=0x39).contains(&u) {
            return None;
        }
        n = n * 10 + u64::from(u - 0x30);
    }
    if n < u64::from(u32::MAX) {
        Some(n as u32)
    } else {
        None
    }
}
