//! Structural, typing and resource validation for schema 4 programs.

use crate::*;
use std::collections::HashSet;

pub const MAX_NODES: usize = 4096;
pub const MAX_CELLS: usize = 256;
pub const MAX_HANDLERS: usize = 1024;
pub const MAX_DEPTH: usize = 64;
pub const MAX_CSS: usize = 4 * 1024 * 1024;
pub const MAX_EXPRESSIONS: usize = 1 << 16;

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

struct Ctx<'a> {
    cells: &'a [Cell],
    /// Cells readable in this context (initialisers may only read earlier cells).
    visible: usize,
    payload: bool,
    count: usize,
}

impl Ctx<'_> {
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
        let mut ty = |x: &Expr| self.infer(x, depth + 1, src);
        let t = match e {
            Lit { value } => {
                if let Value::Number(n) = value {
                    if !n.is_finite() {
                        return err("E_IR", "Numeric literals must be finite", src);
                    }
                }
                if let Value::String(s) = value {
                    if s.len() > 1 << 20 {
                        return err("E_RESOURCE", "A string literal exceeds 1 MiB", src);
                    }
                }
                value.ty()
            }
            Cell { cell, .. } => {
                if *cell >= self.visible {
                    return err(
                        "E_IR",
                        format!("Invalid or forward cell reference {cell}"),
                        src,
                    );
                }
                self.cells[*cell].ty
            }
            Payload => {
                if !self.payload {
                    return err("E_IR", "Event payload outside an input handler", src);
                }
                Type::String
            }
            Not { arg } => expect(ty(arg)?, Type::Boolean, "!", src).map(|_| Type::Boolean)?,
            Neg { arg } => expect(ty(arg)?, Type::Number, "unary -", src).map(|_| Type::Number)?,
            ToString { arg } => {
                ty(arg)?;
                Type::String
            }
            Utf16Length { arg } => {
                expect(ty(arg)?, Type::String, ".length", src)?;
                Type::Number
            }
            Add { left, right }
            | Sub { left, right }
            | Mul { left, right }
            | Min { left, right }
            | Max { left, right } => {
                expect(ty(left)?, Type::Number, "arithmetic", src)?;
                expect(ty(right)?, Type::Number, "arithmetic", src)?;
                Type::Number
            }
            Concat { left, right } => {
                expect(ty(left)?, Type::String, "concatenation", src)?;
                expect(ty(right)?, Type::String, "concatenation", src)?;
                Type::String
            }
            Eq { left, right } | Ne { left, right } => {
                let (a, b) = (ty(left)?, ty(right)?);
                if a != b {
                    return err("E_IR", "Strict equality operands must have one type", src);
                }
                Type::Boolean
            }
            Lt { left, right } | Le { left, right } | Gt { left, right } | Ge { left, right } => {
                expect(ty(left)?, Type::Number, "comparison", src)?;
                expect(ty(right)?, Type::Number, "comparison", src)?;
                Type::Boolean
            }
            And { left, right } | Or { left, right } => {
                expect(ty(left)?, Type::Boolean, "logical operator", src)?;
                expect(ty(right)?, Type::Boolean, "logical operator", src)?;
                Type::Boolean
            }
            Cond {
                test,
                then,
                otherwise,
            } => {
                expect(ty(test)?, Type::Boolean, "condition", src)?;
                let (a, b) = (ty(then)?, ty(otherwise)?);
                if a != b {
                    return err("E_IR", "Conditional branches must have one type", src);
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
                expect(ty(guard)?, Type::Boolean, "mapping guard", src)?;
                let (a, b) = (ty(fast)?, ty(reference)?);
                if a != b {
                    return err(
                        "E_IR",
                        "Mapping lowering and reference must have one type",
                        src,
                    );
                }
                a
            }
        };
        Ok(t)
    }
}

/// The type of an expression in a validated component.
pub fn type_of(e: &Expr, cells: &[Cell]) -> Type {
    let mut ctx = Ctx {
        cells,
        visible: cells.len(),
        payload: true,
        count: 0,
    };
    ctx.infer(e, 0, None).expect("validated expression")
}

fn expect(actual: Type, wanted: Type, what: &str, src: Option<&Source>) -> Result<()> {
    if actual == wanted {
        Ok(())
    } else {
        err(
            "E_IR",
            format!(
                "{what} requires {} operands, found {}",
                wanted.name(),
                actual.name()
            ),
            src,
        )
    }
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
    let mut ids = HashSet::new();
    let mut nodes = 0;
    for component in &p.components {
        validate_component(component, &mut ids, &mut nodes)?;
    }
    Ok(())
}

fn validate_component(c: &Component, ids: &mut HashSet<String>, nodes: &mut usize) -> Result<()> {
    if c.cells.len() > MAX_CELLS || c.handlers.len() > MAX_HANDLERS {
        return err(
            "E_RESOURCE",
            "Too many cells or handlers in a component",
            None,
        );
    }
    for (i, cell) in c.cells.iter().enumerate() {
        let src = cell.source.as_ref();
        let mut ctx = Ctx {
            cells: &c.cells,
            visible: i,
            payload: false,
            count: 0,
        };
        if ctx.infer(&cell.init, 0, src)? != cell.ty {
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
        validate_node(c, node, 0, ids, nodes, &mut used, &mut stack)?;
    }
    for (i, h) in c.handlers.iter().enumerate() {
        let src = h.source.as_ref();
        if !used[i] {
            return err("E_IR", "Handler is not referenced by any listener", src);
        }
        if h.body.len() > 1024 {
            return err("E_RESOURCE", "Handler body is too large", src);
        }
        for stmt in &h.body {
            let Stmt::Set {
                cell,
                value,
                source,
            } = stmt;
            let src = source.as_ref().or(src);
            let Some(target) = c.cells.get(*cell) else {
                return err("E_IR", "Assignment to an unknown cell", src);
            };
            let mut ctx = Ctx {
                cells: &c.cells,
                visible: c.cells.len(),
                payload: h.event == EventKind::Input,
                count: 0,
            };
            if ctx.infer(value, 0, src)? != target.ty {
                return err(
                    "E_IR",
                    format!("Assignment type differs from cell {}", target.name),
                    src,
                );
            }
        }
    }
    Ok(())
}

fn validate_node(
    c: &Component,
    node: &Node,
    depth: usize,
    ids: &mut HashSet<String>,
    nodes: &mut usize,
    used: &mut [bool],
    stack: &mut Vec<&'static str>,
) -> Result<()> {
    *nodes += 1;
    let src = node.source();
    if depth > MAX_DEPTH || *nodes > MAX_NODES {
        return err(
            "E_RESOURCE",
            "Template is too deep or has too many nodes",
            src,
        );
    }
    let mut ctx = Ctx {
        cells: &c.cells,
        visible: c.cells.len(),
        payload: false,
        count: 0,
    };
    match node {
        Node::Text { parts, .. } => {
            if parts.is_empty() || parts.len() > 256 {
                return err("E_IR", "Text nodes need between 1 and 256 parts", src);
            }
            for part in parts {
                if ctx.infer(part, 0, src)? != Type::String {
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
            if ctx.infer(test, 0, src)? != Type::Boolean {
                return err("E_IR", "Conditional template requires a boolean test", src);
            }
            for n in then.iter().chain(otherwise) {
                validate_node(c, n, depth + 1, ids, nodes, used, stack)?;
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
                match ctx.infer(&a.value, 0, src)? {
                    Type::String | Type::Boolean => {}
                    Type::Number => {
                        return err("E_IR", "Attribute values must be strings or booleans", src);
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
                if ctx.infer(&prop.value, 0, src)? != Type::String {
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
                validate_node(c, n, depth + 1, ids, nodes, used, stack)?;
            }
            stack.pop();
        }
    }
    Ok(())
}
