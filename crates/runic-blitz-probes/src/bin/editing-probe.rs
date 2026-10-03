
use runic_blitz_probes::controls;
use blitz_dom::{DocGuard, DocGuardMut, Document, DocumentConfig, EventDriver, EventHandler};
use blitz_html::HtmlDocument;
use blitz_traits::{
    events::{BlitzImeEvent, DomEvent, DomEventData, EventState, UiEvent},
    node_id::NodeId,
};
use keyboard_types::{Code, Key, Modifiers};
use serde_json::{Value, json};

struct Probe {
    doc: HtmlDocument,
    events: Vec<Value>,
    guard: bool,
}
struct Echo<'a> {
    events: &'a mut Vec<Value>,
    guard: bool,
}
impl EventHandler for Echo<'_> {
    fn handle_event(
        &mut self,
        _: &[NodeId],
        event: &mut DomEvent,
        doc: &mut dyn Document,
        state: &mut EventState,
    ) {
        if self.guard
            && (controls::blocks_edit(&doc.inner(), &event.data)
                || controls::exceeds_text_domain(&doc.inner(), &event.data))
        {
            state.prevent_default();
            return;
        }
        if let DomEventData::Input(input) = &event.data {
            let mut d = doc.inner_mut();
            let id = d.query_selector("#text").unwrap().unwrap();
            self.events.push(json!({"value":input.value}));
            controls::live_value(&mut d, id, &input.value);
        }
    }
}
impl Document for Probe {
    fn inner(&self) -> DocGuard<'_> {
        self.doc.inner()
    }
    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        self.doc.inner_mut()
    }
    fn handle_ui_event(&mut self, event: UiEvent) {
        EventDriver::new(
            &mut self.doc,
            Echo {
                events: &mut self.events,
                guard: self.guard,
            },
        )
        .handle_ui_event(event);
    }
}
fn main() {
    use base64::Engine;
    let font = base64::engine::general_purpose::STANDARD.encode(include_bytes!(
        "../../../../fixtures/quantity/assets/DejaVuSans.woff2"
    ));
    let html = format!(
        "<html><head><style>@font-face{{font-family:Probe;src:url(data:font/woff2;base64,{font}) format('woff2')}}input{{font-family:Probe}}</style></head><body><input id='text' type='text' value='ab'><button id='other'>Other</button></body></html>"
    );
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            net_provider: Some(blitz_shell::DataUriNetProvider::shared(None)),
            ..Default::default()
        },
    );
    for _ in 0..4 {
        doc.resolve(0.0);
    }
    let id = doc.query_selector("#text").unwrap().unwrap();
    doc.set_focus_to(id);
    let mut p = Probe {
        doc,
        events: vec![],
        guard: false,
    };
    let mut checks = Vec::new();
    let mut check = |name: &str, passed: bool| {
        assert!(passed, "{name}");
        checks.push(json!({"name":name,"passed":passed}));
    };
    p.doc.with_text_input(id, |mut d| {
        d.move_to_text_end();
    });
    p.handle_ui_event(controls::key(
        Key::Character("c".into()),
        Code::KeyC,
        Modifiers::empty(),
        Some("c"),
    ));
    check(
        "typing",
        controls::value(&p.doc, id).as_deref() == Some("abc"),
    );
    p.handle_ui_event(controls::key(
        Key::Backspace,
        Code::Backspace,
        Modifiers::empty(),
        None,
    ));
    check(
        "deletion",
        controls::value(&p.doc, id).as_deref() == Some("ab"),
    );
    p.doc.with_text_input(id, |mut d| d.select_all());
    p.handle_ui_event(controls::key(
        Key::Character("😀e\u{301}".into()),
        Code::Unidentified,
        Modifiers::empty(),
        Some("😀e\u{301}"),
    ));
    check(
        "unicode selection replacement",
        controls::value(&p.doc, id).as_deref() == Some("😀e\u{301}"),
    );
    let selected = controls::snapshot(&p.doc, id).unwrap();
    check("UTF16 offsets", selected["selectionStart"] == 4);
    p.doc.with_text_input(id, |mut d| d.select_byte_range(0, 4));
    let before = controls::snapshot(&p.doc, id);
    controls::live_value(&mut p.doc, id, "😀e\u{301}");
    check(
        "echo preserves selection",
        controls::snapshot(&p.doc, id) == before,
    );
    controls::live_value(&mut p.doc, id, "");
    check(
        "live clear",
        controls::value(&p.doc, id).as_deref() == Some(""),
    );
    check(
        "identity and focus",
        p.doc.query_selector("#text").unwrap() == Some(id)
            && p.doc.get_focussed_node_id() == Some(id),
    );
    p.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Enabled));
    p.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Preedit(
        "あ".into(),
        Some((3, 3)),
    )));
    let events = p.events.len();
    p.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Preedit("".into(), None)));
    p.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("あ".into())));
    check(
        "composition commit",
        controls::value(&p.doc, id).as_deref() == Some("あ") && p.events.len() == events + 1,
    );
    p.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Disabled));
    p.doc.mutate().set_attribute(
        id,
        markup5ever::QualName::new(
            None,
            markup5ever::Namespace::from(""),
            markup5ever::LocalName::from("readonly"),
        ),
        "",
    );
    p.handle_ui_event(controls::key(
        Key::Character("x".into()),
        Code::KeyX,
        Modifiers::empty(),
        Some("x"),
    ));
    let raw_readonly = controls::value(&p.doc, id); // Measure the current pin before enabling our binding guard.
    controls::live_value(&mut p.doc, id, "あ");
    p.guard = true;
    p.handle_ui_event(controls::key(
        Key::Character("x".into()),
        Code::KeyX,
        Modifiers::empty(),
        Some("x"),
    ));
    check(
        "binding read-only guard",
        controls::value(&p.doc, id).as_deref() == Some("あ"),
    );
    p.handle_ui_event(UiEvent::Ime(BlitzImeEvent::Commit("x".into())));
    check(
        "read-only composition guard",
        controls::value(&p.doc, id).as_deref() == Some("あ"),
    );
    p.handle_ui_event(controls::key(
        Key::Character("a".into()),
        Code::KeyA,
        Modifiers::CONTROL,
        None,
    ));
    check(
        "read-only remains selectable",
        controls::snapshot(&p.doc, id).unwrap()["selectionEnd"] == 1,
    );
    p.doc.mutate().clear_attribute(
        id,
        markup5ever::QualName::new(
            None,
            markup5ever::Namespace::from(""),
            markup5ever::LocalName::from("readonly"),
        ),
    );
    controls::live_value(&mut p.doc, id, &"x".repeat(256));
    p.doc
        .with_text_input(id, |mut d| d.select_byte_range(100, 100));
    let boundary = controls::snapshot(&p.doc, id);
    p.handle_ui_event(controls::key(
        Key::Character("y".into()),
        Code::KeyY,
        Modifiers::empty(),
        Some("y"),
    ));
    check(
        "length limit preserves caret",
        controls::snapshot(&p.doc, id) == boundary,
    );
    p.doc.mutate().set_attribute(
        id,
        markup5ever::QualName::new(
            None,
            markup5ever::Namespace::from(""),
            markup5ever::LocalName::from("disabled"),
        ),
        "",
    );
    p.handle_ui_event(controls::key(
        Key::Backspace,
        Code::Backspace,
        Modifiers::empty(),
        None,
    ));
    check("disabled guard", controls::snapshot(&p.doc, id) == boundary);
    p.doc.clear_focus();
    check("blur", p.doc.get_focussed_node_id() != Some(id));
    println!(
        "{}",
        json!({"route":"internal EventDriver; no OS input","blitz":"89e5e615aea649a1a9630c526956aa3d90a3afa7","rawReadonlyValue":raw_readonly,"checks":checks,"inputEvents":p.events})
    );
}
