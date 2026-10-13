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
    style_config::set_pref!("layout.container-queries.enabled", true);
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

/// The specificity of each selector of the selector list `selector`, as
/// Stylo computes it for the cascade; none where Stylo does not parse it.
pub fn specificities(selector: &str) -> Option<Vec<u32>> {
    blitz_prefs();
    let lock = SharedRwLock::new();
    let contents = StylesheetContents::from_str(
        &format!("{selector} {{}}"),
        crate::url_data(),
        Origin::Author,
        &lock,
        None,
        None,
        QuirksMode::NoQuirks,
        AllowImportRules::No,
        None,
    );
    let guard = lock.read();
    let rules = contents.rules.read_with(&guard);
    match rules.0.as_slice() {
        [style::stylesheets::CssRule::Style(rule)] => Some(
            rule.read_with(&guard)
                .selectors
                .slice()
                .iter()
                .map(|s| s.specificity())
                .collect(),
        ),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_dropped_rules_and_declarations() {
        let css = ".a { color: red }\n.b::-webkit-scrollbar { display: none }\n@starting-style { .c { color: red } }\n.d:has(> svg) { color: red }\n.e { line-clamp: 2 }\n@container card (width > 1px) { .f { color: red } }\n";
        let found = dropped(css);
        let lines: Vec<u32> = found.iter().map(|d| d.line).collect();
        assert!(lines.contains(&2), "{found:?}");
        assert!(lines.contains(&3), "{found:?}");
        assert!(
            !lines.contains(&1) && !lines.contains(&4) && !lines.contains(&6),
            "{found:?}"
        );
        assert!(declaration_parses("color", "oklch(0.5 0.1 200)"));
        assert!(!declaration_parses(
            "-webkit-tap-highlight-color",
            "transparent"
        ));
        assert!(!declaration_parses("line-clamp", "2"));
        // Parsed in servo builds by the Stylo fork.
        assert!(declaration_parses("field-sizing", "content"));
        assert!(declaration_parses("-webkit-line-clamp", "2"));
        assert!(declaration_parses("-webkit-box-orient", "vertical"));
        assert!(declaration_parses("display", "-webkit-box"));
        assert!(declaration_parses("display", "-webkit-inline-box"));
        assert!(declaration_parses("--tw-ring", ""));
    }

    #[test]
    fn specificities_are_stylo_s() {
        // (Ids, classes and attributes, types: 10 bits each.)
        assert_eq!(specificities(".a"), Some(vec![1 << 10]));
        assert_eq!(specificities("#a, div"), Some(vec![1 << 20, 1]));
        // `:is()` takes its most specific argument; `:where()` counts nothing.
        assert_eq!(specificities(":is(.a > *)[x]"), Some(vec![2 << 10]));
        assert_eq!(specificities(":where(.a) b"), Some(vec![1]));
        assert_eq!(specificities("::-webkit-nothing"), None);
    }
}
