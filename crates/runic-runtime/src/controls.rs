//! Text control behaviour that Blitz does not provide at the pinned revision:
//! read-only/disabled edit guards and `maxlength` enforcement before mutation
//! (Blitz's `Input` event is dispatched after the editor changed and is not
//! cancelable), plus live value access that preserves selection on echoes.

use blitz_dom::BaseDocument;
use blitz_traits::{events::DomEventData, node_id::NodeId};
use keyboard_types::{Key, Modifiers};

fn editor(doc: &BaseDocument, id: NodeId) -> Option<&blitz_dom::node::TextInputData> {
    doc.get_node(id)?.element_data()?.text_input_data()
}

pub fn has_editor(doc: &BaseDocument, id: NodeId) -> bool {
    editor(doc, id).is_some()
}

pub fn value(doc: &BaseDocument, id: NodeId) -> Option<String> {
    Some(editor(doc, id)?.editor.raw_text().to_owned())
}

/// Replace the editor text when it differs; returns whether it changed.
pub fn live_value(doc: &mut BaseDocument, id: NodeId, text: &str) -> bool {
    if value(doc, id).as_deref() == Some(text) {
        return false;
    }
    doc.with_text_input(id, |mut editor| {
        editor.select_all();
        editor.insert_or_replace_selection(text);
        editor.move_to_text_end();
    });
    true
}

/// `(selectionStart, selectionEnd)` in UTF-16 code units.
#[cfg_attr(not(feature = "probe"), allow(dead_code))]
pub fn selection(doc: &BaseDocument, id: NodeId) -> Option<(usize, usize, bool)> {
    let e = &editor(doc, id)?.editor;
    let text = e.raw_text();
    let range = e.raw_selection().text_range();
    let units = |b: usize| text[..b].encode_utf16().count();
    Some((
        units(range.start),
        units(range.end),
        e.raw_compose().is_some(),
    ))
}

fn locked(doc: &BaseDocument, id: NodeId) -> bool {
    doc.get_node(id)
        .is_some_and(|n| n.attr("disabled".into()).is_some() || n.attr("readonly".into()).is_some())
}

/// Editing keys and IME input on a focused disabled/read-only text control.
pub fn blocks_edit(doc: &BaseDocument, event: &DomEventData) -> bool {
    let Some(id) = doc.get_focussed_node_id() else {
        return false;
    };
    if !has_editor(doc, id) || !locked(doc, id) {
        return false;
    }
    match event {
        DomEventData::Ime(_) => true,
        DomEventData::KeyDown(k) => match &k.key {
            Key::Backspace | Key::Delete => true,
            Key::Character(s) => {
                !k.modifiers
                    .intersects(Modifiers::CONTROL | Modifiers::SUPER)
                    || !matches!(s.to_lowercase().as_str(), "a" | "c")
            }
            _ => false,
        },
        _ => false,
    }
}

/// A character key whose insertion would exceed the control's `maxlength`
/// (in UTF-16 units) or insert a control character into a single-line input.
pub fn exceeds_maxlength(doc: &BaseDocument, event: &DomEventData) -> bool {
    let DomEventData::KeyDown(key) = event else {
        return false;
    };
    if key
        .modifiers
        .intersects(Modifiers::CONTROL | Modifiers::SUPER)
    {
        return false;
    }
    let Key::Character(insert) = &key.key else {
        return false;
    };
    let Some(id) = doc.get_focussed_node_id() else {
        return false;
    };
    let Some(data) = editor(doc, id) else {
        return false;
    };
    if insert.chars().any(|c| c < ' ' || c == '\u{7f}') {
        return true;
    }
    let Some(max) = doc
        .get_node(id)
        .and_then(|n| n.attr("maxlength".into()))
        .and_then(|m| m.trim().parse::<usize>().ok())
    else {
        return false;
    };
    let text = data.editor.raw_text();
    let range = data.editor.raw_selection().text_range();
    let units = text[..range.start].encode_utf16().count()
        + insert.encode_utf16().count()
        + text[range.end..].encode_utf16().count();
    units > max
}
