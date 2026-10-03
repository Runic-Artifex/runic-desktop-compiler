//! `matchMedia(query).matches` for the media features applications test
//! from script: the user preferences and the viewport size. Queries with
//! other features are unsupported (`None`), and the compiler rejects them.

/// What media queries see.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MediaEnv {
    /// Viewport size in CSS pixels.
    pub width: f64,
    pub height: f64,
    pub dark: bool,
    pub contrast_more: bool,
    pub reduced_motion: bool,
}

impl Default for MediaEnv {
    /// Chromium's defaults under Playwright: light, no contrast or motion
    /// preference, the probe's default viewport.
    fn default() -> Self {
        MediaEnv {
            width: 800.0,
            height: 600.0,
            dark: false,
            contrast_more: false,
            reduced_motion: false,
        }
    }
}

struct Tokens<'a> {
    rest: &'a str,
}

impl<'a> Tokens<'a> {
    fn skip_ws(&mut self) {
        self.rest = self.rest.trim_start();
    }
    fn eat(&mut self, s: &str) -> bool {
        self.skip_ws();
        if self.rest.len() >= s.len() && self.rest[..s.len()].eq_ignore_ascii_case(s) {
            self.rest = &self.rest[s.len()..];
            true
        } else {
            false
        }
    }
    fn ident(&mut self) -> Option<&'a str> {
        self.skip_ws();
        let end = self
            .rest
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '-' || c == '_'))
            .unwrap_or(self.rest.len());
        if end == 0 {
            return None;
        }
        let (id, rest) = self.rest.split_at(end);
        self.rest = rest;
        Some(id)
    }
    fn number(&mut self) -> Option<f64> {
        self.skip_ws();
        let end = self
            .rest
            .find(|c: char| !(c.is_ascii_digit() || c == '.' || c == '-' || c == '+'))
            .unwrap_or(self.rest.len());
        let n = self.rest[..end].parse().ok()?;
        self.rest = &self.rest[end..];
        Some(n)
    }
}

/// A length in CSS pixels (`px`, `em`/`rem` at the 16 px default).
fn length(t: &mut Tokens) -> Option<f64> {
    let n = t.number()?;
    let unit = t.ident().unwrap_or("").to_ascii_lowercase();
    match unit.as_str() {
        "px" => Some(n),
        "em" | "rem" => Some(n * 16.0),
        "" if n == 0.0 => Some(0.0),
        _ => None,
    }
}

/// One `( feature )` test.
fn feature(t: &mut Tokens, env: &MediaEnv) -> Option<bool> {
    if !t.eat("(") {
        return None;
    }
    let name = t.ident()?.to_ascii_lowercase();
    let result = if t.eat(":") {
        match name.as_str() {
            "prefers-color-scheme" => match t.ident()?.to_ascii_lowercase().as_str() {
                "dark" => env.dark,
                "light" => !env.dark,
                _ => return None,
            },
            "prefers-contrast" => match t.ident()?.to_ascii_lowercase().as_str() {
                "more" => env.contrast_more,
                "no-preference" => !env.contrast_more,
                "less" | "custom" => false,
                _ => return None,
            },
            "prefers-reduced-motion" => match t.ident()?.to_ascii_lowercase().as_str() {
                "reduce" => env.reduced_motion,
                "no-preference" => !env.reduced_motion,
                _ => return None,
            },
            "orientation" => match t.ident()?.to_ascii_lowercase().as_str() {
                "portrait" => env.height >= env.width,
                "landscape" => env.width > env.height,
                _ => return None,
            },
            "min-width" => env.width >= length(t)?,
            "max-width" => env.width <= length(t)?,
            "width" => env.width == length(t)?,
            "min-height" => env.height >= length(t)?,
            "max-height" => env.height <= length(t)?,
            "height" => env.height == length(t)?,
            _ => return None,
        }
    } else {
        // Range syntax: (width >= 600px), (height < 40em).
        let size = match name.as_str() {
            "width" => env.width,
            "height" => env.height,
            _ => return None,
        };
        let op = [">=", "<=", ">", "<", "="]
            .into_iter()
            .find(|op| t.eat(op))?;
        let v = length(t)?;
        match op {
            ">=" => size >= v,
            "<=" => size <= v,
            ">" => size > v,
            "<" => size < v,
            _ => size == v,
        }
    };
    t.eat(")").then_some(result)
}

/// One query of a comma-separated list: `[not | only] [type] [and (…)]…` or `(…) [and (…)]…`.
fn query(t: &mut Tokens, env: &MediaEnv) -> Option<bool> {
    let not = t.eat("not ");
    if !not {
        t.eat("only ");
    }
    let mut result = true;
    t.skip_ws();
    if !t.rest.starts_with('(') {
        match t.ident()?.to_ascii_lowercase().as_str() {
            "all" | "screen" => {}
            "print" => result = false,
            _ => return None,
        }
        if !t.eat("and") {
            return Some(result != not);
        }
    }
    loop {
        result &= feature(t, env)?;
        if !t.eat("and") {
            break;
        }
    }
    Some(result != not)
}

/// Whether `query` matches; `None` when it uses unsupported syntax or features.
pub fn matches(query: &str, env: &MediaEnv) -> Option<bool> {
    let mut any = false;
    for part in query.split(',') {
        let mut t = Tokens { rest: part };
        let r = query_one(&mut t, env)?;
        any |= r;
    }
    Some(any)
}

fn query_one(t: &mut Tokens, env: &MediaEnv) -> Option<bool> {
    let r = query(t, env)?;
    t.skip_ws();
    t.rest.is_empty().then_some(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluates() {
        let env = MediaEnv::default();
        assert_eq!(matches("(prefers-color-scheme: dark)", &env), Some(false));
        assert_eq!(matches("(prefers-color-scheme: light)", &env), Some(true));
        assert_eq!(matches("(min-width: 768px)", &env), Some(true));
        assert_eq!(matches("screen and (max-width: 40em)", &env), Some(false));
        assert_eq!(
            matches("(width >= 800px) and (orientation: landscape)", &env),
            Some(true)
        );
        assert_eq!(
            matches("not (prefers-reduced-motion: reduce)", &env),
            Some(true)
        );
        assert_eq!(matches("(hover: hover)", &env), None);
        assert_eq!(
            matches("(max-width: 10px), (prefers-contrast: no-preference)", &env),
            Some(true)
        );
    }
}
