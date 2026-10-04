//! `<select>` on Blitz, which draws nothing for it at the pinned revision:
//! the closed control is styled to Chromium's metrics (the widest option
//! sets the width, 4 px before the text, 16 px for the arrow, 1 px above and
//! below; the arrow is a rotated border box placed from the padding edge as
//! Chromium's theme paints it), and the shown option carries a marker
//! attribute that snapshots omit.

use blitz_dom::BaseDocument;
use blitz_traits::node_id::NodeId;

/// The marker of the option a select shows.
pub(crate) const MARK: &str = "runic-selected";

pub(crate) const UA: &str = "select { display: inline-grid; position: relative; align-items: center; \
border: 1px solid #767676; padding: 0; background-color: #ffffff; color: #000000; }\n\
select > option { display: block; grid-area: 1 / 1; visibility: hidden; padding: 1px 16px 1px 4px; white-space: nowrap; }\n\
select > option[runic-selected] { visibility: visible; }\n\
select::after { content: \"\"; position: absolute; right: 7px; top: 50%; width: 5px; height: 5px; \
margin-top: -5px; border-right: 2px solid currentColor; border-bottom: 2px solid currentColor; transform: rotate(45deg); }";

fn tag(doc: &BaseDocument, id: NodeId) -> Option<&str> {
    Some(&doc.get_node(id)?.element_data()?.name.local)
}

pub(crate) fn is_select(doc: &BaseDocument, id: NodeId) -> bool {
    tag(doc, id) == Some("select")
}

fn options(doc: &BaseDocument, select: NodeId) -> Vec<NodeId> {
    doc.get_node(select)
        .map(|n| {
            n.children
                .iter()
                .copied()
                .filter(|&c| tag(doc, c) == Some("option"))
                .collect()
        })
        .unwrap_or_default()
}

/// `option.value`: the value attribute, or the text with ASCII whitespace
/// stripped and collapsed.
fn option_value(doc: &BaseDocument, option: NodeId) -> String {
    let Some(node) = doc.get_node(option) else {
        return String::new();
    };
    match node.attr("value".into()) {
        Some(v) => v.to_owned(),
        None => node
            .text_content()
            .split([' ', '\t', '\n', '\x0c', '\r'])
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(" "),
    }
}

fn marked(doc: &BaseDocument, option: NodeId) -> bool {
    doc.get_node(option)
        .is_some_and(|n| n.attr(MARK.into()).is_some())
}

/// `select.value`: the shown option's value ("" with none).
pub(crate) fn value(doc: &BaseDocument, select: NodeId) -> Option<String> {
    if !is_select(doc, select) {
        return None;
    }
    Some(
        options(doc, select)
            .into_iter()
            .find(|&o| marked(doc, o))
            .map(|o| option_value(doc, o))
            .unwrap_or_default(),
    )
}

/// Show `option` (none: no option).
fn mark(dom: &mut crate::Dom, select: NodeId, option: Option<NodeId>) {
    for o in options(dom.doc, select) {
        let want = Some(o) == option;
        if marked(dom.doc, o) != want {
            dom.set_bool_attr(o, MARK, want);
        }
    }
}

/// `select.value = v`: the first option with that value, or none.
pub(crate) fn set_value(dom: &mut crate::Dom, select: NodeId, value: &str) {
    let found = options(dom.doc, select)
        .into_iter()
        .find(|&o| option_value(dom.doc, o) == value);
    mark(dom, select, found);
}

/// After the options changed: a controlled select shows the option of its
/// value; otherwise the shown option stays while it is there, or the first
/// enabled option is shown.
pub(crate) fn settle(dom: &mut crate::Dom, select: NodeId, desired: Option<&str>) {
    match desired {
        Some(v) => set_value(dom, select, v),
        None => {
            let options = options(dom.doc, select);
            if !options.iter().any(|&o| marked(dom.doc, o)) {
                let first = options.into_iter().find(|&o| {
                    dom.doc
                        .get_node(o)
                        .is_some_and(|n| n.attr("disabled".into()).is_none())
                });
                mark(dom, select, first);
            }
        }
    }
}

/// The option a key moves a focused closed select to (Linux Chromium):
/// arrows to the previous/next enabled option, Home/End to the first/last
/// enabled one, a printable character to the next option whose label starts
/// with it (wrapping). None: the key does not change the selection.
pub(crate) fn key_target(doc: &BaseDocument, select: NodeId, key: &str) -> Option<String> {
    let options = options(doc, select);
    let enabled: Vec<bool> = options
        .iter()
        .map(|&o| {
            doc.get_node(o)
                .is_some_and(|n| n.attr("disabled".into()).is_none())
        })
        .collect();
    let current = options.iter().position(|&o| marked(doc, o));
    let pick = |i: usize| Some(option_value(doc, options[i]));
    match key {
        "ArrowDown" => {
            let from = current.map_or(0, |c| c + 1);
            (from..options.len()).find(|&i| enabled[i]).and_then(pick)
        }
        "ArrowUp" => {
            let to = current?;
            (0..to).rev().find(|&i| enabled[i]).and_then(pick)
        }
        "Home" => (0..options.len()).find(|&i| enabled[i]).and_then(pick),
        "End" => (0..options.len())
            .rev()
            .find(|&i| enabled[i])
            .and_then(pick),
        k if k.chars().count() == 1 && k != " " => {
            let c = k.to_lowercase();
            let n = options.len();
            let start = current.map_or(0, |c| c + 1);
            (0..n)
                .map(|d| (start + d) % n)
                .find(|&i| {
                    enabled[i]
                        && doc.get_node(options[i]).is_some_and(|o| {
                            o.text_content().trim_start().to_lowercase().starts_with(&c)
                        })
                })
                .and_then(pick)
        }
        _ => None,
    }
    .filter(|v| current.map(|c| option_value(doc, options[c])) != Some(v.clone()))
}
