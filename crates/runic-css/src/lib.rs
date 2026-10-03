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

fn url_data() -> UrlExtraData {
    thread_local! {
        static URL: UrlExtraData = UrlExtraData(Arc::new(url::Url::parse("about:blank").unwrap()));
    }
    URL.with(Clone::clone)
}

fn block(css: &str) -> PropertyDeclarationBlock {
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

/// `style.setProperty(name, value, priority)` on the declarations `css`:
/// the new serialization, or `None` when the value is invalid (nothing
/// changes). An empty value removes the property.
pub fn set_property(css: &str, name: &str, value: &str, important: bool) -> Option<String> {
    let id = PropertyId::parse_enabled_for_all_content(name).ok()?;
    let mut block = block(css);
    if value.trim().is_empty() {
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

/// `style.removeProperty(name)` on the declarations `css`: the new
/// serialization (unchanged for unknown properties).
pub fn remove_property(css: &str, name: &str) -> String {
    let Ok(id) = PropertyId::parse_enabled_for_all_content(name) else {
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
    let Ok(id) = PropertyId::parse_enabled_for_all_content(name) else {
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
    }
}

pub mod media;
pub use media::{MediaEnv, matches as media_matches};
pub mod root;
pub use root::Root;
