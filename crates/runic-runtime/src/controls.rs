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

/// Whether a text control has an IME composition in progress.
pub fn composing(doc: &BaseDocument, id: NodeId) -> bool {
    editor(doc, id).is_some_and(|e| e.editor.raw_compose().is_some())
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

/// A single-line text control losing focus shows its text from the start
/// again (Chromium's `HTMLInputElement::DispatchBlurEvent` scrolls the inner
/// editor back before the `blur` listeners run); text areas keep their
/// scroll position. Blitz keeps the offset the caret last needed, so a value
/// set later while the control is unfocused could be drawn scrolled out of
/// view.
pub fn reset_scroll_on_blur(doc: &mut BaseDocument, id: NodeId) {
    if let Some(data) = doc
        .get_node_mut(id)
        .and_then(|n| n.element_data_mut())
        .and_then(|el| el.text_input_data_mut())
        .filter(|data| !data.is_multiline)
    {
        data.scroll_offset = 0.0;
    }
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

/// Keys with no default action in a text control in Chromium on Linux: Alt
/// with arrows, Home, End, Backspace or Delete (verified in Chromium 153),
/// and PageUp/PageDown in a single-line input.
pub fn inert_key(doc: &BaseDocument, id: NodeId, k: &blitz_traits::events::BlitzKeyEvent) -> bool {
    let Some(editor) = editor(doc, id) else {
        return false;
    };
    let alt_only = k.modifiers.contains(Modifiers::ALT)
        && !k
            .modifiers
            .intersects(Modifiers::CONTROL | Modifiers::SUPER);
    match k.key {
        Key::ArrowUp
        | Key::ArrowDown
        | Key::ArrowLeft
        | Key::ArrowRight
        | Key::Home
        | Key::End
        | Key::Backspace
        | Key::Delete => alt_only,
        Key::PageUp | Key::PageDown => !editor.is_multiline,
        _ => false,
    }
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
