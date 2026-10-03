//! Rust code generation from validated Runic IR (schema 4).
//!
//! The generated module implements `runic_runtime::App`:
//! - records become structs behind `JsRef` (reference identity);
//! - each component has a cell struct and instances `I{k}` (shared, so
//!   closures keep their instance alive); its functions and handlers take the
//!   instance as `inst`;
//! - every IR function becomes `fn fN(cx: &mut Cx, [inst,] captures…, params…)`;
//! - each template scope (component root, conditional branch, list block)
//!   becomes a struct with node handles, child instances and the last written
//!   binding values; listeners are closures over their instance and locals;
//! - after a handler, dirty cells of every live instance (SameValue changes,
//!   plus deep cells after heap mutation) drive targeted DOM updates, keyed
//!   lists reuse and move their blocks, and live input values are
//!   re-synchronised with their cells (controlled-input semantics).

use runic_ir::*;
use std::collections::BTreeSet;
use std::fmt::Write as _;

pub mod builtins;
pub mod emit;
pub mod expr;
pub mod types;

use expr::{FnCtx, js_str, rust_str};
use types::{default_value, rust_type, same_expr};

pub struct Options {
    /// Skip bindings whose dependencies did not change (`--no-opt` disables).
    pub optimize: bool,
}

// ---------------------------------------------------------------------------
// Cell read sets (for dependency-guarded bindings)

/// Cells read by each function, transitively; `None` = unknown (calls through
/// function values).
fn function_reads(p: &Program) -> Vec<Option<BTreeSet<usize>>> {
    let n = p.functions.len();
    let mut direct: Vec<(BTreeSet<usize>, BTreeSet<usize>, bool)> = vec![];
    for f in &p.functions {
        let mut cells = BTreeSet::new();
        let mut calls = BTreeSet::new();
        let mut unknown = false;
        for s in &f.body {
            stmt_refs(s, &mut cells, &mut calls, &mut unknown);
        }
        direct.push((cells, calls, unknown));
    }
    let mut reads: Vec<Option<BTreeSet<usize>>> = direct
        .iter()
        .map(|(c, _, u)| if *u { None } else { Some(c.clone()) })
        .collect();
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..n {
            let Some(mut acc) = reads[i].clone() else {
                continue;
            };
            let mut unknown = false;
            for &callee in &direct[i].1 {
                match &reads[callee] {
                    Some(r) => acc.extend(r.iter().copied()),
                    None => unknown = true,
                }
            }
            let next = if unknown { None } else { Some(acc) };
            if next != reads[i] {
                reads[i] = next;
                changed = true;
            }
        }
    }
    reads
}

fn expr_refs(
    e: &Expr,
    cells: &mut BTreeSet<usize>,
    calls: &mut BTreeSet<usize>,
    unknown: &mut bool,
) {
    match e {
        Expr::Cell { cell, .. } => {
            cells.insert(*cell);
        }
        Expr::Call { function, .. } | Expr::Closure { function, .. } => {
            calls.insert(*function);
        }
        Expr::CallValue { callee, .. } if !matches!(**callee, Expr::Closure { .. }) => {
            *unknown = true
        }
        _ => {}
    }
    for c in e.children() {
        expr_refs(c, cells, calls, unknown);
    }
}

fn stmt_refs(
    s: &Stmt,
    cells: &mut BTreeSet<usize>,
    calls: &mut BTreeSet<usize>,
    unknown: &mut bool,
) {
    let mut ex = |e: &Expr| expr_refs(e, cells, calls, unknown);
    match s {
        Stmt::Set { value, .. } | Stmt::Expr { value, .. } | Stmt::Throw { value, .. } => ex(value),
        Stmt::Let { value, .. } | Stmt::Return { value, .. } => {
            if let Some(v) = value {
                ex(v)
            }
        }
        Stmt::Assign { target, value, .. } => {
            ex(value);
            match target {
                Place::Field { object, .. } => ex(object),
                Place::Index { array, index } => {
                    ex(array);
                    ex(index)
                }
                _ => {}
            }
        }
        Stmt::If {
            test,
            then,
            otherwise,
            ..
        } => {
            ex(test);
            for s in then.iter().chain(otherwise) {
                stmt_refs(s, cells, calls, unknown);
            }
        }
        Stmt::While {
            test, body, update, ..
        } => {
            ex(test);
            for s in body.iter().chain(update) {
                stmt_refs(s, cells, calls, unknown);
            }
        }
        Stmt::ForOf { iterable, body, .. } => {
            ex(iterable);
            for s in body {
                stmt_refs(s, cells, calls, unknown);
            }
        }
        Stmt::Try {
            body,
            catch,
            finally,
        } => {
            for s in body
                .iter()
                .chain(catch.iter().flat_map(|c| &c.body))
                .chain(finally.iter().flatten())
            {
                stmt_refs(s, cells, calls, unknown);
            }
        }
        Stmt::Break { .. } | Stmt::Continue { .. } => {}
    }
}

// ---------------------------------------------------------------------------
// Pass 1: plan template scopes and node keys.
//
// A scope is the node list of a component root, a conditional branch or a
// list block. Every scope belongs to one component; its expressions run in
// an instance of that component with the template locals of the scope.

enum Item<'a> {
    Text {
        key: usize,
        parts: &'a [Expr],
    },
    Element {
        key: usize,
        node: &'a Node,
        children: Vec<Item<'a>>,
    },
    If {
        key: usize,
        test: &'a Expr,
        then: usize,
        otherwise: usize,
    },
    Component {
        key: usize,
        component: usize,
        props: &'a [PropArg],
        root: usize,
        /// (slot declaration of the child, definition, body scope)
        slots: Vec<(usize, &'a SlotDef, usize)>,
    },
    Slot {
        key: usize,
        decl: usize,
        args: &'a [Expr],
        fallback: usize,
    },
    Each {
        key: usize,
        node: &'a Node,
        body: usize,
        otherwise: usize,
    },
}

struct PlanScope<'a> {
    component: usize,
    items: Vec<Item<'a>>,
}

struct Planner<'a> {
    p: &'a Program,
    scopes: Vec<Option<PlanScope<'a>>>,
    /// Root scope of each component (planned once).
    roots: Vec<Option<usize>>,
    key: usize,
}

impl<'a> Planner<'a> {
    fn new(p: &'a Program) -> Self {
        Planner {
            p,
            scopes: vec![],
            roots: vec![None; p.components.len()],
            key: 0,
        }
    }
    fn root(&mut self, component: usize) -> usize {
        if let Some(id) = self.roots[component] {
            return id;
        }
        let id = self.scopes.len();
        self.roots[component] = Some(id);
        self.scopes.push(None);
        let items = self.items(&self.p.components[component].template, component);
        self.scopes[id] = Some(PlanScope { component, items });
        id
    }
    fn scope(&mut self, nodes: &'a [Node], component: usize) -> usize {
        let id = self.scopes.len();
        self.scopes.push(None);
        let items = self.items(nodes, component);
        self.scopes[id] = Some(PlanScope { component, items });
        id
    }
    fn items(&mut self, nodes: &'a [Node], component: usize) -> Vec<Item<'a>> {
        nodes.iter().map(|n| self.item(n, component)).collect()
    }
    fn item(&mut self, n: &'a Node, component: usize) -> Item<'a> {
        self.key += 1;
        let key = self.key;
        match n {
            Node::Text { parts, .. } => Item::Text { key, parts },
            Node::Element { children, .. } => Item::Element {
                key,
                node: n,
                children: self.items(children, component),
            },
            Node::If {
                test,
                then,
                otherwise,
                ..
            } => {
                let then = self.scope(then, component);
                let otherwise = self.scope(otherwise, component);
                Item::If {
                    key,
                    test,
                    then,
                    otherwise,
                }
            }
            Node::Component {
                component: c,
                props,
                slots,
                ..
            } => {
                let defs = slots
                    .iter()
                    .map(|d| {
                        let decl = self.p.components[*c].slot(&d.name).expect("validated slot");
                        (decl, d, self.scope(&d.body, component))
                    })
                    .collect();
                Item::Component {
                    key,
                    component: *c,
                    props,
                    root: self.root(*c),
                    slots: defs,
                }
            }
            Node::Slot {
                name,
                args,
                fallback,
                ..
            } => Item::Slot {
                key,
                decl: self.p.components[component]
                    .slot(name)
                    .expect("validated slot"),
                args,
                fallback: self.scope(fallback, component),
            },
            Node::Each {
                body, otherwise, ..
            } => {
                let body = self.scope(body, component);
                let otherwise = self.scope(otherwise, component);
                Item::Each {
                    key,
                    node: n,
                    body,
                    otherwise,
                }
            }
        }
    }
}

/// Rust expression for the first mounted node among `items`, falling back to `tail`.
fn first_of(items: &[Item], tail: &str) -> String {
    let mut out = String::new();
    for item in items {
        let part = match item {
            Item::Text { key, .. } | Item::Element { key, .. } => format!("Some(s.n{key})"),
            Item::If {
                key,
                then,
                otherwise,
                ..
            } => format!(
                "s.then{key}.as_deref().and_then(first_s{then}).or_else(|| s.else{key}.as_deref().and_then(first_s{otherwise}))"
            ),
            Item::Component { key, root, .. } => format!("first_s{root}(&s.cs{key})"),
            Item::Slot { key, fallback, .. } => format!(
                "s.sl{key}.as_ref().and_then(|b| b.first()).or_else(|| s.fb{key}.as_deref().and_then(first_s{fallback}))"
            ),
            Item::Each {
                key,
                body,
                otherwise,
                ..
            } => format!(
                "s.e{key}.iter().find_map(|(_, _, b)| first_s{body}(b)).or_else(|| s.else{key}.as_deref().and_then(first_s{otherwise}))"
            ),
        };
        let is_static = matches!(item, Item::Text { .. } | Item::Element { .. });
        out = if out.is_empty() {
            part
        } else {
            format!("{out}.or_else(|| {part})")
        };
        if is_static {
            return out;
        }
    }
    if out.is_empty() {
        tail.to_owned()
    } else {
        format!("{out}.or({tail})")
    }
}

// ---------------------------------------------------------------------------
// Pass 2: emit template scopes.

struct Gen<'a> {
    p: &'a Program,
    optimize: bool,
    reads: Vec<Option<BTreeSet<usize>>>,
}

#[derive(Default)]
struct Out {
    fields: Vec<(String, String)>,
    mount: String,
    update: String,
    sync: String,
    dispose: String,
    nodes: String,
    instances: String,
    /// Type definitions emitted after the scope (slot blocks).
    extra: String,
}

/// Whether an expression reads template locals (directly or by capture).
fn reads_locals(e: &Expr) -> bool {
    matches!(e, Expr::Local { .. })
        || matches!(e, Expr::Closure { captures, .. } if !captures.is_empty())
        || e.children().iter().any(|c| reads_locals(c))
}

impl Gen<'_> {
    fn ctx(&self, component: usize) -> FnCtx<'_> {
        FnCtx::new(
            self.p,
            Some(component),
            self.p.components[component].template_locals.clone(),
            None,
            Type::Void,
        )
    }

    /// Cells an expression may read; `None` = unknown.
    fn deps(&self, exprs: &[&Expr]) -> Option<BTreeSet<usize>> {
        let mut cells = BTreeSet::new();
        let mut calls = BTreeSet::new();
        let mut unknown = false;
        for e in exprs {
            expr_refs(e, &mut cells, &mut calls, &mut unknown);
        }
        if unknown {
            return None;
        }
        for f in calls {
            cells.extend(self.reads[f].as_ref()?.iter().copied());
        }
        Some(cells)
    }

    /// The update condition of a binding: a dirty cell it reads, or changed
    /// template locals (`tl`).
    fn guard(&self, exprs: &[&Expr]) -> String {
        if !self.optimize {
            return "true".into();
        }
        let locals = exprs.iter().any(|e| reads_locals(e));
        match self.deps(exprs) {
            None => "true".into(),
            Some(d) => {
                let mut parts: Vec<String> = d.iter().map(|c| format!("d[{c}]")).collect();
                if locals {
                    parts.push("tl".into());
                }
                if parts.is_empty() {
                    "false".into()
                } else {
                    parts.join(" || ")
                }
            }
        }
    }

    fn is_static(&self, exprs: &[&Expr]) -> bool {
        self.deps(exprs).is_some_and(|d| d.is_empty()) && !exprs.iter().any(|e| reads_locals(e))
    }

    /// Bind the template locals of `component` from `t` (an `Rc<RefCell<T{k}>>`).
    fn prelude(&self, component: usize, t: &str) -> String {
        let locals = &self.p.components[component].template_locals;
        if locals.is_empty() {
            return String::new();
        }
        let mut s = format!("let tb = {t}.borrow(); ");
        for i in 0..locals.len() {
            let _ = write!(s, "let mut l{i} = tb.l{i}.clone(); ");
        }
        s.push_str("drop(tb);\n");
        s
    }

    fn scope(&self, id: usize, scope: &PlanScope) -> String {
        let k = scope.component;
        let mut o = Out::default();
        for (i, item) in scope.items.iter().enumerate() {
            self.item(k, item, &mut o, None, &scope.items[i + 1..]);
        }
        for item in &scope.items {
            self.top_nodes(item, &mut o.nodes);
        }
        let fields: String = o
            .fields
            .iter()
            .map(|(n, t)| format!("{n}: {t}, "))
            .collect();
        let inits: String = o.fields.iter().map(|(n, _)| format!("{n}, ")).collect();
        let first = first_of(&scope.items, "None");
        let prelude = self.prelude(k, "t");
        let n = self.p.components[k].cells.len();
        format!(
            "pub struct S{id} {{ {fields}}}\n\
             #[allow(unused_variables, unused_mut)]\nfn mount_s{id}(cx: &mut Cx, dom: &mut Dom, inst: &I{k}, t: &Rc<RefCell<T{k}>>, parent: NodeId, before: Option<NodeId>) -> JsResult<Box<S{id}>> {{\n{prelude}{mount}Ok(Box::new(S{id} {{ {inits}}}))\n}}\n\
             #[allow(unused_variables, unused_mut)]\nfn update_s{id}(s: &mut S{id}, cx: &mut Cx, dom: &mut Dom, inst: &I{k}, t: &Rc<RefCell<T{k}>>, tl: bool, parent: NodeId, after: Option<NodeId>) -> JsResult<()> {{\nlet d: [bool; {n}] = inst.borrow().dirty;\n{prelude}{update}Ok(())\n}}\n\
             #[allow(unused_variables, unused_mut)]\nfn sync_s{id}(s: &S{id}, cx: &mut Cx, dom: &mut Dom, inst: &I{k}, t: &Rc<RefCell<T{k}>>) -> JsResult<()> {{\n{prelude}{sync}Ok(())\n}}\n\
             #[allow(unused_variables)]\nfn dispose_s{id}(s: &S{id}, cx: &mut Cx) {{\n{dispose}}}\n\
             #[allow(unused_variables)]\nfn nodes_s{id}(s: &S{id}, out: &mut Vec<NodeId>) {{\n{nodes}}}\n\
             #[allow(unused_variables)]\nfn instances_s{id}(s: &S{id}, out: &mut Vec<runic_runtime::Json>) {{\n{instances}}}\n\
             fn first_s{id}(s: &S{id}) -> Option<NodeId> {{ {first} }}\n\
             fn remove_s{id}(s: &S{id}, cx: &mut Cx, dom: &mut Dom) {{ dispose_s{id}(s, cx); let mut ns = Vec::new(); nodes_s{id}(s, &mut ns); for n in ns {{ dom.remove(n); }} }}\n{extra}\n",
            extra = o.extra,
            mount = o.mount,
            update = o.update,
            sync = o.sync,
            dispose = o.dispose,
            nodes = o.nodes,
            instances = o.instances,
        )
    }

    /// Top-level DOM nodes of an item, in order (for moves and removal).
    fn top_nodes(&self, item: &Item, out: &mut String) {
        match item {
            Item::Text { key, .. } | Item::Element { key, .. } => {
                let _ = writeln!(out, "out.push(s.n{key});");
            }
            Item::If {
                key,
                then,
                otherwise,
                ..
            } => {
                let _ = writeln!(
                    out,
                    "if let Some(b) = &s.then{key} {{ nodes_s{then}(b, out); }}\nif let Some(b) = &s.else{key} {{ nodes_s{otherwise}(b, out); }}"
                );
            }
            Item::Component { key, root, .. } => {
                let _ = writeln!(out, "nodes_s{root}(&s.cs{key}, out);");
            }
            Item::Slot { key, fallback, .. } => {
                let _ = writeln!(
                    out,
                    "if let Some(b) = &s.sl{key} {{ b.nodes(out); }}\nif let Some(b) = &s.fb{key} {{ nodes_s{fallback}(b, out); }}"
                );
            }
            Item::Each {
                key,
                body,
                otherwise,
                ..
            } => {
                let _ = writeln!(
                    out,
                    "for (_, _, b) in &s.e{key} {{ nodes_s{body}(b, out); }}\nif let Some(b) = &s.else{key} {{ nodes_s{otherwise}(b, out); }}"
                );
            }
        }
    }

    /// DOM text of a string-typed expression.
    fn text_value(&self, k: usize, parts: &[Expr]) -> String {
        let mut cx = self.ctx(k);
        if let [only] = parts {
            return format!("{}.to_rust()", cx.expr(only));
        }
        let mut s = String::from("{ let mut s = String::new(); ");
        for part in parts {
            let _ = write!(s, "s.push_str(&{}.to_rust()); ", cx.expr(part));
        }
        s.push_str("s }");
        s
    }

    fn item(&self, k: usize, item: &Item, o: &mut Out, parent: Option<usize>, following: &[Item]) {
        let attach = |field: &str| match parent {
            Some(p) => format!("dom.append(n{p}, {field});\n"),
            None => format!("dom.insert(parent, {field}, before);\n"),
        };
        // Mount parent/before and update parent/tail anchor of dynamic items.
        let (mp, mb, up, tail) = match parent {
            Some(p) => (format!("n{p}"), "None", format!("s.n{p}"), "None"),
            None => ("parent".into(), "before", "parent".into(), "after"),
        };
        match item {
            Item::Text { key, parts } => {
                let key = *key;
                o.fields.push((format!("n{key}"), "NodeId".into()));
                let value = self.text_value(k, parts);
                let refs: Vec<&Expr> = parts.iter().collect();
                if self.is_static(&refs) {
                    let _ = writeln!(o.mount, "let n{key} = dom.text(&{value});");
                } else {
                    o.fields.push((format!("v{key}"), "String".into()));
                    let _ = writeln!(
                        o.mount,
                        "let v{key} = {value};\nlet n{key} = dom.text(&v{key});"
                    );
                    let guard = self.guard(&refs);
                    let _ = writeln!(
                        o.update,
                        "if {guard} {{ let v = {value}; if v != s.v{key} {{ dom.set_text(s.n{key}, &v); s.v{key} = v; }} }}"
                    );
                }
                o.mount.push_str(&attach(&format!("n{key}")));
            }
            Item::Element {
                key,
                node,
                children,
            } => {
                let key = *key;
                let Node::Element {
                    tag,
                    attrs,
                    props,
                    listeners,
                    reference,
                    ..
                } = node
                else {
                    unreachable!()
                };
                o.fields.push((format!("n{key}"), "NodeId".into()));
                let _ = writeln!(o.mount, "let n{key} = dom.element({});", rust_str(tag));
                if let Some(r) = reference {
                    // The ref holds the element while mounted and null afterwards.
                    o.fields.push((format!("ri{key}"), format!("I{k}")));
                    let _ = writeln!(
                        o.mount,
                        "let ri{key} = Rc::clone(inst); inst.borrow_mut().c.c{r} = Maybe::Some(js::Element(n{key}.as_u64()));"
                    );
                    let _ = writeln!(
                        o.dispose,
                        "{{ let mut st = s.ri{key}.borrow_mut(); if matches!(&st.c.c{r}, Maybe::Some(e) if e.0 == s.n{key}.as_u64()) {{ st.c.c{r} = Maybe::Null; }} }}"
                    );
                }
                for (i, a) in attrs.iter().enumerate() {
                    let mut cx = self.ctx(k);
                    let ty = cx.ty(&a.value);
                    let raw = cx.expr(&a.value);
                    let name = rust_str(&a.name);
                    // Cached form: bool, String or Option<String>.
                    let (value, rty, write): (String, &str, Box<dyn Fn(&str, &str) -> String>) =
                        match ty {
                            Type::Boolean => (
                                raw,
                                "bool",
                                Box::new(move |n: &str, v: &str| {
                                    format!("dom.set_bool_attr({n}, {name}, {v});")
                                }),
                            ),
                            Type::Maybe(_) => (
                                format!(
                                    "(match {raw} {{ Maybe::Some(x) => Some(x.to_rust()), _ => None }})"
                                ),
                                "Option<String>",
                                Box::new(move |n: &str, v: &str| {
                                    format!("dom.set_opt_attr({n}, {name}, {v}.as_deref());")
                                }),
                            ),
                            _ => (
                                format!("{raw}.to_rust()"),
                                "String",
                                Box::new(move |n: &str, v: &str| {
                                    format!("dom.set_attr({n}, {name}, &{v});")
                                }),
                            ),
                        };
                    if self.is_static(&[&a.value]) {
                        let _ = writeln!(
                            o.mount,
                            "{{ let v = {value}; {} }}",
                            write(&format!("n{key}"), "v")
                        );
                    } else {
                        let cache = format!("a{key}_{i}");
                        o.fields.push((cache.clone(), rty.into()));
                        let _ = writeln!(
                            o.mount,
                            "let {cache} = {value};\n{}",
                            write(&format!("n{key}"), &cache)
                        );
                        let guard = self.guard(&[&a.value]);
                        let _ = writeln!(
                            o.update,
                            "if {guard} {{ let v = {value}; if v != s.{cache} {{ {} s.{cache} = v; }} }}",
                            write(&format!("s.n{key}"), "v")
                        );
                    }
                }
                for p in props {
                    let v = self.ctx(k).expr(&p.value);
                    if p.name == "checked" {
                        let _ = writeln!(o.mount, "dom.set_checked(n{key}, {v});");
                        let _ =
                            writeln!(o.sync, "{{ let v = {v}; dom.set_checked(s.n{key}, v); }}");
                    } else {
                        let _ = writeln!(o.mount, "dom.set_value(n{key}, &{v}.to_rust());");
                        let _ = writeln!(
                            o.sync,
                            "{{ let v = {v}.to_rust(); dom.set_value(s.n{key}, &v); }}"
                        );
                    }
                }
                for l in listeners {
                    let ev = match l.event {
                        EventKind::Click => "Event::Click",
                        EventKind::Input => "Event::Input",
                        EventKind::Change => "Event::Change",
                        EventKind::Keydown => "Event::Keydown",
                    };
                    let mut cx = self.ctx(k);
                    let mut args = String::new();
                    let mut names = String::new();
                    for (i, a) in l.args.iter().enumerate() {
                        let _ = write!(args, "let a{i} = {}; ", cx.expr(a));
                        let _ = write!(names, ", a{i}");
                    }
                    let prelude = self.prelude(k, "t");
                    let _ = writeln!(
                        o.mount,
                        "{{ let inst = Rc::clone(inst); let t = Rc::clone(t); let key = cx.listen(Rc::new(move |cx: &mut Cx| -> JsResult<()> {{ {prelude}{args}handler_{k}_{}(cx, &inst{names}) }})); dom.listen(n{key}, {ev}, key); }}",
                        l.handler
                    );
                }
                for (i, c) in children.iter().enumerate() {
                    self.item(k, c, o, Some(key), &children[i + 1..]);
                }
                o.mount.push_str(&attach(&format!("n{key}")));
            }
            Item::If {
                key,
                test,
                then,
                otherwise,
            } => {
                let key = *key;
                let (th, el) = (*then, *otherwise);
                let test_rs = self.ctx(k).expr(test);
                o.fields.push((format!("t{key}"), "bool".into()));
                o.fields
                    .push((format!("then{key}"), format!("Option<Box<S{th}>>")));
                o.fields
                    .push((format!("else{key}"), format!("Option<Box<S{el}>>")));
                let _ = writeln!(
                    o.mount,
                    "let t{key} = {test_rs};\n\
                     let then{key} = if t{key} {{ Some(mount_s{th}(cx, dom, inst, t, {mp}, {mb})?) }} else {{ None }};\n\
                     let else{key} = if t{key} {{ None }} else {{ Some(mount_s{el}(cx, dom, inst, t, {mp}, {mb})?) }};"
                );
                let anchor = first_of(following, tail);
                let guard = self.guard(&[test]);
                let _ = writeln!(
                    o.update,
                    "{{\n\
                     let c = if {guard} {{ {test_rs} }} else {{ s.t{key} }};\n\
                     let anchor = {anchor};\n\
                     if c != s.t{key} {{\n\
                     if let Some(b) = s.then{key}.take() {{ remove_s{th}(&b, cx, dom); }}\n\
                     if let Some(b) = s.else{key}.take() {{ remove_s{el}(&b, cx, dom); }}\n\
                     if c {{ s.then{key} = Some(mount_s{th}(cx, dom, inst, t, {up}, anchor)?); }} else {{ s.else{key} = Some(mount_s{el}(cx, dom, inst, t, {up}, anchor)?); }}\n\
                     s.t{key} = c;\n\
                     }} else {{\n\
                     if let Some(b) = s.then{key}.as_mut() {{ update_s{th}(b, cx, dom, inst, t, tl, {up}, anchor)?; }}\n\
                     if let Some(b) = s.else{key}.as_mut() {{ update_s{el}(b, cx, dom, inst, t, tl, {up}, anchor)?; }}\n\
                     }}\n\
                     }}"
                );
                let _ = writeln!(
                    o.sync,
                    "if let Some(b) = &s.then{key} {{ sync_s{th}(b, cx, dom, inst, t)?; }}\nif let Some(b) = &s.else{key} {{ sync_s{el}(b, cx, dom, inst, t)?; }}"
                );
                let _ = writeln!(
                    o.dispose,
                    "if let Some(b) = &s.then{key} {{ dispose_s{th}(b, cx); }}\nif let Some(b) = &s.else{key} {{ dispose_s{el}(b, cx); }}"
                );
                let _ = writeln!(
                    o.instances,
                    "if let Some(b) = &s.then{key} {{ instances_s{th}(b, out); }}\nif let Some(b) = &s.else{key} {{ instances_s{el}(b, out); }}"
                );
            }
            Item::Component {
                key,
                component: c,
                props,
                root,
                slots,
            } => {
                let key = *key;
                let (c, root) = (*c, *root);
                let child = &self.p.components[c];
                // Slot providers: mount the parent's content in the parent instance.
                let mut providers = String::new();
                for (decl, def, body) in slots {
                    let (decl, body) = (*decl, *body);
                    let params: String = def
                        .params
                        .iter()
                        .enumerate()
                        .map(|(i, l)| format!("v.l{l} = a.a{i}.clone(); "))
                        .collect();
                    let _ = writeln!(
                        providers,
                        "{{ let inst = Rc::clone(inst); let t = Rc::clone(t); let p: P{c}_{decl} = Rc::new(move |cx: &mut Cx, dom: &mut Dom, a: A{c}_{decl}, parent: NodeId, before: Option<NodeId>| -> JsResult<Box<dyn Block<A{c}_{decl}>>> {{ let t2: Rc<RefCell<T{k}>> = Rc::new(RefCell::new({{ let mut v = t.borrow().clone(); {params}v }})); let s = mount_s{body}(cx, dom, &inst, &t2, parent, before)?; Ok(Box::new(SB{body} {{ inst: Rc::clone(&inst), outer: Rc::clone(&t), t: t2, s }})) }}); ci{key}.borrow_mut().s{decl} = Some(p); }}"
                    );
                    let _ = writeln!(
                        o.extra,
                        "pub struct SB{body} {{ inst: I{k}, outer: Rc<RefCell<T{k}>>, t: Rc<RefCell<T{k}>>, s: Box<S{body}> }}\n\
                         impl Block<A{c}_{decl}> for SB{body} {{\n\
                         fn update(&mut self, cx: &mut Cx, dom: &mut Dom, a: A{c}_{decl}, parent: NodeId, after: Option<NodeId>) -> JsResult<()> {{ {{ let mut v = self.outer.borrow().clone(); {params}*self.t.borrow_mut() = v; }} update_s{body}(&mut self.s, cx, dom, &self.inst, &self.t, true, parent, after) }}\n\
                         fn sync(&self, cx: &mut Cx, dom: &mut Dom) -> JsResult<()> {{ sync_s{body}(&self.s, cx, dom, &self.inst, &self.t) }}\n\
                         fn dispose(&self, cx: &mut Cx) {{ dispose_s{body}(&self.s, cx); }}\n\
                         fn nodes(&self, out: &mut Vec<NodeId>) {{ nodes_s{body}(&self.s, out); }}\n\
                         fn first(&self) -> Option<NodeId> {{ first_s{body}(&self.s) }}\n\
                         fn instances(&self, out: &mut Vec<runic_runtime::Json>) {{ instances_s{body}(&self.s, out); }}\n\
                         }}"
                    );
                }
                o.fields.push((format!("ci{key}"), format!("I{c}")));
                o.fields
                    .push((format!("ct{key}"), format!("Rc<RefCell<T{c}>>")));
                o.fields.push((format!("cs{key}"), format!("Box<S{root}>")));
                let mut pass = String::new();
                for a in props.iter() {
                    let cell = child.prop(&a.name).expect("validated prop");
                    let mut cx = self.ctx(k);
                    let v = cx.expr(&a.value);
                    let bind = match &a.bind {
                        Some(_) => format!("st.b{cell} = Some(b);"),
                        None => String::new(),
                    };
                    let b = match &a.bind {
                        Some(b) => format!("let b = {}; ", cx.expr(b)),
                        None => String::new(),
                    };
                    let _ = writeln!(
                        pass,
                        "{{ let v = {v}; {b}let mut st = ci{key}.borrow_mut(); st.p{cell} = Some(v.clone()); st.c.c{cell} = v; {bind} }}"
                    );
                    // Update: a changed prop sets the child's cell and dirty bit.
                    let ty = &child.cells[cell].ty;
                    let same = same_expr(ty, "(*o)", "v");
                    let guard = self.guard(&[&a.value]);
                    let _ = writeln!(
                        o.update,
                        "if {guard} {{ let v = {v}; let mut st = s.ci{key}.borrow_mut(); let changed = match &st.p{cell} {{ Some(o) => !{same}, None => true }}; if changed {{ st.p{cell} = Some(v.clone()); st.c.c{cell} = v.clone(); st.snap.c{cell} = v; st.dirty[{cell}] = true; }} }}"
                    );
                    if let Some(b) = &a.bind {
                        let guard = self.guard(&[b]);
                        let bv = self.ctx(k).expr(b);
                        let _ = writeln!(
                            o.update,
                            "if {guard} {{ let b = {bv}; s.ci{key}.borrow_mut().b{cell} = Some(b); }}"
                        );
                    }
                }
                let _ = writeln!(
                    o.mount,
                    "let ci{key} = new_i{c}(cx);\n{pass}{providers}init_i{c}(cx, &ci{key})?;\nlet ct{key}: Rc<RefCell<T{c}>> = Rc::new(RefCell::new(T{c}::default()));\nlet cs{key} = mount_s{root}(cx, dom, &ci{key}, &ct{key}, {mp}, {mb})?;"
                );
                let anchor = first_of(following, tail);
                let _ = writeln!(
                    o.update,
                    "{{ let anchor = {anchor}; update_s{root}(&mut s.cs{key}, cx, dom, &s.ci{key}, &s.ct{key}, false, {up}, anchor)?; }}"
                );
                let _ = writeln!(
                    o.sync,
                    "sync_s{root}(&s.cs{key}, cx, dom, &s.ci{key}, &s.ct{key})?;"
                );
                let _ = writeln!(
                    o.dispose,
                    "dispose_s{root}(&s.cs{key}, cx); destroy_i{c}(cx, &s.ci{key});"
                );
                let _ = writeln!(
                    o.instances,
                    "out.push(runic_runtime::Json::Object([(\"component\".to_string(), runic_runtime::Json::String({}.into())), (\"cells\".to_string(), cells_json_i{c}(&s.ci{key}))].into_iter().collect()));\ninstances_s{root}(&s.cs{key}, out);",
                    rust_str(&child.name)
                );
            }
            Item::Slot {
                key,
                decl,
                args,
                fallback,
            } => {
                let (key, decl, fb) = (*key, *decl, *fallback);
                o.fields.push((
                    format!("sl{key}"),
                    format!("Option<Box<dyn Block<A{k}_{decl}>>>"),
                ));
                o.fields
                    .push((format!("fb{key}"), format!("Option<Box<S{fb}>>")));
                let mut cx = self.ctx(k);
                let fields: String = args
                    .iter()
                    .enumerate()
                    .map(|(i, a)| format!("a{i}: {}, ", cx.expr(a)))
                    .collect();
                let make = format!("A{k}_{decl} {{ {fields}}}");
                let _ = writeln!(
                    o.mount,
                    "let p = {{ let p = inst.borrow().s{decl}.clone(); p }};\n\
                     let (sl{key}, fb{key}): (Option<Box<dyn Block<A{k}_{decl}>>>, Option<Box<S{fb}>>) = match p {{ Some(p) => {{ let a = {make}; (Some(p(cx, dom, a, {mp}, {mb})?), None) }} None => (None, Some(mount_s{fb}(cx, dom, inst, t, {mp}, {mb})?)) }};"
                );
                let anchor = first_of(following, tail);
                let _ = writeln!(
                    o.update,
                    "{{ let anchor = {anchor};\n\
                     if let Some(b) = s.sl{key}.as_mut() {{ let a = {make}; b.update(cx, dom, a, {up}, anchor)?; }}\n\
                     if let Some(b) = s.fb{key}.as_mut() {{ update_s{fb}(b, cx, dom, inst, t, tl, {up}, anchor)?; }} }}"
                );
                let _ = writeln!(
                    o.sync,
                    "if let Some(b) = &s.sl{key} {{ b.sync(cx, dom)?; }}\nif let Some(b) = &s.fb{key} {{ sync_s{fb}(b, cx, dom, inst, t)?; }}"
                );
                let _ = writeln!(
                    o.dispose,
                    "if let Some(b) = &s.sl{key} {{ b.dispose(cx); }}\nif let Some(b) = &s.fb{key} {{ dispose_s{fb}(b, cx); }}"
                );
                let _ = writeln!(
                    o.instances,
                    "if let Some(b) = &s.sl{key} {{ b.instances(out); }}\nif let Some(b) = &s.fb{key} {{ instances_s{fb}(b, out); }}"
                );
            }
            Item::Each {
                key,
                node,
                body,
                otherwise,
            } => {
                let key = *key;
                let (bd, el) = (*body, *otherwise);
                let Node::Each {
                    items,
                    item,
                    index,
                    key: list_key,
                    reorder,
                    ..
                } = node
                else {
                    unreachable!()
                };
                o.fields.push((
                    format!("e{key}"),
                    format!("Vec<(js::MapKey, Rc<RefCell<T{k}>>, Box<S{bd}>)>"),
                ));
                o.fields
                    .push((format!("else{key}"), format!("Option<Box<S{el}>>")));
                let items_rs = self.ctx(k).expr(items);
                let set_index = match index {
                    Some(x) => format!("v.l{x} = i as f64; "),
                    None => String::new(),
                };
                // The block's locals and key.
                let key_rs = match list_key {
                    Some(e) => {
                        let prelude = self.prelude(k, "t2");
                        let v = self.ctx(k).expr(e);
                        format!("{{ {prelude}let kv = {v}; js::ToMapKey::map_key(&kv) }}")
                    }
                    None => "js::ToMapKey::map_key(&(i as f64))".into(),
                };
                let block = format!(
                    "let t2: Rc<RefCell<T{k}>> = Rc::new(RefCell::new({{ let mut v = t.borrow().clone(); v.l{item} = x; {set_index}v }}));\n\
                     let bk = {key_rs};\n\
                     if !seen.insert(bk.clone()) {{ return Err(js::Throw::new(\"RunicKeyError\", \"Duplicate key in a keyed list\")); }}"
                );
                let _ = writeln!(
                    o.mount,
                    "let mut e{key}: Vec<(js::MapKey, Rc<RefCell<T{k}>>, Box<S{bd}>)> = Vec::new();\n\
                     {{ let items = {items_rs}; let values: Vec<_> = items.borrow().clone(); let mut seen = std::collections::HashSet::new();\n\
                     for (i, x) in values.into_iter().enumerate() {{\n{block}\nlet b = mount_s{bd}(cx, dom, inst, &t2, {mp}, {mb})?;\ne{key}.push((bk, t2, b));\n}} }}\n\
                     let else{key} = if e{key}.is_empty() {{ Some(mount_s{el}(cx, dom, inst, t, {mp}, {mb})?) }} else {{ None }};"
                );
                let anchor = first_of(following, tail);
                let guard = self.guard(&[items]);
                let _ = writeln!(
                    o.update,
                    "{{\n\
                     let after_list = {anchor};\n\
                     if {guard} {{\n\
                     let items = {items_rs}; let values: Vec<_> = items.borrow().clone(); let mut seen = std::collections::HashSet::new();\n\
                     let old_len = s.e{key}.len();\n\
                     let mut old: std::collections::HashMap<js::MapKey, (usize, Rc<RefCell<T{k}>>, Box<S{bd}>)> = s.e{key}.drain(..).enumerate().map(|(i, (k, t, b))| (k, (i, t, b))).collect();\n\
                     let mut next: Vec<(js::MapKey, Rc<RefCell<T{k}>>, Option<Box<S{bd}>>, Option<usize>)> = Vec::new();\n\
                     for (i, x) in values.into_iter().enumerate() {{\n{block}\n\
                     match old.remove(&bk) {{ Some((oi, ot, ob)) => {{ let v = t2.borrow().clone(); *ot.borrow_mut() = v; next.push((bk, ot, Some(ob), Some(oi))); }} None => next.push((bk, t2, None, None)) }}\n\
                     }}\n\
                     let mut gone: Vec<_> = old.into_values().collect(); gone.sort_by_key(|g| g.0);\n\
                     for (_, _, ob) in gone {{ remove_s{bd}(&ob, cx, dom); }}\n\
                     let keep = runic_runtime::reorder::keep(runic_runtime::reorder::Reorder::{reorder:?}, &next.iter().map(|e| e.3).collect::<Vec<_>>(), old_len);\n\
                     let mut anchor = after_list;\n\
                     let mut out = Vec::with_capacity(next.len());\n\
                     for (j, (bk, tt, b, _)) in next.into_iter().enumerate().rev() {{\n\
                     let b = match b {{\n\
                     Some(mut b) => {{ if !keep[j] {{ let mut ns = Vec::new(); nodes_s{bd}(&b, &mut ns); dom.insert_all({up}, &ns, anchor); }} update_s{bd}(&mut b, cx, dom, inst, &tt, true, {up}, anchor)?; b }}\n\
                     None => mount_s{bd}(cx, dom, inst, &tt, {up}, anchor)?,\n\
                     }};\n\
                     if let Some(f) = first_s{bd}(&b) {{ anchor = Some(f); }}\n\
                     out.push((bk, tt, b));\n\
                     }}\n\
                     out.reverse(); s.e{key} = out;\n\
                     }} else {{\n\
                     let mut anchor = after_list;\n\
                     for (_, tt, b) in s.e{key}.iter_mut().rev() {{ update_s{bd}(b, cx, dom, inst, tt, tl, {up}, anchor)?; if let Some(f) = first_s{bd}(b) {{ anchor = Some(f); }} }}\n\
                     }}\n\
                     if s.e{key}.is_empty() {{\n\
                     match s.else{key}.as_mut() {{ Some(b) => update_s{el}(b, cx, dom, inst, t, tl, {up}, after_list)?, None => s.else{key} = Some(mount_s{el}(cx, dom, inst, t, {up}, after_list)?) }}\n\
                     }} else if let Some(b) = s.else{key}.take() {{ remove_s{el}(&b, cx, dom); }}\n\
                     }}"
                );
                let _ = writeln!(
                    o.sync,
                    "for (_, tt, b) in &s.e{key} {{ sync_s{bd}(b, cx, dom, inst, tt)?; }}\nif let Some(b) = &s.else{key} {{ sync_s{el}(b, cx, dom, inst, t)?; }}"
                );
                let _ = writeln!(
                    o.dispose,
                    "for (_, _, b) in &s.e{key} {{ dispose_s{bd}(b, cx); }}\nif let Some(b) = &s.else{key} {{ dispose_s{el}(b, cx); }}"
                );
                let _ = writeln!(
                    o.instances,
                    "for (_, _, b) in &s.e{key} {{ instances_s{bd}(b, out); }}\nif let Some(b) = &s.else{key} {{ instances_s{el}(b, out); }}"
                );
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Records and probe output

fn records(p: &Program) -> String {
    let mut out = String::new();
    for (r, rec) in p.records.iter().enumerate() {
        let fields: String = rec
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| format!("pub f{i}: {}, ", rust_type(&f.ty)))
            .collect();
        let defaults: String = rec
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| format!("f{i}: {}, ", default_value(&f.ty, p)))
            .collect();
        let owns: String = (0..rec.fields.len())
            .map(|i| format!("self.f{i} = js::Own::own(self.f{i}.clone()); "))
            .collect();
        let _ = writeln!(
            out,
            "/// {}\n#[derive(Clone)]\npub struct R{r} {{ {fields}}}\n\
             impl Default for R{r} {{ fn default() -> Self {{ R{r} {{ {defaults}}} }} }}\n\
             impl js::HeapToString for R{r} {{ fn heap_to_string(&self) -> JsString {{ JsString::from(\"[object Object]\") }} }}\n\
             impl js::OwnFields for R{r} {{ const PROXIED: bool = true; fn own_fields(&mut self) {{ {owns}}} }}\n\
             impl std::fmt::Debug for R{r} {{ fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {{ f.write_str({}) }} }}",
            rec.name.replace('\n', " "),
            rust_str(&rec.name)
        );
        if rec.fields.iter().all(|f| builtins_json_ok(&f.ty, p)) {
            let members: String = rec
                .fields
                .iter()
                .enumerate()
                .map(|(i, f)| {
                    format!(
                        "if let Some(j) = {} {{ m.push(({}, j)); }} ",
                        builtins::to_json(&f.ty, &format!("b.f{i}"), p),
                        js_str(&f.name)
                    )
                })
                .collect();
            let reads: String = rec
                .fields
                .iter()
                .enumerate()
                .map(|(i, f)| {
                    let missing = if matches!(f.ty, Type::Maybe(_)) {
                        "Ok(Maybe::Undefined)".to_string()
                    } else {
                        format!("Err(js::Throw::syntax_error(\"JSON value does not match the expected type: expected field {}\"))", f.name.escape_default())
                    };
                    format!(
                        "f{i}: match members.iter().find(|(k, _)| k.to_rust() == {}) {{ Some((_, v)) => {{ {} }}?, None => {missing}? }}, ",
                        rust_str(&f.name),
                        builtins::from_json(&f.ty, "v", p)
                    )
                })
                .collect();
            let _ = writeln!(
                out,
                "#[allow(dead_code, unused_parens)]\nfn json_to_r{r}(v: &JsRef<R{r}>) -> js::json::Json {{ let b = v.borrow(); let mut m = Vec::new(); {members}js::json::Json::Object(m) }}\n\
                 #[allow(dead_code, unused_parens)]\nfn json_from_r{r}(j: &js::json::Json) -> JsResult<JsRef<R{r}>> {{ let js::json::Json::Object(members) = j else {{ return Err(js::Throw::syntax_error(\"JSON value does not match the expected type: expected object\")); }}; Ok(JsRef::new(R{r} {{ {reads}}})) }}"
            );
        }
        let clones: String = rec
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| {
                format!(
                    "f{i}: {}, ",
                    builtins::deep_clone(&f.ty, &format!("b.f{i}"), p)
                )
            })
            .collect();
        let probes: String = rec
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| format!("{}, ", probe_json(&f.ty, &format!("b.f{i}"))))
            .collect();
        let _ = writeln!(
            out,
            "#[allow(dead_code, unused_parens)]\nfn probe_r{r}(v: &JsRef<R{r}>) -> runic_runtime::Json {{ let b = v.borrow(); runic_runtime::Json::Array(vec![{probes}]) }}\n\
             #[allow(dead_code, unused_parens)]\nfn clone_r{r}(v: &JsRef<R{r}>) -> JsRef<R{r}> {{ let b = v.borrow(); JsRef::new(R{r} {{ {clones}}}) }}\n"
        );
    }
    out
}

fn builtins_json_ok(t: &Type, p: &Program) -> bool {
    runic_ir::builtins::json_compatible(t, &p.records, 0)
}

/// Probe JSON for a cell value (matches `runic_ir::interp::cell_json`).
fn probe_json(t: &Type, v: &str) -> String {
    match t {
        Type::Number => format!("js::json(&{v})"),
        Type::String => format!("runic_runtime::Json::String({v}.to_rust())"),
        Type::Boolean => format!("runic_runtime::Json::Bool({v})"),
        Type::Void => "runic_runtime::Json::Null".into(),
        Type::Maybe(i) => format!(
            "(match &{v} {{ Maybe::Some(x) => {}, _ => runic_runtime::Json::Null }})",
            probe_json(i, "(*x)")
        ),
        Type::Array(i) => format!(
            "runic_runtime::Json::Array({v}.borrow().iter().map(|x| {}).collect())",
            probe_json(i, "(*x)")
        ),
        Type::Record(r) => format!("probe_r{r}(&{v})"),
        Type::Map(k, x) => format!(
            "runic_runtime::Json::Array({v}.borrow().entries.values().map(|(k, x)| runic_runtime::Json::Array(vec![{}, {}])).collect())",
            probe_json(k, "(*k)"),
            probe_json(x, "(*x)")
        ),
        Type::Set(i) => format!(
            "runic_runtime::Json::Array({v}.borrow().entries.values().map(|x| {}).collect())",
            probe_json(i, "(*x)")
        ),
        Type::Fn(_) => {
            format!("{{ let _ = &{v}; runic_runtime::Json::String(\"function\".into()) }}")
        }
        // Element ids differ between the interpreter and the native app.
        Type::Element => {
            format!("{{ let _ = &{v}; runic_runtime::Json::String(\"element\".into()) }}")
        }
    }
}

/// Per-component state types and instance lifecycle functions.
fn component_state(p: &Program, k: usize, out: &mut String) {
    let c = &p.components[k];
    let n = c.cells.len();
    let fields: String = c
        .cells
        .iter()
        .enumerate()
        .map(|(i, cell)| format!("pub c{i}: {}, ", rust_type(&cell.ty)))
        .collect();
    let defaults: String = c
        .cells
        .iter()
        .enumerate()
        .map(|(i, cell)| format!("c{i}: {}, ", default_value(&cell.ty, p)))
        .collect();
    let locals: String = c
        .template_locals
        .iter()
        .enumerate()
        .map(|(i, l)| format!("pub l{i}: {}, ", rust_type(&l.ty)))
        .collect();
    let local_defaults: String = c
        .template_locals
        .iter()
        .enumerate()
        .map(|(i, l)| format!("l{i}: {}, ", default_value(&l.ty, p)))
        .collect();
    let mut props = String::new();
    let mut prop_defaults = String::new();
    for (j, d) in c.slots.iter().enumerate() {
        let fields: String = d
            .params
            .iter()
            .enumerate()
            .map(|(i, t)| format!("pub a{i}: {}, ", rust_type(t)))
            .collect();
        let _ = writeln!(
            out,
            "/// Arguments of slot {name} of {comp}.\n#[derive(Clone)]\npub struct A{k}_{j} {{ {fields}}}\n\
             pub type P{k}_{j} = Rc<dyn Fn(&mut Cx, &mut Dom, A{k}_{j}, NodeId, Option<NodeId>) -> JsResult<Box<dyn Block<A{k}_{j}>>>>;",
            name = d.name.replace('\n', " "),
            comp = c.name.replace('\n', " "),
        );
        let _ = write!(props, "pub s{j}: Option<P{k}_{j}>, ");
        let _ = write!(prop_defaults, "s{j}: None, ");
    }
    for (i, cell) in c.cells.iter().enumerate() {
        if cell.prop.is_some() {
            let t = rust_type(&cell.ty);
            let f = rust_type(&Type::Fn(FnType {
                params: vec![cell.ty.clone()],
                result: Box::new(Type::Void),
            }));
            let _ = write!(props, "pub p{i}: Option<{t}>, pub b{i}: Option<{f}>, ");
            let _ = write!(prop_defaults, "p{i}: None, b{i}: None, ");
        }
    }
    let _ = writeln!(
        out,
        "/// Cells of component {name}.\n#[derive(Clone)]\npub struct Cells{k} {{ {fields}}}\n\
         impl Default for Cells{k} {{ fn default() -> Self {{ Cells{k} {{ {defaults}}} }} }}\n\
         /// Template locals of component {name}.\n#[derive(Clone)]\npub struct T{k} {{ {locals}}}\n\
         impl Default for T{k} {{ fn default() -> Self {{ T{k} {{ {local_defaults}}} }} }}\n\
         /// An instance of {name}: current, snapshot and pre-handler cells, dirty bits and props.\n\
         pub struct St{k} {{ pub c: Cells{k}, pub snap: Cells{k}, pub before: Cells{k}, pub dirty: [bool; {n}], {props}}}\n\
         pub type I{k} = Rc<RefCell<St{k}>>;\n\
         fn new_i{k}(cx: &mut Cx) -> I{k} {{ let i = Rc::new(RefCell::new(St{k} {{ c: Cells{k}::default(), snap: Cells{k}::default(), before: Cells{k}::default(), dirty: [false; {n}], {prop_defaults}}})); cx.live{k}.push(Rc::clone(&i)); i }}\n\
         fn destroy_i{k}(cx: &mut Cx, inst: &I{k}) {{ cx.live{k}.retain(|x| !Rc::ptr_eq(x, inst)); }}",
        name = c.name.replace('\n', " "),
    );
    // Initialisation: passed props keep their value; other cells evaluate `init`.
    let mut init = String::new();
    for (i, cell) in c.cells.iter().enumerate() {
        let mut cx = FnCtx::new(p, Some(k), vec![], None, Type::Void);
        let v = cx.expr(&cell.init);
        let check = match cell.domain {
            Some(Domain::Text { max_utf16 }) => format!(
                "if !js::valid_single_line(&v.to_rust(), {max_utf16}) {{ return Err(js::Throw::new(\"RunicDomainError\", \"initial value leaves the text domain\")); }} "
            ),
            None => String::new(),
        };
        // Initial proxied state is proxied (props are passed as is).
        let own = if cell.tracking == Tracking::Proxied && cell.prop.is_none() {
            "let v = js::Own::own(v); "
        } else {
            ""
        };
        let assign = format!("{{ let v = {v}; {check}{own}inst.borrow_mut().c.c{i} = v; }}");
        if cell.prop.is_some() {
            let _ = writeln!(init, "if inst.borrow().p{i}.is_none() {assign}");
        } else {
            let _ = writeln!(init, "{assign}");
        }
    }
    let dirty: String = c
        .cells
        .iter()
        .enumerate()
        .map(|(i, cell)| {
            let same = same_expr(&cell.ty, &format!("st.before.c{i}"), &format!("st.c.c{i}"));
            match cell.tracking {
                Tracking::None => "false, ".to_string(),
                Tracking::Deep if cell.ty.is_reference() => format!("(!{same} || deep), "),
                Tracking::Proxied if cell.ty.is_reference() => format!("(!{same} || owned), "),
                _ => format!("!{same}, "),
            }
        })
        .collect();
    let cells_json: String = c
        .cells
        .iter()
        .enumerate()
        .map(|(i, cell)| format!("{}, ", probe_json(&cell.ty, &format!("st.c.c{i}"))))
        .collect();
    let _ = writeln!(
        out,
        "#[allow(unused_variables)]\nfn init_i{k}(cx: &mut Cx, inst: &I{k}) -> JsResult<()> {{\n{init}let mut st = inst.borrow_mut(); st.snap = st.c.clone(); st.before = st.c.clone();\nOk(())\n}}\n\
         fn begin_i{k}(st: &mut St{k}) {{ st.before = st.c.clone(); st.snap = st.c.clone(); }}\n\
         #[allow(unused_variables)]\nfn end_i{k}(st: &mut St{k}, deep: bool, owned: bool, optimize: bool) {{ let dirty: [bool; {n}] = [{dirty}]; st.dirty = if optimize {{ dirty }} else {{ [true; {n}] }}; st.snap = st.c.clone(); }}\n\
         #[allow(unused_variables)]\nfn cells_json_i{k}(inst: &I{k}) -> runic_runtime::Json {{ let st = inst.borrow(); runic_runtime::Json::Array(vec![{cells_json}]) }}\n"
    );
}

/// Generate `app.rs` for a validated program. `css` is the stylesheet with
/// assets replaced by `runic-asset:N` references.
pub fn generate(
    p: &Program,
    ir_hash: &str,
    css: &str,
    asset_mimes: &[String],
    options: &Options,
) -> Result<String> {
    let reads = function_reads(p);
    let g = Gen {
        p,
        optimize: options.optimize,
        reads,
    };
    let mut planner = Planner::new(p);
    let root = planner.root(p.root);
    let ri = p.root;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "// Generated by runic-codegen from Runic IR schema {SCHEMA} ({ir_hash}). Do not edit.\n\
         #![allow(unused_parens, unused_variables, unused_mut, unused_assignments, unused_braces, dead_code, unused_imports, unused_labels, unreachable_code, clippy::all)]\n\
         use runic_runtime::{{js, Dom, Event, NodeId}};\n\
         use runic_runtime::js::{{JsArray, JsMap, JsRef, JsResult, JsSet, JsString, Maybe}};\n\
         use std::cell::RefCell;\n\
         use std::rc::Rc;\n\
         #[allow(unused_macros)]\n\
         macro_rules! tri {{ ($e:expr, $l:lifetime) => {{ match $e {{ Ok(v) => v, Err(e) => break $l Err(e) }} }}; }}\n"
    );
    out.push_str(&records(p));
    out.push_str(
        "/// Parent-owned slot content mounted inside a child.\n\
         pub trait Block<A> {\n\
         fn update(&mut self, cx: &mut Cx, dom: &mut Dom, args: A, parent: NodeId, after: Option<NodeId>) -> JsResult<()>;\n\
         fn sync(&self, cx: &mut Cx, dom: &mut Dom) -> JsResult<()>;\n\
         fn dispose(&self, cx: &mut Cx);\n\
         fn nodes(&self, out: &mut Vec<NodeId>);\n\
         fn first(&self) -> Option<NodeId>;\n\
         fn instances(&self, out: &mut Vec<runic_runtime::Json>);\n\
         }\n",
    );
    for k in 0..p.components.len() {
        component_state(p, k, &mut out);
    }
    // The context: event payload, listener closures and live instances.
    let live: String = (0..p.components.len())
        .map(|k| format!("pub live{k}: Vec<I{k}>, "))
        .collect();
    let live_init: String = (0..p.components.len())
        .map(|k| format!("live{k}: Vec::new(), "))
        .collect();
    let globals: String = p
        .globals
        .iter()
        .enumerate()
        .map(|(i, g)| format!("pub g{i}: {}, ", rust_type(&g.ty)))
        .collect();
    let globals_init: String = p
        .globals
        .iter()
        .enumerate()
        .map(|(i, g)| format!("g{i}: {}, ", default_value(&g.ty, p)))
        .collect();
    let mut init_globals = String::new();
    for (i, g) in p.globals.iter().enumerate() {
        let mut cx = FnCtx::new(p, None, vec![], None, Type::Void);
        let v = cx.expr(&g.init);
        let _ = writeln!(init_globals, "{{ let v = {v}; cx.g{i} = v; }}");
    }
    let _ = writeln!(
        out,
        "pub type Lst = Rc<dyn Fn(&mut Cx) -> JsResult<()>>;\n\
         /// A timer callback (`setTimeout`/`setInterval`, or an animation frame receiving the time).\n\
         #[derive(Clone)]\npub enum TimerCb {{ Plain(Rc<dyn Fn(&mut Cx) -> JsResult<()>>), Frame(Rc<dyn Fn(&mut Cx, f64) -> JsResult<()>>) }}\n\
         pub struct Cx {{ pub payload: Option<JsString>, pub listeners: Vec<Option<Lst>>, pub free: Vec<u32>, pub focus: Option<(u64, bool)>, pub timers: runic_runtime::Timers<TimerCb>, {live}{globals}}}\n\
         impl Cx {{\n\
         fn new() -> Self {{ Cx {{ payload: None, listeners: Vec::new(), free: Vec::new(), focus: None, timers: runic_runtime::Timers::new(runic_runtime::clock_origin()), {live_init}{globals_init}}} }}\n\
         fn listen(&mut self, f: Lst) -> u32 {{ match self.free.pop() {{ Some(k) => {{ self.listeners[k as usize] = Some(f); k }} None => {{ self.listeners.push(Some(f)); (self.listeners.len() - 1) as u32 }} }} }}\n\
         }}\n"
    );
    // Functions.
    let mut errors = vec![];
    for f in 0..p.functions.len() {
        out.push_str(&expr::function(p, f, &mut errors));
    }
    // Handlers.
    for (k, c) in p.components.iter().enumerate() {
        for (h, handler) in c.handlers.iter().enumerate() {
            let all: Vec<Local> = handler
                .params
                .iter()
                .chain(&handler.locals)
                .cloned()
                .collect();
            let mut cx = FnCtx::new(p, Some(k), all.clone(), handler.event.payload(), Type::Void);
            let body = cx.block(&handler.body);
            errors.extend(
                cx.errors
                    .iter()
                    .map(|e| format!("{} handler {h}: {e}", c.name)),
            );
            let np = handler.params.len();
            let mut sig = String::new();
            let mut locals = String::new();
            for (i, l) in all.iter().enumerate() {
                let t = rust_type(&l.ty);
                if i < np {
                    if l.boxed {
                        let _ = write!(sig, ", p{i}: {t}");
                        let _ = writeln!(
                            locals,
                            "let mut l{i}: Rc<RefCell<{t}>> = Rc::new(RefCell::new(p{i}));"
                        );
                    } else {
                        let _ = write!(sig, ", mut l{i}: {t}");
                    }
                } else if l.boxed {
                    let _ = writeln!(
                        locals,
                        "let mut l{i}: Rc<RefCell<{t}>> = Rc::new(RefCell::new({}));",
                        default_value(&l.ty, p)
                    );
                } else {
                    let _ = writeln!(locals, "let mut l{i}: {t} = {};", default_value(&l.ty, p));
                }
            }
            let _ = writeln!(
                out,
                "#[allow(unused_mut, unused_variables, unused_assignments, unreachable_code, unused_labels)]\nfn handler_{k}_{h}(cx: &mut Cx, inst: &I{k}{sig}) -> JsResult<()> {{\n{locals}{body}Ok(())\n}}\n"
            );
        }
    }
    if !errors.is_empty() {
        return Err(Diagnostic::new("E_CODEGEN", errors.join("; "), None));
    }
    // Scopes.
    for (id, scope) in planner.scopes.iter().enumerate() {
        out.push_str(&g.scope(id, scope.as_ref().expect("planned scope")));
    }
    let each_live = |f: &str| -> String {
        (0..p.components.len())
            .map(|k| {
                format!(
                    "for i in &self.cx.live{k} {{ {} }}\n",
                    f.replace("{k}", &k.to_string())
                )
            })
            .collect()
    };
    let begin = each_live("begin_i{k}(&mut i.borrow_mut());");
    let rollback = each_live("let mut st = i.borrow_mut(); st.c = st.before.clone();");
    let end = each_live(&format!(
        "end_i{{k}}(&mut i.borrow_mut(), deep, owned, {});",
        options.optimize
    ));
    let container: String = p
        .container_attrs
        .iter()
        .map(|(k, v)| format!("dom.set_attr(parent, {}, {});\n", rust_str(k), rust_str(v)))
        .collect();
    let assets: String = asset_mimes
        .iter()
        .enumerate()
        .map(|(i, mime)| format!("({}, include_bytes!(\"../assets/{i}\")), ", rust_str(mime)))
        .collect();
    let _ = writeln!(
        out,
        "pub struct App {{ cx: Cx, inst: I{ri}, t: Rc<RefCell<T{ri}>>, root: Option<(NodeId, Box<S{root}>)> }}\n\
         impl App {{\n\
         fn free(&mut self, dom: &mut Dom) {{ for k in dom.take_freed() {{ self.cx.listeners[k as usize] = None; self.cx.free.push(k); }} }}\n\
         /// Run a task (a handler or a timer callback), then update the DOM.\n\
         fn task(&mut self, dom: &mut Dom, f: impl FnOnce(&mut Cx) -> JsResult<()>) -> JsResult<()> {{\n\
         {begin}\
         let epoch = js::mutation_epoch();\n\
         let owned_epoch = js::owned_epoch();\n\
         let result = f(&mut self.cx);\n\
         self.cx.payload = None;\n\
         if let Err(e) = &result {{ if e.name.to_rust() == \"RunicDomainError\" {{ {rollback} }} }}\n\
         let deep = js::mutation_epoch() != epoch;\n\
         let owned = js::owned_epoch() != owned_epoch;\n\
         {end}\
         if let Some((parent, s)) = self.root.as_mut() {{\n\
         if let Err(e) = update_s{root}(s, &mut self.cx, dom, &self.inst, &self.t, false, *parent, None) {{ eprintln!(\"runic: render error: {{e}}\"); }}\n\
         if let Err(e) = sync_s{root}(s, &mut self.cx, dom, &self.inst, &self.t) {{ eprintln!(\"runic: render error: {{e}}\"); }}\n}}\n\
         {restore}\
         if let Some((node, on)) = self.cx.focus.take() {{ dom.focus_element(NodeId::from_u64(node), on); }}\n\
         self.free(dom);\n\
         result\n}}\n\
         }}\n\
         impl runic_runtime::App for App {{\n\
         const TITLE: &'static str = {title};\n\
         const CSS: &'static str = {css};\n\
         const ASSETS: &'static [(&'static str, &'static [u8])] = &[{assets}];\n\
         const IR_HASH: &'static str = {hash};\n\
         fn new() -> Self {{\nlet mut cx = Cx::new();\n(|| -> JsResult<()> {{ let cx = &mut cx; {init_globals}Ok(()) }})().expect(\"module constants\");\nlet inst = new_i{ri}(&mut cx);\ninit_i{ri}(&mut cx, &inst).expect(\"initial state\");\nApp {{ cx, inst, t: Rc::new(RefCell::new(T{ri}::default())), root: None }}\n}}\n\
         fn mount(&mut self, dom: &mut Dom, parent: NodeId) {{\n\
         {container}match mount_s{root}(&mut self.cx, dom, &self.inst, &self.t, parent, None) {{\n\
         Ok(s) => self.root = Some((parent, s)),\n\
         Err(e) => eprintln!(\"runic: render error: {{e}}\"),\n}}\n\
         self.free(dom);\n}}\n\
         fn dispatch(&mut self, dom: &mut Dom, listener: u32, payload: Option<&str>) -> Result<(), String> {{\n\
         let Some(l) = self.cx.listeners.get(listener as usize).cloned().flatten() else {{ return Ok(()); }};\n\
         self.cx.payload = payload.map(JsString::from);\n\
         self.task(dom, |cx| l(cx)).map_err(|e| e.to_string())\n}}\n\
         fn advance(&mut self, dom: &mut Dom, to: f64) {{\n\
         while let Some((_, cb)) = self.cx.timers.take_due(to) {{\n\
         self.cx.timers.during_tick = true;\n\
         let result = self.task(dom, |cx| match cb {{ TimerCb::Plain(f) => f(cx), TimerCb::Frame(f) => {{ let t = cx.timers.now; f(cx, t) }} }});\n\
         self.cx.timers.during_tick = false;\n\
         if let Err(e) = result {{ eprintln!(\"runic: uncaught exception in a timer: {{e}}\"); }}\n\
         }}\n\
         if self.cx.timers.now < to {{ self.cx.timers.now = to; }}\n\
         }}\n\
         fn next_timer(&self) -> Option<f64> {{ self.cx.timers.next_due() }}\n\
         fn now(&self) -> f64 {{ self.cx.timers.now }}\n\
         fn cells_json(&self) -> runic_runtime::Json {{ cells_json_i{ri}(&self.inst) }}\n\
         fn instances_json(&self) -> Vec<runic_runtime::Json> {{ let mut out = Vec::new(); if let Some((_, s)) = &self.root {{ instances_s{root}(s, &mut out); }} out }}\n\
         }}",
        title = rust_str(&p.meta.title),
        css = rust_str(css),
        hash = rust_str(ir_hash),
        restore = if p.restore_focus {
            "dom.restore_focus();\n"
        } else {
            ""
        },
    );
    Ok(out)
}
