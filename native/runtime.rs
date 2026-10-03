use crate::{app, controls};
use anyrender::{ImageRenderer, RenderContext, WindowRenderer};
use blitz_dom::{
    BaseDocument, DocGuard, DocGuardMut, Document, DocumentConfig, EventDriver, EventHandler,
};
use blitz_html::HtmlDocument;
use blitz_shell::{
    BlitzApplication, BlitzShellProxy, DataUriNetProvider, WindowConfig, create_default_event_loop,
};
use blitz_traits::{
    events::{BlitzKeyEvent, DomEvent, DomEventData, EventState, KeyState, UiEvent},
    node_id::NodeId,
    shell::{ColorScheme, Viewport},
};
use keyboard_types::{Code, Key, Location, Modifiers};
use markup5ever::{LocalName, Namespace, QualName};
use serde_json::{Value, json};
use std::{
    io::Write,
    sync::{Arc, Mutex},
    time::Instant,
};

pub fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}
pub enum Kind {
    Text,
    LiveValue,
    Conditional(fn(&app::State) -> String),
    Attribute(&'static str, bool),
}
pub struct Binding {
    pub id: &'static str,
    pub kind: Kind,
    pub deps: &'static [usize],
    pub value: fn(&app::State) -> String,
}
fn attr(name: &str) -> QualName {
    QualName::new(None, Namespace::from(""), LocalName::from(name))
}
fn node(doc: &BaseDocument, id: &str) -> Option<NodeId> {
    doc.query_selector(&format!("[data-runic='{id}']"))
        .ok()
        .flatten()
}
fn cache(s: &app::State) -> Vec<String> {
    app::BINDINGS.iter().map(|b| (b.value)(s)).collect()
}
fn apply(
    doc: &mut BaseDocument,
    s: &app::State,
    changed: &[bool],
    previous: &mut [String],
) -> usize {
    let mut writes = 0;
    for (index, binding) in app::BINDINGS.iter().enumerate() {
        if app::OPTIMIZE && !binding.deps.iter().any(|&slot| changed[slot]) {
            continue;
        }
        let value = (binding.value)(s);
        // Visibility changes only mount/unmount when the condition changes.
        // Evaluating every binding in baseline mode must still preserve node identity.
        if previous[index] == value {
            continue;
        }
        previous[index] = value.clone();
        let Some(id) = node(doc, binding.id) else {
            continue;
        };
        if matches!(binding.kind, Kind::LiveValue) {
            writes += usize::from(controls::live_value(doc, id, &value));
            continue;
        }
        let mut mutator = doc.mutate();
        match binding.kind {
            Kind::LiveValue => unreachable!(),
            Kind::Text => mutator.set_inner_html(id, &escape(&value)),
            Kind::Conditional(children) => {
                let html = if value == "true" {
                    children(s)
                } else {
                    String::new()
                };
                mutator.set_inner_html(id, &html);
            }
            Kind::Attribute(name, boolean) => {
                if boolean && value == "false" {
                    mutator.clear_attribute(id, attr(name));
                } else {
                    mutator.set_attribute(id, attr(name), if boolean { "" } else { &value });
                }
            }
        }
        writes += 1;
    }
    writes
}
fn snapshot(doc: &BaseDocument, state: &app::State) -> Value {
    let mut elements = serde_json::Map::new();
    for &id in app::ELEMENTS {
        if let Some(n) = doc.query_selector(&format!("#{id}")).ok().flatten() {
            let nd = doc.get_node(n).unwrap();
            let rect = doc.get_client_bounding_rect(n);
            let text = nd.text_content();
            let mut record = json!({"text":text,"class":nd.attr("class".into()).unwrap_or(""),"disabled":nd.attr("disabled".into()).is_some(),"nodeIdentity":format!("{n:?}"),"rect":rect.map(|r|json!({"x":r.x,"y":r.y,"width":r.width,"height":r.height}))});
            if let Some(editor) = controls::snapshot(doc, n) {
                for (k, v) in editor.as_object().unwrap() {
                    record[k] = v.clone();
                }
            }
            elements.insert(id.into(), record);
        }
    }
    let focused = doc
        .get_focussed_node_id()
        .and_then(|id| doc.get_node(id))
        .and_then(|n| n.attr("id".into()))
        .map(str::to_owned);
    json!({"state":app::json(state),"elements":elements,"focused":focused,"irHash":app::IR_HASH})
}
struct Handler<'a> {
    state: &'a mut app::State,
    snapshots: &'a mut Vec<Value>,
    cache: &'a mut Vec<String>,
    space_target: &'a mut Option<NodeId>,
    input_start: &'a Arc<Mutex<Option<Instant>>>,
}
impl EventHandler for Handler<'_> {
    fn handle_event(
        &mut self,
        chain: &[NodeId],
        event: &mut DomEvent,
        doc: &mut dyn Document,
        event_state: &mut EventState,
    ) {
        if controls::blocks_edit(&doc.inner(), &event.data)
            || controls::exceeds_text_domain(&doc.inner(), &event.data)
        {
            event_state.prevent_default();
            return;
        }
        let button_focused = {
            let d = doc.inner();
            d.get_focussed_node_id()
                .and_then(|id| d.get_node(id))
                .and_then(|n| n.element_data())
                .is_some_and(|e| e.name.local == LocalName::from("button"))
        };
        let payload = if let DomEventData::Input(input) = &event.data {
            Some(input.value.clone())
        } else {
            None
        };
        let route = match &event.data {
            DomEventData::Input(_) => "text-input",
            DomEventData::Click(_) => "pointer-click",
            DomEventData::KeyDown(k) if k.key == Key::Tab => {
                event_state.prevent_default();
                *self.space_target = None;
                let mut d = doc.inner_mut();
                let controls: Vec<NodeId> = app::EVENTS
                    .iter()
                    .filter_map(|&(id, e)| {
                        if !app::focusable(e, self.state) {
                            return None;
                        }
                        let n = node(&d, id)?;
                        let r = d.get_client_bounding_rect(n)?;
                        (r.width > 0.0 && r.height > 0.0).then_some(n)
                    })
                    .collect();
                let old = d.get_focussed_node_id();
                let backwards = k.modifiers.contains(Modifiers::SHIFT);
                let next = old
                    .and_then(|id| controls.iter().position(|n| *n == id))
                    .map(|i| {
                        if backwards {
                            if i == 0 { None } else { Some(controls[i - 1]) }
                        } else {
                            controls.get(i + 1).copied()
                        }
                    })
                    .unwrap_or_else(|| {
                        if backwards {
                            controls.last().copied()
                        } else {
                            controls.first().copied()
                        }
                    });
                if let Some(n) = next {
                    d.set_focus_to(n);
                } else {
                    d.clear_focus();
                }
                d.resolve(0.0);
                let mut record = snapshot(&d, self.state);
                record["route"] = json!("key-tab");
                record["backwards"] = json!(backwards);
                self.snapshots.push(record.clone());
                println!("NATIVE_INPUT {record}");
                if let Ok(file) = std::env::var("RUNIC_TRACE") {
                    std::fs::write(file, serde_json::to_string_pretty(self.snapshots).unwrap())
                        .unwrap();
                }
                event_state.request_redraw();
                return;
            }
            DomEventData::KeyDown(k) if button_focused && k.key == Key::Enter => "key-enter",
            DomEventData::KeyDown(k) if button_focused && k.key == Key::Character(" ".into()) => {
                event_state.prevent_default();
                if !k.is_auto_repeating {
                    *self.space_target = doc.inner().get_focussed_node_id();
                }
                return;
            }
            DomEventData::KeyUp(k) if button_focused && k.key == Key::Character(" ".into()) => {
                event_state.prevent_default();
                let held = self.space_target.take();
                if held.is_none() || held != doc.inner().get_focussed_node_id() {
                    return;
                }
                "key-space"
            }
            _ => return,
        };
        let event_id = {
            let d = doc.inner();
            chain.iter().find_map(|&n| {
                let nd = d.get_node(n)?;
                if nd.attr("disabled".into()).is_some() {
                    return None;
                }
                let identity = nd.attr("data-runic".into())?;
                app::EVENTS.iter().find_map(|&(id, e)| {
                    (id == identity && app::is_text_event(e) == payload.is_some()).then_some((e, n))
                })
            })
        };
        let Some((e, target)) = event_id else {
            return;
        };
        if !app::enabled(e, self.state) {
            return;
        }
        let start = Instant::now();
        *self.input_start.lock().unwrap() = Some(start);
        let changed = match app::dispatch_event(self.state, e, payload.as_deref()) {
            Ok(changed) => changed,
            Err(reason) => {
                let mut d = doc.inner_mut();
                if let Some(binding) = app::BINDINGS
                    .iter()
                    .find(|b| matches!(b.kind, Kind::LiveValue) && node(&d, b.id) == Some(target))
                {
                    controls::live_value(&mut d, target, &(binding.value)(self.state));
                }
                println!("NATIVE_REJECTED {reason}");
                event_state.request_redraw();
                return;
            }
        };
        let mut d = doc.inner_mut();
        // Supported controls are buttons outside forms. Blitz's default Click
        // action clears their focus; supply the Linux button focus contract and
        // suppress that default action. Disabled controls cannot dispatch here.
        if payload.is_none() {
            event_state.prevent_default();
        }
        let writes = apply(&mut d, self.state, &changed, self.cache);
        if payload.is_none() {
            if app::focusable(e, self.state) {
                d.set_focus_to(target);
            } else {
                d.clear_focus();
            }
        }
        d.resolve(0.0);
        let mut record = snapshot(&d, self.state);
        record["event"] = json!(e);
        record["route"] = json!(route);
        if let Some(text) = payload {
            record["payload"] = json!(text);
        }
        record["writes"] = json!(writes);
        record["update_us"] = json!(start.elapsed().as_secs_f64() * 1e6);
        println!("NATIVE_EVENT {record}");
        self.snapshots.push(record.clone());
        if let Ok(file) = std::env::var("RUNIC_TRACE") {
            std::fs::write(file, serde_json::to_string_pretty(&self.snapshots).unwrap()).unwrap();
        }
        event_state.request_redraw();
    }
}
struct Native {
    doc: HtmlDocument,
    state: app::State,
    snapshots: Vec<Value>,
    cache: Vec<String>,
    space_target: Option<NodeId>,
    input_start: Arc<Mutex<Option<Instant>>>,
}
impl Document for Native {
    fn inner(&self) -> DocGuard<'_> {
        self.doc.inner()
    }
    fn inner_mut(&mut self) -> DocGuardMut<'_> {
        self.doc.inner_mut()
    }
    fn handle_ui_event(&mut self, event: UiEvent) {
        EventDriver::new(
            &mut self.doc,
            Handler {
                state: &mut self.state,
                snapshots: &mut self.snapshots,
                cache: &mut self.cache,
                space_target: &mut self.space_target,
                input_start: &self.input_start,
            },
        )
        .handle_ui_event(event);
    }
}
type Cpu = anyrender_vello_cpu::VelloCpuWindowRenderer;
// Requests real window resizes and records layout after Winit redraw delivery.
// This is a window-system resize probe, not a synthesized input test.
struct ResizeProbe {
    app: BlitzApplication<Measured>,
    step: usize,
}
impl winit::application::ApplicationHandler for ResizeProbe {
    fn can_create_surfaces(&mut self, e: &dyn winit::event_loop::ActiveEventLoop) {
        self.app.can_create_surfaces(e);
    }
    fn destroy_surfaces(&mut self, e: &dyn winit::event_loop::ActiveEventLoop) {
        self.app.destroy_surfaces(e);
    }
    fn resumed(&mut self, e: &dyn winit::event_loop::ActiveEventLoop) {
        self.app.resumed(e);
    }
    fn suspended(&mut self, e: &dyn winit::event_loop::ActiveEventLoop) {
        self.app.suspended(e);
    }
    fn proxy_wake_up(&mut self, e: &dyn winit::event_loop::ActiveEventLoop) {
        self.app.proxy_wake_up(e);
    }
    fn window_event(
        &mut self,
        e: &dyn winit::event_loop::ActiveEventLoop,
        id: winit::window::WindowId,
        event: winit::event::WindowEvent,
    ) {
        let redraw = matches!(event, winit::event::WindowEvent::RedrawRequested);
        self.app.window_event(e, id, event);
        if !redraw {
            return;
        }
        let Some(view) = self.app.windows.get_mut(&id) else {
            return;
        };
        let size = view.doc.inner().viewport().window_size;
        let wanted = if self.step == 1 {
            (420, 600)
        } else {
            (800, 600)
        };
        if self.step > 0 && size != wanted {
            return;
        }
        let native = view.downcast_doc_mut::<Native>();
        println!(
            "NATIVE_RESIZE {}",
            json!({"step":self.step,"size":size,"snapshot":snapshot(&native.doc,&native.state)})
        );
        if self.step == 2 {
            e.exit();
            return;
        }
        let width = if self.step == 0 { 420 } else { 800 };
        self.step += 1;
        let _ = view
            .window
            .request_surface_size(winit::dpi::LogicalSize::new(width, 600).into());
        view.window.request_redraw();
    }
}
struct Measured {
    renderer: Cpu,
    start: Instant,
    first: bool,
    input_start: Arc<Mutex<Option<Instant>>>,
}
impl RenderContext for Measured {}
impl WindowRenderer for Measured {
    type ScenePainter<'a> = <Cpu as WindowRenderer>::ScenePainter<'a>;
    fn resume<F: FnOnce() + 'static>(
        &mut self,
        window: Arc<dyn anyrender::WindowHandle>,
        w: u32,
        h: u32,
        f: F,
    ) {
        self.renderer.resume(window, w, h, f);
    }
    fn complete_resume(&mut self) -> bool {
        self.renderer.complete_resume()
    }
    fn suspend(&mut self) {
        self.renderer.suspend();
    }
    fn is_active(&self) -> bool {
        self.renderer.is_active()
    }
    fn set_size(&mut self, w: u32, h: u32) {
        self.renderer.set_size(w, h);
    }
    fn render<F: FnOnce(&mut Self::ScenePainter<'_>)>(&mut self, f: F) {
        self.renderer.render(f);
        if let Some(input) = self.input_start.lock().unwrap().take() {
            println!("INPUT_PRESENT_US {}", input.elapsed().as_secs_f64() * 1e6);
        }
        if !self.first {
            self.first = true;
            println!(
                "FIRST_PRESENT_US {}",
                self.start.elapsed().as_secs_f64() * 1e6
            );
            if std::env::var_os("RUNIC_MEASURE_EXIT").is_some() {
                std::process::exit(0);
            }
        }
    }
}
fn make_doc(state: &app::State, w: u32, h: u32) -> HtmlDocument {
    let html = format!(
        "<!doctype html><html><head><style>runic-text,runic-if{{display:contents}}button:focus{{border-color:currentColor}}{}</style></head><body>{}</body></html>",
        app::CSS,
        app::body(state)
    );
    let mut doc = HtmlDocument::from_html(
        &html,
        DocumentConfig {
            net_provider: Some(DataUriNetProvider::shared(None)),
            html_parser_provider: Some(Arc::new(blitz_html::HtmlProvider)),
            viewport: Some(Viewport::new(w, h, 1.0, ColorScheme::Light)),
            ..Default::default()
        },
    );
    for _ in 0..4 {
        doc.resolve(0.0);
    }
    doc
}
fn save_png(doc: &mut BaseDocument, w: u32, h: u32, file: &str) {
    let mut renderer = anyrender_vello_cpu::VelloCpuImageRenderer::new(w, h);
    let mut buffer = Vec::new();
    renderer.render_to_vec(
        |scene| blitz_paint::paint_scene(scene, doc, 1.0, w, h, 0, 0),
        &mut buffer,
    );
    let mut encoder = png::Encoder::new(std::fs::File::create(file).unwrap(), w, h);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&buffer)
        .unwrap();
}
pub fn launch() {
    let start = Instant::now();
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.first().is_some_and(|a| a == "--edit-trace") {
        let actions: Value =
            serde_json::from_str(&std::io::read_to_string(std::io::stdin()).unwrap()).unwrap();
        let state = app::initial();
        let doc = make_doc(&state, 800, 600);
        let previous = cache(&state);
        let mut native = Native {
            doc,
            state,
            cache: previous,
            snapshots: vec![],
            space_target: None,
            input_start: Arc::new(Mutex::new(None)),
        };
        let mut trace = vec![snapshot(&native.doc, &native.state)];
        for action in actions.as_array().expect("action list") {
            let id = action.get("id").and_then(Value::as_str).unwrap_or("editor");
            let target = native
                .doc
                .query_selector(&format!("#{id}"))
                .unwrap()
                .expect("target");
            match action["kind"].as_str().expect("action kind") {
                "focus" => {
                    if native
                        .doc
                        .get_node(target)
                        .unwrap()
                        .attr("disabled".into())
                        .is_none()
                    {
                        native.doc.set_focus_to(target);
                    }
                }
                "blur" => native.doc.clear_focus(),
                "select" => {
                    let text = controls::value(&native.doc, target).expect("text input");
                    let byte = |units: usize| {
                        let mut n = 0;
                        for (index, c) in text.char_indices() {
                            if n == units {
                                return index;
                            }
                            n += c.len_utf16();
                        }
                        assert_eq!(n, units, "scalar selection boundary");
                        text.len()
                    };
                    let from = byte(action["start"].as_u64().unwrap() as usize);
                    let to = byte(action["end"].as_u64().unwrap() as usize);
                    native
                        .doc
                        .with_text_input(target, |mut d| d.select_byte_range(from, to));
                }
                "text" => {
                    let text = action["value"].as_str().unwrap();
                    native.handle_ui_event(controls::key(
                        Key::Character(text.into()),
                        Code::Unidentified,
                        Modifiers::empty(),
                        Some(text),
                    ));
                }
                "backspace" => native.handle_ui_event(controls::key(
                    Key::Backspace,
                    Code::Backspace,
                    Modifiers::empty(),
                    None,
                )),
                "delete" => native.handle_ui_event(controls::key(
                    Key::Delete,
                    Code::Delete,
                    Modifiers::empty(),
                    None,
                )),
                "click" => {
                    if native
                        .doc
                        .get_node(target)
                        .unwrap()
                        .attr("disabled".into())
                        .is_none()
                    {
                        native.doc.set_focus_to(target);
                        native.handle_ui_event(controls::key(
                            Key::Enter,
                            Code::Enter,
                            Modifiers::empty(),
                            None,
                        ));
                    }
                }
                "payload" => {
                    let value = action["value"].as_str().unwrap();
                    controls::live_value(&mut native.doc, target, value);
                    let mut driver = EventDriver::new(
                        &mut native.doc,
                        Handler {
                            state: &mut native.state,
                            snapshots: &mut native.snapshots,
                            cache: &mut native.cache,
                            space_target: &mut native.space_target,
                            input_start: &native.input_start,
                        },
                    );
                    driver.handle_dom_event(DomEvent::new(
                        target,
                        DomEventData::Input(blitz_traits::events::BlitzInputEvent {
                            value: value.to_owned(),
                        }),
                    ));
                }
                "ime-preedit" => native.handle_ui_event(UiEvent::Ime(
                    blitz_traits::events::BlitzImeEvent::Preedit(
                        action["value"].as_str().unwrap().into(),
                        None,
                    ),
                )),
                "ime-commit" => native.handle_ui_event(UiEvent::Ime(
                    blitz_traits::events::BlitzImeEvent::Commit(
                        action["value"].as_str().unwrap().into(),
                    ),
                )),
                _ => panic!("unknown edit action"),
            }
            native.doc.resolve(0.0);
            let mut shot = snapshot(&native.doc, &native.state);
            shot["action"] = action.clone();
            trace.push(shot);
        }
        save_png(&mut native.doc, 800, 600, &format!("{}.png", args[1]));
        std::fs::write(
            format!("{}.json", args[1]),
            serde_json::to_string_pretty(&trace).unwrap(),
        )
        .unwrap();
        return;
    }
    if args.first().is_some_and(|a| a == "--ui-events") {
        let state = app::initial();
        let doc = make_doc(&state, 800, 600);
        let previous = cache(&state);
        let mut native = Native {
            doc,
            state,
            snapshots: vec![],
            cache: previous,
            space_target: None,
            input_start: Arc::new(Mutex::new(None)),
        };
        let mut trace = vec![snapshot(&native.doc, &native.state)];
        for token in args[2].split(',').filter(|x| !x.is_empty()) {
            let (key, code, mods, up) = match token {
                "tab" => (Key::Tab, Code::Tab, Modifiers::empty(), false),
                "shift-tab" => (Key::Tab, Code::Tab, Modifiers::SHIFT, false),
                "enter" => (Key::Enter, Code::Enter, Modifiers::empty(), false),
                "space-down" => (
                    Key::Character(" ".into()),
                    Code::Space,
                    Modifiers::empty(),
                    false,
                ),
                "space-up" => (
                    Key::Character(" ".into()),
                    Code::Space,
                    Modifiers::empty(),
                    true,
                ),
                _ => panic!("unknown key token"),
            };
            let data = BlitzKeyEvent {
                key,
                code,
                modifiers: mods,
                location: Location::Standard,
                is_auto_repeating: false,
                is_composing: false,
                state: if up {
                    KeyState::Released
                } else {
                    KeyState::Pressed
                },
                text: None,
            };
            native.handle_ui_event(if up {
                UiEvent::KeyUp(data)
            } else {
                UiEvent::KeyDown(data)
            });
            let mut shot = snapshot(&native.doc, &native.state);
            shot["token"] = json!(token);
            trace.push(shot);
        }
        std::fs::write(&args[1], serde_json::to_string_pretty(&trace).unwrap()).unwrap();
        return;
    }
    if args.first().is_some_and(|a| a == "--headless") {
        let w = args[1].parse().unwrap();
        let h = args[2].parse().unwrap();
        let base = &args[3];
        let mut state = app::initial();
        let mut doc = make_doc(&state, w, h);
        let mut previous = cache(&state);
        let mut trace = vec![snapshot(&doc, &state)];
        if let Some(events) = args.get(4) {
            for e in events.split(',').filter(|s| !s.is_empty()) {
                let e = e.parse().unwrap();
                let clock = Instant::now();
                let changed = app::dispatch(&mut state, e);
                let writes = apply(&mut doc, &state, &changed, &mut previous);
                doc.resolve(0.0);
                let mut shot = snapshot(&doc, &state);
                shot["event"] = json!(e);
                shot["writes"] = json!(writes);
                shot["update_us"] = json!(clock.elapsed().as_secs_f64() * 1e6);
                trace.push(shot);
            }
        }
        save_png(&mut doc, w, h, &format!("{base}.png"));
        std::fs::write(
            format!("{base}.json"),
            serde_json::to_string_pretty(&trace).unwrap(),
        )
        .unwrap();
        return;
    }
    if args.first().is_some_and(|a| a == "--transitions") {
        let input = std::io::read_to_string(std::io::stdin()).unwrap();
        let cases: Value = serde_json::from_str(&input).unwrap();
        let results: Vec<Value> = cases
            .as_array()
            .unwrap()
            .iter()
            .map(|case| {
                let mut s = app::from_json(&case["from"]);
                app::dispatch_event(
                    &mut s,
                    case["event"].as_u64().unwrap() as usize,
                    case.get("payload").and_then(Value::as_str),
                )
                .expect("valid transition");
                app::json(&s)
            })
            .collect();
        println!("{}", json!(results));
        return;
    }
    if args
        .first()
        .is_some_and(|a| a == "--benchmark" || a == "--benchmark-paint")
    {
        let mut state = app::initial();
        let mut doc = make_doc(&state, 800, 600);
        let mut previous = cache(&state);
        let mut samples = vec![];
        let mut writes = 0;
        let paint = args[0] == "--benchmark-paint";
        let mut renderer = anyrender_vello_cpu::VelloCpuImageRenderer::new(800, 600);
        let mut buffer = Vec::new();
        assert!(!app::EVENTS.is_empty(), "benchmark requires events");
        for i in 0..120 {
            let clock = Instant::now();
            let clicks: Vec<_> = app::EVENTS
                .iter()
                .filter(|(_, e)| !app::is_text_event(*e))
                .map(|(_, e)| *e)
                .collect();
            let changed = app::dispatch(&mut state, clicks[i % clicks.len()]);
            writes += apply(&mut doc, &state, &changed, &mut previous);
            doc.resolve(0.0);
            if paint {
                renderer.reset();
                renderer.render_to_vec(
                    |scene| blitz_paint::paint_scene(scene, &mut doc, 1.0, 800, 600, 0, 0),
                    &mut buffer,
                );
            }
            if i >= 20 {
                samples.push(clock.elapsed().as_secs_f64() * 1e6);
            }
        }
        println!(
            "{}",
            json!({"samples_us":samples,"writes":writes,"optimized":app::OPTIMIZE,"includesPaint":paint})
        );
        return;
    }
    let w = args
        .windows(2)
        .find(|p| p[0] == "--width")
        .map(|p| p[1].parse().unwrap())
        .unwrap_or(800);
    let h = args
        .windows(2)
        .find(|p| p[0] == "--height")
        .map(|p| p[1].parse().unwrap())
        .unwrap_or(600);
    let state = app::initial();
    let doc = make_doc(&state, w, h);
    println!("NATIVE_INITIAL {}", snapshot(&doc, &state));
    let _ = std::io::stdout().flush();
    let event_loop = if args.iter().any(|a| a == "--x11") {
        use winit::platform::x11::EventLoopBuilderExtX11;
        winit::event_loop::EventLoop::builder()
            .with_x11()
            .build()
            .unwrap()
    } else {
        create_default_event_loop()
    };
    let (proxy, receiver) = BlitzShellProxy::new(event_loop.create_proxy());
    let mut app = BlitzApplication::new(proxy, receiver);
    let input_start = Arc::new(Mutex::new(None));
    let renderer = Measured {
        renderer: Cpu::new(),
        start,
        first: false,
        input_start: input_start.clone(),
    };
    let previous = cache(&state);
    app.add_window(WindowConfig::with_attributes(
        Box::new(Native {
            doc,
            state,
            snapshots: vec![],
            cache: previous,
            space_target: None,
            input_start,
        }),
        renderer,
        winit::window::WindowAttributes::default()
            .with_title(app::TITLE)
            .with_surface_size(winit::dpi::LogicalSize::new(w, h)),
    ));
    if args.iter().any(|a| a == "--resize-probe") {
        event_loop.run_app(ResizeProbe { app, step: 0 }).unwrap();
    } else {
        event_loop.run_app(app).unwrap();
    }
}
