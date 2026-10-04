//! `<select>` on Blitz, which draws nothing for it at the pinned revision:
//! the closed control is styled to Chromium's metrics (the widest option
//! sets the width, 4 px before the text, 16 px for the arrow, 1 px above and
//! below; the arrow is a rotated border box placed from the padding edge as
//! Chromium's theme paints it), and the shown option carries a marker
//! attribute that snapshots omit.

use blitz_dom::BaseDocument;
use blitz_traits::node_id::NodeId;

/// The marker of the selected option (the select's value).
pub(crate) const MARK: &str = "runic-selected";
/// The marker of the option the closed control shows (the highlighted one
/// while the popup is open).
pub(crate) const SHOWN: &str = "runic-shown";

pub(crate) const UA: &str = "select { display: inline-grid; position: relative; align-items: center; \
border: 1px solid #767676; padding: 0; background-color: #ffffff; color: #000000; }\n\
select > option { display: block; grid-area: 1 / 1; visibility: hidden; padding: 1px 16px 1px 4px; white-space: nowrap; }\n\
select > option[runic-shown] { visibility: visible; }\n\
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

/// Select `option` (none: no option), which the control then shows.
fn mark(dom: &mut crate::Dom, select: NodeId, option: Option<NodeId>) {
    for o in options(dom.doc, select) {
        let want = Some(o) == option;
        if marked(dom.doc, o) != want {
            dom.set_bool_attr(o, MARK, want);
        }
    }
    show(dom, select, option);
}

/// The closed control shows `option`.
fn show(dom: &mut crate::Dom, select: NodeId, option: Option<NodeId>) {
    for o in options(dom.doc, select) {
        let want = Some(o) == option;
        let shown = dom
            .doc
            .get_node(o)
            .is_some_and(|n| n.attr(SHOWN.into()).is_some());
        if shown != want {
            dom.set_bool_attr(o, SHOWN, want);
        }
    }
}

/// While the popup is open the control shows the highlighted option.
pub(crate) fn show_index(dom: &mut crate::Dom, select: NodeId, i: Option<usize>) {
    let option = i.and_then(|i| options(dom.doc, select).get(i).copied());
    show(dom, select, option);
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

/// An open select popup: the select and the highlighted option.
pub(crate) struct Popup {
    pub select: NodeId,
    pub highlighted: Option<usize>,
    /// The drawn list (none in probes: Chromium's popup is not page content).
    pub list: Option<NodeId>,
}

/// The index of the shown option.
pub(crate) fn shown_index(doc: &BaseDocument, select: NodeId) -> Option<usize> {
    options(doc, select)
        .into_iter()
        .position(|o| marked(doc, o))
}

/// Whether an enabled option has `value`.
pub(crate) fn has_enabled_value(doc: &BaseDocument, select: NodeId, value: &str) -> bool {
    options(doc, select).into_iter().any(|o| {
        option_value(doc, o) == value
            && doc
                .get_node(o)
                .is_some_and(|n| n.attr("disabled".into()).is_none())
    })
}

/// Whether option `i` is enabled.
pub(crate) fn option_enabled(doc: &BaseDocument, select: NodeId, i: usize) -> bool {
    options(doc, select)
        .get(i)
        .and_then(|&o| doc.get_node(o))
        .is_some_and(|n| n.attr("disabled".into()).is_none())
}

/// The value of option `i`.
pub(crate) fn value_at(doc: &BaseDocument, select: NodeId, i: usize) -> Option<String> {
    options(doc, select).get(i).map(|&o| option_value(doc, o))
}

/// Where a key moves the highlight of an open popup (as \`key_target\`, by index).
pub(crate) fn popup_key(
    doc: &BaseDocument,
    select: NodeId,
    from: Option<usize>,
    key: &str,
) -> Option<usize> {
    let options = options(doc, select);
    let enabled: Vec<bool> = options
        .iter()
        .map(|&o| {
            doc.get_node(o)
                .is_some_and(|n| n.attr("disabled".into()).is_none())
        })
        .collect();
    let n = options.len();
    match key {
        "ArrowDown" => (from.map_or(0, |c| c + 1)..n).find(|&i| enabled[i]),
        "ArrowUp" => (0..from?).rev().find(|&i| enabled[i]),
        "Home" => (0..n).find(|&i| enabled[i]),
        "End" => (0..n).rev().find(|&i| enabled[i]),
        k if k.chars().count() == 1 && k != " " => {
            let c = k.to_lowercase();
            let start = from.map_or(0, |c| c + 1);
            (0..n).map(|d| (start + d) % n).find(|&i| {
                enabled[i]
                    && doc.get_node(options[i]).is_some_and(|o| {
                        o.text_content().trim_start().to_lowercase().starts_with(&c)
                    })
            })
        }
        _ => None,
    }
}

/// Draw the popup list under the select (windowed runs).
pub(crate) fn draw_popup(
    dom: &mut crate::Dom,
    select: NodeId,
    highlighted: Option<usize>,
) -> Option<NodeId> {
    let rect = crate::layout::client_rect(dom.doc, select)?;
    let body = dom.doc.query_selector("body").ok().flatten()?;
    let font = dom.doc.resolved_style_value(select, "font");
    let color = dom.doc.resolved_style_value(select, "color");
    let pad = |side: &str| {
        dom.doc
            .resolved_style_value(select, side)
            .trim_end_matches("px")
            .parse::<f64>()
            .unwrap_or(0.0)
    };
    let (left, right) = (pad("padding-left") + 4.0, pad("padding-right") + 4.0);
    let list = dom.element("div");
    dom.set_attr(
        list,
        "style",
        &format!(
            "position: fixed; left: {}px; top: {}px; min-width: {}px; box-sizing: border-box; margin: 0; z-index: 2147483647; background: #ffffff; color: {color}; border: 1px solid #767676; font: {font}; padding: 0;",
            rect.x,
            rect.y + rect.height,
            rect.width
        ),
    );
    for (i, o) in options(dom.doc, select).into_iter().enumerate() {
        let item = dom.element("div");
        let disabled = dom
            .doc
            .get_node(o)
            .is_some_and(|n| n.attr("disabled".into()).is_some());
        let colors = if Some(i) == highlighted {
            "background: #1967d2; color: #ffffff;"
        } else if disabled {
            "color: #808080;"
        } else {
            ""
        };
        dom.set_attr(
            item,
            "style",
            &format!(
                "margin: 0; padding: 4px {right}px 4px {left}px; white-space: nowrap; {colors}"
            ),
        );
        let text = dom
            .doc
            .get_node(o)
            .map(|n| n.text_content())
            .unwrap_or_default();
        let t = dom.text(text.trim());
        dom.append(item, t);
        dom.append(list, item);
    }
    dom.append(body, list);
    Some(list)
}
