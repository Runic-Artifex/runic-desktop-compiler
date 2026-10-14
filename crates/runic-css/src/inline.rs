//! The CSS contract for inline styles (`style` attributes, Svelte `style:`
//! directives, React and Vue style objects, CSSOM writes): the declaration
//! checks `compiler/collect.mjs` gives stylesheet declarations, for the one
//! element the inline style applies to (docs/CONTRACT.md, inline styles).
//!
//! A declaration a stylesheet would be rejected for ([`Kind::Reject`]) is
//! rejected at build time where the value is literal; one a stylesheet would
//! give a style guard for ([`Kind::Report`]: the guard reports once its
//! rule matches an element) is reported when the inline style is set. Values
//! known only at run time are reported then, whatever their kind. The rules
//! mirror collect.mjs (`checkRules`, `checkWithStylo`, `chromiumDrops`,
//! `overriddenInRule` and the `EQUIVALENT_*` tables); a change to one side
//! belongs on both.

use crate::check::declaration_parses;

/// The properties Chromium 153 parses in a declaration block (its own and
/// its aliases): Blink's css_properties.json5 at 153.0.8010.12, without
/// `-internal-` names, where `CSS.supports(name, "inherit")` holds in the
/// harness's Chromium (722 of 794; `node conformance/chromium-properties.mjs`
/// measures them again). Chromium drops a declaration of any other property,
/// as Stylo may: such a drop is equivalent.
const CHROMIUM_PROPERTIES: &str = include_str!("chromium-properties.txt");

/// Whether Chromium 153 parses declarations of `name` (lower case);
/// custom properties always.
pub fn chromium_parses_property(name: &str) -> bool {
    static SET: std::sync::OnceLock<std::collections::HashSet<&'static str>> =
        std::sync::OnceLock::new();
    name.starts_with("--")
        || SET
            .get_or_init(|| CHROMIUM_PROPERTIES.lines().collect())
            .contains(name)
}

/// What Chromium 153 accepts as a value of one identifier where Stylo
/// drops it (`node conformance/chromium-properties.mjs` measures it): per
/// property, flags (`u`: Stylo parses no value of it; `c`: Chromium accepts
/// any identifier, a custom ident) and keywords (with `u`, every Blink
/// keyword Chromium accepts alone; otherwise those it accepts and Stylo
/// drops). A property it leaves out accepts no custom ident, and no keyword
/// Stylo drops.
const CHROMIUM_KEYWORDS: &str = include_str!("chromium-keywords.txt");

/// Where Stylo and Chromium 153 agree on values beyond single identifiers
/// (`node conformance/chromium-grammar.mjs` measures it): per property,
/// `<name>\t<samples>\t<functions>\t<units>\t<idents>`, the vocabulary of
/// at least 20 corpus values and their JavaScript-number mutations, on all of
/// which both engines agree. `#` lines are comments.
const CHROMIUM_GRAMMAR: &str = include_str!("chromium-grammar.txt");

/// The vocabulary of a value over cssparser's tokens (the CSS Syntax
/// tokenizer, as Blink's): lower-cased function names, dimension units and
/// identifiers other than artifacts (compiler/css-vocabulary.mjs is the twin).
#[derive(Default)]
struct Vocabulary {
    functions: Vec<String>,
    units: Vec<String>,
    idents: Vec<String>,
}

/// What JavaScript string building makes of a number in a CSS numeric
/// position: `--25` (a written minus before a negative number), `NaNpx`,
/// `Infinity` with a unit, `undefinedpx`, `undefined`, `null`. `nan`,
/// `infinity` and `-infinity` alone are calc() keywords, not artifacts.
fn artifact(lower: &str) -> bool {
    let rest = lower.strip_prefix('-').unwrap_or(lower);
    (rest.starts_with('-') && rest[1..].starts_with(|c: char| c.is_ascii_digit()))
        || ["nan", "infinity", "undefined", "null"]
            .iter()
            .any(|w| rest.len() > w.len() && rest.starts_with(w))
        || lower == "undefined"
        || lower == "null"
}

fn vocabulary(value: &str) -> Vocabulary {
    use cssparser::{Parser, Token};
    fn walk(p: &mut Parser<'_>, v: &mut Vocabulary) {
        while let Ok(token) = p.next_including_whitespace_and_comments() {
            let nested = match token {
                Token::Function(name) => {
                    v.functions.push(name.to_ascii_lowercase());
                    true
                }
                Token::Dimension { unit, .. } => {
                    v.units.push(unit.to_ascii_lowercase());
                    false
                }
                Token::Ident(name) => {
                    let lower = name.to_ascii_lowercase();
                    if !artifact(&lower) {
                        v.idents.push(lower);
                    }
                    false
                }
                Token::UnquotedUrl(_) => {
                    v.functions.push("url".into());
                    false
                }
                Token::ParenthesisBlock | Token::SquareBracketBlock | Token::CurlyBracketBlock => {
                    true
                }
                _ => false,
            };
            if nested {
                let _ = p.parse_nested_block(|p| -> Result<(), cssparser::ParseError<()>> {
                    walk(p, v);
                    Ok(())
                });
            }
        }
    }
    let mut v = Vocabulary::default();
    walk(&mut Parser::new(value), &mut v);
    v
}

/// Whether `name: value`, a value Stylo drops that is not one identifier,
/// is one Chromium drops too: `name` is a property of the measured grammar
/// table and every function, unit and identifier of the value occurs in its
/// agreeing samples (artifact identifiers being a class the samples cover).
fn chromium_grammar_drops(name: &str, value: &str) -> bool {
    type Entry = (Vec<&'static str>, Vec<&'static str>, Vec<&'static str>);
    static TABLE: std::sync::OnceLock<std::collections::HashMap<&'static str, Entry>> =
        std::sync::OnceLock::new();
    let table = TABLE.get_or_init(|| {
        CHROMIUM_GRAMMAR
            .lines()
            .filter(|line| !line.starts_with('#'))
            .filter_map(|line| {
                let mut parts = line.split('\t');
                let name = parts.next()?;
                parts.next()?;
                let mut list = || -> Vec<&'static str> {
                    parts
                        .next()
                        .unwrap_or("")
                        .split(' ')
                        .filter(|x| !x.is_empty())
                        .collect()
                };
                let functions = list();
                let units = list();
                let idents = list();
                Some((name, (functions, units, idents)))
            })
            .collect()
    });
    let Some((functions, units, idents)) = table.get(name) else {
        return false;
    };
    let v = vocabulary(value);
    v.functions.iter().all(|f| functions.contains(&f.as_str()))
        && v.units.iter().all(|u| units.contains(&u.as_str()))
        && v.idents.iter().all(|i| idents.contains(&i.as_str()))
}

/// Whether Chromium 153 drops the declaration `name: value` too, where
/// Stylo drops it (both measured): a property Chromium does not parse; a
/// value of one identifier (CSS-wide keywords included) that Chromium
/// accepts neither as a keyword of the property nor as a custom ident
/// (chromium-keywords.txt); a longer value of a property on whose corpus the
/// engines agree, within the vocabulary of that corpus (chromium-grammar.txt).
/// Any other value Stylo drops may be one Chromium keeps.
pub fn chromium_drops_value(name: &str, value: &str) -> bool {
    type Table = std::collections::HashMap<&'static str, (&'static str, Vec<&'static str>)>;
    static TABLE: std::sync::OnceLock<Table> = std::sync::OnceLock::new();
    if !chromium_parses_property(name) {
        return true;
    }
    let value = value.trim();
    let mut chars = value.chars();
    let ident_start = |c: char| c.is_ascii_alphabetic() || c == '_' || !c.is_ascii();
    let single_ident = match chars.next() {
        Some('-') => chars.next().is_some_and(|c| ident_start(c) || c == '-'),
        Some(c) => ident_start(c),
        None => false,
    } && value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || !c.is_ascii());
    if name.starts_with("--") {
        return false;
    }
    if !single_ident {
        let lower = value.to_ascii_lowercase();
        return !["var(", "env(", "attr("].iter().any(|f| lower.contains(f))
            && chromium_grammar_drops(name, value);
    }
    let table = TABLE.get_or_init(|| {
        CHROMIUM_KEYWORDS
            .lines()
            .filter_map(|line| {
                let mut parts = line.split('\t');
                Some((
                    parts.next()?,
                    (
                        parts.next().unwrap_or(""),
                        parts
                            .next()
                            .unwrap_or("")
                            .split(' ')
                            .filter(|k| !k.is_empty())
                            .collect(),
                    ),
                ))
            })
            .collect()
    });
    let lower = value.to_ascii_lowercase();
    match table.get(name) {
        None => true,
        Some((flags, keywords)) => !flags.contains('c') && !keywords.contains(&lower.as_str()),
    }
}

/// What a problem is for a literal value at build time.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    /// Rejected at build time (a stylesheet rejects it where it may apply).
    Reject,
    /// Reported when set (a stylesheet reports it where its rule matches).
    Report,
}

/// A declaration of an inline style outside the contract.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Problem {
    pub kind: Kind,
    /// The declaration as written, `name: value`.
    pub declaration: String,
    pub reason: String,
}

impl Problem {
    /// The report or diagnostic text: `the inline style declaration
    /// <declaration> (<reason>)`.
    pub fn message(&self) -> String {
        format!(
            "the inline style declaration {} ({})",
            self.declaration, self.reason
        )
    }
}

/// The element an inline style is on, as far as the checks need it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Element<'a> {
    /// Lower-case tag name.
    pub tag: &'a str,
    /// The `type` attribute of an `input`, if known.
    pub input_type: Option<&'a str>,
}

/// The declarations of a declaration list, `(name, value, important)`:
/// split at `;` outside parentheses, brackets, braces and strings.
/// A part without a colon gives an empty value.
pub fn declarations(css: &str) -> Vec<(String, String, bool)> {
    let mut parts = vec![];
    let (mut depth, mut quote, mut start) = (0i32, None::<char>, 0usize);
    let mut chars = css.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match (quote, c) {
            (Some(_), '\\') => {
                chars.next();
            }
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '"' | '\'') => quote = Some(c),
            (None, '(' | '[' | '{') => depth += 1,
            (None, ')' | ']' | '}') => depth -= 1,
            (None, ';') if depth == 0 => {
                parts.push(&css[start..i]);
                start = i + 1;
            }
            _ => {}
        }
    }
    parts.push(&css[start..]);
    parts
        .into_iter()
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(|decl| {
            let (name, value) = decl.split_once(':').unwrap_or((decl, ""));
            let value = value.trim();
            let (value, important) = match value.strip_suffix("!important") {
                Some(v) => (v.trim_end(), true),
                None => (value, false),
            };
            (
                name.trim().to_ascii_lowercase(),
                value.to_owned(),
                important,
            )
        })
        .collect()
}

// collect.mjs `EQUIVALENT_DROPPED_PROPERTY`: verified equivalent in Chromium 153.
const EQUIVALENT_DROPPED_PROPERTY: &[&str] = &[
    "-webkit-text-size-adjust",
    "-webkit-tap-highlight-color",
    "-ms-overflow-style",
    "-webkit-overflow-scrolling",
    "-webkit-text-decoration",
    "-webkit-backdrop-filter",
];
// collect.mjs `EQUIVALENT_DROPPED_VALUE`.
const EQUIVALENT_DROPPED_VALUE: &[(&str, &str)] = &[
    ("-webkit-font-smoothing", "antialiased"),
    ("-moz-osx-font-smoothing", "grayscale"),
];
// collect.mjs `WEBKIT_DISTINCT`: `-webkit-` properties Chromium 153 keeps
// apart from their standard property.
const WEBKIT_DISTINCT: &[&str] = &[
    "box-decoration-break",
    "line-break",
    "ruby-position",
    "text-orientation",
    "writing-mode",
];
// collect.mjs `FILTER_FUNCTIONS`.
const FILTER_FUNCTIONS: &[&str] = &[
    "blur",
    "brightness",
    "contrast",
    "grayscale",
    "hue-rotate",
    "invert",
    "opacity",
    "saturate",
    "sepia",
    "drop-shadow",
];
// collect.mjs `SVG_PAINT_CSS`.
const SVG_PAINT: &[&str] = &[
    "fill",
    "fill-opacity",
    "fill-rule",
    "stroke",
    "stroke-width",
    "stroke-opacity",
    "stroke-linecap",
    "stroke-linejoin",
    "stroke-miterlimit",
    "stroke-dasharray",
    "stroke-dashoffset",
];
// collect.mjs `SVG_CSS` (the names without a `fill-`, `stroke-` or `marker`
// prefix).
const SVG_ONLY: &[&str] = &[
    "clip-rule",
    "paint-order",
    "vector-effect",
    "shape-rendering",
    "stop-color",
    "stop-opacity",
    "flood-color",
    "flood-opacity",
    "lighting-color",
    "color-interpolation",
    "color-interpolation-filters",
    "color-rendering",
    "text-anchor",
    "dominant-baseline",
    "alignment-baseline",
    "baseline-shift",
    "mask-type",
    "d",
    "cx",
    "cy",
    "r",
    "rx",
    "ry",
    "x",
    "y",
];

/// The standard property a dropped vendor property names (collect.mjs
/// `overriddenInRule`).
fn standard_name(prop: &str) -> String {
    for (old, side) in [
        ("start", "inline-start"),
        ("end", "inline-end"),
        ("before", "block-start"),
        ("after", "block-end"),
    ] {
        for bx in ["margin", "padding", "border"] {
            let parts: &[&str] = if bx == "border" {
                &["", "-color", "-style", "-width"]
            } else {
                &[""]
            };
            for part in parts {
                if prop == format!("-webkit-{bx}-{old}{part}") {
                    return format!("{bx}-{side}{part}");
                }
            }
        }
    }
    if let Some(rest) = prop.strip_prefix("-webkit-") {
        if !WEBKIT_DISTINCT.contains(&rest) {
            return rest.to_owned();
        }
        return prop.to_owned();
    }
    for prefix in ["-moz-", "-o-", "-ms-"] {
        if let Some(rest) = prop.strip_prefix(prefix) {
            return rest.to_owned();
        }
    }
    prop.to_owned()
}

/// Identifiers of a value (outside strings), lower-cased.
fn idents(value: &str) -> Vec<String> {
    let mut out = vec![];
    let mut word = String::new();
    let mut quote = None;
    for c in value.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
            }
            None if c == '"' || c == '\'' => quote = Some(c),
            None if c.is_alphanumeric() || c == '-' || c == '_' => word.push(c),
            None => {
                if !word.is_empty() {
                    out.push(std::mem::take(&mut word).to_ascii_lowercase());
                }
            }
        }
    }
    if !word.is_empty() {
        out.push(word.to_ascii_lowercase());
    }
    out
}

/// Function names a value calls (outside strings), lower-cased.
fn functions(value: &str) -> Vec<String> {
    let mut out = vec![];
    let mut word = String::new();
    let mut quote = None;
    for c in value.chars() {
        match quote {
            Some(q) => {
                if c == q {
                    quote = None;
                }
                word.clear();
            }
            None if c == '"' || c == '\'' => {
                quote = Some(c);
                word.clear();
            }
            None if c == '(' => {
                if !word.is_empty() {
                    out.push(std::mem::take(&mut word).to_ascii_lowercase());
                }
            }
            None if c.is_alphanumeric() || c == '-' || c == '_' => word.push(c),
            None => word.clear(),
        }
    }
    out
}

fn reject(declaration: &str, reason: impl Into<String>) -> Problem {
    Problem {
        kind: Kind::Reject,
        declaration: declaration.to_owned(),
        reason: reason.into(),
    }
}

fn report(declaration: &str, reason: impl Into<String>) -> Problem {
    Problem {
        kind: Kind::Report,
        declaration: declaration.to_owned(),
        reason: reason.into(),
    }
}

/// The declarations of the inline style `css` on `element` outside the
/// contract, in order.
pub fn problems(css: &str, element: Element<'_>) -> Vec<Problem> {
    let decls = declarations(css);
    let mut out = vec![];
    for (i, (name, value, important)) in decls.iter().enumerate() {
        let written = format!("{name}: {value}");
        let lower = value.to_ascii_lowercase();
        let words = idents(value);
        let calls = functions(value);
        // collect.mjs `unsupportedTimeBased`.
        if [
            "animation-timeline",
            "animation-range",
            "animation-range-start",
            "animation-range-end",
            "scroll-timeline",
            "scroll-timeline-name",
            "scroll-timeline-axis",
            "view-timeline",
            "view-timeline-name",
            "view-timeline-axis",
            "view-timeline-inset",
            "timeline-scope",
        ]
        .contains(&name.as_str())
        {
            out.push(reject(
                &written,
                "scroll-driven animations (animation and scroll timelines) are not supported",
            ));
            continue;
        }
        if (name == "transition" || name == "transition-behavior")
            && words.iter().any(|w| w == "allow-discrete")
        {
            out.push(reject(
                &written,
                "transition-behavior: allow-discrete is not supported",
            ));
            continue;
        }
        // collect.mjs `unsupportedFilter`.
        if (name == "filter" || name == "backdrop-filter")
            && let Some(f) = calls
                .iter()
                .find(|f| *f != "var" && !FILTER_FUNCTIONS.contains(&f.as_str()))
        {
            out.push(reject(
                &written,
                format!("{f}() is not a CSS filter function the renderers draw"),
            ));
            continue;
        }
        // On an element (inline styles style no pseudo-element), Chromium
        // gives `content` effect only with an image, which Blitz does not
        // generate.
        if name == "content"
            && calls
                .iter()
                .any(|f| matches!(f.as_str(), "url" | "image-set" | "linear-gradient"))
        {
            out.push(reject(&written, "Blitz generates no images from content"));
            continue;
        }
        if name == "text-transform"
            && words
                .iter()
                .any(|w| w == "full-width" || w == "full-size-kana")
        {
            out.push(reject(&written, "Blitz transforms the case of text only"));
            continue;
        }
        if SVG_PAINT.contains(&name.as_str()) && calls.iter().any(|f| f == "url") {
            out.push(reject(
                &written,
                "paint servers (url()) are not supported in inline SVG",
            ));
            continue;
        }
        if !SVG_PAINT.contains(&name.as_str())
            && (name.starts_with("fill")
                || name.starts_with("stroke")
                || name.starts_with("marker")
                || SVG_ONLY.contains(&name.as_str()))
        {
            out.push(reject(
                &written,
                "Blitz draws inline SVG with the painting properties fill, stroke and their longhands only",
            ));
            continue;
        }
        // collect.mjs `checkWithStylo`: what Stylo drops, but for drops
        // verified equivalent in Chromium 153.
        if !declaration_parses(name, value) {
            let equivalent = EQUIVALENT_DROPPED_PROPERTY.contains(&name.as_str())
                || EQUIVALENT_DROPPED_VALUE
                    .iter()
                    .any(|(p, v)| p == name && *v == lower.trim())
                || name == "resize"
                || chromium_drops_value(name, value)
                || {
                    let standard = standard_name(name);
                    decls[i + 1..].iter().any(|(n, v, imp)| {
                        (n == name || *n == standard)
                            && declaration_parses(n, v)
                            && (*imp || !*important)
                    })
                };
            if !equivalent {
                out.push(report(
                    &written,
                    "Blitz's style engine (Stylo) does not support it",
                ));
            }
            continue;
        }
        if name == "-moz-box-orient" {
            out.push(report(
                &written,
                "Chromium ignores it and Blitz's style engine (Stylo) applies it",
            ));
            continue;
        }
        let none = |v: &str| {
            matches!(
                v.trim(),
                "none" | "initial" | "inherit" | "unset" | "revert" | "revert-layer"
            )
        };
        // collect.mjs `MULTICOL`: Blitz lays out no multi-column layout.
        if matches!(name.as_str(), "columns" | "column-count" | "column-width")
            && !matches!(
                lower.split_whitespace().collect::<Vec<_>>()[..],
                ["auto"]
                    | ["auto", "auto"]
                    | ["initial"]
                    | ["unset"]
                    | ["revert"]
                    | ["revert-layer"]
            )
        {
            out.push(report(
                &written,
                "Blitz does not lay out multi-column layout",
            ));
            continue;
        }
        if name == "text-shadow" && !none(&lower) {
            out.push(report(&written, "Blitz does not paint text shadows"));
            continue;
        }
        if (name == "text-wrap" || name == "text-wrap-style")
            && element.tag == "textarea"
            && words.iter().any(|w| w == "balance" || w == "pretty")
        {
            out.push(report(
                &written,
                "Blitz breaks the text of a text area greedily",
            ));
            continue;
        }
        if name == "field-sizing"
            && words.iter().any(|w| w == "content" || w == "inherit")
            && (element.tag == "select"
                || (element.tag == "input"
                    && element.input_type.is_some_and(|t| {
                        ["search", "number", "password", "file"]
                            .contains(&t.to_ascii_lowercase().as_str())
                    })))
        {
            out.push(report(
                &written,
                "Blitz does not size that control by its content as Chromium does",
            ));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(css: &str, element: Element<'_>) -> Vec<(Kind, String)> {
        problems(css, element)
            .into_iter()
            .map(|p| (p.kind, p.declaration))
            .collect()
    }

    #[test]
    fn inline_declarations_get_the_stylesheet_checks() {
        let div = Element {
            tag: "div",
            input_type: None,
        };
        // A value of one identifier both engines drop (bits-ui's floating
        // layer spreads `z-index: undefined`); Chromium keeps keywords Stylo
        // drops (measured).
        assert_eq!(
            kinds(
                "z-index: undefined; width: undefinedpx; -webkit-text-stroke: undefined; width: -webkit-max-content; word-break: break-word",
                div
            ),
            [
                (Kind::Report, "width: -webkit-max-content".into()),
                (Kind::Report, "word-break: break-word".into()),
            ]
        );
        // Longer values both engines drop, within a property's measured
        // vocabulary (chromium-grammar.txt): a template building a number
        // (`translateX(-{x}%)` with x = -25: bits-ui's progress indicator
        // past its maximum), NaN and undefined; values outside the
        // vocabulary (a function Stylo lacks) stay reported.
        assert_eq!(
            kinds(
                "transform: translateX(--25%); transform: translateX(NaNpx); margin: 0 --4px; transform: translateX(undefined%); width: calc-size(auto, size)",
                div
            ),
            [(Kind::Report, "width: calc-size(auto, size)".into())]
        );
        // Multi-column layout.
        assert_eq!(
            kinds(
                "columns: 2; column-width: 12em; column-count: auto; columns: auto auto",
                div
            ),
            [
                (Kind::Report, "columns: 2".into()),
                (Kind::Report, "column-width: 12em".into()),
            ]
        );
        assert_eq!(
            kinds(
                "position: sticky; top: 0; color: red; -webkit-text-stroke: 1px red; text-shadow: 1px 1px red",
                div
            ),
            [
                (Kind::Report, "-webkit-text-stroke: 1px red".into()),
                (Kind::Report, "text-shadow: 1px 1px red".into()),
            ]
        );
        assert_eq!(
            kinds(
                "animation: spin 1s forwards; filter: url(#f); animation-timeline: scroll(); text-transform: full-width; stroke: url(#g)",
                div
            )
            .into_iter()
            .map(|(k, _)| k)
            .collect::<Vec<_>>(),
            [Kind::Reject; 4]
        );
        // Filled animations stay in effect as in Chromium (case `animation-fill`).
        assert_eq!(
            kinds(
                "animation: spin 1s forwards; animation-fill-mode: both",
                div
            ),
            []
        );
        // Drops verified equivalent, or overridden later in the block.
        assert_eq!(
            kinds(
                "-moz-column-gap: 1px; column-gap: 2px; position: -webkit-sticky; position: sticky; -webkit-tap-highlight-color: red; -webkit-font-smoothing: antialiased; text-shadow: none",
                div
            ),
            []
        );
        assert_eq!(
            kinds(
                "text-wrap: balance",
                Element {
                    tag: "textarea",
                    input_type: None
                }
            )
            .len(),
            1
        );
        assert_eq!(
            kinds(
                "field-sizing: content",
                Element {
                    tag: "input",
                    input_type: Some("NUMBER")
                }
            )
            .len(),
            1
        );
        assert_eq!(
            kinds(
                "field-sizing: content",
                Element {
                    tag: "input",
                    input_type: Some("text")
                }
            ),
            []
        );
    }
}
