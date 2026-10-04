//! `runic-codegen`: the Rust backend command used by the Node CLI.
//!
//! ```text
//! runic-codegen check   <ir.json>
//! runic-codegen migrate <ir.json>
//! runic-codegen emit    <ir.json> <out-dir> --runtime <crate> --lock <Cargo.lock> --hash <hex> [--no-opt]
//! runic-codegen interp  <ir.json> < actions.json
//! ```
//! Diagnostics are printed as JSON on stderr with exit code 1.

use runic_codegen::{Options, emit};
use runic_ir::interp::{Env, Machine, Target};
use runic_ir::{Diagnostic, Node};
use serde_json::json;
use std::path::Path;

fn fail(d: Diagnostic) -> ! {
    eprintln!("{}", serde_json::to_string(&d).unwrap());
    std::process::exit(1);
}

fn flag(args: &[String], name: &str) -> Option<String> {
    args.windows(2).find(|w| w[0] == name).map(|w| w[1].clone())
}

fn count(nodes: &[Node]) -> usize {
    nodes
        .iter()
        .map(|n| match n {
            Node::Element { children, .. } => 1 + count(children),
            Node::Text { .. } => 1,
            Node::If {
                then, otherwise, ..
            }
            | Node::Each {
                body: then,
                otherwise,
                ..
            } => 1 + count(then) + count(otherwise),
            Node::Component { slots, .. } => {
                1 + slots.iter().map(|s| count(&s.body)).sum::<usize>()
            }
            Node::Slot { fallback, .. } => 1 + count(fallback),
        })
        .sum()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(command), Some(file)) = (args.first(), args.get(1)) else {
        eprintln!(
            "usage: runic-codegen check|migrate|emit|interp <ir.json> ... | css-check <input.json>"
        );
        std::process::exit(2);
    };
    let text = std::fs::read_to_string(file)
        .unwrap_or_else(|e| fail(Diagnostic::new("E_INPUT", e.to_string(), None)));
    // The build-time CSS oracle (runic_css::check): input
    // {"css": stylesheet, "declarations": [[name, value], ...]}; output the
    // rules and declarations Stylo drops and the declarations that do not parse.
    if command == "css-check" {
        let input: serde_json::Value = serde_json::from_str(&text)
            .unwrap_or_else(|e| fail(Diagnostic::new("E_INPUT", e.to_string(), None)));
        let css = input["css"].as_str().unwrap_or_default();
        let dropped: Vec<serde_json::Value> = runic_css::check::dropped(css)
            .into_iter()
            .map(|d| json!({"line": d.line, "column": d.column, "message": d.message}))
            .collect();
        let invalid: Vec<usize> = input["declarations"]
            .as_array()
            .map(|ds| {
                ds.iter()
                    .enumerate()
                    .filter(|(_, d)| {
                        !runic_css::check::declaration_parses(
                            d[0].as_str().unwrap_or_default(),
                            d[1].as_str().unwrap_or_default(),
                        )
                    })
                    .map(|(i, _)| i)
                    .collect()
            })
            .unwrap_or_default();
        println!("{}", json!({"dropped": dropped, "invalid": invalid}));
        return;
    }
    let program = runic_ir::load(&text).unwrap_or_else(|d| fail(d));
    match command.as_str() {
        "check" => {
            let c = &program.components[program.root];
            println!(
                "{}",
                json!({"schema": program.schema, "cells": c.cells.len(), "handlers": c.handlers.len(), "nodes": count(&c.template)})
            );
        }
        "migrate" => println!("{}", serde_json::to_string_pretty(&program).unwrap()),
        "emit" => {
            let out = args.get(2).unwrap_or_else(|| {
                fail(Diagnostic::new("E_INPUT", "missing output directory", None))
            });
            let runtime = flag(&args, "--runtime")
                .unwrap_or_else(|| fail(Diagnostic::new("E_INPUT", "missing --runtime", None)));
            let lock = flag(&args, "--lock")
                .unwrap_or_else(|| fail(Diagnostic::new("E_INPUT", "missing --lock", None)));
            let hash = flag(&args, "--hash").unwrap_or_default();
            let options = Options {
                optimize: !args.iter().any(|a| a == "--no-opt"),
            };
            emit::write_crate(
                &program,
                &hash,
                Path::new(out),
                Path::new(&runtime),
                Path::new(&lock),
                &options,
            )
            .unwrap_or_else(|d| fail(d));
        }
        "interp" => {
            let actions: serde_json::Value = serde_json::from_reader(std::io::stdin())
                .unwrap_or_else(|e| fail(Diagnostic::new("E_INPUT", e.to_string(), None)));
            // localStorage items the case starts with (a JSON object).
            let storage: serde_json::Map<String, serde_json::Value> = flag(&args, "--storage")
                .map(|s| {
                    serde_json::from_str(&s)
                        .unwrap_or_else(|e| fail(Diagnostic::new("E_INPUT", e.to_string(), None)))
                })
                .unwrap_or_default();
            let storage = storage
                .into_iter()
                .map(|(k, v)| {
                    (
                        runic_js::JsString::from(k.as_str()),
                        runic_js::JsString::from(v.as_str().unwrap_or_default()),
                    )
                })
                .collect();
            // The case's time zone and locale (Date and Intl).
            if let Some(zone) = flag(&args, "--timezone") {
                if !runic_js::intl::is_verified_zone(&zone) {
                    let m = format!("time zone {zone} is not verified against Chromium");
                    fail(Diagnostic::new("E_INPUT", m, None));
                }
                runic_js::env::set_time_zone(&zone)
                    .unwrap_or_else(|e| fail(Diagnostic::new("E_INPUT", e, None)));
            }
            if let Some(locale) = flag(&args, "--locale") {
                runic_js::env::set_locale(&locale)
                    .unwrap_or_else(|e| fail(Diagnostic::new("E_INPUT", e, None)));
            }
            // The rest of the case's host environment (docs/design/M5-PLATFORM.md).
            let url = flag(&args, "--url").unwrap_or_else(|| "/".into());
            let env = Env {
                storage,
                clipboard: runic_js::JsString::from(flag(&args, "--clipboard").unwrap_or_default()),
                session: runic_js::history::Session::new(&url)
                    .unwrap_or_else(|e| fail(Diagnostic::new("E_INPUT", e, None))),
                seed: flag(&args, "--seed")
                    .map(|s| {
                        s.parse().unwrap_or_else(|_| {
                            fail(Diagnostic::new("E_INPUT", "--seed takes an integer", None))
                        })
                    })
                    .unwrap_or(1),
            };
            let mut m = Machine::with_env(&program, env).unwrap_or_else(|d| fail(d));
            let mut steps = vec![json!({"action": null, "state": m.snapshot()})];
            for action in actions.as_array().cloned().unwrap_or_default() {
                // Targets: an element id, or the n-th element listening for the action's event.
                let kind = match action["kind"].as_str() {
                    Some(
                        k @ ("click" | "dblclick" | "contextmenu" | "hover" | "input" | "keydown"
                        | "wheel" | "choose"),
                    ) => k,
                    Some("reload") => {
                        // A new program instance on the same localStorage,
                        // clipboard and session history.
                        let env = m.reload_env();
                        m = Machine::with_env(&program, env).unwrap_or_else(|d| fail(d));
                        steps.push(
                            json!({"action": action, "outcome": "reloaded", "state": m.snapshot()}),
                        );
                        continue;
                    }
                    Some(k @ ("resize" | "emulate")) => {
                        // The viewport or the user preferences change.
                        let mut env = m.media();
                        if k == "resize" {
                            env.width = action["width"].as_f64().unwrap_or(env.width);
                            env.height = action["height"].as_f64().unwrap_or(env.height);
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
                        let outcome = match m.environ(env) {
                            Ok(true) => json!("handled"),
                            Ok(false) => json!("ignored"),
                            Err(d) => json!({"rejected": d}),
                        };
                        steps.push(
                            json!({"action": action, "outcome": outcome, "state": m.snapshot()}),
                        );
                        continue;
                    }
                    Some(k @ ("back" | "forward")) => {
                        // The user traverses the session history.
                        let outcome = match m.navigate(if k == "back" { -1 } else { 1 }) {
                            Ok(true) => json!("handled"),
                            Ok(false) => json!("ignored"),
                            Err(d) => json!({"rejected": d}),
                        };
                        steps.push(
                            json!({"action": action, "outcome": outcome, "state": m.snapshot()}),
                        );
                        continue;
                    }
                    Some("wait") => {
                        let result = m.advance(action["ms"].as_f64().unwrap_or(0.0));
                        let outcome = match result {
                            Ok(()) => json!("waited"),
                            Err(d) => json!({"rejected": d}),
                        };
                        steps.push(
                            json!({"action": action, "outcome": outcome, "state": m.snapshot()}),
                        );
                        continue;
                    }
                    other => fail(Diagnostic::new(
                        "E_INPUT",
                        format!("unknown action {other:?}"),
                        None,
                    )),
                };
                let target = match (action["id"].as_str(), action["nth"].as_u64()) {
                    (Some(id), _) => Target::Id(id),
                    (None, Some(n)) => Target::Nth(kind, n as usize),
                    _ => fail(Diagnostic::new("E_INPUT", "action without target", None)),
                };
                let wheel = format!(
                    "{},{}",
                    action["deltaX"].as_f64().unwrap_or(0.0),
                    action["deltaY"].as_f64().unwrap_or(0.0)
                );
                let data = match kind {
                    "input" | "choose" => action["value"].as_str(),
                    "keydown" => action["key"].as_str(),
                    "wheel" => Some(wheel.as_str()),
                    _ => None,
                };
                let result = m.fire(target, kind, data);
                let outcome = match result {
                    Ok(true) => json!("handled"),
                    Ok(false) => json!("ignored"),
                    Err(d) => json!({"rejected": d}),
                };
                steps.push(json!({"action": action, "outcome": outcome, "state": m.snapshot()}));
            }
            println!("{}", serde_json::to_string_pretty(&steps).unwrap());
        }
        other => fail(Diagnostic::new(
            "E_INPUT",
            format!("unknown command {other}"),
            None,
        )),
    }
}
