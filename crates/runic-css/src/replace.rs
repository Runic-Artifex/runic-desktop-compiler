//! The managed inline style in `replace` mode (docs/IR.md "Managed inline
//! style"; Vue's runtime-dom `patchStyle`): a style text replaces the
//! declarations through `cssText` when it changes, and style properties are
//! all set again, in order, whenever one of them changes.

use crate::{block, css_text, set_property, text};
use style::properties::PropertyId;

/// JavaScript's `\s`.
fn js_space(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// The value without a trailing `/\s*!important$/`, and whether it had one.
fn important(value: &str) -> (&str, bool) {
    match value.strip_suffix("!important") {
        Some(rest) => (rest.trim_end_matches(js_space), true),
        None => (value, false),
    }
}

/// `style.removeProperty(name)`: the new declarations, or `None` when
/// nothing was removed (the attribute is then left as it is).
fn remove(css: &str, name: &str) -> Option<String> {
    let id = PropertyId::parse_enabled_for_all_content(name).ok()?;
    let mut block = block(css);
    let first = block.first_declaration_to_remove(&id)?;
    block.remove_property(&id, first);
    Some(text(&block))
}

/// Set one property as runtime-dom's `setStyle` does: an empty value
/// removes it, a value ending in `!important` sets it important, an invalid
/// value changes nothing. `None`: nothing changed.
fn set(css: &str, name: &str, value: &str) -> Option<String> {
    let (value, important) = important(value);
    if value.is_empty() {
        return remove(css, name);
    }
    set_property(css, name, value, important)
}

/// The state of an element's inline style in `replace` mode.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ReplaceState {
    /// The values applied last (`None` before the first application).
    last: Option<Applied>,
}

#[derive(Clone, Debug, PartialEq)]
enum Applied {
    Text(Option<String>),
    Properties(Vec<Option<String>>),
}

impl ReplaceState {
    /// A style text (`None`: nullish): set through `cssText` when it
    /// changes; becoming nullish after a non-empty text removes the
    /// attribute. The new attribute given the current one, or `Err(())`
    /// when it does not change.
    pub fn apply_text(&mut self, value: Option<String>) -> Result<Option<String>, ()> {
        let first = self.last.is_none();
        let previous = match self.last.replace(Applied::Text(value.clone())) {
            Some(Applied::Text(p)) => p,
            _ => None,
        };
        if !first && previous == value {
            return Err(());
        }
        match value {
            Some(v) => Ok(Some(css_text(&v))),
            None if previous.is_some_and(|p| !p.is_empty()) => Ok(None),
            None => Err(()),
        }
    }

    /// Style properties (values `None`: nullish): all set in order at the
    /// first application and whenever one changes, after removing those
    /// that are nullish (from the second application on).
    pub fn apply_properties(
        &mut self,
        current: Option<&str>,
        properties: &[(&str, Option<String>)],
    ) -> Result<Option<String>, ()> {
        let values: Vec<Option<String>> = properties.iter().map(|p| p.1.clone()).collect();
        let mounted = match self.last.replace(Applied::Properties(values.clone())) {
            Some(Applied::Properties(p)) if p == values => return Err(()),
            Some(_) => true,
            None => false,
        };
        let mut css = current.map(str::to_owned);
        let mut changed = false;
        let mut step = |css: &mut Option<String>, next: Option<String>| {
            if let Some(next) = next {
                *css = Some(next);
                changed = true;
            }
        };
        if mounted {
            for (name, v) in properties {
                if v.is_none() {
                    let next = remove(css.as_deref().unwrap_or(""), name);
                    step(&mut css, next);
                }
            }
        }
        for (name, v) in properties {
            let next = set(
                css.as_deref().unwrap_or(""),
                name,
                v.as_deref().unwrap_or(""),
            );
            step(&mut css, next);
        }
        if changed { Ok(css) } else { Err(()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(
        state: &mut ReplaceState,
        css: Option<&str>,
        p: &[(&str, Option<&str>)],
    ) -> Result<Option<String>, ()> {
        let p: Vec<(&str, Option<String>)> =
            p.iter().map(|(n, v)| (*n, v.map(str::to_owned))).collect();
        state.apply_properties(css, &p)
    }

    #[test]
    fn text_like_patch_style() {
        let mut s = ReplaceState::default();
        // Nullish at mount: no attribute.
        assert_eq!(s.apply_text(None), Err(()));
        assert_eq!(
            s.apply_text(Some("color:RED".into())),
            Ok(Some("color: red;".into()))
        );
        assert_eq!(s.apply_text(Some("color:RED".into())), Err(()));
        assert_eq!(s.apply_text(None), Ok(None));
        // An empty text is an empty attribute, which stays when the text becomes nullish.
        assert_eq!(s.apply_text(Some(String::new())), Ok(Some(String::new())));
        assert_eq!(s.apply_text(None), Err(()));
        let mut s = ReplaceState::default();
        assert_eq!(s.apply_text(Some(String::new())), Ok(Some(String::new())));
    }

    #[test]
    fn properties_like_patch_style() {
        let mut s = ReplaceState::default();
        // All nullish at mount: no attribute.
        assert_eq!(props(&mut s, None, &[("color", None)]), Err(()));
        let mut s = ReplaceState::default();
        let css = props(
            &mut s,
            None,
            &[
                ("color", Some("red !important")),
                ("--x", Some("1px  !important")),
                ("float", Some("left")),
            ],
        )
        .unwrap();
        assert_eq!(
            css.as_deref(),
            Some("color: red !important; --x: 1px !important; float: left;")
        );
        // Numbers without units are invalid (nothing changes); unchanged values are not set again.
        let mut s = ReplaceState::default();
        let css = props(
            &mut s,
            None,
            &[("width", Some("120")), ("opacity", Some("0.5"))],
        )
        .unwrap();
        assert_eq!(css.as_deref(), Some("opacity: 0.5;"));
        assert_eq!(
            props(
                &mut s,
                css.as_deref(),
                &[("width", Some("120")), ("opacity", Some("0.5"))]
            ),
            Err(())
        );
        // Every property is set again in order: the shorthand resets the longhand set before it.
        let mut s = ReplaceState::default();
        let css = props(
            &mut s,
            None,
            &[("border", Some("1px solid")), ("border-color", None)],
        )
        .unwrap();
        assert_eq!(
            css.as_deref(),
            Some("border-width: 1px; border-style: solid; border-image: none;")
        );
        let css = props(
            &mut s,
            css.as_deref(),
            &[("border", Some("1px solid")), ("border-color", Some("red"))],
        )
        .unwrap();
        assert_eq!(css.as_deref(), Some("border: 1px solid red;"));
        let css = props(
            &mut s,
            css.as_deref(),
            &[("border", Some("1px solid")), ("border-color", None)],
        )
        .unwrap();
        assert_eq!(
            css.as_deref(),
            Some("border-width: 1px; border-style: solid; border-image: none;")
        );
        let mut s = ReplaceState::default();
        let css = props(
            &mut s,
            None,
            &[("border-color", None), ("border", Some("1px solid"))],
        )
        .unwrap();
        let css = props(
            &mut s,
            css.as_deref(),
            &[("border-color", Some("red")), ("border", Some("1px solid"))],
        );
        assert_eq!(css, Ok(Some("border: 1px solid;".into())));
        // Removing the last property leaves an empty attribute.
        let mut s = ReplaceState::default();
        let css = props(&mut s, None, &[("color", Some("red"))]).unwrap();
        assert_eq!(
            props(&mut s, css.as_deref(), &[("color", None)]),
            Ok(Some(String::new()))
        );
    }

    #[test]
    fn cssom_values_like_chromium() {
        // Whitespace is not an empty value: invalid for a property, a valid custom property value.
        assert_eq!(set_property("color: red", "color", "  ", false), None);
        assert_eq!(
            set_property("", "--z", "  ", false).as_deref(),
            Some("--z: ;")
        );
        // `!` is not part of a value.
        assert_eq!(set_property("", "--y", "red !important", false), None);
        assert_eq!(set_property("", "color", "red !important", false), None);
    }
}
