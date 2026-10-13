//! Reactive heap objects (docs/design/REACTIVITY-ALIASING.md, R1/R2): the
//! static types whose values may be proxies of Svelte deep state or Vue
//! reactive objects. Their slots are signals wherever the value is held (a
//! constant, a context, a class field, a collection, a closure), so a reader
//! that may read a slot of such a value depends on writes through it.

use crate::{Program, Reactive, Tracking, Type};
use std::collections::HashSet;

/// The heap types of a program whose values may carry signals of their own.
#[derive(Clone, Debug, Default)]
pub struct ReactiveHeap {
    types: HashSet<Type>,
}

impl ReactiveHeap {
    pub fn of(p: &Program) -> Self {
        let mut h = ReactiveHeap::default();
        for c in &p.components {
            for cell in &c.cells {
                match cell.tracking {
                    Tracking::Proxied => h.proxied(p, &cell.ty),
                    Tracking::Deep => h.deep(p, &cell.ty),
                    _ => {}
                }
            }
        }
        // `$state` class fields (and module state, a one-field class) hold
        // proxies as proxied cells do.
        for r in &p.records {
            for f in &r.fields {
                if f.reactive == Some(Reactive::State) {
                    h.proxied(p, &f.ty);
                }
            }
        }
        h
    }

    /// Svelte proxies plain objects and arrays, and the plain objects and
    /// arrays they hold; class instances, maps, sets and promises stay raw
    /// (with what they hold).
    fn proxied(&mut self, p: &Program, t: &Type) {
        match t {
            Type::Maybe(inner) => self.proxied(p, inner),
            Type::Union(ms) => {
                for m in ms {
                    self.proxied(p, m);
                }
            }
            Type::Array(e) => {
                if self.types.insert(t.clone()) {
                    self.proxied(p, e);
                }
            }
            Type::Record(r) if !p.records[*r].class => {
                if self.types.insert(t.clone()) {
                    for f in &p.records[*r].fields {
                        self.proxied(p, &f.ty);
                    }
                }
            }
            _ => {}
        }
    }

    /// Vue makes everything a deep ref holds reactive (class instances,
    /// maps and sets included).
    fn deep(&mut self, p: &Program, t: &Type) {
        match t {
            Type::Maybe(inner) => self.deep(p, inner),
            Type::Union(ms) => {
                for m in ms {
                    self.deep(p, m);
                }
            }
            Type::Class(_) | Type::Classes(_) => {
                for r in p.class_members(t).unwrap_or_default() {
                    self.deep(p, &Type::Record(r));
                }
            }
            Type::Array(e) | Type::Set(e) => {
                if self.types.insert(t.clone()) {
                    self.deep(p, e);
                }
            }
            Type::Map(k, v) => {
                if self.types.insert(t.clone()) {
                    self.deep(p, k);
                    self.deep(p, v);
                }
            }
            Type::Record(r) => {
                if self.types.insert(t.clone()) {
                    for f in &p.records[*r].fields {
                        self.deep(p, &f.ty);
                    }
                }
            }
            _ => {}
        }
    }

    /// Whether the program has reactive heap objects at all.
    pub fn is_empty(&self) -> bool {
        self.types.is_empty()
    }

    /// Whether a value of type `t` may itself be a reactive heap object: a
    /// read of one of its slots (a field, an element, the length) may read
    /// a signal.
    pub fn is(&self, p: &Program, t: &Type) -> bool {
        match t {
            Type::Maybe(inner) => self.is(p, inner),
            Type::Union(ms) => ms.iter().any(|m| self.is(p, m)),
            Type::Class(_) | Type::Classes(_) => p
                .class_members(t)
                .unwrap_or_default()
                .into_iter()
                .any(|r| self.types.contains(&Type::Record(r))),
            _ => self.types.contains(t),
        }
    }

    /// Whether a value of type `t` may hold a reactive heap object at any
    /// depth (a built-in given it may read through one). Dynamic values may
    /// box any value.
    pub fn reachable(&self, p: &Program, t: &Type) -> bool {
        !self.is_empty() && self.reach(p, t, &mut HashSet::new())
    }

    fn reach(&self, p: &Program, t: &Type, seen: &mut HashSet<usize>) -> bool {
        if self.is(p, t) {
            return true;
        }
        match t {
            // Dynamic values may box any value.
            Type::Dyn => true,
            // Attribute bags hold values; the built-ins that read inside
            // the records a bag holds are those of style objects (records
            // of strings), which they merge and print.
            Type::Attrs => self.types.iter().any(|t| {
                matches!(t, Type::Record(r) if p.records[*r].fields.iter().all(|f| {
                    matches!(&f.ty, Type::String)
                        || matches!(&f.ty, Type::Maybe(s) if **s == Type::String)
                }))
            }),
            Type::Maybe(inner) | Type::Array(inner) | Type::Set(inner) | Type::Promise(inner) => {
                self.reach(p, inner, seen)
            }
            Type::Map(k, v) => self.reach(p, k, seen) || self.reach(p, v, seen),
            Type::Union(ms) => ms.iter().any(|m| self.reach(p, m, seen)),
            Type::Class(_) | Type::Classes(_) => p
                .class_members(t)
                .unwrap_or_default()
                .into_iter()
                .any(|r| self.reach(p, &Type::Record(r), seen)),
            Type::Record(r) => {
                seen.insert(*r)
                    && p.records[*r]
                        .fields
                        .iter()
                        .any(|f| self.reach(p, &f.ty, seen))
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::validate::validate;
    use serde_json::{Value as Json, json};

    fn state() -> Json {
        json!({"op": "cell", "cell": 0, "read": "current"})
    }

    /// One component: `state` (cell 0, proxied) holding a plain `Tone`
    /// record (with an array of `Tone`s and a map to `Tone`s) that a click
    /// handler mutates in place, and `alias` (cell 1, identity) initialised
    /// with `init`, whose field the template reads; record 1 is a class
    /// holding a `Tone` in a plain field.
    fn program(init: Json) -> crate::Program {
        let map = json!({"map": ["string", {"record": 0}]});
        serde_json::from_value(json!({
            "schema": crate::SCHEMA,
            "meta": {"title": "aliases", "sourceHash": "0".repeat(64), "frontend": {}},
            "capabilities": ["dom"],
            "styles": {"css": ""},
            "records": [
                {"name": "Tone", "fields": [
                    {"name": "count", "type": "number"},
                    {"name": "more", "type": {"array": {"record": 0}}},
                    {"name": "named", "type": map}
                ]},
                {"name": "Holder", "class": true, "fields": [{"name": "tone", "type": {"record": 0}}]}
            ],
            "components": [{
                "name": "App",
                "cells": [
                    {"name": "state", "type": {"record": 0}, "tracking": "proxied",
                     "init": {"op": "record", "record": 0, "fields": [
                        {"op": "lit", "value": 0},
                        {"op": "array", "type": {"array": {"record": 0}}, "items": []},
                        {"op": "builtin", "name": "Map.new", "args": [], "type": map}
                     ]}},
                    {"name": "alias", "type": {"record": 0}, "tracking": "identity", "init": init}
                ],
                "handlers": [{"event": "click", "body": [{"op": "assign",
                    "target": {"place": "field", "object": state(), "field": 0},
                    "value": {"op": "add", "left": {"op": "get", "object": state(), "field": 0},
                              "right": {"op": "lit", "value": 1}}}]}],
                "template": [{"kind": "element", "tag": "button",
                    "listeners": [{"event": "click", "handler": 0}],
                    "children": [{"kind": "text", "parts": [{"op": "to-string", "arg": {"op": "get",
                        "object": {"op": "cell", "cell": 1, "read": "current"}, "field": 0}}]}]}]
            }],
            "root": 0
        }))
        .unwrap()
    }

    #[test]
    fn constants_holding_deep_state_are_read_through_it() {
        // `const alias = state` (or a context's or a function's value): the
        // template's reads through the proxy are dependencies wherever it is
        // held (R1/R2), so the program is accepted.
        let p = program(state());
        validate(&p).unwrap();
        let heap = ReactiveHeap::of(&p);
        let tone = Type::Record(0);
        assert!(heap.is(&p, &tone));
        assert!(heap.is(&p, &Type::Array(Box::new(tone.clone()))));
        assert!(heap.is(&p, &Type::Maybe(Box::new(tone.clone()))));
        // Maps, class instances and strings are not proxies; the first two
        // may hold one.
        let map = Type::Map(Box::new(Type::String), Box::new(tone.clone()));
        assert!(!heap.is(&p, &map) && heap.reachable(&p, &map));
        assert!(!heap.is(&p, &Type::Record(1)) && heap.reachable(&p, &Type::Record(1)));
        assert!(!heap.is(&p, &Type::String) && !heap.reachable(&p, &Type::String));
    }
}
