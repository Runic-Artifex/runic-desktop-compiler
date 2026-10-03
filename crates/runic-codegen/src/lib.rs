//! Rust code generation from validated Runic IR (schema 4).
//!
//! The generated module implements `runic_runtime::App`:
//! - records become structs behind `JsRef` (reference identity);
//! - every IR function becomes `fn fN(cx: &mut Cx, captures…, params…)`;
//! - each template scope (component root, conditional branch) becomes a
//!   struct with node handles and the last written binding values;
//! - after a handler, dirty cells (SameValue changes, plus deep cells after
//!   heap mutation) drive targeted DOM updates, and live input values are
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
}

struct PlanScope<'a> {
    items: Vec<Item<'a>>,
}

#[derive(Default)]
struct Planner<'a> {
    scopes: Vec<Option<PlanScope<'a>>>,
    key: usize,
}

impl<'a> Planner<'a> {
    fn scope(&mut self, nodes: &'a [Node]) -> usize {
        let id = self.scopes.len();
        self.scopes.push(None);
        let items = self.items(nodes);
        self.scopes[id] = Some(PlanScope { items });
        id
    }
    fn items(&mut self, nodes: &'a [Node]) -> Vec<Item<'a>> {
        nodes.iter().map(|n| self.item(n)).collect()
    }
    fn item(&mut self, n: &'a Node) -> Item<'a> {
        self.key += 1;
        let key = self.key;
        match n {
            Node::Text { parts, .. } => Item::Text { key, parts },
            Node::Element { children, .. } => Item::Element {
                key,
                node: n,
                children: self.items(children),
            },
            Node::If {
                test,
                then,
                otherwise,
                ..
            } => {
                let then = self.scope(then);
                let otherwise = self.scope(otherwise);
                Item::If {
                    key,
                    test,
                    then,
                    otherwise,
                }
            }
        }
    }
}

/// Rust expression for the first mounted node among `items` of scope `s`,
/// falling back to `tail`.
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
        };
        let is_static = !matches!(item, Item::If { .. });
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
    component: usize,
    optimize: bool,
    reads: Vec<Option<BTreeSet<usize>>>,
}

#[derive(Default)]
struct Out {
    fields: Vec<(String, String)>,
    mount: String,
    update: String,
    sync: String,
}

impl Gen<'_> {
    fn ctx(&self) -> FnCtx<'_> {
        FnCtx::new(self.p, Some(self.component), vec![], false, Type::Void)
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

    fn guard(&self, exprs: &[&Expr]) -> String {
        if !self.optimize {
            return "true".into();
        }
        match self.deps(exprs) {
            None => "true".into(),
            Some(d) if d.is_empty() => "false".into(),
            Some(d) => d
                .iter()
                .map(|c| format!("dirty[{c}]"))
                .collect::<Vec<_>>()
                .join(" || "),
        }
    }

    fn is_static(&self, exprs: &[&Expr]) -> bool {
        self.deps(exprs).is_some_and(|d| d.is_empty())
    }

    fn scope(&self, id: usize, scope: &PlanScope) -> String {
        let mut o = Out::default();
        for (i, item) in scope.items.iter().enumerate() {
            self.item(item, &mut o, None, &scope.items[i + 1..]);
        }
        let mut remove = String::new();
        for item in &scope.items {
            match item {
                Item::Text { key, .. } | Item::Element { key, .. } => {
                    let _ = writeln!(remove, "dom.remove(s.n{key});");
                }
                Item::If {
                    key,
                    then,
                    otherwise,
                    ..
                } => {
                    let _ = writeln!(
                        remove,
                        "if let Some(b) = &s.then{key} {{ remove_s{then}(b, dom); }}\nif let Some(b) = &s.else{key} {{ remove_s{otherwise}(b, dom); }}"
                    );
                }
            }
        }
        let fields: String = o
            .fields
            .iter()
            .map(|(n, t)| format!("{n}: {t}, "))
            .collect();
        let inits: String = o.fields.iter().map(|(n, _)| format!("{n}, ")).collect();
        let first = first_of(&scope.items, "None");
        format!(
            "pub struct S{id} {{ {fields}}}\n\
             #[allow(unused_variables)]\nfn mount_s{id}(cx: &mut Cx, dom: &mut Dom, parent: NodeId, before: Option<NodeId>) -> JsResult<Box<S{id}>> {{\n{mount}Ok(Box::new(S{id} {{ {inits}}}))\n}}\n\
             #[allow(unused_variables)]\nfn update_s{id}(s: &mut S{id}, cx: &mut Cx, dom: &mut Dom, dirty: &[bool], parent: NodeId, after: Option<NodeId>) -> JsResult<()> {{\n{update}Ok(())\n}}\n\
             #[allow(unused_variables)]\nfn sync_s{id}(s: &S{id}, cx: &mut Cx, dom: &mut Dom) -> JsResult<()> {{\n{sync}Ok(())\n}}\n\
             fn first_s{id}(s: &S{id}) -> Option<NodeId> {{ {first} }}\n\
             fn remove_s{id}(s: &S{id}, dom: &mut Dom) {{\n{remove}}}\n\n",
            mount = o.mount,
            update = o.update,
            sync = o.sync,
        )
    }

    /// DOM text of a string-typed expression.
    fn text_value(&self, parts: &[Expr]) -> String {
        let mut cx = self.ctx();
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

    fn item(&self, item: &Item, o: &mut Out, parent: Option<usize>, following: &[Item]) {
        let attach = |field: &str| match parent {
            Some(p) => format!("dom.append(n{p}, {field});\n"),
            None => format!("dom.insert(parent, {field}, before);\n"),
        };
        match item {
            Item::Text { key, parts } => {
                let k = *key;
                o.fields.push((format!("n{k}"), "NodeId".into()));
                let value = self.text_value(parts);
                let refs: Vec<&Expr> = parts.iter().collect();
                if self.is_static(&refs) {
                    let _ = writeln!(o.mount, "let n{k} = dom.text(&{value});");
                } else {
                    o.fields.push((format!("v{k}"), "String".into()));
                    let _ = writeln!(o.mount, "let v{k} = {value};\nlet n{k} = dom.text(&v{k});");
                    let guard = self.guard(&refs);
                    let _ = writeln!(
                        o.update,
                        "if {guard} {{ let v = {value}; if v != s.v{k} {{ dom.set_text(s.n{k}, &v); s.v{k} = v; }} }}"
                    );
                }
                o.mount.push_str(&attach(&format!("n{k}")));
            }
            Item::Element {
                key,
                node,
                children,
            } => {
                let k = *key;
                let Node::Element {
                    tag,
                    attrs,
                    props,
                    listeners,
                    ..
                } = node
                else {
                    unreachable!()
                };
                o.fields.push((format!("n{k}"), "NodeId".into()));
                let _ = writeln!(o.mount, "let n{k} = dom.element({});", rust_str(tag));
                for (i, a) in attrs.iter().enumerate() {
                    let mut cx = self.ctx();
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
                            write(&format!("n{k}"), "v")
                        );
                    } else {
                        let cache = format!("a{k}_{i}");
                        o.fields.push((cache.clone(), rty.into()));
                        let _ = writeln!(
                            o.mount,
                            "let {cache} = {value};\n{}",
                            write(&format!("n{k}"), &cache)
                        );
                        let guard = self.guard(&[&a.value]);
                        let _ = writeln!(
                            o.update,
                            "if {guard} {{ let v = {value}; if v != s.{cache} {{ {} s.{cache} = v; }} }}",
                            write(&format!("s.n{k}"), "v")
                        );
                    }
                }
                for p in props {
                    let value = format!("{}.to_rust()", self.ctx().expr(&p.value));
                    let _ = writeln!(o.mount, "dom.set_value(n{k}, &{value});");
                    let _ = writeln!(o.sync, "{{ let v = {value}; dom.set_value(s.n{k}, &v); }}");
                }
                for l in listeners {
                    let ev = match l.event {
                        EventKind::Click => "Event::Click",
                        EventKind::Input => "Event::Input",
                    };
                    let _ = writeln!(o.mount, "dom.listen(n{k}, {ev}, {});", l.handler);
                }
                for (i, c) in children.iter().enumerate() {
                    self.item(c, o, Some(k), &children[i + 1..]);
                }
                o.mount.push_str(&attach(&format!("n{k}")));
            }
            Item::If {
                key,
                test,
                then,
                otherwise,
            } => {
                let k = *key;
                let (t, e) = (*then, *otherwise);
                let test_rs = self.ctx().expr(test);
                o.fields.push((format!("t{k}"), "bool".into()));
                o.fields
                    .push((format!("then{k}"), format!("Option<Box<S{t}>>")));
                o.fields
                    .push((format!("else{k}"), format!("Option<Box<S{e}>>")));
                let (mp, mb, up, tail) = match parent {
                    Some(p) => (format!("n{p}"), "None", format!("s.n{p}"), "None"),
                    None => ("parent".into(), "before", "parent".into(), "after"),
                };
                let _ = writeln!(
                    o.mount,
                    "let t{k} = {test_rs};\n\
                     let then{k} = if t{k} {{ Some(mount_s{t}(cx, dom, {mp}, {mb})?) }} else {{ None }};\n\
                     let else{k} = if t{k} {{ None }} else {{ Some(mount_s{e}(cx, dom, {mp}, {mb})?) }};"
                );
                let anchor = first_of(following, tail);
                let guard = self.guard(&[test]);
                let _ = writeln!(
                    o.update,
                    "{{\n\
                     let t = if {guard} {{ {test_rs} }} else {{ s.t{k} }};\n\
                     let anchor = {anchor};\n\
                     if t != s.t{k} {{\n\
                     if let Some(b) = s.then{k}.take() {{ remove_s{t}(&b, dom); }}\n\
                     if let Some(b) = s.else{k}.take() {{ remove_s{e}(&b, dom); }}\n\
                     if t {{ s.then{k} = Some(mount_s{t}(cx, dom, {up}, anchor)?); }} else {{ s.else{k} = Some(mount_s{e}(cx, dom, {up}, anchor)?); }}\n\
                     s.t{k} = t;\n\
                     }} else {{\n\
                     if let Some(b) = s.then{k}.as_mut() {{ update_s{t}(b, cx, dom, dirty, {up}, anchor)?; }}\n\
                     if let Some(b) = s.else{k}.as_mut() {{ update_s{e}(b, cx, dom, dirty, {up}, anchor)?; }}\n\
                     }}\n\
                     }}"
                );
                let _ = writeln!(
                    o.sync,
                    "if let Some(b) = &s.then{k} {{ sync_s{t}(b, cx, dom)?; }}\nif let Some(b) = &s.else{k} {{ sync_s{e}(b, cx, dom)?; }}"
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
        let _ = writeln!(
            out,
            "/// {}\n#[derive(Clone)]\npub struct R{r} {{ {fields}}}\n\
             impl Default for R{r} {{ fn default() -> Self {{ R{r} {{ {defaults}}} }} }}\n\
             impl js::HeapToString for R{r} {{ fn heap_to_string(&self) -> JsString {{ JsString::from(\"[object Object]\") }} }}\n\
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
    }
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
    let ci = p.root;
    let c = &p.components[ci];
    let reads = function_reads(p);
    let g = Gen {
        p,
        component: ci,
        optimize: options.optimize,
        reads,
    };
    let mut planner = Planner::default();
    let root = planner.scope(&c.template);
    let mut out = String::new();
    let _ = writeln!(
        out,
        "// Generated by runic-codegen from Runic IR schema {SCHEMA} ({ir_hash}). Do not edit.\n\
         #![allow(unused_parens, unused_variables, unused_mut, unused_braces, dead_code, unused_imports, unused_labels, unreachable_code, clippy::all)]\n\
         use runic_runtime::{{js, Dom, Event, NodeId}};\n\
         use runic_runtime::js::{{JsArray, JsMap, JsRef, JsResult, JsSet, JsString, Maybe}};\n\
         use std::cell::RefCell;\n\
         use std::rc::Rc;\n\
         #[allow(unused_macros)]\n\
         macro_rules! tri {{ ($e:expr, $l:lifetime) => {{ match $e {{ Ok(v) => v, Err(e) => break $l Err(e) }} }}; }}\n"
    );
    out.push_str(&records(p));
    // Cells and context.
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
    let _ = writeln!(
        out,
        "#[derive(Clone)]\npub struct Cells {{ {fields}}}\n\
         impl Default for Cells {{ fn default() -> Self {{ Cells {{ {defaults}}} }} }}\n\
         pub struct Cx {{ pub c: Cells, pub snap: Cells, pub payload: Option<JsString> }}\n"
    );
    // Functions.
    let mut errors = vec![];
    for f in 0..p.functions.len() {
        out.push_str(&expr::function(p, f, &mut errors));
    }
    // Handlers.
    for (h, handler) in c.handlers.iter().enumerate() {
        let mut cx = FnCtx::new(
            p,
            Some(ci),
            handler.locals.clone(),
            handler.event == EventKind::Input,
            Type::Void,
        );
        let body = cx.block(&handler.body);
        errors.extend(cx.errors.iter().map(|e| format!("handler {h}: {e}")));
        let locals: String = handler
            .locals
            .iter()
            .enumerate()
            .map(|(i, l)| {
                if l.boxed {
                    format!(
                        "let mut l{i}: Rc<RefCell<{}>> = Rc::new(RefCell::new({}));\n",
                        rust_type(&l.ty),
                        default_value(&l.ty, p)
                    )
                } else {
                    format!(
                        "let mut l{i}: {} = {};\n",
                        rust_type(&l.ty),
                        default_value(&l.ty, p)
                    )
                }
            })
            .collect();
        let _ = writeln!(
            out,
            "#[allow(unused_mut, unused_variables, unused_assignments, unreachable_code, unused_labels)]\nfn handler_{h}(cx: &mut Cx) -> JsResult<()> {{\n{locals}{body}Ok(())\n}}\n"
        );
    }
    if !errors.is_empty() {
        return Err(Diagnostic::new("E_CODEGEN", errors.join("; "), None));
    }
    // Scopes.
    for (id, scope) in planner.scopes.iter().enumerate() {
        out.push_str(&g.scope(id, scope.as_ref().expect("planned scope")));
    }
    // Initial cells.
    let mut init = String::new();
    for (i, cell) in c.cells.iter().enumerate() {
        let mut cx = FnCtx::new(p, Some(ci), vec![], false, Type::Void);
        let v = cx.expr(&cell.init);
        let _ = writeln!(
            init,
            "cx.c.c{i} = (|| -> JsResult<_> {{ let cx = &mut cx; Ok({v}) }})().expect(\"initial value of {}\");\ncx.snap.c{i} = cx.c.c{i}.clone();",
            cell.name.escape_default()
        );
        if let Some(Domain::Text { max_utf16 }) = cell.domain {
            let _ = writeln!(
                init,
                "assert!(js::valid_single_line(&cx.c.c{i}.to_rust(), {max_utf16}), \"initial text domain\");"
            );
        }
    }
    let n = c.cells.len();
    let dirty: String = c
        .cells
        .iter()
        .enumerate()
        .map(|(i, cell)| {
            let same = same_expr(
                &cell.ty,
                &format!("before.c{i}"),
                &format!("self.cx.c.c{i}"),
            );
            match cell.tracking {
                Tracking::None => "false, ".to_string(),
                Tracking::Deep if cell.ty.is_reference() => format!("(!{same} || deep), "),
                _ => format!("!{same}, "),
            }
        })
        .collect();
    let dispatch_arms: String = (0..c.handlers.len())
        .map(|h| format!("{h} => handler_{h}(&mut self.cx),\n"))
        .collect();
    let cells_json: String = c
        .cells
        .iter()
        .enumerate()
        .map(|(i, cell)| format!("{}, ", probe_json(&cell.ty, &format!("self.cx.c.c{i}"))))
        .collect();
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
        "pub struct App {{ cx: Cx, root: Option<(NodeId, Box<S{root}>)> }}\n\
         impl runic_runtime::App for App {{\n\
         const TITLE: &'static str = {title};\n\
         const CSS: &'static str = {css};\n\
         const ASSETS: &'static [(&'static str, &'static [u8])] = &[{assets}];\n\
         const IR_HASH: &'static str = {hash};\n\
         fn new() -> Self {{\nlet mut cx = Cx {{ c: Cells::default(), snap: Cells::default(), payload: None }};\n{init}cx.snap = cx.c.clone();\nApp {{ cx, root: None }}\n}}\n\
         fn mount(&mut self, dom: &mut Dom, parent: NodeId) {{\n\
         {container}match mount_s{root}(&mut self.cx, dom, parent, None) {{\n\
         Ok(s) => self.root = Some((parent, s)),\n\
         Err(e) => eprintln!(\"runic: render error: {{e}}\"),\n}}\n}}\n\
         fn dispatch(&mut self, dom: &mut Dom, handler: u32, payload: Option<&str>) -> Result<(), String> {{\n\
         let before = self.cx.c.clone();\n\
         self.cx.snap = self.cx.c.clone();\n\
         self.cx.payload = payload.map(JsString::from);\n\
         let epoch = js::mutation_epoch();\n\
         let result = match handler {{\n{dispatch_arms}_ => Err(js::Throw::new(\"Error\", \"unknown handler\")),\n}};\n\
         self.cx.payload = None;\n\
         if let Err(e) = &result {{ if e.name.to_rust() == \"RunicDomainError\" {{ self.cx.c = before.clone(); }} }}\n\
         let deep = js::mutation_epoch() != epoch;\n\
         self.cx.snap = self.cx.c.clone();\n\
         let dirty: [bool; {n}] = [{dirty}];\n\
         let dirty = if {optimize} {{ dirty }} else {{ [true; {n}] }};\n\
         if let Some((parent, s)) = self.root.as_mut() {{\n\
         if let Err(e) = update_s{root}(s, &mut self.cx, dom, &dirty, *parent, None) {{ eprintln!(\"runic: render error: {{e}}\"); }}\n\
         if let Err(e) = sync_s{root}(s, &mut self.cx, dom) {{ eprintln!(\"runic: render error: {{e}}\"); }}\n}}\n\
         result.map_err(|e| e.to_string())\n}}\n\
         fn cells_json(&self) -> runic_runtime::Json {{ runic_runtime::Json::Array(vec![{cells_json}]) }}\n\
         }}",
        title = rust_str(&p.meta.title),
        css = rust_str(css),
        hash = rust_str(ir_hash),
        optimize = options.optimize,
    );
    Ok(out)
}
