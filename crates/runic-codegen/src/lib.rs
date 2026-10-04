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

/// Whether `e` (typed in `component` with `locals`) reads a reactive class
/// field itself; the functions it calls are added to `calls`.
fn reactive_refs(
    p: &Program,
    component: Option<usize>,
    locals: &[Local],
    e: &Expr,
    calls: &mut BTreeSet<usize>,
) -> bool {
    let mut found = false;
    match e {
        Expr::Get { object, field } => {
            if let Some(r) = p.field_record(&runic_ir::validate::infer_in(
                p, component, locals, None, object,
            )) {
                found = p.records[r].fields[*field].reactive.is_some();
            }
        }
        Expr::Call { function, .. } => {
            calls.insert(*function);
        }
        _ => {}
    }
    for c in e.children() {
        found |= reactive_refs(p, component, locals, c, calls);
    }
    found
}

/// Whether each function may read a reactive class field, directly or
/// through the functions it calls (calls through function values make a
/// binding's dependencies unknown anyway).
fn function_reactive_reads(p: &Program) -> Vec<bool> {
    let n = p.functions.len();
    if !p.has_reactive_fields() {
        return vec![false; n];
    }
    let mut direct = vec![];
    for f in &p.functions {
        let locals: Vec<Local> = f
            .captures
            .iter()
            .chain(&f.params)
            .chain(&f.locals)
            .cloned()
            .collect();
        let mut exprs = vec![];
        for s in &f.body {
            stmt_exprs(s, &mut exprs);
        }
        let mut calls = BTreeSet::new();
        let mut found = false;
        for e in exprs {
            found |= reactive_refs(p, f.component, &locals, e, &mut calls);
        }
        direct.push((found, calls));
    }
    let mut reads: Vec<bool> = direct.iter().map(|d| d.0).collect();
    let mut changed = true;
    while changed {
        changed = false;
        for i in 0..n {
            if !reads[i] && direct[i].1.iter().any(|&c| reads[c]) {
                reads[i] = true;
                changed = true;
            }
        }
    }
    reads
}

/// The expressions of a statement (assignment targets included).
fn stmt_exprs<'a>(s: &'a Stmt, out: &mut Vec<&'a Expr>) {
    match s {
        Stmt::Set { value, .. } | Stmt::Expr { value, .. } | Stmt::Throw { value, .. } => {
            out.push(value)
        }
        Stmt::Let { value, .. } | Stmt::Return { value, .. } => out.extend(value.as_ref()),
        Stmt::Assign { target, value, .. } => {
            out.push(value);
            match target {
                Place::Field { object, .. } => out.push(object),
                Place::Index { array, index } => {
                    out.push(array);
                    out.push(index)
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
            out.push(test);
            for s in then.iter().chain(otherwise) {
                stmt_exprs(s, out);
            }
        }
        Stmt::While {
            test, body, update, ..
        } => {
            out.push(test);
            for s in body.iter().chain(update) {
                stmt_exprs(s, out);
            }
        }
        Stmt::ForOf { iterable, body, .. } => {
            out.push(iterable);
            for s in body {
                stmt_exprs(s, out);
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
                stmt_exprs(s, out);
            }
        }
        Stmt::Break { .. } | Stmt::Continue { .. } => {}
    }
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
    /// Per function: whether it may read a reactive class field.
    reactive: Vec<bool>,
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

    /// Whether template expressions of component `k` may read a reactive
    /// class field, directly or through the functions they call.
    fn reads_reactive(&self, k: usize, exprs: &[&Expr]) -> bool {
        if !self.p.has_reactive_fields() {
            return false;
        }
        let locals = &self.p.components[k].template_locals;
        exprs.iter().any(|e| {
            let mut calls = BTreeSet::new();
            reactive_refs(self.p, Some(k), locals, e, &mut calls)
                || calls.iter().any(|&f| self.reactive[f])
        })
    }

    /// The update condition of a binding: a dirty cell it reads, changed
    /// template locals (`tl`), or a reactive class field written since the
    /// last flush pass (`cx.rh`) when it may read one.
    fn guard(&self, k: usize, exprs: &[&Expr]) -> String {
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
                if self.reads_reactive(k, exprs) {
                    parts.push("cx.rh".into());
                }
                if parts.is_empty() {
                    "false".into()
                } else {
                    parts.join(" || ")
                }
            }
        }
    }

    fn is_static(&self, k: usize, exprs: &[&Expr]) -> bool {
        self.deps(exprs).is_some_and(|d| d.is_empty())
            && !exprs.iter().any(|e| reads_locals(e))
            && !self.reads_reactive(k, exprs)
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
             #[allow(unused_variables)]\nfn walk_s{id}(s: &S{id}, parent: usize, out: &mut Vec<(Rc<dyn Inst>, usize)>) {{\n{instances}}}\n\
             fn first_s{id}(s: &S{id}) -> Option<NodeId> {{ {first} }}\n\
             fn remove_s{id}(s: &S{id}, cx: &mut Cx, dom: &mut Dom) {{ let mut ns = Vec::new(); nodes_s{id}(s, &mut ns); let events = commit_events(dom.focus_loss(&ns)); if !events.is_empty() {{ run_nested(cx, events); }} dispose_s{id}(s, cx); for n in ns {{ dom.remove(n); }} }}\n{extra}\n",
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
                if self.is_static(k, &refs) {
                    let _ = writeln!(o.mount, "let n{key} = dom.text(&{value});");
                } else {
                    o.fields.push((format!("v{key}"), "String".into()));
                    let _ = writeln!(
                        o.mount,
                        "let v{key} = {value};\nlet n{key} = dom.text(&v{key});"
                    );
                    let guard = self.guard(k, &refs);
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
                    spread,
                    classes,
                    style_text,
                    styles,
                    style_update,
                    restore: restore_mode,
                    ..
                } = node
                else {
                    unreachable!()
                };
                o.fields.push((format!("n{key}"), "NodeId".into()));
                let _ = writeln!(o.mount, "let n{key} = dom.element({});", rust_str(tag));
                if let Some(r) = reference {
                    // The ref holds the element while mounted and null afterwards;
                    // a ref that is a bound prop forwards it to the parent.
                    let prop = self.p.components[k].cells[*r].prop.is_some();
                    let forward = |inst: &str, v: &str| {
                        if prop {
                            format!(
                                "{{ let b = {inst}.borrow().b{r}.clone(); if let Some(b) = b {{ if let Err(e) = b(cx, {v}) {{ eprintln!(\"runic: uncaught exception in a binding: {{e}}\"); }} }} }}"
                            )
                        } else {
                            String::new()
                        }
                    };
                    o.fields.push((format!("ri{key}"), format!("I{k}")));
                    let _ = writeln!(
                        o.mount,
                        "let ri{key} = Rc::clone(inst); {{ let ver = cx.jobs.version(); let mut st = inst.borrow_mut(); st.c.c{r} = Maybe::Some(js::Element(n{key}.as_u64())); st.ver[{r}] = ver; }} cx.jobs.ref_written(); {}",
                        forward(
                            "inst",
                            &format!("Maybe::Some(js::Element(n{key}.as_u64()))")
                        )
                    );
                    let _ = writeln!(
                        o.dispose,
                        "{{ let cleared = {{ let mut st = s.ri{key}.borrow_mut(); let mine = matches!(&st.c.c{r}, Maybe::Some(e) if e.0 == s.n{key}.as_u64()); if mine {{ st.c.c{r} = Maybe::Null; st.ver[{r}] = cx.jobs.version(); cx.jobs.ref_written(); }} mine }}; if cleared {{ {} }} }}",
                        forward("s.ri{key}", "Maybe::Null").replace("{key}", &key.to_string())
                    );
                }
                if style_text.is_some() || !styles.is_empty() {
                    // The inline style, managed through the CSSOM.
                    let mut cx = self.ctx(k);
                    let opt = |cx: &mut FnCtx, e: &Expr| {
                        let v = cx.expr(e);
                        match cx.ty(e) {
                            Type::String => format!("Some({v}.to_rust())"),
                            // Typed: a value that is only `undefined` infers nothing.
                            _ => format!(
                                "(match {{ let m: Maybe<JsString> = {v}; m }} {{ Maybe::Some(s) => Some(s.to_rust()), _ => None }})"
                            ),
                        }
                    };
                    // Without a style value: properties only (React DOM).
                    let value = style_text.as_ref().map(|e| opt(&mut cx, e));
                    let props: Vec<String> = styles
                        .iter()
                        .map(|p| format!("({}, {})", rust_str(&p.name), opt(&mut cx, &p.value)))
                        .collect();
                    let props = props.join(", ");
                    let state = match style_update {
                        StyleUpdate::Compose => "StyleState",
                        StyleUpdate::Replace => "ReplaceState",
                    };
                    let apply = |n: &str, st: &str| match (style_update, &value) {
                        (StyleUpdate::Compose, Some(value)) => format!(
                            "{{ let v = {value}; dom.styles({n}, v, &[{props}], &mut {st}); }}"
                        ),
                        (StyleUpdate::Compose, None) => {
                            format!("{{ dom.style_properties({n}, &[{props}], &mut {st}); }}")
                        }
                        (StyleUpdate::Replace, Some(value)) => format!(
                            "{{ let v = {value}; dom.style_text_replace({n}, v, &mut {st}); }}"
                        ),
                        (StyleUpdate::Replace, None) => format!(
                            "{{ dom.style_properties_replace({n}, &[{props}], &mut {st}); }}"
                        ),
                    };
                    o.fields
                        .push((format!("st{key}"), format!("runic_runtime::css::{state}")));
                    let _ = writeln!(
                        o.mount,
                        "let mut st{key} = runic_runtime::css::{state}::default(); {}",
                        apply(&format!("n{key}"), &format!("st{key}"))
                    );
                    let exprs: Vec<&Expr> = style_text
                        .iter()
                        .chain(styles.iter().map(|p| &p.value))
                        .collect();
                    if !self.is_static(k, &exprs) {
                        let guard = self.guard(k, &exprs);
                        let _ = writeln!(
                            o.update,
                            "if {guard} {}",
                            apply(&format!("s.n{key}"), &format!("s.st{key}"))
                        );
                    }
                }
                if !classes.is_empty() {
                    // The class attribute composed with the class toggles.
                    let class = attrs.iter().find(|a| a.name == "class");
                    let mut cx = self.ctx(k);
                    let value = class.map_or("JsString::new()".to_string(), |a| cx.expr(&a.value));
                    let toggles: Vec<String> = classes
                        .iter()
                        .map(|t| format!("({}, {})", rust_str(&t.name), cx.expr(&t.value)))
                        .collect();
                    let toggles = toggles.join(", ");
                    o.fields
                        .push((format!("cl{key}"), "runic_runtime::ClassState".into()));
                    let _ = writeln!(
                        o.mount,
                        "let mut cl{key} = runic_runtime::ClassState::default(); {{ let v = {value}; dom.classes(n{key}, v, &[{toggles}], &mut cl{key}); }}"
                    );
                    let exprs: Vec<&Expr> = class
                        .into_iter()
                        .map(|a| &a.value)
                        .chain(classes.iter().map(|t| &t.value))
                        .collect();
                    if !self.is_static(k, &exprs) {
                        let guard = self.guard(k, &exprs);
                        let _ = writeln!(
                            o.update,
                            "if {guard} {{ let v = {value}; dom.classes(s.n{key}, v, &[{toggles}], &mut s.cl{key}); }}"
                        );
                    }
                }
                for (i, a) in attrs.iter().enumerate() {
                    if !classes.is_empty() && a.name == "class" {
                        continue;
                    }
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
                    if self.is_static(k, &[&a.value]) {
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
                        let guard = self.guard(k, &[&a.value]);
                        let _ = writeln!(
                            o.update,
                            "if {guard} {{ let v = {value}; if v != s.{cache} {{ {} s.{cache} = v; }} }}",
                            write(&format!("s.n{key}"), "v")
                        );
                    }
                }
                if let Some(bag) = spread {
                    // The bag's attributes and listeners, re-applied when it changes.
                    let value = self.ctx(k).expr(bag);
                    let listen = "&mut |f: Bag| -> u32 { cx.listen(Rc::new(move |cx: &mut Cx| { let e = cx.event.clone().expect(\"event context\"); f(cx, e) })) }";
                    o.fields
                        .push((format!("sp{key}"), "runic_runtime::Spread<Bag>".into()));
                    let _ = writeln!(
                        o.mount,
                        "let mut sp{key} = runic_runtime::Spread::default(); {{ let v = {value}; dom.spread(n{key}, &v, &mut sp{key}, {listen}); }}"
                    );
                    if !self.is_static(k, &[bag]) {
                        let guard = self.guard(k, &[bag]);
                        let _ = writeln!(
                            o.update,
                            "if {guard} {{ let v = {value}; dom.spread(s.n{key}, &v, &mut s.sp{key}, {listen}); }}"
                        );
                    }
                }
                // Controlled values: restored at every sync (restore), or
                // applied when they differ from the value last applied.
                let restore = self.p.schedule.controlled_restore;
                // With `restore: render`, also at each re-render of the instance.
                let rerender = if *restore_mode == Some(Restore::Render) {
                    o.fields
                        .push((format!("pr{key}"), "std::cell::Cell<u64>".into()));
                    let _ = writeln!(
                        o.mount,
                        "let pr{key} = std::cell::Cell::new(inst.borrow().renders);"
                    );
                    format!("{{ let r = inst.borrow().renders; s.pr{key}.replace(r) != r }}")
                } else {
                    "false".to_string()
                };
                for p in props {
                    let v = self.ctx(k).expr(&p.value);
                    if p.name == "defaultValue" {
                        // A text area's text content, set when it changes
                        // (not a controlled value).
                        let _ = writeln!(
                            o.mount,
                            "{{ let v = {v}.to_rust(); dom.set_default_value(n{key}, &v); }}"
                        );
                        if !self.is_static(k, &[&p.value]) {
                            let guard = self.guard(k, &[&p.value]);
                            let _ = writeln!(
                                o.update,
                                "if {guard} {{ let v = {v}.to_rust(); dom.set_default_value(s.n{key}, &v); }}"
                            );
                        }
                        continue;
                    }
                    let (rty, conv, set) = if p.name == "checked" {
                        ("bool", "", "dom.set_checked(N, v)")
                    } else if p.name == "selectValue" {
                        ("String", ".to_rust()", "dom.set_select_value(N, &v)")
                    } else {
                        ("String", ".to_rust()", "dom.set_value(N, &v)")
                    };
                    let set_n = |n: &str| set.replace('N', n);
                    if restore {
                        let _ = writeln!(
                            o.mount,
                            "{{ let v = {v}{conv}; {}; }}",
                            set_n(&format!("n{key}"))
                        );
                        let _ = writeln!(
                            o.sync,
                            "{{ let v = {v}{conv}; {}; }}",
                            set_n(&format!("s.n{key}"))
                        );
                    } else {
                        let cache = format!("pv{key}_{}", p.name);
                        o.fields.push((cache.clone(), format!("RefCell<{rty}>")));
                        let _ = writeln!(
                            o.mount,
                            "let {cache} = RefCell::new({v}{conv}); {{ let v = {cache}.borrow().clone(); {}; }}",
                            set_n(&format!("n{key}"))
                        );
                        let _ = writeln!(
                            o.sync,
                            "{{ let v = {v}{conv}; let rerendered = {rerender}; if cx.force_sync || rerendered || *s.{cache}.borrow() != v {{ {}; *s.{cache}.borrow_mut() = v; }} }}",
                            set_n(&format!("s.n{key}"))
                        );
                    }
                }
                for l in listeners {
                    // The runtime's event kinds mirror the IR's.
                    let ev = format!("Event::{:?}", l.event);
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
                let guard = self.guard(k, &[test]);
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
                    "if let Some(b) = &s.then{key} {{ walk_s{th}(b, parent, out); }}\nif let Some(b) = &s.else{key} {{ walk_s{el}(b, parent, out); }}"
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
                let has_pre = child.effects.iter().any(|e| e.phase == EffectPhase::Pre);
                // Pre effects run when the instance is created.
                let created = if has_pre {
                    format!("fx_phase_i{c}(cx, &ci{key}, 0, true);\n")
                } else {
                    String::new()
                };
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
                         fn walk(&self, parent: usize, out: &mut Vec<(Rc<dyn Inst>, usize)>) {{ walk_s{body}(&self.s, parent, out); }}\n\
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
                    // Update: a changed prop sets the child's cell and dirty bit; it is
                    // part of this render, not a change the next flush sees (`before`).
                    let ty = &child.cells[cell].ty;
                    let same = same_expr(ty, "(*o)", "v");
                    let guard = self.guard(k, &[&a.value]);
                    let _ = writeln!(
                        o.update,
                        "if {guard} {{ let v = {v}; let mut st = s.ci{key}.borrow_mut(); let changed = match &st.p{cell} {{ Some(o) => !{same}, None => true }}; if changed {{ st.p{cell} = Some(v.clone()); st.c.c{cell} = v.clone(); st.before.c{cell} = v.clone(); Rc::make_mut(&mut st.snap).c{cell} = v; st.dirty[{cell}] = true; st.ver[{cell}] = cx.jobs.version(); }} }}"
                    );
                    if let Some(b) = &a.bind {
                        let guard = self.guard(k, &[b]);
                        let bv = self.ctx(k).expr(b);
                        let _ = writeln!(
                            o.update,
                            "if {guard} {{ let b = {bv}; s.ci{key}.borrow_mut().b{cell} = Some(b); }}"
                        );
                    }
                }
                let _ = writeln!(
                    o.mount,
                    "let ci{key} = new_i{c}(cx);\n{pass}{providers}init_i{c}(cx, &ci{key})?;\n{created}let ct{key}: Rc<RefCell<T{c}>> = Rc::new(RefCell::new(T{c}::default()));\nlet cs{key} = mount_s{root}(cx, dom, &ci{key}, &ct{key}, {mp}, {mb})?;"
                );
                let anchor = first_of(following, tail);
                // Pre effects of the child run before it updates (after its props).
                let pre = if has_pre {
                    format!(
                        "{{ let u = cx.updated.get(&(Rc::as_ptr(&s.ci{key}) as *const u8 as usize)).copied().unwrap_or(true); fx_phase_i{c}(cx, &s.ci{key}, 0, u); }}\n"
                    )
                } else {
                    String::new()
                };
                let _ = writeln!(
                    o.update,
                    "{pre}{{ let anchor = {anchor}; update_s{root}(&mut s.cs{key}, cx, dom, &s.ci{key}, &s.ct{key}, false, {up}, anchor)?; }}"
                );
                let _ = writeln!(
                    o.sync,
                    "sync_s{root}(&s.cs{key}, cx, dom, &s.ci{key}, &s.ct{key})?;"
                );
                let _ = writeln!(
                    o.dispose,
                    "cx.destroyed.push(Rc::new(H{c}(Rc::clone(&s.ci{key})))); dispose_s{root}(&s.cs{key}, cx); destroy_i{c}(cx, &s.ci{key});"
                );
                let _ = writeln!(
                    o.instances,
                    "out.push((Rc::new(H{c}(Rc::clone(&s.ci{key}))) as Rc<dyn Inst>, parent));\nwalk_s{root}(&s.cs{key}, Rc::as_ptr(&s.ci{key}) as *const u8 as usize, out);"
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
                    "if let Some(b) = &s.sl{key} {{ b.walk(parent, out); }}\nif let Some(b) = &s.fb{key} {{ walk_s{fb}(b, parent, out); }}"
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
                let guard = self.guard(k, &[items]);
                let _ = writeln!(
                    o.update,
                    "{{\n\
                     let after_list = {anchor};\n\
                     if {guard} {{\n\
                     let items = {items_rs}; let values: Vec<_> = items.borrow().clone(); let mut seen = std::collections::HashSet::new();\n\
                     // Keys first: a throwing key or a duplicate leaves the blocks as they are.\n\
                     let mut fresh = Vec::with_capacity(values.len());\n\
                     for (i, x) in values.into_iter().enumerate() {{\n{block}\nfresh.push((bk, t2));\n}}\n\
                     let old_len = s.e{key}.len();\n\
                     let mut old: std::collections::HashMap<js::MapKey, (usize, Rc<RefCell<T{k}>>, Box<S{bd}>)> = s.e{key}.drain(..).enumerate().map(|(i, (k, t, b))| (k, (i, t, b))).collect();\n\
                     let mut next: Vec<(js::MapKey, Rc<RefCell<T{k}>>, Option<Box<S{bd}>>, Option<usize>)> = Vec::new();\n\
                     for (bk, t2) in fresh {{\n\
                     match old.remove(&bk) {{ Some((oi, ot, ob)) => {{ let v = t2.borrow().clone(); *ot.borrow_mut() = v; next.push((bk, ot, Some(ob), Some(oi))); }} None => next.push((bk, t2, None, None)) }}\n\
                     }}\n\
                     let mut gone: Vec<_> = old.into_values().collect(); gone.sort_by_key(|g| g.0);\n\
                     for (_, _, ob) in gone {{ remove_s{bd}(&ob, cx, dom); }}\n\
                     let keep = runic_runtime::reorder::keep(runic_runtime::reorder::Reorder::{reorder:?}, &next.iter().map(|e| e.3).collect::<Vec<_>>(), old_len);\n\
                     let mut anchor = after_list;\n\
                     let mut out = Vec::with_capacity(next.len());\n\
                     // Every block is placed even if one throws (no block is lost with its DOM); the first error is returned after.\n\
                     let mut err = None;\n\
                     for (j, (bk, tt, b, _)) in next.into_iter().enumerate().rev() {{\n\
                     let b = match b {{\n\
                     Some(mut b) => {{ if !keep[j] {{ let mut ns = Vec::new(); nodes_s{bd}(&b, &mut ns); let events = commit_events(dom.focus_loss(&ns)); if !events.is_empty() {{ run_nested(cx, events); }} dom.insert_all({up}, &ns, anchor); }} if let Err(e) = update_s{bd}(&mut b, cx, dom, inst, &tt, true, {up}, anchor) {{ err.get_or_insert(e); }} Some(b) }}\n\
                     None => match mount_s{bd}(cx, dom, inst, &tt, {up}, anchor) {{ Ok(b) => Some(b), Err(e) => {{ err.get_or_insert(e); None }} }},\n\
                     }};\n\
                     if let Some(b) = b {{ if let Some(f) = first_s{bd}(&b) {{ anchor = Some(f); }} out.push((bk, tt, b)); }}\n\
                     }}\n\
                     out.reverse(); s.e{key} = out;\n\
                     if let Some(e) = err {{ return Err(e); }}\n\
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
                    "for (_, _, b) in &s.e{key} {{ walk_s{bd}(b, parent, out); }}\nif let Some(b) = &s.else{key} {{ walk_s{el}(b, parent, out); }}"
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
        // A derived class field holds its cache (M6 stage B).
        let fields: String = rec
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| match f.is_derived() {
                true => format!(
                    "pub f{i}: Option<runic_runtime::Derived<{}, Cx>>, ",
                    rust_type(&f.ty)
                ),
                false => format!("pub f{i}: {}, ", rust_type(&f.ty)),
            })
            .collect();
        let defaults: String = rec
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| match f.is_derived() {
                true => format!("f{i}: None, "),
                false => format!("f{i}: {}, ", default_value(&f.ty, p)),
            })
            .collect();
        let values = || {
            rec.fields
                .iter()
                .enumerate()
                .filter(|(_, f)| !f.is_derived())
        };
        let owns: String = values()
            .map(|(i, _)| format!("self.f{i} = js::Own::own(self.f{i}.clone()); "))
            .collect();
        let marks: String = values()
            .map(|(i, _)| format!("js::Own::mark(&self.f{i}); "))
            .collect();
        let derived = rec.fields.iter().any(|f| f.is_derived());
        // Class instances are never proxied (Svelte proxies plain objects only).
        let proxied = !rec.class;
        let _ = writeln!(
            out,
            "/// {}\n#[derive(Clone)]\npub struct R{r} {{ {fields}}}\n\
             impl Default for R{r} {{ fn default() -> Self {{ R{r} {{ {defaults}}} }} }}\n\
             impl js::HeapToString for R{r} {{ fn heap_to_string(&self) -> JsString {{ JsString::from(\"[object Object]\") }} }}\n\
             impl js::OwnFields for R{r} {{ const PROXIED: bool = {proxied}; fn own_fields(&mut self) {{ {owns}}} fn mark_fields(&self) {{ {marks}}} }}\n\
             impl std::fmt::Debug for R{r} {{ fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {{ f.write_str({}) }} }}",
            rec.name.replace('\n', " "),
            rust_str(&rec.name)
        );
        // Class instances are not plain data (JSON rejects them).
        if !derived && rec.fields.iter().all(|f| builtins_json_ok(&f.ty, p)) {
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
            .map(|(i, f)| match f.is_derived() {
                true => format!("f{i}: None, "),
                false => format!(
                    "f{i}: {}, ",
                    builtins::deep_clone(&f.ty, &format!("b.f{i}"), p)
                ),
            })
            .collect();
        // Derived class fields show as null (their caches are not program state).
        let probes: String = rec
            .fields
            .iter()
            .enumerate()
            .map(|(i, f)| match f.is_derived() {
                true => "runic_runtime::Json::Null, ".to_string(),
                false => format!("{}, ", probe_json(&f.ty, &format!("b.f{i}"))),
            })
            .collect();
        let _ = writeln!(
            out,
            "#[allow(dead_code, unused_parens)]\nfn probe_r{r}(v: &JsRef<R{r}>) -> runic_runtime::Json {{ let Some(_v) = v.visit() else {{ return runic_runtime::Json::String(\"[Circular]\".into()); }}; let b = v.borrow(); runic_runtime::Json::Array(vec![{probes}]) }}\n\
             #[allow(dead_code, unused_parens)]\nfn clone_r{r}(v: &JsRef<R{r}>) -> JsRef<R{r}> {{ let b = v.borrow(); JsRef::new(R{r} {{ {clones}}}) }}\n"
        );
    }
    out.push_str(&class_refs(p));
    out
}

/// Class references (M6 inheritance): one enum of the instances of every
/// class in a hierarchy, by class; an IR class type restricts which
/// variants a value can be.
fn class_refs(p: &Program) -> String {
    if !types::has_class_refs(p) {
        return String::new();
    }
    let variants = types::obj_variants(p);
    let each = |f: &dyn Fn(usize) -> String| -> String { variants.iter().map(|&r| f(r)).collect() };
    let decl = each(&|r| format!("R{r}(JsRef<R{r}>), "));
    let eq = each(&|r| format!("(Obj::R{r}(a), Obj::R{r}(b)) => JsRef::ptr_eq(a, b), "));
    let addr = each(&|r| format!("Obj::R{r}(o) => o.addr(), "));
    let mark = each(&|r| format!("Obj::R{r}(o) => js::Own::mark(o), "));
    let debug = each(&|r| format!("Obj::R{r}(o) => std::fmt::Debug::fmt(o, f), "));
    let probe = each(&|r| format!("Obj::R{r}(o) => probe_r{r}(o), "));
    let eq_rest = "_ => false, ";
    format!(
        "/// A class instance with its class.\n#[derive(Clone)]\npub enum Obj {{ {decl}}}\n\
         impl Obj {{ fn addr(&self) -> usize {{ match self {{ {addr}_ => unreachable!(), }} }} }}\n\
         impl PartialEq for Obj {{ fn eq(&self, other: &Self) -> bool {{ js::StrictEq::strict_eq(self, other) }} }}\n\
         impl std::fmt::Debug for Obj {{ fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {{ match self {{ {debug}_ => unreachable!(), }} }} }}\n\
         impl js::StrictEq for Obj {{ fn strict_eq(&self, other: &Self) -> bool {{ match (self, other) {{ {eq}{eq_rest}}} }} }}\n\
         impl js::Truthy for Obj {{ fn truthy(&self) -> bool {{ true }} }}\n\
         impl js::TypeOf for Obj {{ fn type_of(&self) -> &'static str {{ \"object\" }} }}\n\
         impl js::ToJsString for Obj {{ fn to_js_string(&self) -> JsString {{ JsString::from(\"[object Object]\") }} }}\n\
         impl js::ArrayElement for Obj {{ fn join_string(&self) -> JsString {{ JsString::from(\"[object Object]\") }} }}\n\
         impl js::ToMapKey for Obj {{ fn map_key(&self) -> js::MapKey {{ js::MapKey::Ref(self.addr()) }} }}\n\
         impl js::Own for Obj {{ fn mark(&self) {{ match self {{ {mark}_ => unreachable!(), }} }} }}\n\
         #[allow(dead_code, unused_parens)]\nfn probe_obj(v: &Obj) -> runic_runtime::Json {{ match v {{ {probe}_ => unreachable!(), }} }}\n"
    )
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
            "(match {v}.visit() {{ None => runic_runtime::Json::String(\"[Circular]\".into()), Some(_v) => runic_runtime::Json::Array({v}.borrow().iter().map(|x| {}).collect()) }})",
            probe_json(i, "(*x)")
        ),
        Type::Record(r) => format!("probe_r{r}(&{v})"),
        Type::Class(_) | Type::Classes(_) => format!("probe_obj(&{v})"),
        Type::Map(k, x) => format!(
            "(match {v}.visit() {{ None => runic_runtime::Json::String(\"[Circular]\".into()), Some(_v) => runic_runtime::Json::Array({v}.borrow().entries.values().map(|(k, x)| runic_runtime::Json::Array(vec![{}, {}])).collect()) }})",
            probe_json(k, "(*k)"),
            probe_json(x, "(*x)")
        ),
        Type::Set(i) => format!(
            "(match {v}.visit() {{ None => runic_runtime::Json::String(\"[Circular]\".into()), Some(_v) => runic_runtime::Json::Array({v}.borrow().entries.values().map(|x| {}).collect()) }})",
            probe_json(i, "(*x)")
        ),
        Type::Fn(_) => {
            format!("{{ let _ = &{v}; runic_runtime::Json::String(\"function\".into()) }}")
        }
        Type::Promise(_) => {
            format!("{{ let _ = &{v}; runic_runtime::Json::String(\"promise\".into()) }}")
        }
        // Element ids differ between the interpreter and the native app.
        Type::Element => {
            format!("{{ let _ = &{v}; runic_runtime::Json::String(\"element\".into()) }}")
        }
        Type::Event => {
            format!("{{ let _ = &{v}; runic_runtime::Json::String(\"event\".into()) }}")
        }
        Type::Attrs => {
            format!("{{ let _ = &{v}; runic_runtime::Json::String(\"attrs\".into()) }}")
        }
        Type::Regexp => {
            format!("runic_runtime::Json::String(js::ToJsString::to_js_string(&{v}).to_rust())")
        }
        Type::MediaQuery => {
            format!("{{ let _ = &{v}; runic_runtime::Json::String(\"media-query\".into()) }}")
        }
        // A Date as its ISO string (or "Invalid Date").
        Type::Date => format!(
            "runic_runtime::Json::String(js::date::to_json({v}.time()).map_or(\"Invalid Date\".into(), |s| s.to_rust()))"
        ),
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
    let m = c.effects.len();
    let mut fx_values = String::new();
    let mut fx_value_defaults = String::new();
    // Cached derived values.
    for (f, func) in p.functions.iter().enumerate() {
        if func.derived && func.component == Some(k) {
            let _ = write!(
                fx_values,
                "pub dv{f}: Option<runic_runtime::Derived<{}, Cx>>, ",
                rust_type(&func.result)
            );
            let _ = write!(fx_value_defaults, "dv{f}: None, ");
        }
    }
    for (e, effect) in c.effects.iter().enumerate() {
        if let EffectDeps::Values { values, .. } = &effect.deps {
            let cx = FnCtx::new(p, Some(k), vec![], None, Type::Void);
            let tys: String = values
                .iter()
                .map(|v| format!("{}, ", rust_type(&cx.ty(v))))
                .collect();
            let _ = write!(fx_values, "pub fxv{e}: Option<({tys})>, ");
            let _ = write!(fx_value_defaults, "fxv{e}: None, ");
        }
    }
    let _ = writeln!(
        out,
        "/// Cells of component {name}.\n#[derive(Clone)]\npub struct Cells{k} {{ {fields}}}\n\
         impl Default for Cells{k} {{ fn default() -> Self {{ Cells{k} {{ {defaults}}} }} }}\n\
         /// Template locals of component {name}.\n#[derive(Clone)]\npub struct T{k} {{ {locals}}}\n\
         impl Default for T{k} {{ fn default() -> Self {{ T{k} {{ {local_defaults}}} }} }}\n\
         /// An instance of {name}: current, snapshot and pre-handler cells, dirty bits and props.\n\
         pub struct St{k} {{ pub c: Cells{k}, pub snap: Rc<Cells{k}>, pub prev: Rc<Cells{k}>, pub before: Cells{k}, pub dirty: [bool; {n}], pub changed: bool, pub ver: [u64; {n}], pub fx: Vec<runic_runtime::Fx<Lst, Cx>>, pub stable: std::collections::HashMap<usize, Rc<dyn std::any::Any>>, pub renders: u64, {props}{fx_values}}}\n\
         pub type I{k} = Rc<RefCell<St{k}>>;\n\
         fn new_i{k}(cx: &mut Cx) -> I{k} {{ let i = Rc::new(RefCell::new(St{k} {{ c: Cells{k}::default(), snap: Rc::new(Cells{k}::default()), prev: Rc::new(Cells{k}::default()), before: Cells{k}::default(), dirty: [false; {n}], changed: false, ver: [0; {n}], fx: (0..{m}).map(|_| runic_runtime::Fx::default()).collect(), stable: std::collections::HashMap::new(), renders: 0, {prop_defaults}{fx_value_defaults}}})); cx.live{k}.push(Rc::clone(&i)); i }}\n\
         fn destroy_i{k}(cx: &mut Cx, inst: &I{k}) {{ cx.live{k}.retain(|x| !Rc::ptr_eq(x, inst)); let stable = std::mem::take(&mut inst.borrow_mut().stable); drop(stable); clear_derived_i{k}(inst); }}",
        name = c.name.replace('\n', " "),
    );
    // Initialisation: passed props keep their value; other cells evaluate `init`.
    let mut init = String::new();
    for (i, cell) in c.cells.iter().enumerate() {
        let mut cx = FnCtx::new(p, Some(k), vec![], None, Type::Void);
        cx.init = true;
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
        } else if cell.tracking == Tracking::Deep && cell.prop.is_none() {
            "js::Own::mark(&v); "
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
        "#[allow(unused_variables)]\nfn init_i{k}(cx: &mut Cx, inst: &I{k}) -> JsResult<()> {{\n{init}let mut st = inst.borrow_mut(); st.snap = Rc::new(st.c.clone()); st.prev = Rc::clone(&st.snap); st.before = st.c.clone();\nOk(())\n}}\n\
         fn begin_i{k}(st: &mut St{k}) {{ st.before = st.c.clone(); }}\n\
         #[allow(unused_variables)]\nfn end_i{k}(st: &mut St{k}, deep: bool, owned: bool, optimize: bool) {{ let dirty: [bool; {n}] = [{dirty}]; st.changed = dirty.iter().any(|d| *d); st.dirty = if optimize {{ dirty }} else {{ [true; {n}] }}; st.prev = std::mem::replace(&mut st.snap, Rc::new(st.c.clone())); }}\n\
         #[allow(unused_variables)]\nfn cells_json_i{k}(inst: &I{k}) -> runic_runtime::Json {{ let st = inst.borrow(); runic_runtime::Json::Array(vec![{cells_json}]) }}\n"
    );
}

/// Whether only reads through proxies make heap dependencies (programs with
/// proxied state; otherwise every heap read counts).
/// Host services of every generated app (docs/design/M5-PLATFORM.md): the
/// host's work queued between tasks and the operations that queue it. The
/// reference interpreter implements the same model (`runic_ir::interp`).
const HOST_SERVICES: &str = r#"/// Work the host does after the running task, in order: clipboard replies, history traversals, `hashchange`.
pub enum HostTask { ClipboardWrite(JsString, js::JsPromise<(), Lst>), ClipboardRead(js::JsPromise<JsString, Lst>), Traverse(i64), HashChange }
impl Cx {
    /// Chromium settles overlapping clipboard operations in an order that depends on their kinds, which the model does not cover.
    fn clipboard_pending(&self) -> JsResult<()> {
        if self.host_tasks.iter().any(|t| matches!(t, HostTask::ClipboardWrite(..) | HostTask::ClipboardRead(_))) {
            return Err(js::Throw::new("RunicHostError", "a clipboard operation while another is pending"));
        }
        Ok(())
    }
    fn clipboard_write(&mut self, text: JsString) -> JsResult<js::JsPromise<(), Lst>> {
        self.clipboard_pending()?;
        let p = js::JsPromise::pending();
        self.host_tasks.push_back(HostTask::ClipboardWrite(text, p.clone()));
        Ok(p)
    }
    fn clipboard_read(&mut self) -> JsResult<js::JsPromise<JsString, Lst>> {
        self.clipboard_pending()?;
        let p = js::JsPromise::pending();
        self.host_tasks.push_back(HostTask::ClipboardRead(p.clone()));
        Ok(p)
    }
    /// Traversals queued while one is pending interact in Chromium (a second may be dropped), which the model does not cover.
    fn traverse(&mut self, delta: i64) -> JsResult<()> {
        if self.host_tasks.iter().any(|t| matches!(t, HostTask::Traverse(_))) {
            return Err(js::Throw::new("RunicHistoryError", "a history traversal while another is pending"));
        }
        self.host_tasks.push_back(HostTask::Traverse(delta));
        Ok(())
    }
    /// `location.hash = value`: `popstate` at once (nested in the setter), `hashchange` as a task.
    fn set_hash(&mut self, value: &JsString) -> JsResult<()> {
        if runic_runtime::history::set_hash(value)? {
            let ev = js::Event::new(js::EventData { kind: JsString::from("popstate"), target: js::Element::WINDOW, ..Default::default() });
            let deliveries: Vec<runic_runtime::Delivery> = self.host.iter().filter(|h| h.0 && h.1 == Event::Popstate).map(|h| runic_runtime::Delivery { listener: h.3, event: ev.clone(), current: js::Element::WINDOW.0 }).collect();
            run_nested(self, vec![(ev, Event::Popstate, deliveries)]);
            self.host_tasks.push_back(HostTask::HashChange);
        }
        Ok(())
    }
}
"#;

fn owned_only(p: &Program) -> bool {
    p.components.iter().any(|c| {
        c.cells
            .iter()
            .any(|cell| cell.tracking == Tracking::Proxied)
    }) || p.has_reactive_fields()
}

/// Strict equality (`===`) of two values of type `t`, as Svelte compares
/// the values written to signals.
fn strict_expr(t: &Type, a: &str, b: &str) -> String {
    match t {
        Type::Number | Type::Boolean => format!("({a} == {b})"),
        Type::Fn(_) => format!("Rc::ptr_eq(&{a}, &{b})"),
        Type::Promise(_) => format!("({a} == {b})"),
        Type::Void => "true".into(),
        Type::Maybe(inner) if matches!(**inner, Type::Fn(_) | Type::Promise(_)) => format!(
            "(match (&{a}, &{b}) {{ (Maybe::Some(x), Maybe::Some(y)) => {}, (Maybe::Undefined, Maybe::Undefined) | (Maybe::Null, Maybe::Null) => true, _ => false }})",
            strict_expr(inner, "(*x)", "(*y)")
        ),
        _ => format!("js::StrictEq::strict_eq(&{a}, &{b})"),
    }
}

/// Derived class fields (docs/IR.md, "Reactive class fields"): `dfresh`
/// recomputes field `i` of an instance of record `r` when it was never
/// computed or what it read changed, keeping the value and its version when
/// the result is `===` to it; `dfield` reads it (a dependency of a running
/// tracked effect or derived value). The computation runs in the calling
/// instance when its function belongs to a component.
fn derived_fields(p: &Program, out: &mut String) {
    for (r, rec) in p.records.iter().enumerate() {
        for (i, f) in rec.fields.iter().enumerate() {
            let Some(d) = f.derived else { continue };
            if rec.is_abstract {
                continue;
            }
            // The function of an inherited field takes the class reference.
            let this = match p.functions[d].params[0].ty {
                Type::Class(_) | Type::Classes(_) => format!("Obj::R{r}(o.clone())"),
                _ => "o.clone()".to_string(),
            };
            let t = rust_type(&f.ty);
            let (sig, args, capture, captured) = match p.functions[d].component {
                Some(k) => (
                    format!(", inst: &I{k}, snap: &Rc<Cells{k}>"),
                    ", inst, snap",
                    "let ki = Rc::clone(inst); let ks = Rc::clone(snap); ",
                    ", &ki, &ks",
                ),
                None => (String::new(), "", "", ""),
            };
            let same = strict_expr(&f.ty, "d.cached", "v");
            let _ = writeln!(
                out,
                "#[allow(unused_variables)]\nfn dfresh_{r}_{i}(cx: &mut Cx{sig}, o: &JsRef<R{r}>) -> JsResult<()> {{\n\
                 let deps = o.peek().f{i}.as_ref().map(|d| d.deps.clone());\n\
                 let stale = match deps {{ None => true, Some(ds) => ds.iter().any(|d| d.changed(cx)) }};\n\
                 if !stale {{ return Ok(()); }}\n\
                 let outer = std::mem::replace(&mut cx.tracking, Some(Vec::new()));\n\
                 let heap_outer = js::begin_heap_reads(Some(true));\n\
                 let r = f{d}(cx{args}, {this});\n\
                 let heap = js::end_heap_reads(heap_outer);\n\
                 let mut deps = std::mem::replace(&mut cx.tracking, outer).unwrap_or_default();\n\
                 let v: {t} = r?;\n\
                 deps.extend(runic_runtime::Dep::heap(heap));\n\
                 let same = o.peek().f{i}.as_ref().is_some_and(|d| {same});\n\
                 if same {{ if let Some(d) = o.peek_mut().f{i}.as_mut() {{ d.deps = deps; }} }}\n\
                 else {{ let version = cx.jobs.version(); o.peek_mut().f{i} = Some(runic_runtime::Derived {{ cached: v, deps, version }}); }}\n\
                 Ok(())\n}}\n\
                 #[allow(unused_variables)]\nfn dfield_{r}_{i}(cx: &mut Cx{sig}, o: &JsRef<R{r}>) -> JsResult<{t}> {{\n\
                 dfresh_{r}_{i}(cx{args}, o)?;\n\
                 let (v, version) = {{ let b = o.peek(); let d = b.f{i}.as_ref().expect(\"derived field\"); (d.cached.clone(), d.version) }};\n\
                 if let Some(t) = cx.tracking.as_mut() {{ let w = o.downgrade(); {capture}t.push(runic_runtime::Dep {{ cells: None, cell: 0, refresh: Some(Rc::new(move |cx: &mut Cx| match w.upgrade() {{ Some(o) => {{ let _ = dfresh_{r}_{i}(cx{captured}, &o); let b = o.peek(); let v = b.f{i}.as_ref().map_or(u64::MAX, |d| d.version); v }} None => u64::MAX }})), version, heap: None }}); }}\n\
                 Ok(v)\n}}"
            );
        }
    }
}

/// Derived values of component `k` (docs/design/M4-EFFECTS.md): `dget` reads
/// the cached value (a dependency of a running tracked effect or derived),
/// `dref` recomputes it when a dependency changed, keeping the value and its
/// version when the result is the same.
fn component_derived(p: &Program, k: usize, out: &mut String) {
    let mut clear = String::new();
    for (f, func) in p.functions.iter().enumerate() {
        if !(func.derived && func.component == Some(k)) {
            continue;
        }
        let t = rust_type(&func.result);
        let owned_only = owned_only(p);
        let same = same_expr(&func.result, "d.cached", "v");
        let _ = write!(clear, "st.dv{f} = None; ");
        let _ = writeln!(
            out,
            "#[allow(unused_variables)]\nfn dref_{f}(cx: &mut Cx, inst: &I{k}) -> JsResult<()> {{\n\
             let deps = inst.borrow().dv{f}.as_ref().map(|d| d.deps.clone());\n\
             let stale = match deps {{ None => true, Some(ds) => ds.iter().any(|d| d.changed(cx)) }};\n\
             if !stale {{ return Ok(()); }}\n\
             let outer = std::mem::replace(&mut cx.tracking, Some(Vec::new()));\n\
             let heap_outer = js::begin_heap_reads(Some({owned_only}));\n\
             let snap = {{ let s = Rc::clone(&inst.borrow().snap); s }};\n\
             let r = f{f}(cx, inst, &snap);\n\
             let heap = js::end_heap_reads(heap_outer);\n\
             let mut deps = std::mem::replace(&mut cx.tracking, outer).unwrap_or_default();\n\
             let v: {t} = r?;\n\
             deps.extend(runic_runtime::Dep::heap(heap));\n\
             let same = inst.borrow().dv{f}.as_ref().is_some_and(|d| {same});\n\
             if same {{ if let Some(d) = inst.borrow_mut().dv{f}.as_mut() {{ d.deps = deps; }} }}\n\
             else {{ let version = cx.jobs.version(); inst.borrow_mut().dv{f} = Some(runic_runtime::Derived {{ cached: v, deps, version }}); }}\n\
             Ok(())\n}}\n\
             #[allow(unused_variables)]\nfn dget_{f}(cx: &mut Cx, inst: &I{k}) -> JsResult<{t}> {{\n\
             dref_{f}(cx, inst)?;\n\
             let (v, version) = {{ let st = inst.borrow(); let d = st.dv{f}.as_ref().expect(\"derived value\"); (d.cached.clone(), d.version) }};\n\
             if let Some(t) = cx.tracking.as_mut() {{ let i2 = Rc::clone(inst); t.push(runic_runtime::Dep {{ cells: None, cell: 0, refresh: Some(Rc::new(move |cx: &mut Cx| {{ let _ = dref_{f}(cx, &i2); i2.borrow().dv{f}.as_ref().map_or(u64::MAX, |d| d.version) }})), version, heap: None }}); }}\n\
             Ok(v)\n}}"
        );
    }
    // Derived slots and effect dependencies hold closures over the instance.
    let _ = writeln!(
        out,
        "#[allow(unused_variables, unused_mut)]\nfn clear_derived_i{k}(inst: &I{k}) {{ let mut st = inst.borrow_mut(); {clear}for fx in st.fx.iter_mut() {{ fx.deps.clear(); }} }}"
    );
}

/// Effects of component `k`: the `Inst` view of its instances (tree
/// walks, dirtiness, effect metadata) and its effects' dependency checks,
/// runs and cleanups (docs/design/M4-EFFECTS.md).
fn component_effects(p: &Program, k: usize, out: &mut String) {
    let c = &p.components[k];
    let meta: String = c
        .effects
        .iter()
        .map(|e| {
            let phase = match e.phase {
                EffectPhase::Pre => 0,
                EffectPhase::Layout => 1,
                EffectPhase::Post => 2,
            };
            format!(
                "({phase}, {}, {}), ",
                e.unmount.removal == Removal::After,
                e.unmount.order == TreeOrder::Post
            )
        })
        .collect();
    let mut due = String::new();
    let mut run = String::new();
    for (e, effect) in c.effects.iter().enumerate() {
        let f = &p.functions[effect.run];
        let mut cx = FnCtx::new(p, Some(k), vec![], None, Type::Void);
        // Dependency values as a tuple, and their comparison with the last ones.
        let (tuple, same) = match &effect.deps {
            EffectDeps::Values { values, .. } => {
                let vs: String = values.iter().map(|v| format!("{}, ", cx.expr(v))).collect();
                let same: Vec<String> = values
                    .iter()
                    .enumerate()
                    .map(|(i, v)| same_expr(&cx.ty(v), &format!("o.{i}"), &format!("new.{i}")))
                    .collect();
                (
                    // A throwing dependency is an uncaught exception; the effect does not run.
                    format!(
                        "match (|| -> JsResult<_> {{ Ok(({vs})) }})() {{ Ok(v) => v, Err(err) => {{ eprintln!(\"runic: uncaught exception in an effect: {{err}}\"); return Default::default(); }} }}"
                    ),
                    if same.is_empty() {
                        "true".into()
                    } else {
                        same.join(" && ")
                    },
                )
            }
            _ => (String::new(), String::new()),
        };
        let check = match &effect.deps {
            EffectDeps::Once => "!started".to_string(),
            EffectDeps::Always => "!started || updated".to_string(),
            EffectDeps::Tracked => {
                "!started || { let deps = inst.borrow().fx[e].deps.clone(); deps.iter().any(|d| d.changed(cx)) }".to_string()
            }
            EffectDeps::Values { initial, .. } => format!(
                "{{ let new = {tuple}; let changed = match &inst.borrow().fxv{e} {{ Some(o) => !({same}), None => true }}; if !started && !{initial} {{ let mut st = inst.borrow_mut(); st.fxv{e} = Some(new); st.fx[e].started = true; return false; }} changed }}"
            ),
        };
        let _ = writeln!(due, "{e} => {check},");
        // Arguments: the new values and the previous ones (undefined at first).
        let mut prologue = String::new();
        let mut args = String::new();
        if let EffectDeps::Values { values, .. } = &effect.deps {
            let _ = write!(
                prologue,
                "let new = {tuple}; let (old, was) = {{ let st = inst.borrow(); (st.fxv{e}.clone(), st.fx[e].started) }}; inst.borrow_mut().fxv{e} = Some(new.clone()); "
            );
            if !f.params.is_empty() {
                for i in 0..values.len() {
                    let _ = write!(args, ", new.{i}.clone()");
                }
                for (i, v) in values.iter().enumerate() {
                    let wrap = if matches!(cx.ty(v), Type::Maybe(_)) {
                        format!("o.{i}.clone()")
                    } else {
                        format!("Maybe::Some(o.{i}.clone())")
                    };
                    let _ = write!(
                        args,
                        ", match (&old, was) {{ (Some(o), true) => {wrap}, _ => Maybe::Undefined }}"
                    );
                }
            }
        }
        let tracked = effect.deps == EffectDeps::Tracked;
        let begin = if tracked {
            format!(
                "let outer = std::mem::replace(&mut cx.tracking, Some(Vec::new())); let heap_outer = js::begin_heap_reads(Some({}));",
                owned_only(p)
            )
        } else {
            "let outer = cx.tracking.take(); let heap_outer = js::begin_heap_reads(None);"
                .to_string()
        };
        let end = if tracked {
            "let heap = js::end_heap_reads(heap_outer); let mut deps = std::mem::replace(&mut cx.tracking, outer).unwrap_or_default(); deps.extend(runic_runtime::Dep::heap(heap)); inst.borrow_mut().fx[e].deps = deps;"
        } else {
            "js::end_heap_reads(heap_outer); cx.tracking = outer;"
        };
        let cleanup = match &f.result {
            Type::Void => "Ok(_) => {}".to_string(),
            Type::Maybe(_) => {
                "Ok(Maybe::Some(f)) => inst.borrow_mut().fx[e].cleanup = Some(f), Ok(_) => {}"
                    .into()
            }
            _ => "Ok(f) => inst.borrow_mut().fx[e].cleanup = Some(f),".into(),
        };
        // A run of the render effect is a re-render (docs/IR.md, `restore`).
        if effect.render {
            prologue.push_str("inst.borrow_mut().renders += 1; ");
        }
        let _ = writeln!(
            run,
            "{e} => {{ {prologue}{begin} let snap = {{ let s = Rc::clone(&inst.borrow().snap); s }}; let r = f{fun}(cx, inst, &snap{args}); {end} inst.borrow_mut().fx[e].started = true; match r {{ {cleanup} Err(err) => eprintln!(\"runic: uncaught exception in an effect: {{err}}\"), }} }}",
            fun = effect.run
        );
    }
    let previous = if p.schedule.cleanup_reads_previous {
        (
            "cx.reading_previous = true; ",
            "cx.reading_previous = false; ",
        )
    } else {
        ("", "")
    };
    let _ = writeln!(
        out,
        "impl runic_runtime::CellVersions for St{k} {{ fn versions(&self) -> &[u64] {{ &self.ver }} }}\n\
         /// An instance of {name} for tree walks and effects.\npub struct H{k}(pub I{k});\n\
         const FX{k}: &[(u8, bool, bool)] = &[{meta}];\n\
         impl Inst for H{k} {{\n\
         fn key(&self) -> usize {{ Rc::as_ptr(&self.0) as *const u8 as usize }}\n\
         fn json(&self) -> runic_runtime::Json {{ runic_runtime::Json::Object([(\"component\".to_string(), runic_runtime::Json::String({name_str}.into())), (\"cells\".to_string(), cells_json_i{k}(&self.0))].into_iter().collect()) }}\n\
         fn changed(&self) -> bool {{ self.0.borrow().changed }}\n\
         fn fx_meta(&self) -> &'static [(u8, bool, bool)] {{ FX{k} }}\n\
         fn fx_due(&self, cx: &mut Cx, e: usize, updated: bool) -> bool {{ fx_due_i{k}(cx, &self.0, e, updated) }}\n\
         fn fx_cleanup(&self, cx: &mut Cx, e: usize) {{ let c = self.0.borrow_mut().fx[e].cleanup.take(); if let Some(c) = c {{ {set}let r = c(cx); {unset}if let Err(err) = r {{ eprintln!(\"runic: uncaught exception in a cleanup: {{err}}\"); }} }} }}\n\
         fn fx_run(&self, cx: &mut Cx, e: usize) {{ fx_run_i{k}(cx, &self.0, e) }}\n\
         }}\n\
         #[allow(unused_variables, unused_mut, unreachable_code)]\nfn fx_due_i{k}(cx: &mut Cx, inst: &I{k}, e: usize, updated: bool) -> bool {{\nlet started = inst.borrow().fx.get(e).is_some_and(|f| f.started);\nmatch e {{\n{due}_ => false,\n}}\n}}\n\
         #[allow(unused_variables, unused_mut, unreachable_code)]\nfn fx_run_i{k}(cx: &mut Cx, inst: &I{k}, e: usize) {{\nmatch e {{\n{run}_ => {{}}\n}}\n}}\n\
         /// Run the due effects of `phase` of an instance of {name}, each cleanup right before its effect.\n\
         fn fx_phase_i{k}(cx: &mut Cx, inst: &I{k}, phase: u8, updated: bool) {{ let h = H{k}(Rc::clone(inst)); for (e, m) in FX{k}.iter().enumerate() {{ if m.0 == phase && h.fx_due(cx, e, updated) {{ h.fx_cleanup(cx, e); h.fx_run(cx, e); }} }} }}",
        name = c.name.replace('\n', " "),
        name_str = rust_str(&c.name),
        set = previous.0,
        unset = previous.1,
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
        reactive: function_reactive_reads(p),
    };
    let mut planner = Planner::new(p);
    let root = planner.root(p.root);
    // Scheduling policies (docs/design/M4-EFFECTS.md).
    let event_microtask = p.schedule.flush == Flush::EventMicrotask;
    let per_listener = p.schedule.checkpoint == Checkpoint::Listener;
    // The document element starts with index.html's <html> attributes.
    let document_attrs: String = p
        .document
        .iter()
        .map(|(k, v)| format!("({}, {}), ", rust_str(k), rust_str(v)))
        .collect();
    let change_with_click = p.schedule.change_with_click;
    let tracked = |t: Tracking| {
        p.components
            .iter()
            .any(|c| c.cells.iter().any(|cell| cell.tracking == t))
    };
    // Reactive class fields hold proxied deep state (M6 stage B).
    let (tracks_deep, tracks_owned) = (
        tracked(Tracking::Deep),
        tracked(Tracking::Proxied) || p.has_reactive_fields(),
    );
    let post_deferred = p.schedule.post_writes_deferred;
    let batched = p.schedule.cleanups == Cleanups::Batched;
    let mount_timing = match p.schedule.mount {
        MountTiming::Sync => "self.flush(dom);",
        MountTiming::Microtask => "self.cx.jobs.queue_mount(false);",
        MountTiming::Task => "self.cx.jobs.queue_mount(true);",
    };
    let (root_pre, root_update_pre) = if p.components[p.root].effects.is_empty() {
        (String::new(), String::new())
    } else {
        (
            format!("fx_phase_i{}(&mut cx, &inst, 0, true);\n", p.root),
            format!(
                "{{ let u = self.cx.updated.get(&(Rc::as_ptr(&self.inst) as *const u8 as usize)).copied().unwrap_or(true); fx_phase_i{}(&mut self.cx, &self.inst, 0, u); }}\n",
                p.root
            ),
        )
    };
    let ri = p.root;
    let mut out = String::new();
    let _ = writeln!(
        out,
        "// Generated by runic-codegen from Runic IR schema {SCHEMA} ({ir_hash}). Do not edit.\n\
         #![allow(unused_parens, unused_variables, unused_mut, unused_assignments, unused_braces, dead_code, unused_imports, unused_labels, unreachable_code, unreachable_patterns, clippy::all)]\n\
         use runic_runtime::{{js, Dom, Event, NodeId}};\n\
         use runic_runtime::js::{{JsArray, JsMap, JsRef, JsResult, JsSet, JsString, Maybe}};\n\
         use std::cell::RefCell;\n\
         use std::rc::Rc;\n\
         #[allow(unused_macros)]\n\
         macro_rules! tri {{ ($e:expr, $l:lifetime) => {{ match $e {{ Ok(v) => v, Err(e) => break $l Err(e) }} }}; }}\n"
    );
    out.push_str(&records(p));
    // `batched_cleanups` mirrors the interpreter's definition, which follows
    // React's commit walk (react-dom `recursivelyTraverseMutationEffects`,
    // `recursivelyTraversePassiveUnmountEffects`).
    out.push_str(
        "/// Parent-owned slot content mounted inside a child.\n\
         pub trait Block<A> {\n\
         fn update(&mut self, cx: &mut Cx, dom: &mut Dom, args: A, parent: NodeId, after: Option<NodeId>) -> JsResult<()>;\n\
         fn sync(&self, cx: &mut Cx, dom: &mut Dom) -> JsResult<()>;\n\
         fn dispose(&self, cx: &mut Cx);\n\
         fn nodes(&self, out: &mut Vec<NodeId>);\n\
         fn first(&self) -> Option<NodeId>;\n\
         fn walk(&self, parent: usize, out: &mut Vec<(Rc<dyn Inst>, usize)>);\n\
         }\n\
         /// A live component instance, for tree walks and effects.\n\
         pub trait Inst {\n\
         fn key(&self) -> usize;\n\
         fn json(&self) -> runic_runtime::Json;\n\
         /// Whether a tracked cell changed in this flush pass.\n\
         fn changed(&self) -> bool;\n\
         /// Per effect: (phase 0 pre, 1 layout, 2 post; cleanup after DOM removal; children first at unmount).\n\
         fn fx_meta(&self) -> &'static [(u8, bool, bool)];\n\
         fn fx_due(&self, cx: &mut Cx, e: usize, updated: bool) -> bool;\n\
         fn fx_cleanup(&self, cx: &mut Cx, e: usize);\n\
         fn fx_run(&self, cx: &mut Cx, e: usize);\n\
         }\n\
         /// Instances of a tree walk (pre-order, with parent keys) with every instance after its children.\n\
         fn post_order(tree: &[(Rc<dyn Inst>, usize)]) -> Vec<Rc<dyn Inst>> {\n\
         fn visit(i: &Rc<dyn Inst>, tree: &[(Rc<dyn Inst>, usize)], out: &mut Vec<Rc<dyn Inst>>) { let k = i.key(); for (c, p) in tree { if *p == k { visit(c, tree, out); } } out.push(Rc::clone(i)); }\n\
         let keys: std::collections::HashSet<usize> = tree.iter().map(|(i, _)| i.key()).collect();\n\
         let mut out = Vec::new(); for (i, p) in tree { if !keys.contains(p) { visit(i, tree, &mut out); } } out\n\
         }\n\
         /// Cleanups selected by `which` (effect metadata) in the destroyed subtree of `i`, each at its unmount tree position.\n\
         fn teardown_at(cx: &mut Cx, i: &Rc<dyn Inst>, which: &dyn Fn(&(u8, bool, bool)) -> bool, set: &std::collections::HashSet<usize>, tree: &[(Rc<dyn Inst>, usize)]) {\n\
         for (e, m) in i.fx_meta().iter().enumerate() { if which(m) && !m.2 { i.fx_cleanup(cx, e); } }\n\
         let k = i.key(); for (c, p) in tree { if *p == k && set.contains(&c.key()) { teardown_at(cx, c, which, set, tree); } }\n\
         for (e, m) in i.fx_meta().iter().enumerate() { if which(m) && m.2 { i.fx_cleanup(cx, e); } }\n\
         }\n\
         /// Cleanups of destroyed instances at unmount: those before DOM removal, then those after, each at its tree position.\n\
         /// Under batched cleanups those of layout and post effects run in their phase's walk instead (`batched_cleanups`).\n\
         fn teardown(cx: &mut Cx, tree: &[(Rc<dyn Inst>, usize)], set: &std::collections::HashSet<usize>, batched: bool) {\n\
         if set.is_empty() { return; }\n\
         for after in [false, true] { for (i, p) in tree { if set.contains(&i.key()) && !set.contains(p) { teardown_at(cx, i, &|m| m.1 == after && !(batched && m.0 != 0), set, tree); } } }\n\
         }\n\
         /// The batched cleanups of `phase` in the subtree of live instance `i`: children first, and at each\n\
         /// instance the instances destroyed under it (`before` tree, each subtree in unmount order) before its live\n\
         /// children (`after` tree), then its own due cleanups (the interpreter's `batched_cleanups`).\n\
         fn batched_cleanups(cx: &mut Cx, i: &Rc<dyn Inst>, phase: u8, due: &[(Rc<dyn Inst>, usize)], after: &[(Rc<dyn Inst>, usize)], set: &std::collections::HashSet<usize>, before: &[(Rc<dyn Inst>, usize)]) {\n\
         let k = i.key();\n\
         for (d, p) in before { if *p == k && set.contains(&d.key()) { teardown_at(cx, d, &|m| m.0 == phase, set, before); } }\n\
         for (c, p) in after { if *p == k && c.key() != k { batched_cleanups(cx, c, phase, due, after, set, before); } }\n\
         for (j, e) in due { if j.key() == k { j.fx_cleanup(cx, *e); } }\n\
         }\n",
    );
    for k in 0..p.components.len() {
        component_state(p, k, &mut out);
        component_effects(p, k, &mut out);
        component_derived(p, k, &mut out);
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
    let commit_ignored = p.schedule.commit_events_ignored;
    let _ = writeln!(
        out,
        "pub type Lst = Rc<dyn Fn(&mut Cx) -> JsResult<()>>;\n\
         /// A listener of an attribute bag (called with the event).\n\
         pub type Bag = Rc<dyn Fn(&mut Cx, js::Event) -> JsResult<()>>;\n\
         /// Run event listeners nested in the running script (focus events of\n\
         /// focus()/blur()): at once, with no microtask checkpoint; their\n\
         /// exceptions are reported, not propagated.\n\
         /// Focus events dispatched during the DOM update: without element\n\
         /// listeners where the framework ignores them during its commit.\n\
         #[allow(unused_mut)]\n\
         fn commit_events(mut events: Vec<(js::Event, Event, Vec<runic_runtime::Delivery>)>) -> Vec<(js::Event, Event, Vec<runic_runtime::Delivery>)> {{ if {commit_ignored} {{ for e in events.iter_mut() {{ e.2.clear(); }} }} events }}\n\
         fn run_nested(cx: &mut Cx, events: Vec<(js::Event, Event, Vec<runic_runtime::Delivery>)>) {{\n\
         for (ev, kind, deliveries) in events {{\n\
         let mut calls: Vec<(u32, u64)> = deliveries.iter().map(|d| (d.listener, d.current)).collect();\n\
         if kind.bubbles() {{ for (window, current) in [(false, js::Element::DOCUMENT), (true, js::Element::WINDOW)] {{ for h in cx.host.iter().filter(|h| h.0 == window && h.1 == kind) {{ calls.push((h.3, current.0)); }} }} }}\n\
         for (key, current) in calls {{\n\
         let Some(f) = cx.listeners.get(key as usize).cloned().flatten() else {{ continue }};\n\
         if !ev.enter(js::Element(current)) {{ continue; }}\n\
         let outer = (cx.payload.take(), cx.event.take());\n\
         cx.payload = ev.payload(); cx.event = Some(ev.clone());\n\
         let r = f(cx);\n\
         (cx.payload, cx.event) = outer;\n\
         if let Err(e) = r {{ eprintln!(\"runic: uncaught exception in a focus listener: {{e}}\"); }}\n\
         }}\n\
         ev.finish();\n\
         }}\n\
         }}\n\
         /// A timer callback (`setTimeout`/`setInterval`, or an animation frame receiving the time).\n\
         #[derive(Clone)]\npub enum TimerCb {{ Plain(Rc<dyn Fn(&mut Cx) -> JsResult<()>>), Frame(Rc<dyn Fn(&mut Cx, f64) -> JsResult<()>>) }}\n\
         pub struct Cx {{ pub force_sync: bool, pub payload: Option<JsString>, pub event: Option<js::Event>, pub root: runic_runtime::css::Root, pub media: runic_runtime::css::MediaEnv, pub host: Vec<(bool, Event, usize, u32)>, pub media_host: Vec<(js::MediaQueryList, usize, u32)>, pub listeners: Vec<Option<Lst>>, pub free: Vec<u32>, pub dom: runic_runtime::Host, pub timers: runic_runtime::Timers<TimerCb>, pub jobs: runic_runtime::Jobs<Lst>, pub stable: std::collections::HashMap<usize, Rc<dyn std::any::Any>>, pub tracking: Option<Vec<runic_runtime::Dep<Cx>>>, pub flush_promise: Option<js::JsPromise<(), Lst>>, pub storage: runic_runtime::Storage, pub random: runic_runtime::Random, pub host_tasks: std::collections::VecDeque<HostTask>, pub reading_previous: bool, pub rh: bool, pub updated: std::collections::HashMap<usize, bool>, pub destroyed: Vec<Rc<dyn Inst>>, {live}{globals}}}\n\
         impl runic_runtime::Microtasks for Cx {{ fn queue_microtask(&mut self, job: Lst) {{ self.jobs.queue(job); }} }}\n\
         impl Cx {{\n\
         fn new() -> Self {{ Cx {{ force_sync: false, payload: None, event: None, root: runic_runtime::css::Root::with_attrs([{document_attrs}]), media: runic_runtime::media_env(), host: Vec::new(), media_host: Vec::new(), listeners: Vec::new(), free: Vec::new(), dom: Default::default(), timers: runic_runtime::Timers::new(runic_runtime::clock_origin()), jobs: runic_runtime::Jobs::new({event_microtask}, {tracks_deep}, {tracks_owned}, {post_deferred}), stable: std::collections::HashMap::new(), tracking: None, flush_promise: None, storage: runic_runtime::Storage::open(<App as runic_runtime::App>::TITLE), random: runic_runtime::Random::new(), host_tasks: Default::default(), reading_previous: false, rh: false, updated: std::collections::HashMap::new(), destroyed: Vec::new(), {live_init}{globals_init}}} }}\n\
         fn listen(&mut self, f: Lst) -> u32 {{ match self.free.pop() {{ Some(k) => {{ self.listeners[k as usize] = Some(f); k }} None => {{ self.listeners.push(Some(f)); (self.listeners.len() - 1) as u32 }} }} }}\n\
         }}\n"
    );
    out.push_str(HOST_SERVICES);
    derived_fields(p, &mut out);
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
            cx.snap = true;
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
                "#[allow(unused_mut, unused_variables, unused_assignments, unreachable_code, unused_labels)]\nfn handler_{k}_{h}(cx: &mut Cx, inst: &I{k}{sig}) -> JsResult<()> {{\nlet snap = &{{ let s = Rc::clone(&inst.borrow().snap); s }};\n{locals}{body}Ok(())\n}}\n"
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
    // React restores controlled values after every event, even when the
    // event wrote no state.
    let restore_controlled = if p.schedule.controlled_restore {
        format!(
            "if let Some((_, s)) = self.root.as_ref() {{ if let Err(e) = sync_s{root}(s, &mut self.cx, dom, &self.inst, &self.t) {{ eprintln!(\"runic: render error: {{e}}\"); }} }}\n"
        )
    } else {
        String::new()
    };
    let _ = writeln!(
        out,
        "pub struct App {{ cx: Cx, inst: I{ri}, t: Rc<RefCell<T{ri}>>, root: Option<(NodeId, Box<S{root}>)> }}\n\
         impl App {{\n\
         fn free(&mut self, dom: &mut Dom) {{ for k in dom.take_freed() {{ self.cx.listeners[k as usize] = None; self.cx.free.push(k); }} }}\n\
         /// Run a task (event listeners or a timer callback), its microtask checkpoint and the default tasks it queued.\n\
         fn task(&mut self, dom: &mut Dom, event: bool, f: impl FnOnce(&mut Cx) -> JsResult<()>) -> JsResult<()> {{\n\
         self.cx.dom = runic_runtime::Host::attach(dom);\n\
         self.cx.jobs.in_event = event;\n\
         let result = f(&mut self.cx);\n\
         if self.cx.root.take_dirty() {{ dom.apply_root(&self.cx.root); }}\n\
         self.cx.payload = None;\n\
         if let Err(e) = &result {{ if e.name.to_rust() == \"RunicDomainError\" {{\n{rollback}self.cx.jobs.clear();\nself.cx.jobs.in_event = false;\n// Re-synchronise controlled inputs.\nself.cx.force_sync = true;\nself.flush(dom);\nself.cx.force_sync = false;\nreturn result;\n}} }}\n\
         self.checkpoint(dom);\n\
         self.cx.jobs.in_event = false;\n\
         while let Some(job) = self.cx.jobs.next_default() {{ self.run_job(dom, job); self.checkpoint(dom); }}\n\
         if self.cx.root.take_dirty() {{ dom.apply_root(&self.cx.root); }}\n\
         self.cx.dom = Default::default();\n\
         result\n}}\n\
         fn checkpoint(&mut self, dom: &mut Dom) {{ while let Some(job) = self.cx.jobs.next_microtask() {{ self.run_job(dom, job); }} if self.cx.root.take_dirty() {{ dom.apply_root(&self.cx.root); }} dom.settle_selects(); }}\n\
         fn run_job(&mut self, dom: &mut Dom, job: runic_runtime::Job<Lst>) {{\n\
         self.cx.dom = runic_runtime::Host::attach(dom);\n\
         match job {{\n\
         runic_runtime::Job::Call(f) => {{ if let Err(e) = f(&mut self.cx) {{ eprintln!(\"runic: uncaught exception in a microtask: {{e}}\"); }} if self.cx.root.take_dirty() {{ dom.apply_root(&self.cx.root); }} }}\n\
         runic_runtime::Job::Flush => self.flush(dom),\n\
         runic_runtime::Job::FlushThen(f) => {{ if self.cx.jobs.take_flush() {{ self.flush(dom); }} if let Err(e) = f(&mut self.cx) {{ eprintln!(\"runic: uncaught exception in a microtask: {{e}}\"); }} }}\n}}\n}}\n\
         /// The flush job: compute dirty cells since the last flush, commit render snapshots and update the DOM.\n\
         /// Live instances in tree order with their parents' keys (the root's is 0).\n\
         fn walk(&self) -> Vec<(Rc<dyn Inst>, usize)> {{ let mut out: Vec<(Rc<dyn Inst>, usize)> = vec![(Rc::new(H{ri}(Rc::clone(&self.inst))), 0)]; if let Some((_, s)) = &self.root {{ walk_s{root}(s, Rc::as_ptr(&self.inst) as *const u8 as usize, &mut out); }} out }}\n\
         /// The flush job: passes until effects stop writing.\n\
         fn flush(&mut self, dom: &mut Dom) {{\n\
         self.cx.jobs.flush_started();\n\
         for pass in 0..=1000usize {{\n\
         if pass == 1000 {{ eprintln!(\"runic: uncaught exception: Maximum update depth exceeded: effects keep writing state\"); break; }}\n\
         self.cx.jobs.again = false;\n\
         self.flush_pass(dom);\n\
         self.cx.jobs.note_mutations();\n\
         if !self.cx.jobs.again {{ break; }}\n\
         }}\n\
         self.cx.jobs.flush_ended();\n\
         if let Some(p) = self.cx.flush_promise.take() {{ runic_runtime::promises::settle(&mut self.cx, &p, Ok(())); }}\n\
         }}\n\
         /// One pass: commit the state, update the DOM (pre effects run as each instance updates), tear down destroyed instances, then layout and post effects children first.\n\
         fn flush_pass(&mut self, dom: &mut Dom) {{\n\
         self.cx.jobs.phase = Some(runic_runtime::Phase::Pre);\n\
         let (deep, owned) = self.cx.jobs.take_mutated();\n\
         // Signal fields of class instances (or deep state through proxies) written since the last pass: bindings that may read them re-evaluate.\n\
         self.cx.rh = js::take_signal_writes();\n\
         {end}\
         {begin}\
         let tree = self.walk();\n\
         let mut updated: std::collections::HashMap<usize, bool> = std::collections::HashMap::new();\n\
         for (i, p) in &tree {{ let u = i.changed() || updated.get(p).copied().unwrap_or(false); updated.insert(i.key(), u); }}\n\
         self.cx.updated = updated;\n\
         {root_update_pre}\
         if let Some((parent, s)) = self.root.as_mut() {{\n\
         if let Err(e) = update_s{root}(s, &mut self.cx, dom, &self.inst, &self.t, false, *parent, None) {{ eprintln!(\"runic: render error: {{e}}\"); }}\n\
         if let Err(e) = sync_s{root}(s, &mut self.cx, dom, &self.inst, &self.t) {{ eprintln!(\"runic: render error: {{e}}\"); }}\n}}\n\
         // Mutations while rendering are not writes.\n\
         self.cx.jobs.take_mutated();\n\
         {restore}\
         if self.cx.root.take_dirty() {{ dom.apply_root(&self.cx.root); }}\n\
         self.free(dom);\n\
         let destroyed: std::collections::HashSet<usize> = self.cx.destroyed.drain(..).map(|i| i.key()).collect();\n\
         teardown(&mut self.cx, &tree, &destroyed, {batched});\n\
         let after = self.walk();\n\
         let post = post_order(&after);\n\
         let keys: std::collections::HashSet<usize> = after.iter().map(|(i, _)| i.key()).collect();\n\
         for (phase, p) in [(1u8, runic_runtime::Phase::Layout), (2u8, runic_runtime::Phase::Post)] {{\n\
         self.cx.jobs.phase = Some(p);\n\
         let mut due = Vec::new();\n\
         for i in &post {{ let u = self.cx.updated.get(&i.key()).copied().unwrap_or(true); for (e, m) in i.fx_meta().iter().enumerate() {{ if m.0 != phase {{ continue; }} if {batched} {{ if i.fx_due(&mut self.cx, e, u) {{ due.push((Rc::clone(i), e)); }} }} else if i.fx_due(&mut self.cx, e, u) {{ i.fx_cleanup(&mut self.cx, e); i.fx_run(&mut self.cx, e); }} }} }}\n\
         if {batched} {{ for (r, p) in &after {{ if !keys.contains(p) {{ batched_cleanups(&mut self.cx, r, phase, &due, &after, &destroyed, &tree); }} }} }}\n\
         for (i, e) in &due {{ i.fx_run(&mut self.cx, *e); }}\n\
         }}\n\
         if self.cx.root.take_dirty() {{ dom.apply_root(&self.cx.root); }}\n\
         }}\n\
         }}\n\
         impl runic_runtime::App for App {{\n\
         const TITLE: &'static str = {title};\n\
         const CSS: &'static str = {css};\n\
         const ASSETS: &'static [(&'static str, &'static [u8])] = &[{assets}];\n\
         const IR_HASH: &'static str = {hash};\n\
         const CHANGE_WITH_CLICK: bool = {change_with_click};\n\
         fn new() -> Self {{\nlet mut cx = Cx::new();\n(|| -> JsResult<()> {{ let cx = &mut cx; {init_globals}Ok(()) }})().expect(\"module constants\");\nlet inst = new_i{ri}(&mut cx);\ninit_i{ri}(&mut cx, &inst).expect(\"initial state\");\n{root_pre}App {{ cx, inst, t: Rc::new(RefCell::new(T{ri}::default())), root: None }}\n}}\n\
         fn mount(&mut self, dom: &mut Dom, parent: NodeId) {{\n\
         self.cx.dom = runic_runtime::Host::attach(dom);\n\
         {container}match mount_s{root}(&mut self.cx, dom, &self.inst, &self.t, parent, None) {{\n\
         Ok(s) => self.root = Some((parent, s)),\n\
         Err(e) => eprintln!(\"runic: render error: {{e}}\"),\n}}\n\
         self.free(dom);\n\
         self.cx.jobs.flush_ended();\n\
         {mount_timing}\n\
         self.checkpoint(dom);\n\
         while let Some(job) = self.cx.jobs.next_default() {{ self.run_job(dom, job); self.checkpoint(dom); }}\n}}\n\
         fn dispatch(&mut self, dom: &mut Dom, deliveries: &[runic_runtime::Delivery]) -> Result<(), String> {{\n\
         // Listeners are resolved before any runs (a flush may free and reuse their slots).\n\
         let resolved: Vec<(Lst, js::Event, u64)> = deliveries.iter().filter_map(|d| self.cx.listeners.get(d.listener as usize).cloned().flatten().map(|f| (f, d.event.clone(), d.current))).collect();\n\
         let groups: Vec<Vec<(Lst, js::Event, u64)>> = if {per_listener} {{ resolved.into_iter().map(|l| vec![l]).collect() }} else {{ vec![resolved] }};\n\
         let mut first: Option<String> = None;\n\
         for group in groups {{\n\
         let r = self.task(dom, true, |cx| {{ let mut err = None; for (f, ev, current) in group {{ if !ev.enter(js::Element(current)) {{ continue; }} cx.payload = ev.payload(); cx.event = Some(ev); let r = f(cx); cx.event = None; if let Err(e) = r {{ if e.name.to_rust() == \"RunicDomainError\" {{ return Err(e); }} err.get_or_insert(e); }} }} cx.payload = None; err.map_or(Ok(()), Err) }});\n\
         if let Err(e) = r {{ first.get_or_insert(e.to_string()); }}\n}}\n\
         {restore_controlled}\
         first.map_or(Ok(()), Err)\n}}\n\
         fn host_listeners(&self, window: bool, event: Event) -> Vec<u32> {{ self.cx.host.iter().filter(|h| h.0 == window && h.1 == event).map(|h| h.3).collect() }}\n\
         fn media_changed(&mut self) -> Vec<(js::Event, Vec<u32>)> {{ self.cx.media = runic_runtime::media_env(); let mut lists: Vec<js::MediaQueryList> = Vec::new(); for h in &self.cx.media_host {{ if !lists.contains(&h.0) {{ lists.push(h.0.clone()); }} }} lists.sort_by_key(|l| l.order()); let mut out = Vec::new(); for list in lists {{ let m = runic_runtime::css::media_matches(list.query(), &self.cx.media).unwrap_or(false); if list.update(m) {{ let keys = self.cx.media_host.iter().filter(|h| h.0 == list).map(|h| h.2).collect(); out.push((js::Event::new(js::EventData {{ kind: JsString::from(\"change\"), matches: m, ..Default::default() }}), keys)); }} }} out }}\n\
         fn advance(&mut self, dom: &mut Dom, to: f64) {{\n\
         while let Some((_, cb)) = self.cx.timers.take_due(to) {{\n\
         self.cx.timers.during_tick = true;\n\
         let result = self.task(dom, false, |cx| match cb {{ TimerCb::Plain(f) => f(cx), TimerCb::Frame(f) => {{ let t = cx.timers.now; f(cx, t) }} }});\n\
         self.cx.timers.during_tick = false;\n\
         if let Err(e) = result {{ eprintln!(\"runic: uncaught exception in a timer: {{e}}\"); }}\n\
         }}\n\
         if self.cx.timers.now < to {{ self.cx.timers.now = to; }}\n\
         }}\n\
         fn host_task(&mut self, dom: &mut Dom) -> Option<Option<Event>> {{\n\
         let task = self.cx.host_tasks.pop_front()?;\n\
         Some(match task {{\n\
         HostTask::ClipboardWrite(text, p) => {{ let r = self.task(dom, false, |cx| {{ let outcome = runic_runtime::clipboard::write(&text).map_err(|m| js::Throw::new(\"NotAllowedError\", m)); runic_runtime::promises::settle(cx, &p, outcome); Ok(()) }}); if let Err(e) = r {{ eprintln!(\"runic: uncaught exception: {{e}}\"); }} None }}\n\
         HostTask::ClipboardRead(p) => {{ let r = self.task(dom, false, |cx| {{ let outcome = runic_runtime::clipboard::read().map_err(|m| js::Throw::new(\"NotAllowedError\", m)); runic_runtime::promises::settle(cx, &p, outcome); Ok(()) }}); if let Err(e) = r {{ eprintln!(\"runic: uncaught exception: {{e}}\"); }} None }}\n\
         HostTask::Traverse(delta) => match runic_runtime::history::traverse(delta) {{\n\
         Ok(Some(t)) => {{ if t.hashchange {{ self.cx.host_tasks.push_front(HostTask::HashChange); }} Some(Event::Popstate) }}\n\
         Ok(None) => None,\n\
         Err(e) => {{ runic_runtime::unsupported(&e.message.to_rust()); None }}\n\
         }},\n\
         HostTask::HashChange => Some(Event::Hashchange),\n\
         }})\n\
         }}\n\
         fn traverse(&mut self, delta: i64) {{ self.cx.host_tasks.push_back(HostTask::Traverse(delta)); }}\n\
         fn next_timer(&self) -> Option<f64> {{ self.cx.timers.next_due() }}\n\
         fn now(&self) -> f64 {{ self.cx.timers.now }}\n\
         fn cells_json(&self) -> runic_runtime::Json {{ cells_json_i{ri}(&self.inst) }}\n\
         fn instances_json(&self) -> Vec<runic_runtime::Json> {{ self.walk().iter().skip(1).map(|(i, _)| i.json()).collect() }}\n\
         }}",
        title = rust_str(&p.meta.title),
        css = rust_str(css),
        hash = rust_str(ir_hash),
        restore = if p.restore_focus {
            "{ let events = commit_events(dom.restore_focus()); if !events.is_empty() { run_nested(&mut self.cx, events); } }\n"
        } else {
            ""
        },
    );
    Ok(out)
}
