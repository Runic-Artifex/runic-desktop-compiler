//! What the elements of a program can carry, for leaving out stylesheet
//! rules no element can match (docs/CONTRACT.md, "Rules no element can
//! match"; `runic_css::unmatched`).
//!
//! A flow-insensitive abstract interpretation over the whole program: every
//! location (cell, local, global, function result, record field by record
//! type, array element by element type, attribute bag entry by name, context
//! value) holds the set of primitive values it can ever hold, or "any"
//! (`Val::Top`). Expressions the analysis does not follow give "any": the
//! results of calls through function values, of most built-ins, event
//! payloads, the parameters of functions the runtime or a function value
//! calls, numbers computed by arithmetic. Records and arrays the runtime
//! creates or changes (the types a built-in takes or gives) have fields and
//! elements of any value. Sets larger than [`CAP`] become "any". Iterating to
//! a fixpoint over all functions, handlers, initialisers and templates of
//! all components (reachable or not) makes every location hold every value
//! any run can store there.
//!
//! The facts are then read from every element the program can create
//! (templates, slot content, `{@html}` fragments) and every attribute write
//! (attributes, spreads of any bag entry, class toggles, inline styles, live
//! properties, `element.setAttribute`, the document element's and body's
//! built-ins), plus the elements the runtime creates (the document shell,
//! the select popup, file input parts). An attribute or class written from
//! "any" value makes that attribute's values, or all class tokens, "any";
//! an attribute name from "any" value makes every name possible.

use crate::validate::try_infer_in;
use crate::*;
use runic_css::unmatched::Facts;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

/// The largest value set kept exact.
pub const CAP: usize = 256;

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Atom {
    Str(String),
    Num(u64),
    True,
    False,
    Null,
    Undefined,
    /// A record, array, function, element, bag or other object.
    Object,
}

/// An abstract value: one of a set of primitives (or an object), a string
/// of whitespace-separated tokens from a set (class values that bags join),
/// or anything.
#[derive(Clone, Debug, PartialEq, Eq)]
enum Val {
    Set(BTreeSet<Atom>),
    Tokens(BTreeSet<String>),
    Top,
}

fn split_tokens(s: &str) -> impl Iterator<Item = &str> {
    s.split([' ', '\t', '\n', '\r', '\x0c'])
        .filter(|t| !t.is_empty())
}

impl Atom {
    /// `String(v)`; none for objects.
    fn text(&self) -> Option<String> {
        Some(match self {
            Atom::Str(s) => s.clone(),
            Atom::Num(n) => runic_js::number_to_string(f64::from_bits(*n)),
            Atom::True => "true".into(),
            Atom::False => "false".into(),
            Atom::Null => "null".into(),
            Atom::Undefined => "undefined".into(),
            Atom::Object => return None,
        })
    }
}

impl Val {
    fn none() -> Val {
        Val::Set(BTreeSet::new())
    }

    fn one(a: Atom) -> Val {
        Val::Set(BTreeSet::from([a]))
    }

    fn object() -> Val {
        Val::one(Atom::Object)
    }

    fn string(s: &str) -> Val {
        Val::one(Atom::Str(s.to_string()))
    }

    /// Join `other` in; whether this changed.
    fn join(&mut self, other: &Val) -> bool {
        let next = match (&*self, other) {
            (Val::Top, _) => return false,
            (_, Val::Top) => Val::Top,
            (Val::Set(a), Val::Set(b)) => {
                if b.is_subset(a) {
                    return false;
                }
                let u: BTreeSet<Atom> = a.union(b).cloned().collect();
                if u.len() > CAP { Val::Top } else { Val::Set(u) }
            }
            (Val::Tokens(a), Val::Tokens(b)) => {
                if b.is_subset(a) {
                    return false;
                }
                Val::Tokens(a.union(b).cloned().collect())
            }
            (Val::Tokens(t), Val::Set(s)) | (Val::Set(s), Val::Tokens(t)) => {
                let mut t = t.clone();
                for a in s {
                    match a.text() {
                        Some(x) => t.extend(split_tokens(&x).map(str::to_string)),
                        None => {
                            *self = Val::Top;
                            return true;
                        }
                    }
                }
                Val::Tokens(t)
            }
        };
        let next = match next {
            Val::Tokens(t) if t.len() > CAP * 4 => Val::Top,
            v => v,
        };
        if next == *self {
            return false;
        }
        *self = next;
        true
    }

    fn joined(mut self, other: &Val) -> Val {
        self.join(other);
        self
    }

    /// `String(v)`.
    fn to_text(&self) -> Val {
        match self {
            Val::Set(s) => {
                let mut out = BTreeSet::new();
                for a in s {
                    match a.text() {
                        Some(t) => {
                            out.insert(Atom::Str(t));
                        }
                        None => return Val::Top,
                    }
                }
                Val::Set(out)
            }
            v => v.clone(),
        }
    }

    /// The strings of `a + b` where both are strings.
    fn concat(&self, other: &Val) -> Val {
        let (Val::Set(a), Val::Set(b)) = (self.to_text(), other.to_text()) else {
            return Val::Top;
        };
        if a.len() * b.len() > CAP {
            return Val::Top;
        }
        let mut out = BTreeSet::new();
        for x in &a {
            for y in &b {
                if let (Atom::Str(x), Atom::Str(y)) = (x, y) {
                    out.insert(Atom::Str(format!("{x}{y}")));
                }
            }
        }
        Val::Set(out)
    }

    fn all_strings(&self) -> bool {
        matches!(self, Val::Set(s) if s.iter().all(|a| matches!(a, Atom::Str(_))))
    }

    /// The texts of an attribute holding this value (none for absent ones:
    /// `undefined`, `null`; `true` is an empty attribute or the text
    /// `"true"`); none for any text.
    fn attribute_texts(&self) -> Option<BTreeSet<String>> {
        let Val::Set(s) = self else { return None };
        let mut out = BTreeSet::new();
        for a in s {
            match a {
                Atom::Null | Atom::Undefined => {}
                Atom::True => {
                    out.insert(String::new());
                    out.insert("true".into());
                }
                Atom::Object => return None,
                a => {
                    out.insert(a.text()?);
                }
            }
        }
        Some(out)
    }

    /// The class tokens of an attribute holding this value; none for any.
    fn class_tokens(&self) -> Option<BTreeSet<String>> {
        match self {
            Val::Tokens(t) => Some(t.clone()),
            v => Some(
                v.attribute_texts()?
                    .iter()
                    .flat_map(|t| split_tokens(t).map(str::to_string).collect::<Vec<_>>())
                    .collect(),
            ),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Scope {
    Template(usize),
    Handler(usize, usize),
    Function(usize),
    CellInit(usize, usize),
    EffectDeps(usize, usize),
    GlobalInit(usize),
}

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
enum Loc {
    Cell(usize, usize),
    Local(Scope, usize),
    Global(usize),
    Return(usize),
    Field(usize, usize),
    Elem(Type),
    Bag(String),
    Context,
}

/// The context expressions are evaluated in.
struct Cx {
    scope: Scope,
    component: Option<usize>,
    locals: Vec<Local>,
    payload: Option<Type>,
}

/// The element facts of a program and why the open ones are open.
#[derive(Clone, Debug, Default)]
pub struct ProgramFacts {
    pub facts: Facts,
    /// Why tags, classes or attributes are not (all) known.
    pub open: Vec<String>,
}

/// What the elements of `p` can carry (see the module documentation).
pub fn element_facts(p: &Program) -> ProgramFacts {
    let mut a = Analysis::new(p);
    for _ in 0..200 {
        a.changed = false;
        a.pass();
        if a.open.is_some() {
            break;
        }
        if !a.changed {
            return a.facts();
        }
    }
    let reason = a
        .open
        .take()
        .unwrap_or_else(|| "the analysis did not settle".into());
    ProgramFacts {
        facts: Facts::open(),
        open: vec![reason],
    }
}

/// Facts read from the elements in one pass.
#[derive(Default)]
struct Out {
    tags: BTreeSet<String>,
    /// Attribute names and their texts (none: any).
    attributes: BTreeMap<String, Option<BTreeSet<String>>>,
    /// Why any attribute name is possible.
    any_name: Option<String>,
    classes: BTreeSet<String>,
    /// Why any class token is possible.
    any_class: Option<String>,
    /// Why some attributes have any value.
    any_value: BTreeMap<String, String>,
    /// Where an element spreads a bag.
    spread: Option<String>,
}

struct Analysis<'p> {
    p: &'p Program,
    /// Each component's template and mount sites (stable addresses for the
    /// type cache).
    nodes: Vec<Vec<Node>>,
    vals: HashMap<Loc, Val>,
    changed: bool,
    types: HashMap<usize, Option<Type>>,
    opaque: HashSet<Type>,
    /// Functions with parameters of any value (called by the runtime or
    /// through function values).
    escaping: HashSet<usize>,
    /// Slot content for each component's slot: the providing component and
    /// the template locals its parameters bind.
    slot_params: HashMap<(usize, String), Vec<(usize, Vec<usize>)>>,
    /// Why bags may hold names no `attrs` expression writes.
    open_bag_names: Option<String>,
    /// Why nothing can be proven.
    open: Option<String>,
    out: Out,
}

fn source_text(s: Option<&Source>) -> String {
    s.map_or_else(String::new, |s| {
        format!(" at {}:{}:{}", s.file, s.line, s.column)
    })
}

impl<'p> Analysis<'p> {
    fn new(p: &'p Program) -> Self {
        let nodes: Vec<Vec<Node>> = p
            .components
            .iter()
            .map(Component::template_and_mounts)
            .collect();
        let mut slot_params: HashMap<(usize, String), Vec<(usize, Vec<usize>)>> = HashMap::new();
        fn defs(
            c: usize,
            nodes: &[Node],
            out: &mut HashMap<(usize, String), Vec<(usize, Vec<usize>)>>,
        ) {
            for n in nodes {
                match n {
                    Node::Element { children, .. } => defs(c, children, out),
                    Node::If {
                        then, otherwise, ..
                    } => {
                        defs(c, then, out);
                        defs(c, otherwise, out);
                    }
                    Node::Each {
                        body, otherwise, ..
                    } => {
                        defs(c, body, out);
                        defs(c, otherwise, out);
                    }
                    Node::Slot { fallback, .. } => defs(c, fallback, out),
                    Node::Component {
                        component, slots, ..
                    } => {
                        for s in slots {
                            out.entry((*component, s.name.clone()))
                                .or_default()
                                .push((c, s.params.clone()));
                            defs(c, &s.body, out);
                        }
                    }
                    Node::Text { .. } | Node::Html { .. } => {}
                }
            }
        }
        for (c, n) in nodes.iter().enumerate() {
            defs(c, n, &mut slot_params);
        }
        let mut escaping = HashSet::new();
        for c in &p.components {
            for e in &c.effects {
                escaping.insert(e.run);
            }
        }
        for r in &p.records {
            for f in &r.fields {
                if let Some(d) = f.derived {
                    escaping.insert(d);
                }
            }
        }
        Analysis {
            p,
            nodes,
            vals: HashMap::new(),
            changed: false,
            types: HashMap::new(),
            opaque: HashSet::new(),
            escaping,
            slot_params,
            open_bag_names: None,
            open: None,
            out: Out::default(),
        }
    }

    fn give_up(&mut self, why: impl Into<String>) {
        if self.open.is_none() {
            self.open = Some(why.into());
        }
    }

    fn get(&self, l: &Loc) -> Val {
        self.vals.get(l).cloned().unwrap_or_else(Val::none)
    }

    fn put(&mut self, l: Loc, v: &Val) {
        let slot = self.vals.entry(l).or_insert_with(Val::none);
        if slot.join(v) {
            self.changed = true;
        }
    }

    fn ty(&mut self, cx: &Cx, e: &Expr) -> Option<Type> {
        let key = e as *const Expr as usize;
        if let Some(t) = self.types.get(&key) {
            return t.clone();
        }
        let t = try_infer_in(self.p, cx.component, &cx.locals, cx.payload.clone(), e).ok();
        if t.is_none() {
            self.give_up("an expression the analysis could not type");
        }
        self.types.insert(key, t.clone());
        t
    }

    /// The records a value of type `t` may be (a class: its subclasses).
    fn records(&self, t: &Type) -> Vec<usize> {
        match t {
            Type::Record(r) => match self.p.records.get(*r) {
                Some(rec) if rec.class => self.p.subtree(*r),
                Some(_) => vec![*r],
                None => vec![],
            },
            Type::Class(_) | Type::Classes(_) => self.p.class_members(t).unwrap_or_default(),
            Type::Maybe(i) => self.records(i),
            _ => vec![],
        }
    }

    /// Values of type `t` may be created or changed by the runtime: their
    /// fields and elements hold any value.
    fn make_opaque(&mut self, t: &Type) {
        if !self.opaque.insert(t.clone()) {
            return;
        }
        match t {
            Type::Maybe(i) | Type::Promise(i) | Type::Set(i) => self.make_opaque(i),
            Type::Array(e) => {
                self.put(Loc::Elem((**e).clone()), &Val::Top);
                self.make_opaque(e);
            }
            Type::Map(k, v) => {
                self.make_opaque(k);
                self.make_opaque(v);
            }
            Type::Fn(f) => {
                for t in &f.params {
                    self.make_opaque(t);
                }
                self.make_opaque(&f.result);
            }
            Type::Record(_) | Type::Class(_) | Type::Classes(_) => {
                for r in self.records(t) {
                    let fields: Vec<Type> = self.p.records[r]
                        .fields
                        .iter()
                        .map(|f| f.ty.clone())
                        .collect();
                    for (k, ft) in fields.iter().enumerate() {
                        self.put(Loc::Field(r, k), &Val::Top);
                        self.make_opaque(ft);
                    }
                }
            }
            _ => {}
        }
    }

    /// Arrays of types `a` and `b` are the same arrays (a cast).
    fn alias(&mut self, a: &Type, b: &Type) {
        match (a, b) {
            (Type::Maybe(a), b) | (b, Type::Maybe(a)) => self.alias(a, b),
            (Type::Array(x), Type::Array(y)) if x != y => {
                let (lx, ly) = (Loc::Elem((**x).clone()), Loc::Elem((**y).clone()));
                let (vx, vy) = (self.get(&lx), self.get(&ly));
                self.put(lx, &vy);
                self.put(ly, &vx);
                self.alias(x, y);
            }
            _ => {}
        }
    }

    fn escape(&mut self, f: usize) {
        if self.escaping.insert(f) {
            self.changed = true;
        }
    }

    fn function_cx(&self, f: usize) -> Cx {
        let func = &self.p.functions[f];
        let mut locals = func.captures.clone();
        locals.extend(func.params.iter().cloned());
        locals.extend(func.locals.iter().cloned());
        Cx {
            scope: Scope::Function(f),
            component: func.component,
            locals,
            payload: None,
        }
    }

    fn pass(&mut self) {
        self.out = Out::default();
        let p = self.p;
        for (g, global) in p.globals.iter().enumerate() {
            let cx = Cx {
                scope: Scope::GlobalInit(g),
                component: None,
                locals: vec![],
                payload: None,
            };
            let v = self.eval(&cx, &global.init);
            self.put(Loc::Global(g), &v);
        }
        for (f, func) in p.functions.iter().enumerate() {
            let cx = self.function_cx(f);
            if self.escaping.contains(&f) {
                for j in 0..func.params.len() {
                    self.put(
                        Loc::Local(Scope::Function(f), func.captures.len() + j),
                        &Val::Top,
                    );
                }
            }
            self.exec(&cx, &func.body);
        }
        for (ri, r) in p.records.iter().enumerate() {
            for (k, field) in r.fields.iter().enumerate() {
                if let Some(d) = field.derived {
                    let v = self.get(&Loc::Return(d));
                    self.put(Loc::Field(ri, k), &v);
                }
            }
        }
        for (c, comp) in p.components.iter().enumerate() {
            for (i, cell) in comp.cells.iter().enumerate() {
                let cx = Cx {
                    scope: Scope::CellInit(c, i),
                    component: Some(c),
                    locals: vec![],
                    payload: None,
                };
                let v = self.eval(&cx, &cell.init);
                self.put(Loc::Cell(c, i), &v);
            }
            for (h, handler) in comp.handlers.iter().enumerate() {
                let mut locals = handler.params.clone();
                locals.extend(handler.locals.iter().cloned());
                let payload = handler.event.payload();
                if let Some(t) = &payload {
                    self.make_opaque(t);
                }
                for j in 0..handler.params.len() {
                    self.put(Loc::Local(Scope::Handler(c, h), j), &Val::Top);
                }
                let cx = Cx {
                    scope: Scope::Handler(c, h),
                    component: Some(c),
                    locals,
                    payload,
                };
                self.exec(&cx, &handler.body);
            }
            for (i, effect) in comp.effects.iter().enumerate() {
                if let EffectDeps::Values { values, .. } = &effect.deps {
                    let cx = Cx {
                        scope: Scope::EffectDeps(c, i),
                        component: Some(c),
                        locals: vec![],
                        payload: None,
                    };
                    for v in values {
                        self.eval(&cx, v);
                    }
                }
            }
            let cx = Cx {
                scope: Scope::Template(c),
                component: Some(c),
                locals: comp.template_locals.clone(),
                payload: None,
            };
            let nodes = std::mem::take(&mut self.nodes[c]);
            self.nodes_walk(&cx, &nodes);
            self.nodes[c] = nodes;
        }
        // Fragments of `{@html}`: static elements.
        fn fragment(out: &mut Out, nodes: &[FragmentNode]) {
            for n in nodes {
                if let FragmentNode::Element {
                    tag,
                    attrs,
                    children,
                } = n
                {
                    out.tags.insert(tag.to_ascii_lowercase());
                    for (name, value) in attrs {
                        let v = Val::string(value);
                        write_attr(out, name, &v, "");
                    }
                    fragment(out, children);
                }
            }
        }
        for f in &p.fragments {
            fragment(&mut self.out, &f.nodes);
        }
        // The document shell (runic-runtime shell.rs).
        for t in ["html", "head", "style", "title", "body", "div"] {
            self.out.tags.insert(t.into());
        }
        let container = p
            .container
            .clone()
            .unwrap_or_else(|| BTreeMap::from([("id".to_string(), "root".to_string())]));
        for (name, value) in p
            .document
            .iter()
            .chain(&p.body)
            .chain(&container)
            .chain(&p.container_attrs)
        {
            write_attr(&mut self.out, name, &Val::string(value), "");
        }
        // The select popup draws `div`s with inline styles and marks options;
        // a file input's button and label.
        if self.out.tags.contains("select") {
            write_attr(&mut self.out, "style", &Val::Top, " (the select popup)");
            for name in ["runic-selected", "runic-shown"] {
                write_attr(&mut self.out, name, &Val::string(""), "");
            }
        }
        if self.out.tags.contains("input") {
            self.out.tags.insert("button".into());
            self.out.tags.insert("label".into());
            write_attr(&mut self.out, "type", &Val::Top, " (a file input's button)");
            write_attr(
                &mut self.out,
                "tabindex",
                &Val::Top,
                " (a file input's button)",
            );
            // Blitz sets `checked` on inputs it creates.
            write_attr(&mut self.out, "checked", &Val::Top, " (an input)");
            write_attr(&mut self.out, "value", &Val::Top, " (an input)");
        }
        if self.out.tags.contains("details") || self.out.tags.contains("dialog") {
            write_attr(&mut self.out, "open", &Val::Top, " (details, dialog)");
        }
        // A spread may set any bag entry.
        if let Some(at) = self.out.spread.clone() {
            if let Some(why) = self.open_bag_names.clone() {
                self.out.any_name.get_or_insert(why);
            }
            let bags: Vec<(String, Val)> = self
                .vals
                .iter()
                .filter_map(|(l, v)| match l {
                    Loc::Bag(n) => Some((n.clone(), v.clone())),
                    _ => None,
                })
                .collect();
            for (name, v) in bags {
                if name.starts_with("on") {
                    continue;
                }
                write_attr(&mut self.out, &name, &v, &format!(" (a spread{at})"));
            }
        }
    }

    fn facts(&self) -> ProgramFacts {
        let out = &self.out;
        let mut open = vec![];
        let attributes = match &out.any_name {
            Some(why) => {
                open.push(format!("any attribute name: {why}"));
                None
            }
            None => Some(out.attributes.clone()),
        };
        let classes = match (&out.any_class, &out.any_name) {
            (Some(why), _) | (None, Some(why)) => {
                open.push(format!("any class: {why}"));
                None
            }
            _ => Some(out.classes.clone()),
        };
        for (name, why) in &out.any_value {
            if name != "class" && name != "style" {
                open.push(format!("any {name} value: {why}"));
            }
        }
        ProgramFacts {
            facts: Facts {
                tags: Some(out.tags.clone()),
                classes,
                attributes,
            },
            open,
        }
    }

    fn nodes_walk(&mut self, cx: &Cx, nodes: &[Node]) {
        for n in nodes {
            self.node(cx, n);
        }
    }

    fn node(&mut self, cx: &Cx, n: &Node) {
        let c = cx.component.expect("template scope");
        match n {
            Node::Element {
                tag,
                attrs,
                props,
                listeners,
                spread,
                classes,
                style_text,
                styles,
                adopt,
                children,
                source,
                ..
            } => {
                let at = format!(" (<{tag}>{})", source_text(source.as_ref()));
                self.out.tags.insert(tag.to_ascii_lowercase());
                for a in attrs {
                    let v = self.eval(cx, &a.value);
                    write_attr(&mut self.out, &a.name, &v, &at);
                }
                // Live properties: the runtime writes `value` and `checked`
                // attributes.
                for a in props {
                    self.eval(cx, &a.value);
                    write_attr(&mut self.out, &a.name, &Val::Top, &at);
                    write_attr(&mut self.out, "value", &Val::Top, &at);
                    write_attr(&mut self.out, "checked", &Val::Top, &at);
                }
                for l in listeners {
                    for a in &l.args {
                        self.eval(cx, a);
                    }
                }
                if let Some(s) = spread {
                    self.eval(cx, s);
                    self.out.spread.get_or_insert(at.clone());
                }
                for a in classes {
                    self.eval(cx, &a.value);
                    write_attr(&mut self.out, "class", &Val::string(&a.name), &at);
                }
                if let Some(s) = style_text {
                    self.eval(cx, s);
                    write_attr(&mut self.out, "style", &Val::Top, &at);
                }
                for a in styles {
                    self.eval(cx, &a.value);
                    write_attr(&mut self.out, "style", &Val::Top, &at);
                }
                if let Some(a) = adopt {
                    self.eval(cx, &a.when);
                    for e in &a.args {
                        self.eval(cx, e);
                    }
                }
                self.nodes_walk(cx, children);
            }
            Node::Text { parts, .. } => {
                for e in parts {
                    self.eval(cx, e);
                }
            }
            Node::Html { value, .. } => {
                self.eval(cx, value);
            }
            Node::If {
                test,
                then,
                otherwise,
                ..
            } => {
                self.eval(cx, test);
                self.nodes_walk(cx, then);
                self.nodes_walk(cx, otherwise);
            }
            Node::Component {
                component,
                props,
                slots,
                ..
            } => {
                for a in props {
                    let v = self.eval(cx, &a.value);
                    self.to_prop(*component, &a.name, &v);
                    if let Some(b) = &a.bind {
                        self.eval(cx, b);
                    }
                }
                for s in slots {
                    if let Some(w) = &s.when {
                        self.eval(cx, w);
                    }
                    self.nodes_walk(cx, &s.body);
                }
            }
            Node::Slot {
                name,
                args,
                fallback,
                ..
            } => {
                let vals: Vec<Val> = args.iter().map(|a| self.eval(cx, a)).collect();
                let targets = self
                    .slot_params
                    .get(&(c, name.clone()))
                    .cloned()
                    .unwrap_or_default();
                for (parent, params) in targets {
                    for (j, &l) in params.iter().enumerate() {
                        let v = vals.get(j).cloned().unwrap_or(Val::Top);
                        self.put(Loc::Local(Scope::Template(parent), l), &v);
                    }
                }
                self.nodes_walk(cx, fallback);
            }
            Node::Each {
                items,
                item,
                index,
                key,
                body,
                otherwise,
                ..
            } => {
                self.eval(cx, items);
                let v = match self.ty(cx, items) {
                    Some(Type::Array(t)) => self.get(&Loc::Elem(*t)),
                    _ => Val::Top,
                };
                self.put(Loc::Local(cx.scope.clone(), *item), &v);
                if let Some(i) = index {
                    self.put(Loc::Local(cx.scope.clone(), *i), &Val::Top);
                }
                if let Some(k) = key {
                    self.eval(cx, k);
                }
                self.nodes_walk(cx, body);
                self.nodes_walk(cx, otherwise);
            }
        }
    }

    fn to_prop(&mut self, k: usize, name: &str, v: &Val) {
        let cells: Vec<usize> = self.p.components[k]
            .cells
            .iter()
            .enumerate()
            .filter(|(_, c)| c.prop.as_deref() == Some(name))
            .map(|(i, _)| i)
            .collect();
        for i in cells {
            self.put(Loc::Cell(k, i), v);
        }
    }

    fn cell(&mut self, cx: &Cx, cell: usize) -> Option<Loc> {
        match cx.component {
            Some(c) => Some(Loc::Cell(c, cell)),
            None => {
                self.give_up("a cell outside a component");
                None
            }
        }
    }

    fn exec(&mut self, cx: &Cx, body: &[Stmt]) {
        for s in body {
            self.stmt(cx, s);
        }
    }

    fn stmt(&mut self, cx: &Cx, s: &Stmt) {
        match s {
            Stmt::Set { cell, value, .. } => {
                let v = self.eval(cx, value);
                if let Some(l) = self.cell(cx, *cell) {
                    self.put(l, &v);
                }
            }
            Stmt::Let { local, value, .. } => {
                if let Some(e) = value {
                    let v = self.eval(cx, e);
                    self.put(Loc::Local(cx.scope.clone(), *local), &v);
                }
            }
            Stmt::Assign { target, value, .. } => {
                let v = self.eval(cx, value);
                match target {
                    Place::Local { local } => self.put(Loc::Local(cx.scope.clone(), *local), &v),
                    Place::Cell { cell } => {
                        if let Some(l) = self.cell(cx, *cell) {
                            self.put(l, &v);
                        }
                    }
                    Place::Field { object, field } => {
                        self.eval(cx, object);
                        let t = self.ty(cx, object);
                        let rs = t.map(|t| self.records(&t)).unwrap_or_default();
                        if rs.is_empty() {
                            self.give_up("a field write to a value of unknown record");
                        }
                        for r in rs {
                            self.put(Loc::Field(r, *field), &v);
                        }
                    }
                    Place::Index { array, index } => {
                        self.eval(cx, array);
                        self.eval(cx, index);
                        match self.ty(cx, array) {
                            Some(Type::Array(t)) => self.put(Loc::Elem(*t), &v),
                            _ => self.give_up("an element write to a value that is not an array"),
                        }
                    }
                }
            }
            Stmt::Expr { value, .. } | Stmt::Throw { value, .. } => {
                self.eval(cx, value);
            }
            Stmt::If {
                test,
                then,
                otherwise,
                ..
            } => {
                self.eval(cx, test);
                self.exec(cx, then);
                self.exec(cx, otherwise);
            }
            Stmt::While {
                test, body, update, ..
            } => {
                self.eval(cx, test);
                self.exec(cx, body);
                self.exec(cx, update);
            }
            Stmt::ForOf {
                local,
                iterable,
                body,
                ..
            } => {
                self.eval(cx, iterable);
                let v = match self.ty(cx, iterable) {
                    Some(Type::Array(t)) => self.get(&Loc::Elem(*t)),
                    _ => Val::Top,
                };
                self.put(Loc::Local(cx.scope.clone(), *local), &v);
                self.exec(cx, body);
            }
            Stmt::Break { .. } | Stmt::Continue { .. } => {}
            Stmt::Return { value, .. } => {
                if let Some(e) = value {
                    let v = self.eval(cx, e);
                    if let Scope::Function(f) = cx.scope {
                        self.put(Loc::Return(f), &v);
                    }
                }
            }
            Stmt::Try {
                body,
                catch,
                finally,
            } => {
                self.exec(cx, body);
                if let Some(c) = catch {
                    if let Some(l) = c.local {
                        self.put(Loc::Local(cx.scope.clone(), l), &Val::Top);
                    }
                    self.exec(cx, &c.body);
                }
                if let Some(f) = finally {
                    self.exec(cx, f);
                }
            }
        }
    }

    fn eval(&mut self, cx: &Cx, e: &Expr) -> Val {
        match e {
            Expr::Lit { value } => match value {
                Value::Boolean(true) => Val::one(Atom::True),
                Value::Boolean(false) => Val::one(Atom::False),
                Value::Number(n) => Val::one(Atom::Num(n.to_bits())),
                Value::String(s) => Val::string(s),
            },
            Expr::Undefined { .. } => Val::one(Atom::Undefined),
            Expr::Null { .. } => Val::one(Atom::Null),
            Expr::Global { global } => self.get(&Loc::Global(*global)),
            Expr::Cell { cell, .. } => match self.cell(cx, *cell) {
                Some(l) => self.get(&l),
                None => Val::Top,
            },
            Expr::Local { local } => self.get(&Loc::Local(cx.scope.clone(), *local)),
            Expr::Payload | Expr::Event | Expr::SlotProvided { .. } => Val::Top,
            Expr::Not { arg }
            | Expr::Neg { arg }
            | Expr::BitNot { arg }
            | Expr::ToNumber { arg }
            | Expr::ToBoolean { arg }
            | Expr::Typeof { arg }
            | Expr::Utf16Length { arg } => {
                self.eval(cx, arg);
                Val::Top
            }
            Expr::ToString { arg } => self.eval(cx, arg).to_text(),
            Expr::Add { left, right } => {
                let (a, b) = (self.eval(cx, left), self.eval(cx, right));
                if a.all_strings() || b.all_strings() {
                    a.concat(&b)
                } else {
                    Val::Top
                }
            }
            Expr::Concat { left, right } => {
                let (a, b) = (self.eval(cx, left), self.eval(cx, right));
                a.concat(&b)
            }
            Expr::Sub { left, right }
            | Expr::Mul { left, right }
            | Expr::Div { left, right }
            | Expr::Rem { left, right }
            | Expr::Pow { left, right }
            | Expr::Min { left, right }
            | Expr::Max { left, right }
            | Expr::BitAnd { left, right }
            | Expr::BitOr { left, right }
            | Expr::BitXor { left, right }
            | Expr::Shl { left, right }
            | Expr::Shr { left, right }
            | Expr::Ushr { left, right }
            | Expr::Eq { left, right }
            | Expr::Ne { left, right }
            | Expr::Lt { left, right }
            | Expr::Le { left, right }
            | Expr::Gt { left, right }
            | Expr::Ge { left, right } => {
                self.eval(cx, left);
                self.eval(cx, right);
                Val::Top
            }
            // The result is one of the operands.
            Expr::And { left, right }
            | Expr::Or { left, right }
            | Expr::Nullish { left, right } => {
                let a = self.eval(cx, left);
                let b = self.eval(cx, right);
                a.joined(&b)
            }
            Expr::Cond {
                test,
                then,
                otherwise,
            } => {
                self.eval(cx, test);
                let a = self.eval(cx, then);
                let b = self.eval(cx, otherwise);
                a.joined(&b)
            }
            Expr::Mapped {
                guard,
                fast,
                reference,
                ..
            } => {
                self.eval(cx, guard);
                let a = self.eval(cx, fast);
                let b = self.eval(cx, reference);
                a.joined(&b)
            }
            Expr::Record { record, fields } => {
                let rs = self.records(&Type::Record(*record));
                for (k, f) in fields.iter().enumerate() {
                    let v = self.eval(cx, f);
                    for &r in &rs {
                        self.put(Loc::Field(r, k), &v);
                    }
                }
                Val::object()
            }
            Expr::Array { ty, items } => {
                let Type::Array(t) = ty else {
                    self.give_up("an array literal without an array type");
                    return Val::Top;
                };
                for item in items {
                    match item {
                        ArrayItem::Item(v) => {
                            let v = self.eval(cx, v);
                            self.put(Loc::Elem((**t).clone()), &v);
                        }
                        ArrayItem::Spread { spread } => {
                            self.eval(cx, spread);
                            let v = match self.ty(cx, spread) {
                                Some(Type::Array(s)) => self.get(&Loc::Elem(*s)),
                                _ => Val::Top,
                            };
                            self.put(Loc::Elem((**t).clone()), &v);
                        }
                    }
                }
                Val::object()
            }
            Expr::Attrs { items, .. } => {
                for item in items {
                    match item {
                        AttrItem::Entry { name, value } => {
                            let v = self.eval(cx, value);
                            self.put(Loc::Bag(name.to_ascii_lowercase()), &v);
                        }
                        AttrItem::Spread { spread } => {
                            self.eval(cx, spread);
                        }
                        AttrItem::Attach { attach } => {
                            self.eval(cx, attach);
                        }
                    }
                }
                Val::object()
            }
            Expr::Get { object, field } => {
                self.eval(cx, object);
                let t = self.ty(cx, object);
                let rs = t.map(|t| self.records(&t)).unwrap_or_default();
                if rs.is_empty() {
                    return Val::Top;
                }
                let mut v = Val::none();
                for r in rs {
                    v.join(&self.get(&Loc::Field(r, *field)));
                }
                v
            }
            Expr::Index { array, index } => {
                self.eval(cx, array);
                self.eval(cx, index);
                match self.ty(cx, array) {
                    Some(Type::Array(t)) => self.get(&Loc::Elem(*t)),
                    _ => Val::Top,
                }
            }
            Expr::Some { value } | Expr::Unwrap { value } => self.eval(cx, value),
            Expr::Upcast { value, ty } | Expr::Downcast { value, ty } => {
                let v = self.eval(cx, value);
                if let Some(from) = self.ty(cx, value) {
                    self.alias(&from, ty);
                }
                v
            }
            Expr::Optional { value, local, then } => {
                let v = self.eval(cx, value);
                self.put(Loc::Local(cx.scope.clone(), *local), &v);
                self.eval(cx, then).joined(&Val::one(Atom::Undefined))
            }
            Expr::With { local, value, body } => {
                let v = self.eval(cx, value);
                self.put(Loc::Local(cx.scope.clone(), *local), &v);
                self.eval(cx, body)
            }
            Expr::MatchUnion {
                value,
                cases,
                otherwise,
            } => {
                // (Each case's local holds the values of its member, a
                // subset of the union's.)
                let v = self.eval(cx, value);
                let mut out = Val::none();
                for case in cases {
                    self.put(Loc::Local(cx.scope.clone(), case.local), &v);
                    let r = self.eval(cx, &case.body);
                    out.join(&r);
                }
                if let Some(o) = otherwise {
                    let r = self.eval(cx, o);
                    out.join(&r);
                }
                out
            }
            Expr::MatchClass {
                value,
                cases,
                otherwise,
            } => {
                let v = self.eval(cx, value);
                let mut out = Val::none();
                for case in cases {
                    self.put(Loc::Local(cx.scope.clone(), case.local), &v);
                    let r = self.eval(cx, &case.body);
                    out.join(&r);
                }
                if let Some(o) = otherwise {
                    let r = self.eval(cx, o);
                    out.join(&r);
                }
                out
            }
            Expr::Call { function, args } => {
                let caps = self.p.functions[*function].captures.len();
                for (j, a) in args.iter().enumerate() {
                    let v = self.eval(cx, a);
                    self.put(Loc::Local(Scope::Function(*function), caps + j), &v);
                }
                self.get(&Loc::Return(*function))
            }
            Expr::CallValue { callee, args } => {
                self.eval(cx, callee);
                for a in args {
                    self.eval(cx, a);
                }
                Val::Top
            }
            Expr::Closure {
                function, captures, ..
            } => {
                self.escape(*function);
                for (i, &l) in captures.iter().enumerate() {
                    let inner = Loc::Local(Scope::Function(*function), i);
                    let outer = Loc::Local(cx.scope.clone(), l);
                    let (vi, vo) = (self.get(&inner), self.get(&outer));
                    self.put(inner, &vo);
                    self.put(outer, &vi);
                }
                Val::object()
            }
            Expr::Mount {
                site,
                target,
                props,
                context,
            } => {
                self.eval(cx, target);
                if let Some(c) = context {
                    self.eval(cx, c);
                }
                let k = cx
                    .component
                    .and_then(|c| self.p.components[c].mounts.get(*site))
                    .map(|m| m.component);
                for prop in props {
                    let v = self.eval(cx, &prop.value);
                    match k {
                        Some(k) => self.to_prop(k, &prop.name, &v),
                        None => self.give_up("a mount of an unknown site"),
                    }
                }
                Val::object()
            }
            Expr::Builtin { name, args, ty } => self.builtin(cx, name, args, ty),
        }
    }

    fn builtin(&mut self, cx: &Cx, name: &str, args: &[Expr], ty: &Type) -> Val {
        let vals: Vec<Val> = args.iter().map(|a| self.eval(cx, a)).collect();
        let strings = |v: &Val| match v {
            Val::Set(s) if s.iter().all(|a| matches!(a, Atom::Str(_))) => Some(
                s.iter()
                    .filter_map(|a| match a {
                        Atom::Str(s) => Some(s.clone()),
                        _ => None,
                    })
                    .collect::<Vec<_>>(),
            ),
            _ => None,
        };
        let at = " (script)";
        match name {
            // Bags keep their entries' names and values (class values
            // joined, style objects merged).
            "attrs.get" => {
                let Some(names) = vals.get(1).and_then(strings) else {
                    return Val::Top;
                };
                let mut v = Val::none();
                for n in names {
                    let n = n.to_ascii_lowercase();
                    let entry = self.get(&Loc::Bag(n.clone()));
                    match n.as_str() {
                        "class" => v.join(&match entry.class_tokens() {
                            Some(t) => Val::Tokens(t),
                            None => Val::Top,
                        }),
                        "style" => v.join(&Val::Top),
                        _ => v.join(&entry),
                    };
                }
                return v;
            }
            "attrs.merge-props" | "attrs.without" | "attrs.has" | "attrs.style-map"
            | "attrs.style-text" => return Val::Top,
            "context.set" => {
                if let Some(v) = vals.get(1) {
                    self.put(Loc::Context, v);
                    return v.clone();
                }
                return Val::Top;
            }
            "context.get" => return self.get(&Loc::Context),
            "element.setAttribute" => {
                let value = vals.get(2).cloned().unwrap_or(Val::Top);
                match vals.get(1).and_then(strings) {
                    Some(names) => {
                        for n in names {
                            write_attr(&mut self.out, &n, &value, at);
                        }
                    }
                    None => {
                        self.out.any_name.get_or_insert_with(|| {
                            "element.setAttribute with a name of any value".into()
                        });
                    }
                }
                return Val::Top;
            }
            // Script DOM (M6): elements script creates (a tag of the IR's
            // allow-list, which the frontend checks), the `<br>` elements of
            // `innerText`, and inline styles set as text.
            "document.createElement" => {
                match vals.first().and_then(strings) {
                    Some(tags) => {
                        for t in tags {
                            self.out.tags.insert(t.to_ascii_lowercase());
                        }
                    }
                    None => {
                        for t in crate::validate::TAGS {
                            self.out.tags.insert((*t).to_owned());
                        }
                    }
                }
                return Val::Top;
            }
            "element.set-innerText" => {
                self.out.tags.insert("br".into());
                return Val::Top;
            }
            // classList (slice 2): the tokens added, toggled on or put in
            // place (an array the analysis does not see built: any class).
            "element.class-add" | "element.class-toggle" | "element.class-replace" => {
                write_attr(&mut self.out, "class", &Val::string(""), at);
                let tokens: Vec<Val> = match (name, args.get(1)) {
                    ("element.class-add", Some(Expr::Array { items, .. })) => items
                        .iter()
                        .map(|i| match i {
                            ArrayItem::Item(e) => self.eval(cx, e),
                            _ => Val::Top,
                        })
                        .collect(),
                    ("element.class-add", _) => vec![Val::Top],
                    ("element.class-toggle", _) => vec![vals.get(1).cloned().unwrap_or(Val::Top)],
                    _ => vec![vals.get(2).cloned().unwrap_or(Val::Top)],
                };
                for t in tokens {
                    write_class_tokens(&mut self.out, &t, " (classList)");
                }
                return Val::Top;
            }
            "element.style-set-text" => {
                write_attr(&mut self.out, "style", &Val::Top, at);
                return Val::Top;
            }
            _ => {}
        }
        if let Some(("root" | "body", m)) = name.split_once('.') {
            match m {
                "set-attr" => {
                    let value = vals.get(1).cloned().unwrap_or(Val::Top);
                    match vals.first().and_then(strings) {
                        Some(names) => {
                            for n in names {
                                write_attr(&mut self.out, &n, &value, at);
                            }
                        }
                        None => {
                            self.out
                                .any_name
                                .get_or_insert_with(|| format!("{name} with a name of any value"));
                        }
                    }
                }
                "class-add" | "class-toggle" => {
                    let v = vals.first().cloned().unwrap_or(Val::Top);
                    write_attr(&mut self.out, "class", &Val::string(""), at);
                    write_class_tokens(&mut self.out, &v, &format!(" ({name})"));
                }
                "style-set" => write_attr(&mut self.out, "style", &Val::Top, at),
                _ => {}
            }
            return Val::Top;
        }
        if *ty == Type::Attrs {
            // A bag the analysis did not see built.
            self.open_bag_names
                .get_or_insert_with(|| format!("a bag from {name}"));
        }
        // Arrays: the elements stay those of the arrays given, or are
        // given (push, splice); `map` makes new ones.
        if let Some(("array", m)) = name.split_once('.') {
            if let Some(Type::Array(t)) = args.first().and_then(|a| self.ty(cx, a)) {
                for (a, v) in args.iter().zip(&vals).skip(1) {
                    if self.ty(cx, a).as_ref() == Some(&*t) {
                        self.put(Loc::Elem((*t).clone()), v);
                    }
                }
                if *ty == *t || *ty == Type::maybe((*t).clone()) {
                    return self.get(&Loc::Elem(*t));
                }
                if let Type::Array(u) = ty {
                    if *u != t || m == "map" {
                        self.put(Loc::Elem((**u).clone()), &Val::Top);
                    }
                }
                return Val::Top;
            }
        }
        // Other built-ins may create or change records and arrays of the
        // types they take or give.
        self.make_opaque(ty);
        for a in args {
            if let Some(t) = self.ty(cx, a) {
                self.make_opaque(&t);
            }
        }
        Val::Top
    }
}

/// Record that an element may have attribute `name` with value `v`.
fn write_attr(out: &mut Out, name: &str, v: &Val, at: &str) {
    let name = name.to_ascii_lowercase();
    let texts = v.attribute_texts();
    if texts.is_none() {
        out.any_value
            .entry(name.clone())
            .or_insert_with(|| format!("{name}{at}"));
    }
    let slot = out
        .attributes
        .entry(name.clone())
        .or_insert_with(|| Some(BTreeSet::new()));
    match (slot.as_mut(), texts) {
        (Some(s), Some(t)) => {
            s.extend(t);
            if s.len() > CAP {
                *slot = None;
            }
        }
        _ => *slot = None,
    }
    if name == "class" {
        write_class_tokens(out, v, at);
    }
}

fn write_class_tokens(out: &mut Out, v: &Val, at: &str) {
    match v.class_tokens() {
        Some(t) => out
            .classes
            .extend(t.into_iter().map(|t| t.to_ascii_lowercase())),
        None => {
            out.any_class
                .get_or_insert_with(|| format!("a class of any value{at}"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_join_and_render() {
        let mut v = Val::string("a b");
        assert!(v.join(&Val::one(Atom::Undefined)));
        assert_eq!(
            v.class_tokens(),
            Some(BTreeSet::from(["a".to_string(), "b".to_string()]))
        );
        assert_eq!(
            v.attribute_texts(),
            Some(BTreeSet::from(["a b".to_string()]))
        );
        let joined = v.joined(&Val::Tokens(BTreeSet::from(["c".to_string()])));
        assert_eq!(joined.attribute_texts(), None);
        assert_eq!(
            joined.class_tokens(),
            Some(BTreeSet::from(
                ["a", "b", "c", "undefined"].map(String::from)
            ))
        );
        assert_eq!(
            Val::string("x-").concat(&Val::one(Atom::Num(2f64.to_bits()))),
            Val::string("x-2")
        );
        assert_eq!(Val::object().to_text(), Val::Top);
    }
}
