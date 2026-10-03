//! Emission of IR expressions and statements as Rust inside one function
//! context (function, handler, template or initialiser).
//!
//! Conventions: values are owned; every function receives `cx: &mut Cx`, and
//! functions of a component also `inst: &I{k}` (the instance whose cells they
//! use) and `snap: &Rc<Cells{k}>` (the render snapshot their `snapshot` reads
//! see, captured by closures); arguments of calls are evaluated into temporaries first (JS
//! evaluation order, no overlapping borrows); cell reads release their borrow
//! immediately; errors propagate with `?`, or to the innermost `try` through
//! `tri!` and labelled-block breaks.

use crate::types::{default_value, rust_type, same_expr};
use runic_ir::validate::infer_in;
use runic_ir::*;
use std::fmt::Write as _;

pub struct FnCtx<'a> {
    pub p: &'a Program,
    pub component: Option<usize>,
    pub locals: Vec<Local>,
    /// The event payload type in handlers (string or boolean).
    pub payload: Option<Type>,
    pub result: Type,
    /// Innermost first: labels that receive errors (`try`/`catch` blocks).
    pub catch: Vec<String>,
    /// IR loop label → Rust label.
    pub loops: Vec<(Option<String>, String)>,
    pub counter: usize,
    /// Whether `finally` forbids control-flow exits (set inside try with finally).
    pub no_exits: usize,
    pub errors: Vec<String>,
    /// Whether a `snap` variable holds the render snapshot (functions and
    /// handlers); elsewhere it is the instance's current snapshot.
    pub snap: bool,
}

pub fn rust_str(s: &str) -> String {
    format!("{s:?}")
}

fn num(x: f64) -> String {
    if x.is_nan() {
        "f64::NAN".into()
    } else if x.is_infinite() {
        if x > 0.0 {
            "f64::INFINITY".into()
        } else {
            "f64::NEG_INFINITY".into()
        }
    } else {
        format!("({x:?}f64)")
    }
}

pub fn js_str(s: &str) -> String {
    if s.is_empty() {
        "JsString::new()".into()
    } else {
        format!("JsString::from({})", rust_str(s))
    }
}

impl<'a> FnCtx<'a> {
    pub fn new(
        p: &'a Program,
        component: Option<usize>,
        locals: Vec<Local>,
        payload: Option<Type>,
        result: Type,
    ) -> Self {
        FnCtx {
            p,
            component,
            locals,
            payload,
            result,
            catch: vec![],
            loops: vec![],
            counter: 0,
            no_exits: 0,
            errors: vec![],
            snap: false,
        }
    }

    fn fresh(&mut self, prefix: &str) -> String {
        self.counter += 1;
        format!("{prefix}{}", self.counter)
    }

    pub fn ty(&self, e: &Expr) -> Type {
        infer_in(
            self.p,
            self.component,
            &self.locals,
            self.payload.clone(),
            e,
        )
    }

    /// Propagate the error of a `JsResult` expression.
    pub fn q(&self, code: &str) -> String {
        match self.catch.last() {
            Some(l) => format!("tri!({code}, '{l})"),
            None => format!("({code})?"),
        }
    }

    fn local_read(&self, i: usize) -> String {
        if self.locals[i].boxed {
            format!("l{i}.borrow().clone()")
        } else {
            format!("l{i}.clone()")
        }
    }

    fn cell_read(&self, cell: usize, read: Read) -> String {
        match read {
            Read::Current => {
                let c = &self.p.components[self.component.expect("cell in a component")];
                let read = if self.p.schedule.cleanup_reads_previous {
                    format!(
                        "if cx.reading_previous {{ inst.borrow().prev.c{cell}.clone() }} else {{ inst.borrow().c.c{cell}.clone() }}"
                    )
                } else {
                    format!("inst.borrow().c.c{cell}.clone()")
                };
                // Reads of reactive cells are dependencies of a running tracked effect.
                if c.cells[cell].tracking == Tracking::None {
                    return format!("{{ let v = {read}; v }}");
                }
                format!(
                    "{{ let v = {read}; if let Some(t) = cx.tracking.as_mut() {{ let version = inst.borrow().ver[{cell}]; t.push(runic_runtime::Dep {{ cells: Some(Rc::clone(inst) as Rc<dyn runic_runtime::Versions>), cell: {cell}, refresh: None, version, heap: None }}); }} v }}"
                )
            }
            Read::Snapshot if self.snap => format!("snap.c{cell}.clone()"),
            Read::Snapshot => format!("{{ let v = inst.borrow().snap.c{cell}.clone(); v }}"),
        }
    }

    /// The render snapshot passed to component functions.
    fn snap_ref(&self) -> &'static str {
        if self.snap {
            "snap"
        } else {
            "&{ let s = Rc::clone(&inst.borrow().snap); s }"
        }
    }

    /// Write cell `cell` of the current instance from the Rust variable `v`;
    /// a bound prop then calls its binding.
    fn cell_write(&self, cell: usize) -> String {
        let check = self.domain_check(cell, "v");
        let prop = self
            .component
            .is_some_and(|c| self.p.components[c].cells[cell].prop.is_some());
        // Proxied state stores proxies of plain objects and arrays.
        let own = match self.component {
            Some(c) if self.p.components[c].cells[cell].tracking == Tracking::Proxied => {
                "let v = js::Own::own(v); "
            }
            // Deep state: what it holds becomes reactive.
            Some(c) if self.p.components[c].cells[cell].tracking == Tracking::Deep => {
                "js::Own::mark(&v); "
            }
            _ => "",
        };
        // A write that changes the value gives the cell a new version.
        let ty = &self.p.components[self.component.expect("cell in a component")].cells[cell].ty;
        let same = same_expr(ty, "(*o)", "v");
        let own = format!(
            "{own}{{ let changed = {{ let st = inst.borrow(); let o = &st.c.c{cell}; !{same} }}; if changed {{ let ver = cx.jobs.version(); inst.borrow_mut().ver[{cell}] = ver; }} }} "
        );
        if prop {
            let call = self.q("b(cx, v)");
            format!(
                "{check}{own}inst.borrow_mut().c.c{cell} = v.clone(); cx.jobs.queue_flush(); let b = {{ let b = inst.borrow().b{cell}.clone(); b }}; if let Some(b) = b {{ {call}; }} "
            )
        } else {
            format!("{check}{own}inst.borrow_mut().c.c{cell} = v; cx.jobs.queue_flush(); ")
        }
    }

    /// `let` temporaries for `args`, returning the bindings and their names.
    fn temps(&mut self, args: &[Expr]) -> (String, Vec<String>) {
        let mut code = String::new();
        let mut names = vec![];
        for a in args {
            let name = self.fresh("t");
            let v = self.expr(a);
            let _ = write!(code, "let {name} = {v}; ");
            names.push(name);
        }
        (code, names)
    }

    pub fn expr(&mut self, e: &Expr) -> String {
        use Expr::*;
        match e {
            Lit {
                value: Value::Number(n),
            } => num(*n),
            Lit {
                value: Value::Boolean(b),
            } => b.to_string(),
            Lit {
                value: Value::String(s),
            } => js_str(s),
            Undefined { ty } if *ty == Type::Void => "()".into(),
            Undefined { .. } => "Maybe::Undefined".into(),
            Null { .. } => "Maybe::Null".into(),
            Cell { cell, read } => self.cell_read(*cell, *read),
            Global { global } => format!("cx.g{global}.clone()"),
            Local { local } => self.local_read(*local),
            Event => "cx.event.clone().expect(\"event context\")".into(),
            Payload => match self.payload {
                Some(Type::Boolean) => {
                    "cx.payload.as_ref().is_some_and(|p| p.to_rust() == \"true\")".into()
                }
                _ => "cx.payload.clone().expect(\"typed payload\")".into(),
            },
            Not { arg } => format!("(!{})", self.expr(arg)),
            Neg { arg } => format!("(-{})", self.expr(arg)),
            BitNot { arg } => format!("js::bit_not({})", self.expr(arg)),
            ToString { arg } => {
                let t = self.ty(arg);
                let v = self.expr(arg);
                match t {
                    Type::String => v,
                    _ => format!("js::ToJsString::to_js_string(&{v})"),
                }
            }
            ToNumber { arg } => {
                let t = self.ty(arg);
                let v = self.expr(arg);
                if t == Type::Number {
                    v
                } else {
                    format!("js::ToNumber::to_number(&{v})")
                }
            }
            ToBoolean { arg } => {
                let t = self.ty(arg);
                let v = self.expr(arg);
                if t == Type::Boolean {
                    v
                } else {
                    format!("js::Truthy::truthy(&{v})")
                }
            }
            Typeof { arg } => {
                let t = self.ty(arg);
                let v = self.expr(arg);
                match t {
                    Type::Fn(_) => format!("{{ let _ = {v}; JsString::from(\"function\") }}"),
                    _ => format!("JsString::from(js::TypeOf::type_of(&{v}))"),
                }
            }
            Utf16Length { arg } => format!("({}.len() as f64)", self.expr(arg)),
            Add { left, right } => self.bin(left, right, |a, b| format!("({a} + {b})")),
            Sub { left, right } => self.bin(left, right, |a, b| format!("({a} - {b})")),
            Mul { left, right } => self.bin(left, right, |a, b| format!("({a} * {b})")),
            Div { left, right } => self.bin(left, right, |a, b| format!("({a} / {b})")),
            Rem { left, right } => self.bin(left, right, |a, b| format!("js::rem({a}, {b})")),
            Pow { left, right } => self.bin(left, right, |a, b| format!("js::pow({a}, {b})")),
            Min { left, right } => self.bin(left, right, |a, b| format!("js::min({a}, {b})")),
            Max { left, right } => self.bin(left, right, |a, b| format!("js::max({a}, {b})")),
            BitAnd { left, right } => {
                self.bin(left, right, |a, b| format!("js::bit_and({a}, {b})"))
            }
            BitOr { left, right } => self.bin(left, right, |a, b| format!("js::bit_or({a}, {b})")),
            BitXor { left, right } => {
                self.bin(left, right, |a, b| format!("js::bit_xor({a}, {b})"))
            }
            Shl { left, right } => self.bin(left, right, |a, b| format!("js::shl({a}, {b})")),
            Shr { left, right } => self.bin(left, right, |a, b| format!("js::shr({a}, {b})")),
            Ushr { left, right } => self.bin(left, right, |a, b| format!("js::ushr({a}, {b})")),
            Concat { left, right } => self.bin(left, right, |a, b| format!("{a}.concat(&{b})")),
            Eq { left, right } => self.eq(left, right, false),
            Ne { left, right } => self.eq(left, right, true),
            Lt { left, right } => self.bin(left, right, |a, b| format!("({a} < {b})")),
            Le { left, right } => self.bin(left, right, |a, b| format!("({a} <= {b})")),
            Gt { left, right } => self.bin(left, right, |a, b| format!("({a} > {b})")),
            Ge { left, right } => self.bin(left, right, |a, b| format!("({a} >= {b})")),
            And { left, right } => format!("({} && {})", self.expr(left), self.expr(right)),
            Or { left, right } => format!("({} || {})", self.expr(left), self.expr(right)),
            Nullish { left, right } => {
                let maybe_right = matches!(self.ty(right), Type::Maybe(_));
                let l = self.expr(left);
                let r = self.expr(right);
                if maybe_right {
                    format!("(match {l} {{ Maybe::Some(v) => Maybe::Some(v), _ => {r} }})")
                } else {
                    format!("(match {l} {{ Maybe::Some(v) => v, _ => {r} }})")
                }
            }
            Cond {
                test,
                then,
                otherwise,
            } => {
                format!(
                    "(if {} {{ {} }} else {{ {} }})",
                    self.expr(test),
                    self.expr(then),
                    self.expr(otherwise)
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
                    self.expr(fast)
                } else {
                    format!(
                        "(if {} {{ {} }} else {{ {} }})",
                        self.expr(guard),
                        self.expr(fast),
                        self.expr(reference)
                    )
                }
            }
            Attrs { items, merge } => {
                let mut code =
                    String::from("{ let mut v: Vec<(JsString, js::AttrValue<Bag>)> = Vec::new(); ");
                for item in items {
                    match item {
                        AttrItem::Spread { spread } if *merge => {
                            let x = self.expr(spread);
                            code.push_str(&format!(
                                "{{ let b = {x}; for (n, e) in b.resolved() {{ js::attrs_merge(&mut v, n.clone(), e.clone()); }} }} "
                            ));
                        }
                        AttrItem::Spread { spread } => {
                            let x = self.expr(spread);
                            code.push_str(&format!("v.extend({x}.entries().iter().cloned()); "));
                        }
                        AttrItem::Entry { name, value } => {
                            let t = self.ty(value);
                            let x = self.expr(value);
                            let entry = match &t {
                                Type::String => format!("js::AttrValue::Text({x})"),
                                Type::Boolean => format!("js::AttrValue::Flag({x})"),
                                Type::Maybe(_) => format!(
                                    "match {x} {{ Maybe::Some(s) => js::AttrValue::Text(s), _ => js::AttrValue::Absent }}"
                                ),
                                Type::Fn(f) => {
                                    let call = if f.params.is_empty() {
                                        "f(cx)"
                                    } else {
                                        "f(cx, e)"
                                    };
                                    format!(
                                        "{{ let f = {x}; let id = Rc::as_ptr(&f) as *const () as usize; let b: Bag = Rc::new(move |cx: &mut Cx, e: js::Event| {{ let _ = &e; let _ = {call}?; Ok(()) }}); js::AttrValue::Listener(id, b) }}"
                                    )
                                }
                                other => unreachable!("validated bag entry {other:?}"),
                            };
                            if *merge {
                                code.push_str(&format!(
                                    "js::attrs_merge(&mut v, {}, {entry}); ",
                                    js_str(name)
                                ));
                            } else {
                                code.push_str(&format!("v.push(({}, {entry})); ", js_str(name)));
                            }
                        }
                    }
                }
                code.push_str("js::Attrs::new(v) }");
                code
            }
            Record { record, fields } => {
                let (code, names) = self.temps(fields);
                let inits: String = names
                    .iter()
                    .enumerate()
                    .map(|(i, n)| format!("f{i}: {n}, "))
                    .collect();
                format!("{{ {code}JsRef::new(R{record} {{ {inits}}}) }}")
            }
            Array { items, .. } => {
                let mut code = String::from("{ let mut v = Vec::new(); ");
                for item in items {
                    match item {
                        ArrayItem::Item(x) => {
                            let x = self.expr(x);
                            let _ = write!(code, "v.push({x}); ");
                        }
                        ArrayItem::Spread { spread } => {
                            let s = self.expr(spread);
                            let _ = write!(
                                code,
                                "{{ let s = {s}; v.extend(s.borrow().iter().cloned()); }} "
                            );
                        }
                    }
                }
                code.push_str("js::array(v) }");
                code
            }
            Get { object, field } => {
                let o = self.expr(object);
                format!("{{ let o = {o}; let v = o.read_slot({field}).f{field}.clone(); v }}")
            }
            Index { array, index } => {
                let (code, n) = self.temps(&[(**array).clone(), (**index).clone()]);
                let call = self.q(&format!("js::array_ops::get_checked(&{}, {})", n[0], n[1]));
                format!("{{ {code}{call} }}")
            }
            Some { value } => format!("Maybe::Some({})", self.expr(value)),
            Optional { value, local, then } => {
                let v = self.expr(value);
                let assign = self.assign_local(*local, "x");
                let t = self.expr(then);
                format!(
                    "(match {v} {{ Maybe::Some(x) => {{ {assign} {t} }} _ => Maybe::Undefined }})"
                )
            }
            Unwrap { value } => {
                let v = self.expr(value);
                self.q(&format!("{v}.unwrap_js()"))
            }
            // A derived value: its cached slot (recomputed when needed).
            Call { function, .. } if self.p.functions[*function].derived => {
                self.q(&format!("dget_{function}(cx, inst)"))
            }
            Call { function, args } => {
                let (code, names) = self.temps(args);
                let inst = if self.p.functions[*function].component.is_some() {
                    format!(", inst, {}", self.snap_ref())
                } else {
                    String::new()
                };
                let call = self.q(&format!(
                    "f{function}(cx{inst}{})",
                    names.iter().map(|n| format!(", {n}")).collect::<String>()
                ));
                format!("{{ {code}{call} }}")
            }
            CallValue { callee, args } => {
                let f = self.expr(callee);
                let (code, names) = self.temps(args);
                let call = self.q(&format!(
                    "(callee)(cx{})",
                    names.iter().map(|n| format!(", {n}")).collect::<String>()
                ));
                format!("{{ let callee = {f}; {code}{call} }}")
            }
            Closure {
                function,
                captures,
                stable,
            } => {
                let c = self.closure(*function, captures);
                if *stable {
                    self.stable_closure(*function, &c)
                } else {
                    c
                }
            }
            Builtin { name, args, ty } => crate::builtins::emit(self, name, args, ty),
            With { local, value, body } => {
                let v = self.expr(value);
                let assign = self.assign_local(*local, &v);
                let b = self.expr(body);
                format!("{{ {assign} {b} }}")
            }
        }
    }

    fn bin(&mut self, l: &Expr, r: &Expr, f: impl Fn(&str, &str) -> String) -> String {
        // Operands are evaluated left to right into temporaries only when the
        // right side may run user code; otherwise the expression is inlined.
        let a = self.expr(l);
        let b = self.expr(r);
        if r.calls() || l.calls() {
            format!("{{ let a = {a}; let b = {b}; {} }}", f("a", "b"))
        } else {
            f(&a, &b)
        }
    }

    fn eq(&mut self, l: &Expr, r: &Expr, negate: bool) -> String {
        let t = self.ty(l);
        let not = if negate { "!" } else { "" };
        match t {
            Type::Number | Type::Boolean | Type::Void => self.bin(l, r, |a, b| {
                format!("({a} {} {b})", if negate { "!=" } else { "==" })
            }),
            Type::Fn(_) => self.bin(l, r, |a, b| format!("({not}Rc::ptr_eq(&{a}, &{b}))")),
            _ => self.bin(l, r, |a, b| {
                format!("({not}js::StrictEq::strict_eq(&{a}, &{b}))")
            }),
        }
    }

    pub fn assign_local(&self, i: usize, value: &str) -> String {
        if self.locals[i].boxed {
            format!("*l{i}.borrow_mut() = {value};")
        } else {
            format!("l{i} = {value};")
        }
    }

    /// A stable closure: created once per instance (cached in its state) or,
    /// for functions of no component, once per program.
    fn stable_closure(&self, function: usize, create: &str) -> String {
        let f = &self.p.functions[function];
        let fn_ty = rust_type(&Type::Fn(FnType {
            params: f.params.iter().map(|p| p.ty.clone()).collect(),
            result: Box::new(f.result.clone()),
        }));
        let cache = if f.component.is_some() {
            "inst.borrow_mut().stable"
        } else {
            "cx.stable"
        };
        let read = if f.component.is_some() {
            "inst.borrow().stable"
        } else {
            "cx.stable"
        };
        format!(
            "{{ let known = {read}.get(&{function}).and_then(|v| v.downcast_ref::<{fn_ty}>().cloned()); match known {{ Some(f) => f, None => {{ let f: {fn_ty} = {create}; {cache}.insert({function}, Rc::new(f.clone()) as Rc<dyn std::any::Any>); f }} }} }}"
        )
    }

    fn closure(&mut self, function: usize, captures: &[usize]) -> String {
        let f = &self.p.functions[function];
        let mut code = String::from("{ ");
        let inst = if f.component.is_some() {
            let _ = write!(
                code,
                "let ki = Rc::clone(inst); let ks = Rc::clone({}); ",
                self.snap_ref()
            );
            ", &ki, &ks"
        } else {
            ""
        };
        let mut names = vec![];
        for (k, &c) in captures.iter().enumerate() {
            let name = format!("k{k}");
            if self.locals[c].boxed {
                let _ = write!(code, "let {name} = Rc::clone(&l{c}); ");
            } else {
                let _ = write!(code, "let {name} = l{c}.clone(); ");
            }
            names.push(name);
        }
        let params: Vec<String> = f
            .params
            .iter()
            .enumerate()
            .map(|(i, p)| format!("p{i}: {}", rust_type(&p.ty)))
            .collect();
        let forward_caps: String = names.iter().map(|n| format!(", {n}.clone()")).collect();
        let forward_params: String = (0..f.params.len()).map(|i| format!(", p{i}")).collect();
        let fn_ty = rust_type(&Type::Fn(FnType {
            params: f.params.iter().map(|p| p.ty.clone()).collect(),
            result: Box::new(f.result.clone()),
        }));
        let _ = write!(
            code,
            "let f: {fn_ty} = Rc::new(move |cx: &mut Cx{}| -> JsResult<{}> {{ f{function}(cx{inst}{forward_caps}{forward_params}) }}); f }}",
            params.iter().map(|p| format!(", {p}")).collect::<String>(),
            rust_type(&f.result),
        );
        code
    }

    // Statements -----------------------------------------------------------------

    pub fn block(&mut self, body: &[Stmt]) -> String {
        let mut out = String::new();
        for s in body {
            self.stmt(s, &mut out);
        }
        out
    }

    fn loop_label(&mut self, label: &Option<String>) -> String {
        let rust = match label {
            Some(l) => format!(
                "l_{}",
                l.chars()
                    .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
                    .collect::<String>()
            ),
            None => self.fresh("loop"),
        };
        self.loops.push((label.clone(), rust.clone()));
        rust
    }

    fn find_loop(&self, label: &Option<String>) -> String {
        match label {
            Some(l) => self
                .loops
                .iter()
                .rev()
                .find(|(ir, _)| ir.as_deref() == Some(l))
                .map(|(_, r)| r.clone()),
            None => self.loops.last().map(|(_, r)| r.clone()),
        }
        .expect("validated loop label")
    }

    pub fn stmt(&mut self, s: &Stmt, out: &mut String) {
        match s {
            Stmt::Set { cell, value, .. } => {
                let v = self.expr(value);
                let write = self.cell_write(*cell);
                let _ = writeln!(out, "{{ let v = {v}; {write}}}");
            }
            Stmt::Let { local, value, .. } => {
                let v = match value {
                    Some(e) => self.expr(e),
                    None => default_value(&self.locals[*local].ty, self.p),
                };
                if self.locals[*local].boxed {
                    // A fresh binding per execution: closures created earlier keep theirs.
                    let _ = writeln!(out, "l{local} = Rc::new(RefCell::new({v}));");
                } else {
                    let _ = writeln!(out, "l{local} = {v};");
                }
            }
            Stmt::Assign { target, value, .. } => match target {
                Place::Local { local } => {
                    let v = self.expr(value);
                    let a = self.assign_local(*local, "v");
                    let _ = writeln!(out, "{{ let v = {v}; {a} }}");
                }
                Place::Cell { cell } => {
                    let v = self.expr(value);
                    let write = self.cell_write(*cell);
                    let _ = writeln!(out, "{{ let v = {v}; {write}}}");
                }
                Place::Field { object, field } => {
                    let o = self.expr(object);
                    let v = self.expr(value);
                    let _ = writeln!(
                        out,
                        "{{ let o = {o}; let v = {v}; let v = js::own_into(&o, v); o.write_slots(&[{field}]).f{field} = v; }}"
                    );
                }
                Place::Index { array, index } => {
                    let a = self.expr(array);
                    let i = self.expr(index);
                    let v = self.expr(value);
                    let set = self.q("js::array_ops::set(&a, i, v)");
                    let _ = writeln!(
                        out,
                        "{{ let a = {a}; let i = {i}; let v = {v}; let v = js::own_into(&a, v); {set}; }}"
                    );
                }
            },
            Stmt::Expr { value, .. } => {
                let v = self.expr(value);
                let _ = writeln!(out, "let _ = {v};");
            }
            Stmt::If {
                test,
                then,
                otherwise,
                ..
            } => {
                let t = self.expr(test);
                let a = self.block(then);
                let b = self.block(otherwise);
                let _ = writeln!(out, "if {t} {{\n{a}}} else {{\n{b}}}");
            }
            Stmt::While {
                test,
                body,
                update,
                label,
            } => {
                let l = self.loop_label(label);
                let t = self.expr(test);
                let b = self.block(body);
                let u = self.block(update);
                self.loops.pop();
                let _ = writeln!(
                    out,
                    "'{l}: loop {{\nif !({t}) {{ break '{l}; }}\n'{l}_body: {{\n{b}}}\n{u}}}"
                );
            }
            Stmt::ForOf {
                local,
                iterable,
                body,
                label,
                ..
            } => {
                let it_ty = self.ty(iterable);
                let it = self.expr(iterable);
                let l = self.loop_label(label);
                let assign = if self.locals[*local].boxed {
                    format!("l{local} = Rc::new(RefCell::new(x));")
                } else {
                    format!("l{local} = x;")
                };
                let b = self.block(body);
                self.loops.pop();
                let source = match it_ty {
                    Type::Array(_) => format!("let items = {it};"),
                    Type::Set(_) => format!("let items = js::array_ops::set_values(&{it});"),
                    _ => format!("let items = js::array(js::string_ops::code_points(&{it}));"),
                };
                let _ = writeln!(
                    out,
                    "{{ {source} let mut index = 0usize;\n'{l}: loop {{\nlet x = {{ let b = items.borrow(); match b.get(index) {{ Some(x) => x.clone(), None => break '{l} }} }};\nindex += 1;\n{assign}\n'{l}_body: {{\n{b}}}\n}} }}"
                );
            }
            Stmt::Break { label } => {
                if self.no_exits > 0 {
                    self.errors
                        .push("break out of try/finally is unsupported".into());
                }
                let l = self.find_loop(label);
                let _ = writeln!(out, "break '{l};");
            }
            Stmt::Continue { label } => {
                if self.no_exits > 0 {
                    self.errors
                        .push("continue out of try/finally is unsupported".into());
                }
                let l = self.find_loop(label);
                let _ = writeln!(out, "break '{l}_body;");
            }
            Stmt::Return { value, .. } => {
                if self.no_exits > 0 {
                    self.errors
                        .push("return out of try/finally is unsupported".into());
                }
                let v = match value {
                    Some(e) => self.expr(e),
                    None => default_value(&self.result, self.p),
                };
                let _ = writeln!(out, "return Ok({v});");
            }
            Stmt::Throw { value, .. } => {
                let v = self.expr(value);
                let thrown = "Err(js::Throw { name: e.borrow().f0.clone(), message: e.borrow().f1.clone() })";
                match self.catch.last() {
                    Some(l) => {
                        let _ = writeln!(out, "{{ let e = {v}; break '{l} {thrown}; }}");
                    }
                    None => {
                        let _ = writeln!(out, "{{ let e = {v}; return {thrown}; }}");
                    }
                }
            }
            Stmt::Try {
                body,
                catch,
                finally,
            } => {
                let id = self.fresh("try");
                if finally.is_some() {
                    self.no_exits += 1;
                }
                self.catch.push(id.clone());
                let b = self.block(body);
                self.catch.pop();
                let mut code = format!("let r_{id}: JsResult<()> = '{id}: {{\n{b}Ok(())\n}};\n");
                if let Some(c) = catch {
                    let cid = format!("{id}_catch");
                    self.catch.push(cid.clone());
                    let bind = match c.local {
                        Some(l) => {
                            let err = format!(
                                "JsRef::new(R{} {{ f0: e.name.clone(), f1: e.message.clone() }})",
                                self.error_record()
                            );
                            self.assign_local(l, &err)
                        }
                        None => String::new(),
                    };
                    let cb = self.block(&c.body);
                    self.catch.pop();
                    let _ = write!(
                        code,
                        "let r_{id}: JsResult<()> = match r_{id} {{ Ok(()) => Ok(()), Err(e) => '{cid}: {{ {bind}\n{cb}Ok(()) }} }};\n"
                    );
                }
                if let Some(f) = finally {
                    let fb = self.block(f);
                    let _ = writeln!(code, "{fb}");
                    self.no_exits -= 1;
                }
                let propagate = self.q(&format!("r_{id}"));
                let _ = writeln!(out, "{{\n{code}{propagate};\n}}");
            }
        }
    }

    pub(crate) fn error_record(&self) -> usize {
        self.p
            .records
            .iter()
            .position(validate::is_error_record)
            .expect("validated error record")
    }

    fn domain_check(&self, cell: usize, v: &str) -> String {
        let Some(c) = self.component else {
            return String::new();
        };
        match self.p.components[c].cells[cell].domain {
            Some(Domain::Text { max_utf16 }) => format!(
                "if !js::valid_single_line(&{v}.to_rust(), {max_utf16}) {{ return Err(js::Throw::new(\"RunicDomainError\", \"value leaves the text domain of {}\")); }} ",
                self.p.components[c].cells[cell].name.escape_default()
            ),
            None => String::new(),
        }
    }
}

/// Emit an IR function as a Rust function.
pub fn function(p: &Program, index: usize, errors: &mut Vec<String>) -> String {
    let f = &p.functions[index];
    let locals: Vec<Local> = f
        .captures
        .iter()
        .chain(&f.params)
        .chain(&f.locals)
        .cloned()
        .collect();
    let mut cx = FnCtx::new(p, f.component, locals.clone(), None, f.result.clone());
    cx.snap = f.component.is_some();
    let body = cx.block(&f.body);
    errors.extend(cx.errors.iter().map(|e| format!("{}: {e}", f.name)));
    let mut sig = String::new();
    let mut prologue = String::new();
    let ncap = f.captures.len();
    for (i, l) in locals.iter().enumerate() {
        let t = rust_type(&l.ty);
        if i < ncap {
            if l.boxed {
                let _ = write!(sig, ", l{i}: Rc<RefCell<{t}>>");
            } else {
                let _ = write!(sig, ", mut l{i}: {t}");
            }
        } else if i < ncap + f.params.len() {
            if l.boxed {
                let _ = write!(sig, ", p{i}: {t}");
                let _ = writeln!(
                    prologue,
                    "let l{i}: Rc<RefCell<{t}>> = Rc::new(RefCell::new(p{i}));"
                );
            } else {
                let _ = write!(sig, ", mut l{i}: {t}");
            }
        } else if l.boxed {
            let _ = writeln!(
                prologue,
                "let mut l{i}: Rc<RefCell<{t}>> = Rc::new(RefCell::new({}));",
                default_value(&l.ty, p)
            );
        } else {
            let _ = writeln!(prologue, "let mut l{i}: {t} = {};", default_value(&l.ty, p));
        }
    }
    format!(
        "/// {}\n#[allow(unused_mut, unused_variables, unused_assignments, unreachable_code, unused_labels, clippy::all)]\nfn f{index}(cx: &mut Cx{}{sig}) -> JsResult<{}> {{\n{prologue}{body}#[allow(unreachable_code)]\nOk({})\n}}\n",
        f.name.replace('\n', " "),
        f.component
            .map(|k| format!(", inst: &I{k}, snap: &Rc<Cells{k}>"))
            .unwrap_or_default(),
        rust_type(&f.result),
        default_value(&f.result, p),
    )
}
