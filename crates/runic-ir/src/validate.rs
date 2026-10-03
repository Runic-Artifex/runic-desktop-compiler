//! Structural, typing and resource validation for schema 4 programs.

use crate::*;
use std::collections::HashSet;

pub const MAX_NODES: usize = 4096;
pub const MAX_CELLS: usize = 1024;
pub const MAX_HANDLERS: usize = 1024;
pub const MAX_FUNCTIONS: usize = 4096;
pub const MAX_DEPTH: usize = 96;
pub const MAX_CSS: usize = 4 * 1024 * 1024;
pub const MAX_EXPRESSIONS: usize = 1 << 20;

/// Elements without default actions that the runtime renders with browser
/// semantics. Elements with navigation, submission or label activation
/// behaviour stay out until the runtime implements those actions.
pub const TAGS: &[&str] = &[
    "div", "span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "button", "input", "main", "article",
    "section", "header", "footer", "nav", "aside", "ul", "ol", "li", "strong", "em", "small", "b",
    "i", "code", "pre", "br", "hr",
];

pub const CAPABILITIES: &[&str] = &["dom", "css", "window", "click", "keyboard", "text-input"];

const VOID: &[&str] = &["input", "br", "hr"];

fn err<T>(code: &str, message: impl Into<String>, source: Option<&Source>) -> Result<T> {
    Err(Diagnostic::new(code, message, source))
}

/// The typing context of an expression or statement.
struct Scope<'a> {
    program: &'a Program,
    component: Option<usize>,
    /// Cells readable here (initialisers see only earlier cells).
    visible: usize,
    locals: Vec<Local>,
    payload: bool,
    result: Option<Type>,
    labels: Vec<Option<String>>,
    count: usize,
}

impl<'a> Scope<'a> {
    fn new(program: &'a Program, component: Option<usize>) -> Self {
        Scope {
            program,
            component,
            visible: component.map_or(0, |c| program.components[c].cells.len()),
            locals: vec![],
            payload: false,
            result: None,
            labels: vec![],
            count: 0,
        }
    }

    fn local(&self, i: usize, src: Option<&Source>) -> Result<&Local> {
        match self.locals.get(i) {
            Some(l) => Ok(l),
            None => err("E_IR", format!("Unknown local {i}"), src),
        }
    }

    fn cell(&self, i: usize, src: Option<&Source>) -> Result<&'a Cell> {
        match self.component {
            Some(c) if i < self.visible => Ok(&self.program.components[c].cells[i]),
            Some(_) => err(
                "E_IR",
                format!("Invalid or forward cell reference {i}"),
                src,
            ),
            None => err("E_IR", "Cell access outside a component context", src),
        }
    }

    fn record(&self, r: usize, src: Option<&Source>) -> Result<&'a RecordType> {
        match self.program.records.get(r) {
            Some(rec) => Ok(rec),
            None => err("E_IR", format!("Unknown record {r}"), src),
        }
    }

    fn function(&self, f: usize, src: Option<&Source>) -> Result<&'a Function> {
        let Some(func) = self.program.functions.get(f) else {
            return err("E_IR", format!("Unknown function {f}"), src);
        };
        if func.component.is_some() && func.component != self.component {
            return err(
                "E_IR",
                format!("Function {} belongs to another component", func.name),
                src,
            );
        }
        Ok(func)
    }

    fn check_type(&self, t: &Type, src: Option<&Source>) -> Result<()> {
        match t {
            Type::Record(r) => self.record(*r, src).map(|_| ()),
            Type::Maybe(i) | Type::Array(i) | Type::Set(i) => self.check_type(i, src),
            Type::Map(k, v) => self.check_type(k, src).and(self.check_type(v, src)),
            Type::Fn(f) => {
                f.params.iter().try_for_each(|p| self.check_type(p, src))?;
                self.check_type(&f.result, src)
            }
            _ => Ok(()),
        }
    }

    fn infer(&mut self, e: &Expr, depth: usize, src: Option<&Source>) -> Result<Type> {
        use Expr::*;
        self.count += 1;
        if depth > MAX_DEPTH || self.count > MAX_EXPRESSIONS {
            return err(
                "E_RESOURCE",
                "Expression tree is too deep or too large",
                src,
            );
        }
        let d = depth + 1;
        let t = match e {
            Lit { value } => {
                if let Value::Number(n) = value {
                    if !n.is_finite() {
                        return err("E_IR", "Numeric literals must be finite", src);
                    }
                }
                value.ty()
            }
            Undefined { ty } | Null { ty } => {
                self.check_type(ty, src)?;
                if !matches!(ty, Type::Maybe(_))
                    && !(matches!(e, Undefined { .. }) && *ty == Type::Void)
                {
                    return err("E_IR", "undefined/null literals need a Maybe type", src);
                }
                ty.clone()
            }
            Cell { cell, .. } => self.cell(*cell, src)?.ty.clone(),
            Local { local } => self.local(*local, src)?.ty.clone(),
            Payload => {
                if !self.payload {
                    return err("E_IR", "Event payload outside an input handler", src);
                }
                Type::String
            }
            Not { arg } => {
                self.expect(arg, Type::Boolean, d, src)?;
                Type::Boolean
            }
            Neg { arg } | BitNot { arg } => {
                self.expect(arg, Type::Number, d, src)?;
                Type::Number
            }
            ToString { arg } => {
                let t = self.infer(arg, d, src)?;
                if matches!(t, Type::Map(..) | Type::Set(_) | Type::Fn(_) | Type::Void) {
                    return err(
                        "E_IR",
                        format!("Cannot convert {} to a string", t.name()),
                        src,
                    );
                }
                Type::String
            }
            ToNumber { arg } => {
                let t = self.infer(arg, d, src)?;
                if !primitive(&t) {
                    return err(
                        "E_IR",
                        format!("Cannot convert {} to a number", t.name()),
                        src,
                    );
                }
                Type::Number
            }
            ToBoolean { arg } => {
                self.infer(arg, d, src)?;
                Type::Boolean
            }
            Typeof { arg } => {
                self.infer(arg, d, src)?;
                Type::String
            }
            Utf16Length { arg } => {
                self.expect(arg, Type::String, d, src)?;
                Type::Number
            }
            Add { left, right }
            | Sub { left, right }
            | Mul { left, right }
            | Div { left, right }
            | Rem { left, right }
            | Pow { left, right }
            | Min { left, right }
            | Max { left, right }
            | BitAnd { left, right }
            | BitOr { left, right }
            | BitXor { left, right }
            | Shl { left, right }
            | Shr { left, right }
            | Ushr { left, right } => {
                self.expect(left, Type::Number, d, src)?;
                self.expect(right, Type::Number, d, src)?;
                Type::Number
            }
            Concat { left, right } => {
                self.expect(left, Type::String, d, src)?;
                self.expect(right, Type::String, d, src)?;
                Type::String
            }
            Eq { left, right } | Ne { left, right } => {
                let (a, b) = (self.infer(left, d, src)?, self.infer(right, d, src)?);
                if a != b {
                    return err(
                        "E_IR",
                        format!("Strict equality between {} and {}", a.name(), b.name()),
                        src,
                    );
                }
                Type::Boolean
            }
            Lt { left, right } | Le { left, right } | Gt { left, right } | Ge { left, right } => {
                self.expect(left, Type::Number, d, src)?;
                self.expect(right, Type::Number, d, src)?;
                Type::Boolean
            }
            And { left, right } | Or { left, right } => {
                self.expect(left, Type::Boolean, d, src)?;
                self.expect(right, Type::Boolean, d, src)?;
                Type::Boolean
            }
            Nullish { left, right } => {
                let a = self.infer(left, d, src)?;
                let b = self.infer(right, d, src)?;
                let Type::Maybe(inner) = &a else {
                    return err(
                        "E_IR",
                        format!("?? needs a Maybe on the left, found {}", a.name()),
                        src,
                    );
                };
                if b == **inner || b == a {
                    b
                } else {
                    return err(
                        "E_IR",
                        format!("?? fallback {} does not fit {}", b.name(), a.name()),
                        src,
                    );
                }
            }
            Cond {
                test,
                then,
                otherwise,
            } => {
                self.expect(test, Type::Boolean, d, src)?;
                let (a, b) = (self.infer(then, d, src)?, self.infer(otherwise, d, src)?);
                if a != b {
                    return err(
                        "E_IR",
                        format!("Conditional branches {} and {}", a.name(), b.name()),
                        src,
                    );
                }
                a
            }
            Mapped {
                rule,
                guard,
                fast,
                reference,
            } => {
                if rule.is_empty() || rule.len() > 128 {
                    return err("E_IR", "Invalid mapping rule identity", src);
                }
                self.expect(guard, Type::Boolean, d, src)?;
                let (a, b) = (self.infer(fast, d, src)?, self.infer(reference, d, src)?);
                if a != b {
                    return err(
                        "E_IR",
                        "Mapping lowering and reference must have one type",
                        src,
                    );
                }
                a
            }
            Record { record, fields } => {
                let rec = self.record(*record, src)?;
                if rec.fields.len() != fields.len() {
                    return err(
                        "E_IR",
                        format!("Record {} needs {} fields", rec.name, rec.fields.len()),
                        src,
                    );
                }
                for (f, v) in rec.fields.iter().zip(fields) {
                    let t = self.infer(v, d, src)?;
                    if t != f.ty {
                        return err(
                            "E_IR",
                            format!(
                                "Field {}.{} is {}, found {}",
                                rec.name,
                                f.name,
                                f.ty.name(),
                                t.name()
                            ),
                            src,
                        );
                    }
                }
                Type::Record(*record)
            }
            Array { ty, items } => {
                self.check_type(ty, src)?;
                let Type::Array(elem) = ty else {
                    return err("E_IR", "Array literal needs an array type", src);
                };
                for item in items {
                    match item {
                        ArrayItem::Item(v) => self.expect(v, (**elem).clone(), d, src)?,
                        ArrayItem::Spread { spread } => self.expect(spread, ty.clone(), d, src)?,
                    }
                }
                ty.clone()
            }
            Get { object, field } => {
                let t = self.infer(object, d, src)?;
                let Type::Record(r) = t else {
                    return err("E_IR", format!("Field access on {}", t.name()), src);
                };
                let rec = self.record(r, src)?;
                match rec.fields.get(*field) {
                    Some(f) => f.ty.clone(),
                    None => {
                        return err(
                            "E_IR",
                            format!("Record {} has no field {field}", rec.name),
                            src,
                        );
                    }
                }
            }
            Index { array, index } => {
                let t = self.infer(array, d, src)?;
                self.expect(index, Type::Number, d, src)?;
                match t {
                    Type::Array(e) => *e,
                    other => return err("E_IR", format!("Index access on {}", other.name()), src),
                }
            }
            Some { value } => Type::maybe(self.infer(value, d, src)?),
            Optional { value, local, then } => {
                let t = self.infer(value, d, src)?;
                let Type::Maybe(inner) = t else {
                    return err("E_IR", "?. needs a Maybe value", src);
                };
                if self.local(*local, src)?.ty != *inner {
                    return err("E_IR", "?. temporary has the wrong type", src);
                }
                let r = self.infer(then, d, src)?;
                if !matches!(r, Type::Maybe(_)) {
                    return err("E_IR", "?. result must be a Maybe", src);
                }
                r
            }
            Unwrap { value } => match self.infer(value, d, src)? {
                Type::Maybe(inner) => *inner,
                other => return err("E_IR", format!("Unwrap of non-Maybe {}", other.name()), src),
            },
            Call { function, args } => {
                let f = self.function(*function, src)?;
                if !f.captures.is_empty() {
                    return err(
                        "E_IR",
                        format!("{} captures variables; call it through a closure", f.name),
                        src,
                    );
                }
                let params: Vec<Type> = f.params.iter().map(|p| p.ty.clone()).collect();
                self.args(&params, args, d, src)?;
                f.result.clone()
            }
            CallValue { callee, args } => {
                let t = self.infer(callee, d, src)?;
                let Type::Fn(sig) = t else {
                    return err("E_IR", format!("Calling a {}", t.name()), src);
                };
                self.args(&sig.params, args, d, src)?;
                *sig.result
            }
            Closure { function, captures } => {
                let f = self.function(*function, src)?;
                if f.captures.len() != captures.len() {
                    return err(
                        "E_IR",
                        format!(
                            "Closure over {} needs {} captures",
                            f.name,
                            f.captures.len()
                        ),
                        src,
                    );
                }
                for (want, &have) in f.captures.iter().zip(captures) {
                    let l = self.local(have, src)?;
                    if l.ty != want.ty || l.boxed != want.boxed {
                        return err(
                            "E_IR",
                            format!("Capture {} does not match {}", l.name, want.name),
                            src,
                        );
                    }
                }
                Type::Fn(FnType {
                    params: f.params.iter().map(|p| p.ty.clone()).collect(),
                    result: Box::new(f.result.clone()),
                })
            }
            Builtin { name, args, ty } => {
                self.check_type(ty, src)?;
                let types = args
                    .iter()
                    .map(|a| self.infer(a, d, src))
                    .collect::<Result<Vec<_>>>()?;
                match builtins::result_type(name, &types, ty, &self.program.records) {
                    Ok(t) if t == *ty => t,
                    Ok(t) => {
                        return err(
                            "E_IR",
                            format!("{name} returns {}, declared {}", t.name(), ty.name()),
                            src,
                        );
                    }
                    Err(m) => return err("E_BUILTIN", format!("{name}: {m}"), src),
                }
            }
            With { local, value, body } => {
                let want = self.local(*local, src)?.ty.clone();
                self.expect(value, want, d, src)?;
                self.infer(body, d, src)?
            }
        };
        Ok(t)
    }

    fn expect(&mut self, e: &Expr, want: Type, depth: usize, src: Option<&Source>) -> Result<()> {
        let t = self.infer(e, depth, src)?;
        if t == want {
            Ok(())
        } else {
            err(
                "E_IR",
                format!("Expected {}, found {}", want.name(), t.name()),
                src,
            )
        }
    }

    fn args(
        &mut self,
        params: &[Type],
        args: &[Expr],
        d: usize,
        src: Option<&Source>,
    ) -> Result<()> {
        if params.len() != args.len() {
            return err(
                "E_IR",
                format!("Expected {} arguments, found {}", params.len(), args.len()),
                src,
            );
        }
        for (p, a) in params.iter().zip(args) {
            self.expect(a, p.clone(), d, src)?;
        }
        Ok(())
    }

    fn place(&mut self, p: &Place, src: Option<&Source>) -> Result<Type> {
        match p {
            Place::Local { local } => Ok(self.local(*local, src)?.ty.clone()),
            Place::Cell { cell } => Ok(self.cell(*cell, src)?.ty.clone()),
            Place::Field { object, field } => {
                let e = Expr::Get {
                    object: Box::new(object.clone()),
                    field: *field,
                };
                self.infer(&e, 0, src)
            }
            Place::Index { array, index } => {
                let e = Expr::Index {
                    array: Box::new(array.clone()),
                    index: Box::new(index.clone()),
                };
                self.infer(&e, 0, src)
            }
        }
    }

    fn label_ok(&self, label: &Option<String>) -> bool {
        match label {
            Some(l) => self.labels.iter().any(|x| x.as_deref() == Some(l)),
            None => !self.labels.is_empty(),
        }
    }

    fn block(&mut self, body: &[Stmt]) -> Result<()> {
        body.iter().try_for_each(|s| self.stmt(s))
    }

    fn stmt(&mut self, s: &Stmt) -> Result<()> {
        match s {
            Stmt::Set {
                cell,
                value,
                source,
            } => {
                let t = self.cell(*cell, source.as_ref())?.ty.clone();
                self.expect(value, t, 0, source.as_ref())
            }
            Stmt::Let {
                local,
                value,
                source,
            } => {
                let t = self.local(*local, source.as_ref())?.ty.clone();
                match value {
                    Some(v) => self.expect(v, t, 0, source.as_ref()),
                    None => Ok(()),
                }
            }
            Stmt::Assign {
                target,
                value,
                source,
            } => {
                let t = self.place(target, source.as_ref())?;
                self.expect(value, t, 0, source.as_ref())
            }
            Stmt::Expr { value, source } => self.infer(value, 0, source.as_ref()).map(|_| ()),
            Stmt::If {
                test,
                then,
                otherwise,
                source,
            } => {
                self.expect(test, Type::Boolean, 0, source.as_ref())?;
                self.block(then)?;
                self.block(otherwise)
            }
            Stmt::While {
                test,
                body,
                update,
                label,
            } => {
                self.expect(test, Type::Boolean, 0, None)?;
                self.labels.push(label.clone());
                let r = self.block(body).and_then(|_| self.block(update));
                self.labels.pop();
                r
            }
            Stmt::ForOf {
                local,
                iterable,
                body,
                label,
                source,
            } => {
                let t = self.infer(iterable, 0, source.as_ref())?;
                let item = match t {
                    Type::Array(e) | Type::Set(e) => *e,
                    Type::String => Type::String,
                    other => {
                        return err(
                            "E_IR",
                            format!("for-of over {}", other.name()),
                            source.as_ref(),
                        );
                    }
                };
                if self.local(*local, source.as_ref())?.ty != item {
                    return err(
                        "E_IR",
                        "for-of variable has the wrong type",
                        source.as_ref(),
                    );
                }
                self.labels.push(label.clone());
                let r = self.block(body);
                self.labels.pop();
                r
            }
            Stmt::Break { label } | Stmt::Continue { label } => {
                if self.label_ok(label) {
                    Ok(())
                } else {
                    err(
                        "E_IR",
                        format!("break/continue to unknown loop {label:?}"),
                        None,
                    )
                }
            }
            Stmt::Return { value, source } => {
                let want = self.result.clone().unwrap_or(Type::Void);
                match value {
                    Some(v) => self.expect(v, want, 0, source.as_ref()),
                    None if want == Type::Void || matches!(want, Type::Maybe(_)) => Ok(()),
                    None => err("E_IR", "Missing return value", source.as_ref()),
                }
            }
            Stmt::Throw { value, source } => {
                let t = self.infer(value, 0, source.as_ref())?;
                if !self.is_error(&t) {
                    return err(
                        "E_IR",
                        "Only Error values ({name, message}) can be thrown",
                        source.as_ref(),
                    );
                }
                Ok(())
            }
            Stmt::Try {
                body,
                catch,
                finally,
            } => {
                self.block(body)?;
                if let Some(c) = catch {
                    if let Some(l) = c.local {
                        let t = self.local(l, None)?.ty.clone();
                        if !self.is_error(&t) {
                            return err("E_IR", "catch binding must be an Error record", None);
                        }
                    }
                    self.block(&c.body)?;
                }
                if let Some(f) = finally {
                    self.block(f)?;
                }
                Ok(())
            }
        }
    }

    fn is_error(&self, t: &Type) -> bool {
        let Type::Record(r) = t else { return false };
        self.program.records.get(*r).is_some_and(is_error_record)
    }
}

/// The record shape used for thrown values: `{ name: string, message: string }`.
pub fn is_error_record(rec: &RecordType) -> bool {
    rec.fields.len() == 2
        && rec.fields[0].name == "name"
        && rec.fields[0].ty == Type::String
        && rec.fields[1].name == "message"
        && rec.fields[1].ty == Type::String
}

fn primitive(t: &Type) -> bool {
    match t {
        Type::Number | Type::String | Type::Boolean => true,
        Type::Maybe(i) => primitive(i),
        _ => false,
    }
}

/// The type of an expression in a validated program and context.
pub fn infer_in(
    program: &Program,
    component: Option<usize>,
    locals: &[Local],
    payload: bool,
    e: &Expr,
) -> Type {
    let mut s = Scope::new(program, component);
    s.locals = locals.to_vec();
    s.payload = payload;
    s.infer(e, 0, None).expect("validated expression")
}

fn attr_name_ok(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some('a'..='z'))
        && name.len() <= 64
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        && !name.starts_with("on")
}

pub fn validate(p: &Program) -> Result<()> {
    if p.schema != SCHEMA {
        return err("E_IR", format!("Expected schema {SCHEMA}"), None);
    }
    if p.meta.title.len() > 256 || p.styles.css.len() > MAX_CSS {
        return err("E_RESOURCE", "Title or CSS exceeds resource limits", None);
    }
    if p.meta.source_hash.len() != 64 || !p.meta.source_hash.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return err("E_IR", "Invalid source hash", None);
    }
    let mut seen = HashSet::new();
    for c in &p.capabilities {
        if !CAPABILITIES.contains(&c.as_str()) || !seen.insert(c) {
            return err("E_IR", format!("Unknown or duplicate capability {c}"), None);
        }
    }
    for a in &p.styles.assets {
        if a.path.is_empty() || a.path.starts_with('/') || a.path.split('/').any(|s| s == "..") {
            return err("E_IR", "Invalid embedded asset path", None);
        }
        if a.mime != "font/woff2" || a.bytes == 0 || a.bytes > 4 << 20 || a.sha256.len() != 64 {
            return err("E_IR", "Invalid embedded asset", None);
        }
    }
    for name in p.container_attrs.keys() {
        if !attr_name_ok(name) || name == "id" {
            return err("E_IR", format!("Invalid container attribute {name}"), None);
        }
    }
    if p.components.len() != 1 || p.root != 0 {
        // Component composition is IR work for M3.
        return err(
            "E_IR",
            "The backend currently mounts exactly one component",
            None,
        );
    }
    if p.functions.len() > MAX_FUNCTIONS {
        return err("E_RESOURCE", "Too many functions", None);
    }
    for (i, r) in p.records.iter().enumerate() {
        let mut names = HashSet::new();
        for f in &r.fields {
            if !names.insert(&f.name) {
                return err("E_IR", format!("Record {i} repeats field {}", f.name), None);
            }
            Scope::new(p, None).check_type(&f.ty, None)?;
        }
    }
    for f in &p.functions {
        let src = f.source.as_ref();
        if let Some(c) = f.component {
            if c >= p.components.len() {
                return err(
                    "E_IR",
                    format!("Function {} names an unknown component", f.name),
                    src,
                );
            }
        }
        let mut s = Scope::new(p, f.component);
        s.locals = f
            .captures
            .iter()
            .chain(&f.params)
            .chain(&f.locals)
            .cloned()
            .collect();
        s.result = Some(f.result.clone());
        for l in &s.locals {
            s.check_type(&l.ty, src)?;
        }
        s.check_type(&f.result, src)?;
        s.block(&f.body)?;
    }
    let mut ids = HashSet::new();
    let mut nodes = 0;
    for ci in 0..p.components.len() {
        validate_component(p, ci, &mut ids, &mut nodes)?;
    }
    Ok(())
}

fn validate_component(
    p: &Program,
    ci: usize,
    ids: &mut HashSet<String>,
    nodes: &mut usize,
) -> Result<()> {
    let c = &p.components[ci];
    if c.cells.len() > MAX_CELLS || c.handlers.len() > MAX_HANDLERS {
        return err(
            "E_RESOURCE",
            "Too many cells or handlers in a component",
            None,
        );
    }
    for (i, cell) in c.cells.iter().enumerate() {
        let src = cell.source.as_ref();
        let mut s = Scope::new(p, Some(ci));
        s.visible = i;
        s.check_type(&cell.ty, src)?;
        if s.infer(&cell.init, 0, src)? != cell.ty {
            return err(
                "E_IR",
                format!("Initialiser type differs from cell {}", cell.name),
                src,
            );
        }
        if let Some(Domain::Text { max_utf16 }) = cell.domain {
            if cell.ty != Type::String || max_utf16 == 0 || max_utf16 > 1 << 20 {
                return err(
                    "E_IR",
                    "Text domains require a string cell and a bounded length",
                    src,
                );
            }
        }
    }
    let mut used = vec![false; c.handlers.len()];
    let mut stack = vec![];
    for node in &c.template {
        validate_node(p, ci, node, 0, ids, nodes, &mut used, &mut stack)?;
    }
    for (i, h) in c.handlers.iter().enumerate() {
        let src = h.source.as_ref();
        if !used[i] {
            return err("E_IR", "Handler is not referenced by any listener", src);
        }
        let mut s = Scope::new(p, Some(ci));
        s.locals = h.locals.clone();
        s.payload = h.event == EventKind::Input;
        s.result = Some(Type::Void);
        for l in &s.locals {
            s.check_type(&l.ty, src)?;
        }
        s.block(&h.body)?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn validate_node(
    p: &Program,
    ci: usize,
    node: &Node,
    depth: usize,
    ids: &mut HashSet<String>,
    nodes: &mut usize,
    used: &mut [bool],
    stack: &mut Vec<&'static str>,
) -> Result<()> {
    let c = &p.components[ci];
    *nodes += 1;
    let src = node.source();
    if depth > MAX_DEPTH || *nodes > MAX_NODES {
        return err(
            "E_RESOURCE",
            "Template is too deep or has too many nodes",
            src,
        );
    }
    let mut s = Scope::new(p, Some(ci));
    match node {
        Node::Text { parts, .. } => {
            if parts.is_empty() || parts.len() > 256 {
                return err("E_IR", "Text nodes need between 1 and 256 parts", src);
            }
            for part in parts {
                if s.infer(part, 0, src)? != Type::String {
                    return err("E_IR", "Text parts must be strings", src);
                }
            }
        }
        Node::If {
            test,
            then,
            otherwise,
            ..
        } => {
            if s.infer(test, 0, src)? != Type::Boolean {
                return err("E_IR", "Conditional template requires a boolean test", src);
            }
            for n in then.iter().chain(otherwise) {
                validate_node(p, ci, n, depth + 1, ids, nodes, used, stack)?;
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
            let Some(&tag) = TAGS.iter().find(|t| **t == tag) else {
                return err(
                    "E_IR",
                    format!("Element <{tag}> is outside the supported set"),
                    src,
                );
            };
            if VOID.contains(&tag) && !children.is_empty() {
                return err("E_IR", format!("<{tag}> cannot have children"), src);
            }
            if tag == "button" && stack.contains(&"button") {
                return err("E_IR", "Nested buttons are invalid", src);
            }
            let mut names = HashSet::new();
            for a in attrs {
                if !attr_name_ok(&a.name) || !names.insert(a.name.as_str()) {
                    return err(
                        "E_IR",
                        format!("Invalid or duplicate attribute {}", a.name),
                        src,
                    );
                }
                match s.infer(&a.value, 0, src)? {
                    Type::String | Type::Boolean => {}
                    Type::Maybe(inner) if *inner == Type::String => {}
                    other => {
                        return err(
                            "E_IR",
                            format!("Attribute {} cannot be {}", a.name, other.name()),
                            src,
                        );
                    }
                }
                if a.name == "id" {
                    let Some(id) = node.element_id() else {
                        return err("E_IR", "Element ids must be string literals", src);
                    };
                    if id.is_empty() || !ids.insert(id.to_owned()) {
                        return err("E_IR", format!("Empty or duplicate element id {id}"), src);
                    }
                }
            }
            for prop in props {
                if prop.name != "value" || tag != "input" {
                    return err(
                        "E_IR",
                        "Only the live value property of inputs is supported",
                        src,
                    );
                }
                if s.infer(&prop.value, 0, src)? != Type::String {
                    return err("E_IR", "The value property must be a string", src);
                }
            }
            let mut kinds = HashSet::new();
            for l in listeners {
                let Some(h) = c.handlers.get(l.handler) else {
                    return err("E_IR", "Listener refers to an unknown handler", src);
                };
                if h.event != l.event || !kinds.insert(l.event) {
                    return err(
                        "E_IR",
                        "Listener and handler event kinds differ or repeat",
                        src,
                    );
                }
                if l.event == EventKind::Input && tag != "input" {
                    return err("E_IR", "Input listeners require an input element", src);
                }
                used[l.handler] = true;
            }
            stack.push(tag);
            for n in children {
                validate_node(p, ci, n, depth + 1, ids, nodes, used, stack)?;
            }
            stack.pop();
        }
    }
    Ok(())
}
