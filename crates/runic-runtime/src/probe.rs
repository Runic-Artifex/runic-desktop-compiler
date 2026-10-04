//! Conformance probe (feature `probe`): `runic-app --probe [--width W] [--height H] [--out DIR]`
//! reads an action list (JSON) on stdin, drives the headless document through
//! real Blitz UI events, and prints a trace in the browser harness's snapshot
//! format (`conformance/harness/browser.mjs`).

use crate::events::{Native, tree_order};
use crate::{App, controls, shell};
use anyrender::ImageRenderer;
use blitz_dom::{BaseDocument, Document};
use blitz_traits::events::{
    BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, BlitzWheelDelta, BlitzWheelEvent, KeyState,
    MouseEventButton, MouseEventButtons, PointerCoords, PointerDetails, UiEvent,
};
use blitz_traits::node_id::NodeId;
use keyboard_types::{Code, Key, Location, Modifiers};
use serde_json::{Map, Value, json};
use std::time::Instant;

fn snapshot_node(doc: &BaseDocument, id: NodeId, focused: Option<NodeId>) -> Option<Value> {
    let node = doc.get_node(id)?;
    if let Some(text) = node.text_data() {
        return (!text.content.is_empty()).then(|| json!({"text": text.content}));
    }
    let el = node.element_data()?;
    let tag = el.name.local.to_string();
    let mut out = Map::new();
    out.insert("tag".into(), json!(tag));
    let checkbox = tag == "input" && el.checkbox_input_checked().is_some();
    // The live checked state is reported as a property, as in the browser.
    let mut attrs: Vec<(String, String)> = el
        .attrs()
        .iter()
        .map(|a| (a.name.local.to_string(), a.value.to_string()))
        .filter(|(k, _)| {
            !(checkbox && k == "checked") && k != crate::select::MARK && k != crate::select::SHOWN
        })
        .collect();
    attrs.sort();
    if let Some((_, v)) = attrs.iter().find(|(k, _)| k == "id") {
        out.insert("id".into(), json!(v));
    }
    if !attrs.is_empty() {
        out.insert(
            "attributes".into(),
            Value::Object(attrs.into_iter().map(|(k, v)| (k, json!(v))).collect()),
        );
    }
    let disabled = matches!(
        tag.as_str(),
        "button" | "input" | "textarea" | "select" | "option"
    ) && node.attr("disabled".into()).is_some();
    if disabled {
        out.insert("disabled".into(), json!(true));
    }
    if focused == Some(id) {
        out.insert("focused".into(), json!(true));
    }
    if checkbox {
        let value = node.attr("value".into()).unwrap_or("on");
        out.insert("value".into(), json!(value));
        out.insert(
            "checked".into(),
            json!(el.checkbox_input_checked() == Some(true)),
        );
    } else if tag == "select" {
        out.insert(
            "value".into(),
            json!(crate::select::value(doc, id).unwrap_or_default()),
        );
    } else if tag == "input" || tag == "textarea" {
        let value = controls::value(doc, id)
            .or_else(|| match tag.as_str() {
                // Before its editor exists, a text area holds its value as text.
                "textarea" => Some(node.text_content()),
                _ => node.attr("value".into()).map(str::to_owned),
            })
            .unwrap_or_default();
        out.insert("value".into(), json!(value));
        if let Some((start, end, composing)) = controls::selection(doc, id) {
            out.insert("selection".into(), json!([start, end]));
            if composing {
                out.insert("composing".into(), json!(true));
            }
        }
        if node.attr("readonly".into()).is_some() {
            out.insert("readOnly".into(), json!(true));
        }
    }
    // A text area's children are its text content (`defaultValue`); a value
    // set by script before its editor existed seeds the editor through them
    // until the next layout (see `Listeners::settle`).
    let children: Vec<Value> = node
        .children
        .iter()
        .filter_map(|&c| snapshot_node(doc, c, focused))
        .collect();
    if !children.is_empty() {
        out.insert("children".into(), Value::Array(children));
    }
    Some(Value::Object(out))
}

fn snapshot<A: App>(native: &Native<A>, width: u32, height: u32) -> Value {
    let doc = &native.doc;
    let focused = doc.get_focussed_node_id();
    let root = doc.get_element_by_id("root").expect("#root");
    let mut geometry = Map::new();
    let mut stack = vec![root];
    while let Some(id) = stack.pop() {
        let Some(node) = doc.get_node(id) else {
            continue;
        };
        if let Some(name) = node.attr("id".into()) {
            if let Some(r) = crate::layout::client_rect(doc, id) {
                geometry.insert(
                    name.to_owned(),
                    json!({"x": r.x, "y": r.y, "width": r.width, "height": r.height}),
                );
            }
        }
        stack.extend(node.children.iter().rev());
    }
    let focused_name = focused.and_then(|f| {
        let n = doc.get_node(f)?;
        let el = n.element_data()?;
        if matches!(&*el.name.local, "body" | "html") {
            return None;
        }
        Some(
            n.attr("id".into())
                .map(str::to_owned)
                .unwrap_or_else(|| el.name.local.to_string()),
        )
    });
    let mut state = json!({
        "dom": snapshot_node(doc, root, focused),
        "focused": focused_name,
        "viewport": {"width": width, "height": height, "scrollX": 0, "scrollY": 0},
        "geometry": geometry,
        "cells": native.app.cells_json(),
    });
    // The document element's attributes (sorted).
    if let Some(html) = doc.try_root_element() {
        let mut attrs: Vec<(String, String)> = html
            .attrs()
            .into_iter()
            .flatten()
            .map(|a| (a.name.local.to_string(), a.value.to_string()))
            .collect();
        attrs.sort();
        if !attrs.is_empty() {
            state["document"] =
                Value::Object(attrs.into_iter().map(|(k, v)| (k, json!(v))).collect());
        }
    }
    let instances = native.app.instances_json();
    if !instances.is_empty() {
        state["instances"] = Value::Array(instances);
    }
    // Host effects (console lines since the last snapshot, the clipboard,
    // the location and the history length), without their defaults.
    let mut host = Map::new();
    let lines: Vec<Value> = crate::console::take()
        .into_iter()
        .map(|(level, text)| json!({"level": level, "text": text_json(&text)}))
        .collect();
    if !lines.is_empty() {
        host.insert("console".into(), Value::Array(lines));
    }
    if let Some(text) = crate::clipboard::text().filter(|t| !t.is_empty()) {
        host.insert("clipboard".into(), text_json(&text));
    }
    let (href, length) = crate::history::state();
    if href != "/" {
        host.insert("href".into(), json!(href));
    }
    if length != 1 {
        host.insert("historyLength".into(), json!(length));
    }
    if !host.is_empty() {
        state["host"] = Value::Object(host);
    }
    state
}

/// A string as snapshot JSON: text, or its UTF-16 code units when it holds
/// a lone surrogate (as the browser harness and the interpreter encode it).
fn text_json(s: &runic_js::JsString) -> Value {
    match String::from_utf16(s.units()) {
        Ok(t) => json!(t),
        Err(_) => json!({ "units": s.units() }),
    }
}

fn pointer(x: f32, y: f32, buttons: MouseEventButtons) -> BlitzPointerEvent {
    BlitzPointerEvent {
        id: BlitzPointerId::Mouse,
        is_primary: true,
        coords: PointerCoords {
            page_x: x,
            page_y: y,
            screen_x: x,
            screen_y: y,
            client_x: x,
            client_y: y,
        },
        button: MouseEventButton::Main,
        buttons,
        mods: Modifiers::empty(),
        details: PointerDetails::default(),
        element: Default::default(),
        active_pointers: Default::default(),
    }
}

fn key_event(key: Key, code: Code, mods: Modifiers, text: Option<&str>, up: bool) -> BlitzKeyEvent {
    BlitzKeyEvent {
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
        text: text.map(Into::into),
    }
}

/// A key as Playwright presses it (`Tab`, `Shift+Tab`, `Enter`, `Space`, `a`):
/// the modifiers go down first and come up last, each a key of its own.
fn press<A: App>(native: &mut Native<A>, spec: &str) {
    // A character outside the US layout is typed with an unidentified code.
    let k = runic_js::parse_key_spec(spec)
        .or_else(|| {
            (spec.chars().count() == 1).then(|| runic_js::KeySpec {
                key: spec.into(),
                code: "Unidentified".into(),
                ..Default::default()
            })
        })
        .unwrap_or_else(|| panic!("unsupported key {spec}"));
    let flag = |name: &str| match name {
        "Shift" => Modifiers::SHIFT,
        "Control" => Modifiers::CONTROL,
        "Alt" => Modifiers::ALT,
        _ => Modifiers::META,
    };
    let mods: Vec<(&str, &str, Modifiers)> = k
        .modifiers
        .iter()
        .map(|&(name, code)| (name, code, flag(name)))
        .collect();
    let key_of = |name: &str| -> Key {
        if name.chars().count() == 1 {
            Key::Character(name.into())
        } else {
            name.parse().expect("named key")
        }
    };
    let mut held = Modifiers::empty();
    for &(name, code, flag) in &mods {
        held |= flag;
        let e = key_event(key_of(name), code.parse().expect("code"), held, None, false);
        native.handle_ui_event(UiEvent::KeyDown(e));
    }
    // With Control, Alt or Meta held Playwright types no text.
    let text =
        (k.key.chars().count() == 1 && !(k.ctrl || k.alt || k.meta)).then_some(k.key.as_str());
    let (key, code) = (key_of(&k.key), k.code.parse::<Code>().expect("code"));
    // A modifier pressed on its own is held during its own key down.
    let own = match k.key.as_str() {
        "Shift" | "Control" | "Alt" | "Meta" => flag(&k.key),
        _ => Modifiers::empty(),
    };
    native.handle_ui_event(UiEvent::KeyDown(key_event(
        key.clone(),
        code,
        held | own,
        text,
        false,
    )));
    native.handle_ui_event(UiEvent::KeyUp(key_event(key, code, held, text, true)));
    for &(name, code, flag) in mods.iter().rev() {
        held -= flag;
        let e = key_event(key_of(name), code.parse().expect("code"), held, None, true);
        native.handle_ui_event(UiEvent::KeyUp(e));
    }
}

fn utf16_to_byte(text: &str, units: usize) -> usize {
    let mut n = 0;
    for (i, c) in text.char_indices() {
        if n >= units {
            return i;
        }
        n += c.len_utf16();
    }
    text.len()
}

/// The n-th element (tree order, modulo their number) listening for an
/// event the action delivers (the interpreter resolves `nth` targets the
/// same way).
fn nth<A: App>(native: &Native<A>, kind: &str, n: u64) -> Option<NodeId> {
    let root = native.doc.get_element_by_id("root")?;
    let order = tree_order(&native.doc);
    let start = order.iter().position(|&x| x == root)?;
    let all: Vec<NodeId> = order[start + 1..]
        .iter()
        .copied()
        .filter(|&x| {
            // Selects are targets of `choose`, not of the other actions.
            let select = crate::select::is_select(&native.doc, x);
            if kind == "choose" {
                select
                    && (native.listeners.listens(x, "click")
                        || native.listeners.listens(x, "input"))
            } else {
                !select && native.listeners.listens(x, kind)
            }
        })
        .collect();
    (!all.is_empty()).then(|| all[(n as usize) % all.len()])
}

fn perform<A: App>(native: &mut Native<A>, action: &Value) {
    if let Some(n) = action["nth"].as_u64() {
        let kind = action["kind"].as_str().unwrap_or_default();
        let Some(target) = nth(native, kind, n) else {
            native.log.push(format!("no {kind} target"));
            return;
        };
        return perform_on(native, action, Some(target));
    }
    let target = match action["id"].as_str() {
        Some(id) => match native.doc.get_element_by_id(id) {
            Some(n) => Some(n),
            None => {
                native.log.push(format!("missing target #{id}"));
                return;
            }
        },
        None => None,
    };
    perform_on(native, action, target);
}

thread_local! {
    /// Whether pointer targets must be fully visible (browser comparisons).
    static STRICT_TARGETS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// The point a pointer action aims at: the centre of a rendered element, or
/// the action's `position` (`{x, y}` from the top-left corner of the
/// element's padding box, as Playwright places it). Playwright first scrolls
/// the target into view where it is not fully visible, which the probe does
/// not model: cases target visible elements.
fn centre<A: App>(native: &mut Native<A>, id: NodeId, action: &Value) -> (f32, f32) {
    // Checked against the browser only (`--visible-targets`): differential
    // traces compare with the interpreter, which has no layout.
    if STRICT_TARGETS.with(|s| s.get()) && !crate::layout::fully_visible(&mut native.doc, id) {
        let name = native
            .doc
            .get_node(id)
            .and_then(|n| n.attr("id".into()))
            .unwrap_or("?");
        panic!(
            "pointer target #{name} is not fully visible in its scroll containers and the viewport: \
             Playwright scrolls it into view first (DOM.scrollIntoViewIfNeeded), which the probe does not model"
        );
    }
    let r = crate::layout::client_rect(&native.doc, id).expect("rendered pointer target");
    let position = &action["position"];
    if position.is_object() {
        let border = native
            .doc
            .get_node(id)
            .expect("pointer target")
            .unrounded_layout()
            .border;
        let x = position["x"].as_f64().expect("position.x");
        let y = position["y"].as_f64().expect("position.y");
        return (
            (r.x + border.left as f64 + x) as f32,
            (r.y + border.top as f64 + y) as f32,
        );
    }
    ((r.x + r.width / 2.0) as f32, (r.y + r.height / 2.0) as f32)
}

/// A button press and release at `(x, y)` with click count `count`.
fn press_button<A: App>(
    native: &mut Native<A>,
    x: f32,
    y: f32,
    button: MouseEventButton,
    count: u32,
) {
    let pressed = match button {
        MouseEventButton::Secondary => MouseEventButtons::Secondary,
        _ => MouseEventButtons::Primary,
    };
    native.pointer.next_count = Some(count);
    let mut down = pointer(x, y, pressed);
    down.button = button;
    native.handle_ui_event(UiEvent::PointerDown(down));
    let mut up = pointer(x, y, MouseEventButtons::None);
    up.button = button;
    native.handle_ui_event(UiEvent::PointerUp(up));
}

fn perform_on<A: App>(native: &mut Native<A>, action: &Value, target: Option<NodeId>) {
    match action["kind"].as_str().expect("action kind") {
        // Pointer input at the element centre, as Playwright's click,
        // dblclick, right click (`contextmenu`), hover and wheel.
        kind @ ("click" | "dblclick" | "contextmenu") => {
            let (x, y) = centre(native, target.expect("pointer target"), action);
            native.handle_ui_event(UiEvent::PointerMove(pointer(x, y, MouseEventButtons::None)));
            if kind == "contextmenu" {
                press_button(native, x, y, MouseEventButton::Secondary, 1);
            } else {
                press_button(native, x, y, MouseEventButton::Main, 1);
                if kind == "dblclick" {
                    press_button(native, x, y, MouseEventButton::Main, 2);
                }
            }
        }
        "hover" => {
            let (x, y) = centre(native, target.expect("hover target"), action);
            native.handle_ui_event(UiEvent::PointerMove(pointer(x, y, MouseEventButtons::None)));
        }
        "wheel" => {
            let (x, y) = centre(native, target.expect("wheel target"), action);
            native.handle_ui_event(UiEvent::PointerMove(pointer(x, y, MouseEventButtons::None)));
            // Blitz's deltas point the other way from the DOM's.
            let dx = action["deltaX"].as_f64().unwrap_or(0.0);
            let dy = action["deltaY"].as_f64().unwrap_or(0.0);
            native.handle_ui_event(UiEvent::Wheel(BlitzWheelEvent {
                delta: BlitzWheelDelta::Pixels(-dx, -dy),
                coords: pointer(x, y, MouseEventButtons::None).coords,
                buttons: MouseEventButtons::None,
                mods: Modifiers::empty(),
                element: Default::default(),
            }));
        }
        "type" => {
            if let Some(id) = target {
                native.focus_to(Some(id));
            }
            for c in action["text"].as_str().expect("text").chars() {
                press(native, &c.to_string());
            }
        }
        "press" => press(native, action["key"].as_str().expect("key")),
        "choose" => {
            let id = target.expect("choose target");
            native.choose(id, action["value"].as_str().expect("value"));
        }
        // The viewport or the user preferences change (Playwright's
        // setViewportSize and emulateMedia).
        "resize" | "emulate" => {
            let mut env = crate::media_env();
            if action["kind"] == "resize" {
                env.width = action["width"].as_f64().expect("width");
                env.height = action["height"].as_f64().expect("height");
            } else {
                if let Some(c) = action["colorScheme"].as_str() {
                    env.dark = c == "dark";
                }
                if let Some(r) = action["reducedMotion"].as_str() {
                    env.reduced_motion = r == "reduce";
                }
                if let Some(c) = action["contrast"].as_str() {
                    env.contrast_more = c == "more";
                }
            }
            native.environ(env);
        }
        "wait" => {
            // Virtual time: run every timer and frame due within the wait.
            let to = native.app.now() + action["ms"].as_f64().expect("ms");
            native.advance(to);
        }
        "keydown" => {
            // A key pressed on the target (differential tests): focus, then press.
            if let Some(id) = target {
                native.focus_to(Some(id));
            }
            press(native, action["key"].as_str().expect("key"));
        }
        "focus" => {
            let id = target.expect("focus target");
            if native
                .doc
                .get_node(id)
                .is_some_and(|n| n.attr("disabled".into()).is_none())
            {
                native.focus_to(Some(id));
            }
        }
        "blur" => native.focus_to(None),
        // The user traverses the session history (browser back and forward).
        "back" => native.traverse(-1),
        "forward" => native.traverse(1),
        "input" => {
            // Semantic value change (differential tests): the control's new
            // value arrives through the normal Input event path, unless the
            // control is disabled or read-only, as with real typing.
            let id = target.expect("input target");
            let locked = native.doc.get_node(id).is_some_and(|n| {
                n.attr("disabled".into()).is_some() || n.attr("readonly".into()).is_some()
            });
            if !locked {
                let value = action["value"].as_str().expect("value").to_owned();
                controls::live_value(&mut native.doc, id, &value);
                native.dispatch_dom(blitz_traits::events::DomEvent::new(
                    id,
                    blitz_traits::events::DomEventData::Input(
                        blitz_traits::events::BlitzInputEvent { value },
                    ),
                ));
            }
        }
        "select" => {
            let id = target.expect("select target");
            let text = controls::value(&native.doc, id).expect("text control");
            let from = utf16_to_byte(&text, action["start"].as_u64().unwrap() as usize);
            let to = utf16_to_byte(&text, action["end"].as_u64().unwrap() as usize);
            native
                .doc
                .with_text_input(id, |mut d| d.select_byte_range(from, to));
        }
        other => panic!("unknown action {other}"),
    }
}

fn screenshot(doc: &mut BaseDocument, width: u32, height: u32, file: &std::path::Path) {
    let mut renderer = anyrender_vello_cpu::VelloCpuImageRenderer::new(width, height);
    let mut buffer = Vec::new();
    renderer.render_to_vec(
        |scene| {
            shell::canvas(scene, width, height);
            blitz_paint::paint_scene(scene, doc, 1.0, width, height, 0, 0);
        },
        &mut buffer,
    );
    let file = std::fs::File::create(file).expect("screenshot file");
    let mut encoder = png::Encoder::new(file, width, height);
    encoder.set_color(png::ColorType::Rgba);
    encoder.set_depth(png::BitDepth::Eight);
    encoder
        .write_header()
        .unwrap()
        .write_image_data(&buffer)
        .unwrap();
}

static ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Whether this process runs as a probe (virtual time, fixed date origin).
pub(crate) fn active() -> bool {
    ACTIVE.load(std::sync::atomic::Ordering::Relaxed)
}

pub(crate) fn run<A: App>() {
    ACTIVE.store(true, std::sync::atomic::Ordering::Relaxed);
    let start = Instant::now();
    let args: Vec<String> = std::env::args().skip(2).collect();
    let flag = |name: &str| args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone());
    let width = flag("--width").and_then(|v| v.parse().ok()).unwrap_or(800);
    let height = flag("--height").and_then(|v| v.parse().ok()).unwrap_or(600);
    let out = flag("--out").map(std::path::PathBuf::from);
    // localStorage items the case starts with (a JSON object), kept in memory.
    let storage: serde_json::Map<String, Value> = flag("--storage")
        .map(|s| serde_json::from_str(&s).expect("--storage takes a JSON object"))
        .unwrap_or_default();
    crate::storage::seed(
        storage
            .into_iter()
            .map(|(k, v)| {
                (
                    runic_js::JsString::from(k.as_str()),
                    runic_js::JsString::from(v.as_str().unwrap_or_default()),
                )
            })
            .collect(),
    );
    // The case's time zone and locale (Date and Intl); UTC and en-US by default.
    if let Some(zone) = flag("--timezone") {
        // Cases compare with Chromium: only zones verified against it.
        assert!(
            runic_js::intl::is_verified_zone(&zone),
            "--timezone {zone} is not verified against Chromium"
        );
        runic_js::env::set_time_zone(&zone).expect("--timezone takes a known IANA zone");
    }
    if let Some(locale) = flag("--locale") {
        runic_js::env::set_locale(&locale).expect("--locale takes a verified locale");
    }
    // The rest of the case's host environment (docs/design/M5-PLATFORM.md):
    // the clipboard text, the start URL and the random seed.
    crate::clipboard::seed(runic_js::JsString::from(
        flag("--clipboard").unwrap_or_default(),
    ));
    crate::history::seed(flag("--url").unwrap_or_else(|| "/".into()));
    crate::random::seed(
        flag("--seed")
            .map(|s| s.parse().expect("--seed takes an integer"))
            .unwrap_or(1),
    );
    STRICT_TARGETS.with(|s| s.set(std::env::args().any(|a| a == "--visible-targets")));
    let actions: Value = serde_json::from_reader(std::io::stdin()).expect("action list on stdin");
    let mut native = shell::document::<A>(width, height);
    let mount_us = start.elapsed().as_secs_f64() * 1e6;
    if let Some(dir) = &out {
        std::fs::create_dir_all(dir).expect("output directory");
    }
    let mut steps = vec![];
    let mut observe = |native: &mut Native<A>, action: Value, index: usize, action_us: f64| {
        // The viewport as resize actions left it.
        let (width, height) = native.doc.viewport().window_size;
        let mut step = snapshot(native, width, height);
        step["action"] = action;
        step["outcomes"] = json!(std::mem::take(&mut native.log));
        step["timing"] = json!({"actionUs": action_us});
        if let Some(dir) = &out {
            let path = dir.join(format!("step-{index:03}.png"));
            screenshot(&mut native.doc, width, height, &path);
            step["screenshotPath"] = json!(path);
        }
        steps.push(step);
    };
    observe(&mut native, Value::Null, 0, 0.0);
    for (i, action) in actions
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .enumerate()
    {
        let t = Instant::now();
        if action["kind"] == "reload" {
            // A new app instance on the same (in-memory) localStorage,
            // clipboard and session history.
            native = shell::document::<A>(width, height);
        } else {
            perform(&mut native, &action);
            // The host's work queued by the action follows it.
            native.host_tasks();
        }
        native.doc.resolve(0.0);
        native.listeners.settle(&mut native.doc);
        // Two frames after the action, as the browser harness waits for two
        // animation frames: pending scroll events in the first rendering
        // step; those of scroll positions its layout clamped in the second.
        native.frame();
        native.frame();
        let us = t.elapsed().as_secs_f64() * 1e6;
        observe(&mut native, action, i + 1, us);
    }
    let trace = json!({"irHash": A::IR_HASH, "mountUs": mount_us, "steps": steps});
    println!("{}", serde_json::to_string(&trace).unwrap());
}
