//! CSSOM serialization of inline styles (`CSSStyleDeclaration`), as Chromium
//! exposes them in the `style` attribute after script changes them: the
//! `cssText` setter and getter, `setProperty`, `removeProperty`. Stylo
//! (the engine Blitz styles with) parses and serializes, so the runtime and
//! the reference interpreter produce the same text.

use selectors::matching::QuirksMode;
use style::properties::declaration_block::SourcePropertyDeclarationUpdate;
use style::properties::declaration_block::{Importance, parse_style_attribute};
use style::properties::{
    PropertyDeclarationBlock, PropertyId, SourcePropertyDeclaration, parse_one_declaration_into,
};
use style::servo_arc::Arc;
use style::stylesheets::{CssRuleType, Origin, UrlExtraData};
use style_traits::{CssStringWriter, ParsingMode};

pub mod check;
pub mod inline;
pub mod unmatched;

fn url_data() -> UrlExtraData {
    thread_local! {
        static URL: UrlExtraData = UrlExtraData(Arc::new(url::Url::parse("about:blank").unwrap()));
    }
    URL.with(Clone::clone)
}

/// Blitz's preferences ([`check::blitz_prefs`]), set once before anything
/// here parses: a native document has set them already, the reference
/// interpreter and the validator would parse without them (no grid).
fn prefs() {
    static PREFS: std::sync::Once = std::sync::Once::new();
    PREFS.call_once(check::blitz_prefs);
}

fn property(name: &str) -> Option<PropertyId> {
    prefs();
    PropertyId::parse_enabled_for_all_content(name).ok()
}

fn block(css: &str) -> PropertyDeclarationBlock {
    prefs();
    parse_style_attribute(
        css,
        &url_data(),
        None,
        QuirksMode::NoQuirks,
        CssRuleType::Style,
    )
}

fn text(block: &PropertyDeclarationBlock) -> String {
    let mut css = CssStringWriter::new();
    let _ = block.to_css(&mut css);
    css
}

/// `style.cssText = css; style.cssText`: the serialization of the
/// declarations `css` holds.
pub fn css_text(css: &str) -> String {
    text(&block(css))
}

/// The first declaration of `css` (as written, `name: value`) that the
/// style engine does not parse, if any. `cssText` drops such a declaration;
/// whether Chromium keeps it is not known here, so the script DOM reports
/// it (docs/design/M6-SCRIPT-DOM.md) instead of serializing without it.
pub fn dropped_declaration(css: &str) -> Option<String> {
    // Declarations end at `;` outside parentheses, brackets and strings.
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
    for part in parts {
        let decl = part.trim();
        if decl.is_empty() {
            continue;
        }
        let Some((name, value)) = decl.split_once(':') else {
            return Some(decl.to_owned());
        };
        let value = value.trim();
        let (value, _) = match value.strip_suffix("!important") {
            Some(v) => (v.trim_end(), true),
            None => (value, false),
        };
        let Some(id) = property(name.trim()) else {
            return Some(decl.to_owned());
        };
        let mut source = SourcePropertyDeclaration::default();
        if parse_one_declaration_into(
            &mut source,
            id,
            value,
            Origin::Author,
            &url_data(),
            None,
            ParsingMode::DEFAULT,
            QuirksMode::NoQuirks,
            CssRuleType::Style,
        )
        .is_err()
        {
            return Some(decl.to_owned());
        }
    }
    None
}

/// `style.setProperty(name, value, priority)` on the declarations `css`:
/// the new serialization, or `None` when the value is invalid (nothing
/// changes). An empty value removes the property; a value of whitespace is
/// parsed like any other, as in Chromium.
pub fn set_property(css: &str, name: &str, value: &str, important: bool) -> Option<String> {
    let id = property(name)?;
    let mut block = block(css);
    if value.is_empty() {
        if let Some(first) = block.first_declaration_to_remove(&id) {
            block.remove_property(&id, first);
        }
    } else {
        let mut source = SourcePropertyDeclaration::default();
        parse_one_declaration_into(
            &mut source,
            id,
            value,
            Origin::Author,
            &url_data(),
            None,
            ParsingMode::DEFAULT,
            QuirksMode::NoQuirks,
            CssRuleType::Style,
        )
        .ok()?;
        let importance = if important {
            Importance::Important
        } else {
            Importance::Normal
        };
        // CSSOM "set a CSS declaration": an existing declaration is updated
        // where it stands (as in Chromium), a new one appended.
        let mut updates = SourcePropertyDeclarationUpdate::default();
        if block.prepare_for_update(&source, importance, &mut updates) {
            block.update(source.drain(), importance, &mut updates);
        }
    }
    Some(text(&block))
}

/// Whether `name` is a CSS property (or a custom property).
pub fn is_property(name: &str) -> bool {
    property(name).is_some()
}

/// Whether the declarations `css` hold `name` (also with an empty value).
pub fn has_property(css: &str, name: &str) -> bool {
    property(name).is_some_and(|id| block(css).first_declaration_to_remove(&id).is_some())
}

/// `style.removeProperty(name)` on the declarations `css`: the new
/// serialization (unchanged for unknown properties).
pub fn remove_property(css: &str, name: &str) -> String {
    let Some(id) = property(name) else {
        return css_text(css);
    };
    let mut block = block(css);
    if let Some(first) = block.first_declaration_to_remove(&id) {
        block.remove_property(&id, first);
    }
    text(&block)
}

/// `style.getPropertyValue(name)`.
pub fn get_property(css: &str, name: &str) -> String {
    let Some(id) = property(name) else {
        return String::new();
    };
    let mut out = CssStringWriter::new();
    let _ = block(css).property_value_to_css(&id, &mut out);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_like_cssom() {
        assert_eq!(
            css_text("color:RED;  width : 10px"),
            "color: red; width: 10px;"
        );
        assert_eq!(
            set_property("margin: 1px", "--accent", "rgb(1 2 3)", false).unwrap(),
            "margin: 1px; --accent: rgb(1 2 3);"
        );
        assert_eq!(
            set_property("", "color-scheme", "dark", false).unwrap(),
            "color-scheme: dark;"
        );
        assert_eq!(set_property("", "color", "nonsense", false), None);
        // Updating keeps the declaration in place.
        assert_eq!(
            set_property("color-scheme: dark; --a: 1", "color-scheme", "dark", false).unwrap(),
            "color-scheme: dark; --a: 1;"
        );
        assert_eq!(remove_property("--a: 1; color: red", "--a"), "color: red;");
        assert_eq!(get_property("margin: 1px 2px", "margin-left"), "2px");
        // `animation-duration: auto` reads back as `auto` (Chromium), also
        // after the block is rewritten.
        assert_eq!(
            get_property("animation-duration: auto, 2s", "animation-duration"),
            "auto, 2s"
        );
        assert_eq!(
            set_property("animation-duration: auto", "opacity", "0.5", false).unwrap(),
            "animation-duration: auto; opacity: 0.5;"
        );
        // Parsed with Blitz's preferences (grid is behind one in Stylo).
        assert_eq!(
            css_text("display: inline-grid; grid-template-columns: 1fr"),
            "display: inline-grid; grid-template-columns: 1fr;"
        );
    }
}

pub mod media;
pub use media::{MediaEnv, matches as media_matches};
pub mod root;
pub use root::Root;
pub mod compose;
pub mod replace;
pub use replace::ReplaceState;

/// The inline style of an element as Svelte's `set_style` manages it: when
/// the style value changes, the value composed with the properties is set
/// through `cssText`; otherwise changed properties are set or removed.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct StyleState {
    value: Option<Option<String>>,
    properties: Vec<Option<String>>,
}

impl StyleState {
    /// The new `style` attribute (`None`: absent) given the current one,
    /// or `Err(())` when it does not change.
    pub fn apply(
        &mut self,
        current: Option<&str>,
        value: Option<String>,
        properties: &[(&str, Option<String>)],
    ) -> Result<Option<String>, ()> {
        let values: Vec<Option<String>> = properties.iter().map(|p| p.1.clone()).collect();
        let result = if self.value.as_ref() != Some(&value) {
            let pairs: Vec<(&str, Option<&str>)> =
                properties.iter().map(|(n, v)| (*n, v.as_deref())).collect();
            let next = compose::compose(value.as_deref(), &pairs).map(|t| css_text(&t));
            self.value = Some(value);
            Ok(next)
        } else {
            let mut css = current.map(str::to_owned);
            let mut changed = false;
            for (i, (name, v)) in properties.iter().enumerate() {
                if self.properties.get(i) == Some(v) {
                    continue;
                }
                let base = css.as_deref().unwrap_or("");
                match v.as_deref().filter(|v| !v.is_empty()) {
                    Some(v) => {
                        if let Some(next) = set_property(base, name, v, false) {
                            css = Some(next);
                            changed = true;
                        }
                    }
                    None => {
                        if css.is_some() && !get_property(base, name).is_empty() {
                            css = Some(remove_property(base, name));
                            changed = true;
                        }
                    }
                }
            }
            if changed { Ok(css) } else { Err(()) }
        };
        self.properties = values;
        result
    }

    /// An inline style of properties only, as React DOM's
    /// `setValueForStyles` manages it: each property whose value changed
    /// (initially: each property) is set through the CSSOM
    /// ([`set_property`]); an absent value removes it. Returns the new
    /// `style` attribute, or `Err(())` when it does not change.
    pub fn apply_properties(
        &mut self,
        current: Option<&str>,
        properties: &[(&str, Option<String>)],
    ) -> Result<Option<String>, ()> {
        let mut css = current.map(str::to_owned);
        let mut changed = false;
        for (i, (name, v)) in properties.iter().enumerate() {
            if self.properties.get(i) == Some(v) {
                continue;
            }
            let base = css.as_deref().unwrap_or("");
            match v.as_deref().filter(|v| !v.is_empty()) {
                Some(v) => {
                    if let Some(next) = set_property(base, name, v, false) {
                        css = Some(next);
                        changed = true;
                    }
                }
                None => {
                    if css.is_some() && has_property(base, name) {
                        css = Some(remove_property(base, name));
                        changed = true;
                    }
                }
            }
        }
        self.properties = properties.iter().map(|p| p.1.clone()).collect();
        if changed { Ok(css) } else { Err(()) }
    }
}

#[cfg(test)]
mod properties_tests {
    use super::*;

    /// Apply successive property lists from no `style` attribute.
    fn run(steps: &[&[(&str, Option<&str>)]]) -> Vec<Option<String>> {
        let mut state = StyleState::default();
        let mut attr: Option<String> = None;
        steps
            .iter()
            .map(|props| {
                let props: Vec<(&str, Option<String>)> = props
                    .iter()
                    .map(|(n, v)| (*n, v.map(str::to_owned)))
                    .collect();
                if let Ok(next) = state.apply_properties(attr.as_deref(), &props) {
                    attr = next;
                }
                attr.clone()
            })
            .collect()
    }

    #[test]
    fn sets_properties_one_by_one_like_react_dom() {
        // Initially each defined property in order; absent ones create no attribute.
        assert_eq!(run(&[&[("color", None)]]), vec![None]);
        assert_eq!(run(&[&[("color", Some("nonsense"))]]), vec![None]);
        let s = run(&[
            &[
                ("margin", Some("4px")),
                ("padding", Some("6px")),
                ("color", None),
            ],
            &[
                ("margin", None),
                ("padding", Some("2px")),
                ("color", Some("green")),
            ],
            // A property set again is appended, as setProperty does.
            &[
                ("margin", Some("4px")),
                ("padding", Some("6px")),
                ("color", None),
            ],
            &[("margin", None), ("padding", None), ("color", None)],
        ]);
        assert_eq!(
            s,
            vec![
                Some("margin: 4px; padding: 6px;".into()),
                Some("padding: 2px; color: green;".into()),
                Some("padding: 6px; margin: 4px;".into()),
                Some("".into()),
            ]
        );
    }

    #[test]
    fn values_follow_setproperty() {
        // Not split at semicolons, no priority in the value.
        assert_eq!(run(&[&[("color", Some("red; width: 5px"))]]), vec![None]);
        assert_eq!(run(&[&[("color", Some("red !important"))]]), vec![None]);
        // Whitespace only: invalid for properties, an empty custom property.
        assert_eq!(
            run(&[&[("color", Some("red"))], &[("color", Some("  "))]]),
            vec![Some("color: red;".into()), Some("color: red;".into())]
        );
        assert_eq!(
            run(&[
                &[("--a", Some(" #204080 "))],
                &[("--a", Some("  "))],
                &[("--a", None)]
            ]),
            vec![
                Some("--a: #204080;".into()),
                Some("--a: ;".into()),
                Some("".into())
            ]
        );
        assert_eq!(
            run(&[&[("margin-top", Some("0"))]]),
            vec![Some("margin-top: 0px;".into())]
        );
    }
}
