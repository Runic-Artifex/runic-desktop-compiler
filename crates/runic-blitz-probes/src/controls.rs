use blitz_dom::BaseDocument;
use blitz_traits::{
    events::{DomEventData, UiEvent},
    node_id::NodeId,
};
use keyboard_types::{Key, Modifiers};
use serde_json::{Value, json};

pub fn value(doc: &BaseDocument, id: NodeId) -> Option<String> {
    Some(
        doc.get_node(id)?
            .element_data()?
            .text_input_data()?
            .editor
            .raw_text()
            .to_owned(),
    )
}
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
pub fn snapshot(doc: &BaseDocument, id: NodeId) -> Option<Value> {
    let editor = &doc.get_node(id)?.element_data()?.text_input_data()?.editor;
    let text = editor.raw_text();
    let range = editor.raw_selection().text_range();
    Some(
        json!({"value":text,"selectionStart":text[..range.start].encode_utf16().count(),"selectionEnd":text[..range.end].encode_utf16().count(),"composing":editor.raw_compose().is_some()}),
    )
}
pub fn locked(doc: &BaseDocument, id: NodeId) -> bool {
    doc.get_node(id)
        .is_some_and(|n| n.attr("disabled".into()).is_some() || n.attr("readonly".into()).is_some())
}
pub fn blocks_edit(doc: &BaseDocument, event: &DomEventData) -> bool {
    let Some(id) = doc.get_focussed_node_id() else {
        return false;
    };
    if value(doc, id).is_none() || !locked(doc, id) {
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
pub fn exceeds_text_domain(doc: &BaseDocument, event: &DomEventData) -> bool {
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
    let Some(editor) = doc
        .get_focussed_node_id()
        .and_then(|id| doc.get_node(id))
        .and_then(|n| n.element_data())
        .and_then(|e| e.text_input_data())
        .map(|e| &e.editor)
    else {
        return false;
    };
    let text = editor.raw_text();
    let range = editor.raw_selection().text_range();
    let units = text[..range.start].encode_utf16().count()
        + insert.encode_utf16().count()
        + text[range.end..].encode_utf16().count();
    units > 256 || insert.chars().any(|c| c < ' ' || c == '\u{7f}')
}
pub fn key(key: Key, code: keyboard_types::Code, mods: Modifiers, text: Option<&str>) -> UiEvent {
    UiEvent::KeyDown(blitz_traits::events::BlitzKeyEvent {
        key,
        code,
        modifiers: mods,
        location: keyboard_types::Location::Standard,
        is_auto_repeating: false,
        is_composing: false,
        state: blitz_traits::events::KeyState::Pressed,
        text: text.map(Into::into),
    })
}
