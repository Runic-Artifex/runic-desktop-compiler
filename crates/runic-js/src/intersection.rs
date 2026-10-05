//! IntersectionObserver options (M6 overlays): `rootMargin` and
//! `threshold`, checked as Chromium's constructor checks them.

/// A side of `rootMargin`: pixels, or a percentage of the root's width
/// (left and right) or height (top and bottom).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Margin {
    Px(f64),
    Percent(f64),
}

impl Margin {
    /// The margin in pixels for a root side of `size`.
    pub fn resolve(self, size: f64) -> f64 {
        match self {
            Margin::Px(v) => v,
            Margin::Percent(p) => size * p / 100.0,
        }
    }
}

/// `rootMargin`: one to four values, each pixels (`10px`) or a percentage
/// (`5%`), expanded like the `margin` shorthand to top, right, bottom,
/// left. Another unit, a bare number or more values is a SyntaxError (the
/// message is Chromium's).
pub fn parse_root_margin(text: &str) -> Result<[Margin; 4], String> {
    let mut values = Vec::new();
    for token in text.split_ascii_whitespace() {
        let margin = if let Some(n) = token.strip_suffix('%') {
            n.parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .map(Margin::Percent)
        } else if let Some(n) = token
            .strip_suffix("px")
            .or_else(|| token.strip_suffix("PX"))
            .or_else(|| token.strip_suffix("Px"))
            .or_else(|| token.strip_suffix("pX"))
        {
            n.parse::<f64>()
                .ok()
                .filter(|v| v.is_finite())
                .map(Margin::Px)
        } else {
            None
        };
        // (Rust's float syntax is wider than CSS's: `inf`, `1e`, `+.`.)
        let numeric = token
            .trim_end_matches(|c: char| c.is_ascii_alphabetic() || c == '%')
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'));
        match margin {
            Some(m) if numeric => values.push(m),
            _ => return Err("rootMargin must be specified in pixels or percent.".into()),
        }
        if values.len() > 4 {
            return Err("Extra text found at the end of rootMargin.".into());
        }
    }
    let zero = Margin::Px(0.0);
    Ok(match values.as_slice() {
        [] => [zero; 4],
        [a] => [*a; 4],
        [a, b] => [*a, *b, *a, *b],
        [a, b, c] => [*a, *b, *c, *b],
        [a, b, c, d] => [*a, *b, *c, *d],
        _ => unreachable!("at most four values"),
    })
}

/// `threshold`: values between 0 and 1 (a RangeError otherwise), sorted;
/// none is `[0]`.
pub fn thresholds(values: &[f64]) -> Result<Vec<f64>, String> {
    if values.iter().any(|v| !(0.0..=1.0).contains(v)) {
        return Err("Threshold values must be numbers between 0 and 1".into());
    }
    let mut out = values.to_vec();
    if out.is_empty() {
        out.push(0.0);
    }
    out.sort_by(|a, b| a.total_cmp(b));
    Ok(out)
}

/// The index of the first threshold greater than `ratio` (the length when
/// `ratio` reaches the last).
pub fn threshold_index(thresholds: &[f64], ratio: f64) -> i64 {
    thresholds
        .iter()
        .position(|t| *t > ratio)
        .unwrap_or(thresholds.len()) as i64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_margins() {
        assert_eq!(
            parse_root_margin("-10px 5% 0px -3.5px"),
            Ok([
                Margin::Px(-10.0),
                Margin::Percent(5.0),
                Margin::Px(0.0),
                Margin::Px(-3.5)
            ])
        );
        assert_eq!(parse_root_margin("4px"), Ok([Margin::Px(4.0); 4]));
        assert_eq!(
            parse_root_margin("1px 2px"),
            Ok([
                Margin::Px(1.0),
                Margin::Px(2.0),
                Margin::Px(1.0),
                Margin::Px(2.0)
            ])
        );
        assert!(parse_root_margin("0").is_err());
        assert!(parse_root_margin("1em").is_err());
        assert!(parse_root_margin("1px 1px 1px 1px 1px").is_err());
    }

    #[test]
    fn threshold_lists() {
        assert_eq!(thresholds(&[]), Ok(vec![0.0]));
        assert_eq!(thresholds(&[1.0, 0.5]), Ok(vec![0.5, 1.0]));
        assert!(thresholds(&[1.5]).is_err());
        assert!(thresholds(&[f64::NAN]).is_err());
        assert_eq!(threshold_index(&[1.0], 1.0), 1);
        assert_eq!(threshold_index(&[1.0], 0.99), 0);
        assert_eq!(threshold_index(&[1e-7], 0.0), 0);
    }
}
