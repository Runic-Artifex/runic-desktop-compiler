//! Conformance probe (feature `probe`): `runic-app --probe [--width W] [--height H] [--out DIR]`
//! reads an action list (JSON) on stdin, drives the headless document through
//! real Blitz UI events, and prints a trace in the browser harness's snapshot
//! format (`conformance/harness/browser.mjs`).

use crate::events::Native;
use crate::{App, controls, shell};
use anyrender::ImageRenderer;
use blitz_dom::{BaseDocument, Document};
use blitz_traits::events::{
    BlitzKeyEvent, BlitzPointerEvent, BlitzPointerId, KeyState, MouseEventButton,
    MouseEventButtons, PointerCoords, PointerDetails, UiEvent,
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
    let mut attrs: Vec<(String, String)> = el
        .attrs()
        .iter()
        .map(|a| (a.name.local.to_string(), a.value.to_string()))
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
    let disabled =
        matches!(tag.as_str(), "button" | "input") && node.attr("disabled".into()).is_some();
    if disabled {
        out.insert("disabled".into(), json!(true));
    }
    if focused == Some(id) {
        out.insert("focused".into(), json!(true));
    }
    if tag == "input" {
        let value = controls::value(doc, id)
            .or_else(|| node.attr("value".into()).map(str::to_owned))
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
            if let Some(r) = doc.get_client_bounding_rect(id) {
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
    json!({
        "dom": snapshot_node(doc, root, focused),
        "focused": focused_name,
        "viewport": {"width": width, "height": height, "scrollX": 0, "scrollY": 0},
        "geometry": geometry,
        "cells": native.app.cells_json(),
    })
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

/// Playwright key names (e.g. `Tab`, `Shift+Tab`, `Enter`, `Space`, `Backspace`).
fn parse_key(spec: &str) -> (Key, Code, Modifiers, Option<String>) {
    let mut mods = Modifiers::empty();
    let mut name = spec;
    while let Some((m, rest)) = name.split_once('+').filter(|(_, r)| !r.is_empty()) {
        mods |= match m {
            "Shift" => Modifiers::SHIFT,
            "Control" => Modifiers::CONTROL,
            "Alt" => Modifiers::ALT,
            "Meta" => Modifiers::META,
            other => panic!("unknown modifier {other}"),
        };
        name = rest;
    }
    let (key, code, text) = match name {
        "Tab" => (Key::Tab, Code::Tab, None),
        "Enter" => (Key::Enter, Code::Enter, None),
        "Space" | " " => (
            Key::Character(" ".into()),
            Code::Space,
            Some(" ".to_owned()),
        ),
        "Backspace" => (Key::Backspace, Code::Backspace, None),
        "Delete" => (Key::Delete, Code::Delete, None),
        "ArrowLeft" => (Key::ArrowLeft, Code::ArrowLeft, None),
        "ArrowRight" => (Key::ArrowRight, Code::ArrowRight, None),
        "Home" => (Key::Home, Code::Home, None),
        "End" => (Key::End, Code::End, None),
        "Escape" => (Key::Escape, Code::Escape, None),
        c if c.chars().count() == 1 => (
            Key::Character(c.into()),
            Code::Unidentified,
            Some(c.to_owned()),
        ),
        other => panic!("unsupported key {other}"),
    };
    (key, code, mods, text)
}

fn press<A: App>(native: &mut Native<A>, spec: &str) {
    let (key, code, mods, text) = parse_key(spec);
    native.handle_ui_event(UiEvent::KeyDown(key_event(
        key.clone(),
        code,
        mods,
        text.as_deref(),
        false,
    )));
    native.handle_ui_event(UiEvent::KeyUp(key_event(
        key,
        code,
        mods,
        text.as_deref(),
        true,
    )));
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

fn perform<A: App>(native: &mut Native<A>, action: &Value) {
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
    match action["kind"].as_str().expect("action kind") {
        "click" => {
            let id = target.expect("click target");
            let r = native
                .doc
                .get_client_bounding_rect(id)
                .expect("rendered click target");
            let (x, y) = ((r.x + r.width / 2.0) as f32, (r.y + r.height / 2.0) as f32);
            native.handle_ui_event(UiEvent::PointerMove(pointer(x, y, MouseEventButtons::None)));
            native.handle_ui_event(UiEvent::PointerDown(pointer(
                x,
                y,
                MouseEventButtons::Primary,
            )));
            native.handle_ui_event(UiEvent::PointerUp(pointer(x, y, MouseEventButtons::None)));
        }
        "type" => {
            if let Some(id) = target {
                native.doc.set_focus_to(id);
            }
            for c in action["text"].as_str().expect("text").chars() {
                press(native, &c.to_string());
            }
        }
        "press" => press(native, action["key"].as_str().expect("key")),
        "focus" => {
            let id = target.expect("focus target");
            if native
                .doc
                .get_node(id)
                .is_some_and(|n| n.attr("disabled".into()).is_none())
            {
                native.doc.set_focus_to(id);
            }
        }
        "blur" => native.doc.clear_focus(),
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

pub(crate) fn run<A: App>() {
    let start = Instant::now();
    let args: Vec<String> = std::env::args().skip(2).collect();
    let flag = |name: &str| args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone());
    let width = flag("--width").and_then(|v| v.parse().ok()).unwrap_or(800);
    let height = flag("--height").and_then(|v| v.parse().ok()).unwrap_or(600);
    let out = flag("--out").map(std::path::PathBuf::from);
    let actions: Value = serde_json::from_reader(std::io::stdin()).expect("action list on stdin");
    let mut native = shell::document::<A>(width, height);
    let mount_us = start.elapsed().as_secs_f64() * 1e6;
    if let Some(dir) = &out {
        std::fs::create_dir_all(dir).expect("output directory");
    }
    let mut steps = vec![];
    let mut observe = |native: &mut Native<A>, action: Value, index: usize, action_us: f64| {
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
        perform(&mut native, &action);
        native.doc.resolve(0.0);
        native.listeners.settle(&mut native.doc);
        let us = t.elapsed().as_secs_f64() * 1e6;
        observe(&mut native, action, i + 1, us);
    }
    let trace = json!({"irHash": A::IR_HASH, "mountUs": mount_us, "steps": steps});
    println!("{}", serde_json::to_string(&trace).unwrap());
}
