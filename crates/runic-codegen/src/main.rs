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
use runic_ir::interp::Machine;
use runic_ir::{Diagnostic, EventKind, Node};
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
            } => 1 + count(then) + count(otherwise),
        })
        .sum()
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let (Some(command), Some(file)) = (args.first(), args.get(1)) else {
        eprintln!("usage: runic-codegen check|migrate|emit|interp <ir.json> ...");
        std::process::exit(2);
    };
    let text = std::fs::read_to_string(file)
        .unwrap_or_else(|e| fail(Diagnostic::new("E_INPUT", e.to_string(), None)));
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
            let mut m = Machine::new(&program).unwrap_or_else(|d| fail(d));
            let mut steps = vec![json!({"action": null, "state": m.snapshot()})];
            for action in actions.as_array().cloned().unwrap_or_default() {
                let id = action["id"].as_str().unwrap_or_default();
                let result = match action["kind"].as_str() {
                    Some("click") => m.fire(id, EventKind::Click, None),
                    Some("input") => m.fire(id, EventKind::Input, action["value"].as_str()),
                    other => fail(Diagnostic::new(
                        "E_INPUT",
                        format!("unknown action {other:?}"),
                        None,
                    )),
                };
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
