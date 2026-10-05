//! svelte-toolbelt 0.10.6's `cssToStyleObj(css)` (dist/utils/css-to-style-obj.js,
//! M6 overlays): `style-to-object` 1.0.14 over `inline-style-parser` 0.2.7,
//! with property names in camelCase (vendor-prefixed ones in PascalCase,
//! custom properties as written). `mergeProps` uses it where a style string
//! meets another style value. Tested against the packages in Node
//! (`tests/vectors/style.mjs`).

/// JavaScript's `\s` (WhiteSpace and LineTerminator).
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// A line terminator (what `.` does not match).
fn line_terminator(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `\w`.
fn word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_'
}

/// `str.replace(/^\s+|\s+$/g, "")`.
fn trim(s: &str) -> String {
    s.trim_matches(js_space).to_string()
}

/// `str.replace(/\/\*[^*]*\*+([^/*][^*]*\*+)*\//g, "")`: complete comments removed.
fn strip_comments(s: &[char]) -> String {
    let mut out = String::new();
    let mut i = 0;
    while i < s.len() {
        if s[i] == '/' && s.get(i + 1) == Some(&'*') {
            if let Some(end) =
                (i + 2..s.len().saturating_sub(1)).find(|&j| s[j] == '*' && s[j + 1] == '/')
            {
                i = end + 2;
                continue;
            }
        }
        out.push(s[i]);
        i += 1;
    }
    out
}

struct Parser {
    s: Vec<char>,
    at: usize,
}

impl Parser {
    fn rest(&self) -> &[char] {
        &self.s[self.at..]
    }

    /// `^\s*`.
    fn whitespace(&mut self) {
        while self.at < self.s.len() && js_space(self.s[self.at]) {
            self.at += 1;
        }
    }

    /// A comment (`/* … */`), and the whitespace after it; `Ok(false)` where none starts here.
    fn comment(&mut self) -> Result<bool, String> {
        let r = self.rest();
        if r.first() != Some(&'/') || r.get(1) != Some(&'*') {
            return Ok(false);
        }
        let mut i = 2;
        while i < r.len() && !(r[i] == '*' && r.get(i + 1) == Some(&'/')) {
            i += 1;
        }
        i += 2;
        if i > r.len() {
            return Err("End of comment missing".into());
        }
        self.at += i;
        self.whitespace();
        Ok(true)
    }

    fn comments(&mut self) -> Result<(), String> {
        while self.comment()? {}
        Ok(())
    }

    /// `^(\*?[-#/*\\\w]+(\[[0-9a-z_-]+\])?)\s*`: the matched text.
    fn property(&mut self) -> Option<Vec<char>> {
        let r = self.rest();
        let mut i = 0;
        if r.first() == Some(&'*') {
            i = 1;
        }
        let class = |c: char| matches!(c, '-' | '#' | '/' | '*' | '\\') || word(c);
        let start = i;
        while i < r.len() && class(r[i]) {
            i += 1;
        }
        // (A leading `*` may also be the class's first character.)
        if i == start {
            if start == 1 {
                // `\*?` backtracks: the `*` is the class's character.
                i = 1;
            } else {
                return None;
            }
        }
        if r.get(i) == Some(&'[') {
            let mut j = i + 1;
            while j < r.len() && matches!(r[j], '0'..='9' | 'a'..='z' | '_' | '-') {
                j += 1;
            }
            if j > i + 1 && r.get(j) == Some(&']') {
                i = j + 1;
            }
        }
        while i < r.len() && js_space(r[i]) {
            i += 1;
        }
        let m = r[..i].to_vec();
        self.at += i;
        Some(m)
    }

    /// A quoted string from `i` (at the quote) by `'(?:\\'|.)*?'`'s first match: its end.
    fn quoted(r: &[char], i: usize, q: char) -> Option<usize> {
        fn from(r: &[char], j: usize, q: char, depth: usize) -> Option<usize> {
            if depth > 10_000 {
                return None;
            }
            let c = *r.get(j)?;
            if c == q {
                return Some(j + 1);
            }
            if c == '\\' && r.get(j + 1) == Some(&q) {
                if let Some(e) = from(r, j + 2, q, depth + 1) {
                    return Some(e);
                }
            }
            if line_terminator(c) {
                return None;
            }
            from(r, j + 1, q, depth + 1)
        }
        from(r, i + 1, q, 0)
    }

    /// `^((?:'(?:\\'|.)*?'|"(?:\\"|.)*?"|\([^)]*?\)|[^};])+)`: the matched text.
    fn value(&mut self) -> Option<Vec<char>> {
        let r = self.rest();
        let mut i = 0;
        loop {
            let Some(&c) = r.get(i) else { break };
            let next = match c {
                '\'' | '"' => Self::quoted(r, i, c),
                '(' => (i + 1..r.len()).find(|&j| r[j] == ')').map(|j| j + 1),
                _ => None,
            };
            match next {
                Some(e) => i = e,
                None if c != '}' && c != ';' => i += 1,
                None => break,
            }
        }
        if i == 0 {
            return None;
        }
        let m = r[..i].to_vec();
        self.at += i;
        Some(m)
    }

    /// A declaration: `Ok(None)` where no property starts here.
    fn declaration(&mut self) -> Result<Option<(String, String)>, String> {
        let Some(prop) = self.property() else {
            return Ok(None);
        };
        self.comment()?;
        if self.rest().first() != Some(&':') {
            return Err("property missing ':'".into());
        }
        self.at += 1;
        self.whitespace();
        let value = self.value();
        let decl = (
            trim(&strip_comments(&prop)),
            value.map_or(String::new(), |v| trim(&strip_comments(&v))),
        );
        // (The node's position wrapper consumes whitespace.)
        self.whitespace();
        // `^[;\s]*`.
        while self.at < self.s.len() && (self.s[self.at] == ';' || js_space(self.s[self.at])) {
            self.at += 1;
        }
        Ok(Some(decl))
    }
}

/// `inline-style-parser`'s declarations (property, value), in order;
/// an error where it throws.
pub fn parse_declarations(css: &str) -> Result<Vec<(String, String)>, String> {
    let mut p = Parser {
        s: css.chars().collect(),
        at: 0,
    };
    p.whitespace();
    p.comments()?;
    let mut out = vec![];
    while let Some(d) = p.declaration()? {
        out.push(d);
        p.comments()?;
    }
    Ok(out)
}

/// svelte-toolbelt's `splitByCase`.
fn split_by_case(s: &str) -> Vec<String> {
    let upper = |c: char| -> Option<bool> {
        if c.is_ascii_digit() {
            None
        } else {
            Some(c.to_lowercase().collect::<String>() != c.to_string())
        }
    };
    let mut parts = vec![];
    let mut buff = String::new();
    let mut previous_upper: Option<bool> = None;
    let mut previous_splitter: Option<bool> = None;
    for c in s.chars() {
        let splitter = matches!(c, '-' | '_' | '/' | '.');
        if splitter {
            parts.push(std::mem::take(&mut buff));
            previous_upper = None;
            continue;
        }
        let is_upper = upper(c);
        if previous_splitter == Some(false) {
            if previous_upper == Some(false) && is_upper == Some(true) {
                parts.push(std::mem::take(&mut buff));
                buff.push(c);
                previous_upper = is_upper;
                continue;
            }
            if previous_upper == Some(true) && is_upper == Some(false) && buff.chars().count() > 1 {
                let last = buff.pop().expect("buffer");
                parts.push(std::mem::take(&mut buff));
                buff.push(last);
                buff.push(c);
                previous_upper = is_upper;
                continue;
            }
        }
        buff.push(c);
        previous_upper = is_upper;
        previous_splitter = Some(splitter);
    }
    parts.push(buff);
    parts
}

fn upper_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

fn lower_first(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_lowercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// svelte-toolbelt's `pascalCase`.
pub fn pascal_case(s: &str) -> String {
    split_by_case(s).iter().map(|p| upper_first(p)).collect()
}

/// svelte-toolbelt's `camelCase`.
pub fn camel_case(s: &str) -> String {
    lower_first(&pascal_case(s))
}

/// `cssToStyleObj(css)`: the style object's entries in key order (a later
/// declaration of a name replaces the value in place). Property names
/// outside ASCII are an error (svelte-toolbelt's case functions index
/// UTF-16 units there).
pub fn css_to_style_obj(css: &str) -> Result<Vec<(String, String)>, String> {
    if css.is_empty() {
        return Ok(vec![]);
    }
    let mut out: Vec<(String, String)> = vec![];
    for (name, value) in parse_declarations(css)? {
        if !name.is_ascii() {
            return Err(format!("a style property name outside ASCII ({name})"));
        }
        let key = if ["-moz-", "-webkit-", "-ms-", "-o-"]
            .iter()
            .any(|p| name.starts_with(p))
        {
            pascal_case(&name)
        } else if name.starts_with("--") {
            name
        } else {
            camel_case(&name)
        };
        match out.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => out.push((key, value)),
        }
    }
    Ok(out)
}
