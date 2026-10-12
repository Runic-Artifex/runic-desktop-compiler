//! Selectors no element of a program can match (docs/CONTRACT.md, "Rules no
//! element can match"). The facts over-approximate every element the
//! program, the runtime and Blitz can ever create: all tags, attribute names
//! and values, and class tokens any element may carry at any time. A complex
//! selector needs one element to carry each type, class, id and attribute
//! selector of each of its compounds (outside `:not()`, `:has()` and other
//! pseudo-classes, which only narrow the match further), so one such simple
//! selector outside the facts means it matches nothing, in any state. A
//! pseudo-element selector matches through its originating element, whose
//! compound counts. Everything else is "may match": comparisons are ASCII
//! case-insensitive, `:is()`/`:where()` fail only when every argument does,
//! and a selector Stylo does not parse is never proven.

use selectors::attr::{
    AttrSelectorOperator, CaseSensitivity, NamespaceConstraint, ParsedAttrSelectorOperation,
};
use selectors::matching::QuirksMode;
use selectors::parser::{Component, Selector};
use std::collections::{BTreeMap, BTreeSet};
use style::selector_parser::SelectorImpl;
use style::shared_lock::SharedRwLock;
use style::stylesheets::{AllowImportRules, CssRule, Origin, StylesheetContents};

/// What the elements of a program can carry; `None` is "anything".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Facts {
    /// Element local names, ASCII-lowercased.
    pub tags: Option<BTreeSet<String>>,
    /// Class tokens, ASCII-lowercased.
    pub classes: Option<BTreeSet<String>>,
    /// Attribute names (ASCII-lowercased) and the values each may have
    /// (`None`: any value).
    pub attributes: Option<BTreeMap<String, Option<BTreeSet<String>>>>,
}

impl Facts {
    /// Facts that prove nothing.
    pub fn open() -> Facts {
        Facts::default()
    }

    fn values(&self, name: &str) -> Option<Option<&BTreeSet<String>>> {
        match &self.attributes {
            None => Some(None),
            Some(map) => map.get(name).map(|v| v.as_ref()),
        }
    }
}

/// Why no element can match the selector list `list` (every selector of it
/// needs something no element carries), or none where one may match.
pub fn unmatchable(list: &str, facts: &Facts) -> Option<String> {
    crate::check::blitz_prefs();
    let lock = SharedRwLock::new();
    let contents = StylesheetContents::from_str(
        &format!("{list} {{}}"),
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
    let [CssRule::Style(rule)] = rules.0.as_slice() else {
        return None;
    };
    let rule = rule.read_with(&guard);
    let mut reasons = Vec::new();
    for selector in rule.selectors.slice() {
        reasons.push(selector_unmatchable(selector, facts)?);
    }
    reasons.sort();
    reasons.dedup();
    (!reasons.is_empty()).then(|| reasons.join("; "))
}

fn selector_unmatchable(selector: &Selector<SelectorImpl>, facts: &Facts) -> Option<String> {
    selector
        .iter_raw_match_order()
        .find_map(|c| component_unmatchable(c, facts))
}

fn component_unmatchable(c: &Component<SelectorImpl>, facts: &Facts) -> Option<String> {
    let insensitive = CaseSensitivity::AsciiCaseInsensitive;
    let attribute = |name: &str, test: Option<(AttrSelectorOperator, &str)>| -> Option<String> {
        let name = name.to_ascii_lowercase();
        let Some(values) = facts.values(&name) else {
            return Some(format!("no element has the attribute {name}"));
        };
        let (op, wanted) = test?;
        // Class and style values are joined and rewritten (merged classes,
        // CSSOM text): only their presence is known.
        if name == "class" || name == "style" {
            return None;
        }
        let values = values?;
        (!values.iter().any(|v| op.eval_str(v, wanted, insensitive)))
            .then(|| format!("no element has an attribute {name} matching {wanted:?}"))
    };
    match c {
        Component::LocalName(l) => {
            let tags = facts.tags.as_ref()?;
            let name = str::to_ascii_lowercase(&l.lower_name);
            (!tags.contains(&name)).then(|| format!("no element is a <{name}>"))
        }
        Component::Class(class) => {
            let classes = facts.classes.as_ref()?;
            let token = str::to_ascii_lowercase(&class.0);
            (!classes.contains(&token)).then(|| format!("no element has the class {token}"))
        }
        Component::ID(id) => {
            let values = facts.values("id");
            match values {
                None => Some(format!("no element has the id {}", &*id.0)),
                Some(None) => None,
                Some(Some(values)) => (!values
                    .iter()
                    .any(|v| insensitive.eq(v.as_bytes(), id.0.as_bytes())))
                .then(|| format!("no element has the id {}", &*id.0)),
            }
        }
        Component::AttributeInNoNamespaceExists {
            local_name_lower, ..
        } => attribute(local_name_lower, None),
        Component::AttributeInNoNamespace {
            local_name,
            operator,
            value,
            ..
        } => attribute(local_name, Some((*operator, &value.0))),
        Component::AttributeOther(a) => {
            // Attributes in a namespace (xlink:href) are not in the facts.
            if !matches!(a.namespace, None | Some(NamespaceConstraint::Any)) {
                return None;
            }
            match &a.operation {
                ParsedAttrSelectorOperation::Exists => attribute(&a.local_name_lower, None),
                ParsedAttrSelectorOperation::WithValue {
                    operator, value, ..
                } => attribute(&a.local_name_lower, Some((*operator, &value.0))),
            }
        }
        Component::Is(list) | Component::Where(list) => {
            let mut reasons = Vec::new();
            for s in list.slice() {
                reasons.push(selector_unmatchable(s, facts)?);
            }
            (!reasons.is_empty()).then(|| reasons.join(", "))
        }
        // No constraint: they only narrow what the other parts match.
        Component::ExplicitUniversalType
        | Component::ExplicitAnyNamespace
        | Component::ExplicitNoNamespace
        | Component::DefaultNamespace(_)
        | Component::Namespace(..)
        | Component::Negation(_)
        | Component::Root
        | Component::Empty
        | Component::Scope
        | Component::ImplicitScope
        | Component::ParentSelector
        | Component::Nth(_)
        | Component::NthOf(_)
        | Component::NonTSPseudoClass(_)
        | Component::Slotted(_)
        | Component::Part(_)
        | Component::Host(_)
        | Component::Has(_)
        | Component::Invalid(_)
        | Component::PseudoElement(_)
        | Component::Combinator(_)
        | Component::RelativeSelectorAnchor => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn set(items: &[&str]) -> BTreeSet<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    fn facts() -> Facts {
        let mut attributes = BTreeMap::new();
        attributes.insert("class".to_string(), None);
        attributes.insert("id".to_string(), Some(set(&["main"])));
        attributes.insert("data-state".to_string(), Some(set(&["open", "closed"])));
        attributes.insert("data-slot".to_string(), None);
        Facts {
            tags: Some(set(&["html", "body", "div", "span"])),
            classes: Some(set(&["card", "flex"])),
            attributes: Some(attributes),
        }
    }

    #[test]
    fn simple_selectors_outside_the_facts() {
        let f = facts();
        assert!(unmatchable(".step::before", &f).is_some());
        assert!(unmatchable(".card::before", &f).is_none());
        assert!(unmatchable(".CARD", &f).is_none(), "case-insensitive");
        assert!(unmatchable("p", &f).is_some());
        assert!(unmatchable("#main", &f).is_none());
        assert!(unmatchable("#other", &f).is_some());
        assert!(unmatchable("[data-line]", &f).is_some());
        assert!(unmatchable("[data-slot=anything]", &f).is_none());
        assert!(unmatchable("[data-state=open]", &f).is_none());
        assert!(unmatchable("[data-state^=clo]", &f).is_none());
        assert!(unmatchable("[data-state=hidden]", &f).is_some());
        assert!(unmatchable("[class*=nothing]", &f).is_none());
    }

    #[test]
    fn lists_combinators_and_pseudo_classes() {
        let f = facts();
        // Every selector of a list must fail.
        assert!(unmatchable(".step, .card", &f).is_none());
        assert!(unmatchable(".step, p", &f).is_some());
        // Any compound of a complex selector.
        assert!(unmatchable(".step > .card", &f).is_some());
        assert!(unmatchable(".card .flex:hover", &f).is_none());
        // :not() and :has() never prove anything.
        assert!(unmatchable(".card:not(.step)", &f).is_none());
        assert!(unmatchable(":not(.card)", &f).is_none());
        assert!(unmatchable(".card:has(.step)", &f).is_none());
        // :is()/:where() fail only when every argument does.
        assert!(unmatchable(":is(.step, p) span", &f).is_some());
        assert!(unmatchable(":where(.step, .card)", &f).is_none());
        // Unparsed selectors are never proven.
        assert!(unmatchable(".step::-webkit-nothing", &f).is_none());
        // Nothing is proven without facts.
        assert!(unmatchable(".step", &Facts::open()).is_none());
    }
}
