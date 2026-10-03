//! Composing a style value with style properties as Svelte's `to_style`
//! does (the text is then set through \`cssText\`): the value's declarations
//! whose property is not given separately, then the given properties.

fn css_name(name: &str) -> String {
    if name.starts_with("--") {
        name.to_owned()
    } else {
        name.to_lowercase()
    }
}

/// Remove `/* … */` comments that do not span lines (JavaScript's
/// `/\/\*.*?\*\//g`).
fn strip_comments(value: &str) -> String {
    let mut out = String::new();
    let mut rest = value;
    while let Some(start) = rest.find("/*") {
        let after = &rest[start + 2..];
        let line_end = after
            .find(['\n', '\r', '\u{2028}', '\u{2029}'])
            .unwrap_or(after.len());
        match after[..line_end].find("*/") {
            Some(end) => {
                out.push_str(&rest[..start]);
                rest = &after[end + 2..];
            }
            None => {
                out.push_str(&rest[..start + 2]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// JavaScript's `String.prototype.trim`.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// `to_style(value, styles)`: `None` when empty.
pub fn compose(value: Option<&str>, styles: &[(&str, Option<&str>)]) -> Option<String> {
    let mut out = String::new();
    if let Some(value) = value.filter(|v| !v.is_empty()) {
        let value = strip_comments(value);
        let value = js_trim(&value);
        let reserved: Vec<String> = styles.iter().map(|(n, _)| css_name(n)).collect();
        let chars: Vec<char> = value.chars().collect();
        let (mut in_str, mut in_apo, mut in_comment) = (None::<char>, 0i32, false);
        let (mut start, mut name_at) = (0usize, None::<usize>);
        let text = |a: usize, b: usize| chars[a..b].iter().collect::<String>();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            if in_comment {
                if c == '/' && i > 0 && chars[i - 1] == '*' {
                    in_comment = false;
                }
            } else if let Some(q) = in_str {
                if q == c {
                    in_str = None;
                }
            } else if c == '/' && chars.get(i + 1) == Some(&'*') {
                in_comment = true;
            } else if c == '"' || c == '\'' {
                in_str = Some(c);
            } else if c == '(' {
                in_apo += 1;
            } else if c == ')' {
                in_apo -= 1;
            }
            if !in_comment && in_str.is_none() && in_apo == 0 {
                if c == ':' && name_at.is_none() {
                    name_at = Some(i);
                } else if c == ';' || i == chars.len() - 1 {
                    if let Some(n) = name_at {
                        let name = css_name(js_trim(&text(start, n)));
                        if !reserved.contains(&name) {
                            if c != ';' {
                                i += 1;
                            }
                            out.push(' ');
                            out.push_str(js_trim(&text(start, i.min(chars.len()))));
                            out.push(';');
                        }
                    }
                    start = i + 1;
                    name_at = None;
                }
            }
            i += 1;
        }
    }
    for (name, value) in styles {
        if let Some(v) = value.filter(|v| !v.is_empty()) {
            out.push_str(&format!(" {name}: {v};"));
        }
    }
    let out = js_trim(&out);
    (!out.is_empty()).then(|| out.to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn composes_like_svelte() {
        assert_eq!(
            compose(Some("width: 10px"), &[("color", Some("red"))]).unwrap(),
            "width: 10px; color: red;"
        );
        assert_eq!(
            compose(Some("color: blue; width: 1px"), &[("color", Some("red"))]).unwrap(),
            "width: 1px; color: red;"
        );
        assert_eq!(compose(None, &[("color", None)]), None);
        assert_eq!(
            compose(Some("background: url(a;b) /* c */"), &[]).unwrap(),
            "background: url(a;b);"
        );
    }
}
