//! A subset of CSS selectors for `querySelector`/`querySelectorAll` (M6,
//! bits-ui's roving focus group: `[data-tabs-trigger]:not([data-disabled])`,
//! `#id`), shared by the interpreter and the native runtime so that both
//! match alike. Selector lists of compound selectors joined by descendant
//! (` `) or child (`>`) combinators; a compound selector is an optional tag
//! name or `*`, then `#id`, `.class`, `[attr]`, `[attr=value]` (a name or a
//! quoted string) and `:not(compound)`. Anything else is unsupported (an
//! error naming the selector); names are ASCII identifiers.

/// An element on the path from the root, as the matcher reads it.
pub trait SelElement {
    /// The local name (lowercase for HTML elements).
    fn tag(&self) -> &str;
    /// The value of an attribute, if present.
    fn attr(&self, name: &str) -> Option<&str>;
}

#[derive(Clone, Debug, PartialEq)]
enum Simple {
    Tag(String),
    Id(String),
    Class(String),
    Has(String),
    Equals(String, String),
    Not(Vec<Simple>),
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Combinator {
    Descendant,
    Child,
}

/// One complex selector: compounds from left to right, each but the first
/// with the combinator before it.
#[derive(Clone, Debug, PartialEq)]
struct Complex(Vec<(Option<Combinator>, Vec<Simple>)>);

/// A parsed selector list.
#[derive(Clone, Debug, PartialEq)]
pub struct Selector(Vec<Complex>);

struct Parser<'a> {
    s: &'a [u8],
    i: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.s.get(self.i).copied()
    }
    fn spaces(&mut self) -> bool {
        let start = self.i;
        while self.peek().is_some_and(|c| c.is_ascii_whitespace()) {
            self.i += 1;
        }
        self.i > start
    }
    fn ident(&mut self) -> Option<String> {
        let start = self.i;
        while self
            .peek()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
        {
            self.i += 1;
        }
        (self.i > start && !self.s[start].is_ascii_digit())
            .then(|| String::from_utf8_lossy(&self.s[start..self.i]).into_owned())
    }
    fn compound(&mut self) -> Option<Vec<Simple>> {
        let mut out = vec![];
        if self.peek() == Some(b'*') {
            self.i += 1;
        } else if self.peek().is_some_and(|c| c.is_ascii_alphabetic()) {
            out.push(Simple::Tag(self.ident()?.to_ascii_lowercase()));
        }
        loop {
            match self.peek() {
                Some(b'#') => {
                    self.i += 1;
                    out.push(Simple::Id(self.ident()?));
                }
                Some(b'.') => {
                    self.i += 1;
                    out.push(Simple::Class(self.ident()?));
                }
                Some(b'[') => {
                    self.i += 1;
                    self.spaces();
                    let name = self.ident()?.to_ascii_lowercase();
                    self.spaces();
                    match self.peek() {
                        Some(b']') => {
                            self.i += 1;
                            out.push(Simple::Has(name));
                        }
                        Some(b'=') => {
                            self.i += 1;
                            self.spaces();
                            let value = match self.peek() {
                                Some(q @ (b'"' | b'\'')) => {
                                    self.i += 1;
                                    let start = self.i;
                                    while self.peek().is_some_and(|c| c != q && c != b'\\') {
                                        self.i += 1;
                                    }
                                    if self.peek() != Some(q) {
                                        return None;
                                    }
                                    let v = String::from_utf8_lossy(&self.s[start..self.i])
                                        .into_owned();
                                    self.i += 1;
                                    v
                                }
                                _ => self.ident()?,
                            };
                            self.spaces();
                            if self.peek() != Some(b']') {
                                return None;
                            }
                            self.i += 1;
                            out.push(Simple::Equals(name, value));
                        }
                        _ => return None,
                    }
                }
                Some(b':') => {
                    if !self.s[self.i..].starts_with(b":not(") {
                        return None;
                    }
                    self.i += 5;
                    self.spaces();
                    let inner = self.compound()?;
                    self.spaces();
                    if inner.is_empty() || self.peek() != Some(b')') {
                        return None;
                    }
                    self.i += 1;
                    out.push(Simple::Not(inner));
                }
                _ => return Some(out),
            }
        }
    }
    fn complex(&mut self) -> Option<Complex> {
        self.spaces();
        let mut parts = vec![];
        let mut combinator = None;
        loop {
            let c = self.compound()?;
            if c.is_empty() && self.i.checked_sub(1).and_then(|i| self.s.get(i)) != Some(&b'*') {
                return None;
            }
            parts.push((combinator, c));
            let spaced = self.spaces();
            match self.peek() {
                None | Some(b',') => return Some(Complex(parts)),
                Some(b'>') => {
                    self.i += 1;
                    self.spaces();
                    combinator = Some(Combinator::Child);
                }
                Some(_) if spaced => combinator = Some(Combinator::Descendant),
                Some(_) => return None,
            }
        }
    }
}

/// Parse a selector list of the supported subset.
pub fn parse_selector(text: &str) -> Result<Selector, String> {
    let mut p = Parser {
        s: text.as_bytes(),
        i: 0,
    };
    let mut list = vec![];
    loop {
        let Some(c) = p.complex() else {
            return Err(format!(
                "the selector {text:?} is outside the supported subset"
            ));
        };
        list.push(c);
        match p.peek() {
            None => return Ok(Selector(list)),
            Some(b',') => p.i += 1,
            _ => {
                return Err(format!(
                    "the selector {text:?} is outside the supported subset"
                ));
            }
        }
    }
}

fn simple_matches<E: SelElement>(s: &Simple, e: &E) -> bool {
    match s {
        Simple::Tag(t) => e.tag() == t,
        Simple::Id(id) => e.attr("id") == Some(id.as_str()),
        Simple::Class(c) => e
            .attr("class")
            .is_some_and(|v| v.split_ascii_whitespace().any(|w| w == c)),
        Simple::Has(n) => e.attr(n).is_some(),
        Simple::Equals(n, v) => e.attr(n) == Some(v.as_str()),
        Simple::Not(inner) => !inner.iter().all(|s| simple_matches(s, e)),
    }
}

fn compound_matches<E: SelElement>(c: &[Simple], e: &E) -> bool {
    c.iter().all(|s| simple_matches(s, e))
}

/// Whether compounds `parts[..=k]` match with `parts[k]` at `path[at]`.
fn complex_matches<E: SelElement>(
    parts: &[(Option<Combinator>, Vec<Simple>)],
    k: usize,
    path: &[E],
    at: usize,
) -> bool {
    if !compound_matches(&parts[k].1, &path[at]) {
        return false;
    }
    let Some(combinator) = parts[k].0 else {
        return true;
    };
    match combinator {
        Combinator::Child => at > 0 && complex_matches(parts, k - 1, path, at - 1),
        Combinator::Descendant => (0..at)
            .rev()
            .any(|a| complex_matches(parts, k - 1, path, a)),
    }
}

impl Selector {
    /// Whether the last element of `path` (the elements from the root down
    /// to it) matches.
    pub fn matches<E: SelElement>(&self, path: &[E]) -> bool {
        let Some(last) = path.len().checked_sub(1) else {
            return false;
        };
        self.0
            .iter()
            .any(|c| complex_matches(&c.0, c.0.len() - 1, path, last))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct E(&'static str, Vec<(&'static str, &'static str)>);
    impl SelElement for E {
        fn tag(&self) -> &str {
            self.0
        }
        fn attr(&self, name: &str) -> Option<&str> {
            self.1.iter().find(|(n, _)| *n == name).map(|(_, v)| *v)
        }
    }

    #[test]
    fn bits_selectors() {
        let s = parse_selector("[data-tabs-trigger]:not([data-disabled])").unwrap();
        let path = [
            E("div", vec![]),
            E("button", vec![("data-tabs-trigger", "")]),
        ];
        assert!(s.matches(&path));
        let disabled = [E(
            "button",
            vec![("data-tabs-trigger", ""), ("data-disabled", "")],
        )];
        assert!(!s.matches(&disabled));
        let id = parse_selector("#bits-c3").unwrap();
        assert!(id.matches(&[E("div", vec![("id", "bits-c3")])]));
        let nested = parse_selector("div > .a b[x='1'], p").unwrap();
        let path = [
            E("div", vec![]),
            E("span", vec![("class", "z a")]),
            E("i", vec![]),
            E("b", vec![("x", "1")]),
        ];
        assert!(nested.matches(&path));
        assert!(nested.matches(&[E("p", vec![])]));
        for bad in ["a:hover", "a + b", "[x~=y]", "", "a,"] {
            assert!(parse_selector(bad).is_err(), "{bad}");
        }
    }
}
