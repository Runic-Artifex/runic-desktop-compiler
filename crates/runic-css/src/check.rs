//! The build-time CSS oracle: what Stylo, with Blitz's preferences, drops
//! from a stylesheet. Dropped rules and declarations would silently differ
//! from Chromium natively, so the compiler reports them (docs/design/M6-LIBRARIES.md).

use cssparser::SourceLocation;
use selectors::matching::QuirksMode;
use std::sync::Mutex;
use style::error_reporting::{ContextualParseError, ParseErrorReporter};
use style::shared_lock::SharedRwLock;
use style::stylesheets::{AllowImportRules, Origin, StylesheetContents, UrlExtraData};

/// A rule or declaration Stylo dropped: its position in the stylesheet
/// (1-based line, 1-based column) and Stylo's reason.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Dropped {
    pub line: u32,
    pub column: u32,
    pub message: String,
}

#[derive(Default)]
struct Reporter(Mutex<Vec<Dropped>>);

impl ParseErrorReporter for Reporter {
    fn report_error(&self, _url: &UrlExtraData, at: SourceLocation, error: ContextualParseError) {
        self.0.lock().unwrap().push(Dropped {
            // cssparser lines are 0-based, columns 1-based.
            line: at.line + 1,
            column: at.column,
            message: error.to_string(),
        });
    }
}

/// The preferences Blitz sets before creating its stylist (blitz-dom
/// `BaseDocument::new`), so parsing here accepts what Blitz accepts.
pub fn blitz_prefs() {
    style_config::set_pref!("layout.grid.enabled", true);
    style_config::set_pref!("layout.flexbox.balance", true);
    style_config::set_pref!("layout.unimplemented", true);
    style_config::set_pref!("layout.columns.enabled", true);
    style_config::set_pref!("layout.css.basic-shape-shape.enabled", true);
    style_config::set_pref!("layout.css.tree-counting-functions.enabled", true);
    style_config::set_pref!("layout.css.progress-function.enabled", true);
    style_config::set_pref!("layout.variable_fonts.enabled", true);
    style_config::set_pref!("layout.css.has-selector.enabled", true);
}

/// The rules and declarations Stylo drops while parsing `css` as an author
/// stylesheet. Unknown vendor-prefixed properties are dropped without an
/// error; [`declaration_parses`] checks declarations one by one.
pub fn dropped(css: &str) -> Vec<Dropped> {
    blitz_prefs();
    let reporter = Reporter::default();
    let lock = SharedRwLock::new();
    let _ = StylesheetContents::from_str(
        css,
        crate::url_data(),
        Origin::Author,
        &lock,
        None,
        Some(&reporter),
        QuirksMode::NoQuirks,
        AllowImportRules::No,
        None,
    );
    reporter.0.into_inner().unwrap()
}

/// Whether Stylo parses the declaration `name: value` (custom properties
/// always parse).
pub fn declaration_parses(name: &str, value: &str) -> bool {
    blitz_prefs();
    name.starts_with("--") || crate::set_property("", name, value, false).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_dropped_rules_and_declarations() {
        let css = ".a { color: red }\n.b::-webkit-scrollbar { display: none }\n@container (width > 1px) { .c { color: red } }\n.d:has(> svg) { color: red }\n.e { field-sizing: content }\n";
        let found = dropped(css);
        let lines: Vec<u32> = found.iter().map(|d| d.line).collect();
        assert!(lines.contains(&2), "{found:?}");
        assert!(lines.contains(&3), "{found:?}");
        assert!(!lines.contains(&1) && !lines.contains(&4), "{found:?}");
        assert!(declaration_parses("color", "oklch(0.5 0.1 200)"));
        assert!(!declaration_parses(
            "-webkit-tap-highlight-color",
            "transparent"
        ));
        assert!(!declaration_parses("field-sizing", "content"));
        assert!(declaration_parses("--tw-ring", ""));
    }
}
