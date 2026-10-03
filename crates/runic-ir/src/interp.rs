//! Reference interpreter: the executable definition of schema 4 semantics.
//!
//! It renders a program to an abstract DOM and fires events at elements by
//! their `id`, applying the same DOM rules as the native runtime (disabled
//! elements ignore activation; read-only inputs ignore edits). Generated code
//! and the original frameworks are compared against it.

use crate::*;
use serde_json::{Map, Value as Json, json};
use std::collections::BTreeMap;

pub struct Machine<'p> {
    pub program: &'p Program,
    component: &'p Component,
    pub cells: Vec<Value>,
}

struct Env<'a> {
    current: &'a [Value],
    snapshot: &'a [Value],
    payload: Option<&'a str>,
}

fn num(v: Value) -> f64 {
    match v {
        Value::Number(n) => n,
        _ => unreachable!("validated number"),
    }
}
fn boolean(v: Value) -> bool {
    match v {
        Value::Boolean(b) => b,
        _ => unreachable!("validated boolean"),
    }
}
fn string(v: Value) -> String {
    match v {
        Value::String(s) => s,
        _ => unreachable!("validated string"),
    }
}

pub fn eval(e: &Expr, current: &[Value], snapshot: &[Value], payload: Option<&str>) -> Value {
    eval_in(
        e,
        &Env {
            current,
            snapshot,
            payload,
        },
    )
}

fn eval_in(e: &Expr, env: &Env) -> Value {
    use Expr::*;
    let ev = |x: &Expr| eval_in(x, env);
    let n = |x: &Expr| num(ev(x));
    let b = |x: &Expr| boolean(ev(x));
    match e {
        Lit { value } => value.clone(),
        Cell {
            cell,
            read: Read::Current,
        } => env.current[*cell].clone(),
        Cell {
            cell,
            read: Read::Snapshot,
        } => env.snapshot[*cell].clone(),
        Payload => Value::String(env.payload.expect("validated payload context").to_owned()),
        Not { arg } => Value::Boolean(!b(arg)),
        Neg { arg } => Value::Number(-n(arg)),
        ToString { arg } => Value::String(match ev(arg) {
            Value::Number(x) => runic_js::number_to_string(x),
            Value::Boolean(x) => runic_js::boolean_to_string(x),
            Value::String(s) => s,
        }),
        Utf16Length { arg } => Value::Number(runic_js::utf16_len(&string(ev(arg)))),
        Add { left, right } => Value::Number(n(left) + n(right)),
        Sub { left, right } => Value::Number(n(left) - n(right)),
        Mul { left, right } => Value::Number(n(left) * n(right)),
        Min { left, right } => Value::Number(runic_js::min(n(left), n(right))),
        Max { left, right } => Value::Number(runic_js::max(n(left), n(right))),
        Concat { left, right } => Value::String(string(ev(left)) + &string(ev(right))),
        Eq { left, right } => Value::Boolean(strict_equal(&ev(left), &ev(right))),
        Ne { left, right } => Value::Boolean(!strict_equal(&ev(left), &ev(right))),
        Lt { left, right } => Value::Boolean(n(left) < n(right)),
        Le { left, right } => Value::Boolean(n(left) <= n(right)),
        Gt { left, right } => Value::Boolean(n(left) > n(right)),
        Ge { left, right } => Value::Boolean(n(left) >= n(right)),
        And { left, right } => Value::Boolean(b(left) && b(right)),
        Or { left, right } => Value::Boolean(b(left) || b(right)),
        Cond {
            test,
            then,
            otherwise,
        } => {
            if b(test) {
                ev(then)
            } else {
                ev(otherwise)
            }
        }
        Mapped {
            guard,
            fast,
            reference,
            ..
        } => {
            if b(guard) {
                ev(fast)
            } else {
                ev(reference)
            }
        }
    }
}

/// JavaScript `===` on values of one type.
pub fn strict_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x == y,
        (x, y) => x == y,
    }
}

pub fn check_domain(cell: &Cell, v: &Value) -> Result<()> {
    if let (Some(Domain::Text { max_utf16 }), Value::String(s)) = (&cell.domain, v) {
        if !runic_js::valid_single_line(s, *max_utf16) {
            return Err(Diagnostic::new(
                "E_TEXT_PAYLOAD",
                format!("Value leaves the text domain of {}", cell.name),
                cell.source.as_ref(),
            ));
        }
    }
    Ok(())
}

/// Abstract DOM node, serialized in the conformance snapshot format: elements
/// as objects, text as strings (adjacent text merged, empty text removed).
#[derive(Clone, Debug, PartialEq)]
pub enum VNode {
    Element {
        tag: String,
        attrs: BTreeMap<String, String>,
        value: Option<String>,
        listeners: Vec<(EventKind, usize)>,
        children: Vec<VNode>,
    },
    Text(String),
}

impl VNode {
    pub fn to_json(&self) -> Json {
        match self {
            VNode::Text(t) => Json::String(t.clone()),
            VNode::Element {
                tag,
                attrs,
                value,
                children,
                ..
            } => {
                let mut o = Map::new();
                o.insert("tag".into(), json!(tag));
                o.insert("attrs".into(), json!(attrs));
                if let Some(v) = value {
                    o.insert("value".into(), json!(v));
                }
                o.insert(
                    "children".into(),
                    Json::Array(children.iter().map(VNode::to_json).collect()),
                );
                Json::Object(o)
            }
        }
    }
}

/// Merge adjacent text and drop empty text, as the snapshot format requires.
pub fn normalize(nodes: Vec<VNode>) -> Vec<VNode> {
    let mut out: Vec<VNode> = vec![];
    for n in nodes {
        match n {
            VNode::Text(t) if t.is_empty() => {}
            VNode::Text(t) => match out.last_mut() {
                Some(VNode::Text(prev)) => prev.push_str(&t),
                _ => out.push(VNode::Text(t)),
            },
            other => out.push(other),
        }
    }
    out
}

impl<'p> Machine<'p> {
    pub fn new(program: &'p Program) -> Result<Self> {
        let component = &program.components[program.root];
        let mut cells: Vec<Value> = vec![];
        for cell in &component.cells {
            let v = eval(&cell.init, &cells, &cells, None);
            check_domain(cell, &v)?;
            cells.push(v);
        }
        Ok(Self {
            program,
            component,
            cells,
        })
    }

    pub fn render(&self) -> Vec<VNode> {
        let mut out = vec![];
        for n in &self.component.template {
            self.render_node(n, &mut out);
        }
        normalize(out)
    }

    fn render_node(&self, n: &Node, out: &mut Vec<VNode>) {
        let ev = |e: &Expr| eval(e, &self.cells, &self.cells, None);
        match n {
            Node::Text { parts, .. } => {
                out.push(VNode::Text(parts.iter().map(|p| string(ev(p))).collect()));
            }
            Node::If {
                test,
                then,
                otherwise,
                ..
            } => {
                for c in if boolean(ev(test)) { then } else { otherwise } {
                    self.render_node(c, out);
                }
            }
            Node::Element {
                tag,
                attrs,
                props,
                listeners,
                children,
                ..
            } => {
                let mut map = BTreeMap::new();
                for a in attrs {
                    match ev(&a.value) {
                        Value::Boolean(true) => {
                            map.insert(a.name.clone(), String::new());
                        }
                        Value::Boolean(false) => {}
                        Value::String(s) => {
                            map.insert(a.name.clone(), s);
                        }
                        Value::Number(_) => unreachable!("validated attribute"),
                    }
                }
                let value = props
                    .iter()
                    .find(|p| p.name == "value")
                    .map(|p| string(ev(&p.value)));
                let mut kids = vec![];
                for c in children {
                    self.render_node(c, &mut kids);
                }
                out.push(VNode::Element {
                    tag: tag.clone(),
                    attrs: map,
                    value,
                    listeners: listeners.iter().map(|l| (l.event, l.handler)).collect(),
                    children: normalize(kids),
                });
            }
        }
    }

    pub fn snapshot(&self) -> Json {
        json!({
            "cells": self.cells.iter().map(|v| match v {
                Value::Number(n) if !n.is_finite() => json!(runic_js::number_to_string(*n)),
                other => serde_json::to_value(other).unwrap(),
            }).collect::<Vec<_>>(),
            "dom": self.render().iter().map(VNode::to_json).collect::<Vec<_>>(),
        })
    }

    /// Run handler `h` atomically. Returns the cells whose value changed.
    pub fn run(&mut self, h: usize, payload: Option<&str>) -> Result<Vec<bool>> {
        let handler = &self.component.handlers[h];
        let snapshot = self.cells.clone();
        let mut current = self.cells.clone();
        for stmt in &handler.body {
            let Stmt::Set { cell, value, .. } = stmt;
            let v = eval(value, &current, &snapshot, payload);
            check_domain(&self.component.cells[*cell], &v)?;
            current[*cell] = v;
        }
        let changed = current
            .iter()
            .zip(&snapshot)
            .map(|(a, b)| !a.same(b))
            .collect();
        self.cells = current;
        Ok(changed)
    }

    /// Fire `event` at the element with `id`. Returns `Ok(false)` when the DOM
    /// rules or a missing listener mean no handler runs.
    pub fn fire(&mut self, id: &str, event: EventKind, payload: Option<&str>) -> Result<bool> {
        let tree = self.render();
        let Some(VNode::Element {
            attrs, listeners, ..
        }) = find(&tree, id)
        else {
            return Err(Diagnostic::new(
                "E_TARGET",
                format!("No element #{id} is rendered"),
                None,
            ));
        };
        if attrs.contains_key("disabled")
            || (event == EventKind::Input && attrs.contains_key("readonly"))
        {
            return Ok(false);
        }
        let Some(&(_, h)) = listeners.iter().find(|(k, _)| *k == event) else {
            return Ok(false);
        };
        self.run(h, payload)?;
        Ok(true)
    }
}

pub fn find<'a>(nodes: &'a [VNode], id: &str) -> Option<&'a VNode> {
    nodes.iter().find_map(|n| match n {
        VNode::Element {
            attrs, children, ..
        } => {
            if attrs.get("id").map(String::as_str) == Some(id) {
                Some(n)
            } else {
                find(children, id)
            }
        }
        VNode::Text(_) => None,
    })
}
