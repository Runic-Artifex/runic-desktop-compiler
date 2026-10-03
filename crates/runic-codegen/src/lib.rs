//! Rust code generation from validated Runic IR (schema 4).
//!
//! The generated module implements `runic_runtime::App`. Each template scope
//! (the component root and every conditional branch) becomes a struct holding
//! its node handles and the last written value of each dynamic binding.
//! Handlers run atomically on a copy of the cells; after every dispatch the
//! dirty cells drive targeted DOM updates, and live input values are
//! re-synchronised with their cells (controlled-input semantics).

use runic_ir::validate::type_of;
use runic_ir::*;
use std::fmt::Write as _;

pub mod emit;

pub struct Options {
    /// Skip bindings whose dependencies did not change (`--no-opt` disables).
    pub optimize: bool,
}

fn rust_str(s: &str) -> String {
    format!("{s:?}")
}

fn rust_f64(x: f64) -> String {
    format!("({x:?}f64)")
}

/// How cell reads are spelled at a code location.
#[derive(Clone, Copy)]
enum At {
    /// Committed cells in `c`.
    Committed,
    /// Inside a handler: `next` (current) and `snap` (entry snapshot).
    Handler,
    /// Initialisers: locals `cell<N>`.
    Init,
}

struct Exprs<'a> {
    cells: &'a [Cell],
}

impl Exprs<'_> {
    fn read(&self, cell: usize, read: Read, at: At) -> String {
        let r = match (at, read) {
            (At::Committed, _) => format!("c.c{cell}"),
            (At::Handler, Read::Current) => format!("next.c{cell}"),
            (At::Handler, Read::Snapshot) => format!("snap.c{cell}"),
            (At::Init, _) => format!("cell{cell}"),
        };
        if self.cells[cell].ty == Type::String {
            format!("{r}.clone()")
        } else {
            r
        }
    }

    /// An owned Rust value of the expression's type (f64, bool or String).
    fn expr(&self, e: &Expr, at: At) -> String {
        use Expr::*;
        let x = |e: &Expr| self.expr(e, at);
        match e {
            Lit {
                value: Value::Number(n),
            } => rust_f64(*n),
            Lit {
                value: Value::Boolean(b),
            } => b.to_string(),
            Lit {
                value: Value::String(s),
            } => format!("String::from({})", rust_str(s)),
            Cell { cell, read } => self.read(*cell, *read, at),
            Payload => "payload.expect(\"typed payload\").to_owned()".into(),
            Not { arg } => format!("(!{})", x(arg)),
            Neg { arg } => format!("(-{})", x(arg)),
            ToString { arg } => match type_of(arg, self.cells) {
                Type::Number => format!("js::number_to_string({})", x(arg)),
                Type::Boolean => format!("js::boolean_to_string({})", x(arg)),
                Type::String => x(arg),
            },
            Utf16Length { arg } => format!("js::utf16_len(&{})", x(arg)),
            Add { left, right } => format!("({} + {})", x(left), x(right)),
            Sub { left, right } => format!("({} - {})", x(left), x(right)),
            Mul { left, right } => format!("({} * {})", x(left), x(right)),
            Min { left, right } => format!("js::min({}, {})", x(left), x(right)),
            Max { left, right } => format!("js::max({}, {})", x(left), x(right)),
            Concat { left, right } => {
                format!(
                    "{{ let mut s = {}; s.push_str(&{}); s }}",
                    x(left),
                    x(right)
                )
            }
            Eq { left, right } => format!("({} == {})", x(left), x(right)),
            Ne { left, right } => format!("({} != {})", x(left), x(right)),
            Lt { left, right } => format!("({} < {})", x(left), x(right)),
            Le { left, right } => format!("({} <= {})", x(left), x(right)),
            Gt { left, right } => format!("({} > {})", x(left), x(right)),
            Ge { left, right } => format!("({} >= {})", x(left), x(right)),
            And { left, right } => format!("({} && {})", x(left), x(right)),
            Or { left, right } => format!("({} || {})", x(left), x(right)),
            Cond {
                test,
                then,
                otherwise,
            } => {
                format!(
                    "(if {} {{ {} }} else {{ {} }})",
                    x(test),
                    x(then),
                    x(otherwise)
                )
            }
            Mapped {
                guard,
                fast,
                reference,
                ..
            } => {
                if matches!(
                    **guard,
                    Lit {
                        value: Value::Boolean(true)
                    }
                ) {
                    x(fast)
                } else {
                    format!(
                        "(if {} {{ {} }} else {{ {} }})",
                        x(guard),
                        x(fast),
                        x(reference)
                    )
                }
            }
        }
    }

    fn concat(&self, parts: &[Expr], at: At) -> String {
        if let [only] = parts {
            return self.expr(only, at);
        }
        let mut s = String::from("{ let mut s = String::new(); ");
        for p in parts {
            let _ = write!(s, "s.push_str(&{}); ", self.expr(p, at));
        }
        s.push_str("s }");
        s
    }
}

// ---------------------------------------------------------------------------
// Pass 1: plan scopes and node keys.

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
// Pass 2: emit.

struct Gen<'a> {
    x: Exprs<'a>,
    optimize: bool,
}

#[derive(Default)]
struct Out {
    fields: Vec<(String, String)>,
    mount: String,
    update: String,
    sync: String,
}

impl Gen<'_> {
    fn guard(&self, exprs: &[&Expr]) -> String {
        if !self.optimize {
            return "true".into();
        }
        let mut deps: Vec<usize> = exprs.iter().flat_map(|e| e.deps()).collect();
        deps.sort_unstable();
        deps.dedup();
        if deps.is_empty() {
            "false".into()
        } else {
            deps.iter()
                .map(|d| format!("dirty[{d}]"))
                .collect::<Vec<_>>()
                .join(" || ")
        }
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
             fn mount_s{id}(c: &Cells, dom: &mut Dom, parent: NodeId, before: Option<NodeId>) -> Box<S{id}> {{\n{mount}Box::new(S{id} {{ {inits}}})\n}}\n\
             fn update_s{id}(s: &mut S{id}, c: &Cells, dom: &mut Dom, dirty: &[bool], parent: NodeId, after: Option<NodeId>) {{\n{update}}}\n\
             fn sync_s{id}(s: &S{id}, c: &Cells, dom: &mut Dom) {{\n{sync}}}\n\
             fn first_s{id}(s: &S{id}) -> Option<NodeId> {{ {first} }}\n\
             fn remove_s{id}(s: &S{id}, dom: &mut Dom) {{\n{remove}}}\n\n",
            mount = o.mount,
            update = o.update,
            sync = o.sync,
        )
    }

    /// `parent`: field name of the parent element, or None at scope top level.
    fn item(&self, item: &Item, o: &mut Out, parent: Option<usize>, following: &[Item]) {
        let attach = |field: &str| match parent {
            Some(p) => format!("dom.append(n{p}, {field});\n"),
            None => format!("dom.insert(parent, {field}, before);\n"),
        };
        match item {
            Item::Text { key, parts } => {
                let k = *key;
                o.fields.push((format!("n{k}"), "NodeId".into()));
                let value = self.x.concat(parts, At::Committed);
                if parts.iter().all(|p| p.deps().is_empty()) {
                    let _ = writeln!(o.mount, "let n{k} = dom.text(&{value});");
                } else {
                    o.fields.push((format!("v{k}"), "String".into()));
                    let _ = writeln!(o.mount, "let v{k} = {value};\nlet n{k} = dom.text(&v{k});");
                    let guard = self.guard(&parts.iter().collect::<Vec<_>>());
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
                    let boolean = type_of(&a.value, self.x.cells) == Type::Boolean;
                    let value = self.x.expr(&a.value, At::Committed);
                    let name = rust_str(&a.name);
                    let write = |node: &str, v: &str| {
                        if boolean {
                            format!("dom.set_bool_attr({node}, {name}, {v});")
                        } else {
                            format!("dom.set_attr({node}, {name}, &{v});")
                        }
                    };
                    if a.value.deps().is_empty() {
                        let _ = writeln!(o.mount, "{}", write(&format!("n{k}"), &value));
                    } else {
                        let cache = format!("a{k}_{i}");
                        let ty = if boolean { "bool" } else { "String" };
                        o.fields.push((cache.clone(), ty.into()));
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
                    let value = self.x.expr(&p.value, At::Committed);
                    let _ = writeln!(o.mount, "dom.set_value(n{k}, &{value});");
                    let _ = writeln!(o.sync, "dom.set_value(s.n{k}, &{value});");
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
                let test_rs = self.x.expr(test, At::Committed);
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
                     let then{k} = if t{k} {{ Some(mount_s{t}(c, dom, {mp}, {mb})) }} else {{ None }};\n\
                     let else{k} = if t{k} {{ None }} else {{ Some(mount_s{e}(c, dom, {mp}, {mb})) }};"
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
                     if t {{ s.then{k} = Some(mount_s{t}(c, dom, {up}, anchor)); }} else {{ s.else{k} = Some(mount_s{e}(c, dom, {up}, anchor)); }}\n\
                     s.t{k} = t;\n\
                     }} else {{\n\
                     if let Some(b) = s.then{k}.as_mut() {{ update_s{t}(b, c, dom, dirty, {up}, anchor); }}\n\
                     if let Some(b) = s.else{k}.as_mut() {{ update_s{e}(b, c, dom, dirty, {up}, anchor); }}\n\
                     }}\n\
                     }}"
                );
                let _ = writeln!(
                    o.sync,
                    "if let Some(b) = &s.then{k} {{ sync_s{t}(b, c, dom); }}\nif let Some(b) = &s.else{k} {{ sync_s{e}(b, c, dom); }}"
                );
            }
        }
    }
}

fn ty(t: Type) -> &'static str {
    match t {
        Type::Number => "f64",
        Type::String => "String",
        Type::Boolean => "bool",
    }
}

/// Generate `app.rs` for a validated program. `css` is the stylesheet with
/// assets already replaced by `runic-asset:N` references.
pub fn generate(
    p: &Program,
    ir_hash: &str,
    css: &str,
    asset_mimes: &[String],
    options: &Options,
) -> String {
    let c = &p.components[p.root];
    let x = Exprs { cells: &c.cells };
    let g = Gen {
        x,
        optimize: options.optimize,
    };
    let mut planner = Planner::default();
    let root = planner.scope(&c.template);
    let mut out = String::new();
    let _ = writeln!(
        out,
        "// Generated by runic-codegen from Runic IR schema {SCHEMA} ({ir_hash}). Do not edit.\n\
         #![allow(unused_parens, unused_variables, unused_mut, dead_code, clippy::all)]\n\
         use runic_runtime::{{js, Dom, Event, NodeId}};\n"
    );
    // Cells.
    let fields: String = c
        .cells
        .iter()
        .enumerate()
        .map(|(i, cell)| format!("pub c{i}: {}, ", ty(cell.ty)))
        .collect();
    let _ = writeln!(
        out,
        "#[derive(Clone, Debug, PartialEq)]\npub struct Cells {{ {fields}}}\n"
    );
    // Handlers.
    for (h, handler) in c.handlers.iter().enumerate() {
        let snap = handler
            .body
            .iter()
            .any(|Stmt::Set { value, .. }| value.reads_snapshot());
        let mut body = String::new();
        for Stmt::Set { cell, value, .. } in &handler.body {
            let v = g.x.expr(value, At::Handler);
            let _ = writeln!(body, "let v = {v};");
            if let Some(Domain::Text { max_utf16 }) = c.cells[*cell].domain {
                let _ = writeln!(
                    body,
                    "if !js::valid_single_line(&v, {max_utf16}) {{ return Err(\"value leaves the text domain of {}\"); }}",
                    c.cells[*cell].name.escape_default()
                );
            }
            let _ = writeln!(body, "next.c{cell} = v;");
        }
        let _ = writeln!(
            out,
            "fn handler_{h}(c: &mut Cells, payload: Option<&str>) -> Result<(), &'static str> {{\n\
             {snap}let mut next = c.clone();\n{body}*c = next;\nOk(())\n}}\n",
            snap = if snap { "let snap = c.clone();\n" } else { "" },
        );
    }
    // Scopes.
    for (id, scope) in planner.scopes.iter().enumerate() {
        out.push_str(&g.scope(id, scope.as_ref().expect("planned scope")));
    }
    // Initial cells.
    let mut init = String::new();
    for (i, cell) in c.cells.iter().enumerate() {
        let _ = writeln!(init, "let cell{i} = {};", g.x.expr(&cell.init, At::Init));
        if let Some(Domain::Text { max_utf16 }) = cell.domain {
            let _ = writeln!(
                init,
                "assert!(js::valid_single_line(&cell{i}, {max_utf16}), \"initial text domain\");"
            );
        }
    }
    let cell_inits: String = (0..c.cells.len())
        .map(|i| format!("c{i}: cell{i}, "))
        .collect();
    let dirty: String = c
        .cells
        .iter()
        .enumerate()
        .map(|(i, cell)| match cell.ty {
            Type::Number => format!("!js::same_value(before.c{i}, self.c.c{i}), "),
            _ => format!("before.c{i} != self.c.c{i}, "),
        })
        .collect();
    let dispatch_arms: String = (0..c.handlers.len())
        .map(|h| format!("{h} => handler_{h}(&mut self.c, payload),\n"))
        .collect();
    let cells_json: String = (0..c.cells.len())
        .map(|i| format!("js::json(&self.c.c{i}), "))
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
        "pub struct App {{ c: Cells, root: Option<(NodeId, Box<S{root}>)> }}\n\
         impl runic_runtime::App for App {{\n\
         const TITLE: &'static str = {title};\n\
         const CSS: &'static str = {css};\n\
         const ASSETS: &'static [(&'static str, &'static [u8])] = &[{assets}];\n\
         const IR_HASH: &'static str = {hash};\n\
         fn new() -> Self {{\n{init}App {{ c: Cells {{ {cell_inits}}}, root: None }}\n}}\n\
         fn mount(&mut self, dom: &mut Dom, parent: NodeId) {{\n\
         {container}let s = mount_s{root}(&self.c, dom, parent, None);\n\
         self.root = Some((parent, s));\n}}\n\
         fn dispatch(&mut self, dom: &mut Dom, handler: u32, payload: Option<&str>) -> Result<(), &'static str> {{\n\
         let before = self.c.clone();\n\
         let result = match handler {{\n{dispatch_arms}_ => Err(\"unknown handler\"),\n}};\n\
         let dirty: [bool; {n}] = [{dirty}];\n\
         let dirty = if {optimize} {{ dirty }} else {{ [true; {n}] }};\n\
         if let Some((parent, s)) = self.root.as_mut() {{\n\
         update_s{root}(s, &self.c, dom, &dirty, *parent, None);\n\
         sync_s{root}(s, &self.c, dom);\n}}\n\
         result\n}}\n\
         fn cells_json(&self) -> runic_runtime::Json {{ runic_runtime::Json::Array(vec![{cells_json}]) }}\n\
         }}",
        title = rust_str(&p.meta.title),
        css = rust_str(css),
        hash = rust_str(ir_hash),
        optimize = options.optimize,
        n = c.cells.len(),
    );
    out
}
